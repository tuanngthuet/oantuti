"""Private child process: live configuration comes only from supervisor stdin."""
import asyncio
import json
import os
import signal
import sys
import time

import worker as core


class RuntimeControl:
    def __init__(self, value):
        self.value = value
        self.terminate = False

    def apply(self, value):
        if value.get('mode') == 'terminate':
            self.terminate = True
        elif (value.get('mode') in ('running', 'paused', 'stopped') and
              type(value.get('max_concurrent')) is int and 1 <= value['max_concurrent'] <= 64 and
              type(value.get('revision')) is int and value['revision'] >= self.value['revision']):
            self.value = value


async def main():
    if not os.getenv('OTT_MANAGED_WORKER_ID') or not os.getenv('OTT_RUNTIME_ID'):
        raise SystemExit('Runtime must be started by the supervisor.')
    core._validate_config()
    control = RuntimeControl(json.loads(os.environ['OTT_INITIAL_CONTROL']))
    reader = asyncio.StreamReader()
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    async def commands():
        try:
            while line := await reader.readline():
                control.apply(json.loads(line))
        finally:
            control.terminate = True  # Parent crashed or closed its control pipe.

    command_task = asyncio.create_task(commands())
    reaper = asyncio.create_task(core._background_reaper())
    active = {}
    executor_ready = False
    last_check = next_dispatch = last_report = 0
    applied = 0
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda: setattr(control, 'terminate', True))
    try:
        while not control.terminate:
            for task_id in [key for key, task in active.items() if task.done()]:
                task = active.pop(task_id)
                if not task.cancelled() and task.exception():
                    core.logger.error('Match process error: %s', task.exception())
            desired = control.value
            limit = desired['max_concurrent']
            core.MAX_CONCURRENT = limit
            mode = desired['mode']
            now = time.monotonic()
            if mode != 'stopped' and now - last_check >= 10:
                executor_ready = await core.check_executor()
                last_check = now
            state = ('draining' if active else 'stopped') if mode == 'stopped' else (
                'paused' if mode == 'paused' else 'running' if executor_ready else 'starting')
            if state in ('running', 'paused', 'stopped'):
                applied = desired['revision']
            if now - last_report >= 1 or state == 'stopped':
                print(json.dumps({'state': state, 'active_jobs': len(active), 'active_task_ids': list(active),
                    'max_concurrent': limit, 'applied_revision': applied,
                    'last_error': '' if executor_ready or mode == 'stopped' else getattr(core, 'RUNNER_NOT_READY_MESSAGE', 'Python sandbox chưa sẵn sàng.')}), flush=True)
                last_report = now
            if state == 'stopped':
                return
            if mode == 'running' and executor_ready and len(active) < limit:
                task, delivery = await core.claim_next_task()
                if task and delivery and not control.terminate:
                    active[task['task_id']] = asyncio.create_task(core.process_task(task, delivery))
                elif not task and now >= next_dispatch:
                    delay = await core.dispatch_rating_task()
                    next_dispatch = time.monotonic() + delay
            await asyncio.sleep(0.2 if active else max(0.2, core.POLL_INTERVAL))
    finally:
        for task in [command_task, reaper, *active.values()]:
            task.cancel()
        await asyncio.gather(command_task, reaper, *active.values(), return_exceptions=True)
        transport.close()
