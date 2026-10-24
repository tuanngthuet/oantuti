# Portable worker verification — 2026-10-21

Bundle: worker_image/portable (3 files, linux/amd64, gzip archive ~53.5 MiB).

PASS Docker image build and real Bubblewrap self-check.
PASS archive reload with docker load -i.
PASS 117 Docker tests (0 skipped), 24.61 seconds; existing dependency deprecation warnings only.
PASS all embedded env values match worker_image/.env except BACKEND_URL/FRONTEND_URL overrides.
PASS backend hosted /health: 200, Redis connected.
PASS backend worker authentication: deliberately invalid identity rejected with 422 after secret validation.
PASS frontend friendly and rating authentication: empty callback rejected with 400 after secret validation.
PASS start/heartbeat and stop (exit 0) against isolated mock backend.
PASS stable worker identity after force-recreate and down/up.
PASS non-root, read-only, no privileged, no published ports.
PASS archive SHA256 in bundled README.
PASS test containers/network/volume cleaned up; pre-existing worker left running.

Not tested: Windows execution; complete hosted Vercel match/callback/ACK lifecycle.
Smoke harness: smoke.py; container logs: smoke.log.
