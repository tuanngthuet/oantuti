// Public rollout is additive, paused, and records the previous enabled flag.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { pinLookup } from './e2e-network.mjs';
import { splitSql } from './sql-statements.mjs';
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());
assert.ok(!process.env.DATABASE_SCHEMA || process.env.DATABASE_SCHEMA === 'public');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (args.includes('--neon-host')) pinLookup(option('--neon-host'), option('--neon-address'));
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const fingerprint = createHash('sha256').update(process.env.DATABASE_URL).digest('hex');
const file = '../logs/adaptive-rating-rollout.json';
if (args.includes('--resume')) {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(state.databaseFingerprint, fingerprint); assert.ok(state.applied && !state.resumed);
  await sql`UPDATE public.rating_scheduler_state SET enabled=${state.previousEnabled} WHERE id=true`;
  state.resumed = new Date().toISOString(); writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ resumed: true, enabled: state.previousEnabled }));
} else if (args.includes('--refresh')) {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(state.databaseFingerprint, fingerprint); assert.ok(state.applied && !state.resumed);
  const [current] = await sql`SELECT enabled FROM public.rating_scheduler_state WHERE id=true`;
  assert.equal(current.enabled, false, 'Refresh is only allowed during the paused rollout');
  const statements = splitSql(readFileSync('adaptive_rating_migration.sql', 'utf8'));
  await sql.transaction(txn => [txn`SELECT set_config('search_path','public',true)`, ...statements.map(text => txn.query(text))]);
  state.refreshedAt = new Date().toISOString(); writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ refreshed: true, enabled: false }));
} else if (args.includes('--apply')) {
  assert.ok(!existsSync(file), 'A rollout record already exists; inspect it before another migration');
  const state = { databaseFingerprint: fingerprint, previousEnabled: null, pausedAt: new Date().toISOString(), applied: false };
  const before = await sql`SELECT enabled FROM public.rating_scheduler_state WHERE id=true`;
  assert.equal(before.length, 1); state.previousEnabled = before[0].enabled;
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
  await sql`UPDATE public.rating_scheduler_state SET enabled=false WHERE id=true`;
  // Let an old in-flight dispatcher finish before installing the new scheduler.
  for (let attempt = 0; ; attempt++) {
    const [lease] = await sql`SELECT lease_until <= NOW() AS expired FROM public.rating_scheduler_state WHERE id=true`;
    if (lease.expired) break;
    assert.ok(attempt < 35, 'Old scheduler lease did not expire; rollout remains paused');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const statements = splitSql(readFileSync('adaptive_rating_migration.sql', 'utf8'));
  await sql.transaction(txn => [txn`SELECT set_config('search_path','public',true)`, ...statements.map(text => txn.query(text))]);
  state.applied = true; writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ applied: true, enabled: false, previousEnabled: state.previousEnabled, next: 'Deploy frontend and workers, then --resume' }));
} else {
  console.log(JSON.stringify({ mode: 'read-only', statements: splitSql(readFileSync('adaptive_rating_migration.sql', 'utf8')).length,
    scheduler: (await sql`SELECT enabled FROM public.rating_scheduler_state WHERE id=true`)[0] }));
}
