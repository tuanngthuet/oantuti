"""Queue endpoints for continuously scheduled TrueSkill matches."""

import json
import logging
from typing import Literal
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from ..redis_client import get_redis
from ..config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/rating", tags=["Rating"])


class EnqueueRatingRequest(BaseModel):
    rated_match_id: int
    kind: Literal["validation", "rating"]
    agent1_id: int
    agent1_code: str = Field(max_length=131072)   # 128 KB hard cap
    agent2_id: int
    agent2_code: str = Field(max_length=131072)
    max_moves: int = Field(default=200, ge=50, le=1000)
    callback_url: str = Field(default="", max_length=256)


def _require_internal_secret(x_internal_secret: str | None) -> None:
    settings = get_settings()
    if x_internal_secret != settings.internal_backend_secret:
        raise HTTPException(status_code=401, detail="Invalid internal secret.")


@router.post("/enqueue", summary="[Internal] Enqueue a TrueSkill validation or rating match")
async def enqueue_rating_task(
    req: EnqueueRatingRequest,
    x_internal_secret: str | None = Header(None, alias="X-Internal-Secret"),
):
    """
    Next.js server → FastAPI để enqueue một trận rating/validation.
    Không cho phép gọi trực tiếp từ browser hay worker.
    """
    _require_internal_secret(x_internal_secret)

    settings = get_settings()
    # callback_url do server cấu hình, không nhận từ client request
    # nếu caller không gửi, dùng CORS origins fallback (không cần — worker dùng FRONTEND_URL config sẵn)
    task = {
        "task_type": "rating",
        "rated_match_id": req.rated_match_id,
        "kind": req.kind,
        "agent1_id": req.agent1_id,
        "agent1_code": req.agent1_code,
        "agent2_id": req.agent2_id,
        "agent2_code": req.agent2_code,
        "max_moves": min(req.max_moves, 60) if req.kind == 'validation' else 200,
        # callback_url bị bỏ qua — worker dùng FRONTEND_URL env var mình cấu hình
    }
    await get_redis().enqueue_worker_task(json.dumps(task))
    logger.info("Enqueued %s rating task #%s", req.kind, req.rated_match_id)
    return {"ok": True, "queued": True, "rated_match_id": req.rated_match_id}
