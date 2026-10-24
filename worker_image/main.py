"""Configure the shared worker protocol with a sandboxed local Python executor."""
import asyncio
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
# Resolve worker configuration independently of the caller's working directory.
os.environ.setdefault('WORKER_ENV_FILE', str(HERE / '.env'))
sys.path.insert(0, str(HERE))

import worker as core
import supervisor


def configure():
    return core.get_runner()


if __name__ == '__main__':
    runner = configure()
    core._validate_config()
    if sys.argv[1:] == ['--check']:
        if not asyncio.run(runner.check()):
            raise SystemExit('Python sandbox self-check failed. No jobs were claimed. See sandbox error above.')
        print('Python sandbox OK')
    elif sys.argv[1:] == ['--runtime']:
        from runtime import main
        asyncio.run(main())
    else:
        supervisor.cli(core)
