"""
Integration tests cho FastAPI endpoints.
Test không cần Judge0 thật - mock Judge0Service.

Chạy: pytest tests/test_api.py -v
"""

import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

from app.main import app
from app.services.match_service import get_match_service, MatchService


# ─── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    """Test client với match service mới cho mỗi test."""
    # Reset match service cho mỗi test
    import app.services.match_service as ms
    ms._match_service = None
    with TestClient(app) as c:
        yield c
    ms._match_service = None


RANDOM_AGENT_CODE = '''
import random

def agent(observation, configuration):
    moves = observation.get("valid_moves", [])
    if not moves:
        return None
    move = random.choice(moves)
    return {
        "from_col": move["from_col"],
        "from_row": move["from_row"],
        "to_col": move["to_col"],
        "to_row": move["to_row"],
    }
'''


# Mock execute_agent để trả về nước đi ngẫu nhiên từ valid_moves
# Khi patch instance method, mock nhận self là tham số đầu tiên
async def mock_execute_agent(self, agent_code, observation, configuration=None):
    import random
    moves = observation.get("valid_moves", [])
    if not moves:
        return {"success": True, "move": None, "stdout": "null", "stderr": "", "error": None}
    move = random.choice(moves)
    return {
        "success": True,
        "move": {
            "from_col": move["from_col"],
            "from_row": move["from_row"],
            "to_col": move["to_col"],
            "to_row": move["to_row"],
        },
        "stdout": str(move),
        "stderr": "",
        "error": None,
    }


# ─── Health Tests ──────────────────────────────────────────────────────────────

class TestHealth:
    def test_root(self, client):
        resp = client.get("/")
        assert resp.status_code == 200
        data = resp.json()
        assert "name" in data
        assert "version" in data

    def test_health_check(self, client):
        with patch(
            "app.services.judge0_service.Judge0Service.check_connection",
            new_callable=AsyncMock,
            return_value=False,
        ):
            resp = client.get("/health")
            assert resp.status_code == 200
            data = resp.json()
            assert data["status"] == "ok"
            assert "judge0_connected" in data
            assert "judge0_url" in data


# ─── Match CRUD Tests ──────────────────────────────────────────────────────────

class TestMatchCRUD:
    def test_create_match(self, client):
        resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "match_id" in data
        assert data["status"] == "running"
        assert "message" in data

    def test_create_match_with_max_moves(self, client):
        resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
            "max_moves": 10,
        })
        assert resp.status_code == 200

    @pytest.mark.parametrize("max_moves", [0, -1])
    def test_create_match_rejects_non_positive_limit(self, client, max_moves):
        resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
            "max_moves": max_moves,
        })
        assert resp.status_code == 422
        assert client.get("/matches/").json()["total"] == 0

    def test_list_matches_empty(self, client):
        resp = client.get("/matches/")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["matches"] == []

    def test_list_matches_after_create(self, client):
        client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
        })
        resp = client.get("/matches/")
        assert resp.status_code == 200
        assert resp.json()["total"] == 1

    def test_get_match_not_found(self, client):
        resp = client.get("/matches/nonexistent")
        assert resp.status_code == 404

    def test_get_match_state(self, client):
        create_resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
        })
        match_id = create_resp.json()["match_id"]

        resp = client.get(f"/matches/{match_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["match_id"] == match_id
        assert data["current_turn"] == 1
        assert data["move_count"] == 0
        assert data["game_over"] is False
        assert len(data["board"]) == 9
        assert len(data["board"][0]) == 9
        assert "piece_counts" in data
        assert "valid_moves" in data

    def test_delete_match(self, client):
        create_resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
        })
        match_id = create_resp.json()["match_id"]

        del_resp = client.delete(f"/matches/{match_id}")
        assert del_resp.status_code == 200

        get_resp = client.get(f"/matches/{match_id}")
        assert get_resp.status_code == 404

    def test_delete_nonexistent_match(self, client):
        resp = client.delete("/matches/nonexistent")
        assert resp.status_code == 404


# ─── Step Tests ────────────────────────────────────────────────────────────────

class TestMatchStep:
    def test_step_not_found(self, client):
        resp = client.post("/matches/nonexistent/step")
        assert resp.status_code == 404

    def test_step_success(self, client):
        create_resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
        })
        match_id = create_resp.json()["match_id"]

        with patch(
            "app.services.judge0_service.Judge0Service.execute_agent",
            new=mock_execute_agent,
        ):
            resp = client.post(f"/matches/{match_id}/step")
            assert resp.status_code == 200
            data = resp.json()
            assert data["match_id"] == match_id
            assert data["player"] == 1
            assert data["step_number"] == 1
            assert "move" in data
            assert data["move"] is not None

    def test_step_increments_move_count(self, client):
        create_resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
        })
        match_id = create_resp.json()["match_id"]

        with patch(
            "app.services.judge0_service.Judge0Service.execute_agent",
            new=mock_execute_agent,
        ):
            client.post(f"/matches/{match_id}/step")
            resp = client.get(f"/matches/{match_id}")
            assert resp.json()["move_count"] == 1

    def test_step_switches_turn(self, client):
        create_resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
        })
        match_id = create_resp.json()["match_id"]

        with patch(
            "app.services.judge0_service.Judge0Service.execute_agent",
            new=mock_execute_agent,
        ):
            client.post(f"/matches/{match_id}/step")  # P1 đi
            resp = client.get(f"/matches/{match_id}")
            assert resp.json()["current_turn"] == 2

    def test_step_with_invalid_move_from_agent(self, client):
        """Agent trả về nước đi không hợp lệ → người kia thắng."""
        create_resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
        })
        match_id = create_resp.json()["match_id"]

        async def mock_invalid_move(self, agent_code, observation, configuration=None):
            return {
                "success": True,
                "move": {"from_col": 0, "from_row": 0, "to_col": 8, "to_row": 8},  # Invalid
                "stdout": "",
                "stderr": "",
                "error": None,
            }

        with patch(
            "app.services.judge0_service.Judge0Service.execute_agent",
            new=mock_invalid_move,
        ):
            resp = client.post(f"/matches/{match_id}/step")
            assert resp.status_code == 200
            data = resp.json()
            assert data["game_over"] is True
            assert data["winner"] == 2  # P2 thắng vì P1 đi sai

    def test_step_with_judge0_error(self, client):
        """Judge0 lỗi → người kia thắng."""
        create_resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
        })
        match_id = create_resp.json()["match_id"]

        async def mock_error(self, agent_code, observation, configuration=None):
            return {
                "success": False,
                "move": None,
                "stdout": "",
                "stderr": "SyntaxError: ...",
                "error": "Lỗi biên dịch",
            }

        with patch(
            "app.services.judge0_service.Judge0Service.execute_agent",
            new=mock_error,
        ):
            resp = client.post(f"/matches/{match_id}/step")
            assert resp.status_code == 200
            data = resp.json()
            assert data["game_over"] is True
            assert data["winner"] == 2


# ─── Run to End Tests ──────────────────────────────────────────────────────────

class TestRunToEnd:
    @pytest.mark.parametrize("endpoint,max_moves", [("step", 1), ("run", 5)])
    def test_move_limit_finishes_match(self, client, endpoint, max_moves):
        match_id = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
            "max_moves": max_moves,
        }).json()["match_id"]

        async def first_valid_move(agent_code, observation, configuration=None):
            return {
                "success": True, "move": observation["valid_moves"][0],
                "stdout": "", "stderr": "", "error": None,
            }

        with patch.object(
            get_match_service()._judge0, "execute_agent",
            side_effect=first_valid_move,
        ) as execute:
            response = client.post(f"/matches/{match_id}/{endpoint}")
            assert response.status_code == 200
            result = response.json()
            assert result["game_over"] is True
            assert result["winner"] is None
            assert result["win_reason"] == f"Đạt giới hạn {max_moves} nước."
            if endpoint == "run":
                assert len(result["steps"]) == max_moves
                assert result["steps"][-1]["game_over"] is True
                assert result["steps"][-1]["error"] is None
            else:
                assert result["move"] is not None
                assert result["error"] is None

            state = client.get(f"/matches/{match_id}").json()
            assert state["status"] == "finished"
            assert state["game_over"] is True
            assert state["move_count"] == max_moves
            assert get_match_service().get_match(match_id).finished_at is not None

            # A later request must not execute the agent or change the board.
            client.post(f"/matches/{match_id}/step")
            assert execute.call_count == max_moves
            assert client.get(f"/matches/{match_id}").json() == state

    def test_winning_on_last_move_is_not_a_draw(self, client):
        match_id = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
            "max_moves": 1,
        }).json()["match_id"]
        match = get_match_service().get_match(match_id)
        match.engine.state.board[7][7] = match.engine.state.board[3][1]
        match.engine.state.board[3][1] = None

        with patch.object(
            get_match_service()._judge0, "execute_agent", new_callable=AsyncMock,
        ) as execute:
            execute.return_value = {
                "success": True,
                "move": {"from_col": 7, "from_row": 7, "to_col": 8, "to_row": 8},
                "stdout": "", "stderr": "", "error": None,
            }
            result = client.post(f"/matches/{match_id}/run").json()
        assert result["game_over"] is True
        assert result["winner"] == 1
        assert "giới hạn" not in result["win_reason"]

    def test_run_small_match(self, client):
        """Chạy trận giới hạn 5 nước."""
        create_resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
            "max_moves": 5,
        })
        match_id = create_resp.json()["match_id"]

        with patch(
            "app.services.judge0_service.Judge0Service.execute_agent",
            new=mock_execute_agent,
        ):
            resp = client.post(f"/matches/{match_id}/run")
            assert resp.status_code == 200
            data = resp.json()
            assert data["match_id"] == match_id
            assert "total_moves" in data
            assert "steps" in data
            assert len(data["steps"]) <= 5

    def test_run_not_found(self, client):
        resp = client.post("/matches/nonexistent/run")
        assert resp.status_code == 404


# ─── Board Structure Tests ─────────────────────────────────────────────────────

class TestBoardStructure:
    def test_initial_board_has_pieces(self, client):
        """Kiểm tra bàn cờ ban đầu có đúng quân."""
        create_resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
        })
        match_id = create_resp.json()["match_id"]
        resp = client.get(f"/matches/{match_id}")
        board = resp.json()["board"]

        # P1 ROCK tại 4b (col=1, row=3)
        assert board[3][1] is not None
        assert board[3][1]["player"] == 1
        assert board[3][1]["type"] == "ROCK"

        # P2 PAPER tại 8e (col=4, row=7)
        assert board[7][4] is not None
        assert board[7][4]["player"] == 2
        assert board[7][4]["type"] == "PAPER"

    def test_initial_piece_counts(self, client):
        create_resp = client.post("/matches/", json={
            "agent1_code": RANDOM_AGENT_CODE,
            "agent2_code": RANDOM_AGENT_CODE,
        })
        match_id = create_resp.json()["match_id"]
        resp = client.get(f"/matches/{match_id}")
        counts = resp.json()["piece_counts"]

        # JSON keys là string
        assert counts["1"]["ROCK"] == 3
        assert counts["1"]["PAPER"] == 4
        assert counts["1"]["SCISSORS"] == 3
        assert counts["2"]["ROCK"] == 3
        assert counts["2"]["PAPER"] == 4
        assert counts["2"]["SCISSORS"] == 3
