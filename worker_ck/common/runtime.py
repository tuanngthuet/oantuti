"""Round-pinned finals service. The container has only an API credential, never a DB DSN."""
import argparse
import asyncio
import hashlib
import importlib
import json
import logging
import os
from pathlib import Path
import signal
import uuid

import httpx
from .sandbox import PythonRunner

log = logging.getLogger('worker-ck')
WRAPPER = '''import json, sys
__AGENT_CODE_PLACEHOLDER__
data = json.loads(sys.stdin.read())
print(json.dumps(agent(data['observation'], data['configuration'])))
'''


def parse_result(stdout, stderr):
    try:
        action = json.loads([line for line in stdout.splitlines() if line.strip()][-1])
        if not isinstance(action, dict):
            raise ValueError('Action must be an object')
        return dict(success=True, move=action, error=None)
    except (ValueError, IndexError) as error:
        return PythonRunner.failure('Invalid agent action: '+str(error))


def load_engine(name):
    folder = Path(__file__).resolve().parent.parent / name
    manifest = json.loads((folder / 'manifest.json').read_text())
    digest = hashlib.sha256()
    # Runtime, wrapper, sandbox and limits are part of execution identity too.
    for path in sorted([*folder.glob('*.py'), folder/'manifest.json', *Path(__file__).parent.glob('*.py')], key=lambda p: p.parent.name+'/'+p.name):
        digest.update((path.parent.name+'/'+path.name+'\0').encode())
        digest.update(path.read_bytes())
    manifest['digest'] = digest.hexdigest()
    return manifest, importlib.import_module('worker_ck.'+name+'.engine').FinalsGame


class Service:
    def __init__(self, name, concurrency):
        self.manifest, self.game_class = load_engine(name)
        self.worker = os.environ['CK_WORKER_ID']
        self.instance = str(uuid.uuid4())
        self.concurrency = concurrency
        self.sandbox = PythonRunner.from_env(WRAPPER, parse_result)
        # Changing agent limits requires a new execution identity.
        limits = [self.sandbox.cpu_seconds, self.sandbox.wall_seconds, self.sandbox.memory_mb,
                  self.sandbox.output_bytes, self.sandbox.source_bytes]
        self.manifest['digest'] = hashlib.sha256((self.manifest['digest']+json.dumps(limits)).encode()).hexdigest()
        self.client = httpx.AsyncClient(base_url=os.environ['CK_FRONTEND_URL'].rstrip('/'),
            headers={'Authorization': 'Bearer '+os.environ['CK_WORKER_TOKEN']}, timeout=20)

    async def call(self, action, **payload):
        response = await self.client.post('/api/internal/finals/worker', json={
            'action': action, 'worker_id': self.worker, 'instance': self.instance,
            'manifest': self.manifest, 'concurrency': self.concurrency, **payload})
        response.raise_for_status()
        return response.json()['result']

    async def run_job(self, job):
        task = asyncio.current_task()
        async def renew():
            try:
                while True:
                    await asyncio.sleep(5)
                    if not await self.call('renew', job_id=job['id'], token=job['token']):
                        task.cancel()
                        return
            except Exception:
                task.cancel()
        renewal = asyncio.create_task(renew())
        try:
            if job['engine_digest'] != self.manifest['digest']:
                raise ValueError('Engine digest mismatch')
            game = self.game_class(job['rules'])
            initial = game.snapshot()['display']
            if job['kind'] == 'match':
                if not await self.call('initial', job_id=job['id'], token=job['token'], state=initial):
                    raise RuntimeError('Initial state rejected')
            while not game.outcome:
                code = job['agent1_code'] if game.current_player == 1 else job['agent2_code']
                result = await self.sandbox.execute(code, game.observation(), {'finals_rules': game.rules,
                    'round': self.manifest['round'], 'engine_digest': self.manifest['digest']})
                if not result['success']:
                    raise RuntimeError(result['error'])
                move = game.step(result['move'])
                if job['kind'] == 'match':
                    if not await self.call('step', job_id=job['id'], token=job['token'],
                        expected=game.move_count-1, move=move, state=game.snapshot(),
                        outcome=game.outcome, reason=game.reason):
                        raise RuntimeError('Move commit rejected')
            if job['kind'] == 'validation':
                await self.call('complete', job_id=job['id'], token=job['token'])
        except asyncio.CancelledError:
            try:
                await self.call('fail', job_id=job['id'], token=job['token'], error='Worker interrupted or lease lost')
            except Exception:
                pass
            raise
        except Exception as error:
            log.exception('Job %s failed', job['id'])
            try:
                await self.call('fail', job_id=job['id'], token=job['token'], error=str(error)[:2000])
            except Exception:
                log.exception('Could not report failure; lease will expire')
        finally:
            renewal.cancel()
            await asyncio.gather(renewal, return_exceptions=True)

    async def run(self):
        if not await self.sandbox.check():
            raise RuntimeError('Sandbox unavailable; refusing to register worker')
        stop = asyncio.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            asyncio.get_running_loop().add_signal_handler(sig, stop.set)
        active = set()
        try:
            while not stop.is_set():
                await self.call('heartbeat')
                active = {t for t in active if not t.done()}
                while len(active) < self.concurrency:
                    job = await self.call('claim')
                    if not job:
                        break
                    active.add(asyncio.create_task(self.run_job(job)))
                try:
                    await asyncio.wait_for(stop.wait(), 2)
                except asyncio.TimeoutError:
                    pass
        finally:
            for task in active:
                task.cancel()
            await asyncio.gather(*active, return_exceptions=True)
            try:
                await self.call('offline')
            finally:
                await self.client.aclose()


async def offline(name, args):
    manifest, game_class = load_engine(name)
    # Use the same effective identity (including sandbox limits) as the online service.
    sandbox = PythonRunner.from_env(WRAPPER, parse_result)
    limits = [sandbox.cpu_seconds,sandbox.wall_seconds,sandbox.memory_mb,sandbox.output_bytes,sandbox.source_bytes]
    digest = hashlib.sha256((manifest['digest']+json.dumps(limits)).encode()).hexdigest()
    bundle = json.loads(Path(args.bundle).read_text())
    if bundle.get('format') != 'ott-finals-bundle-v2':
        raise ValueError('Only round-pinned v2 bundles are supported')
    job = next(g for g in bundle['games'] if int(g['id']) == args.game)
    if job['round'] != manifest['round'] or job['engine_digest'] != digest:
        raise ValueError('Bundle requires a different round or engine build')
    entrants = {int(e['seed']):e for e in bundle['entrants'] if e['round'] == job['round']}
    if not await sandbox.check():
        raise RuntimeError('Sandbox unavailable')
    game = game_class(job['round_rules'])
    initial = game.snapshot()['display']
    moves = []
    while not game.outcome:
        seed = job['seed1'] if game.current_player == 1 else job['seed2']
        result = await sandbox.execute(entrants[seed]['code'],game.observation(),{'round':manifest['round'],'engine_digest':digest,'finals_rules':game.rules})
        if not result['success']:
            raise RuntimeError(result['error'])
        move = game.step(result['move'])
        moves.append({**move,'display':game.snapshot()['display']})
    record = {'format':'ott-finals-record-v2','game_id':args.game,'engine_digest':digest,
        'rules':game.rules,'initial_state':initial,'moves':moves,'outcome':game.outcome,'reason':game.reason}
    fd = os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump(record,stream,ensure_ascii=False)


def main(name):
    parser = argparse.ArgumentParser()
    parser.add_argument('--concurrency', type=int, choices=range(1, 9), default=1)
    parser.add_argument('--check',action='store_true')
    parser.add_argument('--bundle')
    parser.add_argument('--game',type=int)
    parser.add_argument('--output')
    args = parser.parse_args()
    if args.bundle and (not args.game or not args.output):
        parser.error('--bundle requires --game and --output')
    if not args.bundle and (args.game or args.output):
        parser.error('--game/--output require --bundle')
    logging.basicConfig(level=logging.INFO)
    if args.check:
        raise SystemExit(0 if asyncio.run(PythonRunner.from_env(WRAPPER,parse_result).check()) else 1)
    asyncio.run(offline(name,args) if args.bundle else Service(name,args.concurrency).run())
