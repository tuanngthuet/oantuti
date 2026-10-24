# Cài Oantuti Worker

Cần máy Intel/AMD 64-bit có Docker và Compose. Trên Windows, mở
[Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
với WSL 2 / Linux containers. Trên Linux, cài
[Docker Engine](https://docs.docker.com/engine/install/) và Compose plugin.

Gói đã chứa image và hai URL Vercel. Sau giải nén, mở `.env.example`, điền
`WORKER_SECRET` và `WORKER_CALLBACK_SECRET`, rồi lưu thành `.env`. Chỉ làm một lần.

## Linux

Tải:

```bash
wget -O oantuti-worker.zip "https://github.com/tuanngthuet/oantuti/releases/download/worker-portable-v1/oantuti-worker.zip"
```

Giải nén và chạy:

```bash
unzip oantuti-worker.zip
cd oantuti-worker
bash worker.sh
```

Dừng: `bash worker.sh stop`. Xem log: `bash worker.sh logs`.
Nếu chưa có quyền Docker, chạy script với `sudo bash worker.sh`.

## Windows — PowerShell

Tải:

```powershell
curl.exe -fL "https://github.com/tuanngthuet/oantuti/releases/download/worker-portable-v1/oantuti-worker.zip" -o oantuti-worker.zip
```

Giải nén và chạy:

```powershell
Expand-Archive .\oantuti-worker.zip -DestinationPath .
cd oantuti-worker
.\worker.cmd
```

Dừng: `.\worker.cmd stop`. Xem log: `.\worker.cmd logs`.

Script tự nạp image, kiểm tra sandbox và chạy nền. Lần sau dùng lại cùng lệnh
để chạy. Vào https://oantuti-three.vercel.app/admin/workers để kiểm tra;
nếu admin đang lưu trạng thái dừng thì bấm **Bật worker**.
Định danh mỗi máy được giữ trong Docker volume.
