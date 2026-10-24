import hashlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
import start
import build_bundle


class ExecutionTests(unittest.TestCase):
    def run_agent(self, source, **kwargs):
        return start.execute_agent(source, "my_agent.py", start.OTTGameEngine().get_observation(), threading.Event(), **kwargs)

    def test_formats_debug_output_and_fresh_process(self):
        source = '''count = 0
def agent(o, c):
    global count
    count += 1
    assert count == 1
    print("debug log")
    move = o["valid_moves"][0]
    return tuple(move[k] for k in ("from_col", "from_row", "to_col", "to_row"))
'''
        for _ in range(2):
            move, logs, _ = self.run_agent(source)
            self.assertIn(move, [{k: m[k] for k in start.COORDS} for m in start.OTTGameEngine().get_observation()["valid_moves"]])
            self.assertEqual(logs["stdout"].strip(), "debug log")
        self.assertEqual(start.normalize_move({"from_pos": "a1", "to_pos": "b2"}), dict(zip(start.COORDS, (0, 0, 1, 1))))

    def test_traceback_has_exact_user_line(self):
        with self.assertRaises(start.AgentFailure) as caught:
            self.run_agent('def agent(o, c):\n    x = 1\n    return x / 0\n')
        self.assertEqual(caught.exception.detail["line"], 3)
        self.assertIn('my_agent.py', caught.exception.detail["traceback"])
        self.assertIn('return x / 0', caught.exception.detail["traceback"])

    def test_missing_function_none_and_bad_coordinates(self):
        for source in ('x = 1', 'def agent(o,c): return None', 'def agent(o,c): return {"from_col": True, "from_row": 0, "to_col": 1, "to_row": 1}'):
            with self.subTest(source=source), self.assertRaises(start.AgentFailure):
                self.run_agent(source)

    def test_timeout_and_both_output_pipes(self):
        cases = [
            ('def agent(o,c):\n    while True: pass', {"timeout": .2}, "Timeout"),
            ('def agent(o,c):\n    while True: print("x"*4096, flush=True)', {}, "OutputLimit"),
            ('import sys\ndef agent(o,c):\n    while True: print("x"*4096, file=sys.stderr, flush=True)', {}, "OutputLimit"),
        ]
        for source, kwargs, kind in cases:
            with self.subTest(kind=kind), self.assertRaises(start.AgentFailure) as caught:
                self.run_agent(source, **kwargs)
            self.assertEqual(caught.exception.detail["kind"], kind)
            self.assertLessEqual(sum(len(caught.exception.detail[k].encode()) for k in ("stdout", "stderr")), 65536)

    def test_cancel_running_agent(self):
        cancel = threading.Event()
        timer = threading.Timer(.15, cancel.set)
        timer.start()
        with self.assertRaises(start.Cancelled):
            start.execute_agent('def agent(o,c):\n    while True: pass', "my_agent.py", {}, cancel)
        timer.join()


class MatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="Thử agent có khoảng trắng ")
        self.root = Path(self.temporary.name)
        self.app = self.root / "app"
        self.app.mkdir()
        for name in ("game_engine.py", "greedy_agent.py", "index.html", "agent_process.py"):
            (self.app / name).write_bytes((APP / name).read_bytes())
        self.context = patch.multiple(start, ROOT=self.root, APP=self.app)
        self.context.start()

    def tearDown(self):
        self.context.stop()
        self.temporary.cleanup()

    def match(self, source):
        (self.root / "my_agent.py").write_text(source, encoding="utf-8")
        manager = start.MatchManager()
        manager.start()
        manager.thread.join(timeout=30)
        self.assertFalse(manager.thread.is_alive())
        return manager.snapshot()

    def test_preflight_error_and_saved_replay(self):
        record = self.match('def agent(o,c)\n    pass\n')
        self.assertEqual(record["error"]["line"], 1)
        self.assertEqual(record["status"], "error")
        self.assertIsNone(record["winner"])
        self.assertIn('> 1:', record["error"]["snippet"])
        html = (self.app / "results" / record["id"] / "replay.html").read_text(encoding="utf-8")
        self.assertNotIn('/*REPLAY_DATA*/null', html)
        saved = json.loads((self.app / "results" / record["id"] / "record.json").read_text(encoding="utf-8"))
        self.assertNotIn("snippet", saved["error"])

    def test_invalid_move_loses_and_preserves_board(self):
        record = self.match('def agent(o,c): return [0,0,8,8]')
        self.assertEqual(record["winner"], 2)
        self.assertEqual(record["moves"], [])
        self.assertEqual(record["error"]["kind"], "IllegalMove")

    def test_real_sample_versus_fixed_greedy(self):
        record = self.match((APP.parent / "my_agent.py").read_text(encoding="utf-8"))
        self.assertIn(record["status"], ("finished", "error"))
        self.assertIsNone(record["error"])
        self.assertGreater(len(record["moves"]), 1)
        self.assertLessEqual(len(record["moves"]), 200)
        engine = start.OTTGameEngine()
        for entry in record["moves"]:
            self.assertEqual(entry["player"], engine.state.current_turn)
            self.assertTrue(engine.apply_move(start.Move(**{k: entry[k] for k in start.COORDS}))["success"])

    def test_200_move_draw(self):
        def legal_move(_source, _filename, observation, _cancel):
            # Avoid captures/base wins: move back and forth with one piece each.
            player = observation["current_player"]
            candidates = ((1, 3, 0, 3), (0, 3, 1, 3)) if player == 1 else ((5, 7, 5, 8), (5, 8, 5, 7))
            for coords in candidates:
                move = dict(zip(start.COORDS, coords))
                if any(all(valid[k] == move[k] for k in start.COORDS) for valid in observation["valid_moves"]):
                    return move, {"stdout": "", "stderr": ""}, 0
            raise AssertionError("No reversible move")
        with patch.object(start, "execute_agent", legal_move):
            record = self.match('def agent(o,c): pass')
        self.assertEqual(record["status"], "finished")
        self.assertEqual(len(record["moves"]), 200)
        self.assertIsNone(record["winner"])

    def test_safe_html_embedding(self):
        html = start.export_html({"reason": '</script><script>alert(1)</script>'})
        self.assertNotIn('</script><script>alert(1)', html)
        self.assertIn('\\u003c/script>', html)

    def test_greedy_error_is_not_player_loss(self):
        (self.app / "greedy_agent.py").write_text('def agent(o,c): return None', encoding="utf-8")
        record = self.match('def agent(o,c): return o["valid_moves"][0]')
        self.assertEqual(record["error"]["player"], 2)
        self.assertIsNone(record["winner"])
        self.assertEqual(len(record["moves"]), 1)

    def test_running_export_is_finite_snapshot(self):
        html = start.export_html({"status": "running", "moves": []})
        self.assertIn('"status": "snapshot"', html)


class BundleTests(unittest.TestCase):
    def test_bundle_contains_only_player_files_and_current_engine(self):
        path = build_bundle.build()
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            self.assertIn("Oantuti-Local/my_agent.py", names)
            self.assertIn("Oantuti-Local/Chay.cmd", names)
            self.assertFalse(any("tests/" in name or "results/" in name or ".env" in name for name in names))
            engine = archive.read("Oantuti-Local/app/game_engine.py")
            self.assertEqual(engine, (APP.parents[1] / "worker_image/game_engine.py").read_bytes())
            self.assertIn(b'\r\n', archive.read("Oantuti-Local/Chay.cmd"))
            manifest = json.loads(archive.read("Oantuti-Local/app/manifest.json"))
            for name, digest in manifest["sha256"].items():
                self.assertEqual(hashlib.sha256(archive.read("Oantuti-Local/" + name)).hexdigest(), digest)


if __name__ == "__main__":
    unittest.main()
