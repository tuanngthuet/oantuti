"""Build a reproducible, dependency-free player ZIP from repository sources."""
from pathlib import Path
import hashlib
import json
import zipfile


def build():
    app = Path(__file__).resolve().parent
    local = app.parent
    repo = local.parent
    sources = {
        "my_agent.py": local / "my_agent.py",
        "Chay.cmd": (local / "Chay.cmd") if (local / "Chay.cmd").exists() else (local / "run.cmd"),
        "app/start.py": app / "start.py",
        "app/agent_process.py": app / "agent_process.py",
        "app/index.html": app / "index.html",
        "app/HUONG_DAN.html": (app / "HUONG_DAN.html") if (app / "HUONG_DAN.html").exists() else (local / "HUONG_DAN.html"),
        "app/Chay.sh": (app / "Chay.sh") if (app / "Chay.sh").exists() else (app / "run.sh"),
        "app/HUONG_DAN_LINUX.html": app / "HUONG_DAN_LINUX.html",
        "app/game_engine.py": repo / "worker_image/game_engine.py",
        "app/greedy_agent.py": repo / "backend/agents/greedy_agent.py",
    }
    destination = app / "dist" / "Oantuti-Local.zip"
    destination.parent.mkdir(exist_ok=True)
    manifest = {"version": "1.0.0", "python": ">=3.10", "rules": "regular-200", "sha256": {}}
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, path in sources.items():
            content = path.read_bytes()
            if name.endswith(".cmd"):
                content = content.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            manifest["sha256"][name] = hashlib.sha256(content).hexdigest()
            archive.writestr(zipfile.ZipInfo("Oantuti-Local/" + name), content,
                compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        archive.writestr(zipfile.ZipInfo("Oantuti-Local/app/manifest.json"), json.dumps(manifest, indent=2),
            compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    print(f"{destination}\n{destination.stat().st_size:,} bytes")
    return destination


if __name__ == "__main__":
    build()
