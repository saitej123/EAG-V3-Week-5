"""Project-wide logger backed by loguru.

Two sinks are configured:

1. A pretty stdout sink for the developer.
2. A *per-request* queue sink that the SSE handler drains and forwards to the
   browser, so every `logger.info(...)` call made anywhere in the codebase
   (including from inside `solver.py`) appears live in the UI's Logs panel
   with proper level + timestamp + module name.

The per-request queue is selected via a `contextvars.ContextVar`, so it works
correctly under FastAPI's async request handling without leaking between
concurrent requests.
"""

from __future__ import annotations

import asyncio
import contextvars
import sys
from typing import Any

from loguru import logger

from .config import get_settings


# ------------------------------------------------------------------
# per-request queue (set by the SSE handler, consumed by the UI sink)
# ------------------------------------------------------------------

_LOG_QUEUE: contextvars.ContextVar[asyncio.Queue | None] = contextvars.ContextVar(
    "ui_log_queue", default=None
)


def set_ui_log_queue(queue: asyncio.Queue | None) -> contextvars.Token:
    """Bind a queue for the duration of a request. Returns a reset token."""
    return _LOG_QUEUE.set(queue)


def reset_ui_log_queue(token: contextvars.Token) -> None:
    _LOG_QUEUE.reset(token)


# ------------------------------------------------------------------
# sinks
# ------------------------------------------------------------------


def _ui_sink(message: Any) -> None:
    """Forward every log record to the active per-request queue, if any."""
    queue = _LOG_QUEUE.get()
    if queue is None:
        return
    record = message.record
    entry = {
        "level": record["level"].name,
        "time": record["time"].strftime("%H:%M:%S"),
        "name": record["name"],
        "msg": record["message"],
    }
    try:
        queue.put_nowait(entry)
    except asyncio.QueueFull:
        # Drop on overflow rather than block the producer.
        pass


_CONFIGURED = False


def configure_logging() -> None:
    """Idempotent loguru configuration."""
    global _CONFIGURED
    if _CONFIGURED:
        return
    settings = get_settings()
    logger.remove()
    logger.add(
        sys.stdout,
        level=settings.log_level,
        colorize=True,
        format=(
            "<green>{time:HH:mm:ss}</green> | "
            "<level>{level: <7}</level> | "
            "<cyan>{name}</cyan> - <level>{message}</level>"
        ),
        backtrace=False,
        diagnose=False,
        enqueue=False,
    )
    logger.add(_ui_sink, level="DEBUG", format="{message}")
    _CONFIGURED = True


def get_logger(name: str | None = None):
    configure_logging()
    return logger.bind(name=name) if name else logger


__all__ = [
    "configure_logging",
    "get_logger",
    "set_ui_log_queue",
    "reset_ui_log_queue",
    "logger",
]
