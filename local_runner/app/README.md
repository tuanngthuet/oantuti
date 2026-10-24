# Bộ test agent local

Người chơi: giải nén, mở `Chay.cmd`, bấm **Chạy thử với Greedy**. Chỉ sửa
`my_agent.py` ở ngoài thư mục `app`, lưu rồi chạy lại. Hướng dẫn đầy đủ nằm ở
`HUONG_DAN.html` và nút **Bắt đầu từ số 0** trong giao diện.

Linux: giải nén, mở Terminal tại nơi có `my_agent.py`, chạy `bash app/Chay.sh`.
Không cần chmod, sudo hoặc pip. Hướng dẫn riêng cho người mới nằm trong
`HUONG_DAN_LINUX.html`, mở trực tiếp offline hoặc từ hướng dẫn trên giao diện.
Script hỗ trợ `--no-browser` và chạy được từ thư mục làm việc khác khi dùng
đường dẫn đầy đủ đến script.

Chạy từ repository root, không cần dependency:

```bash
python3 -B local_runner/app/start.py
python3 -B -m unittest discover -s local_runner/app/tests -v
python3 -B local_runner/app/build_bundle.py
node local_runner/app/tests/browser_smoke.mjs
```

ZIP phát hành nằm tại `local_runner/app/dist/Oantuti-Local.zip`. Script build
lấy engine và Greedy trực tiếp từ nguồn hiện tại, không đưa log, test, secrets,
kết quả hoặc mã build vào ZIP. Trước khi phát hành, kiểm tra engine/Greedy dùng
trong checkout local vẫn khớp nguồn; ZIP luôn lấy bản nguồn mới nhất.

Kiểm tra trên Windows có Python 3.10+: giải nén vào đường dẫn có khoảng trắng và
tiếng Việt, nhấp đúp launcher, chạy mẫu, sửa file/lưu/chạy lại, kiểm tra báo lỗi
đúng dòng, tua khi live, dừng trận, tải HTML offline và thoát công cụ. Máy build
Linux không thay thế cho kiểm thử launcher thực tế trên Windows.

Local server chỉ bind loopback, cổng tự chọn; thao tác thay đổi trạng thái cần
token của phiên và đúng Host. Agent là code tin cậy, không có sandbox. Mỗi lượt
là process Python mới, stdlib, 12 giây wall time, tổng output 64 KiB; không áp
giới hạn CPU/RAM như server. Ctrl+C và nút thoát hủy agent đang chạy. Đóng tab
không dừng server. Muốn chạy trên macOS/Linux: dùng lệnh Python ở trên.
Kiểm thử trình duyệt dành cho phát triển dùng Playwright đã có trong Frontend;
người chơi chỉ cần Python và trình duyệt. Bài kiểm thử giải nén ZIP vào đường dẫn
có tiếng Việt/khoảng trắng rồi gọi chính `app/Chay.sh` từ thư mục làm việc khác.

API nội bộ: `GET /api/state`, `POST /api/start`, `/api/stop`, `/api/quit`;
`GET /download/replay`, `/download/json`. Đây là API riêng của công cụ local,
không thay đổi hệ thống thi đấu. Một trận mỗi server; kết quả tự lưu dưới
`app/results/<id>/`. `--no-browser` dành cho kiểm tra tự động.
