"""Bounded beam alpha-beta search. Standalone Judge0 submission; no project imports."""
import time

SEED = 1
LEVEL = 3
BEATS = {"ROCK": "SCISSORS", "PAPER": "ROCK", "SCISSORS": "PAPER"}
DIRECTIONS = [(x, y) for x in (-1, 0, 1) for y in (-1, 0, 1) if x or y]


def agent(observation, configuration):
    legal = observation.get("valid_moves", [])
    if not legal:
        return None
    board = list(observation["board"])
    root = observation["current_player"]
    deadline = time.monotonic() + 0.07
    nodes = [0]
    cache = {}

    def moves(state, side):
        result = []
        for i, piece in enumerate(state):
            if not piece or piece["player"] != side:
                continue
            x, y = i % 9, i // 9
            for dx, dy in DIRECTIONS:
                tx, ty = x + dx, y + dy
                if not (0 <= tx < 9 and 0 <= ty < 9):
                    continue
                j = ty * 9 + tx
                target = state[j]
                if target is None or (target["player"] != side and BEATS[piece["type"]] == target["type"]):
                    result.append((i, j))
        return result

    def apply(state, move):
        copied = state[:]
        copied[move[1]], copied[move[0]] = copied[move[0]], None
        return copied

    def winner(state):
        if state[80] and state[80]["player"] == 1:
            return 1
        if state[0] and state[0]["player"] == 2:
            return 2
        counts = {1: set(), 2: set()}
        for piece in state:
            if piece:
                counts[piece["player"]].add(piece["type"])
        if len(counts[2]) < 3:
            return 1
        if len(counts[1]) < 3:
            return 2
        return None

    def evaluate(state):
        won = winner(state)
        if won:
            return 100000 if won == root else -100000
        score = 0
        counts = {1: {kind: 0 for kind in BEATS}, 2: {kind: 0 for kind in BEATS}}
        for i, piece in enumerate(state):
            if not piece:
                continue
            side = piece["player"]
            counts[side][piece["type"]] += 1
            target = 8 if side == 1 else 0
            distance = max(abs(i % 9 - target), abs(i // 9 - target))
            value = 110 + (8 - distance) * (12 + SEED % 5)
            # Defend rare piece types and avoid predator-controlled squares.
            for dx, dy in DIRECTIONS:
                x, y = i % 9 + dx, i // 9 + dy
                if 0 <= x < 9 and 0 <= y < 9:
                    neighbor = state[y * 9 + x]
                    if neighbor and neighbor["player"] != side and BEATS[neighbor["type"]] == piece["type"]:
                        value -= 45
            score += value if side == root else -value
        for side in (root, 3 - root):
            penalty = sum(90 for count in counts[side].values() if count == 1)
            score += -penalty if side == root else penalty
        return score

    def ordered(state, side):
        candidates = moves(state, side)
        goal = 80 if side == 1 else 0
        def priority(move):
            target = state[move[1]]
            x, y = move[1] % 9, move[1] // 9
            distance = max(abs(x - goal % 9), abs(y - goal // 9))
            return (move[1] == goal, target is not None, -distance, (move[0] * 17 + move[1] * SEED) % 97)
        candidates.sort(key=priority, reverse=True)
        return candidates[:(6 if LEVEL >= 4 else 10)]

    def search(state, side, depth, alpha, beta):
        original_alpha, original_beta = alpha, beta
        nodes[0] += 1
        if nodes[0] > 1800 or time.monotonic() >= deadline:
            raise TimeoutError()
        if depth == 0 or winner(state):
            return evaluate(state)
        key = None
        if LEVEL >= 5:
            key = (tuple((p["player"], p["type"]) if p else None for p in state), side, depth)
            if key in cache:
                return cache[key]
        options = ordered(state, side)
        if not options:
            return evaluate(state)
        maximizing = side == root
        best = -float("inf") if maximizing else float("inf")
        cutoff = False
        for move in options:
            value = search(apply(state, move), 3 - side, depth - 1, alpha, beta)
            best = max(best, value) if maximizing else min(best, value)
            if maximizing:
                alpha = max(alpha, best)
            else:
                beta = min(beta, best)
            if beta <= alpha:
                cutoff = True
                break
        # Only cache exact values; cutoff bounds are not exact minimax scores.
        if key is not None and not cutoff and original_alpha < best < original_beta:
            cache[key] = best
        return best

    indexed = {(m["from_row"] * 9 + m["from_col"], m["to_row"] * 9 + m["to_col"]): m for m in legal}
    candidates = ordered(board, root)
    # Always return a move from the supplied authoritative legal-move list.
    candidates = [m for m in candidates if m in indexed]
    if not candidates:
        return legal[0]
    best = max(candidates, key=lambda m: evaluate(apply(board, m)))
    depths = range(1, (5 if LEVEL >= 5 else 3 if LEVEL == 4 else 2) + 1)
    for depth in depths:
        try:
            scored = [(search(apply(board, m), 3 - root, depth - 1, -float("inf"), float("inf")), m) for m in candidates]
            best = max(scored, key=lambda entry: entry[0])[1]
            candidates.sort(key=lambda m: m != best)
        except TimeoutError:
            break
    return indexed[best]
