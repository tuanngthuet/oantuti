#!/usr/bin/env bash
# Chạy bằng: bash app/Chay.sh (không cần chmod hoặc cài thư viện).
runner_app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || exit 1

for runner_python in python3 python; do
    if command -v "$runner_python" >/dev/null 2>&1 &&
        "$runner_python" -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
        exec "$runner_python" -B "$runner_app_dir/start.py" "$@"
    fi
done

echo 'Không tìm thấy Python 3.10 trở lên.' >&2
echo 'Kiểm tra bằng: python3 --version. Cài hoặc nâng cấp Python rồi chạy lại.' >&2
echo "Hướng dẫn: mở $runner_app_dir/HUONG_DAN_LINUX.html bằng trình duyệt." >&2
exit 1
