"""One fresh interpreter per move; stdlib only. Not a sandbox."""
import json
import linecache
import sys
import traceback


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    data = json.loads(sys.stdin.read())
    source, filename = data["source"], data["filename"]
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
    try:
        namespace = {"__name__": "local_agent", "__file__": filename}
        exec(compile(source, filename, "exec"), namespace)
        function = namespace.get("agent")
        if not callable(function):
            raise TypeError("Không tìm thấy hàm agent(observation, configuration).")
        result = function(data["observation"], {})
        if isinstance(result, (list, tuple)) and len(result) == 4:
            result = dict(zip(("from_col", "from_row", "to_col", "to_row"), map(int, result)))
        envelope = {"ok": True, "move": result}
        # Validate serializability inside the exception handler.
        encoded = json.dumps(envelope, ensure_ascii=True)
    except BaseException as error:
        frames = traceback.extract_tb(error.__traceback__)
        matching = [frame for frame in frames if frame.filename == filename]
        encoded = json.dumps({"ok": False, "error": {
            "kind": type(error).__name__, "message": str(error),
            "line": getattr(error, "lineno", None) or (matching[-1].lineno if matching else None),
            "traceback": traceback.format_exc(),
        }}, ensure_ascii=True)
    print("\n" + encoded, flush=True)


if __name__ == "__main__":
    main()
