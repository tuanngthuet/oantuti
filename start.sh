#!/usr/bin/env bash
# =============================================================================
# start.sh — Khởi động toàn bộ stack OTTv2 (production mode, chạy nền)
#
#   Backend  → http://localhost:8000
#   Worker   → poll Redis queue
#   Frontend → http://localhost:3000  (nếu có)
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
WORKER_DIR="$SCRIPT_DIR/worker_image"
FRONTEND_DIR="$SCRIPT_DIR/Frontend"
LOG_DIR="$SCRIPT_DIR/logs"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
step()  { echo -e "${CYAN}[STEP]${NC}  $*"; }

mkdir -p "$LOG_DIR"

# ── 2. Backend (FastAPI) ──────────────────────────────────────────────────────
step "1/3 Backend..."
OLD_PID=$(lsof -ti :8000 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  warn "  Port 8000 đang bị chiếm (PID $OLD_PID), kill..."
  kill "$OLD_PID" 2>/dev/null || true
  sleep 1
fi

if [ ! -f "$BACKEND_DIR/venv/bin/activate" ]; then
  warn "  Chưa có virtualenv. Chạy ./setup.sh trước."
else
  cd "$BACKEND_DIR"
  source venv/bin/activate
  nohup uvicorn app.main:app \
    --host 0.0.0.0 --port 8000 \
    >> "$LOG_DIR/backend.log" 2>&1 &
  BACKEND_PID=$!
  echo $BACKEND_PID > "$LOG_DIR/backend.pid"
  deactivate
  cd "$SCRIPT_DIR"

  sleep 2
  if kill -0 $BACKEND_PID 2>/dev/null; then
    info "  ✅ Backend (PID $BACKEND_PID) → http://localhost:8000"
  else
    warn "  ⚠️  Backend không khởi động. Xem: tail -f $LOG_DIR/backend.log"
  fi
fi

# ── Python sandbox worker ────────────────────────────────────────────────────
step "2/3 Python worker..."
if [ ! -f "$WORKER_DIR/.env" ]; then
  warn "worker_image/.env chưa được cấu hình. Bỏ qua worker."
else
  bash "$SCRIPT_DIR/dockerworker.sh" up
fi

# ── 4. Frontend (tùy chọn) ────────────────────────────────────────────────────
step "3/3 Frontend..."
if [ ! -f "$FRONTEND_DIR/package.json" ]; then
  warn "  Không tìm thấy Frontend. Bỏ qua."
else
  OLD_PID=$(lsof -ti :3000 2>/dev/null || true)
  if [ -n "$OLD_PID" ]; then
    warn "  Port 3000 đang bị chiếm (PID $OLD_PID), kill..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi

  cd "$FRONTEND_DIR"
  if [ ! -d ".next/server" ]; then
    info "  Build frontend lần đầu (~30s)..."
    npm run build >> "$LOG_DIR/frontend-build.log" 2>&1
  fi

  nohup npm start -- --port 3000 \
    >> "$LOG_DIR/frontend.log" 2>&1 &
  FRONTEND_PID=$!
  echo $FRONTEND_PID > "$LOG_DIR/frontend.pid"
  cd "$SCRIPT_DIR"

  sleep 3
  if kill -0 $FRONTEND_PID 2>/dev/null; then
    info "  ✅ Frontend (PID $FRONTEND_PID) → http://localhost:3000"
  else
    warn "  ⚠️  Frontend không khởi động. Xem: tail -f $LOG_DIR/frontend.log"
  fi
fi

# ── Tóm tắt ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  OTTv2 đang chạy!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo "  🌐 Frontend  →  http://localhost:3000"
echo "  ⚙️  Backend   →  http://localhost:8000/docs"
echo "  🤖 Worker    →  Python sandbox (xem ./dockerworker.sh logs)"
echo ""
echo "  Logs:"
echo "    tail -f $LOG_DIR/backend.log"
echo "    ./dockerworker.sh logs"
echo "    tail -f $LOG_DIR/frontend.log"
echo ""
echo "  Để dừng: ./stop.sh"
echo ""
