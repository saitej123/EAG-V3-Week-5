"""FastAPI entry point.

Routes:
    GET  /                  -> shadcn-style HTML UI
    GET  /healthz           -> liveness
    POST /api/solve         -> SSE stream of reasoning events
"""

from __future__ import annotations

from pathlib import Path
import base64
import binascii

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .logger import configure_logging, get_logger
from .schemas import SolveRequest, StreamEvent
from .solver import JeeSolver

configure_logging()
log = get_logger("api")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(
    title="JEE-Solver",
    version="0.1.0",
    description="Async IIT-JEE math solver with transparent multi-stage reasoning, powered by Gemini.",
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_solver = JeeSolver()


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/qualification", include_in_schema=False)
async def qualification() -> FileResponse:
    return FileResponse(BASE_DIR / "PROMPT_QUALIFICATION.md", media_type="text/markdown")


@app.get("/healthz")
async def healthz() -> JSONResponse:
    settings = get_settings()
    return JSONResponse(
        {
            "status": "ok",
            "model": settings.gemini_model,
            "api_key_loaded": bool(settings.gemini_api_key),
        }
    )


@app.post("/api/debug-image")
async def debug_image(req: SolveRequest) -> JSONResponse:
    """Validate the image payload without calling Gemini.

    This is useful for debugging browser upload/paste issues.
    """
    if not req.image_b64:
        return JSONResponse({"ok": False, "error": "missing image_b64"}, status_code=400)

    payload = req.image_b64.strip()
    mime = req.image_mime or ""
    if payload.startswith("data:") and ";base64," in payload:
        header, payload = payload.split(";base64,", 1)
        mime = header.removeprefix("data:")
    try:
        decoded = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        return JSONResponse(
            {"ok": False, "error": f"invalid base64: {exc}", "mime": mime},
            status_code=400,
        )

    return JSONResponse(
        {
            "ok": True,
            "mime": mime,
            "name": req.image_name,
            "bytes": len(decoded),
            "question_chars": len(req.question or ""),
        }
    )


def _sse_pack(event: StreamEvent) -> bytes:
    return f"data: {event.model_dump_json()}\n\n".encode("utf-8")


@app.post("/api/solve")
async def api_solve(req: SolveRequest, request: Request) -> StreamingResponse:
    if not req.question.strip() and not req.image_b64:
        return JSONResponse(
            {"error": "Provide either `question` text or an image."},
            status_code=400,
        )

    log.info(
        "solve request: text_len={} image={} mime={} name={}",
        len(req.question or ""),
        bool(req.image_b64),
        req.image_mime or "none",
        req.image_name or "none",
    )

    async def event_stream():
        try:
            async for ev in _solver.stream_solve(
                question=req.question,
                image_b64=req.image_b64,
                image_mime=req.image_mime,
            ):
                if await request.is_disconnected():
                    log.info("client disconnected, stopping stream")
                    break
                yield _sse_pack(ev)
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("stream failed: {}", exc)
            err = StreamEvent(type="error", message=f"server error: {exc}")
            yield _sse_pack(err)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
