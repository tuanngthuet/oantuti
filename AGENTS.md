# AGENTS.md — Hướng dẫn Kiến trúc & Quy tắc Bất biến (Branch `ns`)

Tài liệu này dành cho các AI Coding Agents (Antigravity, Cursor, Claude Code, Codex, Copilot, v.v.) và lập trình viên khi đọc hiểu, bảo trì hoặc nâng cấp hệ thống **OTTv2 Arena (`oantuti` - branch `ns`)**.

> **QUAN TRỌNG**: Trước khi sửa bất kỳ logic nào, hãy đọc kỹ mục **3. Các Quy tắc Bất biến (Invariants)** bên dưới. Nhiều cơ chế trong hệ thống này được thiết kế có chủ đích và được khóa chặt bởi bộ Integration/Unit Test. Không tự ý thay đổi các cơ chế đó nếu không có yêu cầu rõ ràng.

---

## 1. Tổng quan Kiến trúc Hệ thống (4 Thành phần)

Hệ thống gồm 4 dịch vụ tách biệt:

1. **`Frontend/` (Next.js App Router + PostgreSQL/Neon)**:
   - Quản lý xác thực người dùng (`users`), đội thi (`teams`, `team_members`), nộp và kiểm duyệt agent (`arena_agents`), thử nghiệm cá nhân (`private_trials`), ghép cặp chấm điểm TrueSkill (`rating_matches`), thách đấu giao hữu (`friendly_matches`, `friendly_challenges`), và giao diện quản trị / vòng Chung kết (`finals`).
   - Kết nối trực tiếp tới PostgreSQL (qua `@neondatabase/serverless` hoặc PGlite trong môi trường test) trong [`Frontend/lib/db.ts`](./Frontend/lib/db.ts).
2. **`backend/` (FastAPI + Upstash Redis REST API)**:
   - Đóng vai trò hàng đợi trung gian (stateless queue) cho các tác vụ thực thi thông thường: `validation`, `rating_match`, `friendly_match`, `trial_match` và bước đi trực tiếp (`step_execution`).
   - Quản lý danh sách worker đăng ký, heartbeat, trạng thái điều khiển (`active` / `draining` / `disabled`) và cô lập keyspace bằng `REDIS_KEY_PREFIX` trong [`backend/app/redis_client.py`](./backend/app/redis_client.py).
   - **Không gọi Judge0 trực tiếp** (Judge0 chỉ được gọi từ `worker/` và `finals_runner/`).
3. **`worker/` (Python Async Worker + Supervisor + Judge0)**:
   - [`worker/supervisor.py`](./worker/supervisor.py): Đăng ký worker với `backend/`, giữ heartbeat định kỳ, nhận lệnh điều khiển (`drain`, `disable`, `max_concurrent`, `stop`) từ Admin và quản lý tiến trình con `worker.py`.
   - [`worker/worker.py`](./worker/worker.py): Poll/claim task từ `backend/` (hoặc gọi `/api/rating/dispatch` trên `Frontend/` khi hàng đợi rỗng), thực thi code Python của Agent trong hộp cát **Judge0**, chạy engine cờ [`worker/game_engine.py`](./worker/game_engine.py), và gửi kết quả kèm `execution_token` về `Frontend/`.
4. **`finals_runner/` (Standalone SQL-Only Finals Runner)**:
   - Công cụ chạy vòng Chung kết (Bracket / Best-of-N) **hoàn toàn độc lập**, giao tiếp trực tiếp với PostgreSQL schema `finals` (hoặc chạy offline qua bundle JSON) và Judge0.
   - Tuyệt đối không phụ thuộc vào Redis, `backend/`, hay `worker/`.

---

## 2. Cấu hình Biến môi trường (`.env`)

Các file `.env` thực tế không được commit lên Git. Khi thiết lập môi trường mới, hãy tham khảo 4 file mẫu:
- [`Frontend/.env.example`](./Frontend/.env.example) $\rightarrow$ copy thành `Frontend/.env.local`
- [`backend/.env.example`](./backend/.env.example) $\rightarrow$ copy thành `backend/.env`
- [`worker/.env.example`](./worker/.env.example) $\rightarrow$ copy thành `worker/.env`
- [`finals_runner/.env.example`](./finals_runner/.env.example) $\rightarrow$ cấu hình biến môi trường khi chạy `python -m finals_runner`

**Mối liên hệ giữa các Secret**:
- `INTERNAL_BACKEND_SECRET`: Phải khớp giữa `Frontend/.env.local` và `backend/.env` (dùng trong header `X-Internal-Secret` khi Frontend đẩy task sang Backend).
- `WORKER_SECRET`: Phải khớp giữa `backend/.env` và `worker/.env` (dùng trong header `X-Worker-Secret` khi Worker gọi Backend).
- `WORKER_CALLBACK_SECRET`: Phải khớp giữa `Frontend/.env.local` và `worker/.env` (dùng trong header `X-Worker-Callback-Secret` khi Worker gọi callback kết quả hoặc `/api/rating/dispatch` về Frontend).

---

## 3. Các Quy tắc Bất biến (Invariants) — KHÔNG TỰ Ý PHÁ VỠ

Khi đọc code để tối ưu hoặc sửa lỗi, **TUYỆT ĐỐI KHÔNG** thay đổi 5 thiết kế có chủ đích sau đây:

### Invariant 1: Một Participant (User hoặc Team) được phép có NHIỀU Agent `active` cùng lúc
- **Thiết kế chuẩn**: Một cá nhân hoặc một đội (`team`) có thể có nhiều agent ở trạng thái `status = 'active' AND is_active = true` và cùng được hệ thống xếp lịch đấu tính điểm TrueSkill.
- **Cách tính Bảng xếp hạng**: Hàm [`buildStandings`](./Frontend/lib/leaderboard.ts) trong [`Frontend/lib/leaderboard.ts`](./Frontend/lib/leaderboard.ts) sẽ gom nhóm theo `participant_key` (`team:{id}` hoặc `user:{id}`) và chỉ chọn **1 agent đủ điều kiện (`valid_games >= 10`) có điểm cao nhất** làm đại diện cho participant đó trên Bảng xếp hạng (tự động fallback xuống agent tiếp theo nếu agent cao nhất bị vô hiệu hóa).
- **Cấm làm**: Không được thêm lệnh tắt (`is_active = false`) các agent cũ của cùng user/team bên trong [`Frontend/app/api/rating/match-result/route.ts`](./Frontend/app/api/rating/match-result/route.ts) khi một agent mới vượt qua bước validation.
- **Test khóa**: [`Frontend/lib/leaderboard.integration.test.ts`](./Frontend/lib/leaderboard.integration.test.ts).

### Invariant 2: `finals_runner` cô lập hoàn toàn và KHÔNG tự ý xử thua khi lỗi
- **Cô lập import**: Bài test [`test_normal_engine_is_not_a_runtime_dependency`](./finals_runner/test_finals.py) dùng `ast.parse` kiểm tra toàn bộ `finals_runner/` để đảm bảo **không có bất kỳ lệnh import nào từ `worker` hoặc `backend`**. Vì vậy [`finals_runner/engine_v1.py`](./finals_runner/engine_v1.py) phải giữ nguyên là file độc lập, không được gộp chung với [`worker/game_engine.py`](./worker/game_engine.py).
- **Cơ chế trọng tài Admin (`needs_attention`)**: Khác với vòng đấu thường, ở vòng Chung kết ([`finals_runner/game.py`](./finals_runner/game.py) và [`finals_runner/__main__.py`](./finals_runner/__main__.py)), khi agent sinh nước đi không hợp lệ hoặc Judge0 gặp sự cố/timeout, hệ thống **không tự động xử thua (forfeit)** mà dừng ở trạng thái `needs_attention` để Admin quyết định trên trang quản trị.
- **Test khóa**: [`finals_runner/test_finals.py`](./finals_runner/test_finals.py) và [`Frontend/lib/finals.integration.test.ts`](./Frontend/lib/finals.integration.test.ts).

### Invariant 3: Giữ nguyên thứ tự gọi `sql` và `sqlTransaction` trong `match-result/route.ts`
- Trong [`Frontend/app/api/rating/match-result/route.ts`](./Frontend/app/api/rating/match-result/route.ts), luồng cập nhật kết quả trận đấu Rating thực hiện:
  1. `sql` lần 1: `SELECT` trạng thái trận đấu và `execution_token` từ `rating_matches`.
  2. `sql` lần 2: `SELECT` thông số TrueSkill (`trueskill_mu`, `trueskill_sigma`) từ `arena_agents`.
  3. `sqlTransaction`: Thực thi đúng **1 câu lệnh CTE nguyên tử (1 query)** để khóa dòng `rating_matches` (`WHERE rm.status = 'running'`) và cập nhật điểm + lịch sử.
- Hơn nữa, hàm SQL `reserve_rating_dispatch` đã chặn không cho bất kỳ agent nào có trận `pending`/`running` được ghép cặp chồng chéo.
- **Cấm làm**: Không thay đổi số lượng hoặc thứ tự gọi `sql` / `sqlTransaction` tại đây vì sẽ làm gãy unit test mock trong [`Frontend/lib/callbacks.test.ts`](./Frontend/lib/callbacks.test.ts).

### Invariant 4: Giữ nguyên `async with httpx.AsyncClient(...) as client:` trong từng hàm gọi HTTP của Python
- Trong [`backend/app/redis_client.py`](./backend/app/redis_client.py), [`worker/worker.py`](./worker/worker.py), [`worker/supervisor.py`](./worker/supervisor.py) và [`finals_runner/agent.py`](./finals_runner/agent.py), việc khởi tạo `async with httpx.AsyncClient(...) as client:` bên trong hàm giúp:
  1. Tránh lỗi đóng/mở `asyncio` event loop giữa các invocation trên môi trường Serverless (Vercel) và `asyncio.run()`.
  2. Tương thích 100% với cơ chế `monkeypatch.setattr(httpx, "AsyncClient", ...)` trong toàn bộ bộ test Python ([`backend/tests/test_redis_namespace.py`](./backend/tests/test_redis_namespace.py), [`backend/tests/test_worker.py`](./backend/tests/test_worker.py), [`finals_runner/test_finals.py`](./finals_runner/test_finals.py)).

### Invariant 5: Tương thích ngược của Schema trong `rating/status/route.ts`
- Bài test [`Frontend/lib/rating-scheduler.integration.test.ts`](./Frontend/lib/rating-scheduler.integration.test.ts) chỉ nạp schema đến bước `adaptive_rating_migration.sql` (trước khi có `teams_migration.sql`).
- Do đó, các câu truy vấn trong [`Frontend/app/api/admin/rating/status/route.ts`](./Frontend/app/api/admin/rating/status/route.ts) không được gọi trực tiếp hàm SQL `agent_participant_key()` hoặc cột `team_id` nếu không cập nhật đồng bộ migration trong bài test đó.

---

## 4. Thứ tự Nạp SQL Migrations (Frontend / PostgreSQL)

Khi khởi tạo database mới hoặc viết integration test với PGlite, các file SQL trong [`Frontend/`](./Frontend) được áp dụng theo thứ tự sau:
1. [`Frontend/database.sql`](./Frontend/database.sql) (Bảng `users` cơ bản)
2. [`Frontend/arena_schema.sql`](./Frontend/arena_schema.sql) (Bảng `arena_agents`, `friendly_matches`)
3. [`Frontend/rating_migration.sql`](./Frontend/rating_migration.sql) (Bảng `rating_matches`, `rating_history`, `rating_scheduler_state`)
4. [`Frontend/friendly_challenge_migration.sql`](./Frontend/friendly_challenge_migration.sql) (Bảng `friendly_challenges`)
5. [`Frontend/app_settings_migration.sql`](./Frontend/app_settings_migration.sql) (Bảng `app_settings`)
6. [`Frontend/execution_token_migration.sql`](./Frontend/execution_token_migration.sql) (Cột `execution_token` chống replay callback)
7. [`Frontend/adaptive_rating_migration.sql`](./Frontend/adaptive_rating_migration.sql) (Hàm chọn cặp đấu thích ứng `reserve_rating_dispatch`)
8. [`Frontend/private_trials_migration.sql`](./Frontend/private_trials_migration.sql) (Bảng `private_trials` cho thử nghiệm cá nhân)
9. [`Frontend/teams_migration.sql`](./Frontend/teams_migration.sql) (Bảng `teams`, `team_members`, hàm `agent_participant_key`, cập nhật `reserve_rating_dispatch` theo phạm vi đội)
10. [`Frontend/finals_migration.sql`](./Frontend/finals_migration.sql) (Schema độc lập `finals` cho vòng Chung kết)

---

## 5. Cách Chạy Kiểm thử (Tests)

Bộ test hoàn toàn chạy độc lập trên bộ nhớ (dùng PGlite và mock HTTP), **không cần kết nối DB hay Redis thật**:

### Frontend (Vitest)
```bash
cd Frontend
npm install
npm test
```

### Backend & Worker & Finals Runner (Pytest)
```bash
pytest backend/tests finals_runner/test_finals.py
```

### Đồng bộ Game Engine giữa Backend và Worker
Khi có thay đổi luật cờ trong [`backend/app/engine/game.py`](./backend/app/engine/game.py), chạy script:
```bash
./sync_engine.sh
```
*(Lưu ý: [`finals_runner/engine_v1.py`](./finals_runner/engine_v1.py) được đóng băng riêng cho luật Chung kết v1, không tự động ghi đè bằng `sync_engine.sh`).*
