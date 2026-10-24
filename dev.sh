#!/usr/bin/env bash
# =============================================================================
# dev.sh — Chạy development mode (hot-reload)
# Mở terminal riêng cho từng thành phần:
#   - Backend  (uvicorn --reload)
#   - Frontend (npm run dev)
# Không tự chạy worker; bật thủ công trong console riêng khi cần.
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/Frontend"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC}  $*"; }
step() { echo -e "${CYAN}[STEP]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }

# Phát hiện terminal emulator
open_terminal() {
  local title="$1"
  local cmd="$2"
  if command -v gnome-terminal >/dev/null 2>&1; then
    gnome-terminal --title="$title" -- bash -c "$cmd; exec bash"
  elif command -v xterm >/dev/null 2>&1; then
    xterm -title "$title" -e bash -c "$cmd; exec bash" &
  else
    info "Không tìm thấy GUI terminal — chạy nền..."
    bash -c "$cmd" &
  fi
}

# ── Backend ───────────────────────────────────────────────────────────────────
step "Backend..."
if lsof -iTCP:8000 -sTCP:LISTEN -t >/dev/null 2>&1; then
  info "Backend đã chạy trên port 8000, bỏ qua."
else
  if [ -x "$BACKEND_DIR/venv/bin/python3" ]; then
    BACKEND_PYTHON="$BACKEND_DIR/venv/bin/python3"
  else
    BACKEND_PYTHON="$(command -v python3 || true)"
  fi
  if [ -z "$BACKEND_PYTHON" ] || ! "$BACKEND_PYTHON" -c 'import uvicorn' >/dev/null 2>&1; then
    warn "Không có Python chạy được uvicorn. Cài dependencies backend trước."
  else
    open_terminal "OTTv2 Backend" \
      "cd '$BACKEND_DIR' && DATABASE_SCHEMA= REDIS_KEY_PREFIX= '$BACKEND_PYTHON' -B -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"
    sleep 1
  fi
fi

# ── Frontend ──────────────────────────────────────────────────────────────────
step "Frontend..."
if lsof -iTCP:3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
  info "Frontend đã chạy trên port 3000, bỏ qua."
else
  open_terminal "OTTv2 Frontend" \
    "cd '$FRONTEND_DIR' && DATABASE_SCHEMA= REDIS_KEY_PREFIX= npm run dev -- -H 0.0.0.0 --port 3000"
fi

# ── Tóm tắt ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}Dev mode đang khởi động...${NC}"
echo ""
echo "  🌐 Frontend  →  http://localhost:3000  (hot-reload)"
echo "  ⚙️  Backend   →  http://localhost:8000/docs (auto-reload)"
echo "  🤖 Worker    →  Python sandbox: ./dockerworker.sh"
echo ""
warn "Đảm bảo backend/.env có UPSTASH_REDIS_REST_URL và UPSTASH_REDIS_REST_TOKEN"
echo ""
