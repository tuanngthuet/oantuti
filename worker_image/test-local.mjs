// Real local frontend/backend + production Docker worker, with isolated Neon/Redis data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import tls from 'node:tls';
import { splitSql } from '../Frontend/scripts/sql-statements.mjs';
import { pinLookup } from '../Frontend/scripts/e2e-network.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendDir = path.join(root, 'Frontend');
const require = createRequire(path.join(frontendDir, 'package.json'));
require('@next/env').loadEnvConfig(frontendDir);
const { neon, neonConfig } = require('@neondatabase/serverless');
const readEnv = file => Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
  const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  return m ? [[m[1], m[2].replace(/^(["'])(.*)\1$/, '$2')]] : [];
}));
const backendEnv = readEnv(path.join(root, 'backend/.env'));
const workerEnv = readEnv(path.join(root, 'worker_image/.env'));
assert.ok(process.env.DATABASE_URL, 'Missing DATABASE_URL');
assert.ok(workerEnv.WORKER_SECRET === backendEnv.WORKER_SECRET, 'Worker/backend credentials differ');
assert.ok(workerEnv.WORKER_CALLBACK_SECRET === process.env.WORKER_CALLBACK_SECRET, 'Worker/frontend credentials differ');
const sql = neon(process.env.DATABASE_URL);
const runId = `worker_image_local_${Date.now()}`;
const schema = runId;
const prefix = `${schema}:`;
const logDir = path.join(root, 'logs', runId);
const buildDir = `.next-${runId}`;
const container = `oantuti-${runId.replaceAll('_', '-')}`;
const frontendPort = Number(process.env.LOCAL_TEST_FRONTEND_PORT || 3000);
const backendPort = Number(process.env.LOCAL_TEST_BACKEND_PORT || 8000);
assert.ok([frontendPort,backendPort].every(port => Number.isInteger(port) && port > 1024 && port < 65536)
  && frontendPort !== backendPort, 'Invalid local test ports');
const frontend = `http://127.0.0.1:${frontendPort}`;
const backend = `http://127.0.0.1:${backendPort}`;
const checks = [];
const services = [];
const accounts = [];
let schemaCreated = false;
let containerStarted = false;
let routeEnv = {};
const report = { passed: false, runId, schema, prefix, frontend, backend, checks };
const nextConfigFiles = ['next-env.d.ts', 'tsconfig.json'].map(name => ({
  file: path.join(frontendDir, name), original: readFileSync(path.join(frontendDir, name), 'utf8'), generated: null,
}));
mkdirSync(logDir, { recursive: true, mode: 0o700 });
writeFileSync(path.join(logDir, '.gitignore'), '*\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const scoped = async (text, values = []) => (await sql.transaction(txn => [
  txn`SELECT set_config('search_path', ${schema}, true)`, txn.query(text, values),
]))[1];
async function waitFor(label, fn, timeout = 180000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    for (const service of services) {
      if (service.child.exitCode !== null) throw new Error(`${service.name} exited; see ${service.log}`);
    }
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await sleep(1000);
  }
  throw new Error(`Timeout: ${label}${last ? ` (${last.message})` : ''}`);
}
async function check(label, fn) {
  await fn();
  checks.push(label);
  console.log(`PASS ${label}`);
}
function launch(name, executable, args, cwd, env) {
  const log = path.join(logDir, `${name}.log`);
  const fd = openSync(log, 'a', 0o600);
  const child = spawn(executable, args, { cwd, detached: true,
    env: { ...process.env, ...env, OTT_E2E_RUN_ID: runId }, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  services.push({ name, child, log });
  console.log(`Started ${name} PID ${child.pid}`);
}
function docker(args) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr || result.error?.message}`);
  return (result.stdout + (args[0] === 'logs' ? result.stderr : '')).trim();
}
async function redis(command) {
  const r = await fetch(backendEnv.UPSTASH_REDIS_REST_URL, { method: 'POST',
    headers: { Authorization: `Bearer ${backendEnv.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command), signal: AbortSignal.timeout(15000) });
  const body = await r.json();
  if (!r.ok || body.error) throw new Error(body.error || `Redis HTTP ${r.status}`);
  return body.result;
}
async function api(route, { method = 'GET', body, cookie, headers = {}, expected = 200 } = {}) {
  const response = await fetch(`${frontend}${route}`, { method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(data)}`);
  return { data, response };
}
async function workers() {
  const r = await fetch(`${backend}/workers/admin`, {
    headers: { 'X-Internal-Secret': backendEnv.INTERNAL_BACKEND_SECRET }, signal: AbortSignal.timeout(15000) });
  assert.ok(r.ok);
  return (await r.json()).workers;
}
async function snapshot() {
  return (await workers()).find(w => w.worker_name === runId);
}

try {
  // Do not replace anyone else's local stack.
  for (const url of [frontend, `${backend}/health`]) {
    let occupied = false;
    try { await fetch(url, { signal: AbortSignal.timeout(1000) }); occupied = true; } catch {}
    assert.equal(occupied, false, `Port already occupied: ${url}`);
  }
  // Select a reachable TLS route without changing system DNS or certificate checks.
  const host = new URL(neonConfig.fetchEndpoint(new URL(process.env.DATABASE_URL).hostname, 5432)).hostname;
  const addresses = await lookup(host, { all: true });
  const address = await Promise.any(addresses.filter(a => a.family === 4).map(({ address }) => new Promise((resolve, reject) => {
    const socket = tls.connect({ host: address, port: 443, servername: host, rejectUnauthorized: true });
    socket.setTimeout(4000, () => socket.destroy(new Error('TLS route timeout')));
    socket.once('error', reject);
    socket.once('secureConnect', () => { socket.end(); resolve(address); });
  })));
  pinLookup(host, address);
  routeEnv = { OTT_E2E_NEON_HOST: host, OTT_E2E_NEON_ADDRESS: address,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${path.join(frontendDir, 'scripts/e2e-network.mjs')}`.trim() };
  await check('real Neon and Redis connectivity', async () => {
    await sql`SELECT 1`;
    assert.equal(await redis(['PING']), 'PONG');
  });
  await sql.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  const statements = ['database.sql', 'arena_schema.sql', 'tournament_schema.sql', 'trueskill_migration.sql',
    'friendly_challenge_migration.sql', 'execution_token_migration.sql', 'app_settings_migration.sql',
    'adaptive_rating_migration.sql', 'teams_migration.sql', 'team_join_requests_migration.sql', 'private_trials_migration.sql', 'draw_rating_migration.sql','draw_200_migration.sql']
    .flatMap(file => splitSql(readFileSync(path.join(frontendDir, file), 'utf8')));
  await sql.transaction(txn => [txn`SELECT set_config('search_path', ${schema}, true)`, ...statements.map(text => txn.query(text))]);
  assert.equal((await scoped('SELECT current_schema() AS schema'))[0].schema, schema);
  await scoped('UPDATE rating_scheduler_state SET enabled=false WHERE id=true');
  launch('backend', 'python3', ['-B', '-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', String(backendPort)],
    path.join(root, 'backend'), { ...backendEnv, REDIS_KEY_PREFIX: prefix, PYTHONDONTWRITEBYTECODE: '1' });
  launch('frontend', 'node', ['node_modules/next/dist/bin/next', 'dev', '--hostname', '0.0.0.0', '--port', String(frontendPort)],
    frontendDir, { DATABASE_SCHEMA: schema, REDIS_KEY_PREFIX: prefix, NEXT_BUILD_DIR: buildDir,
      BACKEND_URL: backend, NEXT_PUBLIC_BACKEND_URL: backend, ...routeEnv });
  await check('local frontend/backend and Redis health', async () => {
    await waitFor('backend Redis', async () => {
      const r = await fetch(`${backend}/health`); return r.ok && (await r.json()).redis_connected;
    });
    await waitFor('frontend login page', async () => (await fetch(`${frontend}/login`)).ok);
    for (const entry of nextConfigFiles) entry.generated = readFileSync(entry.file, 'utf8');
  });
  docker(['compose', '-f', 'worker_image/compose.yaml', 'run', '--rm', '-d', '--name', container,
    '-e', `BACKEND_URL=http://host.docker.internal:${backendPort}`, '-e', `FRONTEND_URL=http://host.docker.internal:${frontendPort}`,
    '-e', `WORKER_ID=${runId}`, '-e', 'MAX_CONCURRENT=2', '-e', 'POLL_INTERVAL=0.2', 'worker-python']);
  containerStarted = true;
  await check('Docker worker connects to host services and sends running heartbeat', async () => {
    const w = await waitFor('Python worker', async () => { const w = await snapshot(); return w?.state === 'running' && w; });
    assert.equal(w.judge0_url, 'local-python://bubblewrap');
    assert.equal(w.max_concurrent, 2);
    report.workerId = w.worker_id;
  });
  const code = `def agent(observation, configuration):
    target = (8, 8) if observation['current_player'] == 1 else (0, 0)
    moves = observation['valid_moves']
    return min(moves, key=lambda m: (max(abs(m['to_col']-target[0]), abs(m['to_row']-target[1])), -int(m.get('is_capture', False)))) if moves else None
`;
  const cases = [
    { name: 'valid_one', code, status: 'active' },
    { name: 'valid_two', code, status: 'active' },
    { name: 'runtime_error', code: "def agent(observation, configuration):\n    raise ValueError('deliberate local test')", status: 'rejected' },
    { name: 'memory_limit', code: 'def agent(observation, configuration):\n    return bytearray(512 * 1024 * 1024)', status: 'rejected' },
    { name: 'wall_timeout', code: 'import time\ndef agent(observation, configuration):\n    time.sleep(60)', status: 'rejected' },
    { name: 'output_limit', code: 'def agent(observation, configuration):\n    while True: print("x" * 1000, flush=True)', status: 'rejected' },
    ...['draw_one', 'draw_two'].map(name => ({ name, status: 'active', code: `def agent(observation, configuration):
    cycle = [(1,3,0,3), (7,5,8,5), (0,3,1,3), (8,5,7,5)]
    return cycle[observation['move_count'] % 4]
` })),
  ];
  await check('agent submission and validation with real callbacks; runtime/memory/time/output failures rejected', async () => {
    for (const [index, test] of cases.entries()) {
      const account = { username: `wi_${Date.now()}_${index}`, password: `Test-${randomUUID()}` };
      const registered = await api('/api/auth/register', { method: 'POST', body: account });
      const cookie = registered.response.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      accounts.push({ ...account, cookie });
      const submitted = await api('/api/arena/agents', { method: 'POST', cookie,
        body: { agent_name: test.name, code: test.code, is_public: true } });
      test.id = Number(submitted.data.agent_id);
    }
    await waitFor('all validations', async () => {
      const rows = await scoped('SELECT id,status FROM arena_agents ORDER BY id');
      return rows.length === cases.length && rows.every(row => row.status !== 'validating');
    });
    const results = await scoped(`SELECT a.id,a.agent_name,a.status,a.validation_error,m.status AS match_status,
      m.is_infra_error,m.total_moves FROM arena_agents a JOIN rated_matches m ON m.agent1_id=a.id AND m.kind='validation' ORDER BY a.id`);
    assert.deepEqual(results.map(row => row.status), cases.map(test => test.status));
    assert.ok(results.every(row => row.match_status === 'finished' && !row.is_infra_error));
    assert.match(results[2].validation_error, /deliberate local test/);
    assert.match(results[3].validation_error, /Memory/i);
    assert.match(results[4].validation_error, /Wall time limit/);
    assert.match(results[5].validation_error, /output limit/);
    report.validations = results;
    // Keep the passive pair out of automatic scheduling until its dedicated test.
    await scoped('UPDATE arena_agents SET is_active=false WHERE id=ANY($1::bigint[])', [cases.slice(-2).map(test => test.id)]);
  });
  await scoped('UPDATE users SET is_admin=true WHERE username=$1', [accounts[0].username]);
  const login = await api('/api/auth/login', { method: 'POST', body: accounts[0] });
  const adminCookie = login.response.headers.get('set-cookie').split(';')[0];
  async function control(value, state) {
    const w = await snapshot();
    await api(`/api/admin/workers/${w.worker_id}`, { method: 'PATCH', cookie: adminCookie,
      body: { revision: w.control.revision, ...value } });
    return waitFor(`control ${state}`, async () => {
      const current = await snapshot();
      return current.state === state && current.applied_revision === current.control.revision && current;
    });
  }
  await check('admin pause/resume controls apply to the local Python runtime', async () => {
    await api('/api/admin/workers', { cookie: adminCookie });
    await control({ action: 'pause' }, 'paused');
    await control({ action: 'resume' }, 'running');
  });
  await check('rating dispatch, TrueSkill and replay persist through real frontend callbacks', async () => {
    await scoped('UPDATE rating_scheduler_state SET enabled=true WHERE id=true');
    await waitFor('rating dispatch', async () => {
      await api('/api/rating/dispatch', { method: 'POST', headers: { 'X-Worker-Callback-Secret': workerEnv.WORKER_CALLBACK_SECRET } });
      return (await scoped("SELECT id FROM rated_matches WHERE kind='rating' ORDER BY id LIMIT 1"))[0];
    });
    await scoped('UPDATE rating_scheduler_state SET enabled=false WHERE id=true');
    const match = await waitFor('rating result', async () => {
      const row = (await scoped("SELECT id,status,is_infra_error,total_moves,agent1_mu_after,agent2_mu_after FROM rated_matches WHERE kind='rating' ORDER BY id LIMIT 1"))[0];
      return row?.status === 'finished' && row;
    });
    assert.equal(match.is_infra_error, false);
    assert.notEqual(match.agent1_mu_after, null);
    assert.notEqual(match.agent2_mu_after, null);
    const scores = await scoped('SELECT rating FROM arena_agents WHERE id=ANY($1::bigint[]) ORDER BY rating', [cases.slice(0,2).map(test => test.id)]);
    assert.ok(Number(scores[0].rating) < 1000, 'A loser must not gain points just because sigma shrank');
    assert.ok(Number(scores[1].rating) > 1000);
    const replay = await api(`/api/rating/matches/${match.id}/replay`, { cookie: adminCookie });
    assert.ok(replay.data.moves.length > 0);
    assert.equal(replay.data.moves.length, match.total_moves);
    report.rating = match;
  });
  await check('friendly match and complete replay work with the Docker worker', async () => {
    const trial = await api('/api/friendly', { method: 'POST', cookie: adminCookie,
      body: { agent1_id: cases[0].id, agent2_id: cases[1].id, request_id: randomUUID() } });
    const id = Number(trial.data.friendly_match_id);
    const match = await waitFor('friendly result', async () => {
      const row = (await scoped('SELECT id,status,total_moves,is_infra_error FROM friendly_matches WHERE id=$1', [id]))[0];
      return row?.status === 'finished' && row;
    });
    assert.equal(match.is_infra_error, false);
    const replay = await api(`/api/friendly/${id}/replay`, { cookie: adminCookie });
    assert.ok(replay.data.moves.length > 0);
    assert.equal(replay.data.moves.length, match.total_moves);
    report.friendly = match;
  });
  await check('Python worker uses the 200-ply draw rule; passive play loses points and stops rematching', async () => {
    const drawCases = cases.slice(-2);
    const drawIds = drawCases.map(test => test.id);
    await scoped('UPDATE arena_agents SET is_active=true WHERE id=ANY($1::bigint[])', [drawIds]);
    const before = await scoped('SELECT id,rating,trueskill_mu,trueskill_sigma FROM arena_agents WHERE id=ANY($1::bigint[]) ORDER BY id', [drawIds]);
    const matches = [];
    for (let turn = 0; turn < 2; turn++) {
      const one = drawCases[turn], two = drawCases[1-turn];
      const [{id}] = await scoped("INSERT INTO rated_matches(kind,agent1_id,agent2_id) VALUES('rating',$1,$2) RETURNING id", [one.id,two.id]);
      matches.push(Number(id));
      const enqueued = await fetch(`${backend}/rating/enqueue`, { method:'POST',
        headers:{'Content-Type':'application/json','X-Internal-Secret':backendEnv.INTERNAL_BACKEND_SECRET},
        body:JSON.stringify({rated_match_id:Number(id),kind:'rating',agent1_id:one.id,agent2_id:two.id,
          agent1_code:one.code,agent2_code:two.code,max_moves:150}) }); // stale payload must be upgraded to 200
      assert.equal(enqueued.status, 200);
      const match = await waitFor('repetition draw', async () => {
        const [row] = await scoped('SELECT status,outcome,is_infra_error,total_moves,rating_delta_agent1,rating_delta_agent2 FROM rated_matches WHERE id=$1', [id]);
        return row.status === 'finished' && row;
      });
      assert.equal(match.outcome, 'draw');
      assert.equal(match.is_infra_error, false);
      assert.equal(match.total_moves, 200);
      assert.equal(match.rating_delta_agent1, -29);
      assert.equal(match.rating_delta_agent2, -29);
    }
    const after = await scoped('SELECT id,rating,trueskill_mu,trueskill_sigma FROM arena_agents WHERE id=ANY($1::bigint[]) ORDER BY id', [drawIds]);
    for(let i=0;i<after.length;i++){
      assert.equal(after[i].rating,before[i].rating-58);
      assert.ok(Number(after[i].trueskill_sigma)<Number(before[i].trueskill_sigma), 'Completed draws must improve confidence');
      assert.ok(Math.abs(after[i].trueskill_mu-(before[i].trueskill_mu-58/40))<1e-9);
    }
    const history = await api(`/api/arena/agents/${drawIds[0]}/rating-history`, {cookie:adminCookie});
    assert.equal(history.data.points.length, 2);
    assert.ok(history.data.points.every(point => point.before-point.after === 29));
    // Exhaust only the normal cooldown, retaining both draws in the 24h window.
    await scoped("UPDATE rated_matches SET finished_at=NOW()-INTERVAL '2 minutes' WHERE id=ANY($1::bigint[])", [matches]);
    await scoped('UPDATE arena_agents SET is_active=false WHERE NOT(id=ANY($1::bigint[]))', [drawIds]);
    await scoped('UPDATE rating_scheduler_state SET enabled=true WHERE id=true');
    const dispatch = await api('/api/rating/dispatch', {method:'POST',headers:{'X-Worker-Callback-Secret':workerEnv.WORKER_CALLBACK_SECRET}});
    assert.equal(dispatch.data.reason, 'no_eligible_pair');
    await scoped('UPDATE rating_scheduler_state SET enabled=false WHERE id=true');
    report.draws = { matches, plies:200, penaltyPerSidePerDraw:29, confidenceIncreased:true, pairBlocked:true };
  });
  await check('all deliveries ACKed and graceful stop preserves the supervisor', async () => {
    await waitFor('empty queue and active list', async () => {
      const w = await snapshot();
      return w.active_jobs === 0 && await redis(['LLEN', `${prefix}worker:queue`]) === 0
        && await redis(['LLEN', `${prefix}worker:active_list:${w.worker_id}`]) === 0;
    });
    const stopped = await control({ action: 'stop', stop_mode: 'graceful' }, 'stopped');
    assert.equal(stopped.pid, null);
    assert.equal(stopped.online, true);
    report.finalWorker = { state: stopped.state, activeJobs: stopped.active_jobs, online: stopped.online };
  });
  report.passed = true;
} catch (error) {
  report.error = `${error.name}: ${error.message}`;
  process.exitCode = 1;
  console.error(report.error);
} finally {
  // Only remove data/processes created and owned by this unique test run.
  if (containerStarted) {
    try {
      writeFileSync(path.join(logDir, 'worker.log'), docker(['logs', container]), { mode: 0o600 });
      docker(['stop', '--time', '20', container]);
    } catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  }
  for (const service of [...services].reverse()) {
    if (service.child.exitCode !== null) continue;
    try {
      const env = readFileSync(`/proc/${service.child.pid}/environ`, 'utf8').split('\0');
      assert.ok(env.includes(`OTT_E2E_RUN_ID=${runId}`));
      process.kill(-service.child.pid, 'SIGTERM');
      await Promise.race([new Promise(resolve => service.child.once('exit', resolve)), sleep(10000)]);
      if (service.child.exitCode === null && service.child.signalCode === null) process.kill(-service.child.pid, 'SIGKILL');
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) report.cleanupError = error.message; }
  }
  if (schemaCreated) {
    try {
      assert.match(schema, /^worker_image_local_\d+$/);
      let cursor = '0', removed = 0;
      do {
        const result = await redis(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', 100]);
        cursor = String(result[0]);
        if (result[1].length) removed += await redis(['DEL', ...result[1]]);
      } while (cursor !== '0');
      await sql.query(`DROP SCHEMA ${schema} CASCADE`);
      report.cleaned = { schema: true, redisKeys: removed };
    } catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  }
  rmSync(path.join(frontendDir, buildDir), { recursive: true, force: true });
  // Next dev adjusts these generated paths. Restore only when nobody edited them
  // after startup, preserving any concurrent user changes.
  for (const entry of nextConfigFiles) {
    if (entry.generated !== null && readFileSync(entry.file, 'utf8') === entry.generated) {
      writeFileSync(entry.file, entry.original);
    }
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(logDir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Report: ${path.join(logDir, 'report.json')}`);
}
