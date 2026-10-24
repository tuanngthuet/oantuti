"""
Greedy Agent - Agent tham lam, ưu tiên:
1. Tiến về căn cứ đối phương (i9 cho P1, a1 cho P2)
2. Ăn quân đối thủ (đặc biệt khi sắp diệt hết 1 loại)
3. Tránh ô bị tấn công

Tương tự logic AI trong game.js makeAIMove().
"""

import random
import math


def agent(observation, configuration):
    """
    Agent tham lam với scoring function.

    Điểm số nước đi:
    - Về căn cứ: +100000 (thắng ngay)
    - Ăn quân sắp diệt loại: +50000
    - Ăn quân bình thường: +120
    - Tiến về phía căn cứ: +15 mỗi đơn vị khoảng cách giảm
    - Ô bị tấn công: -80
    - Nhiễu ngẫu nhiên nhỏ: +[0,5)
    """
    moves = observation.get("valid_moves", [])
    if not moves:
        return None

    current_player = observation.get("current_player", 1)
    board = observation.get("board", [])   # List[81]
    piece_counts = observation.get("piece_counts", {})

    # Target base: P1 → i9=(8,8), P2 → a1=(0,0)
    target_col = 8 if current_player == 1 else 0
    target_row = 8 if current_player == 1 else 0
    opponent = 2 if current_player == 1 else 1

    def get_cell(col, row):
        """Lấy piece tại (col, row) từ board phẳng."""
        if 0 <= col < 9 and 0 <= row < 9:
            return board[row * 9 + col]
        return None

    BEATS = {"ROCK": "SCISSORS", "PAPER": "ROCK", "SCISSORS": "PAPER"}

    def can_capture(attacker_type, defender_type):
        if attacker_type == defender_type:
            return False
        return BEATS.get(attacker_type) == defender_type

    # 8 hướng
    DIRECTIONS = [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]

    def score_move(move):
        fc, fr = move["from_col"], move["from_row"]
        tc, tr = move["to_col"], move["to_row"]
        is_capture = move.get("is_capture", False)
        piece = get_cell(fc, fr)

        s = 0.0

        # Điều kiện thắng ngay
        if current_player == 1 and tc == 8 and tr == 8:
            s += 100000
        if current_player == 2 and tc == 0 and tr == 0:
            s += 100000

        # Ăn quân
        if is_capture:
            s += 120
            target_piece = get_cell(tc, tr)
            if target_piece:
                # Kiểm tra sắp diệt hết 1 loại
                opp_counts = piece_counts.get(str(opponent), piece_counts.get(opponent, {}))
                remaining = opp_counts.get(target_piece["type"], 0)
                if remaining == 1:
                    s += 50000  # Diệt hết loại → thắng

        # Tiến về căn cứ
        current_dist = math.hypot(fc - target_col, fr - target_row)
        new_dist = math.hypot(tc - target_col, tr - target_row)
        s += (current_dist - new_dist) * 15

        # Tránh ô bị tấn công
        if piece:
            piece_type = piece["type"]
            for dc, dr in DIRECTIONS:
                nc, nr = tc + dc, tr + dr
                neighbor = get_cell(nc, nr)
                if neighbor and neighbor["player"] == opponent:
                    if can_capture(neighbor["type"], piece_type):
                        s -= 80
                        break

        # Nhiễu nhỏ để tránh lặp
        s += random.random() * 5

        return s

    best_move = max(moves, key=score_move)
    return {
        "from_col": best_move["from_col"],
        "from_row": best_move["from_row"],
        "to_col": best_move["to_col"],
        "to_row": best_move["to_row"],
    }
