"""Execute the actual Lua scripts, including races, in an isolated Redis engine."""
import asyncio
import hashlib
import json

import fakeredis.aioredis
from fastapi import FastAPI, HTTPException
import httpx
import pytest
import pytest_asyncio

from app.redis_client import RedisClient
from app.services import worker_control as controls
from app.routers import workers, workers_queue
from scripts.repair_queue_duplicates import REPAIR


def registration(name='default', instance='a' * 32):
    machine = 'machine-one'
    return {'worker_id': hashlib.sha256(f'{machine}\0{name}'.encode()).hexdigest()[:32],
            'machine_id': machine, 'hostname': 'test-host', 'worker_name': name,
            'instance_id': instance, 'max_concurrent': 4, 'judge0_url': 'http://judge.test'}


@pytest_asyncio.fixture
async def redis():
    fake = fakeredis.aioredis.FakeRedis(decode_responses=True)
    client = RedisClient.__new__(RedisClient)
    client._key_prefix = ''
    client._cmd = fake.execute_command
    client.fake = fake
    yield client
    await fake.aclose()


async def online(redis, name='default', instance='a' * 32, runtime='b' * 32):
    req = registration(name, instance)
    result = await controls.register(redis, req)
    scope = {'runtime_id': runtime, 'instance_id': instance, 'generation': result['generation']}
    hb = workers.SupervisorHeartbeat(worker_id=req['worker_id'], state='running', active_jobs=0,
        max_concurrent=4, judge0_url='http://judge.test', applied_revision=1, **scope).model_dump()
    await controls.heartbeat(redis, hb)
    return req['worker_id'], scope, hb


async def enqueue(redis, match_id=1):
    await redis.enqueue_worker_task(json.dumps({'task_type': 'rating', 'rated_match_id': match_id}))


@pytest.mark.asyncio
async def test_public_status_preserves_stopped_state_and_zero_slots(redis, monkeypatch):
    _, _, hb = await online(redis)
    hb.update(state='stopped', last_error='')
    await controls.heartbeat(redis, hb)
    monkeypatch.setattr(workers, 'get_redis', lambda: redis)
    result = await workers.workers_status()
    assert result.workers[0].state == 'stopped'
    assert result.workers[0].available_slots == 0
    assert result.workers[0].active_jobs == 0


@pytest.mark.asyncio
async def test_public_status_keeps_legacy_worker_compatible(redis, monkeypatch):
    import time
    await redis.set_json('workers:known', {'legacy': time.time()})
    await redis.set_json('worker:legacy', {'last_seen': time.time(), 'max_concurrent': 4, 'available_slots': 4})
    monkeypatch.setattr(workers, 'get_redis', lambda: redis)
    result = await workers.workers_status()
    assert result.workers[0].worker_id == 'legacy'
    assert result.workers[0].state is None


@pytest.mark.asyncio
async def test_duplicate_queue_repair_preserves_order_payloads_leases_and_backup(redis):
    values = ['{"task_id":"rating-25"}', '{"task_id":"rating-24"}', '{"task_id":"rating-25"}']
    await redis.fake.rpush('worker:queue', *values)
    await redis.set_json('worker:lease:rating-25', {'delivery_id': 'untouched'})
    assert await redis._eval(REPAIR, keys=['worker:queue', 'repair-backup'], args=[]) == [3, 2]
    assert await redis.lrange('worker:queue', 0, -1) == values[:2]
    assert await redis.get_json('repair-backup') == values
    assert await redis.fake.ttl('repair-backup') > 600000
    assert (await redis.get_json('worker:lease:rating-25'))['delivery_id'] == 'untouched'
    assert await redis._eval(REPAIR, keys=['worker:queue', 'repair-backup-2'], args=[]) == [2, 2]


@pytest.mark.asyncio
async def test_dispatch_retry_does_not_duplicate_a_queued_or_running_task(redis):
    worker, scope, _ = await online(redis)
    await asyncio.gather(enqueue(redis, 24), enqueue(redis, 24), enqueue(redis, 25))
    assert await redis.worker_queue_depth() == 2
    claimed, _, _ = await redis.atomic_claim(worker, 'delivery', **scope)
    match_id = int(claimed.split('-')[1])
    await enqueue(redis, match_id)
    assert await redis.worker_queue_depth() == 1
    assert claimed not in [json.loads(raw)['task_id'] for raw in await redis.lrange('worker:queue', 0, -1)]


@pytest.mark.asyncio
async def test_duplicate_registration_does_not_replace_owner_or_heartbeat(redis):
    worker, scope, hb = await online(redis)
    before = await redis.get_json(f'workers:state:{worker}')
    with pytest.raises(HTTPException) as error:
        await controls.register(redis, registration(instance='c' * 32))
    assert error.value.status_code == 409
    assert await redis.get_json(f'workers:state:{worker}') == before
    await controls.heartbeat(redis, hb)
    assert (await redis.get_json(f'workers:owner:{worker}'))['instance_id'] == scope['instance_id']


@pytest.mark.asyncio
async def test_revision_conflicts_and_configuration_survives_restart(redis):
    worker, scope, _ = await online(redis)
    change = {'revision': 1, 'max_concurrent': 2, 'updated_by': 'admin'}
    assert (await controls.update(redis, worker, change))['control']['revision'] == 2
    with pytest.raises(HTTPException):
        await controls.update(redis, worker, {**change, 'max_concurrent': 5})
    await redis.delete(f'workers:owner:{worker}')
    result = await controls.register(redis, registration(instance='d' * 32))
    assert result['generation'] > scope['generation']
    assert result['control']['max_concurrent'] == 2


@pytest.mark.asyncio
async def test_pause_and_reduced_limit_are_enforced_inside_claim(redis):
    worker, scope, _ = await online(redis)
    for number in range(1, 5):
        await enqueue(redis, number)
    first = await redis.atomic_claim(worker, 'delivery-1', **scope)
    second = await redis.atomic_claim(worker, 'delivery-2', **scope)
    await controls.update(redis, worker, {'revision': 1, 'max_concurrent': 1, 'updated_by': 'admin'})
    assert (await redis.atomic_claim(worker, 'delivery-3', **scope))[0] is None
    assert await redis.ack_task(worker, first[0], 'delivery-1', **scope)
    assert (await redis.atomic_claim(worker, 'delivery-3', **scope))[0] is None
    assert await redis.ack_task(worker, second[0], 'delivery-2', **scope)
    await controls.update(redis, worker, {'revision': 2, 'action': 'pause', 'updated_by': 'admin'})
    assert (await redis.atomic_claim(worker, 'delivery-3', **scope))[0] is None
    await controls.update(redis, worker, {'revision': 3, 'action': 'resume', 'updated_by': 'admin'})
    assert (await redis.atomic_claim(worker, 'delivery-3', **scope))[0] == 'rating-3'


@pytest.mark.asyncio
async def test_runtime_recovery_is_atomic_idempotent_and_does_not_touch_named_sibling(redis):
    worker, scope, _ = await online(redis)
    sibling, other_scope, _ = await online(redis, name='beta')
    await enqueue(redis)
    await enqueue(redis, 2)
    await redis.atomic_claim(worker, 'first', **scope)
    await redis.atomic_claim(sibling, 'second', **other_scope)
    results = await asyncio.gather(*[redis.recover_task(worker, 'rating-1', expired_only=False, **scope) for _ in range(2)])
    assert sorted(results) == [0, 1]
    assert await redis.worker_queue_depth() == 1
    assert (await redis.get_json('worker:lease:rating-2'))['machine_id'] == sibling
    assert await redis.renew_lease(sibling, 'rating-2', 'second', **other_scope)
    assert not await redis.ack_task(worker, 'rating-2', 'second', **scope)


@pytest.mark.asyncio
async def test_old_supervisor_cannot_claim_renew_ack_or_heartbeat_after_takeover(redis):
    worker, old_scope, old_hb = await online(redis)
    await enqueue(redis)
    await redis.atomic_claim(worker, 'old-delivery', **old_scope)
    await redis.delete(f'workers:owner:{worker}')
    _, scope, _ = await online(redis, instance='e' * 32, runtime='f' * 32)
    with pytest.raises(HTTPException):
        await controls.heartbeat(redis, old_hb)
    assert not await redis.renew_lease(worker, 'rating-1', 'old-delivery', **old_scope)
    assert not await redis.ack_task(worker, 'rating-1', 'old-delivery', **old_scope)
    assert (await redis.atomic_claim(worker, 'invalid', **old_scope))[0] is None
    assert await redis.recover_task(worker, 'rating-1', expired_only=False, old_only=True,
        instance_id=scope['instance_id'], generation=scope['generation']) == 1
    assert (await redis.atomic_claim(worker, 'new-delivery', **scope))[0] == 'rating-1'
    assert await redis.recover_task(worker, 'rating-1', expired_only=False, **old_scope) == 0


@pytest.mark.asyncio
async def test_old_runtime_with_same_supervisor_cannot_release_current_runtime(redis):
    worker, scope, hb = await online(redis)
    await enqueue(redis)
    await redis.atomic_claim(worker, 'delivery', **scope)
    wrong_runtime = {**scope, 'runtime_id': 'c' * 32}
    assert await redis.recover_task(worker, 'rating-1', expired_only=False, **wrong_runtime) == 0
    assert await redis.worker_queue_depth() == 0
    assert not await redis.ack_task(worker, 'rating-1', 'delivery', **wrong_runtime)
    await controls.update(redis, worker, {'revision': 1, 'action': 'stop', 'stop_mode': 'immediate', 'updated_by': 'admin'})
    assert await redis.recover_task(worker, 'rating-1', expired_only=False, **scope) == 1


@pytest.mark.asyncio
async def test_reaper_does_not_recover_live_jobs_and_recovers_expired_jobs_once(redis):
    worker, scope, _ = await online(redis)
    await enqueue(redis)
    await redis.atomic_claim(worker, 'delivery', **scope)
    assert (await redis.reap_expired_tasks())['reaped'] == 0
    await redis.delete('worker:lease:rating-1')
    results = await asyncio.gather(redis.reap_expired_tasks(), redis.reap_expired_tasks())
    assert sum(result['reaped'] for result in results) == 1
    assert await redis.worker_queue_depth() == 1


@pytest.mark.asyncio
async def test_offline_worker_remains_visible_and_can_save_limit_but_cannot_start(redis):
    worker, _, _ = await online(redis)
    await redis.delete(f'workers:owner:{worker}')
    listed = await controls.list_workers(redis)
    assert listed[0]['online'] is False
    assert 'instance_id' not in listed[0]
    assert 'generation' not in listed[0]
    with pytest.raises(HTTPException):
        await controls.update(redis, worker, {'revision': 1, 'action': 'start', 'updated_by': 'admin'})
    assert (await controls.update(redis, worker, {'revision': 1, 'max_concurrent': 8, 'updated_by': 'admin'}))['control']['max_concurrent'] == 8


@pytest.mark.asyncio
async def test_admin_auth_validation_and_legacy_recovery(redis, monkeypatch):
    from types import SimpleNamespace
    settings = SimpleNamespace(worker_secret='worker', internal_backend_secret='internal')
    for module in (workers, workers_queue):
        monkeypatch.setattr(module, 'get_redis', lambda: redis)
        monkeypatch.setattr(module, 'get_settings', lambda: settings)
    app = FastAPI()
    app.include_router(workers.router)
    app.include_router(workers_queue.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
        assert (await client.get('/workers/admin')).status_code == 401
        assert (await client.get('/workers/admin', headers={'X-Worker-Secret': 'worker'})).status_code == 401
        assert (await client.post('/workers/register', json=registration(), headers={'X-Worker-Secret': 'worker'})).status_code == 200
        worker = registration()['worker_id']
        for limit in (0, 65, True, 1.5):
            response = await client.patch(f'/workers/admin/{worker}', headers={'X-Internal-Secret': 'internal'},
                json={'revision': 1, 'max_concurrent': limit, 'updated_by': 'admin'})
            assert response.status_code == 422
        assert (await client.get('/workers/admin', headers={'X-Internal-Secret': 'internal'})).status_code == 200
        await enqueue(redis)
        await redis.atomic_claim('legacy-host', 'legacy-delivery')
        recovered = await client.post('/worker/tasks/recover?machine_id=legacy-host', headers={'X-Worker-Secret': 'worker'})
        assert recovered.json()['recovered'] == 0  # Opening another old console cannot steal its live lease.
