import { createRequire } from 'node:module';
import { readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pinLookup } from './e2e-network.mjs';
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
assert.ok(args.includes('--directory'));
const directory = path.resolve(option('--directory'));
assert.match(directory, /\/logs\/fresh-test-data-\d+$/);
const state = JSON.parse(readFileSync(path.join(directory, 'state.json'), 'utf8'));
assert.equal(state.phase, 'ready_for_session_rotation');
const accounts = JSON.parse(readFileSync(path.join(directory, 'accounts.json'), 'utf8'));
assert.equal(accounts.length, 10);
if (args.includes('--neon-host')) pinLookup(option('--neon-host'), option('--neon-address'));
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const env = Object.fromEntries(readFileSync('../backend/.env', 'utf8').split(/\r?\n/).flatMap(line => {
  const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  return m ? [[m[1], m[2].replace(/^(["'])(.*)\1$/, '$2')]] : [];
}));
const frontend = 'http://127.0.0.1:3000', backend = 'http://127.0.0.1:8000';
const internal = { 'Content-Type': 'application/json', 'X-Internal-Secret': env.INTERNAL_BACKEND_SECRET };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function http(url, options = {}, expected = 200) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, expected, `${url}: HTTP ${response.status}`);
  return { response, data: await response.json() };
}
for (let attempt = 0; ; attempt++) {
  try { await http(frontend + '/api/backend-status'); break; }
  catch (error) { if (attempt >= 30) throw error; await sleep(1000); }
}
const old = readFileSync(path.join(directory, 'old-session-token.txt'), 'utf8');
await http(frontend + '/api/auth/me', { headers: { Cookie: `auth_session=${old}` } }, 401);
console.log('PASS previous login sessions invalidated');
let adminCookie;
for (const account of accounts) {
  const login = await http(frontend + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: account.username, password: account.password }) });
  const cookie = login.response.headers.get('set-cookie').split(';')[0];
  const { data } = await http(frontend + '/api/arena/agents', { headers: { Cookie: cookie } });
  assert.equal(data.agents.length, 2);
  if (account.is_admin) adminCookie = cookie;
  else await http(frontend + '/api/admin/rating/status', { headers: { Cookie: cookie } }, 403);
}
console.log('PASS 10 real logins, 2 agents per user and admin authorization');
if (args.includes('--temporary-worker')) {
  assert.equal(state.workers.length, 0, 'Temporary worker is only needed when original workers were offline');
  let current;
  for (let attempt = 0; attempt < 20; attempt++) {
    const list = await http(backend + '/workers/admin', { headers: internal });
    current = list.data.workers.find(w => w.worker_id === option('--temporary-worker') && w.online);
    if (current) break;
    await sleep(1000);
  }
  assert.ok(current && current.state === 'stopped' && current.pid === null);
  state.workers.push({ worker_id: current.worker_id, previousMode: 'stopped', temporarySupervisorPid: current.supervisor_pid });
  writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
}
assert.ok(state.workers.length > 0, 'No validation worker available; start a supervisor explicitly');
const users = await sql`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_admin)::int AS admins FROM public.users`;
assert.deepEqual(users[0], { n: 10, admins: 1 });
const pending = await sql`SELECT m.id::int,m.agent1_id::int,m.agent2_id::int,a1.code AS agent1_code,a2.code AS agent2_code
  FROM public.rated_matches m JOIN public.arena_agents a1 ON a1.id=m.agent1_id JOIN public.arena_agents a2 ON a2.id=m.agent2_id
  WHERE m.kind='validation' AND m.status='scheduled' ORDER BY m.id`;
assert.equal(pending.length, 20);
// Fill the real validation queue without inventing any result or active flag.
for (let offset = 0; offset < pending.length; offset += 4) {
  await Promise.all(pending.slice(offset, offset + 4).map(async match => {
    await http(backend + '/rating/enqueue', { method: 'POST', headers: internal,
      body: JSON.stringify({ rated_match_id: match.id, kind: 'validation', agent1_id: match.agent1_id,
        agent2_id: match.agent2_id, agent1_code: match.agent1_code, agent2_code: match.agent2_code, max_moves: 300 }) });
    await sql`UPDATE public.rated_matches SET dispatched_at=NOW() WHERE id=${match.id} AND status='scheduled'`;
  }));
}
for (const worker of state.workers) {
  const list = await http(backend + '/workers/admin', { headers: internal });
  const current = list.data.workers.find(w => w.worker_id === worker.worker_id);
  assert.ok(current?.online, 'Original supervisor must still be online');
  await http(backend + '/workers/admin/' + worker.worker_id, { method: 'PATCH', headers: internal,
    body: JSON.stringify({ revision: current.control.revision, action: 'start', updated_by: 'maintenance:fresh-test-validation' }) });
}
console.log('Queued all 20 self-play validations; existing worker consoles resumed');
for (let attempt = 0; ; attempt++) {
  const rows = await sql`SELECT status,COUNT(*)::int AS n FROM public.arena_agents GROUP BY status ORDER BY status`;
  console.log(JSON.stringify({ agents: rows }), new Date().toISOString());
  assert.ok(!rows.some(row => row.status === 'rejected'), 'A seeded agent failed validation; inspect before enabling rating');
  if (rows.length === 1 && rows[0].status === 'active' && rows[0].n === 20) break;
  assert.ok(attempt < 120, 'Validation exceeded 20 minutes; rating remains paused');
  await sleep(10000);
}
const [validations] = await sql`SELECT COUNT(*)::int AS n,BOOL_AND(status='finished' AND NOT is_infra_error AND total_moves>0) AS valid
  FROM public.rated_matches WHERE kind='validation'`;
assert.deepEqual(validations, { n: 20, valid: true });
const mismatches = await sql`SELECT m.id FROM public.rated_matches m LEFT JOIN public.rated_match_move_history h ON h.rated_match_id=m.id
  WHERE m.kind='validation' GROUP BY m.id HAVING COUNT(h.id)<>m.total_moves`;
assert.equal(mismatches.length, 0);
for (const table of ['tournament_sessions','tournament_matches','match_move_history','friendly_matches','friendly_challenges','friendly_match_history','arena_matches','submissions']) {
  assert.equal((await sql.query(`SELECT COUNT(*)::int AS n FROM public."${table}"`))[0].n, 0);
}
for (const worker of state.workers.filter(w => w.previousMode !== 'running')) {
  const list = await http(backend + '/workers/admin', { headers: internal });
  const current = list.data.workers.find(w => w.worker_id === worker.worker_id);
  await http(backend + '/workers/admin/' + worker.worker_id, { method: 'PATCH', headers: internal,
    body: JSON.stringify({ revision: current.control.revision, action: worker.previousMode === 'paused' ? 'pause' : 'stop', updated_by: 'maintenance:restore-worker-mode' }) });
  if (worker.temporarySupervisorPid) {
    for (let attempt = 0; ; attempt++) {
      const stopped = (await http(backend + '/workers/admin', { headers: internal })).data.workers.find(w => w.worker_id === worker.worker_id);
      assert.equal(stopped.supervisor_pid, worker.temporarySupervisorPid);
      if (stopped.state === 'stopped' && stopped.pid === null) break;
      assert.ok(attempt < 30, 'Temporary worker did not stop'); await sleep(1000);
    }
    const pid = worker.temporarySupervisorPid;
    assert.equal(readlinkSync(`/proc/${pid}/cwd`), path.resolve('../worker_image'));
    assert.ok(readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('main.py'));
    process.kill(pid, 'SIGTERM');
  }
}
await sql`UPDATE public.rating_scheduler_state SET enabled=${state.schedulerEnabled} WHERE id=true`;
await http(frontend + '/api/admin/rating/status', { headers: { Cookie: adminCookie } });
state.phase = 'verified'; state.verifiedAt = new Date().toISOString();
state.result = { users: 10, admins: 1, agents: 20, activeAgents: 20, realSelfPlays: 20, replayVerified: true, schedulerEnabled: state.schedulerEnabled };
writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ passed: true, ...state.result, credentialsFile: path.join(directory, 'accounts.json') }));
