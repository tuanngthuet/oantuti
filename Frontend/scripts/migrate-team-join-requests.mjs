// Apply only this additive migration; never rerun rating-reset migrations.
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {lookup} from 'node:dns/promises';
import tls from 'node:tls';
import {splitSql} from './sql-statements.mjs';
import {pinLookup} from './e2e-network.mjs';
const require=createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());
const {neon,neonConfig}=require('@neondatabase/serverless');
const sql=neon(process.env.DATABASE_URL);
const host=new URL(neonConfig.fetchEndpoint(new URL(process.env.DATABASE_URL).hostname,5432)).hostname;
const addresses=await lookup(host,{all:true});
const address=await Promise.any(addresses.filter(a=>a.family===4).map(a=>new Promise((resolve,reject)=>{
  const socket=tls.connect({host:a.address,port:443,servername:host});
  socket.setTimeout(3000,()=>socket.destroy(new Error('TLS timeout')));
  socket.once('error',reject);socket.once('secureConnect',()=>{resolve(a.address);socket.end();});
})));
pinLookup(host,address);
if(!process.argv.includes('--apply')) {
  console.log(JSON.stringify(await sql`SELECT to_regclass('public.team_join_requests') IS NOT NULL AS migrated`));
} else {
  const fingerprint=`SELECT (SELECT count(*) FROM users) AS users,
    (SELECT count(*) FROM rated_matches) AS matches,
    (SELECT md5(COALESCE(string_agg(row_to_json(a)::text,'|' ORDER BY id),'')) FROM arena_agents a) AS agents,
    (SELECT md5(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY id),'')) FROM teams t) AS teams,
    (SELECT md5(COALESCE(string_agg(row_to_json(m)::text,'|' ORDER BY user_id),'')) FROM team_members m) AS members`;
  const statements=splitSql(readFileSync(new URL('../team_join_requests_migration.sql',import.meta.url),'utf8'));
  const results=await sql.transaction(tx=>[
    tx`SELECT set_config('search_path','public',true)`,
    tx`SELECT id FROM rating_scheduler_state WHERE id=true FOR UPDATE`,
    tx`LOCK TABLE users,arena_agents,rated_matches,teams,team_members IN SHARE ROW EXCLUSIVE MODE`,
    tx.query(`CREATE TEMP TABLE join_requests_before ON COMMIT DROP AS ${fingerprint}`),
    tx.query(fingerprint),...statements.map(s=>tx.query(s)),
    tx.query(`CREATE TEMP TABLE join_requests_after ON COMMIT DROP AS ${fingerprint}`),
    tx.query(`DO $$ BEGIN IF (SELECT row_to_json(b)::text FROM join_requests_before b)<>
      (SELECT row_to_json(a)::text FROM join_requests_after a) THEN RAISE EXCEPTION 'Data preservation failed'; END IF; END $$`),
    tx.query(fingerprint),
  ]);
  const report={appliedAt:new Date().toISOString(),before:results[4],after:results.at(-1),preserved:true};
  mkdirSync('../logs',{recursive:true});
  writeFileSync('../logs/team-join-requests-rollout.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
