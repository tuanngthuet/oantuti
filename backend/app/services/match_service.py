"""
Match Service - Quản lý trận đấu OTTv2.

Lưu trữ match trong memory (dict). Trong production có thể thay bằng Redis/DB.
"""

import uuid
import logging
from typing import Optional
from datetime import datetime

from ..engine.game import OTTGameEngine, Move
from ..models import MatchStatus, StepResult, MoveInfo
from ..config import get_settings
from .judge0_service import Judge0Service

logger = logging.getLogger(__name__)


class MatchData:
    """Dữ liệu một trận đấu."""

    def __init__(self, match_id: str, agent1_code: str, agent2_code: str, max_moves: int):
        self.match_id = match_id
        self.agent1_code = agent1_code
        self.agent2_code = agent2_code
        self.max_moves = max_moves
        self.engine = OTTGameEngine()
        self.status = MatchStatus.PENDING
        self.created_at = datetime.utcnow()
        self.finished_at: Optional[datetime] = None

    def to_summary_dict(self) -> dict:
        state = self.engine.state
        return {
            "match_id": self.match_id,
            "status": self.status,
            "current_turn": state.current_turn,
            "move_count": state.move_count,
            "game_over": state.game_over,
            "winner": state.winner,
            "win_reason": state.win_reason,
        }

    def to_state_dict(self) -> dict:
        state = self.engine.state
        obs = self.engine.get_observation()
        return {
            "match_id": self.match_id,
            "status": self.status,
            "current_turn": state.current_turn,
            "move_count": state.move_count,
            "game_over": state.game_over,
            "winner": state.winner,
            "win_reason": state.win_reason,
            "board": state.to_dict()["board"],
            "piece_counts": obs["piece_counts"],
            "valid_moves": obs["valid_moves"],
            "history": state.history,
        }


class MatchService:
    """Service quản lý vòng đời trận đấu."""

    def __init__(self):
        self._matches: dict[str, MatchData] = {}
        self._judge0 = Judge0Service()
        self._settings = get_settings()

    def create_match(
        self,
        agent1_code: str,
        agent2_code: str,
        max_moves: Optional[int] = None,
    ) -> MatchData:
        """Tạo trận đấu mới."""
        match_id = str(uuid.uuid4())[:8]  # Short ID cho dễ dùng
        max_moves = max_moves or self._settings.max_moves_per_match
        match = MatchData(
            match_id=match_id,
            agent1_code=agent1_code,
            agent2_code=agent2_code,
            max_moves=max_moves,
        )
        match.status = MatchStatus.RUNNING
        self._matches[match_id] = match
        logger.info(f"Created match {match_id}")
        return match

    def get_match(self, match_id: str) -> Optional[MatchData]:
        return self._matches.get(match_id)

    def list_matches(self) -> list[MatchData]:
        return list(self._matches.values())

    def delete_match(self, match_id: str) -> bool:
        if match_id in self._matches:
            del self._matches[match_id]
            return True
        return False

    async def step(self, match_id: str) -> StepResult:
        """
        Thực hiện 1 nước đi trong trận đấu:
        1. Lấy observation hiện tại
        2. Gọi agent tương ứng qua Judge0
        3. Áp dụng nước đi vào engine
        4. Trả về kết quả
        """
        match = self.get_match(match_id)
        if not match:
            return StepResult(
                match_id=match_id,
                step_number=0,
                player=0,
                game_over=False,
                error=f"Không tìm thấy trận đấu {match_id}",
            )

        if match.engine.state.game_over:
            state = match.engine.state
            return StepResult(
                match_id=match_id,
                step_number=state.move_count,
                player=state.current_turn,
                game_over=True,
                winner=state.winner,
                win_reason=state.win_reason,
                error="Trận đấu đã kết thúc.",
            )

        if match.engine.state.move_count >= match.max_moves:
            match.engine.state.game_over = True
            match.engine.state.win_reason = f"Đạt giới hạn {match.max_moves} nước."
            match.status = MatchStatus.FINISHED
            match.finished_at = datetime.utcnow()
            return StepResult(
                match_id=match_id,
                step_number=match.engine.state.move_count,
                player=match.engine.state.current_turn,
                game_over=True,
                winner=None,
                win_reason=match.engine.state.win_reason,
                error="Đạt giới hạn số nước.",
            )

        current_player = match.engine.state.current_turn
        agent_code = match.agent1_code if current_player == 1 else match.agent2_code
        observation = match.engine.get_observation()
        step_number = match.engine.state.move_count + 1

        # Gọi Judge0 thực thi agent
        exec_result = await self._judge0.execute_agent(
            agent_code=agent_code,
            observation=observation,
        )

        agent_stdout = exec_result.get("stdout", "")

        if not exec_result["success"] or exec_result["move"] is None:
            error_msg = exec_result.get("error") or "Agent không trả về nước đi."
            logger.warning(f"Match {match_id} step {step_number}: agent P{current_player} error: {error_msg}")
            # Agent lỗi → người kia thắng
            match.engine.state.game_over = True
            match.engine.state.winner = 2 if current_player == 1 else 1
            match.engine.state.win_reason = f"Agent P{current_player} lỗi: {error_msg}"
            match.status = MatchStatus.FINISHED
            match.finished_at = datetime.utcnow()
            return StepResult(
                match_id=match_id,
                step_number=step_number,
                player=current_player,
                game_over=True,
                winner=match.engine.state.winner,
                win_reason=match.engine.state.win_reason,
                error=error_msg,
                agent_stdout=agent_stdout,
            )

        # Áp dụng nước đi
        move_data = exec_result["move"]
        move = Move(
            from_col=move_data["from_col"],
            from_row=move_data["from_row"],
            to_col=move_data["to_col"],
            to_row=move_data["to_row"],
        )

        apply_result = match.engine.apply_move(move)

        if not apply_result["success"]:
            error_msg = apply_result.get("error") or "Nước đi không hợp lệ."
            logger.warning(f"Match {match_id} step {step_number}: invalid move by P{current_player}: {error_msg}")
            # Nước đi không hợp lệ → người kia thắng
            match.engine.state.game_over = True
            match.engine.state.winner = 2 if current_player == 1 else 1
            match.engine.state.win_reason = f"Agent P{current_player} đi nước không hợp lệ: {error_msg}"
            match.status = MatchStatus.FINISHED
            match.finished_at = datetime.utcnow()
            return StepResult(
                match_id=match_id,
                step_number=step_number,
                player=current_player,
                game_over=True,
                winner=match.engine.state.winner,
                win_reason=match.engine.state.win_reason,
                error=error_msg,
                agent_stdout=agent_stdout,
            )

        # Kết thúc hòa ngay sau nước cuối, nhưng giữ kết quả thắng của engine.
        if not apply_result["game_over"] and match.engine.state.move_count >= match.max_moves:
            match.engine.state.game_over = True
            match.engine.state.win_reason = f"Đạt giới hạn {match.max_moves} nước."
            apply_result["game_over"] = True
            apply_result["win_reason"] = match.engine.state.win_reason

        # Nước đi hợp lệ
        if apply_result["game_over"]:
            match.status = MatchStatus.FINISHED
            match.finished_at = datetime.utcnow()

        from ..engine.game import COLS, ROWS
        move_info = MoveInfo(
            from_col=move.from_col,
            from_row=move.from_row,
            to_col=move.to_col,
            to_row=move.to_row,
            from_pos=f"{COLS[move.from_col]}{ROWS[move.from_row]}",
            to_pos=f"{COLS[move.to_col]}{ROWS[move.to_row]}",
        )

        captured_raw = apply_result.get("captured")
        captured_info = None
        if captured_raw:
            from ..models import PieceInfo
            captured_info = PieceInfo(
                player=captured_raw["player"],
                type=captured_raw["type"],
            )

        return StepResult(
            match_id=match_id,
            step_number=step_number,
            player=current_player,
            move=move_info,
            captured=captured_info,
            game_over=apply_result["game_over"],
            winner=apply_result.get("winner"),
            win_reason=apply_result.get("win_reason", ""),
            error=None,
            agent_stdout=agent_stdout,
        )

    async def run_to_end(self, match_id: str) -> dict:
        """
        Chạy trận đấu đến khi kết thúc.
        Trả về danh sách tất cả StepResult.
        """
        match = self.get_match(match_id)
        if not match:
            return {
                "match_id": match_id,
                "total_moves": 0,
                "game_over": False,
                "winner": None,
                "win_reason": "",
                "steps": [],
                "aborted_reason": f"Không tìm thấy trận đấu {match_id}",
            }

        steps = []
        while not match.engine.state.game_over:
            step_result = await self.step(match_id)
            steps.append(step_result)
            if step_result.game_over:
                break
            if match.engine.state.move_count >= match.max_moves:
                break

        state = match.engine.state
        return {
            "match_id": match_id,
            "total_moves": state.move_count,
            "game_over": state.game_over,
            "winner": state.winner,
            "win_reason": state.win_reason,
            "steps": steps,
            "aborted_reason": None,
        }


# Singleton instance
_match_service: Optional[MatchService] = None


def get_match_service() -> MatchService:
    global _match_service
    if _match_service is None:
        _match_service = MatchService()
    return _match_service
