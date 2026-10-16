"""
Pydantic models cho request/response API.
"""

from pydantic import BaseModel, Field
from typing import Optional, Any
from enum import Enum


class MatchStatus(str, Enum):
    PENDING = "pending"       # Chưa bắt đầu
    RUNNING = "running"       # Đang chạy
    FINISHED = "finished"     # Đã kết thúc


# ─── Request models ───────────────────────────────────────────────────────────

class CreateMatchRequest(BaseModel):
    agent1_code: str = Field(..., description="Mã nguồn Python của agent 1 (Player 1/Blue)")
    agent2_code: str = Field(..., description="Mã nguồn Python của agent 2 (Player 2/Red)")
    max_moves: Optional[int] = Field(None, ge=1, description="Giới hạn số nước tối đa (None = dùng config mặc định)")

    model_config = {
        "json_schema_extra": {
            "example": {
                "agent1_code": "import random\n\ndef agent(observation, configuration):\n    moves = observation['valid_moves']\n    return random.choice(moves) if moves else None\n",
                "agent2_code": "import random\n\ndef agent(observation, configuration):\n    moves = observation['valid_moves']\n    return random.choice(moves) if moves else None\n",
            }
        }
    }


class StepRequest(BaseModel):
    match_id: str = Field(..., description="ID trận đấu")


# ─── Response models ──────────────────────────────────────────────────────────

class PieceInfo(BaseModel):
    player: int
    type: str  # ROCK | PAPER | SCISSORS


class MoveInfo(BaseModel):
    from_col: int
    from_row: int
    to_col: int
    to_row: int
    from_pos: str  # Ví dụ: "a1"
    to_pos: str    # Ví dụ: "b2"


class StepResult(BaseModel):
    match_id: str
    step_number: int
    player: int
    move: Optional[MoveInfo] = None
    captured: Optional[PieceInfo] = None
    game_over: bool
    winner: Optional[int] = None
    win_reason: str = ""
    error: Optional[str] = None      # Lỗi thực thi agent (nếu có)
    agent_stdout: Optional[str] = None   # Output của agent (debug)


class MatchState(BaseModel):
    match_id: str
    status: MatchStatus
    current_turn: int
    move_count: int
    game_over: bool
    winner: Optional[int] = None
    win_reason: str = ""
    board: list                       # List[9][9] pieces
    piece_counts: dict
    valid_moves: list
    history: list


class MatchSummary(BaseModel):
    match_id: str
    status: MatchStatus
    current_turn: int
    move_count: int
    game_over: bool
    winner: Optional[int] = None
    win_reason: str = ""


class CreateMatchResponse(BaseModel):
    match_id: str
    status: MatchStatus
    message: str


class RunToEndResponse(BaseModel):
    match_id: str
    total_moves: int
    game_over: bool
    winner: Optional[int] = None
    win_reason: str = ""
    steps: list[StepResult]
    aborted_reason: Optional[str] = None  # Nếu dừng giữa chừng


class ListMatchesResponse(BaseModel):
    matches: list[MatchSummary]
    total: int


class HealthResponse(BaseModel):
    status: str
    judge0_connected: bool
    judge0_url: str
    version: str


# ─── Tournament models ────────────────────────────────────────────────────────

class MatchPairRequest(BaseModel):
    """A single match pair to enqueue in a tournament session."""
    match_id: int = Field(..., description="DB match ID from Next.js")
    agent1_id: int = Field(..., description="Agent 1 DB ID")
    agent1_code: str = Field(..., description="Agent 1 Python source code")
    agent2_id: int = Field(..., description="Agent 2 DB ID")
    agent2_code: str = Field(..., description="Agent 2 Python source code")


class TournamentStartRequest(BaseModel):
    """Request body for POST /tournament/sessions/{session_id}/start."""
    pairs: list[MatchPairRequest] = Field(
        ...,
        description="List of match pairs to run in this session",
    )
    config: Optional[dict[str, Any]] = Field(
        default=None,
        description="Optional config: {max_parallel: int, max_moves: int}",
    )
    callback_url: str = Field(
        ...,
        description=(
            "Base URL of the Next.js app. Results are POSTed to "
            "{callback_url}/api/tournament/match-result"
        ),
    )

    model_config = {
        "json_schema_extra": {
            "example": {
                "pairs": [
                    {
                        "match_id": 42,
                        "agent1_id": 1,
                        "agent1_code": "import random\ndef agent(obs, cfg): return random.choice(obs['valid_moves'])",
                        "agent2_id": 2,
                        "agent2_code": "import random\ndef agent(obs, cfg): return random.choice(obs['valid_moves'])",
                    }
                ],
                "config": {"max_parallel": 3, "max_moves": 300},
                "callback_url": "https://myapp.vercel.app",
            }
        }
    }


class TournamentStatusResponse(BaseModel):
    """Response for GET /tournament/status."""
    status: str = Field(..., description="idle | running | paused | stopped")
    session_id: Optional[int] = Field(None, description="Currently active session ID")
    queue_depth: int = Field(..., description="Number of matches waiting in queue")
    active_matches: list[str] = Field(..., description="Backend match IDs currently running")
    active_count: int = Field(..., description="Number of concurrently running matches")
    max_parallel: int = Field(..., description="Max concurrent matches allowed")
    callback_url: str = Field(..., description="Callback URL for this session")


class ValidateAgentRequest(BaseModel):
    """Request body for POST /tournament/validate-agent."""
    code: str = Field(..., description="Python source code of the agent to validate")

    model_config = {
        "json_schema_extra": {
            "example": {
                "code": "import random\n\ndef agent(observation, configuration):\n    moves = observation['valid_moves']\n    return random.choice(moves) if moves else None\n"
            }
        }
    }


class ValidateAgentResponse(BaseModel):
    """Response for POST /tournament/validate-agent."""
    valid: bool = Field(..., description="True if the agent ran successfully and returned a valid move")
    error: Optional[str] = Field(None, description="Error message if validation failed")
