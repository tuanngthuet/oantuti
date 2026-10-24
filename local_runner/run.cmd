@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
py -3 -c "import sys; sys.exit(sys.version_info < (3,10))" >nul 2>&1
if not errorlevel 1 (
    py -3 -B app\start.py
    goto finish
)
python -c "import sys; sys.exit(sys.version_info < (3,10))" >nul 2>&1
if not errorlevel 1 (
    python -B app\start.py
    goto finish
)
echo Không tìm thấy Python 3.10 trở lên.
echo Hãy cài Python, bật tùy chọn Add Python to PATH rồi mở lại Chay.cmd.
echo Hướng dẫn: mở app\HUONG_DAN.html bằng trình duyệt.
:finish
if errorlevel 1 (
    echo Chương trình chưa chạy được. Xem thông báo phía trên và app\logs\startup.log nếu có.
    pause
)
endlocal
