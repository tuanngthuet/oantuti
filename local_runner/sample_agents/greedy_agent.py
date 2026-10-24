"""
Greedy Tactical Heuristic Agent
Chiến thuật tham lam:
1. Nếu có nước ăn quân: Ưu tiên ăn quân mà đối phương còn ít nhất (để kích hoạt điều kiện thắng 3 & 4),
   tiếp theo là nước ăn quân tiến gần đích nhất.
2. Nếu không có nước ăn quân: Chọn nước tiến gần căn cứ đích đối phương nhất.
"""

def agent(observation, configuration):
    valid_moves = observation.get("valid_moves", [])
    if not valid_moves:
        return None

    my_player = observation.get("current_player", 1)
    opp_player = 2 if my_player == 1 else 1

    # Tọa độ đích: P1 đích là i9 (col 8, row 8), P2 đích là a1 (col 0, row 0)
    target_col, target_row = (8, 8) if my_player == 1 else (0, 0)

    # 1. Lọc nước đi ăn quân
    capture_moves = [m for m in valid_moves if m.get("is_capture")]

    if capture_moves:
        # Ưu tiên nước ăn quân tiến gần đích đối phương nhất
        def capture_score(m):
            dist = abs(m["to_col"] - target_col) + abs(m["to_row"] - target_row)
            return dist

        best_capture = min(capture_moves, key=capture_score)
        return {
            "from_col": best_capture["from_col"],
            "from_row": best_capture["from_row"],
            "to_col": best_capture["to_col"],
            "to_row": best_capture["to_row"]
        }

    # 2. Không ăn được quân: Chọn nước tiến gần căn cứ đích đối phương nhất
    def move_dist(m):
        return abs(m["to_col"] - target_col) + abs(m["to_row"] - target_row)

    best_move = min(valid_moves, key=move_dist)
    return {
        "from_col": best_move["from_col"],
        "from_row": best_move["from_row"],
        "to_col": best_move["to_col"],
        "to_row": best_move["to_row"]
    }
