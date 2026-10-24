// Default: read-only audit. --apply: migrate paused/drained public data atomically.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import tls from 'node:tls';
import { splitSql } from './sql-statements.mjs';
import { pinLookup } from './e2e-network.mjs';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(frontend);
const { neon, neonConfig } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const host = new URL(neonConfig.fetchEndpoint(new URL(process.env.DATABASE_URL).hostname, 5432)).hostname;
const addresses = await lookup(host, { all: true });
const address = await Promise.any(addresses.filter(a => a.family === 4).map(a => new Promise((resolve, reject) => {
  const socket = tls.connect({ host: a.address, port: 443, servername: host });
  socket.setTimeout(4000, () => socket.destroy(new Error('TLS timeout')));
  socket.once('error', reject);
  socket.once('secureConnect', () => { socket.end(); resolve(a.address); });
})));
pinLookup(host, address);
const audit = `SELECT
  (SELECT enabled FROM rating_scheduler_state WHERE id=true) AS scheduler_enabled,
  (SELECT count(*)::int FROM rated_matches WHERE kind='rating' AND status IN ('scheduled','running')) AS pending_rating,
  (SELECT count(*)::int FROM arena_agents WHERE rating<>floor(1000+40*(trueskill_mu-25)+0.5)::int) AS scores_to_correct,
  (SELECT max(rating) FROM arena_agents) AS maximum_old_score,
  (SELECT max(floor(1000+40*(trueskill_mu-25)+0.5)::int) FROM arena_agents) AS maximum_new_score,
  (SELECT count(*)::int FROM rated_matches WHERE kind='rating' AND status='finished' AND outcome='draw' AND NOT is_infra_error) AS historical_draws`;
const [before] = await sql.transaction(tx => [tx`SELECT set_config('search_path','public',true)`, tx.query(audit)]).then(rows => rows.slice(1));
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ dryRun: true, ...before[0] }, null, 2));
} else {
  const statements = splitSql(readFileSync(path.join(frontend, 'draw_rating_migration.sql'), 'utf8'));
  const results = await sql.transaction(tx => [
    tx`SELECT set_config('search_path','public',true)`,
    tx`SELECT id FROM rating_scheduler_state WHERE id=true FOR UPDATE`,
    tx`LOCK TABLE arena_agents,rated_matches IN SHARE ROW EXCLUSIVE MODE`,
    ...statements.map(statement => tx.query(statement)), tx.query(audit),
  ]);
  const report = { appliedAt: new Date().toISOString(), schema: 'public', before: before[0], after: results.at(-1)[0],
    backupTable: 'rating_policy_migrations', version: 'draw-neutral-v1' };
  const logDir = path.resolve(frontend, '../logs');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, `draw-rating-rollout-${Date.now()}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
