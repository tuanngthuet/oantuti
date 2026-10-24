#!/usr/bin/env bash
# =============================================================================
# stop.sh — Dừng toàn bộ stack OTTv2
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }

kill_by_pid_file() {
  local name="$1"
  local pid_file="$2"
  local port="$3"

  if [ -f "$pid_file" ]; then
    PID=$(cat "$pid_file" 2>/dev/null || true)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      info "$name (PID $PID) đã dừng."
    else
      warn "$name PID $PID không còn chạy."
    fi
    rm -f "$pid_file"
  elif [ -n "$port" ]; then
    PID=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$PID" ]; then
      kill "$PID"
      info "$name (port $port) đã dừng."
    fi
  fi
}

# Stop the worker while backend/frontend are still available for lease recovery.
if command -v docker >/dev/null 2>&1; then
  docker compose -f "$SCRIPT_DIR/worker_image/compose.yaml" stop worker-python
fi

kill_by_pid_file "Frontend" "$LOG_DIR/frontend.pid" "3000"
kill_by_pid_file "Backend"  "$LOG_DIR/backend.pid"  "8000"
kill_by_pid_file "Worker"   "$LOG_DIR/worker.pid"   ""


echo ""
info "Đã dừng xong."
