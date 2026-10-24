"""
Redis client wrapper dùng Upstash REST API (tương thích serverless/Vercel).

Key conventions:
  worker:queue                   → FIFO queue; payload có task_id cố định (LPUSH/RPOP)
  worker:lease:{task_id}         → JSON lease (TTL=LEASE_TTL); chứa delivery_id + machine_id
  worker:task_data:{task_id}     → raw task JSON (TTL=TASK_DATA_TTL) để crash-recovery
  worker:machine:{machine_id}    → JSON heartbeat của machine (TTL=HEARTBEAT_TTL)
  workers:known                  → JSON map {machine_id: timestamp}

Delivery model:
  ┌──────────────────────────────────────────────────────────────────────────────────┐
  │  ENQUEUE      → task_id gắn vào payload ngay khi enqueue (idempotent)           │
  │  CLAIM (Lua)  → RPOP queue + SET NX lease{delivery_id} trong 1 script atomic    │
  │                 → không thể mất task giữa 2 bước                                 │
  │  RENEW (Lua)  → kiểm tra worker_id + delivery_id khớp trước khi EXPIRE          │
  │  ACK   (Lua)  → kiểm tra worker_id + delivery_id khớp trước khi DEL             │
  │                 → worker cũ restart không thể ACK lease của worker mới           │
  │  REAP         → scan active_list của tất cả machines, re-enqueue lease hết hạn  │
  └──────────────────────────────────────────────────────────────────────────────────┘

machine_id = hostname (ổn định qua restart, dùng làm key active_list)
instance_id = uuid4 per process (embed trong delivery_id, phân biệt restart)
delivery_id = "{instance_id}:{monotonic_counter}" — unique per claim
"""

import json
import logging
import time
import uuid
import httpx
from typing import Any, Optional

from .config import get_settings

logger = logging.getLogger(__name__)

WORKER_HEARTBEAT_TTL  = 90       # giây
LEASE_TTL             = 720      # giây (12 phút — đủ cho 1 trận ~300 nước × ~1s)
LEASE_RENEW_INTERVAL  = 120      # giây (worker gia hạn mỗi 2 phút)
TASK_DATA_TTL         = 7200     # giây (2 giờ — đủ dài để recover sau downtime)
# Reaper quét tất cả machine active_lists, re-enqueue task hết lease
REAP_SCAN_LIMIT       = 200      # tối đa task_id scan mỗi lần reap

# ── Lua scripts ───────────────────────────────────────────────────────────────
# Upstash hỗ trợ EVAL qua REST với endpoint /pipeline hoặc cú pháp đặc biệt.
# Dùng /eval endpoint: POST body = ["EVAL", script, numkeys, key1..., arg1...]

# Script 1: Atomic RPOP + SET NX lease
# KEYS[1] = queue key
# KEYS[2] = lease key (worker:lease:{task_id})
# ARGV[1] = lease JSON string
# ARGV[2] = LEASE_TTL (giây)
# Returns: 1 nếu claim thành công, 0 nếu queue rỗng, -1 nếu lease đã tồn tại
_CLAIM_SCRIPT = """
local raw = redis.call('RPOP', KEYS[1])
if raw == false then return {0, ''} end
local ok = redis.call('SET', KEYS[2], ARGV[1], 'EX', tonumber(ARGV[2]), 'NX')
if ok == false then
  -- lease key đã tồn tại (task đã được claim trước đó, ví dụ re-enqueue race)
  -- đẩy lại vào queue tail để không mất task
  redis.call('RPUSH', KEYS[1], raw)
  return {-1, raw}
end
return {1, raw}
"""

# Script 2: Atomic renew — chỉ EXPIRE nếu delivery_id khớp
# KEYS[1] = lease key
# ARGV[1] = expected delivery_id
# ARGV[2] = new TTL
# Returns: 1 nếu renewed, 0 nếu không tồn tại, -1 nếu delivery_id không khớp
_SCOPE_CHECK = """
if lease.machine_id ~= ARGV[4] then return -1 end
if redis.call('EXISTS', KEYS[5]) == 1 then
  local raw_owner = redis.call('GET', KEYS[4])
  if not raw_owner then return -1 end
  local owner = cjson.decode(raw_owner)
  if owner.instance_id ~= ARGV[6] or owner.generation ~= tonumber(ARGV[7])
    or owner.runtime_id ~= ARGV[5] or lease.runtime_id ~= ARGV[5]
    or lease.supervisor_instance_id ~= ARGV[6] then return -1 end
end
"""

_RENEW_SCRIPT = """
local raw = redis.call('GET', KEYS[1])
if raw == false then return 0 end
local lease = cjson.decode(raw)
if lease['delivery_id'] ~= ARGV[1] then return -1 end
""" + _SCOPE_CHECK + """
lease['expires_at'] = tonumber(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(lease), 'EX', tonumber(ARGV[2]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[8]))
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[8]))
return 1
"""

# Script 3: Atomic ack — chỉ DEL nếu delivery_id khớp
# KEYS[1] = lease key
# KEYS[2] = task_data key
# ARGV[1] = expected delivery_id
# Returns: 1 nếu acked, 0 nếu không tồn tại, -1 nếu delivery_id không khớp
_ACK_SCRIPT = """
local raw = redis.call('GET', KEYS[1])
if raw == false then return 1 end  -- already gone = idempotent success
local lease = cjson.decode(raw)
if lease['delivery_id'] ~= ARGV[1] then return -1 end
""" + _SCOPE_CHECK + """
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('LREM', KEYS[3], 0, ARGV[9])
return 1
"""

_RECOVER_SCRIPT = """
if ARGV[4] ~= '' then
  local raw_owner = redis.call('GET', KEYS[5])
  if not raw_owner then return 0 end
  local owner = cjson.decode(raw_owner)
  if owner.instance_id ~= ARGV[4] or owner.generation ~= tonumber(ARGV[5]) then return 0 end
end
local raw_lease = redis.call('GET', KEYS[1])
if raw_lease then
  if ARGV[3] == '1' then return 0 end
  local lease = cjson.decode(raw_lease)
  if lease.machine_id ~= ARGV[1] then return 0 end
  if ARGV[6] ~= '' and lease.runtime_id ~= ARGV[6] then return 0 end
  if ARGV[7] == '1' and lease.supervisor_instance_id == ARGV[4] then return 0 end
elseif ARGV[3] ~= '1' and ARGV[6] ~= '' then
  -- Lease expired: the active-list membership still belongs to this worker;
  -- no newer delivery can be removed without its lease being checked above.
end
if redis.call('LREM', KEYS[3], 0, ARGV[2]) == 0 then return 0 end
local raw = redis.call('GET', KEYS[2])
redis.call('DEL', KEYS[1])
if not raw then return -1 end
redis.call('LPUSH', KEYS[4], raw)
return 1
"""

# ─────────────────────────────────────────────────────────────────────────────


class RedisClient:
    """Thin async wrapper quanh Upstash Redis REST API."""

    def __init__(self) -> None:
        settings = get_settings()
        self._url   = settings.upstash_redis_rest_url.rstrip("/")
        self._token = settings.upstash_redis_rest_token
        self._key_prefix = settings.redis_key_prefix

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }

    async def _cmd(self, *args: Any) -> Any:
        """Gửi 1 Redis command qua REST."""
        command = list(args)
        prefix = getattr(self, "_key_prefix", "")
        if prefix:
            name = str(command[0]).upper()
            if name == "EVAL":
                for index in range(3, 3 + int(command[2])):
                    command[index] = prefix + str(command[index])
            elif name in {"DEL", "EXISTS", "MGET"}:
                command[1:] = [prefix + str(key) for key in command[1:]]
            elif name != "PING":
                command[1] = prefix + str(command[1])
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                self._url,
                headers=self._headers(),
                json=command,
            )
            resp.raise_for_status()
            data = resp.json()
            if "error" in data:
                raise RuntimeError(f"Redis error: {data['error']}")
            return data.get("result")

    async def _eval(self, script: str, keys: list[str], args: list[Any]) -> Any:
        """
        Gửi Lua script qua EVAL.
        Upstash REST: POST body = ["EVAL", script, numkeys, key1..., arg1...]
        """
        cmd = ["EVAL", script, str(len(keys))] + keys + [str(a) for a in args]
        return await self._cmd(*cmd)

    # ── Basic ops ─────────────────────────────────────────────────────────────

    async def set(self, key: str, value: str, ex: Optional[int] = None) -> None:
        if ex:
            await self._cmd("SET", key, value, "EX", ex)
        else:
            await self._cmd("SET", key, value)

    async def get(self, key: str) -> Optional[str]:
        return await self._cmd("GET", key)

    async def delete(self, *keys: str) -> int:
        if not keys:
            return 0
        return await self._cmd("DEL", *keys)

    async def exists(self, key: str) -> bool:
        return bool(await self._cmd("EXISTS", key))

    async def expire(self, key: str, seconds: int) -> None:
        await self._cmd("EXPIRE", key, seconds)

    async def ttl(self, key: str) -> int:
        result = await self._cmd("TTL", key)
        return int(result) if result is not None else -2

    async def set_json(self, key: str, value: dict, ex: Optional[int] = None) -> None:
        await self.set(key, json.dumps(value), ex=ex)

    async def get_json(self, key: str) -> Optional[dict]:
        raw = await self.get(key)
        return json.loads(raw) if raw else None

    async def set_nx(self, key: str, value: str, ex: int) -> bool:
        result = await self._cmd("SET", key, value, "EX", ex, "NX")
        return result == "OK"

    async def lpush(self, key: str, *values: str) -> int:
        return await self._cmd("LPUSH", key, *values)

    async def rpush(self, key: str, *values: str) -> int:
        return await self._cmd("RPUSH", key, *values)

    async def rpop(self, key: str) -> Optional[str]:
        return await self._cmd("RPOP", key)

    async def llen(self, key: str) -> int:
        return await self._cmd("LLEN", key) or 0

    async def lrange(self, key: str, start: int, stop: int) -> list[str]:
        return await self._cmd("LRANGE", key, start, stop) or []

    async def lrem(self, key: str, count: int, value: str) -> int:
        return int(await self._cmd("LREM", key, count, value) or 0)

    # ── Queue ─────────────────────────────────────────────────────────────────

    WORKER_QUEUE_KEY = "worker:queue"

    async def enqueue_worker_task(self, task_json: str) -> None:
        """
        Enqueue task. Nếu payload chưa có task_id → gán một cái.
        task_id = "{type}-{match_id}" — ổn định, dùng làm lease key.
        """
        try:
            task = json.loads(task_json)
        except Exception:
            await self.lpush(self.WORKER_QUEUE_KEY, task_json)
            return

        if not task.get("task_id"):
            task_type = task.get("task_type", "unknown")
            match_id = (
                task.get("rated_match_id") or
                task.get("friendly_match_id") or
                task.get("match_id")
            )
            if match_id:
                task["task_id"] = f"{task_type}-{match_id}"
            else:
                task["task_id"] = f"{task_type}-{uuid.uuid4().hex[:8]}"
            task_json = json.dumps(task)

        # A dispatcher may retry after a timeout or after dispatched_at ages out.
        # Treat the same stable task ID as accepted, not as another queue entry.
        await self._eval("""
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
local offset = 0
while true do
  local values = redis.call('LRANGE', KEYS[1], offset, offset + 99)
  for _, raw in ipairs(values) do
    local ok, task = pcall(cjson.decode, raw)
    if ok and type(task) == 'table' and task.task_id == ARGV[1] then return 0 end
  end
  if #values < 100 then break end
  offset = offset + 100
end
redis.call('LPUSH', KEYS[1], ARGV[2])
return 1
""", keys=[self.WORKER_QUEUE_KEY, f"worker:lease:{task['task_id']}"],
            args=[task['task_id'], task_json])

    async def worker_queue_depth(self) -> int:
        return await self.llen(self.WORKER_QUEUE_KEY)

    # ── Atomic claim (Lua) ────────────────────────────────────────────────────

    async def atomic_claim(
        self,
        machine_id: str,
        delivery_id: str,
        runtime_id: str = '',
        instance_id: str = '',
        generation: int = 0,
    ) -> tuple[str | None, str | None, dict | None]:
        """
        Atomic RPOP + SET NX trong 1 Lua script.
        Returns (task_id, delivery_id, task_dict) nếu claim thành công.
        Returns (None, None, None) nếu queue rỗng hoặc đã có lease (race condition).

        Lease payload:
          {machine_id, delivery_id, task_id, claimed_at, expires_at}
        """
        # Cần task_id để biết lease key — đọc trước không atomic.
        # Giải pháp: dùng script để RPOP, decode task_id từ Lua, SET NX.
        # Vì Upstash Lua có cjson, ta decode trong script.

        claim_script = """
local prefix = ARGV[6]
local control_raw = redis.call('GET', prefix .. 'workers:control:' .. ARGV[1])
if control_raw then
  local owner_raw = redis.call('GET', prefix .. 'workers:owner:' .. ARGV[1])
  if not owner_raw then return {-3, '', ''} end
  local owner = cjson.decode(owner_raw)
  local control = cjson.decode(control_raw)
  if owner.instance_id ~= ARGV[8] or owner.generation ~= tonumber(ARGV[9])
    or owner.runtime_id ~= ARGV[7] or ARGV[7] == '' or control.mode ~= 'running' then return {-3, '', ''} end
  if redis.call('LLEN', prefix .. 'worker:active_list:' .. ARGV[1]) >= control.max_concurrent then return {-3, '', ''} end
end
local raw = redis.call('RPOP', KEYS[1])
if raw == false then return {0, '', ''} end
local ok, task = pcall(cjson.decode, raw)
if not ok or type(task) ~= 'table' then return {-2, '', raw} end
local task_id = task['task_id']
if type(task_id) ~= 'string' or task_id == '' then return {-2, '', raw} end
local lease_key = prefix .. 'worker:lease:' .. task_id
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local lease = cjson.encode({
  machine_id   = ARGV[1],
  delivery_id  = ARGV[2],
  task_id      = task_id,
  claimed_at   = now,
  expires_at   = now + ttl,
  runtime_id   = ARGV[7],
  supervisor_instance_id = ARGV[8],
  generation = tonumber(ARGV[9]),
})
local set_ok = redis.call('SET', lease_key, lease, 'EX', ttl, 'NX')
if set_ok == false then
  -- Move the duplicate behind other queued work, avoiding FIFO starvation.
  redis.call('LPUSH', KEYS[1], raw)
  return {-1, task_id, raw}
end
redis.call('SET', prefix .. 'worker:task_data:' .. task_id, raw, 'EX', tonumber(ARGV[5]))
redis.call('LPUSH', prefix .. 'worker:active_list:' .. ARGV[1], task_id)
redis.call('EXPIRE', prefix .. 'worker:active_list:' .. ARGV[1], tonumber(ARGV[5]))
redis.call('SADD', prefix .. 'workers:machines', ARGV[1])
return {1, task_id, raw}
"""
        now = time.time()
        result = await self._eval(
            claim_script,
            keys=[self.WORKER_QUEUE_KEY],
            args=[machine_id, delivery_id, now, LEASE_TTL, TASK_DATA_TTL, getattr(self, "_key_prefix", ""),
                  runtime_id, instance_id, generation],
        )

        # result = [status_code, task_id_or_empty, raw_json_or_empty]
        if not result or not isinstance(result, list):
            return None, None, None

        status = int(result[0]) if result[0] is not None else 0
        task_id = result[1] if len(result) > 1 else ""
        raw = result[2] if len(result) > 2 else ""

        if status == 1 and task_id and raw:
            # Recovery data and active membership were persisted atomically
            # with the lease, so a crash after EVAL cannot orphan the task.
            try:
                task_dict = json.loads(raw)
                task_dict["task_id"] = task_id
                task_dict["delivery_id"] = delivery_id
                return task_id, delivery_id, task_dict
            except Exception:
                return task_id, delivery_id, None
        elif status == -1:
            logger.warning(f"Claim race: task {task_id} already has a live lease, skipping")
            return None, None, None
        elif status == -2:
            logger.error(f"Claim error: task JSON missing task_id, discarded: {str(raw)[:100]}")
            return None, None, None
        else:
            return None, None, None

    # ── Atomic renew (Lua) ────────────────────────────────────────────────────

    async def renew_lease(
        self,
        machine_id: str,
        task_id: str,
        delivery_id: str,
        runtime_id: str = '', instance_id: str = '', generation: int = 0,
    ) -> bool:
        """
        Gia hạn lease. Chỉ thành công nếu delivery_id khớp.
        worker_id cũ restart không thể renew lease của instance mới.
        Returns True nếu renewed, False nếu lease gone/stolen.
        """
        now = time.time()
        result = await self._eval(
            _RENEW_SCRIPT,
            keys=[f"worker:lease:{task_id}", f'worker:task_data:{task_id}', f'worker:active_list:{machine_id}',
                  f'workers:owner:{machine_id}', f'workers:control:{machine_id}'],
            args=[delivery_id, LEASE_TTL, now + LEASE_TTL, machine_id, runtime_id, instance_id, generation, TASK_DATA_TTL, task_id],
        )
        code = int(result) if result is not None else 0
        if code == 1:
            return True
        elif code == -1:
            logger.warning(
                f"Renew fencing: delivery_id mismatch for task {task_id} "
                f"(machine={machine_id}) — lease stolen by another instance"
            )
        elif code == 0:
            logger.info(f"Renew: lease for task {task_id} already gone (TTL expired)")
        return False

    # ── Atomic ack (Lua) ──────────────────────────────────────────────────────

    async def ack_task(
        self,
        machine_id: str,
        task_id: str,
        delivery_id: str,
        runtime_id: str = '', instance_id: str = '', generation: int = 0,
    ) -> bool:
        """
        ACK task sau khi callback thành công. Chỉ DEL nếu delivery_id khớp.
        Returns True nếu acked (hoặc lease đã gone — idempotent).
        Returns False nếu delivery_id không khớp (fencing).
        """
        result = await self._eval(
            _ACK_SCRIPT,
            keys=[
                f"worker:lease:{task_id}",
                f"worker:task_data:{task_id}",
                f'worker:active_list:{machine_id}', f'workers:owner:{machine_id}', f'workers:control:{machine_id}',
            ],
            args=[delivery_id, 0, 0, machine_id, runtime_id, instance_id, generation, TASK_DATA_TTL, task_id],
        )
        code = int(result) if result is not None else 0
        if code == 1:
            logger.info(f"ACK: task {task_id} (machine={machine_id}, delivery={delivery_id})")
            return True
        elif code == -1:
            logger.warning(
                f"ACK fencing: delivery_id mismatch for task {task_id} "
                f"(machine={machine_id}) — refusing to ACK"
            )
            return False
        return True  # code == 0: already gone, idempotent

    # ── Reaper: scan + re-enqueue expired leases ──────────────────────────────

    async def recover_task(self, machine_id: str, task_id: str, expired_only: bool = True,
                           instance_id: str = '', generation: int = 0, runtime_id: str = '', old_only: bool = False) -> int:
        result = await self._eval(_RECOVER_SCRIPT, keys=[f'worker:lease:{task_id}', f'worker:task_data:{task_id}',
            f'worker:active_list:{machine_id}', self.WORKER_QUEUE_KEY, f'workers:owner:{machine_id}'], args=[
            machine_id, task_id, int(expired_only), instance_id, generation, runtime_id, int(old_only)])
        return int(result or 0)

    async def reap_expired_tasks(self) -> dict:
        """
        Scan active_list của tất cả machines.
        Task nào có lease hết TTL → re-enqueue; task_data hết TTL → báo lost.
        Gọi định kỳ bởi background coroutine trong worker, hoặc qua /tasks/reap endpoint.
        Returns: {reaped, lost, checked}
        """
        known: dict = await self.get_json("workers:known") or {}
        # Heartbeat discovery expires well before a 12-minute lease. Keep a
        # durable registry so a crashed machine remains visible to the reaper.
        machines = set(await self._cmd("SMEMBERS", "workers:machines") or []) | set(known)
        reaped = 0
        lost = 0
        checked = 0

        for machine_id in machines:
            task_ids = await self.lrange(
                f"worker:active_list:{machine_id}", 0, REAP_SCAN_LIMIT - 1
            )
            for task_id in task_ids:
                checked += 1
                outcome = await self.recover_task(machine_id, task_id)
                if outcome == 1:
                    logger.info(
                        f"Reaped task {task_id} from machine {machine_id} → re-enqueued"
                    )
                    reaped += 1
                elif outcome == -1:
                    logger.warning(
                        f"Lost task {task_id} from machine {machine_id} "
                        f"— both lease and task_data expired; DB reset needed"
                    )
                    lost += 1

        return {"reaped": reaped, "lost": lost, "checked": checked}

    async def get_stuck_tasks(
        self,
        machine_id: str,
        assume_all_stuck: bool = False,
    ) -> list[tuple[str, str | None]]:
        """
        Lấy (task_id, raw_json) của tasks stuck trên machine này.
        assume_all_stuck=True: machine vừa restart.
        """
        task_ids = await self.lrange(f"worker:active_list:{machine_id}", 0, 99)
        stuck = []
        for tid in task_ids:
            if assume_all_stuck:
                is_stuck = True
            else:
                is_stuck = not await self.exists(f"worker:lease:{tid}")
            if is_stuck:
                raw = await self.get(f"worker:task_data:{tid}")
                stuck.append((tid, raw))
        return stuck

    # ── Worker / Machine heartbeat ────────────────────────────────────────────

    async def worker_heartbeat(self, machine_id: str, info: dict) -> None:
        await self.set_json(f"worker:{machine_id}", info, ex=WORKER_HEARTBEAT_TTL)

    async def get_worker(self, machine_id: str) -> Optional[dict]:
        return await self.get_json(f"worker:{machine_id}")

    async def get_all_active_workers(self) -> list[str]:
        known = await self.get_json("workers:known") or {}
        return list(known.keys())

    # ── Distributed lock ──────────────────────────────────────────────────────

    async def acquire_match_lock(self, match_id: str, holder: str, ttl: int = 30) -> bool:
        return await self.set_nx(f"lock:match:{match_id}", holder, ex=ttl)

    async def release_match_lock(self, match_id: str) -> None:
        await self.delete(f"lock:match:{match_id}")

    # ── Health check ──────────────────────────────────────────────────────────

    async def ping(self) -> bool:
        try:
            return await self._cmd("PING") == "PONG"
        except Exception as e:
            logger.warning(f"Redis ping failed: {e}")
            return False


_redis_client: Optional[RedisClient] = None


def get_redis() -> RedisClient:
    global _redis_client
    if _redis_client is None:
        _redis_client = RedisClient()
    return _redis_client
