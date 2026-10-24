"""
Router: /workers - Worker management.
"""

import time
import json
import hashlib
import asyncio
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field, ConfigDict, model_validator
from typing import Literal

from ..redis_client import get_redis, WORKER_HEARTBEAT_TTL
from ..config import get_settings
from ..services import worker_control

router = APIRouter(prefix="/workers", tags=["Workers"])


class Registration(BaseModel):
    worker_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    machine_id: str = Field(min_length=1, max_length=128)
    hostname: str = Field(min_length=1, max_length=128)
    worker_name: str = Field(pattern=r'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$')
    instance_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    max_concurrent: int = Field(ge=1, le=64, strict=True)
    judge0_url: str = Field(max_length=256)


class SupervisorHeartbeat(BaseModel):
    worker_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    instance_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    generation: int = Field(ge=1)
    runtime_id: str = Field(default='', pattern=r'^([a-f0-9]{32})?$')
    state: Literal['starting', 'running', 'paused', 'draining', 'stopping', 'stopped', 'error']
    active_jobs: int = Field(ge=0, le=64)
    max_concurrent: int = Field(ge=1, le=64)
    active_task_ids: list[str] = Field(default_factory=list, max_length=64)
    applied_revision: int = Field(default=0, ge=0)
    last_error: str = Field(default='', max_length=1000)
    judge0_url: str = Field(max_length=256)
    pid: int | None = None
    supervisor_pid: int | None = None


class WorkerUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int = Field(ge=1, strict=True)
    action: Literal['start', 'pause', 'resume', 'stop'] | None = None
    stop_mode: Literal['graceful', 'immediate'] = 'graceful'
    max_concurrent: int | None = Field(default=None, ge=1, le=64, strict=True)
    updated_by: str = Field(min_length=1, max_length=128)

    @model_validator(mode='after')
    def require_change(self):
        if self.action is None and self.max_concurrent is None:
            raise ValueError('Provide an action or max_concurrent')
        return self


class ReleaseRuntime(BaseModel):
    worker_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    instance_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    generation: int = Field(ge=1)
    runtime_id: str = Field(default='', pattern=r'^([a-f0-9]{32})?$')
    old_only: bool = False


def require_secret(value: str | None, internal: bool = False):
    settings = get_settings()
    if value != (settings.internal_backend_secret if internal else settings.worker_secret):
        raise HTTPException(401, 'Invalid secret.')


@router.post('/register')
async def register_supervisor(req: Registration, x_worker_secret: str | None = Header(None)):
    require_secret(x_worker_secret)
    expected = hashlib.sha256(f'{req.machine_id}\0{req.worker_name}'.encode()).hexdigest()[:32]
    if expected != req.worker_id:
        raise HTTPException(422, 'Worker identity does not match machine/name.')
    return await worker_control.register(get_redis(), req.model_dump())


@router.post('/supervisor-heartbeat')
async def supervisor_heartbeat(req: SupervisorHeartbeat, x_worker_secret: str | None = Header(None)):
    require_secret(x_worker_secret)
    return await worker_control.heartbeat(get_redis(), req.model_dump())


@router.post('/release-runtime')
async def release_runtime(req: ReleaseRuntime, x_worker_secret: str | None = Header(None)):
    require_secret(x_worker_secret)
    if not req.runtime_id and not req.old_only:
        raise HTTPException(422, 'runtime_id required unless recovering old supervisors.')
    redis = get_redis()
    owner = await redis.get_json(f'workers:owner:{req.worker_id}')
    if not owner or owner['instance_id'] != req.instance_id or owner['generation'] != req.generation:
        raise HTTPException(409, 'Supervisor ownership lost.')
    semaphore = asyncio.Semaphore(8)
    async def release(task_id):
        async with semaphore:
            return await redis.recover_task(req.worker_id, task_id, expired_only=False,
                instance_id=req.instance_id, generation=req.generation,
                runtime_id=req.runtime_id, old_only=req.old_only)
    outcomes = await asyncio.gather(*[release(task_id) for task_id in
        await redis.lrange(f'worker:active_list:{req.worker_id}', 0, -1)])
    recovered = sum(value == 1 for value in outcomes)
    lost = sum(value == -1 for value in outcomes)
    return {'recovered': recovered, 'lost': lost}


@router.get('/admin')
async def admin_workers(x_internal_secret: str | None = Header(None)):
    require_secret(x_internal_secret, internal=True)
    redis = get_redis()
    workers, depth = await asyncio.gather(worker_control.list_workers(redis), redis.worker_queue_depth())
    return {'workers': workers, 'queue_depth': depth}


@router.patch('/admin/{worker_id}')
async def control_worker(worker_id: str, req: WorkerUpdate, x_internal_secret: str | None = Header(None)):
    require_secret(x_internal_secret, internal=True)
    return await worker_control.update(get_redis(), worker_id, req.model_dump())


class HeartbeatRequest(BaseModel):
    worker_id: str
    judge0_url: str
    active_jobs: int
    max_concurrent: int
    available_slots: int
    timestamp: float
    active_task_ids: list[str] = []  # e.g. ["rating-12", "friendly-5"]


class WorkerInfo(BaseModel):
    worker_id: str
    judge0_url: str
    active_jobs: int
    max_concurrent: int
    available_slots: int
    last_seen: float
    seconds_ago: int
    active_task_ids: list[str] = []
    state: str | None = None
    last_error: str = ''


class WorkersStatusResponse(BaseModel):
    workers: list[WorkerInfo]
    total_workers: int
    total_active_jobs: int
    total_available_slots: int
    queue_depth: int


@router.post("/heartbeat", summary="[Worker] Gửi heartbeat")
async def worker_heartbeat(
    req: HeartbeatRequest,
    x_worker_secret: str = Header(..., alias="X-Worker-Secret"),
):
    """Worker gọi mỗi 30s (hoặc ngay khi job count thay đổi) để báo online."""
    settings = get_settings()
    if x_worker_secret != settings.worker_secret:
        raise HTTPException(status_code=401, detail="Worker secret không hợp lệ.")

    redis = get_redis()
    if await redis.exists(f'workers:control:{req.worker_id}'):
        raise HTTPException(409, 'This worker requires the supervisor heartbeat protocol.')
    info = {
        "worker_id": req.worker_id,
        "judge0_url": req.judge0_url,
        "active_jobs": req.active_jobs,
        "max_concurrent": req.max_concurrent,
        "available_slots": req.available_slots,
        "active_task_ids": req.active_task_ids,
        "last_seen": req.timestamp,
    }
    await redis.worker_heartbeat(req.worker_id, info)

    # Track worker_id trong set để có thể list
    known = await redis.get_json("workers:known") or {}
    known[req.worker_id] = req.timestamp
    # Xóa worker cũ (quá HEARTBEAT_TTL * 2)
    cutoff = time.time() - WORKER_HEARTBEAT_TTL * 2
    known = {k: v for k, v in known.items() if v > cutoff}
    await redis.set_json("workers:known", known, ex=WORKER_HEARTBEAT_TTL * 3)

    return {"ok": True}


@router.get("/status", response_model=WorkersStatusResponse, summary="Trạng thái workers")
async def workers_status():
    """
    Trả về danh sách worker đang active và trạng thái queue.
    Public endpoint — không cần auth.
    """
    redis = get_redis()
    now = time.time()

    known, managed, queue_depth = await asyncio.gather(
        redis.get_json("workers:known"), redis._cmd('SMEMBERS', 'workers:managed'), redis.worker_queue_depth())
    ids = sorted(set(known or {}) | set(managed or []))
    raw_states = await redis._cmd('MGET', *[f'worker:{worker_id}' for worker_id in ids]) if ids else []
    workers = []

    for worker_id, raw in zip(ids, raw_states):
        info = json.loads(raw) if raw else None
        if not info:
            continue
        last_seen = info.get("last_seen", 0)
        # Bỏ qua worker đã im lặng quá HEARTBEAT_TTL giây
        if now - last_seen > WORKER_HEARTBEAT_TTL:
            continue
        workers.append(WorkerInfo(
            worker_id=worker_id,
            judge0_url=info.get("judge0_url", ""),
            active_jobs=info.get("active_jobs", 0),
            max_concurrent=info.get("max_concurrent", 0),
            available_slots=info.get("available_slots", 0),
            last_seen=last_seen,
            seconds_ago=int(now - last_seen),
            active_task_ids=info.get("active_task_ids", []),
            state=info.get('state'), last_error=info.get('last_error', ''),
        ))

    return WorkersStatusResponse(
        workers=workers,
        total_workers=len(workers),
        total_active_jobs=sum(w.active_jobs for w in workers),
        total_available_slots=sum(w.available_slots for w in workers),
        queue_depth=queue_depth,
    )
