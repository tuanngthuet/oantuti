"""Queue endpoints for friendly matches."""

import json
import logging
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from ..redis_client import get_redis
from ..config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/friendly", tags=["Friendly"])


class EnqueueFriendlyRequest(BaseModel):
    friendly_match_id: int
    agent1_id: int
    agent1_code: str = Field(max_length=131072)
    agent2_id: int
    agent2_code: str = Field(max_length=131072)
    max_moves: int = Field(default=200, ge=50, le=1000)


def _require_internal_secret(x_internal_secret: str | None) -> None:
    settings = get_settings()
    if x_internal_secret != settings.internal_backend_secret:
        raise HTTPException(status_code=401, detail="Invalid internal secret.")


@router.post("/enqueue", summary="[Internal] Enqueue a friendly match")
async def enqueue_friendly_task(
    req: EnqueueFriendlyRequest,
    x_internal_secret: str | None = Header(None, alias="X-Internal-Secret"),
):
    """
    Next.js server → FastAPI để enqueue một trận friendly.
    callback_url do worker tự biết qua FRONTEND_URL env; không nhận từ request.
    """
    _require_internal_secret(x_internal_secret)

    task = {
        "task_type": "friendly",
        "friendly_match_id": req.friendly_match_id,
        "agent1_id": req.agent1_id,
        "agent1_code": req.agent1_code,
        "agent2_id": req.agent2_id,
        "agent2_code": req.agent2_code,
        "max_moves": 200,
        # callback_url bỏ qua — worker dùng FRONTEND_URL env var
    }
    await get_redis().enqueue_worker_task(json.dumps(task))
    logger.info("Enqueued friendly task #%s", req.friendly_match_id)
    return {"ok": True, "queued": True, "friendly_match_id": req.friendly_match_id}


@router.get("/queue/depth", summary="Độ sâu friendly task queue")
async def friendly_queue_depth():
    """Số task friendly đang chờ trong unified queue (không phân biệt loại)."""
    redis = get_redis()
    depth = await redis.worker_queue_depth()
    return {"queue_depth": depth}
