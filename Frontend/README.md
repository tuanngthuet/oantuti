# 🌐 OTTv2 Arena — Frontend Application

Giao diện web trực tuyến của hệ thống **OTTv2 Arena**, được xây dựng trên nền tảng **Next.js 15 (App Router)**, **React 19**, **Tailwind CSS** và **Neon PostgreSQL**.

---

## 📑 Mục lục
1. [Tính năng chính](#1-tính-năng-chính)
2. [Cấu trúc thư mục](#2-cấu-trúc-thư-mục)
3. [Cấu hình biến môi trường](#3-cấu-hình-biến-môi-trường)
4. [Hướng dẫn cài đặt & Khởi chạy](#4-hướng-dẫn-cài-đặt--khởi-chạy)
5. [Cơ sở dữ liệu & Migration](#5-cơ-sở-dữ-liệu--migration)

---

## 1. Tính năng chính
* **Xác thực người dùng:** Đăng ký, đăng nhập bảo mật với Bcrypt và Session Token lưu trong `HttpOnly Cookie`.
* **Trình soạn thảo Agent (IDE):** Tích hợp **CodeMirror** (One Dark theme, highlight cú pháp Python, đếm ký tự đến 64KB).
* **Kiểm tra tính hợp lệ (Validation):** Gửi code chạy thử nghiệm 60 nước đi mẫu trong Sandbox trước khi lưu chính thức.
* **Đấu giao hữu riêng tư (`/arena/friendly`):** Ghép cặp bot cá nhân/team với bot công khai của đối thủ (tối đa 200 nước, 10 lượt/ngày, bảo mật Replay không lộ bài).
* **Bảng xếp hạng ELO (Leaderboard):** Tự động lọc **Best Agent** (mỗi người chơi/đội chỉ lấy 1 bot có ELO cao nhất để xếp hạng).
* **Interactive Replay Player:** Tua ván cờ, xem diễn biến từng nước đi với tốc độ tùy chỉnh (100ms – 2000ms/nước).
* **Quản trị Vòng Chung kết (`/admin/finals`):** Chốt Top 16 hạt giống, mở nhận bài theo từng vòng, khóa bài và mở đấu.

---

## 2. Cấu trúc thư mục

```text
Frontend/
├── app/                  # Next.js App Router (pages & server actions)
│   ├── (auth)/           # Đăng nhập, đăng ký
│   ├── admin/            # Trang quản trị (workers, finals, agent review)
│   ├── arena/            # Đấu giao hữu & đấu test
│   ├── finals/           # Sơ đồ và chi tiết Vòng Chung kết
│   ├── leaderboard/      # Bảng xếp hạng ELO Best Agent
│   └── replay/           # Trình phát lại ván đấu
├── components/           # UI Components (Board, Replay, Editor, Bracket)
├── lib/                  # Utilities, DB Client (Neon), Auth & ELO math
├── scripts/              # Scripts migration DB, seed demo, E2E test
├── public/               # Tài nguyên tĩnh (ảnh, icon quân cờ)
└── README.md             # Tài liệu này
```

---

## 3. Cấu hình biến môi trường

Sao chép `.env.example` thành `.env.local`:
```bash
cp .env.example .env.local
```

Các biến môi trường quan trọng:
* `DATABASE_URL`: Connection string kết nối cơ sở dữ liệu Neon PostgreSQL.
* `SESSION_SECRET`: Khóa bí mật ký JWT Session (tối thiểu 32 ký tự).
* `BACKEND_URL`: Địa chỉ Backend FastAPI (mặc định: `http://localhost:8000`).
* `INTERNAL_BACKEND_SECRET`: Khóa xác thực nội bộ khớp với Backend.
* `WORKER_CALLBACK_SECRET`: Khóa nhận callback kết quả từ Worker.
* `CK_WORKER_TOKENS`: JSON chứa 5 token xác thực cho 5 vòng Chung kết.

---

## 4. Hướng dẫn cài đặt & Khởi chạy

```bash
# 1. Cài đặt dependencies
npm install

# 2. Khởi chạy môi trường phát triển (Development)
npm run dev

# 3. Build & Chạy Production
npm run build
npm start
```

Truy cập ứng dụng tại: `http://localhost:3000`

---

## 5. Cơ sở dữ liệu & Migration

Để chuẩn bị dữ liệu cho hệ thống:
```bash
# Migration cho hệ thống Chung kết (Dry-run kiểm tra)
node scripts/migrate-finals.mjs

# Thực thi migration chính thức
node scripts/migrate-finals.mjs --apply

# Nạp dữ liệu tài khoản và bot mẫu (Test environment)
node scripts/seed-demo-data.mjs --apply
```

---
[⬅ Quay lại README Tổng](../README.md)
