# ⚙️ OTTv2 Arena — Backend API & Game Engine

Máy chủ backend của **OTTv2 Arena**, phát triển bằng **Python 3.10+** và **FastAPI**, chịu trách nhiệm điều phối trận đấu, quản lý vòng đời Agent, cung cấp API tính toán trạng thái và hàng đợi Worker.

---

## 📑 Mục lục
1. [Nhiệm vụ chính](#1-nhiệm-vụ-chính)
2. [Cấu trúc thư mục](#2-cấu-trúc-thư-mục)
3. [Cài đặt & Khởi động](#3-cài-đặt--khởi-động)
4. [Tài liệu API (Endpoints)](#4-tài-liệu-api-endpoints)
5. [Quy chuẩn Game Engine](#5-quy-chuẩn-game-engine)

---

## 1. Nhiệm vụ chính
* **Game Engine thuần Python (Pure Python 3):** Mô phỏng chính xác 100% luật chơi bàn cờ 9×9, kiểm tra nước đi hợp lệ (`valid_moves`), bắt lỗi phạm quy và xác định điều kiện thắng cuộc.
* **Match Lifecycle & Queue:** Tiếp nhận yêu cầu tạo trận (Friendly / Rating), điều phối hàng đợi và phân phối công việc cho các Worker.
* **Quản trị Worker (Worker Control):** Giám sát trạng thái hoạt động (Healthcheck), nhịp tim (Heartbeat) và tải của các worker node.

---

## 2. Cấu trúc thư mục

```text
backend/
├── app/
│   ├── engine/           # Pure Python Game Engine (game.py)
│   ├── routers/          # API Routers (friendly, rating, workers, health)
│   ├── services/         # Logic nghiệp vụ (match lifecycle, worker control)
│   ├── config.py         # Cấu hình biến môi trường
│   ├── main.py           # Entrypoint khởi tạo FastAPI
│   └── redis_client.py   # Kết nối hàng đợi Redis
├── agents/               # Code các agent mẫu (random_agent, greedy_agent)
├── requirements.txt      # Danh sách thư viện Python
└── README.md             # Tài liệu này
```

---

## 3. Cài đặt & Khởi động

```bash
# 1. Tạo và kích hoạt môi trường ảo
python3 -m venv venv
source venv/bin/activate  # Trên Windows: .\venv\Scripts\activate

# 2. Cài đặt dependencies
pip install -r requirements.txt

# 3. Cấu hình file .env
cp .env.example .env

# 4. Khởi động server (Development auto-reload)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Tài liệu API tương tác:
* **Swagger UI:** `http://localhost:8000/docs`
* **ReDoc:** `http://localhost:8000/redoc`

---

## 4. Tài liệu API (Endpoints chính)

| Method | Endpoint | Chức năng |
| :--- | :--- | :--- |
| `GET` | `/health` | Kiểm tra tình trạng kết nối backend & Redis |
| `POST` | `/api/friendly` | Tiếp nhận yêu cầu trận đấu giao hữu |
| `POST` | `/api/rating/enqueue` | Đẩy trận đấu xếp hạng vào hàng đợi |
| `GET` | `/api/workers/status` | Xem danh sách các worker đang kết nối |
| `POST` | `/api/workers/lease` | Worker nhận trận đấu mới để xử lý |

---

## 5. Quy chuẩn Game Engine

Tọa độ bàn cờ 9×9: cột `a`–`i` (chỉ số `0`–`8`), hàng `1`–`9` (chỉ số `0`–`8`).
* **P1 (Quân Xanh):** Căn cứ nhà `a1` (0,0), mục tiêu đánh chiếm `i9` (8,8).
* **P2 (Quân Đỏ):** Căn cứ nhà `i9` (8,8), mục tiêu đánh chiếm `a1` (0,0).
* **Quy luật ăn quân:** Đấm ✊ ăn Kéo ✌️, Kéo ✌️ ăn Lá ✋, Lá ✋ ăn Đấm ✊.

---
[⬅ Quay lại README Tổng](../README.md)
