"""Key isolation must also cover dynamic keys inside the claim Lua script."""

import json

import httpx
import pytest

from app.redis_client import RedisClient


@pytest.mark.asyncio
async def test_namespace_covers_commands_and_lua_without_changing_payload(monkeypatch):
    captured = []

    def handler(request):
        command = json.loads(request.content)
        captured.append(command)
        result = ([0, "", ""] if "RPOP" in command[1] else 1) if command[0] == "EVAL" else "OK"
        return httpx.Response(200, json={"result": result})

    original_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs))
    client = RedisClient.__new__(RedisClient)
    client._url = "https://redis.test"
    client._token = "test"
    client._key_prefix = "ott_e2e_test:"
    await client.set("worker:task_data:rating-1", "worker:literal-payload")
    await client.delete("worker:lease:rating-1", "worker:task_data:rating-1")
    await client.atomic_claim("machine", "delivery")
    await client.renew_lease("machine", "rating-1", "delivery")
    assert captured[0] == ["SET", "ott_e2e_test:worker:task_data:rating-1", "worker:literal-payload"]
    assert captured[1] == ["DEL", "ott_e2e_test:worker:lease:rating-1", "ott_e2e_test:worker:task_data:rating-1"]
    claim, renew = captured[2:]
    assert claim[3] == "ott_e2e_test:worker:queue"
    assert claim[9] == "ott_e2e_test:"
    assert renew[3] == "ott_e2e_test:worker:lease:rating-1"
