# Triển khai backend, frontend và Python worker

Backend FastAPI quản lý Redis queue và lease. Frontend Next.js lưu agent, rating,
lịch sử và replay trong PostgreSQL. Worker Docker nhận cả trận rồi chạy engine
và Python agents trong Bubblewrap; không có dịch vụ thực thi HTTP cho worker chính.

## Backend

Cài dependencies trong `backend/requirements.txt`. Điền `backend/.env` hoặc các
biến môi trường tương ứng: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
`WORKER_SECRET`, `INTERNAL_BACKEND_SECRET`. Khởi động bằng:

```bash
cd backend
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Kiểm tra `/health` trả `redis_connected: true`.

## Frontend

Điền `Frontend/.env.local` khi chạy local hoặc cấu hình môi trường trên hosting:
`DATABASE_URL`, `SESSION_SECRET`, `BACKEND_URL`, `INTERNAL_BACKEND_SECRET` và
`WORKER_CALLBACK_SECRET`. Dùng migration phù hợp với database hiện tại; không
chạy lại migration khởi tạo có reset dữ liệu trên database đang sử dụng.

```bash
cd Frontend
npm ci
npm run build
npm start
```

## Worker Python

Máy worker cần Linux, Docker Engine, Compose và quyền tạo nested user namespaces.
Copy `worker_image/.env.example` thành `worker_image/.env`, đặt:

- `BACKEND_URL`: URL backend mà container truy cập được.
- `FRONTEND_URL`: URL frontend nhận callback.
- `WORKER_SECRET`: khớp backend.
- `WORKER_CALLBACK_SECRET`: khớp frontend.
- `WORKER_ID`: tên ổn định; khác nhau nếu chạy nhiều worker trên cùng máy.
- `AGENT_CPU_SECONDS`, `AGENT_WALL_SECONDS`, `AGENT_MEMORY_MB`: giới hạn mỗi lượt.

Nếu server chạy trên chính host Docker, dùng `host.docker.internal`; nếu ở máy
khác, dùng địa chỉ server thật. `localhost` bên trong container trỏ về container.

Từ repository root:

```bash
./dockerworker.sh
./dockerworker.sh status
./dockerworker.sh logs
./dockerworker.sh stop
```

Lệnh mặc định build, self-check sandbox và tạo lại worker. Điều khiển xử lý trận
và concurrency tại `/admin/workers`. Worker đã dừng trong admin cần bấm Bật worker
để xử lý tiếp; recreate container không xóa trạng thái đã lưu.

## Chuyển image có cấu hình sang máy khác

```bash
./dockerworker.sh export
```

Chuyển `worker-image.tar.gz` và `compose.yaml` trong thư mục xuất `logs/worker_bundle_*`.
Máy nhận phải cùng kiến trúc CPU. Trong thư mục chứa hai file:

```bash
gunzip -c worker-image.tar.gz | docker load
docker compose run --rm --no-deps worker-python --check
docker compose up -d
```

Image này chứa secrets trong `.env`; chỉ chia sẻ cho máy/người tin cậy. Không cần
source code, Dockerfile hoặc `.env` ngoài image. Thay cấu hình nhúng thì export lại.

## Kiểm thử

```bash
./dockerworker.sh test
LOCAL_TEST_FRONTEND_PORT=3301 LOCAL_TEST_BACKEND_PORT=8301 node worker_image/test-local.mjs
```

Test local tạo schema PostgreSQL và namespace Redis riêng, rồi dọn khi hoàn tất.
Hướng dẫn chi tiết: [worker_image/README.md](worker_image/README.md).
Năm worker Chung kết được quản lý riêng theo [worker_ck/README.md](worker_ck/README.md). Cần migration Chung kết mới và năm token API riêng; worker rating không nhận trận Chung kết.
