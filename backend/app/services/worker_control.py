"""Persistent desired state and fenced, short-lived supervisor ownership."""
import asyncio
import json
import time

from fastapi import HTTPException

from ..redis_client import RedisClient

SUPERVISOR_TTL = 15

REGISTER = """
local owner = redis.call('GET', KEYS[1])
if owner then
  local current = cjson.decode(owner)
  if current.instance_id ~= ARGV[1] then return '' end
  redis.call('EXPIRE', KEYS[1], 15)
  return owner
end
local generation = redis.call('INCR', KEYS[2])
local value = cjson.encode({instance_id=ARGV[1], generation=generation, runtime_id=''})
redis.call('SET', KEYS[1], value, 'EX', 15)
redis.call('SET', KEYS[3], ARGV[2], 'NX')
redis.call('SET', KEYS[4], ARGV[3])
redis.call('SADD', KEYS[5], ARGV[4])
return value
"""

HEARTBEAT = """
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local owner = cjson.decode(raw)
if owner.instance_id ~= ARGV[1] or owner.generation ~= tonumber(ARGV[2]) then return '' end
owner.runtime_id = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(owner), 'EX', 15)
redis.call('SET', KEYS[2], ARGV[4])
redis.call('SET', KEYS[3], ARGV[5], 'EX', 15)
return redis.call('GET', KEYS[4])
"""

UPDATE = """
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing', ''} end
local config = cjson.decode(raw)
if config.revision ~= tonumber(ARGV[1]) then return {'conflict', raw} end
local action = ARGV[2]
if action ~= '' and not redis.call('GET', KEYS[2]) then return {'offline', raw} end
if action == 'start' then config.mode = 'running'
elseif action == 'pause' then
  if config.mode ~= 'running' then return {'invalid_state', raw} end
  config.mode = 'paused'
elseif action == 'resume' then
  if config.mode ~= 'paused' then return {'invalid_state', raw} end
  config.mode = 'running'
elseif action == 'stop' then
  config.mode = 'stopped'
  config.stop_mode = ARGV[3]
end
if ARGV[4] ~= '' then config.max_concurrent = tonumber(ARGV[4]) end
config.revision = config.revision + 1
config.last_action = action
config.updated_by = ARGV[5]
config.updated_at = tonumber(ARGV[6])
local updated = cjson.encode(config)
redis.call('SET', KEYS[1], updated)
return {'ok', updated}
"""


async def register(redis: RedisClient, request: dict) -> dict:
    worker_id = request['worker_id']
    config = {'revision': 1, 'mode': 'running', 'stop_mode': 'graceful',
              'max_concurrent': request['max_concurrent'], 'updated_at': time.time(), 'updated_by': 'registration'}
    raw = await redis._eval(REGISTER, keys=[
        f'workers:owner:{worker_id}', f'workers:generation:{worker_id}',
        f'workers:control:{worker_id}', f'workers:meta:{worker_id}', 'workers:managed',
    ], args=[request['instance_id'], json.dumps(config), json.dumps(request), worker_id])
    if not raw:
        raise HTTPException(409, 'Worker đã có supervisor khác đang hoạt động.')
    return {**json.loads(raw), 'control': await redis.get_json(f'workers:control:{worker_id}')}


async def heartbeat(redis: RedisClient, request: dict) -> dict:
    worker_id = request['worker_id']
    now = time.time()
    state = {**request, 'last_seen': now}
    running = request['state'] == 'running'
    summary = {
        'worker_id': worker_id, 'judge0_url': request['judge0_url'],
        'active_jobs': request['active_jobs'], 'max_concurrent': request['max_concurrent'],
        'available_slots': max(0, request['max_concurrent'] - request['active_jobs']) if running else 0,
        'active_task_ids': request['active_task_ids'], 'last_seen': now,
        'state': request['state'], 'last_error': request.get('last_error', ''),
    }
    raw = await redis._eval(HEARTBEAT, keys=[f'workers:owner:{worker_id}', f'workers:state:{worker_id}',
        f'worker:{worker_id}', f'workers:control:{worker_id}'], args=[request['instance_id'], request['generation'],
        request.get('runtime_id') or '', json.dumps(state), json.dumps(summary)])
    if not raw:
        owner = await redis.get_json(f'workers:owner:{worker_id}')
        raise HTTPException(409, {'reason': 'ownership_changed' if owner else 'ownership_expired'})
    return {'control': json.loads(raw), 'server_time': now}


async def update(redis: RedisClient, worker_id: str, request: dict) -> dict:
    result = await redis._eval(UPDATE, keys=[f'workers:control:{worker_id}', f'workers:owner:{worker_id}'], args=[
        request['revision'], request.get('action') or '', request.get('stop_mode', 'graceful'),
        request.get('max_concurrent') if request.get('max_concurrent') is not None else '',
        request['updated_by'], time.time(),
    ])
    reason, raw = result
    if reason != 'ok':
        raise HTTPException(404 if reason == 'missing' else 409,
                            {'reason': reason, 'control': json.loads(raw) if raw else None})
    return {'control': json.loads(raw)}


async def list_workers(redis: RedisClient) -> list[dict]:
    result = []
    now = time.time()
    ids, known = await asyncio.gather(redis._cmd('SMEMBERS', 'workers:managed'), redis.get_json('workers:known'))
    ids, known = ids or [], known or {}
    snapshots = await redis._cmd('MGET', *[f'workers:{kind}:{worker_id}' for worker_id in ids
                                        for kind in ('meta', 'control', 'state', 'owner')]) if ids else []
    for index, worker_id in enumerate(ids):
        meta, control, state, owner = [json.loads(raw) if raw else {} for raw in snapshots[index * 4:index * 4 + 4]]
        online = bool(owner) and state.get('instance_id') == owner.get('instance_id') and \
            state.get('generation') == owner.get('generation') and now - state.get('last_seen', 0) < SUPERVISOR_TTL
        result.append({**meta, **state, 'worker_id': worker_id, 'managed': True, 'online': online,
                       'control': control, 'seconds_ago': max(0, int(now - state.get('last_seen', 0)))})
    # Legacy workers remain visible, but can never receive control operations.
    legacy_ids = [worker_id for worker_id in known if worker_id not in ids]
    legacy_states = await redis._cmd('MGET', *[f'worker:{worker_id}' for worker_id in legacy_ids]) if legacy_ids else []
    for worker_id, raw in zip(legacy_ids, legacy_states):
        state = json.loads(raw) if raw else None
        if state:
            result.append({**state, 'worker_name': worker_id, 'hostname': worker_id,
                           'managed': False, 'online': now - state.get('last_seen', 0) < 90})
    # Do not expose supervisor ownership credentials in admin responses.
    for worker in result:
        worker.pop('instance_id', None)
        worker.pop('generation', None)
    return sorted(result, key=lambda w: (w.get('hostname', ''), w.get('worker_name', '')))
