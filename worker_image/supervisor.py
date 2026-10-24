"""Resident worker controller. Only its child executes matches."""
import argparse
import asyncio
from collections import deque
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import signal
import socket
import sys
import tempfile
import time
import uuid

import httpx

log = logging.getLogger('supervisor')


def identity(name=None):
    name = name or os.getenv('WORKER_ID') or 'default'
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}', name):
        raise ValueError('Worker name must contain 1–64 letters, digits, dots, underscores or hyphens.')
    source = os.getenv('MACHINE_ID')
    identity_file = os.getenv('WORKER_MACHINE_ID_FILE')
    if not source and identity_file:
        # A Docker volume gives each installation its own identity on Linux/Windows.
        # Lock before reading so concurrent checks never observe a partial UUID.
        with open(identity_file, 'a+', encoding='utf-8') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            handle.seek(0)
            source = handle.read().strip()
            if not source:
                source = uuid.uuid4().hex
                handle.write(source + '\n')
                handle.flush()
                os.fsync(handle.fileno())
    if not source:
        try:
            source = Path('/etc/machine-id').read_text().strip()
        except OSError:
            source = str(uuid.getnode())
    machine = hashlib.sha256(source.encode()).hexdigest()[:16]
    worker = hashlib.sha256(f'{machine}\0{name}'.encode()).hexdigest()[:32]
    return {'machine_id': machine, 'worker_name': name, 'worker_id': worker, 'hostname': socket.gethostname()}


class WorkerLock:
    def __init__(self, worker_id):
        directory = Path(tempfile.gettempdir()) / f'oantuti-worker-{os.getuid()}'
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or directory.stat().st_uid != os.getuid():
            raise RuntimeError('Worker lock directory has an invalid owner.')
        fd = os.open(directory / f'{worker_id}.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        self.file = os.fdopen(fd, 'r+')

    def __enter__(self):
        try:
            fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.file.seek(0)
            pid = self.file.read().strip() or '?'
            self.file.close()
            raise RuntimeError(f'Worker đã chạy (supervisor PID {pid}). Dùng --name khác để chạy song song.')
        self.file.seek(0)
        self.file.truncate()
        self.file.write(str(os.getpid()))
        self.file.flush()
        return self

    def __exit__(self, *args):
        # Never unlink: another waiter must see the same locked inode.
        self.file.close()


class Supervisor:
    def __init__(self, config, ident, client=None):
        self.config = config
        self.ident = ident
        self.instance_id = uuid.uuid4().hex
        self.generation = 0
        self.child = None
        self.reader = None
        self.runtime_id = ''
        self.control = {'mode': 'running', 'max_concurrent': config.MAX_CONCURRENT, 'revision': 0}
        self.snapshot = {'state': 'starting', 'active_jobs': 0, 'active_task_ids': [], 'applied_revision': 0,
                         'max_concurrent': config.MAX_CONCURRENT, 'last_error': ''}
        self.pending_releases = []
        self.shutdown = asyncio.Event()
        self.crashes = deque()
        self.retry_at = 0
        self.blocked = False
        self.last_success = 0
        self.client = client

    async def post(self, path, body):
        response = await self.client.post(self.config.BACKEND_URL + path, json=body,
                                         headers={'X-Worker-Secret': self.config.WORKER_SECRET})
        response.raise_for_status()
        return response.json()

    def scope(self):
        return {'worker_id': self.ident['worker_id'], 'instance_id': self.instance_id, 'generation': self.generation}

    async def register(self):
        data = await self.post('/workers/register', {**self.ident, 'instance_id': self.instance_id,
            'max_concurrent': self.config.MAX_CONCURRENT, 'judge0_url': self.config.EXECUTOR_URL})
        self.generation = data['generation']
        self.control = data['control']
        await self.post('/workers/release-runtime', {**self.scope(), 'old_only': True})
        self.last_success = time.monotonic()

    async def heartbeat(self):
        result = await self.post('/workers/supervisor-heartbeat', {**self.scope(), **self.snapshot,
            'runtime_id': self.runtime_id, 'judge0_url': self.config.EXECUTOR_URL,
            'supervisor_pid': os.getpid(), 'pid': self.child.pid if self.child else None})
        next_control = result['control']
        if next_control['revision'] != self.control['revision'] and next_control.get('last_action') == 'start':
            self.blocked = False
            self.crashes.clear()
            self.retry_at = 0
            self.snapshot['last_error'] = ''
        self.control = next_control
        self.last_success = time.monotonic()

    async def read_status(self, child):
        while line := await child.stdout.readline():
            try:
                data = json.loads(line)
                if self.child is child and isinstance(data, dict):
                    # A child saying "stopped" has not necessarily exited yet.
                    # Acknowledge stop only after wait() and lease recovery finish.
                    if data.get('state') == 'stopped':
                        data['state'] = 'draining'
                        data['applied_revision'] = self.snapshot['applied_revision']
                    for key in ('state', 'active_jobs', 'active_task_ids', 'max_concurrent', 'applied_revision', 'last_error'):
                        if key in data:
                            self.snapshot[key] = data[key]
            except (ValueError, TypeError):
                log.warning('Ignored invalid runtime status')

    async def send_control(self, value):
        if self.child and self.child.returncode is None:
            self.child.stdin.write((json.dumps(value) + '\n').encode())
            await asyncio.wait_for(self.child.stdin.drain(), 1)

    async def start_child(self):
        self.runtime_id = uuid.uuid4().hex
        self.snapshot.update(state='starting', active_jobs=0, active_task_ids=[], applied_revision=0)
        # Publish the runtime identity before it can issue its first claim.
        await self.heartbeat()
        if self.control['mode'] == 'stopped':
            self.runtime_id = ''
            return
        env = {**os.environ, 'OTT_MANAGED_WORKER_ID': self.ident['worker_id'],
               'OTT_SUPERVISOR_INSTANCE': self.instance_id, 'OTT_SUPERVISOR_GENERATION': str(self.generation),
               'OTT_RUNTIME_ID': self.runtime_id, 'OTT_INITIAL_CONTROL': json.dumps(self.control)}
        entrypoint = getattr(self.config, 'RUNTIME_ENTRYPOINT', Path(__file__).with_name('main.py'))
        self.child = await asyncio.create_subprocess_exec(sys.executable, '-B', '-u', str(entrypoint),
            '--runtime', env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            start_new_session=True, limit=65536)
        self.reader = asyncio.create_task(self.read_status(self.child))
        log.info('Started worker %s (PID %s)', self.ident['worker_name'], self.child.pid)

    async def finish_child(self, unexpected=False):
        child = self.child
        if child is None:
            return
        await child.wait()
        if self.reader:
            await self.reader
        if self.runtime_id:
            self.pending_releases.append(self.runtime_id)
        self.child = None
        self.runtime_id = ''
        self.snapshot.update(active_jobs=0, active_task_ids=[])
        if unexpected:
            now = time.monotonic()
            while self.crashes and self.crashes[0] < now - 300:
                self.crashes.popleft()
            self.crashes.append(now)
            self.blocked = len(self.crashes) > 3
            self.retry_at = now + [1, 5, 15][min(len(self.crashes) - 1, 2)]
            self.snapshot.update(state='error', last_error=f'Process exited ({child.returncode}). ' +
                ('Đã hết 3 lần tự khởi động lại; hãy bấm Bật worker.' if self.blocked else 'Đang chờ tự khởi động lại.'))
        else:
            self.snapshot.update(state='stopped')

    async def terminate_child(self):
        if not self.child:
            return
        self.snapshot['state'] = 'stopping'
        try:
            await self.send_control({'mode': 'terminate'})
            await asyncio.wait_for(self.child.wait(), 5)
        except (asyncio.TimeoutError, BrokenPipeError, ConnectionResetError):
            if self.child.returncode is None:
                os.killpg(self.child.pid, signal.SIGKILL)
                await self.child.wait()
        await self.finish_child()

    async def release_pending(self):
        for runtime in list(self.pending_releases):
            result = await self.post('/workers/release-runtime', {**self.scope(), 'runtime_id': runtime})
            if result.get('lost'):
                self.snapshot['last_error'] = f"{result['lost']} job thiếu dữ liệu recovery; cần kiểm tra trận bị kẹt."
            self.pending_releases.remove(runtime)

    async def tick(self):
        await self.heartbeat()
        if self.child and self.child.returncode is not None:
            await self.finish_child(unexpected=self.control['mode'] != 'stopped')
        await self.release_pending()
        if self.control['mode'] == 'stopped':
            if self.child:
                if self.control.get('stop_mode') == 'immediate':
                    await self.terminate_child()
                    await self.release_pending()
                else:
                    self.snapshot['state'] = 'draining'
                    await self.send_control(self.control)
            else:
                self.snapshot.update(state='stopped', max_concurrent=self.control['max_concurrent'],
                                     applied_revision=self.control['revision'])
        elif not self.child:
            if not self.blocked and time.monotonic() >= self.retry_at:
                await self.start_child()
        else:
            await self.send_control(self.control)

    async def run(self):
        # A previous process may have died while its 15s server lease is alive.
        for attempt in range(6):
            try:
                await self.register()
                break
            except httpx.HTTPStatusError as error:
                if error.response.status_code != 409 or attempt == 5:
                    raise
                log.warning('Waiting for previous supervisor ownership to expire...')
                await asyncio.sleep(3)
        log.info('Supervisor %s / %s online', self.ident['hostname'], self.ident['worker_name'])
        try:
            while not self.shutdown.is_set():
                try:
                    await self.tick()
                except (httpx.HTTPError, OSError, ValueError) as error:
                    log.warning('Control connection: %s', type(error).__name__)
                    fenced = False
                    if isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 409:
                        try:
                            fenced = error.response.json().get('detail', {}).get('reason') != 'ownership_expired'
                        except (ValueError, AttributeError):
                            fenced = True
                    if fenced or time.monotonic() - self.last_success >= 12:
                        await self.terminate_child()
                        self.snapshot['state'] = 'error'
                        if fenced:
                            raise RuntimeError('Supervisor ownership lost; worker stopped.') from error
                        # Re-register with the same instance after connection returns.
                        self.generation = 0
                    if not self.generation:
                        try:
                            await self.register()
                        except httpx.HTTPError:
                            pass
                try:
                    await asyncio.wait_for(self.shutdown.wait(), 3)
                except asyncio.TimeoutError:
                    pass
        finally:
            await self.terminate_child()
            try:
                await self.release_pending()
            except httpx.HTTPError:
                log.warning('Recovery deferred to the lease reaper.')


def cli(config):
    parser = argparse.ArgumentParser(description='OTTv2 worker supervisor (controllable from /admin/workers)')
    parser.add_argument('--name', help='Worker name; use a different name to run multiple workers on the same machine')
    args = parser.parse_args()
    config._validate_config()
    if not 1 <= config.MAX_CONCURRENT <= 64:
        raise SystemExit('MAX_CONCURRENT must be between 1 and 64.')
    try:
        ident = identity(args.name)
        with WorkerLock(ident['worker_id']):
            async def run():
                if not await config.check_executor():
                    raise RuntimeError('Python sandbox self-check failed. No jobs were claimed.')
                async with httpx.AsyncClient(timeout=10) as client:
                    supervisor = Supervisor(config, ident, client)
                    loop = asyncio.get_running_loop()
                    for sig in (signal.SIGINT, signal.SIGTERM):
                        loop.add_signal_handler(sig, supervisor.shutdown.set)
                    await supervisor.run()
            asyncio.run(run())
    except (RuntimeError, ValueError, httpx.HTTPError) as error:
        log.error('%s', str(error) if not isinstance(error, httpx.HTTPError) else type(error).__name__)
        raise SystemExit(2)
