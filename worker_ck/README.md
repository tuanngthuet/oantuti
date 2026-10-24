# 🏅 OTTv2 Arena — Finals Workers (Cụm Chấm Vòng Chung Kết)

Hệ thống chấm thi độc lập dành riêng cho **Vòng Chung kết Top 16**, bao gồm 5 dịch vụ worker chạy tách biệt hoàn toàn ứng với 5 vòng đấu loại trực tiếp.

---

## 📑 Mục lục
1. [Kiến trúc 5 cụm Worker](#1-kiến-trúc-5-cụm-worker)
2. [Cấu trúc thư mục](#2-cấu-trúc-thư-mục)
3. [Quy trình cấu hình Credential](#3-quy-trình-cấu-hình-credential)
4. [Khởi chạy dịch vụ](#4-khởi-chạy-dịch-vụ)
5. [Chế độ chạy Offline & Trọng tài](#5-chế-độ-chạy-offline--trọng-tài)

---

## 1. Kiến trúc 5 cụm Worker

Nhằm đảm bảo tính bảo mật và công bằng tối đa, mỗi vòng đấu sở hữu một Worker riêng với API Token và Engine Checksum độc lập:
* `round_16` (Vòng 1): 16 đội $\rightarrow$ 8 cặp đấu.
* `quarterfinal` (Vòng 2): Tứ kết 8 đội $\rightarrow$ 4 cặp đấu.
* `semifinal` (Vòng 3): Bán kết 4 đội $\rightarrow$ 2 cặp đấu.
* `final` (Vòng 4): Trận Chung kết tranh chức Vô địch.
* `third_place` (Vòng 5): Trận Tranh hạng ba.

---

## 2. Cấu trúc thư mục

```text
worker_ck/
├── common/               # Thư viện khung chung, sandbox runner
├── round_16/             # Engine & cấu hình cho Vòng 1/8
├── quarterfinal/         # Engine & cấu hình cho Tứ kết
├── semifinal/            # Engine & cấu hình cho Bán kết
├── final/                # Engine & cấu hình cho Chung kết
├── third_place/          # Engine & cấu hình cho Tranh hạng ba
├── compose.yaml          # File compose chạy cả 5 worker
├── configure.py          # Script tự động sinh token an toàn
└── README.md             # Tài liệu này
```

---

## 3. Quy trình cấu hình Credential

Từ thư mục gốc dự án, tạo bộ credential riêng cho từng vòng:
```bash
python3 worker_ck/configure.py --url http://host.docker.internal:3000
```

Script sẽ tạo 5 file bí mật `.env.<tên_worker>` và `worker_ck/.env.frontend`. Đưa nội dung biến `CK_WORKER_TOKENS` vào file `Frontend/.env.local`.

---

## 4. Khởi chạy dịch vụ

```bash
# 1. Build images cho cả 5 vòng
docker compose -f worker_ck/compose.yaml build

# 2. Kiểm tra tính toàn vẹn của Sandbox trước khi chạy
for worker in round_16 quarterfinal semifinal final third_place; do
  docker compose -f worker_ck/compose.yaml run --rm "$worker" --check || break
done

# 3. Khởi chạy toàn bộ cụm worker nền
docker compose -f worker_ck/compose.yaml up -d
```

---

## 5. Chế độ chạy Offline & Trọng tài

Ban tổ chức có thể tải gói dữ liệu bảo mật (`finals.bundle.json`) chứa mã nguồn đã khóa để chạy đối kháng offline trên máy trọng tài, không cần kết nối mạng:

```bash
python3 -m worker_ck.round_16 \
  --bundle /private/finals.bundle.json \
  --game 1 \
  --output /private/game-1.record.json
```
Bản ghi xuất ra chứa đầy đủ snapshot từng nước đi và được nhập vào hệ thống để công bố Replay công khai.

---
[⬅ Quay lại README Tổng](../README.md)
