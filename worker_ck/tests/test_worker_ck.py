import asyncio
from dataclasses import replace
import importlib
import json
import os
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from worker_ck.common.runtime import WRAPPER, Service, load_engine, parse_result
from worker_ck.common.sandbox import PythonRunner

NAMES = ['round_16', 'quarterfinal', 'semifinal', 'final', 'third_place']
CYCLE = [dict(from_col=1, from_row=3, to_col=0, to_row=3),
         dict(from_col=7, from_row=5, to_col=8, to_row=5),
         dict(from_col=0, from_row=3, to_col=1, to_row=3),
         dict(from_col=8, from_row=5, to_col=7, to_row=5)]


@pytest.mark.parametrize('name', NAMES)
def test_engine_keeps_original_rules_and_expanded_observation(name):
    manifest, cls = load_engine(name)
    assert manifest['round'] == NAMES.index(name)+1
    game = cls(manifest['rules'])
    assert len(game.snapshot()['display']['board']) == 81
    obs = game.observation()
    assert obs['finals']['terrain'] == []
    assert obs['finals']['bonus_cells'] == []
    assert obs['finals']['scores'] == {'1': 0, '2': 0}
    for n in range(8):
        game.step(CYCLE[n % 4])
    assert game.outcome == 'draw'
    assert game.engine.state.move_count == 8


def test_engine_changes_do_not_change_other_round_digests(monkeypatch):
    digests = [load_engine(name)[0]['digest'] for name in NAMES]
    original = Path.read_bytes
    def patched(path):
        content = original(path)
        if path.parent.name == 'quarterfinal' and path.name == 'engine.py':
            return content+b'\n# next engine revision\n'
        return content
    monkeypatch.setattr(Path, 'read_bytes', patched)
    newer = [load_engine(name)[0]['digest'] for name in NAMES]
    assert newer[1] != digests[1]
    assert newer[:1]+newer[2:] == digests[:1]+digests[2:]


@pytest.mark.asyncio
async def test_missing_sandbox_never_runs_agent(monkeypatch):
    monkeypatch.setattr('worker_ck.common.sandbox.shutil.which', lambda _: None)
    result = await PythonRunner(WRAPPER, parse_result).execute('raise Exception("must not run")', {})
    assert result['is_infra_error']


@pytest.mark.parametrize('key,value', [('CK_AGENT_WALL_SECONDS','nan'),('CK_AGENT_CPU_SECONDS','0'),('CK_AGENT_MEMORY_MB','16')])
def test_invalid_limits_refuse_start(key, value, monkeypatch):
    monkeypatch.setenv(key,value)
    with pytest.raises(ValueError):
        PythonRunner.from_env(WRAPPER,parse_result)


async def real_sandbox():
    sandbox=PythonRunner(WRAPPER,parse_result)
    if not await sandbox.check():
        if os.getenv('REQUIRE_SANDBOX_TESTS') == '1':
            pytest.fail('Real sandbox is required')
        pytest.skip('Sandbox unavailable in this environment')
    return sandbox


@pytest.mark.asyncio
async def test_real_agent_receives_round_configuration():
    sandbox=await real_sandbox()
    result=await sandbox.execute('''def agent(o,c):
    assert c['round'] == 3
    assert o['finals']['scores']['1'] == 0
    return {'from_pos':'b4','to_pos':'a4'}
''', load_engine('semifinal')[1]().observation(), {'round':3})
    assert result['success']
    assert result['move']['from_pos']=='b4'


@pytest.mark.asyncio
@pytest.mark.parametrize('code,fragment', [
 ('def agent(o,c):\n    while True: pass','limit'),
 ('def agent(o,c):\n    print("x"*200000)\n    return {}','output'),
 ('def agent(o,c):\n    x=bytearray(256*1024*1024)\n    return {}','Memory'),
 ('def agent(o,c):\n    import socket\n    socket.socket()\n    return {}','Permission'),
 ('def agent(o,c):\n    return {"secret": open("/app/worker_ck/.env").read()}','FileNotFound'),
 ('def agent(o,c):\n    import os\n    assert "CK_WORKER_TOKEN" in os.environ\n    return {}','Assertion'),
])
async def test_real_sandbox_bounds_and_isolation(code, fragment):
    sandbox=await real_sandbox()
    result=await sandbox.execute(code,{})
    assert not result['success']
    assert fragment.lower() in result['error'].lower()


@pytest.mark.asyncio
async def test_real_worker_commits_engine_display_and_finishes_validation(monkeypatch):
    sandbox=await real_sandbox()
    for key,value in {'CK_WORKER_ID':'tests','CK_WORKER_TOKEN':'test-only','CK_FRONTEND_URL':'http://localhost'}.items():
        monkeypatch.setenv(key,value)
    service=Service('round_16',1)
    service.sandbox=sandbox
    service.call=AsyncMock(return_value=True)
    code='def agent(o,c):\n    return '+repr(CYCLE)+'[o["move_count"] % 4]'
    job={'id':1,'token':'test','engine_digest':service.manifest['digest'],'rules':service.manifest['rules'],'agent1_code':code,'agent2_code':code,'kind':'match'}
    try:
        await service.run_job(job)
        calls=service.call.call_args_list
        assert calls[0].args==('initial',)
        steps=[c for c in calls if c.args==('step',)]
        assert len(steps)==8
        assert steps[-1].kwargs['outcome']=='draw'
        assert len(steps[-1].kwargs['state']['display']['board'])==81
        service.call.reset_mock()
        await service.run_job({**job,'kind':'validation'})
        service.call.assert_awaited_once_with('complete',job_id=1,token='test')
    finally:
        await service.client.aclose()
