"""Pydantic models exchanged between API <-> client and solver <-> API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# --------------------------- request ---------------------------


class SolveRequest(BaseModel):
    question: str = Field(default="", description="Text of the JEE problem")
    image_b64: str | None = Field(
        default=None,
        description="Base64-encoded image bytes (without data: prefix)",
    )
    image_mime: str | None = Field(
        default=None,
        description="MIME type of the image, e.g. image/png",
    )
    image_name: str | None = Field(
        default=None,
        description="Optional original image filename, used only for logs/UI debugging",
    )


# --------------------------- solver pipeline payloads ---------------------------


class ParseStage(BaseModel):
    restated: str = ""
    given: list[str] = Field(default_factory=list)
    unknown: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)


class PlanStage(BaseModel):
    approach: str = ""
    tools: list[str] = Field(default_factory=list)
    reasoning_type: str = "logic"


class SolveStep(BaseModel):
    n: int
    reasoning_type: str
    action: str
    math: str = ""
    result: str = ""


class VerifyStage(BaseModel):
    method: str = ""
    passed: bool = False
    details: str = ""
    reasoning_type: str = "verification"


class FinalAnswer(BaseModel):
    answer: str = ""
    summary: str = ""
    confidence: float = 0.0


class SolverResult(BaseModel):
    status: Literal["ok", "uncertain", "rejected"] = "ok"
    topic: str = ""
    parse: ParseStage = Field(default_factory=ParseStage)
    plan: PlanStage = Field(default_factory=PlanStage)
    solve: list[SolveStep] = Field(default_factory=list)
    verify: VerifyStage = Field(default_factory=VerifyStage)
    final: FinalAnswer = Field(default_factory=FinalAnswer)
    fallback: str = ""


# --------------------------- streaming events ---------------------------


class StreamEvent(BaseModel):
    """One event pushed over the SSE channel to the browser."""

    type: Literal[
        "log",
        "stage",
        "heartbeat",
        "stream_chunk",
        "result",
        "error",
        "done",
    ]
    stage: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    message: str | None = None
