@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 exit /b 1
if not "%~2"=="" goto usage
if "%~1"=="" goto start
if /i "%~1"=="start" goto start
if /i "%~1"=="stop" goto stop
if /i "%~1"=="logs" goto logs
if /i "%~1"=="status" goto status
goto usage

:start
if exist .env.example if not exist .env (
  copy /y .env.example .env >nul
  echo Created .env. Fill WORKER_SECRET and WORKER_CALLBACK_SECRET, then run this command again.
  exit /b 1
)
docker load -i worker-image.tar.gz
if errorlevel 1 exit /b 1
docker compose run --rm --no-deps worker-python --check
if errorlevel 1 exit /b 1
docker compose up -d --no-build worker-python
if errorlevel 1 exit /b 1
echo Worker started. Admin: https://oantuti-three.vercel.app/admin/workers
exit /b 0

:stop
docker compose stop worker-python
exit /b %errorlevel%

:logs
docker compose logs -f --tail 100 worker-python
exit /b %errorlevel%

:status
docker compose ps -a worker-python
exit /b %errorlevel%

:usage
echo Usage: worker.cmd [start^|stop^|logs^|status]
exit /b 2
