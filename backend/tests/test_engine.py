"""
Unit tests cho OTTv2 Game Engine.
Kiểm thử toàn bộ luật chơi dựa trên game.js.

Chạy: pytest tests/test_engine.py -v
"""

import pytest
from app.engine.game import (
    OTTGameEngine, Move, Piece, GameState, COLS, ROWS, PIECE_BEATS
)


class TestBoardInitialization:
    """Kiểm thử khởi tạo bàn cờ đúng theo game.js initBoard()."""

    def setup_method(self):
        self.engine = OTTGameEngine()
        self.board = self.engine.state.board

    def _piece_at(self, col: int, row: int):
        return self.board[row][col]

    def test_board_size(self):
        assert len(self.board) == 9
        for row in self.board:
            assert len(row) == 9

    def test_initial_turn(self):
        assert self.engine.state.current_turn == 1

    def test_game_not_over(self):
        assert self.engine.state.game_over is False

    # Player 1 - SCISSORS: 5c, 4d, 3e
    def test_p1_scissors_5c(self):
        # 5c: col=c(2), row=5-1=4
        p = self._piece_at(2, 4)
        assert p is not None
        assert p.player == 1
        assert p.type == "SCISSORS"

    def test_p1_scissors_4d(self):
        p = self._piece_at(3, 3)
        assert p is not None and p.player == 1 and p.type == "SCISSORS"

    def test_p1_scissors_3e(self):
        p = self._piece_at(4, 2)
        assert p is not None and p.player == 1 and p.type == "SCISSORS"

    # Player 1 - PAPER: 5b, 4c, 3d, 2e
    def test_p1_paper_5b(self):
        p = self._piece_at(1, 4)
        assert p is not None and p.player == 1 and p.type == "PAPER"

    def test_p1_paper_4c(self):
        p = self._piece_at(2, 3)
        assert p is not None and p.player == 1 and p.type == "PAPER"

    def test_p1_paper_3d(self):
        p = self._piece_at(3, 2)
        assert p is not None and p.player == 1 and p.type == "PAPER"

    def test_p1_paper_2e(self):
        p = self._piece_at(4, 1)
        assert p is not None and p.player == 1 and p.type == "PAPER"

    # Player 1 - ROCK: 4b, 3c, 2d
    def test_p1_rock_4b(self):
        p = self._piece_at(1, 3)
        assert p is not None and p.player == 1 and p.type == "ROCK"

    def test_p1_rock_3c(self):
        p = self._piece_at(2, 2)
        assert p is not None and p.player == 1 and p.type == "ROCK"

    def test_p1_rock_2d(self):
        p = self._piece_at(3, 1)
        assert p is not None and p.player == 1 and p.type == "ROCK"

    # Player 2 - SCISSORS: 7e, 6f, 5g
    def test_p2_scissors_7e(self):
        p = self._piece_at(4, 6)
        assert p is not None and p.player == 2 and p.type == "SCISSORS"

    def test_p2_scissors_6f(self):
        p = self._piece_at(5, 5)
        assert p is not None and p.player == 2 and p.type == "SCISSORS"

    def test_p2_scissors_5g(self):
        p = self._piece_at(6, 4)
        assert p is not None and p.player == 2 and p.type == "SCISSORS"

    # Player 2 - PAPER: 8e, 7f, 6g, 5h
    def test_p2_paper_8e(self):
        p = self._piece_at(4, 7)
        assert p is not None and p.player == 2 and p.type == "PAPER"

    def test_p2_paper_7f(self):
        p = self._piece_at(5, 6)
        assert p is not None and p.player == 2 and p.type == "PAPER"

    def test_p2_paper_6g(self):
        p = self._piece_at(6, 5)
        assert p is not None and p.player == 2 and p.type == "PAPER"

    def test_p2_paper_5h(self):
        p = self._piece_at(7, 4)
        assert p is not None and p.player == 2 and p.type == "PAPER"

    # Player 2 - ROCK: 8f, 7g, 6h
    def test_p2_rock_8f(self):
        p = self._piece_at(5, 7)
        assert p is not None and p.player == 2 and p.type == "ROCK"

    def test_p2_rock_7g(self):
        p = self._piece_at(6, 6)
        assert p is not None and p.player == 2 and p.type == "ROCK"

    def test_p2_rock_6h(self):
        p = self._piece_at(7, 5)
        assert p is not None and p.player == 2 and p.type == "ROCK"

    def test_total_pieces_player1(self):
        counts = self.engine.state.get_piece_counts()
        assert counts[1]["SCISSORS"] == 3
        assert counts[1]["PAPER"] == 4
        assert counts[1]["ROCK"] == 3

    def test_total_pieces_player2(self):
        counts = self.engine.state.get_piece_counts()
        assert counts[2]["SCISSORS"] == 3
        assert counts[2]["PAPER"] == 4
        assert counts[2]["ROCK"] == 3

    def test_a1_empty(self):
        # a1 = căn cứ P1, ban đầu trống
        assert self._piece_at(0, 0) is None

    def test_i9_empty(self):
        # i9 = căn cứ P2, ban đầu trống
        assert self._piece_at(8, 8) is None


class TestCaptureRules:
    """Kiểm thử luật ăn quân từ game.js canCapture()."""

    def setup_method(self):
        self.engine = OTTGameEngine()

    def test_rock_beats_scissors(self):
        assert self.engine.can_capture("ROCK", "SCISSORS") is True

    def test_paper_beats_rock(self):
        assert self.engine.can_capture("PAPER", "ROCK") is True

    def test_scissors_beats_paper(self):
        assert self.engine.can_capture("SCISSORS", "PAPER") is True

    def test_scissors_loses_to_rock(self):
        assert self.engine.can_capture("SCISSORS", "ROCK") is False

    def test_rock_loses_to_paper(self):
        assert self.engine.can_capture("ROCK", "PAPER") is False

    def test_paper_loses_to_scissors(self):
        assert self.engine.can_capture("PAPER", "SCISSORS") is False

    def test_same_type_cannot_capture_rock(self):
        assert self.engine.can_capture("ROCK", "ROCK") is False

    def test_same_type_cannot_capture_paper(self):
        assert self.engine.can_capture("PAPER", "PAPER") is False

    def test_same_type_cannot_capture_scissors(self):
        assert self.engine.can_capture("SCISSORS", "SCISSORS") is False

    def test_piece_beats_dict(self):
        assert PIECE_BEATS["ROCK"] == "SCISSORS"
        assert PIECE_BEATS["PAPER"] == "ROCK"
        assert PIECE_BEATS["SCISSORS"] == "PAPER"


class TestMovement:
    """Kiểm thử di chuyển kiểu Vua."""

    def _make_engine_with_piece(self, player: int, piece_type: str, col: int, row: int):
        """Tạo engine với 1 quân đơn trên bàn trống."""
        engine = OTTGameEngine()
        engine.state.board = [[None]*9 for _ in range(9)]
        engine.state.board[row][col] = Piece(player=player, type=piece_type)
        engine.state.current_turn = player
        return engine

    def test_piece_can_move_8_directions_from_center(self):
        engine = self._make_engine_with_piece(1, "ROCK", 4, 4)
        moves = engine.get_valid_moves_for_piece(4, 4)
        assert len(moves) == 8

    def test_piece_at_corner_has_3_moves(self):
        engine = self._make_engine_with_piece(1, "ROCK", 0, 0)
        moves = engine.get_valid_moves_for_piece(0, 0)
        assert len(moves) == 3

    def test_piece_at_edge_has_5_moves(self):
        engine = self._make_engine_with_piece(1, "ROCK", 0, 4)
        moves = engine.get_valid_moves_for_piece(0, 4)
        assert len(moves) == 5

    def test_cannot_move_to_friendly_cell(self):
        engine = OTTGameEngine()
        # P1 ROCK tại 3c (col=2,row=2), P1 PAPER tại 4c (col=2,row=3)
        # Kiểm tra PAPER không thể đi vào ô của ROCK
        moves = engine.get_valid_moves_for_piece(2, 3)  # P1 PAPER at 4c
        move_positions = [(m["col"], m["row"]) for m in moves]
        assert (2, 2) not in move_positions  # Không ăn được P1 ROCK

    def test_can_capture_enemy(self):
        engine = OTTGameEngine()
        engine.state.board = [[None]*9 for _ in range(9)]
        engine.state.board[4][4] = Piece(player=1, type="ROCK")
        engine.state.board[5][5] = Piece(player=2, type="SCISSORS")  # ROCK ăn SCISSORS
        engine.state.current_turn = 1
        moves = engine.get_valid_moves_for_piece(4, 4)
        capture_moves = [m for m in moves if m["is_capture"]]
        assert any(m["col"] == 5 and m["row"] == 5 for m in capture_moves)

    def test_cannot_capture_stronger_enemy(self):
        engine = OTTGameEngine()
        engine.state.board = [[None]*9 for _ in range(9)]
        engine.state.board[4][4] = Piece(player=1, type="ROCK")
        engine.state.board[5][5] = Piece(player=2, type="PAPER")  # PAPER thắng ROCK
        engine.state.current_turn = 1
        moves = engine.get_valid_moves_for_piece(4, 4)
        assert not any(m["col"] == 5 and m["row"] == 5 for m in moves)


class TestApplyMove:

    @pytest.mark.parametrize("coordinate", [-100, -1, 9, 100, None, "1", 1.5, True])
    @pytest.mark.parametrize("field", ["from_col", "from_row", "to_col", "to_row"])
    def test_bad_coordinates_do_not_crash_or_mutate_board(self, field, coordinate):
        engine = OTTGameEngine()
        before = engine.get_state_dict()
        coords = dict(from_col=1, from_row=3, to_col=0, to_row=3)
        coords[field] = coordinate
        result = engine.apply_move(Move(**coords))
        assert result["success"] is False
        assert engine.get_state_dict() == before
    """Kiểm thử thực hiện nước đi."""

    def test_simple_move_success(self):
        engine = OTTGameEngine()
        # P1 PAPER tại 4c (col=2, row=3) di chuyển lên 5c (col=2, row=4)
        # Nhưng 5c đã có P1 SCISSORS → dùng ô khác
        # P1 ROCK tại 4b (col=1, row=3) di chuyển sang 4a (col=0, row=3)
        result = engine.apply_move(Move(from_col=1, from_row=3, to_col=0, to_row=3))
        assert result["success"] is True
        assert engine.state.board[3][0] is not None
        assert engine.state.board[3][0].type == "ROCK"
        assert engine.state.board[3][1] is None

    def test_turn_switches_after_move(self):
        engine = OTTGameEngine()
        engine.apply_move(Move(from_col=1, from_row=3, to_col=0, to_row=3))
        assert engine.state.current_turn == 2

    def test_wrong_turn_fails(self):
        engine = OTTGameEngine()
        # P2 cố đi trước khi đến lượt
        result = engine.apply_move(Move(from_col=4, from_row=6, to_col=4, to_row=5))
        assert result["success"] is False
        assert "lượt" in result["error"]

    def test_invalid_destination_fails(self):
        engine = OTTGameEngine()
        # P1 ROCK tại 4b (1,3) không thể nhảy 2 ô
        result = engine.apply_move(Move(from_col=1, from_row=3, to_col=3, to_row=3))
        assert result["success"] is False

    def test_empty_source_fails(self):
        engine = OTTGameEngine()
        result = engine.apply_move(Move(from_col=5, from_row=5, to_col=6, to_row=6))
        assert result["success"] is False

    def test_capture_removes_enemy(self):
        engine = OTTGameEngine()
        engine.state.board = [[None]*9 for _ in range(9)]
        engine.state.board[4][4] = Piece(player=1, type="ROCK")
        engine.state.board[5][5] = Piece(player=2, type="SCISSORS")
        engine.state.current_turn = 1
        result = engine.apply_move(Move(from_col=4, from_row=4, to_col=5, to_row=5))
        assert result["success"] is True
        assert result["captured"] is not None
        assert result["captured"]["type"] == "SCISSORS"
        assert engine.state.board[5][5].player == 1

    def test_history_records_move(self):
        engine = OTTGameEngine()
        engine.apply_move(Move(from_col=1, from_row=3, to_col=0, to_row=3))
        assert len(engine.state.history) == 1
        entry = engine.state.history[0]
        assert entry["from_col"] == 1 and entry["from_row"] == 3

    def test_move_count_increments(self):
        engine = OTTGameEngine()
        assert engine.state.move_count == 0
        engine.apply_move(Move(from_col=1, from_row=3, to_col=0, to_row=3))
        assert engine.state.move_count == 1


class TestWinConditions:
    """Kiểm thử điều kiện thắng."""

    def _empty_engine(self, player_turn=1):
        engine = OTTGameEngine()
        engine.state.board = [[None]*9 for _ in range(9)]
        engine.state.current_turn = player_turn
        return engine

    def test_p1_wins_reaching_i9(self):
        """P1 đưa quân về i9 (col=8, row=8) → P1 thắng."""
        engine = self._empty_engine(1)
        engine.state.board[7][8] = Piece(player=1, type="ROCK")
        # Cần P2 có đủ quân để không trigger win condition khác
        engine.state.board[0][0] = Piece(player=2, type="ROCK")
        engine.state.board[0][1] = Piece(player=2, type="PAPER")
        engine.state.board[0][2] = Piece(player=2, type="SCISSORS")
        result = engine.apply_move(Move(from_col=8, from_row=7, to_col=8, to_row=8))
        assert result["success"] is True
        assert result["game_over"] is True
        assert result["winner"] == 1

    def test_p2_wins_reaching_a1(self):
        """P2 đưa quân về a1 (col=0, row=0) → P2 thắng."""
        engine = self._empty_engine(2)
        engine.state.board[1][0] = Piece(player=2, type="ROCK")
        # P1 cần đủ quân
        engine.state.board[8][8] = Piece(player=1, type="ROCK")
        engine.state.board[8][7] = Piece(player=1, type="PAPER")
        engine.state.board[8][6] = Piece(player=1, type="SCISSORS")
        result = engine.apply_move(Move(from_col=0, from_row=1, to_col=0, to_row=0))
        assert result["success"] is True
        assert result["game_over"] is True
        assert result["winner"] == 2

    def test_p1_wins_eliminating_all_p2_rock(self):
        """P1 tiêu diệt hết ROCK của P2 → P1 thắng."""
        engine = self._empty_engine(1)
        # P1 PAPER tại (0,0), P2 ROCK duy nhất tại (1,1)
        engine.state.board[0][0] = Piece(player=1, type="PAPER")
        engine.state.board[1][1] = Piece(player=2, type="ROCK")
        # P2 còn PAPER và SCISSORS (chưa bị diệt)
        engine.state.board[8][8] = Piece(player=2, type="PAPER")
        engine.state.board[8][7] = Piece(player=2, type="SCISSORS")
        # P1 cần đủ quân
        engine.state.board[8][6] = Piece(player=1, type="ROCK")
        engine.state.board[8][5] = Piece(player=1, type="SCISSORS")
        result = engine.apply_move(Move(from_col=0, from_row=0, to_col=1, to_row=1))
        assert result["success"] is True
        assert result["game_over"] is True
        assert result["winner"] == 1

    def test_p2_wins_eliminating_all_p1_scissors(self):
        """P2 tiêu diệt hết SCISSORS của P1 → P2 thắng."""
        engine = self._empty_engine(2)
        engine.state.board[0][0] = Piece(player=2, type="ROCK")
        engine.state.board[1][1] = Piece(player=1, type="SCISSORS")  # SCISSORS duy nhất
        engine.state.board[8][8] = Piece(player=1, type="ROCK")
        engine.state.board[8][7] = Piece(player=1, type="PAPER")
        engine.state.board[8][6] = Piece(player=2, type="PAPER")
        engine.state.board[8][5] = Piece(player=2, type="SCISSORS")
        result = engine.apply_move(Move(from_col=0, from_row=0, to_col=1, to_row=1))
        assert result["success"] is True
        assert result["game_over"] is True
        assert result["winner"] == 2

    def test_game_not_over_without_win_condition(self):
        """Nước đi bình thường không kết thúc game."""
        engine = OTTGameEngine()
        result = engine.apply_move(Move(from_col=1, from_row=3, to_col=0, to_row=3))
        assert result["success"] is True
        assert result["game_over"] is False
        assert result["winner"] is None

    def test_cannot_move_after_game_over(self):
        engine = self._empty_engine(1)
        engine.state.board[7][8] = Piece(player=1, type="ROCK")
        engine.state.board[0][0] = Piece(player=2, type="ROCK")
        engine.state.board[0][1] = Piece(player=2, type="PAPER")
        engine.state.board[0][2] = Piece(player=2, type="SCISSORS")
        engine.apply_move(Move(from_col=8, from_row=7, to_col=8, to_row=8))
        assert engine.state.game_over is True
        result = engine.apply_move(Move(from_col=0, from_row=0, to_col=0, to_row=1))
        assert result["success"] is False


class TestObservation:
    """Kiểm thử get_observation() cho agent."""

    def test_observation_has_required_keys(self):
        engine = OTTGameEngine()
        obs = engine.get_observation()
        assert "board" in obs
        assert "board_2d" in obs
        assert "current_player" in obs
        assert "valid_moves" in obs
        assert "piece_counts" in obs
        assert "move_count" in obs

    def test_observation_board_length(self):
        engine = OTTGameEngine()
        obs = engine.get_observation()
        assert len(obs["board"]) == 81

    def test_observation_valid_moves_not_empty(self):
        engine = OTTGameEngine()
        obs = engine.get_observation()
        assert len(obs["valid_moves"]) > 0

    def test_observation_current_player(self):
        engine = OTTGameEngine()
        assert engine.get_observation()["current_player"] == 1
        engine.apply_move(Move(from_col=1, from_row=3, to_col=0, to_row=3))
        assert engine.get_observation()["current_player"] == 2

    def test_valid_moves_format(self):
        engine = OTTGameEngine()
        moves = engine.get_observation()["valid_moves"]
        for m in moves:
            assert "from_col" in m
            assert "from_row" in m
            assert "to_col" in m
            assert "to_row" in m
            assert "is_capture" in m


class TestSerialization:
    """Kiểm thử serialize/deserialize state."""

    def test_state_to_dict_from_dict_roundtrip(self):
        engine = OTTGameEngine()
        # Di chuyển vài nước
        engine.apply_move(Move(from_col=1, from_row=3, to_col=0, to_row=3))
        engine.apply_move(Move(from_col=4, from_row=6, to_col=4, to_row=5))

        state_dict = engine.get_state_dict()
        engine2 = OTTGameEngine.from_state(state_dict)

        assert engine2.state.current_turn == engine.state.current_turn
        assert engine2.state.move_count == engine.state.move_count
        assert engine2.state.game_over == engine.state.game_over

        # So sánh board
        for r in range(9):
            for c in range(9):
                p1 = engine.state.board[r][c]
                p2 = engine2.state.board[r][c]
                if p1 is None:
                    assert p2 is None
                else:
                    assert p2 is not None
                    assert p1.player == p2.player
                    assert p1.type == p2.type
