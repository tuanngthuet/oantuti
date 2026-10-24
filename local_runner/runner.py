"""
OTTv2 Local Runner - Công cụ kiểm thử Agent trên máy cá nhân
Chạy mô phỏng trận đấu đối kháng giữa 2 Agent hoặc chơi trực tiếp với người.

Cách dùng cơ bản:
    python runner.py my_agent.py
    python runner.py my_agent.py sample_agents/greedy_agent.py --render
    python runner.py my_agent.py human --render
    python runner.py my_agent.py sample_agents/random_agent.py --rounds 20 --switch-sides
"""

import sys
import os
import time
import json
import argparse
import importlib.util
from typing import Callable, Optional, Dict, Any, Tuple

# Import Engine từ cùng thư mục
try:
    from game_engine import OTTGameEngine, Move, Piece, COLS, ROWS, PIECE_ICONS
except ImportError:
    sys.path.append(os.path.dirname(os.path.abspath(__file__)))
    from game_engine import OTTGameEngine, Move, Piece, COLS, ROWS, PIECE_ICONS


# ── Built-in Agents ───────────────────────────────────────────────────────────

def random_bot(observation: dict, configuration: dict):
    import random
    moves = observation.get("valid_moves", [])
    if not moves:
        return None
    m = random.choice(moves)
    return {"from_col": m["from_col"], "from_row": m["from_row"], "to_col": m["to_col"], "to_row": m["to_row"]}


def greedy_bot(observation: dict, configuration: dict):
    moves = observation.get("valid_moves", [])
    if not moves:
        return None
    my_p = observation.get("current_player", 1)
    target_c, target_r = (8, 8) if my_p == 1 else (0, 0)
    captures = [m for m in moves if m.get("is_capture")]
    if captures:
        best = min(captures, key=lambda m: abs(m["to_col"] - target_c) + abs(m["to_row"] - target_r))
        return {"from_col": best["from_col"], "from_row": best["from_row"], "to_col": best["to_col"], "to_row": best["to_row"]}
    best = min(moves, key=lambda m: abs(m["to_col"] - target_c) + abs(m["to_row"] - target_r))
    return {"from_col": best["from_col"], "from_row": best["from_row"], "to_col": best["to_col"], "to_row": best["to_row"]}


def human_player(observation: dict, configuration: dict):
    """Cho phép người chơi nhập nước đi trực tiếp qua bàn phím."""
    valid_moves = observation.get("valid_moves", [])
    if not valid_moves:
        print("[Human] Không còn nước đi hợp lệ nào!")
        return None

    my_p = observation.get("current_player", 1)
    target = "i9" if my_p == 1 else "a1"
    print(f"\n[Lượt P{my_p}] Nhập nước đi dạng 'c5 d6' hoặc số thứ tự [1-{len(valid_moves)}]:")

    while True:
        try:
            inp = input("Nước đi của bạn: ").strip().lower()
            if not inp:
                continue

            # Nếu nhập số thứ tự
            if inp.isdigit():
                idx = int(inp) - 1
                if 0 <= idx < len(valid_moves):
                    chosen = valid_moves[idx]
                    return {"from_col": chosen["from_col"], "from_row": chosen["from_row"],
                            "to_col": chosen["to_col"], "to_row": chosen["to_row"]}
                print(f"Số thứ tự không hợp lệ. Vui lòng nhập từ 1 đến {len(valid_moves)}.")
                continue

            # Nếu nhập chuỗi như 'c5 d6' hoặc 'c5-d6' hoặc 'c5d6'
            parts = inp.replace('-', ' ').replace('->', ' ').split()
            if len(parts) == 1 and len(parts[0]) == 4:
                from_pos, to_pos = parts[0][:2], parts[0][2:]
            elif len(parts) >= 2:
                from_pos, to_pos = parts[0], parts[1]
            else:
                print("Định dạng sai! Ví dụ: c5 d6")
                continue

            fc = ord(from_pos[0]) - ord('a')
            fr = int(from_pos[1]) - 1
            tc = ord(to_pos[0]) - ord('a')
            tr = int(to_pos[1]) - 1

            matched = next((m for m in valid_moves if m["from_col"] == fc and m["from_row"] == fr and m["to_col"] == tc and m["to_row"] == tr), None)
            if matched:
                return {"from_col": fc, "from_row": fr, "to_col": tc, "to_row": tr}
            else:
                print("Nước đi đó không hợp lệ theo luật! Các nước đi khả thi gần vị trí đó:")
                matching_piece = [f"{COLS[m['from_col']]}{ROWS[m['from_row']]}->{COLS[m['to_col']]}{ROWS[m['to_row']]}" for m in valid_moves if m["from_col"] == fc and m["from_row"] == fr]
                if matching_piece:
                    print("  Gợi ý:", ", ".join(matching_piece))
                else:
                    print(f"  Không có quân nào của bạn tại {from_pos} có thể đi được.")
        except (KeyboardInterrupt, EOFError):
            print("\nĐã hủy ván đấu.")
            return None
        except Exception as e:
            print(f"Lỗi: {e}. Vui lòng nhập lại.")


# ── Loader ────────────────────────────────────────────────────────────────────

def load_agent(agent_spec: str) -> Tuple[Callable, str]:
    """Tải hàm agent từ đường dẫn file .py hoặc bot có sẵn."""
    spec_lower = agent_spec.lower().strip()
    if spec_lower in ("random", "sample_agents/random_agent.py"):
        return random_bot, "RandomBot"
    if spec_lower in ("greedy", "sample_agents/greedy_agent.py"):
        return greedy_bot, "GreedyBot"
    if spec_lower == "human":
        return human_player, "Human"

    if not os.path.exists(agent_spec):
        raise FileNotFoundError(f"Không tìm thấy file agent: {agent_spec}")

    module_name = f"user_agent_{os.path.splitext(os.path.basename(agent_spec))[0]}"
    spec = importlib.util.spec_from_file_location(module_name, agent_spec)
    if not spec or not spec.loader:
        raise ImportError(f"Không thể load spec từ file {agent_spec}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    if not hasattr(module, "agent"):
        raise AttributeError(f"File {agent_spec} không chứa hàm 'def agent(observation, configuration)'!")

    name = os.path.basename(agent_spec)
    return getattr(module, "agent"), name


# ── Match Runner ──────────────────────────────────────────────────────────────

def run_single_match(
    agent1_fn: Callable,
    agent1_name: str,
    agent2_fn: Callable,
    agent2_name: str,
    max_moves: int = 200,
    render: bool = False,
    delay: float = 0.0,
    step_mode: bool = False,
    timeout: float = 1.0,
    quiet: bool = False,
) -> Dict[str, Any]:
    """Chạy một ván đấu giữa P1 và P2."""
    engine = OTTGameEngine()
    agents = {1: (agent1_fn, agent1_name), 2: (agent2_fn, agent2_name)}
    steps_log = []
    times = {1: [], 2: []}

    if render and not quiet:
        print("\n" + "=" * 55)
        print(f"  TRẬN ĐẤU: P1 (Xanh): {agent1_name}  VS  P2 (Đỏ): {agent2_name}")
        print("=" * 55)
        print(engine.render_ascii())

    for move_num in range(max_moves):
        cur_player = engine.state.current_turn
        fn, name = agents[cur_player]
        obs = engine.get_observation()

        # Thực thi Agent có đo thời gian
        t0 = time.perf_counter()
        raw_move = None
        error_msg = None

        try:
            raw_move = fn(obs, {})
        except Exception as e:
            error_msg = f"Exception: {type(e).__name__}: {e}"

        elapsed = time.perf_counter() - t0
        times[cur_player].append(elapsed)

        if elapsed > timeout and fn != human_player:
            if not quiet:
                print(f"⚠️ Cảnh báo: P{cur_player} ({name}) chạy mất {elapsed:.3f}s (vượt giới hạn {timeout}s)")

        # Kiểm tra nếu agent lỗi
        if error_msg or raw_move is None:
            reason = error_msg or "Agent trả về None (không có nước đi)."
            winner = 2 if cur_player == 1 else 1
            if not quiet:
                print(f"❌ P{cur_player} ({name}) phạm lỗi: {reason}")
                print(f"🏆 P{winner} ({agents[winner][1]}) thắng trận do đối thủ lỗi.")
            return {
                "winner": winner,
                "win_reason": f"P{cur_player} ({name}) lỗi: {reason}",
                "move_count": move_num + 1,
                "history": engine.state.history,
                "times": times,
            }

        # Chuẩn hóa nước đi
        if isinstance(raw_move, (list, tuple)) and len(raw_move) == 4:
            move_obj = Move(from_col=int(raw_move[0]), from_row=int(raw_move[1]),
                            to_col=int(raw_move[2]), to_row=int(raw_move[3]))
        elif isinstance(raw_move, dict):
            move_obj = Move(from_col=int(raw_move["from_col"]), from_row=int(raw_move["from_row"]),
                            to_col=int(raw_move["to_col"]), to_row=int(raw_move["to_row"]))
        else:
            reason = f"Định dạng nước đi không hợp lệ: {type(raw_move)}"
            winner = 2 if cur_player == 1 else 1
            return {
                "winner": winner,
                "win_reason": f"P{cur_player} ({name}) lỗi: {reason}",
                "move_count": move_num + 1,
                "history": engine.state.history,
                "times": times,
            }

        from_pos = f"{COLS[move_obj.from_col]}{ROWS[move_obj.from_row]}"
        to_pos = f"{COLS[move_obj.to_col]}{ROWS[move_obj.to_row]}"

        # Áp dụng nước đi
        apply_res = engine.apply_move(move_obj)

        if not apply_res["success"]:
            reason = apply_res.get("error", "Nước đi không hợp lệ.")
            winner = 2 if cur_player == 1 else 1
            if not quiet:
                print(f"❌ P{cur_player} ({name}) đi nước không hợp lệ ({from_pos} -> {to_pos}): {reason}")
            return {
                "winner": winner,
                "win_reason": f"P{cur_player} ({name}) đi sai: {reason}",
                "move_count": move_num + 1,
                "history": engine.state.history,
                "times": times,
            }

        captured = apply_res.get("captured")
        captured_str = f" [Ăn {captured['type']} của P{captured['player']}]" if captured else ""

        if render and not quiet:
            print("\n" + "-" * 45)
            print(f"Nước #{move_num + 1}: P{cur_player} ({name}) đi {from_pos} -> {to_pos}{captured_str}  ({elapsed*1000:.1f}ms)")
            print(engine.render_ascii())

            if step_mode:
                input("Nhấn [Enter] để tiếp tục...")
            elif delay > 0:
                time.sleep(delay)

        if apply_res["game_over"]:
            winner = apply_res["winner"]
            reason = apply_res["win_reason"]
            if not quiet:
                winner_name = agents[winner][1] if winner else "Hòa"
                print(f"\n🎉 TRẬN ĐẤU KẾT THÚC! Thắng: P{winner} ({winner_name})")
                print(f"Lý do: {reason}")
            return {
                "winner": winner,
                "win_reason": reason,
                "move_count": move_num + 1,
                "history": engine.state.history,
                "times": times,
            }

    # Hết max_moves -> Hòa
    if not quiet:
        print(f"\n⚖️ HÒA! Đạt giới hạn tối đa {max_moves} nước.")
    return {
        "winner": None,
        "win_reason": f"Hòa sau {max_moves} nước.",
        "move_count": max_moves,
        "history": engine.state.history,
        "times": times,
    }


# ── Main CLI ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="OTTv2 Arena Local Runner - Chạy & Kiểm thử Agent cờ Oẳn Tù Tì 9x9",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Ví dụ sử dụng:
  # Chạy 1 trận bot của bạn vs bot ngẫu nhiên:
  python runner.py my_agent.py

  # Xem bàn cờ trực quan từng bước:
  python runner.py my_agent.py sample_agents/greedy_agent.py --render --delay 0.2

  # Tự chơi trực tiếp bằng bàn phím với bot:
  python runner.py human my_agent.py --render

  # Kiểm thử 50 ván đổi bên để tính tỷ lệ thắng:
  python runner.py my_agent.py sample_agents/greedy_agent.py --rounds 50 --switch-sides --quiet

  # Xuất file replay để xem lại:
  python runner.py my_agent.py sample_agents/greedy_agent.py --save-replay match_replay.json
        """
    )
    parser.add_argument("agent1", help="Đường dẫn file agent 1 (.py) hoặc 'random', 'greedy', 'human'")
    parser.add_argument("agent2", nargs="?", default="random", help="Đường dẫn file agent 2 (mặc định: 'random')")
    parser.add_argument("--rounds", "-n", type=int, default=1, help="Số ván đấu cần chạy (mặc định: 1)")
    parser.add_argument("--switch-sides", "-s", action="store_true", help="Luân phiên đổi lượt P1/P2 qua từng ván")
    parser.add_argument("--render", "-r", action="store_true", help="Hiển thị bàn cờ Terminal sau mỗi nước đi")
    parser.add_argument("--delay", "-d", type=float, default=0.0, help="Độ trễ (giây) giữa các nước đi khi render (vd: 0.2)")
    parser.add_argument("--step", action="store_true", help="Chế độ dừng từng bước, nhấn Enter để đi tiếp")
    parser.add_argument("--max-moves", type=int, default=200, help="Số nước đi tối đa của trận (mặc định: 200)")
    parser.add_argument("--timeout", type=float, default=1.0, help="Cảnh báo nếu thời gian tính 1 nước > timeout (mặc định: 1.0s)")
    parser.add_argument("--save-replay", type=str, default="", help="Lưu dữ liệu lịch sử ván đấu ra file JSON")
    parser.add_argument("--quiet", "-q", action="store_true", help="Chỉ in kết quả tổng kết cuối cùng")

    args = parser.parse_args()

    try:
        fn1, name1 = load_agent(args.agent1)
        fn2, name2 = load_agent(args.agent2)
    except Exception as e:
        print(f"❌ Lỗi tải agent: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"🎮 OTTv2 Local Runner")
    print(f"• Agent 1: {name1}")
    print(f"• Agent 2: {name2}")
    print(f"• Số ván  : {args.rounds} {'(Có đổi bên)' if args.switch_sides else ''}")
    print("-" * 50)

    stats = {
        name1: {"win": 0, "loss": 0, "draw": 0},
        name2: {"win": 0, "loss": 0, "draw": 0},
    }
    all_replays = []

    for round_idx in range(1, args.rounds + 1):
        # Đổi bên nếu có cờ --switch-sides
        if args.switch_sides and round_idx % 2 == 0:
            p1_fn, p1_name = fn2, name2
            p2_fn, p2_name = fn1, name1
        else:
            p1_fn, p1_name = fn1, name1
            p2_fn, p2_name = fn2, name2

        if args.rounds > 1 and not args.quiet:
            print(f"\n--- Ván {round_idx}/{args.rounds}: P1 ({p1_name}) vs P2 ({p2_name}) ---")

        result = run_single_match(
            agent1_fn=p1_fn,
            agent1_name=p1_name,
            agent2_fn=p2_fn,
            agent2_name=p2_name,
            max_moves=args.max_moves,
            render=args.render,
            delay=args.delay,
            step_mode=args.step,
            timeout=args.timeout,
            quiet=args.quiet and args.rounds > 1,
        )

        winner = result["winner"]
        if winner == 1:
            stats[p1_name]["win"] += 1
            stats[p2_name]["loss"] += 1
        elif winner == 2:
            stats[p2_name]["win"] += 1
            stats[p1_name]["loss"] += 1
        else:
            stats[p1_name]["draw"] += 1
            stats[p2_name]["draw"] += 1

        all_replays.append({
            "round": round_idx,
            "p1": p1_name,
            "p2": p2_name,
            "winner": winner,
            "win_reason": result["win_reason"],
            "move_count": result["move_count"],
            "history": result["history"],
        })

    # Lưu replay nếu có yêu cầu
    if args.save_replay:
        try:
            with open(args.save_replay, "w", encoding="utf-8") as f:
                json.dump(all_replays, f, ensure_ascii=False, indent=2)
            print(f"\n💾 Đã lưu lịch sử {len(all_replays)} ván đấu vào: {args.save_replay}")
        except Exception as e:
            print(f"❌ Không thể lưu file replay: {e}")

    # Bảng tổng kết
    if args.rounds > 1:
        print("\n" + "=" * 50)
        print(f"📊 BẢNG TỔNG KẾT SAU {args.rounds} VÁN ĐẤU")
        print("=" * 50)
        for name in (name1, name2):
            w = stats[name]["win"]
            l = stats[name]["loss"]
            d = stats[name]["draw"]
            winrate = (w / args.rounds) * 100
            print(f"• {name:20}: Thắng {w:2d} | Thua {l:2d} | Hòa {d:2d}  -> Tỷ lệ thắng: {winrate:5.1f}%")
        print("=" * 50)


if __name__ == "__main__":
    main()
