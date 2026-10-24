// Explicit public-data replacement. Stop writers, back up, then replace atomically.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createConnection } from 'node:net';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { seedUsers, seedAgents } from './test-seed-fixtures.mjs';
import { pinLookup } from './e2e-network.mjs';
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
assert.ok(args.includes('--apply') && option('--confirm') === 'RESET_PUBLIC_TEST_DATA', 'Requires --apply --confirm RESET_PUBLIC_TEST_DATA');
assert.ok(!process.env.DATABASE_SCHEMA || process.env.DATABASE_SCHEMA === 'public');
if (args.includes('--neon-host')) pinLookup(option('--neon-host'), option('--neon-address'));
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');
const sql = neon(process.env.DATABASE_URL);
const env = Object.fromEntries(readFileSync('../backend/.env', 'utf8').split(/\r?\n/).flatMap(line => {
  const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  return m ? [[m[1], m[2].replace(/^(["'])(.*)\1$/, '$2')]] : [];
}));
assert.ok(!env.REDIS_KEY_PREFIX);
const backend = 'http://127.0.0.1:8000';
const headers = { 'Content-Type': 'application/json', 'X-Internal-Secret': env.INTERNAL_BACKEND_SECRET };
async function api(route, body) {
  const response = await fetch(backend + route, { method: body ? 'PATCH' : 'GET', headers,
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
}
async function redis(command) {
  const response = await fetch(env.UPSTASH_REDIS_REST_URL, { method: 'POST', headers: {
    Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command), signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok); const data = await response.json(); if (data.error) throw Error(data.error); return data.result;
}
const business = ['users','submissions','arena_agents','arena_matches','tournament_sessions','tournament_matches',
  'match_move_history','friendly_challenges','friendly_matches','friendly_match_history','rated_matches','rated_match_move_history'];
const preserved = ['rating_scheduler_policy','rating_scheduler_state'];
const actual = await sql`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
assert.deepEqual(actual.map(t => t.tablename).sort(), [...business, ...preserved].sort(), 'Unexpected public tables; inspect foreign keys before reset');
const directory = path.resolve('../logs', `fresh-test-data-${Date.now()}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const state = { directory, phase: 'prepared', createdAt: new Date().toISOString(), workers: [], schedulerEnabled: false };
const save = () => writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
const [scheduler] = await sql`SELECT enabled FROM public.rating_scheduler_state WHERE id=true`;
state.schedulerEnabled = scheduler.enabled;
state.workers = (await api('/workers/admin')).workers.filter(w => w.managed && w.online)
  .map(w => ({ worker_id: w.worker_id, previousMode: w.control.mode, previousLimit: w.control.max_concurrent }));
save(); console.log(`Reset audit directory: ${directory}`);
await sql`UPDATE public.rating_scheduler_state SET enabled=false WHERE id=true`;
for (const worker of state.workers) {
  const current = (await api('/workers/admin')).workers.find(w => w.worker_id === worker.worker_id);
  await api(`/workers/admin/${worker.worker_id}`, { revision: current.control.revision, action: 'stop', stop_mode: 'immediate', updated_by: 'maintenance:fresh-test-data' });
}
for (let attempt = 0; ; attempt++) {
  const current = await api('/workers/admin');
  const allStopped = current.workers.filter(w => w.online).every(w => w.managed && w.state === 'stopped' && w.active_jobs === 0 && w.pid === null);
  if (allStopped) break;
  assert.ok(attempt < 35, 'Workers did not stop; no data deleted'); await new Promise(resolve => setTimeout(resolve, 1000));
}
// The frontend must be stopped externally to prevent registration/submission writes.
await new Promise((resolve, reject) => {
  const socket = createConnection({ host: '127.0.0.1', port: 3000 });
  socket.setTimeout(1000, () => { socket.destroy(); reject(Error('Cannot verify frontend shutdown')); });
  socket.once('connect', () => { socket.destroy(); reject(Error('Frontend is still running; no data deleted')); });
  socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
});
const oldAdmin = (await sql`SELECT id,username FROM public.users WHERE is_admin=true ORDER BY id LIMIT 1`)[0];
if (oldAdmin) {
  const token = await new SignJWT({ username: oldAdmin.username, is_admin: true }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(oldAdmin.id)).setIssuedAt().setExpirationTime('30m').sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  writeFileSync(path.join(directory, 'old-session-token.txt'), token, { mode: 0o600 });
}
const snapshot = await sql.transaction(txn => [...business, ...preserved].map(table => txn.query(`SELECT * FROM public."${table}"`)), { isolationLevel: 'RepeatableRead', readOnly: true });
const backup = Object.fromEntries([...business, ...preserved].map((table, index) => [table, snapshot[index]]));
writeFileSync(path.join(directory, 'database-backup.json'), JSON.stringify(backup), { mode: 0o600 });
const owned = key => key === 'worker:queue' || key === 'workers:machines' ||
  ['worker:lease:', 'worker:task_data:', 'worker:active_list:', 'tournament:', 'match:', 'matches:', 'friendly:', 'rating:', 'arena:', 'maintenance:worker_queue:backup:'].some(prefix => key.startsWith(prefix));
let cursor = '0'; const keys = [];
do { const page = await redis(['SCAN', cursor, 'COUNT', 100]); cursor = String(page[0]); keys.push(...page[1].filter(owned)); } while (cursor !== '0');
const redisBackup = [];
for (const key of [...new Set(keys)]) {
  const type = await redis(['TYPE', key]);
  const command = { string: ['GET', key], list: ['LRANGE', key, 0, -1], set: ['SMEMBERS', key], hash: ['HGETALL', key], zset: ['ZRANGE', key, 0, -1, 'WITHSCORES'] }[type];
  assert.ok(command, `Unsupported Redis backup type ${type}`);
  redisBackup.push({ key, type, ttl: await redis(['TTL', key]), value: await redis(command) });
}
writeFileSync(path.join(directory, 'redis-backup.json'), JSON.stringify(redisBackup), { mode: 0o600 });
const password = randomBytes(12).toString('base64url') + '!Aa1';
const users = seedUsers(await Promise.all(Array.from({ length: 10 }, () => bcrypt.hash(password, 12))));
const agents = seedAgents(users);
writeFileSync(path.join(directory, 'accounts.json'), JSON.stringify(users.map(u => ({ username: u.username, password, is_admin: u.is_admin })), null, 2), { mode: 0o600 });
writeFileSync(path.join(directory, 'agents.json'), JSON.stringify(agents, null, 2), { mode: 0o600 });
state.oldCounts = Object.fromEntries(business.map(table => [table, backup[table].length]));
state.phase = 'backed_up'; save();
assert.ok(existsSync(path.join(directory, 'database-backup.json')) && existsSync(path.join(directory, 'redis-backup.json')));
await sql.transaction(txn => [
  txn.query(`TRUNCATE ${business.map(table => `public."${table}"`).join(',')} RESTART IDENTITY RESTRICT`),
  txn`INSERT INTO public.users(username,password_hash,is_admin)
    SELECT username,password_hash,is_admin FROM jsonb_to_recordset(${JSON.stringify(users)}::jsonb)
    AS x(ordinal integer,username text,password_hash text,is_admin boolean) ORDER BY ordinal`,
  txn`INSERT INTO public.arena_agents(user_id,agent_name,description,code,version,status,is_active)
    SELECT u.id,x.agent_name,x.description,x.code,x.version,'validating',false
    FROM jsonb_to_recordset(${JSON.stringify(agents)}::jsonb) AS x(username text,agent_name text,description text,code text,version integer)
    JOIN public.users u ON u.username=x.username ORDER BY u.id,x.version`,
  txn`INSERT INTO public.rated_matches(kind,agent1_id,agent2_id) SELECT 'validation',id,id FROM public.arena_agents ORDER BY id`,
  txn`UPDATE public.rating_scheduler_state SET enabled=false,lease_until='epoch' WHERE id=true`,
]);
state.phase = 'database_replaced'; save();
if (redisBackup.length) await redis(['DEL', ...redisBackup.map(entry => entry.key)]);
state.phase = 'ready_for_session_rotation'; save();
console.log(JSON.stringify({ replaced: true, users: users.length, agents: agents.length, validationMatches: agents.length,
  removedOldCounts: state.oldCounts, removedRedisKeys: redisBackup.length, directory, next: 'Rotate SESSION_SECRET, start frontend, resume validation; scheduler remains paused.' }, null, 2));
