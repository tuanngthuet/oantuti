# 🏆 OTTv2 Arena — Hệ Thống Thi Đấu Agent AI Oẳn Tù Tì

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-15-black?style=for-the-badge&logo=next.js" alt="Next.js 15" />
  <img src="https://img.shields.io/badge/FastAPI-0.100+-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/PostgreSQL-Neon-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/Docker-Sandbox-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/TailwindCSS-Brutalist-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind CSS" />
</p>

---

## 📑 Mục lục
1. [Giới thiệu](#1-giới-thiệu)
2. [Kiến trúc hệ thống](#2-kiến-trúc-hệ-thống)
3. [Tính năng nổi bật](#3-tính-năng-nổi-bật)
4. [Thể lệ cuộc thi & Luật chơi](#4-thể-lệ-cuộc-thi--luật-chơi)
5. [Quy chuẩn kỹ thuật khi lập trình Agent](#5-quy-chuẩn-kỹ-thuật-khi-lập-trình-agent)
6. [Quy trình tổ chức giải đấu](#6-quy-trình-tổ-chức-giải-đấu)
7. [Hướng dẫn khởi chạy & Cài đặt](#7-hướng-dẫn-khởi-chạy--cài-đặt)

---

## 1. Giới thiệu

**OTTv2 Arena** (Oẳn Tù Tì v2) là nền tảng thi đấu và đánh giá năng lực tự động giữa các Agent AI. Dựa trên biến thể trò chơi dân gian Oẳn Tù Tì kết hợp cùng tư duy chiến thuật cờ bàn (board game) trên lưới 9×9, hệ thống cung cấp một sân chơi đối kháng khép kín, công bằng và khách quan cho sinh viên.

Dự án được xây dựng trong khuôn khổ môn học Lập trình mạng (INT3304 3) — Trường Đại học Công nghệ, ĐHQGHN (VNU-UET).

### 👥 Nhóm thực hiện: Nhóm 1
1. **Nguyễn Thiên Tuấn**
2. **Bùi Thanh Sơn**
3. **Phạm Gia Hưng**
4. **Nguyễn Văn Tuyên**

---

## 2. Kiến trúc hệ thống

Dự án áp dụng mô hình phân tán giữa tầng hiển thị trực tuyến, cơ sở dữ liệu phi máy chủ (Serverless), và cụm xử lý/chấm điểm trận đấu độc lập bảo mật.

### 2.1. Sơ đồ kiến trúc tổng quan

```text
               Người dùng (Trình duyệt Web)
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│               Frontend (Next.js 15 App)                │  ← Always-online (Vercel)
│  - Authentication, Quản lý tài khoản (JWT, Bcrypt)     │
│  - Trình soạn thảo Code (CodeMirror Python)            │
│  - Bảng xếp hạng ELO, Replay Player, Dashboard         │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
        (Kết nối Database)         (Khi chạy trận / validate)
               ▼                          ▼
┌──────────────────────────────┐   ┌──────────────────────────────┐
│       Neon PostgreSQL        │   │    Cloudflare Tunnel         │  ← Reverse Proxy HTTPS
│       (Serverless DB)        │   └──────────────┬───────────────┘
│  - Users, Agents, Elo Stats  │                  ▼
│  - Matches, Moves Replay     │   ┌──────────────────────────────┐
│  - Tournament Sessions       │   │    FastAPI Backend Server    │  ← Localhost :8000
└──────────────────────────────┘   │  ├── Match Service (Vòng đời)│
                                   │  ├── Game Engine (Pure Python│
                                   │  └── Queue / Sandbox Adapter │
                                   └──────────────┬───────────────┘
                                                  ▼
                                   ┌──────────────────────────────┐
                                   │  Execution Sandbox / Worker  │  ← Docker Container
                                   │  (Judge0 CE / Bubblewrap)    │
                                   │  Thực thi Python 3 an toàn   │
                                   │  Giới hạn RAM, CPU, Timeout  │
                                   └──────────────────────────────┘
```

### 2.2. Chi tiết các thành phần công nghệ

| Thành phần | Công nghệ sử dụng | Nhiệm vụ chính |
| :--- | :--- | :--- |
| **Frontend** | Next.js 15, React 19, Tailwind CSS | Giao diện phong cách Neo-Brutalist phẳng, hiển thị bàn cờ thời gian thực, quản lý thí sinh và phân tích ván đấu. |
| **Backend API** | Python 3.10+, FastAPI, Uvicorn | Quản lý vòng đời trận đấu, điều phối hàng đợi (Queue), xác thực lease và tính toán trạng thái bàn cờ. |
| **Game Engine** | Pure Python 3 | Mô phỏng chính xác logic bàn cờ 9×9, kiểm tra tính hợp lệ của từng nước đi, xác định trạng thái kết thúc trận. |
| **Execution Sandbox**| Docker (Judge0 CE / Bubblewrap) | Chạy mã nguồn Python của thí sinh trong môi trường cô lập nghiêm ngặt (Isolated Sandbox), kiểm soát CPU, RAM và Timeout. |
| **Database** | PostgreSQL (Neon Database) | Lưu trữ người dùng, phiên bản mã nguồn Agent, lịch sử từng nước đi (`history replay`), bảng điểm ELO. |
| **Network & Proxy** | Cloudflare Tunnel | Mở kênh kết nối an toàn (TLS Reverse Proxy) từ Internet về máy chủ chấm cục bộ mà không cần mở Port NAT. |

---

## 3. Tính năng nổi bật

### 3.1. Dành cho Thí sinh (Người chơi)
* **Xác thực an toàn:** Đăng ký, đăng nhập bảo mật bằng JWT lưu trong `HttpOnly Cookie`, mật khẩu được mã hóa chuẩn Bcrypt.
* **Soạn thảo & Nộp Agent trực quan:**
  * Trình soạn thảo tích hợp **CodeMirror** (hỗ trợ gợi ý cú pháp Python, giao diện One Dark, đếm dung lượng mã nguồn giới hạn 64KB).
  * Chức năng **"🔍 Kiểm tra tính hợp lệ"**: Tự động gửi code vào Sandbox chạy thử nghiệm một lượt đi thực tế trước khi lưu chính thức.
  * Quản lý phiên bản bot (`v1`, `v2`,...), theo dõi trạng thái phê duyệt (`Pending`, `Active`, `Rejected`).
* **Đấu giao hữu trực quan (Friendly Match):**
  * Tùy chọn 2 bot AI bất kỳ để thi đấu 1v1 ngay trên bàn cờ trực tiếp mà không ảnh hưởng điểm xếp hạng.
  * Cập nhật từng nước đi theo thời gian thực mượt mà thông qua cơ chế **Server-Sent Events (SSE)**.
* **Hệ thống Rank ELO & Bảng xếp hạng:**
  * Hệ thống tính điểm ELO động phản ánh chính xác trình độ bot qua từng trận:
    * 👑 **Grandmaster** (ELO ≥ 2000)
    * 💎 **Master** (ELO ≥ 1800)
    * 🔷 **Expert** (ELO ≥ 1600)
    * 🟢 **Intermediate** (ELO ≥ 1400)
    * ⚪ **Novice** (ELO < 1400)
  * Thống kê trực quan số trận Thắng / Thua / Hòa và tỷ lệ thắng tổng quát.
* **Trình phát lại ván cờ (Interactive Replay Player):**
  * Tải và phát lại chi tiết từng lượt đi của bất kỳ ván đấu nào trong lịch sử.
  * Thanh trượt tua thời gian, bộ nút điều khiển đa dạng (*Về đầu, Lùi bước, Tự động phát, Tiến bước, Về cuối*), tùy chỉnh tốc độ từ 100ms – 2000ms/bước.

### 3.2. Dành cho Ban tổ chức (Quản trị viên - Admin)
* **Kiểm duyệt Agent:** Thẩm định mã nguồn của thí sinh, chạy thử nghiệm sandbox trước khi phê duyệt tham gia đấu giải chính thức.
* **Quản trị Tournament & Worker Session:**
  * Thiết lập phiên giải đấu, điều chỉnh số trận chạy song song (Concurrency).
  * Bật/tắt các Worker tự động bốc thăm ghép cặp vòng tròn (Round-Robin).
* **Playground Test Bot:** Giao diện ghép cặp thủ công nhanh chóng phục vụ mục đích gỡ lỗi (debug) và đánh giá chiến thuật.
* **Quản lý & Cấu hình:** Xem toàn bộ lịch sử đấu, dọn dẹp dữ liệu rác, linh hoạt cập nhật URL kết nối Backend Tunnel.

---

## 4. Thể lệ cuộc thi & Luật chơi

### 4.1. Quy chuẩn bàn cờ & Bố trí ban đầu
* **Kích thước bàn cờ:** Bàn cờ lưới vuông **9 × 9 ô**, cột ký hiệu từ `a` đến `i` (chỉ số 0 đến 8), hàng ký hiệu từ `1` đến `9` (chỉ số 0 đến 8).
* **Các loại quân cờ:** Mỗi người chơi sở hữu 10 quân cờ thuộc 3 chủng loại:
  * ✊ **ĐẤM (ROCK):** 3 quân
  * ✋ **LÁ (PAPER):** 4 quân
  * ✌️ **KÉO (SCISSORS):** 3 quân
* **Tọa độ xuất phát ban đầu:**
  * **Người chơi 1 (P1 - Quân Xanh):** Xuất phát góc dưới bên trái, căn cứ nhà cần bảo vệ tại **`a1`**, mục tiêu đánh chiếm là căn cứ **`i9`**.
    * ✌️ Kéo (3): `5c`, `4d`, `3e`
    * ✋ Lá (4): `5b`, `4c`, `3d`, `2e`
    * ✊ Đấm (3): `4b`, `3c`, `2d`
  * **Người chơi 2 (P2 - Quân Đỏ):** Xuất phát góc trên bên phải, căn cứ nhà cần bảo vệ tại **`i9`**, mục tiêu đánh chiếm là căn cứ **`a1`**.
    * ✌️ Kéo (3): `7e`, `6f`, `5g`
    * ✋ Lá (4): `8e`, `7f`, `6g`, `5h`
    * ✊ Đấm (3): `8f`, `7g`, `6h`

### 4.2. Quy tắc di chuyển & Cơ chế ăn quân
* **Di chuyển:** Mỗi lượt, một quân cờ có thể di chuyển **1 ô** theo **8 hướng** (ngang, dọc, chéo – tương tự như nước đi của quân Vua trong cờ vua).
* **Quy luật ăn quân (Tương khắc Oẳn Tù Tì):**
  * ✊ **ĐẤM** ăn ✌️ **KÉO**
  * ✋ **LÁ** ăn ✊ **ĐẤM**
  * ✌️ **KÉO** ăn ✋ **LÁ**
* **Ràng buộc di chuyển:**
  * Hai quân **cùng loại không thể ăn nhau** (không thể đi vào ô có quân cùng loại của đối phương).
  * Quân cờ **không được di chuyển vào ô đang có quân của phe mình**.

### 4.3. Điều kiện định đoạt kết quả
Trận đấu kết thúc ngay lập tức khi xuất hiện một trong các trường hợp sau:

1. **Chiếm cứ điểm đối phương:**
   * **P1 thắng:** Đưa bất kỳ một quân cờ nào của mình tiến vào căn cứ **`i9`**.
   * **P2 thắng:** Đưa bất kỳ một quân cờ nào của mình tiến vào căn cứ **`a1`**.
2. **Tuyệt diệt quân chủng đối phương:**
   * Thắng ngay khi tiêu diệt hết toàn bộ một chủng loại quân bất kỳ của đối thủ (ăn sạch 3 quân Đấm, HOẶC sạch 4 quân Lá, HOẶC sạch 3 quân Kéo).
3. **Xử thua kỹ thuật (Disqualification):**
   * **Quá thời gian (Timeout):** Agent xử lý vượt quá giới hạn **10 giây / nước đi**.
   * **Nước đi phạm quy (Illegal Move):** Trả về nước đi không nằm trong danh sách nước đi hợp lệ (`valid_moves`).
   * **Lỗi thực thi (Runtime Error):** Mã nguồn phát sinh ngoại lệ không bắt được (Crash/Exception) trong môi trường Sandbox.
   * **Đầu hàng:** Agent chủ động trả về `None` khi bàn cờ vẫn còn nước đi hợp lệ.
4. **Hòa cờ (Draw):**
   * Trận đấu vượt quá số lượt đi tối đa quy định (mặc định 200 – 300 nước) mà chưa có bên nào đạt điều kiện thắng.

---

## 5. Quy chuẩn kỹ thuật khi lập trình Agent

Mỗi Agent nộp lên phải là một tập lệnh Python 3 hợp lệ chứa hàm entry-point `agent(observation, configuration)` theo chuẩn:

```python
def agent(observation, configuration):
    """
    Args:
        observation (dict):
            - valid_moves (list[dict]): Danh sách các nước đi hợp lệ ở lượt hiện tại:
                [
                    {
                        "from_col": int,  # Cột bắt đầu (0-8, tương ứng a-i)
                        "from_row": int,  # Hàng bắt đầu (0-8, tương ứng 1-9)
                        "to_col": int,    # Cột đích (0-8)
                        "to_row": int,    # Hàng đích (0-8)
                        "is_capture": bool # Có phải nước đi ăn quân đối thủ không
                    },
                    ...
                ]
            - board (list[dict|None]): Mảng 1 chiều 81 ô (row-major: index = row * 9 + col).
                Mỗi phần tử là None hoặc {"player": 1|2, "type": "ROCK"|"PAPER"|"SCISSORS"}
            - current_player (int): Lượt của người chơi hiện tại (1 hoặc 2)
            - piece_counts (dict): Số lượng quân còn lại của 2 bên:
                {
                    "1": {"ROCK": int, "PAPER": int, "SCISSORS": int},
                    "2": {"ROCK": int, "PAPER": int, "SCISSORS": int}
                }
            - move_count (int): Tổng số nước đi đã diễn ra trong ván đấu
        configuration (dict): Các thông số cấu hình bổ sung từ hệ thống (nếu có).

    Returns:
        dict: Nước đi được lựa chọn dưới dạng:
            {"from_col": int, "from_row": int, "to_col": int, "to_row": int}
        hoặc None (để chấp nhận đầu hàng).
    """
    moves = observation.get("valid_moves", [])
    if not moves:
        return None
    
    # Chiến thuật ví dụ: Ưu tiên nước đi ăn quân đối phương
    capture_moves = [m for m in moves if m.get("is_capture")]
    selected_move = capture_moves[0] if capture_moves else moves[0]

    return {
        "from_col": selected_move["from_col"],
        "from_row": selected_move["from_row"],
        "to_col": selected_move["to_col"],
        "to_row": selected_move["to_row"]
    }
```

### ⚙️ Giới hạn & Ràng buộc môi trường:
* **Ngôn ngữ:** Python 3.10+
* **Thư viện cho phép:** Chỉ được sử dụng các thư viện chuẩn (Standard Library) của Python như: `math`, `random`, `time`, `collections`, `heapq`, `copy`, `itertools`, `functools`... **Không hỗ trợ** các thư viện bên thứ ba cài ngoài như `numpy`, `pandas`, `scipy`...
* **Giới hạn tài nguyên:**
  * **Thời gian tính toán:** Tối đa **10 giây / lượt đi**.
  * **Kích thước mã nguồn:** Tối đa **65,536 ký tự** (~64 KB).
  * **Bộ nhớ:** Tối đa **128 MB RAM** cho mỗi tiến trình con trong Sandbox.

---

## 6. Quy trình giải đấu

Hệ thống thi đấu của **OTTv2 Arena** được tổ chức với tính cạnh tranh gồm 3 chế độ thi đấu:

### 6.1. Chế độ Giao hữu (Private Friendly Match)
* **Thử nghiệm & Gỡ lỗi:** Thí sinh tự do ghép cặp 1v1 giữa bot của mình với một bot công khai bất kỳ của đối thủ để kiểm tra tính hiệu quả của chiến thuật.
* **Bảo mật Replay:** Chỉ người tạo trận hoặc thành viên cùng đội mới có quyền xem log và Replay ván cờ. Đối thủ **không nhận thông báo và không xem được kết quả/replay**, ngăn chặn hoàn toàn việc bị nghiên cứu chiến thuật trước giải.
* **Quy chuẩn:** Cấp hạn mức 10 trận/ngày/tài khoản; kết quả **không làm thay đổi điểm ELO**.

### 6.2. Vòng bảng & Bảng xếp hạng ELO (Best Agent Leaderboard)
* **Matchmaking tự động:** Hệ thống Worker ngầm liên tục bốc thăm ghép cặp các Agent `Public` để thi đấu tích lũy điểm ELO theo công thức chuẩn.
* **Cơ chế "Best Agent" trên BXH:**
  * Thí sinh có thể nộp và phát triển nhiều phiên bản bot (`v1`, `v2`, `v3`...).
  * Trên Bảng xếp hạng chung (Leaderboard), mỗi cá nhân hoặc đội **chỉ xuất hiện đúng 1 vị trí đại diện duy nhất** tương ứng với **Agent sở hữu ELO cao nhất (Best Agent)** của họ.
  * *Ý nghĩa:* Ngăn chặn tình trạng một đội mạnh spam nhiều bot để chiếm trọn Top đầu, đảm bảo bảng xếp hạng đa dạng, khách quan và công bằng.
* **Phân cấp danh hiệu ELO:** 👑 *Grandmaster* (≥ 2000), 💎 *Master* (≥ 1800), 🔷 *Expert* (≥ 1600), 🟢 *Intermediate* (≥ 1400), ⚪ *Novice* (< 1400).
* **Chốt sổ vòng bảng:** Căn cứ bảng xếp hạng Best Agent tại thời điểm đóng sổ để chọn ra **Top 16 hạt giống** bước vào vòng Chung kết.

### 6.3. Vòng Chung kết (Finals Top 16 — Loại trực tiếp)
* **Nhánh đấu 5 vòng:** Vòng 1/8 (`round_16`) --> Tứ kết (`quarterfinal`) --> Bán kết (`semifinal`) --> Chung kết (`final`) & Tranh hạng ba (`third_place`).
* **Thể thức 2 ván đổi bên (Home/Away Swap):** Mỗi cặp đấu gồm 2 ván, bắt buộc hoán đổi vị trí cầm quân Xanh (P1) và Đỏ (P2) để triệt tiêu lợi thế đi trước. Nếu hòa điểm (1 - 1), hạt giống có thứ hạng vòng bảng cao hơn sẽ giành quyền đi tiếp.
* **Nộp bài độc lập từng vòng (Per-round Submissions):** Hệ thống **không tự động lấy code vòng bảng**. Mỗi vòng đấu knock-out, thí sinh phải nộp lại code riêng (được quyền chỉnh sửa để khắc chế đối thủ tiếp theo) và phải vượt qua bài kiểm tra Self-play với đúng Engine của vòng đó.
* **5 Cụm Worker Sandbox độc lập:** Mỗi vòng chạy trên 1 container Worker riêng biệt với Bubblewrap sandbox cô lập hoàn toàn mạng, file hệ thống và bộ nhớ.
* **Replay về giải:** Admin khóa mã nguồn trước giờ đấu, tự động ghi nhận kết quả và công bố Replay công khai cho khán giả theo dõi.

---

## 7. Hướng dẫn khởi chạy & Cài đặt

### 7.1. Yêu cầu hệ thống
* Hệ điều hành: Linux (Ubuntu 20.04+ khuyến nghị) hoặc Windows 11 với WSL 2.
* Python 3.10+ và Node.js 18.x / 20.x.
* Docker Engine & Docker Compose.

### 7.2. Cấu hình biến môi trường
Sao chép các file cấu hình mẫu và cập nhật các thông số cần thiết:
```bash
# 1. Cấu hình Backend
cp backend/.env.example backend/.env

# 2. Cấu hình Frontend
cp Frontend/.env.example Frontend/.env.local

# 3. Cấu hình Worker Sandbox
cp worker_image/.env.example worker_image/.env
```

### 7.3. Khởi động nhanh toàn bộ dịch vụ (Development)
Sử dụng bộ kịch bản tự động được chuẩn bị sẵn trong thư mục gốc:

```bash
# Bước 1: Cài đặt toàn bộ môi trường và dependencies
./setup.sh

# Bước 2: Khởi động toàn bộ các dịch vụ (Backend, Frontend, Sandbox)
./start.sh
```

### 7.4. Các địa chỉ truy cập cục bộ:
* **Frontend Web:** `http://localhost:3000`
* **FastAPI Docs (Swagger UI):** `http://localhost:8000/docs`
* **FastAPI ReDoc:** `http://localhost:8000/redoc`
* **Sandbox Engine Health:** `http://localhost:8000/health`

Để dừng toàn bộ dịch vụ đang chạy:
```bash
./stop.sh
```

