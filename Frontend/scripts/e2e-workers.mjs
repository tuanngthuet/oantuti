// Requires an isolated stack created by scripts/e2e.mjs --run.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { pinLookup } from './e2e-network.mjs';

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(frontend, '..');
require('@next/env').loadEnvConfig(frontend);
const { neon } = require('@neondatabase/serverless');
const statePath = path.join(root, 'logs/e2e-state.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
assert.match(state.schema, /^ott_e2e_\d+$/);
assert.equal(state.prefix, `${state.schema}:`);
assert.equal(state.stopped, undefined);
const baseline = JSON.parse(readFileSync(path.join(state.logDir, 'report.json'), 'utf8'));
assert.equal(baseline.passed, true);
if (baseline.neonRoute) pinLookup(baseline.neonRoute.host, baseline.neonRoute.address);
const sql = neon(process.env.DATABASE_URL);
const scoped = async (text, values = []) => (await sql.transaction(txn => [
  txn`SELECT set_config('search_path', ${state.schema}, true)`, txn.query(text, values),
]))[1];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(label, fn, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(1000); }
  throw new Error(`Timed out: ${label}`);
}
const readEnv = file => Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
  const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  return m ? [[m[1], m[2].replace(/^(["'])(.*)\1$/, '$2')]] : [];
}));
const workerEnv = { ...process.env, ...readEnv(path.join(root, 'worker_image/.env')),
  BACKEND_URL: state.backend, FRONTEND_URL: state.frontend,
  OTT_E2E_RUN_ID: state.runId, PYTHONUNBUFFERED: '1' };
const account = JSON.parse(readFileSync(path.join(state.logDir, 'accounts.json'), 'utf8'))[0];
const loggedIn = await fetch(`${state.frontend}/api/auth/login`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(account) });
assert.equal(loggedIn.status, 200);
const cookie = loggedIn.headers.get('set-cookie').split(';')[0];
async function api(route, body, expected = 200) {
  let r;
  // Retry transient read failures only; never repeat a control mutation implicitly.
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fetch(`${state.frontend}${route}`, { method: body ? 'PATCH' : 'GET',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (body || expected !== 200 || r.status !== 503 || attempt === 2) break;
    await r.text();
    console.log(`Retry transient status read: ${route}`);
    await sleep(1000);
  }
  const data = await r.json();
  assert.equal(r.status, expected, `${route}: ${JSON.stringify(data)}`);
  return data;
}
const list = async () => (await api('/api/admin/workers')).workers;
const get = async id => (await list()).find(w => w.worker_id === id);
async function control(id, value, expected = 200) {
  const current = await get(id);
  return api(`/api/admin/workers/${id}`, { revision: current.control.revision, ...value }, expected);
}
async function applied(id, predicate) {
  return waitFor('worker applied control', async () => {
    const w = await get(id);
    return w && w.online && w.applied_revision === w.control.revision && predicate(w) && w;
  });
}
function launch(name, role) {
  const log = path.join(state.logDir, `${role}.log`);
  const fd = openSync(log, 'a', 0o600);
  const child = spawn('python3', ['-B', 'main.py', '--name', name], {
    cwd: path.join(root, 'worker_image'), env: workerEnv, detached: true, stdio: ['ignore', fd, fd],
  });
  child.unref(); closeSync(fd);
  const previous = state.processes.findIndex(p => p.name === role);
  const record = { name: role, pid: child.pid, log };
  if (previous >= 0) state.processes[previous] = record;
  else state.processes.push(record);
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  return child.pid;
}
function killOwned(pid, signal, workerId) {
  const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  assert.ok(env.includes(`OTT_E2E_RUN_ID=${state.runId}`));
  if (workerId) assert.ok(env.includes(`OTT_MANAGED_WORKER_ID=${workerId}`));
  process.kill(pid, signal);
}
const checks = [];
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
let browser;
try {
  const alpha = (await list()).find(w => w.managed);
  assert.ok(alpha);
  let beta;
  await check('same console identity blocked before registration; named sibling independent', async () => {
    const duplicate = spawnSync('python3', ['-B', 'main.py', '--name', alpha.worker_name], {
      cwd: path.join(root, 'worker_image'), env: workerEnv, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(duplicate.status, 2);
    assert.ok(duplicate.stderr.includes('Worker đã chạy'));
    const name = `${state.runId}_beta`;
    launch(name, 'worker-beta');
    beta = await waitFor('named sibling', async () => (await list()).find(w => w.worker_name === name && w.state === 'running'));
    assert.equal(beta.machine_id, alpha.machine_id);
    assert.notEqual(beta.worker_id, alpha.worker_id);
    await control(beta.worker_id, { action: 'pause' });
    beta = await applied(beta.worker_id, w => w.state === 'paused');
  });
  browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addCookies([{ name: 'auth_session', value: cookie.slice('auth_session='.length), url: state.frontend, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(`${state.frontend}/admin/workers`);
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: alpha.worker_name, exact: true }) });
  await card.waitFor();
  await check('browser form preserves edits across polling and saves limit', async () => {
    const input = card.getByRole('spinbutton');
    await input.fill('1');
    await page.waitForTimeout(3500); // Cross a real UI polling boundary.
    assert.equal(await input.inputValue(), '1');
    await card.getByRole('button', { name: 'Lưu giới hạn' }).click();
    await applied(alpha.worker_id, w => w.max_concurrent === 1);
  });
  const agents = await scoped("SELECT id, code FROM arena_agents WHERE status = 'active' ORDER BY id");
  assert.equal(agents.length, 2);
  for (const agent of agents) {
    const code = 'import time\n' + agent.code.replace('def agent(', 'def e2e_base_agent(') +
      '\ndef agent(observation, configuration):\n    time.sleep(1)\n    return e2e_base_agent(observation, configuration)\n';
    await scoped('UPDATE arena_agents SET code = $1 WHERE id = $2', [code, agent.id]);
  }
  const matches = [];
  await check('live increase/decrease of concurrency and pause without new claims', async () => {
    for (let index = 0; index < 4; index++) {
      const response = await fetch(`${state.frontend}/api/friendly`, { method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent1_id: Number(agents[0].id), agent2_id: Number(agents[1].id),request_id:crypto.randomUUID() }) });
      assert.equal(response.status, 200); matches.push(Number((await response.json()).friendly_match_id));
    }
    await waitFor('one active match', async () => (await get(alpha.worker_id)).active_jobs === 1);
    await card.getByRole('spinbutton').fill('2');
    await card.getByRole('button', { name: 'Lưu giới hạn' }).click();
    await applied(alpha.worker_id, w => w.active_jobs === 2 && w.max_concurrent === 2);
    await card.getByRole('spinbutton').fill('1');
    await card.getByRole('button', { name: 'Lưu giới hạn' }).click();
    const reduced = await applied(alpha.worker_id, w => w.max_concurrent === 1);
    assert.equal(reduced.active_jobs, 2, 'Reducing concurrency must not cancel active matches');
    await card.getByRole('button', { name: 'Tạm dừng', exact: true }).click();
    const paused = await applied(alpha.worker_id, w => w.state === 'paused');
    await sleep(3500);
    const after = await get(alpha.worker_id);
    assert.ok(after.active_task_ids.every(id => paused.active_task_ids.includes(id)));
  });
  await check('graceful stop finishes current matches and preserves supervisor/sibling', async () => {
    await card.getByRole('button', { name: 'Dừng an toàn' }).click();
    const stopped = await applied(alpha.worker_id, w => w.state === 'stopped');
    assert.equal(stopped.pid, null);
    assert.equal(stopped.active_jobs, 0);
    assert.equal((await get(beta.worker_id)).pid, beta.pid);
    assert.equal((await get(beta.worker_id)).state, 'paused');
    assert.equal((await scoped('SELECT COUNT(*)::int AS count FROM friendly_matches WHERE id = ANY($1::bigint[]) AND status = \'finished\'', [matches]))[0].count, 2);
  });
  await check('immediate stop confirmation returns unfinished job to real Redis queue', async () => {
    await card.getByRole('button', { name: 'Bật worker' }).click();
    await applied(alpha.worker_id, w => w.state === 'running' && w.active_jobs === 1);
    await card.getByRole('button', { name: 'Dừng ngay', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.ok((await page.getByRole('dialog').innerText()).includes('job đang chạy'));
    await page.getByRole('button', { name: 'Xác nhận dừng ngay' }).click();
    await applied(alpha.worker_id, w => w.state === 'stopped');
    await waitFor('requeued jobs', async () => (await api('/api/admin/workers')).queue_depth === 2);
    assert.equal((await get(beta.worker_id)).pid, beta.pid);
  });
  await check('sibling resumes interrupted match using a new execution token, with complete replay', async () => {
    await control(beta.worker_id, { action: 'resume' });
    await applied(beta.worker_id, w => w.state === 'running');
    await waitFor('all interrupted matches completed', async () => {
      const rows = await scoped('SELECT status, is_infra_error FROM friendly_matches WHERE id = ANY($1::bigint[])', [matches]);
      return rows.every(row => row.status === 'finished' && !row.is_infra_error);
    }, 240000);
    for (const id of matches) {
      const replay = await api(`/api/friendly/${id}/replay`);
      assert.equal(replay.moves.length, replay.match.total_moves);
      assert.ok(replay.moves.length > 0);
    }
  });
  await check('unexpected child crash auto-restarts while supervisor remains online', async () => {
    await control(alpha.worker_id, { action: 'start' });
    const started = await applied(alpha.worker_id, w => w.state === 'running');
    killOwned(started.pid, 'SIGKILL', alpha.worker_id);
    await waitFor('automatic restart', async () => {
      const w = await get(alpha.worker_id); return w.online && w.state === 'running' && w.pid && w.pid !== started.pid;
    });
  });
  await check('stopped state and limit survive supervisor restart', async () => {
    await control(alpha.worker_id, { action: 'stop', stop_mode: 'graceful' });
    const stopped = await applied(alpha.worker_id, w => w.state === 'stopped');
    killOwned(stopped.supervisor_pid, 'SIGTERM');
    await sleep(2500);
    const pid = launch(alpha.worker_name, 'worker');
    await applied(alpha.worker_id, w => w.state === 'stopped' && w.supervisor_pid === pid && w.max_concurrent === 1);
  });
  await check('offline supervisor visible; limit saved offline; start rejected', async () => {
    const current = await get(beta.worker_id);
    killOwned(current.supervisor_pid, 'SIGTERM');
    await waitFor('offline worker', async () => !(await get(beta.worker_id)).online, 45000);
    await control(beta.worker_id, { max_concurrent: 2 });
    assert.equal((await get(beta.worker_id)).control.max_concurrent, 2);
    await control(beta.worker_id, { action: 'start' }, 409);
  });
  await page.screenshot({ path: path.join(state.logDir, 'worker-controls.png'), fullPage: true });
  assert.deepEqual(browserErrors, []);
  writeFileSync(path.join(state.logDir, 'worker-controls-report.json'), JSON.stringify({ passed: true,
    verifiedAt: new Date().toISOString(), checks, frontend: state.frontend, schema: state.schema }, null, 2));
  console.log(`Worker report: ${state.logDir}/worker-controls-report.json`);
} finally {
  await browser?.close();
}
