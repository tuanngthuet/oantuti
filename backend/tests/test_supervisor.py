import asyncio
import importlib
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.fixture
def modules(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'worker_image'))
    return importlib.import_module('supervisor'), importlib.import_module('runtime')


def test_identity_stable_by_machine_and_name(modules, monkeypatch):
    supervisor, _ = modules
    monkeypatch.setenv('MACHINE_ID', 'test-machine')
    first = supervisor.identity('alpha')
    assert supervisor.identity('alpha') == first
    assert supervisor.identity('beta')['worker_id'] != first['worker_id']
    monkeypatch.setenv('MACHINE_ID', 'other-machine')
    assert supervisor.identity('alpha')['worker_id'] != first['worker_id']
    with pytest.raises(ValueError):
        supervisor.identity('../../escape')


def test_two_consoles_same_identity_are_blocked_before_network(modules, monkeypatch):
    import os
    supervisor, _ = modules
    monkeypatch.setenv('MACHINE_ID', 'console-lock-test')
    worker_id = supervisor.identity('alpha')['worker_id']
    with supervisor.WorkerLock(worker_id):
        result = subprocess.run([sys.executable, '-B', str(Path(supervisor.__file__).with_name('main.py')), '--name', 'alpha'],
            env={**os.environ, 'WORKER_SECRET': 'valid-worker-secret', 'WORKER_CALLBACK_SECRET': 'valid-callback-secret',
                 'BACKEND_URL': 'http://127.0.0.1:1'}, capture_output=True, text=True, timeout=5)
        assert result.returncode == 2
        assert 'Worker đã chạy' in result.stderr
        with supervisor.WorkerLock(supervisor.identity('beta')['worker_id']):
            pass
    # Stale lock files must be reusable after the original owner exits.
    with supervisor.WorkerLock(worker_id):
        pass


def test_runtime_control_rejects_stale_and_invalid_limits(modules):
    _, runtime = modules
    control = runtime.RuntimeControl({'mode': 'running', 'max_concurrent': 4, 'revision': 2})
    control.apply({'mode': 'paused', 'max_concurrent': 1, 'revision': 1})
    assert control.value['mode'] == 'running'
    for limit in (0, 65, True):
        control.apply({'mode': 'running', 'max_concurrent': limit, 'revision': 3})
        assert control.value['max_concurrent'] == 4
    control.apply({'mode': 'paused', 'max_concurrent': 2, 'revision': 3})
    assert control.value['mode'] == 'paused'
    control.apply({'mode': 'terminate'})
    assert control.terminate


@pytest.mark.asyncio
async def test_supervisor_preserves_stopped_intent_and_sends_live_configuration(modules):
    supervisor, _ = modules
    manager = supervisor.Supervisor(SimpleNamespace(MAX_CONCURRENT=4), supervisor.identity('unit'))
    manager.heartbeat = AsyncMock()
    manager.release_pending = AsyncMock()
    manager.start_child = AsyncMock()
    manager.control = {'mode': 'stopped', 'revision': 3, 'max_concurrent': 2}
    await manager.tick()
    manager.start_child.assert_not_awaited()
    assert manager.snapshot['applied_revision'] == 3
    manager.child = SimpleNamespace(returncode=None)
    manager.send_control = AsyncMock()
    manager.control = {'mode': 'paused', 'revision': 4, 'max_concurrent': 1}
    await manager.tick()
    manager.send_control.assert_awaited_once_with(manager.control)


@pytest.mark.asyncio
async def test_graceful_stop_drains_but_immediate_stop_terminates(modules):
    supervisor, _ = modules
    manager = supervisor.Supervisor(SimpleNamespace(MAX_CONCURRENT=4), supervisor.identity('unit'))
    manager.heartbeat = AsyncMock()
    manager.release_pending = AsyncMock()
    manager.send_control = AsyncMock()
    manager.terminate_child = AsyncMock()
    manager.child = SimpleNamespace(returncode=None)
    manager.control = {'mode': 'stopped', 'stop_mode': 'graceful', 'revision': 2, 'max_concurrent': 4}
    await manager.tick()
    assert manager.snapshot['state'] == 'draining'
    manager.terminate_child.assert_not_awaited()
    manager.control['stop_mode'] = 'immediate'
    await manager.tick()
    manager.terminate_child.assert_awaited_once()


@pytest.mark.asyncio
async def test_stop_is_not_acknowledged_until_child_actually_exits(modules):
    supervisor, _ = modules
    manager = supervisor.Supervisor(SimpleNamespace(MAX_CONCURRENT=4), supervisor.identity('unit'))
    stream = asyncio.StreamReader()
    stream.feed_data((json.dumps({'state': 'stopped', 'applied_revision': 2, 'active_jobs': 0}) + '\n').encode())
    stream.feed_eof()
    manager.child = SimpleNamespace(stdout=stream)
    manager.snapshot['applied_revision'] = 1
    await manager.read_status(manager.child)
    assert manager.snapshot['state'] == 'draining'
    assert manager.snapshot['applied_revision'] == 1


@pytest.mark.asyncio
async def test_crash_loop_stops_after_three_retries(modules):
    supervisor, _ = modules
    manager = supervisor.Supervisor(SimpleNamespace(MAX_CONCURRENT=4), supervisor.identity('unit'))
    manager.reader = None
    for attempt in range(4):
        manager.child = SimpleNamespace(wait=AsyncMock(return_value=1), returncode=1)
        manager.runtime_id = str(attempt)
        await manager.finish_child(unexpected=True)
        assert manager.blocked == (attempt == 3)
    assert len(manager.pending_releases) == 4


@pytest.mark.asyncio
async def test_immediate_shutdown_kills_unresponsive_child_within_timeout(modules, monkeypatch):
    supervisor, _ = modules
    manager = supervisor.Supervisor(SimpleNamespace(MAX_CONCURRENT=4), supervisor.identity('unit'))
    # Exercise real subprocess/pipe cleanup without contacting external services.
    manager.child = await asyncio.create_subprocess_exec(sys.executable, '-c', 'import time; time.sleep(60)',
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, start_new_session=True)
    manager.runtime_id = 'dead-runtime'
    original_wait = asyncio.wait_for
    async def fast_wait(awaitable, timeout):
        return await original_wait(awaitable, min(timeout, 0.05))
    monkeypatch.setattr(supervisor.asyncio, 'wait_for', fast_wait)
    try:
        await manager.terminate_child()
        assert manager.child is None
        assert manager.pending_releases == ['dead-runtime']
    finally:
        if manager.child and manager.child.returncode is None:
            manager.child.kill()
            await manager.child.wait()
