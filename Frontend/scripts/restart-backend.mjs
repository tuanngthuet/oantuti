// Restart only the backend recorded by start-local, retaining live worker processes.
import { readFileSync, readlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const statePath = path.join(root, 'logs/local-stack.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const record = state.processes.find(service => service.name === 'backend');
const env = Object.fromEntries(readFileSync(`/proc/${record.pid}/environ`, 'utf8').split('\0').filter(Boolean).map(entry => {
  const at = entry.indexOf('='); return [entry.slice(0, at), entry.slice(at + 1)];
}));
assert.equal(env.DATABASE_SCHEMA, ''); assert.equal(env.REDIS_KEY_PREFIX, '');
assert.equal(env.OTT_E2E_RUN_ID, undefined);
assert.equal(readlinkSync(`/proc/${record.pid}/cwd`), path.join(root, 'backend'));
const command = readFileSync(`/proc/${record.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
assert.deepEqual(command.slice(1), ['-B', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000']);
process.kill(record.pid, 'SIGTERM');
let stopped = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const stat = readFileSync(`/proc/${record.pid}/stat`, 'utf8');
    stopped = stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch (error) { if (error.code === 'ENOENT') stopped = true; else throw error; }
  if (stopped) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(stopped, 'Backend did not stop gracefully; no replacement started');
const fd = openSync(path.join(root, 'logs/backend.log'), 'a', 0o600);
const child = spawn(command[0], command.slice(1), { cwd: path.join(root, 'backend'), env, detached: true, stdio: ['ignore', fd, fd] });
child.unref(); closeSync(fd);
record.pid = child.pid;
writeFileSync(statePath, JSON.stringify(state, null, 2));
writeFileSync(path.join(root, 'logs/backend.pid'), `${child.pid}\n`);
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try { ready = (await fetch(`${state.backend}/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch {}
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(ready, 'Backend health failed');
console.log(JSON.stringify({ backendPid: child.pid, healthy: true, workersUntouched: true }));
