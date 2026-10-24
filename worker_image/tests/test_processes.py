"""Real supervisor/child processes of parallel Python workers against a local fake stack."""
import asyncio
import json
import os
from pathlib import Path
import signal
import socket
import sys
from types import SimpleNamespace
import uuid

import fakeredis.aioredis
from fastapi import FastAPI, Request
import pytest
import uvicorn

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from app.redis_client import RedisClient
from app.routers import workers, workers_queue
from app.services import worker_control


@pytest.mark.asyncio
async def test_python_supervisors_process_jobs_and_stop_independently(monkeypatch, tmp_path):
    fake = fakeredis.aioredis.FakeRedis(decode_responses=True)
    redis = RedisClient.__new__(RedisClient)
    redis._key_prefix = ''
    redis._cmd = fake.execute_command
    settings = SimpleNamespace(worker_secret='test-worker', internal_backend_secret='test-internal')
    for module in (workers, workers_queue):
        monkeypatch.setattr(module, 'get_redis', lambda: redis)
        monkeypatch.setattr(module, 'get_settings', lambda: settings)
    app = FastAPI()
    app.include_router(workers.router)
    app.include_router(workers_queue.router)
    finished = {}
    owners = set()
    unexpected_http = []

    @app.post('/api/rating/dispatch')
    async def dispatch():
        return {'retry_after_seconds': 60}

    @app.post('/api/rating/match-result')
    async def callback(request: Request):
        body = await request.json()
        assert request.headers['X-Worker-Callback-Secret'] == 'test-callback'
        lease = await redis.get_json(f'worker:lease:rating-{body["rated_match_id"]}')
        assert lease['delivery_id'] == body['delivery_id']
        if body['event'] == 'started':
            owners.add(lease['machine_id'])
            # Keep the delivery active long enough for both Python workers to claim.
            await asyncio.sleep(0.3)
            return {'execution_token': body['delivery_id']}
        assert body['execution_token'] == lease['delivery_id']
        finished[body['rated_match_id']] = body
        return {'ok': True}

    @app.api_route('/{path:path}', methods=['GET', 'POST'])
    async def unexpected(request: Request, path: str):
        unexpected_http.append(path)
        return {'error': 'Unexpected execution service request'}

    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    address = f'http://127.0.0.1:{listener.getsockname()[1]}'
    server = uvicorn.Server(uvicorn.Config(app, log_level='error', lifespan='off'))
    server.install_signal_handlers = lambda: None
    service = asyncio.create_task(server.serve(sockets=[listener]))
    processes = []
    logs = []

    async def wait_for(predicate, seconds=20):
        async def poll():
            while True:
                result = await predicate()
                if result:
                    return result
                for process in processes:
                    if process.returncode is not None:
                        pytest.fail(f'Worker exited ({process.returncode}): ' + '\n'.join(path.read_text() for path in logs))
                await asyncio.sleep(0.1)
        return await asyncio.wait_for(poll(), seconds)

    async def both_running():
        values = await worker_control.list_workers(redis)
        return values if len(values) == 2 and all(w.get('state') == 'running' for w in values) else None

    try:
        while not server.started:
            await asyncio.sleep(0.01)
        env = {**os.environ, 'BACKEND_URL': address, 'FRONTEND_URL': address,
            'WORKER_SECRET': 'test-worker', 'WORKER_CALLBACK_SECRET': 'test-callback',
            'MAX_CONCURRENT': '1', 'POLL_INTERVAL': '0.1', 'MACHINE_ID': uuid.uuid4().hex,
            'WORKER_ENV_FILE': str(tmp_path / 'no-dotenv'), 'WORKER_ID': 'local-python'}
        for name, entrypoint in (('python-alpha', ROOT / 'worker_image' / 'main.py'),
                                 ('python-beta', ROOT / 'worker_image' / 'main.py')):
            path = tmp_path / f'{name}.log'
            logs.append(path)
            with path.open('wb') as stream:
                processes.append(await asyncio.create_subprocess_exec(sys.executable, '-B', str(entrypoint),
                    '--name', name, env=env, stdout=stream, stderr=stream))
        values = await wait_for(both_running)
        code = 'def agent(o,c):\n    g=8 if o["current_player"]==1 else 0\n    return min(o["valid_moves"],key=lambda m:(max(abs(m["to_col"]-g),abs(m["to_row"]-g)),-int(m.get("is_capture",False))))'
        for number in range(1, 5):
            await redis.enqueue_worker_task(json.dumps({'task_type': 'rating', 'rated_match_id': number,
                'kind': 'rating', 'agent1_id': 1, 'agent2_id': 2, 'max_moves': 2,
                'agent1_code': code, 'agent2_code': code}))

        async def all_acked():
            if len(finished) != 4:
                return False
            leases = await asyncio.gather(*[fake.exists(f'worker:lease:rating-{i}') for i in range(1, 5)])
            return not any(leases)

        await wait_for(all_acked)
        assert len(owners) == 2
        assert unexpected_http == []  # Execution must not call any remote service.
        assert all(not body['is_infra_error'] and 0<body['total_moves']<200 and body['outcome']!='draw' for body in finished.values())
        python_worker = next(w for w in values if w['worker_name'] == 'python-beta')
        sibling_worker = next(w for w in values if w['worker_name'] == 'python-alpha')
        await worker_control.update(redis, python_worker['worker_id'], {'revision': 1, 'action': 'stop',
            'stop_mode': 'graceful', 'updated_by': 'test'})

        async def only_python_stopped():
            listed = await worker_control.list_workers(redis)
            states = {w['worker_id']: w for w in listed}
            return (states[python_worker['worker_id']].get('state') == 'stopped'
                    and states[sibling_worker['worker_id']].get('state') == 'running')

        await wait_for(only_python_stopped)
        assert all(proc.returncode is None for proc in processes)  # Supervisor remains available to Start.
    finally:
        for process in processes:
            if process.returncode is None:
                process.send_signal(signal.SIGTERM)
        for process in processes:
            try:
                await asyncio.wait_for(process.wait(), 10)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        server.should_exit = True
        await service
        await fake.aclose()
