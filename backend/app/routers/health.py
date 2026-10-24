"""
Router: /health - Health check.
"""

import time
from fastapi import APIRouter
from pydantic import BaseModel
from ..config import get_settings
from ..redis_client import get_redis

router = APIRouter(tags=["Health"])

_PING_CACHE_TTL = 5.0
_ping_cached_at: float = 0.0
_ping_cached_ok: bool | None = None


class HealthResponse(BaseModel):
    status: str
    redis_connected: bool
    version: str


@router.get("/health", response_model=HealthResponse, summary="Health check")
async def health_check():
    """Kiểm tra trạng thái API và kết nối Redis (cache ngắn 5s để tránh spam Upstash)."""
    global _ping_cached_at, _ping_cached_ok
    settings = get_settings()
    now = time.monotonic()
    if _ping_cached_ok is not None and (now - _ping_cached_at) < _PING_CACHE_TTL:
        redis_ok = _ping_cached_ok
    else:
        redis = get_redis()
        redis_ok = await redis.ping()
        _ping_cached_ok = redis_ok
        _ping_cached_at = now
    return HealthResponse(
        status="ok" if redis_ok else "degraded",
        redis_connected=redis_ok,
        version=settings.app_version,
    )


@router.get("/", summary="Root")
def root():
    """Root endpoint."""
    settings = get_settings()
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "docs": "/docs",
        "health": "/health",
    }
