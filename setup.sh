#!/usr/bin/env bash
# =============================================================================
# setup.sh — Cài đặt OTTv2 (Backend + Python Worker + Frontend)
# Chạy 1 lần duy nhất trên máy mới.
#
# Kiến trúc:
#   Frontend (Vercel) ←→ FastAPI (Vercel) ←→ Redis (Upstash) ←→ Worker (máy này)
#                                                                      ↓
#                                                                  Python sandbox (Docker)
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
WORKER_DIR="$SCRIPT_DIR/worker_image"
FRONTEND_DIR="$SCRIPT_DIR/Frontend"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
step()  { echo -e "${CYAN}[STEP]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       OTTv2 Setup Script             ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""

# ── 1. Kiểm tra dependencies ──────────────────────────────────────────────────
step "1/5 Kiểm tra dependencies..."
command -v docker   >/dev/null 2>&1 || error "Docker chưa cài. Xem: https://docs.docker.com/engine/install/ubuntu/"
command -v python3  >/dev/null 2>&1 || error "Python 3 chưa cài."
command -v pip3     >/dev/null 2>&1 || error "pip3 chưa cài."
command -v node     >/dev/null 2>&1 || warn "Node.js chưa cài — cần nếu chạy frontend local."
info "  Docker:  $(docker --version | head -1)"
info "  Python:  $(python3 --version)"
command -v node >/dev/null 2>&1 && info "  Node:    $(node --version)"

# ── 2. Backend: virtualenv + pip ─────────────────────────────────────────────
step "2/5 Cài đặt backend dependencies..."
cd "$BACKEND_DIR"
if [ ! -d "venv" ]; then
  python3 -m venv venv
  info "  Đã tạo virtualenv."
fi
source venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
deactivate
info "  Backend dependencies OK."

# Backend .env
if [ ! -f "$BACKEND_DIR/.env" ]; then
  cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
  warn "  Đã tạo backend/.env — hãy điền UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, WORKER_SECRET!"
else
  info "  backend/.env đã tồn tại."
fi

# ── 3. Worker configuration ───────────────────────────────────────────────────
step "3/5 Cấu hình Python worker..."
if [ ! -f "$WORKER_DIR/.env" ]; then
  cp "$WORKER_DIR/.env.example" "$WORKER_DIR/.env"
  chmod 600 "$WORKER_DIR/.env"
  warn "Đã tạo worker_image/.env — điền URL backend/frontend và secrets trước khi chạy."
else
  info "worker_image/.env đã tồn tại."
fi

# ── 4. Frontend: npm install ──────────────────────────────────────────────────
step "4/5 Cài đặt frontend dependencies..."
if command -v node >/dev/null 2>&1; then
  cd "$FRONTEND_DIR"
  npm install --silent
  info "  Frontend dependencies OK."

  if [ ! -f "$FRONTEND_DIR/.env.local" ]; then
    if [ -f "$FRONTEND_DIR/.env.example" ]; then
      cp "$FRONTEND_DIR/.env.example" "$FRONTEND_DIR/.env.local"
      warn "  Đã tạo Frontend/.env.local — hãy điền DATABASE_URL, SESSION_SECRET, BACKEND_URL!"
    fi
  else
    info "  Frontend/.env.local đã tồn tại."
  fi
else
  warn "  Node.js không có — bỏ qua frontend."
fi

# ── 5. Python sandbox image ──────────────────────────────────────────────────
step "5/5 Build Python worker image..."
docker compose -f "$WORKER_DIR/compose.yaml" build worker-python

# ── Tóm tắt ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}✅ Setup hoàn tất!${NC}"
echo ""
echo "  Tiếp theo — điền các biến môi trường:"
echo ""
echo "  📄 backend/.env"
echo "     UPSTASH_REDIS_REST_URL=https://..."
echo "     UPSTASH_REDIS_REST_TOKEN=..."
echo "     WORKER_SECRET=<chuỗi ngẫu nhiên>"
echo ""
echo "  📄 worker_image/.env"
echo "     BACKEND_URL=http://host.docker.internal:8000   (local test)"
echo "     WORKER_SECRET=<giống với backend>"
echo ""
echo "  📄 Frontend/.env.local"
echo "     DATABASE_URL=postgresql://..."
echo "     SESSION_SECRET=..."
echo "     BACKEND_URL=http://host.docker.internal:8000   (local test)"
echo ""
echo "  Sau khi điền xong:"
echo "    ./start.sh   — khởi động toàn bộ"
echo "    ./dev.sh     — chạy dev mode (hot-reload)"
echo ""
