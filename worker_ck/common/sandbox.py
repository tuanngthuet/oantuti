"""Bounded, cancellable Python execution through an unprivileged bubblewrap sandbox."""
import asyncio
from dataclasses import dataclass
import json
import logging
import math
import os
from pathlib import Path
import shutil
import signal
import tempfile

log = logging.getLogger('python-runner')
READY = b'OTT_SANDBOX_READY\n'


class OutputLimitExceeded(Exception):
    pass


@dataclass
class PythonRunner:
    wrapper: str
    parse_result: object
    cpu_seconds: int = 2
    wall_seconds: float = 4
    memory_mb: int = 128
    output_bytes: int = 65536
    source_bytes: int = 1048576

    @classmethod
    def from_env(cls, wrapper, parse_result):
        runner = cls(wrapper, parse_result,
            cpu_seconds=int(os.getenv('CK_AGENT_CPU_SECONDS', '2')),
            wall_seconds=float(os.getenv('CK_AGENT_WALL_SECONDS', '4')),
            memory_mb=int(os.getenv('CK_AGENT_MEMORY_MB', '128')),
            output_bytes=int(os.getenv('CK_AGENT_OUTPUT_BYTES', '65536')),
            source_bytes=int(os.getenv('CK_AGENT_SOURCE_BYTES', '1048576')))
        if (runner.cpu_seconds < 1 or not math.isfinite(runner.wall_seconds) or runner.wall_seconds <= 0
                or runner.memory_mb < 32 or runner.output_bytes < 1024 or runner.source_bytes < 1024):
            raise ValueError('Invalid AGENT_* limits (CPU >= 1, wall > 0, memory >= 32 MiB, output/source >= 1024 bytes).')
        return runner

    def command(self, agent_path):
        binary = shutil.which('bwrap')
        if not binary:
            raise OSError('bubblewrap is not installed')
        args = [binary, '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
                '--setenv', 'PATH', '/usr/bin', '--setenv', 'LANG', 'C.UTF-8']
        for path in ('/usr', '/lib', '/lib64'):
            if Path(path).exists():
                args += ['--ro-bind', path, path]
        args += ['--dir', '/etc']
        if Path('/etc/ld.so.cache').exists():
            args += ['--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache']
        # Python agents do not need procfs. Leaving it empty also avoids exposing
        # process metadata and works with Docker's locked/masked proc mounts.
        args += ['--dir', '/proc', '--dir', '/dev']
        for device in ('null', 'zero', 'urandom'):
            args += ['--ro-bind', f'/dev/{device}', f'/dev/{device}']
        args += ['--dir', '/tmp', '--ro-bind', str(agent_path), '/agent.py',
                 '--ro-bind', str(Path(__file__).with_name('sandbox_launcher.py')), '/launcher.py',
                 '--chdir', '/tmp', '--remount-ro', '/', '--', '/usr/bin/python3', '-I', '-S', '-B',
                 '/launcher.py', str(self.cpu_seconds), str(self.memory_mb * 1024 * 1024)]
        return args

    @staticmethod
    def failure(error, infra=False, stdout='', stderr=''):
        return dict(success=False, move=None, stdout=stdout, stderr=stderr, error=error, is_infra_error=infra)

    async def execute(self, agent_code, observation, configuration=None):
        if not isinstance(agent_code, str) or len(agent_code.encode()) > self.source_bytes:
            return self.failure('Agent source exceeds the size limit.')
        source = self.wrapper.replace('__AGENT_CODE_PLACEHOLDER__', agent_code)
        proc = None
        jobs = []
        output = {'stdout': bytearray(), 'stderr': bytearray()}
        total = 0
        ready = False
        handshake = asyncio.Event()
        try:
            with tempfile.TemporaryDirectory(prefix='ott-agent-') as directory:
                path = Path(directory) / 'agent.py'
                path.write_text(source, encoding='utf-8')
                proc = await asyncio.create_subprocess_exec(*self.command(path),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, start_new_session=True)

                async def read(stream, name):
                    nonlocal total, ready
                    if name == 'stderr':
                        try:
                            prefix = await stream.readexactly(len(READY))
                        except asyncio.IncompleteReadError as error:
                            prefix = error.partial
                        ready = prefix == READY
                        if not ready:
                            output[name].extend(prefix)
                            total += len(prefix)
                        handshake.set()
                    else:
                        # Consume the trusted marker before an agent can exhaust
                        # the shared output budget with stdout.
                        await handshake.wait()
                    while chunk := await stream.read(8192):
                        remaining = self.output_bytes - total
                        output[name].extend(chunk[:max(0, remaining)])
                        total += len(chunk)
                        if total > self.output_bytes:
                            raise OutputLimitExceeded

                async def write():
                    try:
                        proc.stdin.write(json.dumps({'observation': observation, 'configuration': configuration or {}}).encode())
                        await proc.stdin.drain()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    finally:
                        proc.stdin.close()

                jobs = [asyncio.create_task(read(proc.stdout, 'stdout')),
                        asyncio.create_task(read(proc.stderr, 'stderr')),
                        asyncio.create_task(write()), asyncio.create_task(proc.wait())]
                error = None
                try:
                    await asyncio.wait_for(asyncio.gather(*jobs), self.wall_seconds)
                except asyncio.TimeoutError:
                    error = 'Wall time limit exceeded.'
                except OutputLimitExceeded:
                    error = 'Agent stdout/stderr exceeded the output limit.'
                finally:
                    # Includes cancellation by stop, lost lease or parent runtime shutdown.
                    if proc.returncode is None:
                        try:
                            os.killpg(proc.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    for job in jobs:
                        if not job.done():
                            job.cancel()
                    await asyncio.gather(*jobs, return_exceptions=True)
                    # Drain after killing: wait() alone can hang when a flooded
                    # pipe's StreamReader paused its transport before cancellation.
                    await proc.communicate()

                stdout = output['stdout'].decode('utf-8', errors='replace')
                stderr = output['stderr'].decode('utf-8', errors='replace')
                if not ready:
                    log.error('Sandbox setup failed: %s', stderr[:2000])
                    return self.failure('Python sandbox could not start: ' + stderr[:500], True, stdout, stderr)
                if error:
                    return self.failure(error, stdout=stdout, stderr=stderr)
                if proc.returncode != 0:
                    detail = ('CPU time limit exceeded or agent killed.' if proc.returncode in (-signal.SIGKILL, -signal.SIGXCPU, 128+signal.SIGKILL, 128+signal.SIGXCPU)
                              else 'Memory limit exceeded.' if 'MemoryError' in stderr
                              else f'Python exited with status {proc.returncode}: {stderr[-1000:]}')
                    return self.failure(detail, stdout=stdout, stderr=stderr)
                return self.parse_result(stdout, stderr)
        except (OSError, ValueError) as error:
            log.error('Local runner infrastructure error: %s', error)
            return self.failure(f'Local runner error: {error}', True)

    async def check(self):
        result = await self.execute("def agent(observation, configuration):\n    return {'from_col': 0, 'from_row': 0, 'to_col': 1, 'to_row': 1}", {})
        if not result['success']:
            log.error('Python sandbox self-check: %s', result['error'])
        return result['success']
