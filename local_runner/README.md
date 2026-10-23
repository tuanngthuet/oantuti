# 🎮 OTTv2 Arena – Local Runner & Testing Kit

Bộ công cụ kiểm thử Agent trên máy cá nhân dành cho thí sinh tham gia giải đấu **OTTv2 Arena: AI Rock-Paper-Scissors Strategy Championship**.

Local Runner giúp bạn:
- Chạy mô phỏng trận đấu trực tiếp trên máy tính cá nhân mà không phụ thuộc vào server hay mạng internet.
- Tự do debug, in log, đo thời gian xử lý từng nước đi (CPU time).
- Chơi thử đối kháng trực tiếp bằng bàn phím (Human mode) với chính Agent do bạn viết.
- Chạy kiểm thử hàng loạt 50 – 100 ván đổi bên để đánh giá tỷ lệ thắng (Winrate) trước khi nộp lên sàn đấu.
- **Không yêu cầu cài đặt thư viện phụ thuộc (Zero Dependencies - chỉ cần Python 3.8 trở lên)**.

---

## 📥 1. Hướng dẫn Tải về (Download)

### Cách 1: Clone toàn bộ Repo bằng Git (Khuyên dùng)
```bash
git clone -b semi_final https://github.com/tuanngthuet/oantuti.git
cd oantuti/local_runner
```

### Cách 2: Tải riêng thư mục `local_runner`
Nếu bạn chỉ muốn lấy thư mục này, có thể tải về từ link GitHub:
👉 **[GitHub Repository: tuanngthuet/oantuti (Branch: semi_final)](https://github.com/tuanngthuet/oantuti/tree/semi_final/local_runner)**

---

## 📂 2. Cấu trúc Thư mục

```text
local_runner/
├── game_engine.py         # Engine mô phỏng luật chơi 9x9 (đúng 100% chuẩn Server)
├── runner.py              # CLI chạy trận đấu, trực quan hóa bàn cờ, thống kê Win/Loss
├── sample_agents/
│   ├── starter_agent.py   # Mẫu khung sườn chuẩn để bắt đầu lập trình
│   ├── random_agent.py    # Bot ngẫu nhiên hợp lệ
│   └── greedy_agent.py    # Bot chiến thuật tham lam (bắt quân + tiến về đích)
└── README.md              # Tài liệu hướng dẫn sử dụng
```

---

## 🚀 3. Hướng dẫn Chạy & Kiểm thử

Chạy các lệnh bên dưới trong thư mục `local_runner/`:

### A. Chạy thử 1 ván đơn giản giữa bot của bạn và bot ngẫu nhiên
```bash
python runner.py sample_agents/starter_agent.py
```

### B. Xem bàn cờ trực quan trên Terminal (`--render`)
```bash
python runner.py sample_agents/starter_agent.py sample_agents/greedy_agent.py --render --delay 0.2
```
> *Tùy chọn `--delay 0.2` dừng 0.2 giây sau mỗi nước để bạn kịp quan sát thế trận.*
> *Tùy chọn `--step` sẽ dừng lại sau mỗi nước và chờ bạn nhấn `Enter` để đi tiếp.*

### C. Chơi thử bằng tay với Bot của bạn (`human`)
```bash
python runner.py human sample_agents/greedy_agent.py --render
```
> *Khi tới lượt người chơi, bạn chỉ cần gõ nước đi dạng `c5 d6` (hoặc gõ số thứ tự nước đi được gợi ý).*

### D. Kiểm thử 50 ván có luân phiên đổi bên (`--rounds` & `--switch-sides`)
```bash
python runner.py my_agent.py sample_agents/greedy_agent.py --rounds 50 --switch-sides --quiet
```
Kết quả in ra bảng tổng kết:
```text
==================================================
📊 BẢNG TỔNG KẾT SAU 50 VÁN ĐẤU
==================================================
• my_agent.py         : Thắng 38 | Thua  8 | Hòa  4  -> Tỷ lệ thắng:  76.0%
• GreedyBot           : Thắng  8 | Thua 38 | Hòa  4  -> Tỷ lệ thắng:  16.0%
==================================================
```

### E. Xuất Replay ra file JSON (`--save-replay`)
```bash
python runner.py my_agent.py sample_agents/greedy_agent.py --save-replay match_replay.json
```

---

## 📖 4. Định dạng Hàm Agent chuẩn

File code nộp lên hệ thống bắt buộc phải chứa hàm định nghĩa:

```python
def agent(observation, configuration):
    valid_moves = observation.get("valid_moves", [])
    if not valid_moves:
        return None

    # Thuật toán tìm nước đi của bạn...
    
    # Trả về dict:
    return {
        "from_col": 2, "from_row": 3,
        "to_col": 3, "to_row": 4
    }
```

### Tham số `observation` chứa:
- `valid_moves`: Danh sách các nước đi hợp lệ `[{"from_col", "from_row", "to_col", "to_row", "is_capture"}]`
- `board`: Mảng 81 ô phẳng biểu diễn bàn cờ (hoặc `board_2d` dạng ma trận 9×9)
- `current_player`: `1` (Xanh, căn cứ a1, mục tiêu chiếm i9) hoặc `2` (Đỏ, căn cứ i9, mục tiêu chiếm a1)
- `piece_counts`: Số lượng quân mỗi bên: `{"1": {"ROCK": 3, "PAPER": 4, "SCISSORS": 3}, "2": {...}}`
- `move_count`: Số nước đi đã thực hiện

---

## ⏱️ 5. Lưu ý về Hiệu năng (Performance)

- **Giới hạn thời gian**: Server giải đấu giới hạn tối đa **1.0 giây CPU** cho mỗi nước đi.
- Runner cục bộ sẽ hiển thị cảnh báo `⚠️ Cảnh báo: P1 chạy mất X.XXs` nếu bot của bạn tính toán quá 1.0 giây.
- Khuyến nghị sử dụng các thuật toán như Minimax kèm cắt tỉa Alpha-Beta, Transposition Table, hoặc Heuristic Search giới hạn độ sâu (Depth 3–5) để đảm bảo thời gian phản hồi nhanh nhất.
