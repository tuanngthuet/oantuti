"""Generate five distinct local credentials without printing secrets or editing frontend env."""
import argparse
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True, help='Frontend URL reachable by worker containers')
    args = parser.parse_args()
    url = urlsplit(args.url)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
        parser.error('URL must be http(s), without embedded credentials')
    root = Path(__file__).resolve().parent
    names = ['round_16', 'quarterfinal', 'semifinal', 'final', 'third_place']
    targets = [root/('.env.'+name) for name in names]+[root/'.env.frontend']
    if any(path.exists() for path in targets):
        parser.error('Config already exists; refusing to replace worker credentials')
    tokens = {str(n): secrets.token_urlsafe(48) for n in range(1,6)}
    contents = [f'CK_FRONTEND_URL={args.url.rstrip("/")}\nCK_WORKER_ID=ck-{name}-01\nCK_WORKER_TOKEN={tokens[str(n)]}\n' for n,name in enumerate(names,1)]
    contents += ["CK_WORKER_TOKENS='"+json.dumps(tokens,separators=(',',':'))+"'\n"]
    # Exclusive creation avoids silently rotating credentials used by running services.
    for path, content in zip(targets, contents):
        fd = os.open(path, os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'w') as stream:
            stream.write(content)
    print('Created five .env worker files and .env.frontend (0600). Install CK_WORKER_TOKENS in the frontend environment.')


if __name__ == '__main__':
    main()
