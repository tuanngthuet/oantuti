"""Worker entrypoints load sandbox configuration without the retired worker folder."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


@pytest.mark.parametrize('entrypoint,config', [('main', '.env'), ('worker', '.env')])
def test_entrypoint_configuration_is_local_and_separate(tmp_path, entrypoint, config):
    deployment = tmp_path / 'worker_image'
    deployment.mkdir()
    for source in Path(__file__).resolve().parents[1].glob('*.py'):
        shutil.copy2(source, deployment / source.name)
    for filename, secret in [('.env', 'python-test-secret'), ('.env.retired', 'retired-test-secret')]:
        (deployment / filename).write_text(f'WORKER_SECRET={secret}\n')
    unrelated = tmp_path / 'unrelated'
    unrelated.mkdir()
    (unrelated / '.env').write_text('WORKER_SECRET=wrong-ambient-secret\n')
    env = {key: value for key, value in os.environ.items()
           if key not in ('WORKER_SECRET', 'WORKER_ENV_FILE')}
    expected = 'python-test-secret'
    script = '''import importlib, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
module = importlib.import_module(sys.argv[2])
core = module.core if sys.argv[2] == 'main' else module
assert core.WORKER_SECRET == sys.argv[3]
assert Path(core.__file__).parent == Path(sys.argv[1])
'''
    result = subprocess.run([sys.executable, '-B', '-c', script, str(deployment), entrypoint, expected],
                            cwd=unrelated, env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
