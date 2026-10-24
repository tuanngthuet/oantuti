// Explicit-ID maintenance only. Refuses live Redis leases and preserves a private backup.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pinLookup } from './e2e-network.mjs';
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
assert.ok(args.includes('--ids'), 'Pass explicit --ids');
assert.match(option('--ids'), /^\d+(,\d+)*$/);
assert.ok(!process.env.DATABASE_SCHEMA || process.env.DATABASE_SCHEMA === 'public');
const ids = option('--ids').split(',').map(Number);
assert.ok(ids.every(id => Number.isSafeInteger(id) && id > 0));
if (args.includes('--neon-host')) pinLookup(option('--neon-host'), option('--neon-address'));
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const rows = await sql`SELECT id::int, status, execution_token, execution_worker FROM public.rated_matches WHERE id = ANY(${ids}::bigint[]) ORDER BY id`;
assert.equal(rows.length, ids.length);
assert.ok(rows.every(row => row.status === 'scheduled' && row.execution_token));
const env = Object.fromEntries(readFileSync('../backend/.env', 'utf8').split(/\r?\n/).flatMap(line => {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  return match ? [[match[1], match[2].replace(/^(["'])(.*)\1$/, '$2')]] : [];
}));
assert.ok(!env.REDIS_KEY_PREFIX, 'This repair targets the default queue only');
for (const id of ids) {
  const response = await fetch(env.UPSTASH_REDIS_REST_URL, { method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['EXISTS', `worker:lease:rating-${id}`]), signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok);
  const data = await response.json();
  assert.equal(data.result, 0, `rating-${id} still has a live lease; aborting`);
}
if (!args.includes('--apply')) console.log(JSON.stringify({ ids, eligible: true, changed: false }));
else {
  const backup = path.resolve('../logs', `scheduled-token-repair-${Date.now()}.json`);
  writeFileSync(backup, JSON.stringify({ capturedAt: new Date().toISOString(), schema: 'public', rows }, null, 2), { mode: 0o600, flag: 'wx' });
  const results = await sql.transaction(txn => rows.map(row => txn`
    UPDATE public.rated_matches SET execution_token = NULL, execution_worker = NULL
    WHERE id = ${row.id} AND status = 'scheduled' AND execution_token = ${row.execution_token}
    RETURNING id::int
  `));
  console.log(JSON.stringify({ updated_ids: results.flat().map(row => row.id), backup }));
}
