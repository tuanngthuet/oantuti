"""
OTTv2 Arena - Starter Agent Template
Mẫu bot cơ bản dành cho thí sinh bắt đầu phát triển chiến thuật.
"""

import random

def agent(observation, configuration):
    """
    Hàm chính xử lý nước đi của Agent.

    Tham số:
      - observation:
          - valid_moves: list[dict] -> Danh sách các nước đi hợp lệ ở lượt này.
              Mỗi phần tử: {"from_col": int, "from_row": int, "to_col": int, "to_row": int, "is_capture": bool}
          - board: list[81] -> Danh sách 81 ô bàn cờ (None hoặc {"player": 1|2, "type": "ROCK"|"PAPER"|"SCISSORS"})
          - current_player: int -> 1 (Đi trước, căn cứ a1, đích i9) hoặc 2 (Đi sau, căn cứ i9, đích a1)
          - piece_counts: dict -> Số lượng quân mỗi bên: {"1": {ROCK:n, PAPER:n, SCISSORS:n}, "2": {...}}
          - move_count: int -> Số nước đi đã diễn ra trong trận
      - configuration: dict -> Cấu hình trận đấu (nếu có)

    Trả về:
      dict: {"from_col": int, "from_row": int, "to_col": int, "to_row": int}
      hoặc tuple/list: (from_col, from_row, to_col, to_row)
      hoặc None (nếu đầu hàng / không còn nước đi)
    """
    valid_moves = observation.get("valid_moves", [])
    if not valid_moves:
        return None

    # TODO: Cài đặt thuật toán của bạn tại đây (Minimax, Alpha-Beta, MCTS, Heuristic...)
    
    # Mặc định: Chọn ngẫu nhiên 1 nước đi hợp lệ
    chosen = random.choice(valid_moves)
    return {
        "from_col": chosen["from_col"],
        "from_row": chosen["from_row"],
        "to_col": chosen["to_col"],
        "to_row": chosen["to_row"]
    }
