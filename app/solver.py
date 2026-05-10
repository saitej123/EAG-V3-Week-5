"""Async multi-stage IIT-JEE solver powered by Gemini.

Pipeline: [parse] -> [plan] -> [solve] -> [verify] -> [final]

We make ONE strong Gemini call (system prompt enforces a strict 5-stage JSON
schema) and then re-emit each stage as its own SSE event so the UI feels
multi-step. While the Gemini call is in flight we concurrently drain the
per-request loguru queue and emit a heartbeat tick, so the user always sees
something moving.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
import time
from typing import Any, AsyncIterator

try:
    import json_repair
except ImportError:
    json_repair = None

from google import genai
from google.genai import types
from loguru import logger as _loguru_logger

from .config import get_settings
from .logger import (
    configure_logging,
    get_logger,
    reset_ui_log_queue,
    set_ui_log_queue,
)
from .schemas import SolverResult, StreamEvent
from .prompts import SOLVER_SYSTEM_PROMPT, USER_TEMPLATE

configure_logging()
log = get_logger("solver")


# ----------------------------- helpers -----------------------------


_JSON_BLOCK_RE = re.compile(r"\{[\s\S]*\}")
_DATA_URL_RE = re.compile(r"^data:(?P<mime>image/[a-zA-Z0-9.+-]+);base64,(?P<data>.+)$", re.DOTALL)
_ALLOWED_IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}


def _normalise_image_mime(mime: str) -> str:
    mime = (mime or "").strip().lower()
    return "image/jpeg" if mime == "image/jpg" else mime


def _extract_json(text: str) -> dict[str, Any]:
    if not text:
        raise ValueError("empty model output")
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.split("\n", 1)[-1] if "\n" in cleaned else cleaned
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].lstrip()
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
            
    # First try standard json.loads
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # If standard fails, try json_repair if available
    if json_repair is not None:
        try:
            repaired = json_repair.repair_json(cleaned, return_objects=True)
            if isinstance(repaired, dict):
                return repaired
        except Exception as e:
            log.warning(f"json_repair failed: {e}")

    # Fallback: try to extract a JSON block using regex and parse it
    match = _JSON_BLOCK_RE.search(cleaned)
    if not match:
        raise ValueError("Could not find JSON block in output")
    
    block = match.group(0)
    
    # Try standard json.loads on the block
    try:
        return json.loads(block)
    except json.JSONDecodeError:
        pass
        
    # Try json_repair on the block
    if json_repair is not None:
        try:
            repaired = json_repair.repair_json(block, return_objects=True)
            if isinstance(repaired, dict):
                return repaired
        except Exception:
            pass

    # Final desperate attempt: manually escape unescaped backslashes (common LaTeX issue)
    # This replaces \ with \\, EXCEPT when it's already \\ or \" or \n or \t or \u or \/
    # We deliberately escape \f, \b, \r because in LaTeX they are \frac, \beta, \rho
    escaped_block = re.sub(r'\\(?![\\"ntu/])', r'\\\\', block)
    try:
        return json.loads(escaped_block)
    except json.JSONDecodeError as e:
        raise ValueError(f"Could not parse solver output even after escaping: {e}")


def _decode_image_payload(image_b64: str, image_mime: str | None) -> tuple[bytes, str]:
    """Decode and validate an image payload sent by the browser.

    Accept both raw base64 and full data URLs. The browser normally sends raw
    base64, but pasted data URLs are common during manual testing.
    """
    settings = get_settings()
    payload = image_b64.strip()
    mime = _normalise_image_mime(image_mime or "")

    match = _DATA_URL_RE.match(payload)
    if match:
        mime = _normalise_image_mime(match.group("mime"))
        payload = match.group("data")

    if mime not in _ALLOWED_IMAGE_MIMES:
        raise ValueError(
            f"unsupported image MIME type: {mime or '(missing)'}; "
            f"allowed={sorted(_ALLOWED_IMAGE_MIMES)}"
        )

    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"invalid base64 image payload: {exc}") from exc

    if not data:
        raise ValueError("image payload decoded to 0 bytes")
    if len(data) > settings.max_image_bytes:
        raise ValueError(
            f"image too large: {len(data)} bytes > {settings.max_image_bytes} bytes"
        )

    return data, mime


def _build_contents(question: str, image_b64: str | None, image_mime: str | None):
    parts: list[Any] = [USER_TEMPLATE.format(question=question or "(see image)")]
    if image_b64:
        data, mime = _decode_image_payload(image_b64, image_mime)
        log.info("image decoded for Gemini (mime={}, bytes={})", mime, len(data))
        parts.append(types.Part.from_bytes(data=data, mime_type=mime))
    return parts


# ----------------------------- main -----------------------------


class JeeSolver:
    """Async solver. Stateless; one instance per process is enough."""

    def __init__(self) -> None:
        settings = get_settings()
        if not settings.gemini_api_key:
            log.warning("GEMINI_API_KEY is not set - solver will fail at runtime")
        self._client = genai.Client(api_key=settings.gemini_api_key or "missing")
        self._model = settings.gemini_model
        self._timeout = settings.request_timeout_s

    async def _generate(self, contents: list[Any]) -> str:
        cfg = types.GenerateContentConfig(
            system_instruction=SOLVER_SYSTEM_PROMPT,
            response_mime_type="application/json",
            temperature=0.2,
        )
        response = await asyncio.wait_for(
            self._client.aio.models.generate_content(
                model=self._model,
                contents=contents,
                config=cfg,
            ),
            timeout=self._timeout,
        )
        return response.text or ""

    async def stream_solve(
        self,
        question: str,
        image_b64: str | None = None,
        image_mime: str | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """Yield SSE events as the solver progresses.

        Uses generate_content_stream to fetch the response chunk by chunk.
        While fetching, it concurrently drains the loguru queue and yields
        heartbeats/chunks.
        """
        t0 = time.perf_counter()

        ui_queue: asyncio.Queue = asyncio.Queue(maxsize=512)
        stream_q: asyncio.Queue = asyncio.Queue()
        token = set_ui_log_queue(ui_queue)
        
        async def _fetch():
            try:
                cfg = types.GenerateContentConfig(
                    system_instruction=SOLVER_SYSTEM_PROMPT,
                    response_mime_type="application/json",
                    temperature=0.2,
                )
                response_stream = await self._client.aio.models.generate_content_stream(
                    model=self._model,
                    contents=contents,
                    config=cfg,
                )
                async for chunk in response_stream:
                    if chunk.text:
                        await stream_q.put({"type": "chunk", "text": chunk.text})
                await stream_q.put({"type": "done"})
            except Exception as e:
                await stream_q.put({"type": "error", "error": e})

        try:
            log.info(
                "received problem (chars={}, image={}, mime={})",
                len(question or ""),
                bool(image_b64),
                image_mime or "none",
            )
            yield StreamEvent(
                type="stage", stage="parse", message="reading and parsing problem..."
            )
            async for ev in _drain_queue(ui_queue):
                yield ev

            contents = _build_contents(question, image_b64, image_mime)
            log.info("calling Gemini ({}) ...", self._model)
            async for ev in _drain_queue(ui_queue):
                yield ev

            fetch_task = asyncio.create_task(_fetch())
            heartbeat_n = 1
            raw = ""

            while True:
                # Drain logs
                async for ev in _drain_queue(ui_queue):
                    yield ev

                try:
                    item = await asyncio.wait_for(stream_q.get(), timeout=1.2)
                    if item["type"] == "chunk":
                        raw += item["text"]
                        yield StreamEvent(type="stream_chunk", message=item["text"])
                    elif item["type"] == "done":
                        break
                    elif item["type"] == "error":
                        raise item["error"]
                except asyncio.TimeoutError:
                    if time.perf_counter() - t0 > self._timeout:
                        fetch_task.cancel()
                        raise asyncio.TimeoutError(f"Gemini call timed out after {self._timeout}s")
                    yield StreamEvent(
                        type="heartbeat",
                        payload={"tick": heartbeat_n, "elapsed_s": round(time.perf_counter() - t0, 1)},
                    )
                    heartbeat_n += 1

            elapsed = time.perf_counter() - t0
            log.success("received {} chars from Gemini in {:.2f}s", len(raw), elapsed)
            async for ev in _drain_queue(ui_queue):
                yield ev

            try:
                data = _extract_json(raw)
                result = SolverResult.model_validate(data)
            except Exception as exc:
                log.warning("could not parse solver output: {}", exc)
                yield StreamEvent(
                    type="error",
                    message=f"could not parse solver output: {exc}",
                    payload={"raw": raw[:2000]},
                )
                return

            yield StreamEvent(
                type="stage",
                stage="parse",
                payload={"topic": result.topic, **result.parse.model_dump()},
            )
            await asyncio.sleep(0.06)

            yield StreamEvent(type="stage", stage="plan", payload=result.plan.model_dump())
            await asyncio.sleep(0.06)

            for step in result.solve:
                yield StreamEvent(type="stage", stage="solve", payload=step.model_dump())
                await asyncio.sleep(0.07)

            yield StreamEvent(type="stage", stage="verify", payload=result.verify.model_dump())
            await asyncio.sleep(0.06)

            yield StreamEvent(
                type="result",
                payload={
                    "status": result.status,
                    "final": result.final.model_dump(),
                    "fallback": result.fallback,
                    "elapsed_s": round(elapsed, 2),
                },
            )
            yield StreamEvent(type="done", message=f"completed in {elapsed:.2f}s")
            
        except asyncio.TimeoutError as exc:
            log.error(str(exc))
            yield StreamEvent(type="error", message="Gemini call timed out")
            async for ev in _drain_queue(ui_queue):
                yield ev
            return
        except Exception as exc:
            log.exception("Gemini call failed")
            yield StreamEvent(type="error", message=f"Gemini error: {exc}")
            async for ev in _drain_queue(ui_queue):
                yield ev
            return
        finally:
            reset_ui_log_queue(token)


async def _drain_queue(queue: asyncio.Queue) -> AsyncIterator[StreamEvent]:
    """Yield every queued log record as a StreamEvent. Non-blocking."""
    while True:
        try:
            entry = queue.get_nowait()
        except asyncio.QueueEmpty:
            return
        yield StreamEvent(type="log", payload=entry)


# silence noisy "unused import" linter while exposing the loguru logger
__all__ = ["JeeSolver", "_extract_json", "_loguru_logger"]
