import asyncio
from dataclasses import replace
import importlib.util
import os
from pathlib import Path
import signal
import sys
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from worker_image.runner import PythonRunner


@pytest.fixture
def core(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / 'worker_image'))
    monkeypatch.setenv('WORKER_ENV_FILE', str(ROOT / 'worker_image' / 'unused-test.env'))
    spec = importlib.util.spec_from_file_location('local_test_core', ROOT / 'worker_image' / 'worker.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def runner(core):
    return PythonRunner(core.AGENT_WRAPPER, core.parse_agent_output, wall_seconds=5)


@pytest_asyncio.fixture
async def sandbox(runner):
    if not await runner.check():
        if os.getenv('REQUIRE_SANDBOX_TESTS') == '1':
            pytest.fail('Real Bubblewrap sandbox is required but not available')
        pytest.skip('Bubblewrap/user namespaces unavailable; set REQUIRE_SANDBOX_TESTS=1 to require them')
    return runner


@pytest.mark.asyncio
async def test_missing_sandbox_is_infrastructure_and_never_runs_agent(runner, monkeypatch):
    monkeypatch.setattr('worker_image.runner.shutil.which', lambda _: None)
    result = await runner.execute('raise Exception("should never execute")', {})
    assert result['is_infra_error']
    assert 'not installed' in result['error']


@pytest.mark.parametrize('setting,value', [
    ('AGENT_CPU_SECONDS', '0'), ('AGENT_WALL_SECONDS', 'nan'), ('AGENT_WALL_SECONDS', '-1'),
    ('AGENT_MEMORY_MB', '16'), ('AGENT_OUTPUT_BYTES', '0'), ('AGENT_SOURCE_BYTES', '0'),
])
def test_invalid_limits_fail_before_claiming(core, monkeypatch, setting, value):
    monkeypatch.setenv(setting, value)
    with pytest.raises(ValueError):
        PythonRunner.from_env(core.AGENT_WRAPPER, core.parse_agent_output)


@pytest.mark.asyncio
async def test_source_limit_does_not_start_process(runner, monkeypatch):
    spawn = AsyncMock()
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    result = await replace(runner, source_bytes=8).execute('x' * 9, {})
    assert not result['success'] and not result['is_infra_error']
    spawn.assert_not_awaited()


@pytest.mark.asyncio
async def test_observation_and_debug_output_preserve_legacy_protocol(sandbox):
    result = await sandbox.execute('''
def agent(observation, configuration):
    print("debug output")
    assert configuration == {}
    return observation['valid_moves'][0]
''', {'valid_moves': [{'from_col': 1, 'from_row': 3, 'to_col': 0, 'to_row': 3}]})
    assert result['success']
    assert result['move'] == {'from_col': 1, 'from_row': 3, 'to_col': 0, 'to_row': 3}
    assert result['stderr'] == ''


@pytest.mark.parametrize('code', [
    'def agent(o,c): return [0,0,1,1]',
    'def agent(o,c): return {"from_pos":"a1","to_pos":"b2"}',
])
@pytest.mark.asyncio
async def test_move_formats(sandbox, code):
    result = await sandbox.execute(code, {})
    assert result['success']
    assert result['move'] == {'from_col': 0, 'from_row': 0, 'to_col': 1, 'to_row': 1}


@pytest.mark.parametrize('code', [
    'def agent(o,c): raise ValueError("broken agent")',
    'def agent(o,c): return "bad move"',
    'def agent(o,c): return {"from_col":99,"from_row":0,"to_col":1,"to_row":1}',
    'this is invalid python !!!',
])
@pytest.mark.asyncio
async def test_agent_failures_are_not_infrastructure(sandbox, code):
    result = await sandbox.execute(code, {})
    assert not result['success']
    assert not result['is_infra_error']


@pytest.mark.asyncio
async def test_wall_timeout_for_sleeping_agent(sandbox):
    result = await replace(sandbox, wall_seconds=1).execute('import time\ndef agent(o,c): time.sleep(60)', {})
    assert not result['is_infra_error']
    assert result['error'] == 'Wall time limit exceeded.'


@pytest.mark.asyncio
async def test_cpu_limit_for_busy_agent(sandbox):
    result = await replace(sandbox, cpu_seconds=1, wall_seconds=5).execute('def agent(o,c):\n    while True: pass', {})
    assert not result['success'] and not result['is_infra_error']
    assert 'Wall time' not in result['error']


@pytest.mark.asyncio
async def test_memory_limit(sandbox):
    result = await replace(sandbox, memory_mb=64).execute('def agent(o,c): return bytearray(256 * 1024 * 1024)', {})
    assert not result['success'] and not result['is_infra_error']
    assert 'Memory' in result['error']


@pytest.mark.asyncio
async def test_output_flood_is_bounded(sandbox):
    result = await replace(sandbox, output_bytes=4096).execute('def agent(o,c):\n    while True: print("x" * 1000, flush=True)', {})
    assert not result['is_infra_error']
    assert 'output limit' in result['error']
    assert len(result['stdout'].encode()) + len(result['stderr'].encode()) <= 4096


@pytest.mark.asyncio
async def test_files_secrets_network_and_fork_are_isolated(sandbox, monkeypatch, tmp_path):
    secret_file = tmp_path / 'secret'
    secret_file.write_text('host-secret')
    monkeypatch.setenv('WORKER_SECRET', 'must-not-reach-agent')
    code = f'''
import os, socket
def agent(o,c):
    assert 'WORKER_SECRET' not in os.environ
    assert not os.path.exists({str(secret_file)!r})
    assert not os.path.exists('/app')
    for operation in (os.fork, socket.socket, lambda: open('/tmp/file', 'w')):
        try:
            operation()
        except OSError:
            pass
        else:
            raise AssertionError('sandbox restriction failed')
    return [0,0,1,1]
'''
    assert (await sandbox.execute(code, {}))['success']


@pytest.mark.asyncio
async def test_hard_resource_limits_cannot_be_raised(sandbox):
    result = await sandbox.execute('''
import resource
def agent(o,c):
    for kind in (resource.RLIMIT_AS, resource.RLIMIT_CPU):
        try:
            resource.setrlimit(kind, (resource.RLIM_INFINITY, resource.RLIM_INFINITY))
        except (OSError, ValueError):
            pass
        else:
            raise AssertionError('agent raised hard resource limit')
    return [0,0,1,1]
''', {})
    assert result['success']


@pytest.mark.asyncio
async def test_cancellation_reaps_process(sandbox, monkeypatch):
    spawned = []
    started = asyncio.Event()
    original = asyncio.create_subprocess_exec

    async def spawn(*args, **kwargs):
        proc = await original(*args, **kwargs)
        spawned.append(proc)
        started.set()
        return proc

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    task = asyncio.create_task(sandbox.execute('import time\ndef agent(o,c): time.sleep(60)', {}))
    await asyncio.wait_for(started.wait(), 2)
    await asyncio.sleep(0.15)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert spawned[0].returncode is not None
    with pytest.raises(ProcessLookupError):
        os.kill(spawned[0].pid, 0)


@pytest.mark.asyncio
async def test_local_runner_plays_complete_match_through_shared_callbacks(sandbox, core, monkeypatch):
    monkeypatch.setattr(core, 'execute_agent', sandbox.execute)
    callbacks = AsyncMock(side_effect=[(True, 200, {'execution_token': 'delivery'}), (True, 200, {})])
    ack = AsyncMock()
    monkeypatch.setattr(core, '_post_callback_with_retry', callbacks)
    monkeypatch.setattr(core, 'ack_task', ack)
    await core.process_task({'task_type': 'rating', 'task_id': 'rating-1', 'rated_match_id': 1,
        'agent1_id': 10, 'agent2_id': 20, 'max_moves': 2,
        'agent1_code': 'def agent(o,c): return [(1,3,0,3),(7,5,8,5),(0,3,1,3),(8,5,7,5)][o["move_count"]%4]',
        'agent2_code': 'def agent(o,c): return [(1,3,0,3),(7,5,8,5),(0,3,1,3),(8,5,7,5)][o["move_count"]%4]'}, 'delivery')
    finished = callbacks.await_args_list[1].args[1]
    assert finished['event'] == 'finished' and finished['outcome'] == 'draw'
    assert finished['total_moves'] == 200 and not finished['is_infra_error']
    ack.assert_awaited_once_with('rating-1', 'delivery')
