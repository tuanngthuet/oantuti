import { createRequire } from 'node:module';
import { readFileSync,writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import tls from 'node:tls';
import { splitSql } from './sql-statements.mjs';
import { pinLookup } from './e2e-network.mjs';
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());
const {neon,neonConfig} = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const host = new URL(neonConfig.fetchEndpoint(new URL(process.env.DATABASE_URL).hostname,5432)).hostname;
const addresses = await lookup(host,{all:true});
const address = await Promise.any(addresses.filter(a=>a.family===4).map(a=>new Promise((resolve,reject)=>{
  const socket=tls.connect({host:a.address,port:443,servername:host});
  socket.setTimeout(3000,()=>socket.destroy(new Error('TLS timeout')));socket.once('error',reject);
  socket.once('secureConnect',()=>{resolve(a.address);socket.end();});
})));
pinLookup(host,address);
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify(await sql`SELECT current_schema() AS schema,to_regclass('public.teams') IS NOT NULL AS migrated`,null,2));
} else {
  const statements=splitSql(readFileSync('teams_migration.sql','utf8'));
  const fingerprint=`SELECT (SELECT count(*) FROM users)::int AS users,(SELECT count(*) FROM rated_matches)::int AS matches,
    (SELECT count(*) FROM rated_match_move_history)::int AS moves,
    (SELECT md5(COALESCE(string_agg(concat_ws(':',id,user_id,status,is_active,rating,trueskill_mu,trueskill_sigma,wins,losses,draws),'|' ORDER BY id),'')) FROM arena_agents) AS agents_digest`;
  const results=await sql.transaction(tx=>[
    tx`SELECT set_config('search_path','public',true)`,
    tx`SELECT id FROM rating_scheduler_state WHERE id=true FOR UPDATE`,
    tx`LOCK TABLE users,arena_agents,rated_matches,rated_match_move_history IN SHARE ROW EXCLUSIVE MODE`,
    tx.query(fingerprint),...statements.map(s=>tx.query(s)),tx.query(fingerprint),
  ]);
  const before=results[3],after=results.at(-1);
  if (JSON.stringify(before)!==JSON.stringify(after)) throw new Error('Unexpected data fingerprint change; inspect rollout');
  const report={appliedAt:new Date().toISOString(),schema:'public',before,after,preserved:true};
  writeFileSync('../logs/teams-rollout.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
