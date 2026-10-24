"""
Tests for queue semantics: atomic claim, delivery token fencing, recovery.

Run with:
    cd backend && python3 -m pytest tests/test_queue.py -v

Uses unittest.mock để giả lập Upstash REST — không cần Redis thật.
"""

import asyncio
import json
import time
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

# ── Helpers ───────────────────────────────────────────────────────────────────

def make_task(task_type: str = "rating", match_id: int = 42) -> dict:
    return {
        "task_type": task_type,
        "rated_match_id": match_id if task_type == "rating" else None,
        "friendly_match_id": match_id if task_type == "friendly" else None,
        "task_id": f"{task_type}-{match_id}",
        "agent1_id": 1, "agent1_code": "def agent(o,c): return None",
        "agent2_id": 2, "agent2_code": "def agent(o,c): return None",
        "max_moves": 10,
    }

# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def redis_client():
    from app.redis_client import RedisClient
    client = RedisClient.__new__(RedisClient)
    client._url   = "https://fake.upstash.io"
    client._token = "fake-token"
    client._cmd   = AsyncMock()
    client._eval  = AsyncMock()
    return client

# ═════════════════════════════════════════════════════════════════════════════
# 1. Enqueue — task_id gắn vào payload
# ═════════════════════════════════════════════════════════════════════════════

class TestEnqueue:

    @pytest.mark.asyncio
    async def test_assigns_task_id(self, redis_client):
        task = {"task_type": "rating", "rated_match_id": 10}
        redis_client._cmd.return_value = 1
        await redis_client.enqueue_worker_task(json.dumps(task))
        pushed = json.loads(redis_client._eval.call_args.kwargs['args'][1])
        assert pushed["task_id"] == "rating-10"

    @pytest.mark.asyncio
    async def test_preserves_existing_task_id(self, redis_client):
        task = {"task_type": "rating", "rated_match_id": 10, "task_id": "custom-id"}
        redis_client._cmd.return_value = 1
        await redis_client.enqueue_worker_task(json.dumps(task))
        pushed = json.loads(redis_client._eval.call_args.kwargs['args'][1])
        assert pushed["task_id"] == "custom-id"

    @pytest.mark.asyncio
    async def test_invalid_json_still_pushes(self, redis_client):
        redis_client._cmd.return_value = 1
        await redis_client.enqueue_worker_task("not-json")
        redis_client._cmd.assert_called_once()


# ═════════════════════════════════════════════════════════════════════════════
# 2. Atomic claim
# ═════════════════════════════════════════════════════════════════════════════

class TestAtomicClaim:

    @pytest.mark.asyncio
    async def test_success(self, redis_client):
        task = make_task()
        raw  = json.dumps(task)
        redis_client._eval.return_value = [1, task["task_id"], raw]
        redis_client._cmd = AsyncMock(return_value=1)

        tid, did, td = await redis_client.atomic_claim("host-A", "delivery-1")
        assert tid == task["task_id"]
        assert did == "delivery-1"
        assert td is not None

    @pytest.mark.asyncio
    async def test_empty_queue_returns_none(self, redis_client):
        redis_client._eval.return_value = [0, "", ""]
        tid, did, td = await redis_client.atomic_claim("host-A", "delivery-1")
        assert tid is None and did is None and td is None

    @pytest.mark.asyncio
    async def test_race_lease_exists_returns_none(self, redis_client):
        """Lua trả -1 (SET NX thất bại vì lease đã tồn tại) → None, item pushed back."""
        task = make_task()
        redis_client._eval.return_value = [-1, task["task_id"], json.dumps(task)]
        tid, did, td = await redis_client.atomic_claim("host-A", "delivery-1")
        assert tid is None

    @pytest.mark.asyncio
    async def test_missing_task_id_in_payload(self, redis_client):
        redis_client._eval.return_value = [-2, "", json.dumps({"task_type": "rating"})]
        tid, did, td = await redis_client.atomic_claim("host-A", "delivery-1")
        assert tid is None

    @pytest.mark.asyncio
    async def test_no_network_gap_after_atomic_claim(self, redis_client):
        task = make_task()
        raw  = json.dumps(task)
        redis_client._eval.return_value = [1, task["task_id"], raw]

        redis_client._cmd = AsyncMock(side_effect=AssertionError("No follow-up writes may be needed after claim"))
        await redis_client.atomic_claim("host-A", "delivery-1")
        redis_client._cmd.assert_not_called()

    @pytest.mark.asyncio
    async def test_two_workers_only_one_wins(self, redis_client):
        task = make_task()
        raw  = json.dumps(task)
        call = 0
        async def mock_eval(*a, **kw):
            nonlocal call; call += 1
            return [1, task["task_id"], raw] if call == 1 else [-1, task["task_id"], raw]
        redis_client._eval = mock_eval
        redis_client._cmd  = AsyncMock(return_value=1)

        tid_a, _, _ = await redis_client.atomic_claim("host-A", "A:1")
        tid_b, _, _ = await redis_client.atomic_claim("host-B", "B:1")
        assert tid_a == task["task_id"]
        assert tid_b is None


# ═════════════════════════════════════════════════════════════════════════════
# 3. Renew lease — delivery_id fencing
# ═════════════════════════════════════════════════════════════════════════════

class TestRenewLease:

    @pytest.mark.asyncio
    async def test_success(self, redis_client):
        redis_client._eval.return_value = 1
        ok = await redis_client.renew_lease("host-A", "rating-42", "delivery-1")
        assert ok is True

    @pytest.mark.asyncio
    async def test_fenced_wrong_delivery_id(self, redis_client):
        redis_client._eval.return_value = -1
        ok = await redis_client.renew_lease("host-A", "rating-42", "old-delivery")
        assert ok is False

    @pytest.mark.asyncio
    async def test_lease_expired(self, redis_client):
        redis_client._eval.return_value = 0
        ok = await redis_client.renew_lease("host-A", "rating-42", "delivery-1")
        assert ok is False

    @pytest.mark.asyncio
    async def test_old_instance_cannot_renew_new_instances_lease(self, redis_client):
        """Machine restart với instance_id mới; old instance cố renew → fenced."""
        redis_client._eval.return_value = -1  # delivery_id không khớp
        ok = await redis_client.renew_lease("host-A", "rating-42", "OLD_INSTANCE:5")
        assert ok is False


# ═════════════════════════════════════════════════════════════════════════════
# 4. ACK task — delivery_id fencing
# ═════════════════════════════════════════════════════════════════════════════

class TestAckTask:

    @pytest.mark.asyncio
    async def test_success(self, redis_client):
        redis_client._eval.return_value = 1
        redis_client._cmd = AsyncMock(return_value=1)
        ok = await redis_client.ack_task("host-A", "rating-42", "delivery-1")
        assert ok is True

    @pytest.mark.asyncio
    async def test_fenced_wrong_delivery_id(self, redis_client):
        redis_client._eval.return_value = -1
        ok = await redis_client.ack_task("host-A", "rating-42", "old-delivery")
        assert ok is False

    @pytest.mark.asyncio
    async def test_idempotent_when_lease_gone(self, redis_client):
        redis_client._eval.return_value = 1  # "already gone" = success
        redis_client._cmd = AsyncMock(return_value=0)
        ok = await redis_client.ack_task("host-A", "rating-42", "delivery-1")
        assert ok is True

    @pytest.mark.asyncio
    async def test_old_instance_cannot_ack_new_instances_lease(self, redis_client):
        redis_client._eval.return_value = -1
        ok = await redis_client.ack_task("host-A", "rating-42", "OLD_INSTANCE:3")
        assert ok is False


# ═════════════════════════════════════════════════════════════════════════════
# 5. Reaper — re-enqueue expired leases
# ═════════════════════════════════════════════════════════════════════════════

def _setup_reaper_mocks(redis_client, machines_tasks: dict):
    """
    machines_tasks = {
        "host-A": [("task-id", lease_alive: bool, raw_json | None)]
    }
    """
    async def mock_get_json(key):
        if key == "workers:known":
            return {m: time.time() for m in machines_tasks}
        return None

    async def mock_lrange(key, start, stop):
        machine = key.replace("worker:active_list:", "")
        return [t[0] for t in machines_tasks.get(machine, [])]

    async def mock_exists(key):
        task_id = key.replace("worker:lease:", "")
        for items in machines_tasks.values():
            for tid, alive, _ in items:
                if tid == task_id:
                    return alive
        return False

    async def mock_get(key):
        task_id = key.replace("worker:task_data:", "")
        for items in machines_tasks.values():
            for tid, _, raw in items:
                if tid == task_id:
                    return raw
        return None

    lpushed, lremmed = [], []
    async def mock_lpush(key, *vals): lpushed.extend(vals)
    async def mock_lrem(key, cnt, val): lremmed.append(val)

    redis_client.get_json = mock_get_json
    redis_client._cmd = AsyncMock(return_value=list(machines_tasks))
    redis_client.lrange   = mock_lrange
    redis_client.exists   = mock_exists
    redis_client.get      = mock_get
    redis_client.lpush    = mock_lpush
    redis_client.lrem     = mock_lrem
    async def mock_recover(machine_id, task_id, **kwargs):
        for tid, alive, raw in machines_tasks.get(machine_id, []):
            if tid == task_id:
                if alive:
                    return 0
                lremmed.append(tid)
                if raw:
                    lpushed.append(raw)
                    return 1
                return -1
        return 0
    redis_client.recover_task = mock_recover
    return lpushed, lremmed


class TestReaper:

    @pytest.mark.asyncio
    async def test_reaps_machine_after_heartbeat_discovery_expired(self, redis_client):
        raw = json.dumps(make_task())
        lpushed, _ = _setup_reaper_mocks(redis_client, {"host-A": [("rating-42", False, raw)]})
        redis_client.get_json = AsyncMock(return_value=None)
        result = await redis_client.reap_expired_tasks()
        assert result["reaped"] == 1
        assert raw in lpushed

    @pytest.mark.asyncio
    async def test_reenqueues_expired_lease_with_data(self, redis_client):
        task = make_task()
        raw  = json.dumps(task)
        lpushed, _ = _setup_reaper_mocks(
            redis_client, {"host-A": [(task["task_id"], False, raw)]}
        )
        result = await redis_client.reap_expired_tasks()
        assert result["reaped"] == 1
        assert result["lost"]   == 0
        assert raw in lpushed

    @pytest.mark.asyncio
    async def test_reports_lost_when_data_expired(self, redis_client):
        _setup_reaper_mocks(redis_client, {"host-A": [("rating-99", False, None)]})
        result = await redis_client.reap_expired_tasks()
        assert result["reaped"] == 0
        assert result["lost"]   == 1

    @pytest.mark.asyncio
    async def test_skips_live_leases(self, redis_client):
        _setup_reaper_mocks(redis_client, {"host-A": [("rating-5", True, "raw")]})
        redis_client.lpush = AsyncMock()
        result = await redis_client.reap_expired_tasks()
        assert result["reaped"] == 0
        redis_client.lpush.assert_not_called()

    @pytest.mark.asyncio
    async def test_multiple_machines(self, redis_client):
        raw2 = json.dumps(make_task(match_id=2))
        _setup_reaper_mocks(redis_client, {
            "host-A": [("rating-1", True, "raw1")],   # alive → skip
            "host-B": [("rating-2", False, raw2)],    # expired → reap
        })
        result = await redis_client.reap_expired_tasks()
        assert result["reaped"] == 1
        assert result["checked"] == 2

    @pytest.mark.asyncio
    async def test_crash_1min_lease_still_alive(self, redis_client):
        """LEASE_TTL=720s; crash after 1 min → lease alive → reap does nothing."""
        _setup_reaper_mocks(redis_client, {"host-A": [("rating-10", True, "raw")]})
        redis_client.lpush = AsyncMock()
        result = await redis_client.reap_expired_tasks()
        assert result["reaped"] == 0
        redis_client.lpush.assert_not_called()

    @pytest.mark.asyncio
    async def test_crash_15min_lease_expired_data_intact(self, redis_client):
        """15 min > LEASE_TTL(12 min); TASK_DATA_TTL=2h → data intact → reaped."""
        raw = json.dumps(make_task())
        _setup_reaper_mocks(redis_client, {"host-A": [("rating-42", False, raw)]})
        result = await redis_client.reap_expired_tasks()
        assert result["reaped"] == 1

    @pytest.mark.asyncio
    async def test_crash_2h_both_expired(self, redis_client):
        """2h > TASK_DATA_TTL → data gone → lost."""
        _setup_reaper_mocks(redis_client, {"host-A": [("rating-77", False, None)]})
        redis_client.lpush = AsyncMock()
        result = await redis_client.reap_expired_tasks()
        assert result["lost"]   == 1
        assert result["reaped"] == 0
        redis_client.lpush.assert_not_called()


# ═════════════════════════════════════════════════════════════════════════════
# 6. Recover on restart
# ═════════════════════════════════════════════════════════════════════════════

class TestRecoverOnRestart:

    @pytest.mark.asyncio
    async def test_assume_all_stuck_returns_all(self, redis_client):
        task1, task2 = make_task(match_id=1), make_task(match_id=2)
        raw1, raw2   = json.dumps(task1), json.dumps(task2)

        async def mock_lrange(key, s, e):
            return [task1["task_id"], task2["task_id"]]
        async def mock_get(key):
            return raw1 if task1["task_id"] in key else raw2

        redis_client.lrange = mock_lrange
        redis_client.get    = mock_get

        stuck = await redis_client.get_stuck_tasks("host-A", assume_all_stuck=True)
        assert len(stuck) == 2

    @pytest.mark.asyncio
    async def test_only_expired_when_not_assume_all(self, redis_client):
        alive_id, dead_id = "rating-1", "rating-2"
        raw_dead = json.dumps(make_task(match_id=2))

        async def mock_lrange(key, s, e): return [alive_id, dead_id]
        async def mock_exists(key):       return alive_id in key
        async def mock_get(key):          return raw_dead if dead_id in key else None

        redis_client.lrange = mock_lrange
        redis_client.exists = mock_exists
        redis_client.get    = mock_get

        stuck = await redis_client.get_stuck_tasks("host-A", assume_all_stuck=False)
        assert len(stuck) == 1
        assert stuck[0][0] == dead_id

    @pytest.mark.asyncio
    async def test_lost_reported_when_data_expired(self, redis_client):
        async def mock_lrange(key, s, e): return ["rating-99"]
        async def mock_get(key):          return None
        redis_client.lrange = mock_lrange
        redis_client.get    = mock_get

        stuck = await redis_client.get_stuck_tasks("host-A", assume_all_stuck=True)
        assert stuck[0][1] is None  # data lost


# ═════════════════════════════════════════════════════════════════════════════
# 7. Lease handoff: expired → re-claimed by other worker
# ═════════════════════════════════════════════════════════════════════════════

class TestLeaseHandoff:

    @pytest.mark.asyncio
    async def test_old_worker_cannot_renew_or_ack_after_handoff(self, redis_client):
        """
        Worker A lease expires → reaper re-enqueues → Worker B claims.
        Worker A (old delivery) tries renew + ack → both fenced.
        """
        # Worker B claims successfully
        task = make_task()
        raw  = json.dumps(task)
        redis_client._eval.return_value = [1, task["task_id"], raw]
        redis_client._cmd = AsyncMock(return_value=1)
        tid_b, did_b, _ = await redis_client.atomic_claim("host-B", "B:new:1")
        assert tid_b == task["task_id"]

        # Worker A (old) tries renew → fenced
        redis_client._eval.return_value = -1
        ok = await redis_client.renew_lease("host-A", task["task_id"], "A:old:5")
        assert ok is False

        # Worker A (old) tries ack → fenced
        redis_client._eval.return_value = -1
        ok = await redis_client.ack_task("host-A", task["task_id"], "A:old:5")
        assert ok is False

    @pytest.mark.asyncio
    async def test_worker_b_ack_succeeds(self, redis_client):
        """Worker B (new owner) can ACK successfully."""
        redis_client._eval.return_value = 1
        redis_client._cmd = AsyncMock(return_value=1)
        ok = await redis_client.ack_task("host-B", "rating-42", "B:new:1")
        assert ok is True
