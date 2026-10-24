#!/usr/bin/env python3
"""Export a credential-bearing Docker deployment and ready-to-download ZIP."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
IMAGE = 'oantuti-worker-python:bundled'
URLS = {
    'BACKEND_URL': 'https://oantuti-backend.vercel.app',
    'FRONTEND_URL': 'https://oantuti-three.vercel.app',
}


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def package(output, public=False):
    archive = output / 'worker-image.tar.gz'
    hasher = hashlib.sha256()
    with archive.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            hasher.update(chunk)
    guide = (HERE / 'PORTABLE.md').read_text()
    if not public:
        guide = guide.replace('Gói đã chứa image và hai URL Vercel. Sau giải nén, mở `.env.example`, điền\n`WORKER_SECRET` và `WORKER_CALLBACK_SECRET`, rồi lưu thành `.env`. Chỉ làm một lần.', 'Bản riêng đã nhúng secrets và cấu hình Vercel; không cần tạo .env. Chỉ chia sẻ riêng.')
    guide += f'\nSHA256 image: `{hasher.hexdigest()}`\n'
    (output / 'README.md').write_text(guide)
    compose = (HERE / 'compose.bundled.yaml').read_text()
    if public:
        compose = compose.replace('image: oantuti-worker-python:bundled', 'image: oantuti-worker-python:portable-public')
        compose = compose.replace('pull_policy: never', 'pull_policy: never\n    env_file: .env')
    (output / 'compose.yaml').write_text(compose)
    for filename in ('worker.sh', 'worker.cmd'):
        data = (HERE / 'portable-scripts' / filename).read_text()
        (output / filename).write_bytes(data.replace('\n', '\r\n').encode() if filename.endswith('.cmd') else data.encode())
    (output / 'worker.sh').chmod(0o755)
    destination = HERE / ('oantuti-worker.zip' if public else 'oantuti-worker-with-secrets.zip')
    with tempfile.NamedTemporaryFile(dir=HERE, prefix='.portable-', suffix='.zip', delete=False) as temporary:
        staging = Path(temporary.name)
    try:
        with zipfile.ZipFile(staging, 'w') as bundle:
            filenames = ['README.md', 'compose.yaml', 'worker.sh', 'worker.cmd', 'worker-image.tar.gz']
            if public:
                filenames.append('.env.example')
            for filename in filenames:
                # The image is already gzip-compressed; storing it avoids double compression.
                bundle.write(output / filename, 'oantuti-worker/' + filename,
                             compress_type=zipfile.ZIP_STORED if filename.endswith('.gz') else zipfile.ZIP_DEFLATED)
        staging.replace(destination)
    finally:
        staging.unlink(missing_ok=True)
    print(f'ZIP: {destination} (~{destination.stat().st_size / 1024**2:.1f} MiB)')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package-only', action='store_true', help='Reuse exported image; refresh scripts/docs and ZIP without Docker.')
    parser.add_argument('--public', action='store_true', help='Build ZIP without secrets, with an external .env template.')
    args = parser.parse_args()
    output = HERE / ('public-portable' if args.public else 'portable')
    if args.package_only:
        package(output, args.public)
        return
    if output.exists():
        raise SystemExit(f'{output} đã tồn tại. Đổi tên/di chuyển gói cũ trước khi export lại.')
    config = (HERE / '.env').read_text()
    image = 'oantuti-worker-python:portable-public' if args.public else IMAGE
    if args.public:
        # Explicit allowlist: newly added credentials can never slip into a public ZIP.
        allowed = {'WORKER_ID', 'MAX_CONCURRENT', 'POLL_INTERVAL', 'AGENT_CPU_SECONDS',
                   'AGENT_WALL_SECONDS', 'AGENT_MEMORY_MB', 'AGENT_OUTPUT_BYTES', 'AGENT_SOURCE_BYTES'}
        lines = [line for line in config.splitlines()
                 if line.partition('=')[0].strip() in allowed]
        config = '\n'.join(lines) + '\nWORKER_SECRET=change-me-in-production\nWORKER_CALLBACK_SECRET=change-me-in-production\n'
    for key, value in URLS.items():
        config, count = re.subn(rf'(?m)^\s*(?:export\s+)?{key}\s*=.*$',
                                f'{key}={value}', config)
        if not count:
            config += f'\n{key}={value}\n'
    # Machine identity belongs to the receiving installation, never the sender.
    config = re.sub(r'(?m)^\s*(?:export\s+)?(?:MACHINE_ID|WORKER_MACHINE_ID_FILE)\s*=.*\n?', '', config)
    print('Build public ZIP without secrets.' if args.public else 'Giữ cấu hình/secrets từ .env; dùng backend/frontend Vercel. Image chứa secrets.', flush=True)
    with tempfile.TemporaryDirectory(prefix='oantuti-export-') as temporary:
        secret = Path(temporary) / '.env'
        secret.touch(mode=0o600)
        secret.write_text(config)
        build = ['docker', 'build', '--target', 'portable' if args.public else 'bundled']
        if not args.public:
            build += ['--build-arg', 'WORKER_ENV_SHA256=' + hashlib.sha256(config.encode()).hexdigest(),
                      '--secret', f'id=worker_env,src={secret}']
        run(*build, '-f', str(HERE / 'Dockerfile'), '-t', image, str(ROOT))
    if not args.public:
        run('docker', 'compose', '-f', str(HERE / 'compose.bundled.yaml'),
            'run', '--rm', '--no-deps', '--pull', 'never', 'worker-python', '--check')
    platform = subprocess.check_output(
        ['docker', 'image', 'inspect', image, '--format', '{{.Os}}/{{.Architecture}}'], text=True).strip()
    # Stage beside the destination: a failed save never leaves a usable-looking bundle.
    with tempfile.TemporaryDirectory(prefix='.portable-', dir=HERE) as temporary:
        stage = Path(temporary)
        archive = stage / 'worker-image.tar.gz'
        # docker save is streamed, without keeping an uncompressed duplicate on disk.
        with archive.open('wb') as handle:
            os.chmod(archive, 0o600)
            save = subprocess.Popen(['docker', 'save', image], stdout=subprocess.PIPE)
            try:
                compressed = subprocess.run(['gzip', '-9', '-n'], stdin=save.stdout, stdout=handle)
            finally:
                save.stdout.close()
            saved = save.wait()
            if saved or compressed.returncode:
                raise SystemExit('Không xuất/nén được image; chưa tạo folder portable.')
        hasher = hashlib.sha256()
        with archive.open('rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                hasher.update(chunk)
        digest = hasher.hexdigest()
        shutil.copyfile(HERE / 'compose.bundled.yaml', stage / 'compose.yaml')
        guide = (HERE / 'PORTABLE.md').read_text()
        guide += f'\n## Thông tin gói này\n\n- Platform: `{platform}`\n- Image: `{image}`\n- SHA256 `worker-image.tar.gz`: `{digest}`\n'
        (stage / 'README.md').write_text(guide)
        if args.public:
            (stage / '.env.example').write_text(config)
        output.mkdir(mode=0o700)
        for file in stage.iterdir():
            file.rename(output / file.name)
    print(f'Đã xuất: {output}\nPlatform: {platform}\nDung lượng: {archive.name} ~{(output / archive.name).stat().st_size / 1024**2:.1f} MiB')
    package(output, args.public)


if __name__ == '__main__':
    main()
