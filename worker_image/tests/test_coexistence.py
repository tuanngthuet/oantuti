"""Run real Redis Lua scripts for simultaneous Python workers."""
import asyncio
import hashlib
import json
from pathlib import Path
import sys

import fakeredis.aioredis
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from app.redis_client import RedisClient
from app.services import worker_control


@pytest.mark.asyncio
async def test_python_workers_share_queue_with_independent_controls_and_recovery():
    fake = fakeredis.aioredis.FakeRedis(decode_responses=True)
    redis = RedisClient.__new__(RedisClient)
    redis._key_prefix = ''
    redis._cmd = fake.execute_command
    try:
        identities = []
        for name, instance, runtime, executor in (
            ('python-alpha', 'a' * 32, 'b' * 32, 'local-python://bubblewrap'),
            ('python-beta', 'c' * 32, 'd' * 32, 'local-python://bubblewrap'),
        ):
            worker_id = hashlib.sha256(f'same-machine\0{name}'.encode()).hexdigest()[:32]
            registered = await worker_control.register(redis, dict(worker_id=worker_id, machine_id='same-machine',
                worker_name=name, hostname='same-host', instance_id=instance, max_concurrent=4, judge0_url=executor))
            scope = dict(instance_id=instance, generation=registered['generation'], runtime_id=runtime)
            await worker_control.heartbeat(redis, dict(worker_id=worker_id, state='running', active_jobs=0,
                active_task_ids=[], max_concurrent=4, judge0_url=executor, applied_revision=1, **scope))
            identities.append((worker_id, scope))
        for number in range(8):
            await redis.enqueue_worker_task(json.dumps({'task_type': 'rating', 'rated_match_id': number + 1}))
        deliveries = await asyncio.gather(*[
            redis.atomic_claim(worker_id, f'delivery-{index}-{turn}', **scope)
            for turn in range(4) for index, (worker_id, scope) in enumerate(identities)])
        assert len({task_id for task_id, _, _ in deliveries}) == 8
        assert await redis.worker_queue_depth() == 0
        for worker_id, scope in identities:
            assert await redis.lrange(f'worker:active_list:{worker_id}', 0, -1)
        old_id, old_scope = identities[0]
        new_id, new_scope = identities[1]
        await worker_control.update(redis, new_id, {'revision': 1, 'action': 'stop',
            'stop_mode': 'immediate', 'updated_by': 'test'})
        local_ids = await redis.lrange(f'worker:active_list:{new_id}', 0, -1)
        for task_id in local_ids:
            assert await redis.recover_task(new_id, task_id, expired_only=False, **new_scope) == 1
        assert await redis.worker_queue_depth() == 4
        old_task, old_delivery, _ = deliveries[0]
        assert await redis.renew_lease(old_id, old_task, old_delivery, **old_scope)
        assert not await redis.ack_task(new_id, old_task, old_delivery, **new_scope)
        assert await redis.ack_task(old_id, old_task, old_delivery, **old_scope)
        # A running Python worker can pick up work released by its stopped sibling.
        claimed, _, _ = await redis.atomic_claim(old_id, 'reclaimed-by-sibling', **old_scope)
        assert claimed in local_ids
        assert (await redis.atomic_claim(new_id, 'stopped-worker', **new_scope))[0] is None
        listed = await worker_control.list_workers(redis)
        assert {worker['worker_name'] for worker in listed} == {'python-alpha', 'python-beta'}
    finally:
        await fake.aclose()
