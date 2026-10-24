"""Read fixtures JSON on stdin; exercise every agent against the real regular engine."""
import copy
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from worker.game_engine import OTTGameEngine, Move

fixtures = json.load(sys.stdin)
maximum = 0
total_moves = 0
for fixture in fixtures["agents"]:
    scope = {}
    exec(compile(fixture["code"], fixture["agent_name"], "exec"), scope)
    select = scope["agent"]
    assert select({"valid_moves": [], "current_player": 1}, {}) is None
    engine = OTTGameEngine()
    positions = {}
    for ply in range(60):
        observation = engine.get_observation()
        if observation["game_over"] or not observation["valid_moves"]:
            break
        before = copy.deepcopy(observation)
        start = time.monotonic()
        move = select(observation, {})
        elapsed = time.monotonic() - start
        maximum = max(maximum, elapsed)
        assert elapsed < 1.0, (fixture["agent_name"], elapsed)
        assert observation == before, "Agent mutated observation"
        assert any(all(move.get(key) == legal[key] for key in ("from_col", "from_row", "to_col", "to_row"))
                   for legal in observation["valid_moves"]), (fixture["agent_name"], move)
        result = engine.apply_move(Move.from_dict(move))
        assert result.get("success"), result
        total_moves += 1
        key = json.dumps([engine.state.current_turn, engine.get_observation()["board"]], sort_keys=True)
        positions[key] = positions.get(key, 0) + 1
        if positions[key] >= 3:
            break
print(json.dumps({"passed": True, "agents": len(fixtures["agents"]), "legalMovesPlayed": total_moves, "maxDecisionSeconds": round(maximum, 4)}))
