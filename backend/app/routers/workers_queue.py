"""
Router: /worker — Unified worker task queue với atomic lease-based delivery.

Flow:
  1. POST /worker/tasks/claim          → atomic RPOP+SET NX (Lua), trả delivery_id
  2. POST /worker/tasks/renew          → gia hạn lease; fencing qua delivery_id
  3. POST /worker/tasks/ack            → xóa lease; fencing qua delivery_id
  4. POST /worker/tasks/recover        → machine restart → re-enqueue active_list
  5. POST /worker/tasks/reap           → background scan tất cả machines, re-enqueue expired
  6. GET  /worker/queue/depth          → số task trong queue

Delivery token:
  - Mỗi claim tạo delivery_id mới = "{instance_uuid}:{counter}"
  - renew/ack PHẢI kèm delivery_id khớp → worker cũ crash+restart không thể
    ACK/renew lease của worker instance mới đang chạy cùng task đó.
"""

import json
import time
import uuid
import logging
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..redis_client import (
    get_redis,
    LEASE_TTL,
    LEASE_RENEW_INTERVAL,
    TASK_DATA_TTL,
)
from ..config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/worker", tags=["Worker Queue"])

# ── Request models ────────────────────────────────────────────────────────────

class TaskAckRequest(BaseModel):
    machine_id: str
    task_id: str
    delivery_id: str
    runtime_id: str = ''
    instance_id: str = ''
    generation: int = 0


class TaskRenewRequest(BaseModel):
    machine_id: str
    task_id: str
    delivery_id: str
    runtime_id: str = ''
    instance_id: str = ''
    generation: int = 0


class VerifyTaskRequest(BaseModel):
    task_id: str
    delivery_id: str


class WorkerQueueDepthResponse(BaseModel):
    queue_depth: int


def _requires_worker_secret(x_worker_secret: Optional[str]) -> None:
    settings = get_settings()
    if x_worker_secret != settings.worker_secret:
        raise HTTPException(status_code=401, detail="Worker secret không hợp lệ.")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/tasks/verify", summary="[Internal] Verify current delivery before execution handoff")
async def verify_task_delivery(
    req: VerifyTaskRequest,
    x_internal_secret: str | None = Header(None, alias="X-Internal-Secret"),
):
    if x_internal_secret != get_settings().internal_backend_secret:
        raise HTTPException(status_code=401, detail="Invalid internal secret.")
    lease = await get_redis().get_json(f"worker:lease:{req.task_id}")
    return {"ok": bool(lease and lease.get("delivery_id") == req.delivery_id)}

@router.post("/tasks/claim", summary="[Worker] Lấy task tiếp theo (atomic claim)")
async def claim_worker_task(
    machine_id: str,
    x_worker_secret: str = Header(None, alias="X-Worker-Secret"),
    runtime_id: str = '', instance_id: str = '', generation: int = 0,
):
    """
    Atomic RPOP + SET NX trong một Lua script.
    - machine_id = hostname (ổn định qua restart)
    - delivery_id được tạo mới mỗi lần claim = "{instance_uuid}:{counter}"
    - Trả về task + delivery_id để dùng trong renew/ack

    Race condition: nếu lease đã tồn tại (task được re-enqueue và đã claimed),
    task được đẩy lại queue và endpoint trả {"task": null}.
    """
    _requires_worker_secret(x_worker_secret)

    # delivery_id = instance_uuid embedded trong caller; server tạo nếu không có
    # Dùng server-side UUID để không phụ thuộc worker truyền đúng
    delivery_id = f"{uuid.uuid4().hex[:12]}:{int(time.time())}"

    redis = get_redis()
    task_id, delivery_id_out, task_dict = await redis.atomic_claim(
        machine_id=machine_id,
        delivery_id=delivery_id,
        runtime_id=runtime_id, instance_id=instance_id, generation=generation,
    )

    if task_id is None:
        return {"task": None}

    logger.info(
        f"Machine {machine_id} claimed task {task_id} "
        f"(delivery={delivery_id_out})"
    )
    return {
        "task": task_dict,
        "task_id": task_id,
        "delivery_id": delivery_id_out,
        "lease_ttl": LEASE_TTL,
        "renew_interval": LEASE_RENEW_INTERVAL,
    }


@router.post("/tasks/renew", summary="[Worker] Gia hạn lease (fenced by delivery_id)")
async def renew_task_lease(
    req: TaskRenewRequest,
    x_worker_secret: str = Header(None, alias="X-Worker-Secret"),
):
    """
    Gia hạn lease. Chỉ thành công nếu delivery_id khớp với lease hiện tại.
    - ok=True  → lease được gia hạn thêm LEASE_TTL giây
    - ok=False → lease gone (expired) hoặc delivery_id không khớp (fencing)

    Worker nên dừng task và không ACK nếu renew trả False.
    """
    _requires_worker_secret(x_worker_secret)

    redis = get_redis()
    renewed = await redis.renew_lease(
        machine_id=req.machine_id,
        task_id=req.task_id,
        delivery_id=req.delivery_id,
        runtime_id=req.runtime_id, instance_id=req.instance_id, generation=req.generation,
    )
    return {
        "ok": renewed,
        "new_ttl": LEASE_TTL if renewed else 0,
    }


@router.post("/tasks/ack", summary="[Worker] ACK task sau callback thành công (fenced by delivery_id)")
async def ack_task(
    req: TaskAckRequest,
    x_worker_secret: str = Header(None, alias="X-Worker-Secret"),
):
    """
    Xóa lease sau khi callback về frontend đã được xác nhận (HTTP 200/201).
    Chỉ xóa nếu delivery_id khớp — worker cũ không thể ACK task của instance mới.
    - ok=True   → lease xóa thành công (hoặc đã gone — idempotent)
    - ok=False  → delivery_id không khớp; task KHÔNG bị xóa (safety)
    """
    _requires_worker_secret(x_worker_secret)

    redis = get_redis()
    acked = await redis.ack_task(
        machine_id=req.machine_id,
        task_id=req.task_id,
        delivery_id=req.delivery_id,
        runtime_id=req.runtime_id, instance_id=req.instance_id, generation=req.generation,
    )
    if not acked:
        # Fencing kick — log nhưng không báo lỗi cho worker (worker chỉ cần move on)
        logger.warning(
            f"ACK fenced: machine={req.machine_id} task={req.task_id} "
            f"delivery={req.delivery_id}"
        )
    return {"ok": acked}


@router.post("/tasks/recover", summary="[Worker] Re-enqueue tasks bị stuck khi machine restart")
async def recover_tasks(
    machine_id: str,
    x_worker_secret: str = Header(None, alias="X-Worker-Secret"),
):
    """
    Machine gọi khi khởi động lại.
    Tất cả task trong active_list[machine_id] đều bị coi là stuck vì machine vừa restart.
    - Task còn task_data → re-enqueue vào queue
    - Task data expired (>2h) → báo lost, cần DB reset
    """
    _requires_worker_secret(x_worker_secret)

    redis = get_redis()
    # Legacy clients cannot declare another live console dead. Managed recovery
    # uses /workers/release-runtime with supervisor generation fencing instead.
    stuck = await redis.lrange(f'worker:active_list:{machine_id}', 0, -1)

    recovered = 0
    lost = 0

    for task_id in stuck:
        outcome = await redis.recover_task(machine_id, task_id)
        if outcome == 1:
            recovered += 1
        elif outcome == -1:
            logger.error(
                f"Recover: task {task_id} data expired — lost "
                f"(machine={machine_id}). DB reset needed."
            )
            lost += 1

    if recovered or lost:
        logger.info(f"Machine {machine_id} recovery: {recovered} re-enqueued, {lost} lost")

    return {"ok": True, "recovered": recovered, "lost": lost}


@router.post("/tasks/reap", summary="[Worker/Admin] Scan tất cả machines, re-enqueue expired leases")
async def reap_expired(
    x_worker_secret: str = Header(None, alias="X-Worker-Secret"),
):
    """
    Background reaper — worker gọi định kỳ mỗi 60s (hoặc admin gọi tay).
    Scan active_list của tất cả machines đã biết:
    - lease hết TTL + task_data còn → re-enqueue
    - cả hai hết TTL → lost (cần DB reset)

    Không phụ thuộc vào machine restart hay admin gọi tay.
    """
    _requires_worker_secret(x_worker_secret)

    redis = get_redis()
    result = await redis.reap_expired_tasks()

    if result["reaped"] or result["lost"]:
        logger.info(
            f"Reap: {result['checked']} checked, "
            f"{result['reaped']} re-enqueued, "
            f"{result['lost']} lost"
        )
    return {"ok": True, **result}


@router.post("/tasks/recover-all", summary="[Admin] Re-enqueue tất cả stuck tasks (alias cho reap)")
async def recover_all_tasks(
    x_worker_secret: str = Header(None, alias="X-Worker-Secret"),
):
    """Admin alias: same as /tasks/reap."""
    _requires_worker_secret(x_worker_secret)
    redis = get_redis()
    result = await redis.reap_expired_tasks()
    return {"ok": True, "total_recovered": result["reaped"], "total_lost": result["lost"]}


@router.get("/queue/depth", response_model=WorkerQueueDepthResponse,
            summary="Độ sâu unified worker queue")
async def worker_queue_depth():
    return {"queue_depth": await get_redis().worker_queue_depth()}
