"""Remove byte-identical queued duplicates only, retaining an expiring Redis backup.

Run from backend: python -B scripts/repair_queue_duplicates.py [--apply]
No database rows, leases or worker controls are changed.
"""
import argparse
import asyncio
import json
from pathlib import Path
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.redis_client import get_redis

REPAIR = """
local count = redis.call('LLEN', KEYS[1])
if count > 1000 then return redis.error_reply('Queue too large for this repair') end
local values = redis.call('LRANGE', KEYS[1], 0, -1)
local seen = {}
local kept = {}
for _, raw in ipairs(values) do
  if not seen[raw] then table.insert(kept, raw); seen[raw] = true end
end
if #kept == #values then return {#values, #kept} end
if not redis.call('SET', KEYS[2], cjson.encode(values), 'EX', 604800, 'NX') then
  return redis.error_reply('Backup key exists; repair aborted')
end
redis.call('DEL', KEYS[1])
for _, raw in ipairs(kept) do redis.call('RPUSH', KEYS[1], raw) end
return {#values, #kept}
"""


async def main(apply=False):
    redis = get_redis()
    if not apply:
        values = await redis.lrange('worker:queue', 0, -1)
        print(json.dumps({'queued': len(values), 'unique_payloads': len(set(values)), 'changed': False}))
        return
    backup = f'maintenance:worker_queue:backup:{uuid.uuid4().hex}'
    before, after = await redis._eval(REPAIR, keys=['worker:queue', backup], args=[])
    print(json.dumps({'before': before, 'after': after, 'removed_duplicates': before - after,
                      'backup_key': redis._key_prefix + backup if before != after else None,
                      'backup_retention_days': 7}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    asyncio.run(main(parser.parse_args().apply))
