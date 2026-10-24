// Real PostgreSQL concurrency and Chrome checks on an already-passed isolated stack.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { pinLookup } from './e2e-network.mjs';
import { splitSql } from './sql-statements.mjs';
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const statePath = '../logs/e2e-state.json';
const state = JSON.parse(readFileSync(statePath, 'utf8'));
assert.match(state.schema, /^ott_e2e_\d+$/); assert.ok(!state.stopped);
const baseline = JSON.parse(readFileSync(path.join(state.logDir, 'report.json'), 'utf8'));
assert.equal(baseline.passed, true);
pinLookup(baseline.neonRoute.host, baseline.neonRoute.address);
const schema = `${state.schema}_rating`;
const retry = state.extraSchemas?.includes(schema);
assert.ok(!retry || process.argv.includes('--retry'), 'Use --retry to reset only the owned scheduler fixture');
state.extraSchemas = [...new Set([...(state.extraSchemas || []), schema])];
writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
if (retry) await sql.query(`DROP SCHEMA ${schema} CASCADE`);
await sql.query(`CREATE SCHEMA ${schema}`);
const statements = ['database.sql', 'arena_schema.sql', 'tournament_schema.sql', 'trueskill_migration.sql',
  'friendly_challenge_migration.sql','execution_token_migration.sql', 'adaptive_rating_migration.sql','teams_migration.sql','team_join_requests_migration.sql','private_trials_migration.sql'].flatMap(file => splitSql(readFileSync(file, 'utf8')));
await sql.transaction(txn => [txn`SELECT set_config('search_path', ${schema}, true)`, ...statements.map(text => txn.query(text))]);
const scoped = async (text, values = [], target = schema) => (await sql.transaction(txn => [
  txn`SELECT set_config('search_path', ${target}, true)`, txn.query(text, values),
]))[1];
const reserve = async (capacity = 4, token = randomUUID()) => (await scoped('SELECT reserve_rating_dispatch($1::uuid,$2) AS result', [token, capacity]))[0].result;
async function seed() {
  await scoped('TRUNCATE users, arena_agents, rated_matches RESTART IDENTITY CASCADE');
  await scoped('UPDATE rating_scheduler_state SET enabled=true WHERE id=true');
  await scoped("INSERT INTO users(username,password_hash) VALUES ('a','x'),('b','x'),('c','x'),('d','x')");
  await scoped("INSERT INTO arena_agents(user_id,agent_name,code,status,is_active) SELECT id,username,'code','active',true FROM users");
  await scoped('UPDATE arena_agents SET is_public=true');
}
const checks = [];
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
await check('real concurrent HTTP database transactions reserve disjoint agents', async () => {
  await seed();
  const reservations = await Promise.all(Array.from({ length: 10 }, () => reserve()));
  const created = reservations.filter(row => row.match_id);
  assert.equal(created.length, 2);
  assert.equal(new Set(created.flatMap(row => [row.agent1_id, row.agent2_id])).size, 4);
  assert.equal((await scoped('SELECT COUNT(*)::int AS n FROM rated_matches'))[0].n, 2);
});
await check('expired dispatch token cannot acknowledge a newer reservation', async () => {
  await seed(); await scoped('UPDATE arena_agents SET is_active=false WHERE id>2');
  const old = randomUUID(), next = randomUUID();
  const first = await reserve(4, old);
  await scoped("UPDATE rated_matches SET dispatch_lease_until=NOW()-INTERVAL '1 second'");
  assert.equal((await reserve(4, next)).match_id, first.match_id);
  assert.equal((await scoped('UPDATE rated_matches SET dispatched_at=NOW() WHERE dispatch_token=$1::uuid RETURNING id', [old])).length, 0);
});
await check('stable agents stop creating matches and refresh after 24 hours', async () => {
  await seed(); await scoped('UPDATE arena_agents SET is_active=false WHERE id>2');
  await scoped("INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,finished_at) SELECT 'rating',1,2,'finished',NOW()-INTERVAL '2 hours' FROM generate_series(1,10)");
  await scoped('UPDATE arena_agents SET trueskill_sigma=2');
  assert.equal((await reserve()).reason, 'no_eligible_pair');
  await scoped("UPDATE rated_matches SET finished_at=NOW()-INTERVAL '25 hours'");
  assert.ok((await reserve()).match_id);
});
await check('daily budget blocks new reservations, infrastructure failures do not consume it', async () => {
  await seed(); await scoped('UPDATE arena_agents SET is_active=false WHERE id>2');
  await scoped("INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,finished_at) SELECT 'rating',1,2,'finished',NOW()-INTERVAL '1 hour' FROM generate_series(1,20)");
  assert.equal((await reserve()).match_id, undefined);
  await scoped("UPDATE rated_matches SET status='error',is_infra_error=true,finished_at=NOW()-INTERVAL '20 minutes'");
  assert.ok((await reserve()).match_id);
});
const account = JSON.parse(readFileSync(path.join(state.logDir, 'accounts.json'), 'utf8'))[0];
const login = await fetch(`${state.frontend}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(account) });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];
const env = Object.fromEntries(readFileSync('../backend/.env', 'utf8').split(/\r?\n/).flatMap(line => {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  return match ? [[match[1], match[2].replace(/^(["'])(.*)\1$/, '$2')]] : [];
}));
const headers = { 'Content-Type': 'application/json', 'X-Internal-Secret': env.INTERNAL_BACKEND_SECRET };
async function workers() {
  const response = await fetch(`${state.backend}/workers/admin`, { headers }); assert.ok(response.ok); return response.json();
}
const worker = (await workers()).workers.find(w => w.managed && w.online);
assert.ok(worker);
if (worker.control.mode !== 'paused') {
  const pause = await fetch(`${state.backend}/workers/admin/${worker.worker_id}`, { method: 'PATCH', headers,
    body: JSON.stringify({ revision: worker.control.revision, action: 'pause', updated_by: 'e2e-rating' }) });
  assert.ok(pause.ok);
}
for (let attempt = 0; ; attempt++) {
  const current = (await workers()).workers.find(w => w.worker_id === worker.worker_id);
  if (current.state === 'paused' && current.active_jobs === 0) break;
  assert.ok(attempt < 30, 'Worker did not pause'); await new Promise(resolve => setTimeout(resolve, 1000));
}
const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addCookies([{ name: 'auth_session', value: cookie.slice('auth_session='.length), url: state.frontend, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await check('Chrome shows per-agent budgets, needs and scheduler control independent of rebuild', async () => {
    await page.goto(`${state.frontend}/admin/rating`);
    await page.getByRole('button', { name: 'Bật tạo rating', exact: true }).waitFor();
    await page.getByRole('columnheader', { name: 'Còn lượt/24h' }).waitFor();
    await page.getByText('Đang hiệu chỉnh', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Bật tạo rating', exact: true }).click();
    await page.getByRole('button', { name: 'Tạm dừng tạo rating', exact: true }).waitFor();
    assert.equal((await scoped('SELECT enabled FROM rating_scheduler_state', [], state.schema))[0].enabled, true);
    await page.getByRole('button', { name: 'Tạm dừng tạo rating', exact: true }).click();
    await page.getByRole('button', { name: 'Bật tạo rating', exact: true }).waitFor();
    assert.equal((await scoped('SELECT enabled FROM rating_scheduler_state', [], state.schema))[0].enabled, false);
    await page.screenshot({ path: path.join(state.logDir, 'adaptive-rating.png'), fullPage: true });
    assert.deepEqual(errors, []);
  });
} finally { await browser.close(); }
writeFileSync(path.join(state.logDir, 'adaptive-rating-report.json'), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), checks, schema, frontend: state.frontend }, null, 2));
console.log(`Report: ${state.logDir}/adaptive-rating-report.json`);
