"""Runtime configuration loaded from environment / .env file.

Implemented with the stdlib + python-dotenv only, so there is no hard
dependency on `pydantic-settings` (which is a frequent install miss).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - dotenv is optional at runtime
    def load_dotenv(*args, **kwargs):  # type: ignore[no-redef]
        return False


_PROJECT_ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    gemini_api_key: str
    gemini_model: str
    log_level: str
    request_timeout_s: float
    max_image_bytes: int


def _bool_env(name: str, default: bool = False) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    load_dotenv(_PROJECT_ROOT / ".env", override=False)
    return Settings(
        gemini_api_key=os.getenv("GEMINI_API_KEY", "").strip(),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip(),
        log_level=os.getenv("LOG_LEVEL", "INFO").strip().upper(),
        request_timeout_s=float(os.getenv("REQUEST_TIMEOUT_S", "90")),
        max_image_bytes=int(os.getenv("MAX_IMAGE_BYTES", str(8 * 1024 * 1024))),
    )
