"""
OTTv2 Game Engine - Standalone Local Runner
Phiên bản Engine độc lập dành cho thí sinh tự kiểm thử và debug Agent trên máy cá nhân.
Không yêu cầu bất kỳ thư viện bên ngoài nào (Zero dependencies - Pure Python 3.8+).

Quy tắc:
- Bàn cờ 9x9: cột a-i (index 0-8), hàng 1-9 (index 0-8)
- 3 loại quân: ROCK (✊ Đấm), PAPER (✋ Lá), SCISSORS (✌️ Kéo)
  - ROCK thắng SCISSORS, PAPER thắng ROCK, SCISSORS thắng PAPER
- Di chuyển kiểu Vua cờ vua: 8 hướng, mỗi bước 1 ô
- Điều kiện thắng:
  1. P1 (Xanh) đưa quân chiếm căn cứ i9 (col=8, row=8)
  2. P2 (Đỏ) đưa quân chiếm căn cứ a1 (col=0, row=0)
  3. P1 tiêu diệt hết 1 loại quân của P2
  4. P2 tiêu diệt hết 1 loại quân của P1
- Hòa sau tối đa 200 nước
"""

import copy
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any, Tuple

# Quan hệ tương khắc Oẳn Tù Tì
PIECE_BEATS = {
    "ROCK": "SCISSORS",
    "PAPER": "ROCK",
    "SCISSORS": "PAPER",
}

PIECE_ICONS = {
    "ROCK": "✊",
    "PAPER": "✋",
    "SCISSORS": "✌️",
}

PIECE_SHORT = {
    "ROCK": "R",
    "PAPER": "P",
    "SCISSORS": "S",
}

PIECE_TYPES = {"ROCK", "PAPER", "SCISSORS"}

COLS = list("abcdefghi")  # index 0-8
ROWS = list(range(1, 10))  # index 0-8 -> row 1-9

# 8 hướng di chuyển kiểu Vua
DIRECTIONS = [
    (-1, -1), (-1, 0), (-1, 1),
    (0, -1),           (0, 1),
    (1, -1),  (1, 0),  (1, 1),
]

MAX_PIECES = {"ROCK": 3, "PAPER": 4, "SCISSORS": 3}


@dataclass
class Piece:
    player: int   # 1 hoặc 2
    type: str     # "ROCK", "PAPER", "SCISSORS"

    def to_dict(self) -> dict:
        return {"player": self.player, "type": self.type}

    @classmethod
    def from_dict(cls, d: dict) -> "Piece":
        return cls(player=d["player"], type=d["type"])


@dataclass
class Move:
    from_col: int
    from_row: int
    to_col: int
    to_row: int

    def to_dict(self) -> dict:
        return {
            "from_col": self.from_col,
            "from_row": self.from_row,
            "to_col": self.to_col,
            "to_row": self.to_row,
            "from_pos": f"{COLS[self.from_col]}{ROWS[self.from_row]}",
            "to_pos": f"{COLS[self.to_col]}{ROWS[self.to_row]}",
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Move":
        return cls(
            from_col=d["from_col"],
            from_row=d["from_row"],
            to_col=d["to_col"],
            to_row=d["to_row"],
        )

    @classmethod
    def from_pos_string(cls, from_pos: str, to_pos: str) -> "Move":
        """Parse từ chuỗi như 'a1', 'b3'."""
        def parse(pos: str):
            pos = pos.strip().lower()
            col = ord(pos[0]) - ord('a')
            row = int(pos[1]) - 1
            return col, row
        fc, fr = parse(from_pos)
        tc, tr = parse(to_pos)
        return cls(from_col=fc, from_row=fr, to_col=tc, to_row=tr)


@dataclass
class HistoryEntry:
    from_col: int
    from_row: int
    to_col: int
    to_row: int
    piece: Piece
    captured: Optional[Piece]
    turn: int

    def to_dict(self) -> dict:
        return {
            "from_col": self.from_col,
            "from_row": self.from_row,
            "to_col": self.to_col,
            "to_row": self.to_row,
            "from_pos": f"{COLS[self.from_col]}{ROWS[self.from_row]}",
            "to_pos": f"{COLS[self.to_col]}{ROWS[self.to_row]}",
            "piece": self.piece.to_dict(),
            "captured": self.captured.to_dict() if self.captured else None,
            "turn": self.turn,
        }


@dataclass
class GameState:
    """Toàn bộ trạng thái trận đấu."""
    board: list = field(default_factory=lambda: [[None]*9 for _ in range(9)])
    current_turn: int = 1          # 1 hoặc 2
    game_over: bool = False
    winner: Optional[int] = None   # 1, 2 hoặc None
    win_reason: str = ""
    history: list = field(default_factory=list)
    move_count: int = 0

    def to_dict(self) -> dict:
        board_serialized = []
        for r in range(9):
            row = []
            for c in range(9):
                p = self.board[r][c]
                row.append(p.to_dict() if p else None)
            board_serialized.append(row)
        return {
            "board": board_serialized,
            "current_turn": self.current_turn,
            "game_over": self.game_over,
            "winner": self.winner,
            "win_reason": self.win_reason,
            "move_count": self.move_count,
            "history": self.history,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "GameState":
        state = cls()
        state.current_turn = d["current_turn"]
        state.game_over = d["game_over"]
        state.winner = d.get("winner")
        state.win_reason = d.get("win_reason", "")
        state.move_count = d.get("move_count", 0)
        state.history = d.get("history", [])
        board = [[None]*9 for _ in range(9)]
        for r in range(9):
            for c in range(9):
                p = d["board"][r][c]
                if p:
                    board[r][c] = Piece.from_dict(p)
        state.board = board
        return state

    def get_piece_counts(self) -> dict:
        """Số lượng từng loại quân còn lại trên bàn của mỗi người chơi."""
        counts = {
            1: {"ROCK": 0, "PAPER": 0, "SCISSORS": 0},
            2: {"ROCK": 0, "PAPER": 0, "SCISSORS": 0},
        }
        for r in range(9):
            for c in range(9):
                p = self.board[r][c]
                if p:
                    counts[p.player][p.type] += 1
        return counts

    def get_board_for_agent(self) -> list:
        """
        Trả về board dạng list phẳng 81 phần tử đúng chuẩn observation gửi cho Agent.
        Mỗi phần tử: None hoặc {"player": int, "type": str}
        Chỉ số index = row * 9 + col (row 0-8, col 0-8).
        """
        flat = []
        for r in range(9):
            for c in range(9):
                p = self.board[r][c]
                flat.append(p.to_dict() if p else None)
        return flat


class OTTGameEngine:
    """Game engine OTTv2 chuẩn xác từ máy chủ giải đấu."""

    def __init__(self):
        self.state = GameState()
        self._init_board()

    def _init_board(self):
        """Khởi tạo vị trí 10 quân mỗi bên trên bàn cờ 9x9."""
        board = [[None]*9 for _ in range(9)]

        def place_js(player: int, piece_type: str, pos: str):
            """pos format: '5c' = cột c (index 2), hàng 5 (index 4)"""
            col_char = None
            row_char = None
            for ch in pos:
                if ch.isalpha():
                    col_char = ch
                else:
                    row_char = ch
            col = ord(col_char.lower()) - ord('a')
            row = int(row_char) - 1
            board[row][col] = Piece(player=player, type=piece_type)

        # Player 1 (Blue) - Khởi đầu ở nửa dưới góc a1
        for pos in ['5c', '4d', '3e']:
            place_js(1, 'SCISSORS', pos)
        for pos in ['5b', '4c', '3d', '2e']:
            place_js(1, 'PAPER', pos)
        for pos in ['4b', '3c', '2d']:
            place_js(1, 'ROCK', pos)

        # Player 2 (Red) - Khởi đầu ở nửa trên góc i9 (đối xứng)
        for pos in ['7e', '6f', '5g']:
            place_js(2, 'SCISSORS', pos)
        for pos in ['8e', '7f', '6g', '5h']:
            place_js(2, 'PAPER', pos)
        for pos in ['8f', '7g', '6h']:
            place_js(2, 'ROCK', pos)

        self.state.board = board

    @classmethod
    def from_state(cls, state_dict: dict) -> "OTTGameEngine":
        engine = cls.__new__(cls)
        engine.state = GameState.from_dict(state_dict)
        return engine

    def can_capture(self, attacker_type: str, defender_type: str) -> bool:
        """Quy luật tương khắc: Đấm thắng Kéo, Lá thắng Đấm, Kéo thắng Lá. Cùng loại không ăn được nhau."""
        if attacker_type == defender_type:
            return False
        return PIECE_BEATS.get(attacker_type) == defender_type

    def get_valid_moves_for_piece(self, col: int, row: int) -> list:
        """Lấy các nước đi hợp lệ cho quân tại (col, row). Trả về list[{col, row, is_capture}]."""
        piece = self.state.board[row][col]
        if not piece:
            return []
        moves = []
        for dc, dr in DIRECTIONS:
            tc = col + dc
            tr = row + dr
            if 0 <= tc < 9 and 0 <= tr < 9:
                target = self.state.board[tr][tc]
                if target is None:
                    moves.append({"col": tc, "row": tr, "is_capture": False})
                elif target.player != piece.player:
                    if self.can_capture(piece.type, target.type):
                        moves.append({"col": tc, "row": tr, "is_capture": True})
        return moves

    def get_all_valid_moves(self, player: int) -> list:
        """
        Lấy tất cả nước đi hợp lệ của player.
        Trả về list[{from_col, from_row, to_col, to_row, is_capture}]
        """
        all_moves = []
        for r in range(9):
            for c in range(9):
                piece = self.state.board[r][c]
                if piece and piece.player == player:
                    moves = self.get_valid_moves_for_piece(c, r)
                    for m in moves:
                        all_moves.append({
                            "from_col": c,
                            "from_row": r,
                            "to_col": m["col"],
                            "to_row": m["row"],
                            "is_capture": m["is_capture"],
                        })
        return all_moves

    def check_win_condition(self, to_col: int, to_row: int, moved_piece: Piece) -> dict:
        """Kiểm tra 4 điều kiện chiến thắng."""
        # Điều kiện 1: P1 chiếm i9 (col=8, row=8)
        if moved_piece.player == 1 and to_col == 8 and to_row == 8:
            return {
                "won": True, "winner": 1,
                "reason": f"Người chơi 1 (Xanh) chiếm thành i9 thành công!"
            }

        # Điều kiện 2: P2 chiếm a1 (col=0, row=0)
        if moved_piece.player == 2 and to_col == 0 and to_row == 0:
            return {
                "won": True, "winner": 2,
                "reason": f"Người chơi 2 (Đỏ) chiếm thành a1 thành công!"
            }

        # Điều kiện 3 & 4: Tiêu diệt hết 1 loại quân của đối phương
        counts = self.state.get_piece_counts()

        # Kiểm tra P2 bị tiêu diệt hết 1 loại (P1 thắng)
        for piece_type, count in counts[2].items():
            if count == 0:
                return {
                    "won": True, "winner": 1,
                    "reason": f"Người chơi 1 đã ăn sạch toàn bộ quân {piece_type} của đối phương!"
                }

        # Kiểm tra P1 bị tiêu diệt hết 1 loại (P2 thắng)
        for piece_type, count in counts[1].items():
            if count == 0:
                return {
                    "won": True, "winner": 2,
                    "reason": f"Người chơi 2 đã ăn sạch toàn bộ quân {piece_type} của đối phương!"
                }

        return {"won": False, "winner": None, "reason": ""}

    def apply_move(self, move: Move) -> dict:
        """
        Thực hiện nước đi trên bàn cờ.
        Trả về dict kết quả: success, error, game_over, winner, win_reason, captured.
        """
        state = self.state

        if state.game_over:
            return {"success": False, "error": "Trận đấu đã kết thúc."}

        if any(type(value) is not int or not 0 <= value < 9 for value in (
            move.from_col, move.from_row, move.to_col, move.to_row
        )):
            return {"success": False, "error": "Tọa độ nước đi phải là số nguyên từ 0 đến 8."}

        piece = state.board[move.from_row][move.from_col]
        if not piece:
            return {
                "success": False,
                "error": f"Không có quân tại ô {COLS[move.from_col]}{ROWS[move.from_row]}."
            }

        if piece.player != state.current_turn:
            return {
                "success": False,
                "error": f"Không phải lượt của Người chơi {piece.player} (Lượt hiện tại: P{state.current_turn})."
            }

        valid_moves = self.get_valid_moves_for_piece(move.from_col, move.from_row)
        valid_target = next(
            (m for m in valid_moves if m["col"] == move.to_col and m["row"] == move.to_row),
            None
        )
        if not valid_target:
            return {
                "success": False,
                "error": f"Nước đi không hợp lệ: {COLS[move.from_col]}{ROWS[move.from_row]} -> {COLS[move.to_col]}{ROWS[move.to_row]}"
            }

        target = state.board[move.to_row][move.to_col]
        captured_piece = copy.copy(target) if target else None

        # Ghi lịch sử
        state.history.append(HistoryEntry(
            from_col=move.from_col,
            from_row=move.from_row,
            to_col=move.to_col,
            to_row=move.to_row,
            piece=copy.copy(piece),
            captured=captured_piece,
            turn=state.current_turn,
        ).to_dict())

        # Di chuyển quân
        state.board[move.to_row][move.to_col] = piece
        state.board[move.from_row][move.from_col] = None
        state.move_count += 1

        # Kiểm tra điều kiện thắng
        win_result = self.check_win_condition(move.to_col, move.to_row, piece)

        if win_result["won"]:
            state.game_over = True
            state.winner = win_result["winner"]
            state.win_reason = win_result["reason"]
            return {
                "success": True,
                "error": None,
                "game_over": True,
                "winner": win_result["winner"],
                "win_reason": win_result["reason"],
                "captured": captured_piece.to_dict() if captured_piece else None,
            }

        # Đổi lượt
        state.current_turn = 2 if state.current_turn == 1 else 1

        return {
            "success": True,
            "error": None,
            "game_over": False,
            "winner": None,
            "win_reason": "",
            "captured": captured_piece.to_dict() if captured_piece else None,
        }

    def get_observation(self) -> dict:
        """Tạo dữ liệu observation gửi vào hàm agent(observation, configuration)."""
        state = self.state
        return {
            "board": state.get_board_for_agent(),     # List[81]
            "board_2d": state.to_dict()["board"],     # List[9][9]
            "current_player": state.current_turn,     # 1 hoặc 2
            "valid_moves": self.get_all_valid_moves(state.current_turn),
            "piece_counts": state.get_piece_counts(),
            "move_count": state.move_count,
            "game_over": state.game_over,
        }

    def render_ascii(self, use_color: bool = True) -> str:
        """Vẽ bàn cờ trực quan ra Terminal."""
        # Mã màu ANSI
        BLUE = "\033[94m\033[1m" if use_color else ""
        RED = "\033[91m\033[1m" if use_color else ""
        GOLD = "\033[93m\033[1m" if use_color else ""
        RESET = "\033[0m" if use_color else ""
        DIM = "\033[2m" if use_color else ""

        lines = []
        lines.append(f"     " + "   ".join(COLS))
        lines.append(f"   +" + "---+" * 9)

        # In từ hàng 9 xuống hàng 1 (row index 8 -> 0)
        for r in range(8, -1, -1):
            row_num = r + 1
            row_str = f" {row_num} |"
            for c in range(9):
                p = self.state.board[r][c]
                is_p1_goal = (c == 8 and r == 8)
                is_p2_goal = (c == 0 and r == 0)

                if p:
                    color = BLUE if p.player == 1 else RED
                    icon = PIECE_SHORT[p.type]
                    # Icon + player id: e.g. R1, P2, S1
                    cell = f"{color}{icon}{p.player}{RESET}"
                elif is_p1_goal:
                    cell = f"{GOLD}★1{RESET}"  # Đích P1
                elif is_p2_goal:
                    cell = f"{GOLD}★2{RESET}"  # Đích P2
                else:
                    cell = f"{DIM} ·{RESET}"
                row_str += f"{cell} |"
            lines.append(row_str)
            lines.append(f"   +" + "---+" * 9)

        # Thông tin quân
        counts = self.state.get_piece_counts()
        lines.append(f"Player 1 (Xanh): ✊ {counts[1]['ROCK']}/3 | ✋ {counts[1]['PAPER']}/4 | ✌️ {counts[1]['SCISSORS']}/3  (Mục tiêu: i9 ★1)")
        lines.append(f"Player 2 (Đỏ)  : ✊ {counts[2]['ROCK']}/3 | ✋ {counts[2]['PAPER']}/4 | ✌️ {counts[2]['SCISSORS']}/3  (Mục tiêu: a1 ★2)")
        return "\n".join(lines)
