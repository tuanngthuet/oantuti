"""Local OTT runner. Python 3.10+, standard library only."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from game_engine import OTTGameEngine, Move

APP = Path(__file__).resolve().parent
ROOT = APP.parent
VERSION = "1.0.0"
COORDS = ("from_col", "from_row", "to_col", "to_row")


class AgentFailure(Exception):
    def __init__(self, detail):
        super().__init__(detail["message"])
        self.detail = detail


class Cancelled(Exception):
    pass


def normalize_move(move):
    if isinstance(move, dict) and "error" in move:
        raise ValueError(str(move["error"]))
    if not isinstance(move, dict):
        raise ValueError("Agent phải trả về một object nước đi, không được bỏ lượt bằng None.")
    if "from_col" in move and "to_col" in move:
        result = {key: move.get(key) for key in COORDS}
        if any(type(value) is not int or not 0 <= value <= 8 for value in result.values()):
            raise ValueError("Bốn tọa độ phải là số nguyên từ 0 đến 8.")
        return result
    if "from_pos" in move and "to_pos" in move:
        def parse(value):
            if not isinstance(value, str) or len(value) != 2 or value[0].lower() not in "abcdefghi" or value[1] not in "123456789":
                raise ValueError("Vị trí phải có dạng a1 đến i9.")
            return ord(value[0].lower()) - 97, int(value[1]) - 1
        fc, fr = parse(move["from_pos"])
        tc, tr = parse(move["to_pos"])
        return dict(zip(COORDS, (fc, fr, tc, tr)))
    raise ValueError("Nước đi thiếu from_col/from_row/to_col/to_row hoặc from_pos/to_pos.")


def kill_process(process):
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def execute_agent(source, filename, observation, cancel, timeout=12, output_limit=65536):
    """Drain pipes concurrently and bound all retained output, including floods."""
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    process = subprocess.Popen(
        [sys.executable, "-I", "-S", "-B", str(APP / "agent_process.py")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=APP, creationflags=flags, start_new_session=os.name != "nt",
    )
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    budget_lock = threading.Lock()
    overflow = threading.Event()
    def read_pipe(name, pipe):
        try:
            while True:
                chunk = pipe.read1(8192)
                if not chunk:
                    break
                with budget_lock:
                    left = max(0, output_limit - sum(map(len, buffers.values())))
                    buffers[name].extend(chunk[:left])
                    if len(chunk) > left:
                        overflow.set()
                if overflow.is_set():
                    kill_process(process)
        finally:
            pipe.close()
    def write_input():
        try:
            process.stdin.write(json.dumps({"source": source, "filename": filename, "observation": observation}).encode())
            process.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            process.stdin.close()
    readers = [threading.Thread(target=read_pipe, args=(name, getattr(process, name)), daemon=True) for name in buffers]
    writer = threading.Thread(target=write_input, daemon=True)
    for thread in readers + [writer]:
        thread.start()
    started = time.monotonic()
    failure = None
    try:
        while process.poll() is None:
            if cancel.is_set():
                raise Cancelled()
            if overflow.is_set():
                failure = {"kind": "OutputLimit", "message": f"Tổng stdout/stderr vượt {output_limit:,} byte. Hãy giảm print()."}
                break
            if time.monotonic() - started >= timeout:
                failure = {"kind": "Timeout", "message": f"Agent tính quá {timeout:g} giây trong một lượt. Kiểm tra vòng lặp hoặc giảm lượng tính toán."}
                break
            cancel.wait(0.01)
    finally:
        kill_process(process)
        process.wait()
        for thread in readers + [writer]:
            thread.join(timeout=1)
    if cancel.is_set():
        raise Cancelled()
    stdout, stderr = (buffers[name].decode("utf-8", errors="replace") for name in ("stdout", "stderr"))
    logs = {"stdout": stdout, "stderr": stderr}
    if overflow.is_set():
        failure = {"kind": "OutputLimit", "message": f"Tổng stdout/stderr vượt {output_limit:,} byte. Hãy giảm print()."}
    if failure:
        raise AgentFailure(dict(failure, **logs))
    try:
        envelope = json.loads(stdout.strip().splitlines()[-1])
        if not isinstance(envelope, dict) or "ok" not in envelope:
            raise ValueError("Thiếu kết quả từ agent")
    except (ValueError, IndexError) as error:
        raise AgentFailure(dict(kind="ProcessExit", message=f"Agent dừng mà không trả kết quả (exit {process.returncode}): {error}", **logs))
    logs["stdout"] = "\n".join(stdout.strip().splitlines()[:-1])
    if not envelope["ok"]:
        raise AgentFailure(dict(envelope["error"], **logs))
    try:
        move = normalize_move(envelope.get("move"))
    except (ValueError, TypeError) as error:
        raise AgentFailure(dict(kind="InvalidMove", message=str(error), returned=envelope.get("move"), **logs))
    return move, logs, round(time.monotonic() - started, 4)


def read_source(path):
    raw = path.read_bytes()
    if len(raw) > 1048576:
        raise ValueError("File agent vượt giới hạn 1 MiB.")
    source = raw.decode("utf-8-sig")
    compile(source, path.name, "exec")
    return source


def export_html(record):
    record = copy.deepcopy(record)
    if record.get("status") == "running":
        record.update(status="snapshot", reason="Bản chụp lịch sử khi trận đang chạy; chỉ gồm các nước đã hoàn tất.")
    # Escape '<' so agent names/logs cannot close the data script element.
    data = json.dumps(record, ensure_ascii=True).replace("<", "\\u003c")
    template = (APP / "index.html").read_text(encoding="utf-8")
    return template.replace("/*LOCAL_TOKEN*/null", "null").replace("/*REPLAY_DATA*/null", data)


class MatchManager:
    def __init__(self):
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.thread = None
        self.state = {"status": "idle", "moves": [], "initial_board": OTTGameEngine().get_state_dict()["board"], "error": None}

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.state)

    def start(self):
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise ValueError("Một trận vẫn đang chạy hoặc đang lưu kết quả. Hãy chờ hoặc dừng trận.")
            self.cancel = threading.Event()
            engine = OTTGameEngine()
            self.state = {"id": uuid.uuid4().hex, "version": VERSION,
                "engine_sha256": hashlib.sha256((APP / "game_engine.py").read_bytes()).hexdigest(),
                "status": "running", "moves": [], "logs": [], "error": None,
                "initial_board": engine.get_state_dict()["board"], "winner": None,
                "reason": "", "current_player": 1, "turn_started": time.time()}
            self.thread = threading.Thread(target=self.run, args=(engine,), daemon=True)
            self.thread.start()

    def report_error(self, error, filename, player, source="", turn=1, preflight=False):
        detail = error.detail if isinstance(error, AgentFailure) else {
            "kind": type(error).__name__, "message": str(error),
            "line": getattr(error, "lineno", None), "traceback": traceback.format_exc()}
        detail.update(file=filename, player=player, turn=turn)
        line = detail.get("line")
        if line and source:
            detail["snippet"] = "\n".join(f"{'>' if index == line else ' '} {index}: {text}" for index, text in enumerate(source.splitlines(), 1) if line - 2 <= index <= line + 2)
        if detail["kind"] in ("SyntaxError", "IndentationError", "TabError"):
            detail["hint"] = "Kiểm tra dấu :, dấu ngoặc và thụt lề bằng 4 dấu cách. Lưu file bằng Ctrl+S rồi chạy lại."
        else:
            detail["hint"] = "Xem dòng lỗi và chi tiết bên dưới. Sửa my_agent.py, nhấn Ctrl+S rồi bấm Chạy lại."
        if player is None:
            detail["hint"] = "Lỗi thuộc công cụ local. Sao chép chi tiết và gửi người cung cấp công cụ."
        elif player == 2:
            detail["hint"] = "Lỗi nằm ở Greedy đi kèm. Gửi bản ghi lỗi cho người cung cấp công cụ."
        with self.lock:
            self.state.update(status="error", error=detail,
                winner=2 if player == 1 and not preflight else None,
                reason="Agent người chơi lỗi, Greedy thắng." if player == 1 and not preflight else "Không thể hoàn tất trận; xem lỗi bên dưới.")

    def run(self, engine):
        source = ""
        try:
            sources = []
            for player, path in ((1, ROOT / "my_agent.py"), (2, APP / "greedy_agent.py")):
                try:
                    source = path.read_bytes()[:1048577].decode("utf-8-sig", errors="replace")
                    sources.append(read_source(path))
                except Exception as error:
                    self.report_error(error, path.name, player, source, preflight=True)
                    return
            for turn in range(1, 201):
                if self.cancel.is_set():
                    raise Cancelled()
                player = engine.state.current_turn
                with self.lock:
                    self.state.update(current_player=player, turn_started=time.time())
                filename = "my_agent.py" if player == 1 else "greedy_agent.py"
                try:
                    move, logs, duration = execute_agent(sources[player - 1], filename, engine.get_observation(), self.cancel)
                    piece = engine.state.board[move["from_row"]][move["from_col"]]
                    result = engine.apply_move(Move(**move))
                    if not result["success"]:
                        raise AgentFailure(dict(kind="IllegalMove", message=result.get("error", "Nước đi không hợp lệ"), returned=move, **logs))
                except AgentFailure as error:
                    self.report_error(error, filename, player, sources[player - 1], turn)
                    break
                with self.lock:
                    self.state["moves"].append(dict(move, player=player, move_number=turn,
                        piece_type=piece.type, captured_type=(result.get("captured") or {}).get("type"), seconds=duration))
                    self.state["logs"].append(dict(turn=turn, player=player, **logs))
                if result["game_over"]:
                    with self.lock:
                        self.state.update(status="finished", winner=result.get("winner"), reason=result.get("win_reason", ""))
                    break
            else:
                with self.lock:
                    self.state.update(status="finished", winner=None, reason="Hòa: đạt giới hạn 200 nước.")
        except Cancelled:
            with self.lock:
                self.state.update(status="cancelled", winner=None, reason="Bạn đã dừng trận. Lịch sử vẫn được giữ lại.")
        except Exception as error:
            self.report_error(error, "Công cụ local", None)
        finally:
            try:
                record = self.snapshot()
                if record.get("error"):
                    record["error"].pop("snippet", None)
                directory = APP / "results" / record["id"]
                directory.mkdir(parents=True, exist_ok=True)
                (directory / "record.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
                (directory / "replay.html").write_text(export_html(record), encoding="utf-8")
                with self.lock:
                    self.state["saved"] = str(directory.relative_to(ROOT))
            except Exception as error:
                with self.lock:
                    self.state["save_error"] = f"Không lưu được kết quả: {error}"

    def stop(self):
        self.cancel.set()


def make_handler(manager, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send(self, code, body, content_type="application/json; charset=utf-8", attachment=None):
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if attachment:
                self.send_header("Content-Disposition", f'attachment; filename="{attachment}"')
            self.end_headers()
            self.wfile.write(body)

        def valid_host(self):
            return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

        def do_GET(self):
            if not self.valid_host():
                return self.send(403, '{}')
            if self.path == "/":
                page = (APP / "index.html").read_text(encoding="utf-8").replace("/*LOCAL_TOKEN*/null", json.dumps(token))
                return self.send(200, page, "text/html; charset=utf-8")
            if self.path == "/guide":
                return self.send(200, (APP / "HUONG_DAN.html").read_bytes(), "text/html; charset=utf-8")
            if self.path in ("/HUONG_DAN.html", "/HUONG_DAN_LINUX.html"):
                return self.send(200, (APP / self.path[1:]).read_bytes(), "text/html; charset=utf-8")
            if self.path == "/api/state":
                return self.send(200, json.dumps(manager.snapshot(), ensure_ascii=True))
            if self.path in ("/download/replay", "/download/json"):
                record = manager.snapshot()
                if record.get("error"):
                    record["error"].pop("snippet", None)
                if self.path.endswith("replay"):
                    return self.send(200, export_html(record), "text/html; charset=utf-8", "replay.html")
                return self.send(200, json.dumps(record, ensure_ascii=False, indent=2), attachment="record.json")
            return self.send(404, '{}')

        def do_POST(self):
            if not self.valid_host() or self.headers.get("X-Local-Token") != token:
                return self.send(403, '{}')
            try:
                if self.path == "/api/start":
                    manager.start()
                elif self.path == "/api/stop":
                    manager.stop()
                elif self.path == "/api/quit":
                    manager.stop()
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                else:
                    return self.send(404, '{}')
                self.send(200, '{"ok":true}')
            except ValueError as error:
                self.send(409, json.dumps({"error": str(error)}))
    return Handler


def main():
    parser = argparse.ArgumentParser(description="Bộ test agent local — chỉ cần Python")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if sys.version_info < (3, 10):
        raise RuntimeError("Cần Python 3.10 trở lên.")
    manager = MatchManager()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(manager, secrets.token_urlsafe(32)))
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"Mở trình duyệt tại: {url}\nGiữ cửa sổ này mở. Nhấn Ctrl+C hoặc nút Thoát công cụ để dừng.", flush=True)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            print("Không tự mở được trình duyệt. Hãy mở địa chỉ phía trên.", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        manager.stop()
        if manager.thread:
            manager.thread.join(timeout=5)
        server.server_close()


if __name__ == "__main__":
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        main()
    except Exception:
        (APP / "logs").mkdir(exist_ok=True)
        (APP / "logs" / "startup.log").write_text(traceback.format_exc(), encoding="utf-8")
        print("Không khởi động được công cụ. Chi tiết: app/logs/startup.log\n" + traceback.format_exc())
        sys.exit(1)
