# 🎮 OTTv2 Arena — Local Runner & Testing Kit

Bộ công cụ kiểm thử Agent trên máy tính cá nhân dành cho thí sinh tham gia giải đấu **OTTv2 Arena**.

---

## 📑 Mục lục
1. [Ưu điểm nổi bật](#1-ưu-điểm-nổi-bật)
2. [Cấu trúc thư mục](#2-cấu-trúc-thư-mục)
3. [Hướng dẫn sử dụng](#3-hướng-dẫn-sử-dụng)
4. [Lập trình Agent với Starter Template](#4-lập-trình-agent-với-starter-template)

---

## 1. Ưu điểm nổi bật
* **Zero Dependencies:** Hoạt động ngay chỉ với **Python 3.8+**, không cần cài thêm bất kỳ thư viện bên ngoài nào.
* **Mô phỏng 100% chuẩn Server:** Dùng chung Game Engine logic với hệ thống thi đấu chính thức.
* **Debug & Đo lường:** In log chi tiết, hiển thị trực quan bàn cờ trên terminal và đo thời gian xử lý CPU từng lượt đi.
* **Chế độ đa dạng:** Chạy 1 ván đơn, đấu thử với người (Human vs Bot), hoặc chạy hàng loạt 50–100 ván đổi bên để tính tỷ lệ thắng (Winrate).

---

## 2. Cấu trúc thư mục

```text
local_runner/
├── game_engine.py         # Engine 9x9 mô phỏng luật chơi chuẩn
├── runner.py              # CLI điều khiển trận đấu & in bàn cờ
├── sample_agents/
│   ├── starter_agent.py   # Khung code mẫu chuẩn để bắt đầu
│   ├── random_agent.py    # Bot đi ngẫu nhiên hợp lệ
│   └── greedy_agent.py    # Bot tham lam (bắt quân + tiến về đích)
└── README.md              # Tài liệu này
```

---

## 3. Hướng dẫn sử dụng

Di chuyển vào thư mục `local_runner/` và thực thi:

### A. Chạy 1 ván thử nghiệm giữa 2 bot:
```bash
python runner.py sample_agents/starter_agent.py sample_agents/random_agent.py
```

### B. Người tự tay đánh cờ với bot (Human Mode):
```bash
python runner.py human sample_agents/greedy_agent.py --render
```

### C. Đấu đối kháng hàng loạt 50 ván đổi bên để đo Winrate:
```bash
python runner.py sample_agents/greedy_agent.py sample_agents/random_agent.py --rounds 50 --switch-sides --quiet
```

---

## 4. Lập trình Agent với Starter Template

Mở file `sample_agents/starter_agent.py` và triển khai chiến thuật của bạn trong hàm `agent()`:

```python
def agent(observation, configuration):
    moves = observation.get("valid_moves", [])
    if not moves:
        return None
    
    # Ưu tiên các nước đi ăn quân đối phương
    capture_moves = [m for m in moves if m.get("is_capture")]
    if capture_moves:
        return capture_moves[0]
        
    return moves[0]
```

---
[⬅ Quay lại README Tổng](../README.md)
