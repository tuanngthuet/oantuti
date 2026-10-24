# 🐳 OTTv2 Arena — Python Sandbox Worker (Rating & Friendly)

Image Worker độc lập dùng để xử lý các trận đấu xếp hạng (Rating) và giao hữu (Friendly). Tích hợp sẵn supervisor, runtime, game engine và sandbox **Bubblewrap** trong một container duy nhất.

---

## 📑 Mục lục
1. [Cơ chế hoạt động](#1-cơ-chế-hoạt-động)
2. [Cấu trúc mã nguồn](#2-cấu-trúc-mã-nguồn)
3. [Cấu hình biến môi trường](#3-cấu-hình-biến-môi-trường)
4. [Khởi chạy với Docker Compose](#4-khởi-chạy-với-docker-compose)
5. [Cơ chế bảo mật Sandbox](#5-cơ-chế-bảo-mật-sandbox)

---

## 1. Cơ chế hoạt động
Worker hoạt động theo mô hình kéo (Pull-based queue):
1. Gửi heartbeat định kỳ và lease trận đấu từ Backend FastAPI.
2. Nạp mã nguồn 2 Agent vào môi trường sandbox cô lập.
3. Cho 2 Agent đối đầu từng lượt thông qua Game Engine nội bộ (giới hạn tối đa 200 nước).
4. Đóng gói kết quả trận đấu, log từng nước đi và callback trực tiếp về Frontend Next.js.

---

## 2. Cấu trúc mã nguồn

```text
worker_image/
├── compose.yaml          # File định nghĩa Docker Compose service
├── Dockerfile            # Định nghĩa image có sẵn Bubblewrap + Python
├── game_engine.py        # Bản sao engine đảm bảo tính nhất quán
├── main.py               # Entrypoint khởi động worker
├── runner.py             # Điều phối vòng lặp lượt đi giữa 2 bot
├── sandbox_launcher.py   # Cấu hình bubblewrap tạo user namespace
├── supervisor.py         # Quản lý tiến trình và xử lý timeout
├── worker.py             # Giao tiếp API với Backend & Frontend
└── README.md             # Tài liệu này
```

---

## 3. Cấu hình biến môi trường

Sao chép `.env.example` thành `.env`:
```bash
cp worker_image/.env.example worker_image/.env
```

* `BACKEND_URL`: URL Backend (`http://host.docker.internal:8000`).
* `FRONTEND_URL`: URL Frontend nhận callback (`http://host.docker.internal:3000`).
* `WORKER_SECRET`: Khóa bí mật xác thực với Backend.
* `WORKER_CALLBACK_SECRET`: Khóa bí mật gửi kết quả về Frontend.
* `WORKER_ID`: Tên định danh duy nhất của Worker.
* `AGENT_CPU_SECONDS`: Giới hạn CPU (mặc định: `2` giây).
* `AGENT_WALL_SECONDS`: Giới hạn thời gian thực (mặc định: `4` giây).
* `AGENT_MEMORY_MB`: Giới hạn RAM (mặc định: `128` MB).

---

## 4. Khởi chạy với Docker Compose

Sử dụng script tiện ích từ repository root:
```bash
# Build và chạy worker
./dockerworker.sh

# Xem log thực thi
./dockerworker.sh logs

# Dừng worker
./dockerworker.sh stop
```

---

## 5. Cơ chế bảo mật Sandbox
* **Chặn mạng hoàn toàn:** Không có quyền truy cập Internet hay socket mạng nội bộ.
* **Hạn chế Syscalls (Seccomp):** Chặn các lệnh fork bom, tạo tiến trình con (`subprocess`).
* **Hệ thống tệp chỉ đọc (Read-only Filesystem):** Không thể chỉnh sửa hay đọc trộm mã nguồn của đối thủ hoặc file hệ thống của host.

---
[⬅ Quay lại README Tổng](../README.md)
