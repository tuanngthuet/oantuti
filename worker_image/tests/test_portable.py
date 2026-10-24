"""Portable identity survives restart and differs between installations."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import os


SUPERVISOR = Path(__file__).resolve().parents[1] / 'supervisor.py'


def test_portable_identity_survives_new_process_and_is_unique_per_volume(tmp_path):
    script = '''import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('portable_supervisor', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module.identity('local-python')['worker_id'])
'''
    env = dict(os.environ)
    env.pop('MACHINE_ID', None)

    def identity(volume):
        env['WORKER_MACHINE_ID_FILE'] = str(volume / 'machine-id')
        return subprocess.check_output([sys.executable, '-B', '-c', script, str(SUPERVISOR)],
                                       env=env, text=True).strip()

    first = tmp_path / 'first-volume'
    second = tmp_path / 'second-volume'
    first.mkdir()
    second.mkdir()
    worker = identity(first)
    assert len(worker) == 32
    assert identity(first) == worker
    assert identity(second) != worker


def test_explicit_machine_id_takes_precedence_over_volume(monkeypatch, tmp_path):
    spec = importlib.util.spec_from_file_location('portable_supervisor', SUPERVISOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv('MACHINE_ID', 'explicit-host')
    monkeypatch.setenv('WORKER_MACHINE_ID_FILE', str(tmp_path / 'missing-directory' / 'machine-id'))
    assert module.identity('alpha')['worker_id'] == module.identity('alpha')['worker_id']
    assert not (tmp_path / 'missing-directory').exists()
