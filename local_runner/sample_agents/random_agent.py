"""
Random Agent - Nước đi ngẫu nhiên hợp lệ
"""

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
        "to_row": move["to_row"]
    }
