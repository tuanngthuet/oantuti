#!/usr/bin/env bash
# Run from any directory. No argument = build, self-check, recreate worker-python.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/worker_image/compose.yaml"
ACTION="${1:-up}"

usage() {
  cat <<'USAGE'
Usage: ./dockerworker.sh [command]

  up, start, update   Build bản mới, kiểm tra sandbox, tạo lại và chạy worker (mặc định).
  build              Build và kiểm tra image, chưa thay container đang chạy.
  check              Kiểm tra sandbox của image hiện tại, không nhận job.
  logs               Theo dõi 100 dòng log gần nhất; Ctrl+C để thoát xem log.
  status, ps         Xem trạng thái container.
  stop               Dừng container worker, trả job chưa xong về lịch chờ.
  test               Build và chạy bộ test worker trong Docker.
  export             Xuất ZIP có sẵn image, secrets, URL Vercel và script Windows/Linux.
  help               Xem hướng dẫn.

Cấu hình: worker_image/.env
Nếu worker đã bị dừng trong admin, bấm "Bật worker" sau khi cập nhật.
Luật tính điểm trên frontend/backend cần cập nhật riêng.
USAGE
}

if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi
case "$ACTION" in
  help|-h|--help) usage; exit 0 ;;
  up|start|update|build|check|logs|status|ps|stop|test|export) ;;
  *) printf 'Lệnh không hợp lệ: %s\n' "$ACTION" >&2; usage >&2; exit 2 ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo 'Không tìm thấy Docker. Cần cài Docker Engine và Docker Compose v2.' >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo 'Không chạy được Docker Compose v2: docker compose version' >&2
  exit 1
fi
if ! docker info --format '{{.ServerVersion}}' >/dev/null; then
  echo 'Không truy cập được Docker daemon. Kiểm tra Docker đang chạy và quyền truy cập; có thể dùng sudo ./dockerworker.sh.' >&2
  exit 1
fi
if [[ "$ACTION" != test && ! -f "$ROOT_DIR/worker_image/.env" ]]; then
  echo 'Thiếu worker_image/.env. Tạo từ worker_image/.env.example và điền URL/secrets trước.' >&2
  exit 1
fi

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
check_image() {
  echo 'Kiểm tra Python sandbox...'
  compose run --rm --no-deps --pull never worker-python --check
}
build_image() {
  echo 'Build image worker mới...'
  compose build worker-python
  check_image
}

case "$ACTION" in
  up|start|update)
    build_image
    echo 'Tạo lại container và chạy worker...'
    compose up -d --no-deps --no-build --force-recreate worker-python
    compose ps worker-python
    echo 'Đã cập nhật worker. Xem log: ./dockerworker.sh logs'
    echo 'Nếu admin đang lưu trạng thái dừng, bấm "Bật worker" tại /admin/workers.'
    ;;
  build) build_image ;;
  check) check_image ;;
  logs) compose logs -f --tail 100 worker-python ;;
  status|ps) compose ps worker-python ;;
  stop) compose stop worker-python ;;
  export)
    python3 "$ROOT_DIR/worker_image/export-bundle.py"
    ;;
  test)
    compose build worker-tests
    compose run --rm --no-deps --pull never worker-tests
    ;;
esac
