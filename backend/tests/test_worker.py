"""Worker regressions with mocked Python execution and callbacks; no external services."""

import asyncio
import importlib.util
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from types import SimpleNamespace

import pytest


@pytest.fixture
def worker_module(monkeypatch):
    directory = Path(__file__).resolve().parents[2] / "worker_image"
    monkeypatch.syspath_prepend(str(directory))
    spec = importlib.util.spec_from_file_location("tested_worker", directory / "worker.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("output", [0, True, [], "a1", {"from_col": 1.2, "from_row": 3, "to_col": 0, "to_row": 3},
    {"from_col": -1, "from_row": 3, "to_col": 0, "to_row": 3}, {"from_pos": "a10", "to_pos": "b2"}])
def test_bad_agent_output_is_agent_error_not_infrastructure(worker_module, output):
    parsed = worker_module.parse_agent_output(json.dumps(output))
    assert parsed["success"] is False
    assert parsed["is_infra_error"] is False


@pytest.mark.asyncio
async def test_invalid_move_loses_match_without_infrastructure_retry(worker_module, monkeypatch):
    # A caller bypassing output normalization must still be handled by the engine.
    monkeypatch.setattr(worker_module, "execute_agent", AsyncMock(return_value={
        "success": True, "move": {"from_col": 99, "from_row": 0, "to_col": 0, "to_row": 0}
    }))
    result = await worker_module.run_match_locally("agent1", "agent2", 2)
    assert result["agent_error"] is True
    assert result["winner"] == 2


@pytest.mark.parametrize('kind,requested,expected', [
    ('validation', None, 60), ('validation', 300, 60), ('validation', 50, 50),
    ('rating', None, 200), ('rating', 300, 200), ('friendly', 300, 200),
    ('friendly', 100, 200), ('validation', True, 60), ('rating', -1, 200), ('rating',150,200),
])
def test_move_limits_include_old_queued_payloads(worker_module, kind, requested, expected):
    assert worker_module.match_move_limit(kind, requested) == expected


@pytest.mark.asyncio
async def test_repetition_continues_until_two_hundred_plies(worker_module, monkeypatch):
    cycle = [
        {'from_col': 1, 'from_row': 3, 'to_col': 0, 'to_row': 3},
        {'from_col': 7, 'from_row': 5, 'to_col': 8, 'to_row': 5},
        {'from_col': 0, 'from_row': 3, 'to_col': 1, 'to_row': 3},
        {'from_col': 8, 'from_row': 5, 'to_col': 7, 'to_row': 5},
    ]
    execute = AsyncMock(side_effect=[{'success': True, 'move': move} for move in cycle * 50])
    monkeypatch.setattr(worker_module, 'execute_agent', execute)
    result = await worker_module.run_match_locally('a', 'b', 200)
    assert execute.await_count == 200
    assert result['winner'] is None
    assert not result['agent_error']
    assert '200' in result['win_reason']
    assert result['steps'][-1]['game_over'] is True
    assert len(worker_module._build_moves_history(result['steps'])) == 200


def test_position_identity_includes_side_to_move_but_not_move_counter(worker_module):
    from game_engine import OTTGameEngine
    state = OTTGameEngine().state
    key = worker_module.position_key(state)
    state.move_count = 100
    assert worker_module.position_key(state) == key
    state.current_turn = 2
    assert worker_module.position_key(state) != key


@pytest.mark.parametrize('kind,requested,expected', [('validation',300,60),('rating',300,200),('validation',50,50),('friendly',300,200),('rating',150,200)])
@pytest.mark.asyncio
async def test_enqueue_limits_are_enforced_before_redis(monkeypatch,kind,requested,expected):
    from app.routers import rating, friendly
    router = friendly if kind == 'friendly' else rating
    queue = SimpleNamespace(enqueue_worker_task=AsyncMock())
    monkeypatch.setattr(router,'get_redis',lambda:queue)
    monkeypatch.setattr(router,'get_settings',lambda:SimpleNamespace(internal_backend_secret='test'))
    fields = dict(agent1_id=1,agent2_id=2,agent1_code='a',agent2_code='b',max_moves=requested)
    if kind == 'friendly':
        await friendly.enqueue_friendly_task(friendly.EnqueueFriendlyRequest(friendly_match_id=1,**fields),'test')
    else:
        await rating.enqueue_rating_task(rating.EnqueueRatingRequest(rated_match_id=1,kind=kind,**fields),'test')
    assert json.loads(queue.enqueue_worker_task.await_args.args[0])['max_moves']==expected


@pytest.mark.asyncio
async def test_move_cap_is_a_draw_not_an_agent_error(worker_module, monkeypatch):
    execute = AsyncMock(return_value={'success': True, 'move': {'from_col': 1, 'from_row': 3, 'to_col': 0, 'to_row': 3}})
    monkeypatch.setattr(worker_module, 'execute_agent', execute)
    result = await worker_module.run_match_locally('a', 'b', 1)
    assert result['winner'] is None
    assert result['win_reason'] == 'Đạt giới hạn 1 nước.'
    assert not result['agent_error']
    assert result['steps'][-1]['game_over'] is True


@pytest.mark.parametrize("processor,id_field", [("process_rating_task", "rated_match_id"), ("process_friendly_task", "friendly_match_id")])
@pytest.mark.asyncio
async def test_terminal_duplicate_can_be_acknowledged(worker_module, monkeypatch, processor, id_field):
    monkeypatch.setattr(worker_module, "_post_callback_with_retry", AsyncMock(return_value=(False, 409, {"reason": "already_finished"})))
    run = AsyncMock()
    monkeypatch.setattr(worker_module, "run_match_locally", run)
    result = await getattr(worker_module, processor)({id_field: 1, "agent1_id": 1, "agent2_id": 2}, "d1")
    assert result is True
    run.assert_not_called()


@pytest.mark.asyncio
async def test_lost_lease_cancels_execution_without_ack(worker_module, monkeypatch):
    stopped = asyncio.Event()

    async def processing(*args):
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setattr(worker_module, "process_rating_task", processing)
    monkeypatch.setattr(worker_module, "LEASE_RENEW_INTERVAL", 0.001)
    renewal = AsyncMock(side_effect=[None, True, False])
    monkeypatch.setattr(worker_module, "renew_task_lease", renewal)
    ack = AsyncMock()
    monkeypatch.setattr(worker_module, "ack_task", ack)
    running = asyncio.create_task(worker_module.process_task({"task_type": "rating", "task_id": "rating-1"}, "d1"))
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(running, 1)
    assert stopped.is_set()
    assert renewal.await_count == 3  # Network uncertainty alone did not cancel execution.
    ack.assert_not_called()


@pytest.mark.asyncio
async def test_success_acknowledges_current_delivery(worker_module, monkeypatch):
    monkeypatch.setattr(worker_module, "process_rating_task", AsyncMock(return_value=True))
    ack = AsyncMock()
    monkeypatch.setattr(worker_module, "ack_task", ack)
    await worker_module.process_task({"task_type": "rating", "task_id": "rating-1"}, "d1")
    ack.assert_awaited_once_with("rating-1", "d1")


@pytest.mark.asyncio
async def test_network_failure_does_not_claim_fencing(worker_module, monkeypatch):
    monkeypatch.setattr(worker_module.httpx, "AsyncClient", MagicMock(side_effect=OSError("network unavailable")))
    assert await worker_module.renew_task_lease("rating-1", "d1") is None


@pytest.mark.parametrize('delay,expected', [(0, 5), (10, 10), (120, 60), (None, 15)])
@pytest.mark.asyncio
async def test_dispatch_honors_bounded_scheduler_backoff(worker_module, monkeypatch, delay, expected):
    import httpx
    original = httpx.AsyncClient
    def handle(request):
        return httpx.Response(200, json={'retry_after_seconds': delay})
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs))
    assert await worker_module.dispatch_rating_task() == expected


@pytest.mark.asyncio
async def test_dispatch_network_failure_backs_off(worker_module, monkeypatch):
    monkeypatch.setattr(worker_module.httpx, 'AsyncClient', MagicMock(side_effect=OSError('unavailable')))
    assert await worker_module.dispatch_rating_task() == 15


@pytest.mark.asyncio
async def test_delivery_verification_requires_internal_auth(monkeypatch):
    from fastapi import HTTPException
    from app.routers import workers_queue

    monkeypatch.setattr(workers_queue, "get_settings", lambda: SimpleNamespace(internal_backend_secret="internal"))
    get_json = AsyncMock(return_value={"delivery_id": "current"})
    monkeypatch.setattr(workers_queue, "get_redis", lambda: SimpleNamespace(get_json=get_json))
    req = workers_queue.VerifyTaskRequest(task_id="rating-1", delivery_id="current")
    with pytest.raises(HTTPException) as error:
        await workers_queue.verify_task_delivery(req, "wrong")
    assert error.value.status_code == 401
    get_json.assert_not_called()
    assert await workers_queue.verify_task_delivery(req, "internal") == {"ok": True}
    req.delivery_id = "old"
    assert await workers_queue.verify_task_delivery(req, "internal") == {"ok": False}
    get_json.return_value = None
    assert await workers_queue.verify_task_delivery(req, "internal") == {"ok": False}
