import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {lookup} from 'node:dns/promises';
import tls from 'node:tls';
import {splitSql} from './sql-statements.mjs';
import {pinLookup} from './e2e-network.mjs';
import {agentCodeIdentity} from '../lib/agent-code.ts';
const require=createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());
const {neon,neonConfig}=require('@neondatabase/serverless');
const sql=neon(process.env.DATABASE_URL);
const host=new URL(neonConfig.fetchEndpoint(new URL(process.env.DATABASE_URL).hostname,5432)).hostname;
const addresses=await lookup(host,{all:true});
const address=await Promise.any(addresses.filter(a=>a.family===4).map(a=>new Promise((resolve,reject)=>{
 const socket=tls.connect({host:a.address,port:443,servername:host});socket.setTimeout(3000,()=>socket.destroy(new Error('TLS timeout')));
 socket.once('error',reject);socket.once('secureConnect',()=>{resolve(a.address);socket.end();});
})));
pinLookup(host,address);
if(!process.argv.includes('--apply')){
 console.log(JSON.stringify(await sql`SELECT current_schema() AS schema,EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='arena_agents' AND column_name='is_public') AS migrated`));
}else{
 const agents=await sql`SELECT id,code FROM arena_agents ORDER BY id`;
 const fingerprint=`SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM rated_matches) AS rated,
 (SELECT count(*) FROM rated_match_move_history) AS rated_moves,(SELECT count(*) FROM friendly_matches) AS trials,
 (SELECT count(*) FROM friendly_match_history) AS trial_moves,
 (SELECT md5(COALESCE(string_agg(concat_ws(':',id,user_id,code,status,is_active,rating,trueskill_mu,trueskill_sigma,wins,losses,draws),'|' ORDER BY id),'')) FROM arena_agents) AS agents_digest`;
 const statements=splitSql(readFileSync('private_trials_migration.sql','utf8'));
 const results=await sql.transaction(tx=>[
 tx`SELECT set_config('search_path','public',true)`,
 tx`SELECT id FROM rating_scheduler_state WHERE id=true FOR UPDATE`,
 tx`LOCK TABLE users,arena_agents,rated_matches,rated_match_move_history,friendly_matches,friendly_match_history IN SHARE ROW EXCLUSIVE MODE`,
 tx.query(`CREATE TEMP TABLE trial_rollout_before ON COMMIT DROP AS ${fingerprint}`),
 tx.query(fingerprint),...statements.map(s=>tx.query(s)),
 ...agents.map(a=>{const c=agentCodeIdentity(a.code);return tx`UPDATE arena_agents SET normalized_code=${c.normalized},code_fingerprint=${c.fingerprint} WHERE id=${a.id} AND code=${a.code}`;}),
 tx.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM arena_agents WHERE normalized_code IS NULL OR code_fingerprint IS NULL) THEN RAISE EXCEPTION 'Concurrent code change: retry migration'; END IF; END $$`),
 tx.query(`CREATE TEMP TABLE trial_rollout_after ON COMMIT DROP AS ${fingerprint}`),
 tx.query(`DO $$ BEGIN IF (SELECT row_to_json(b)::text FROM trial_rollout_before b)<>(SELECT row_to_json(a)::text FROM trial_rollout_after a) THEN RAISE EXCEPTION 'Preservation check failed'; END IF; END $$`),
 tx.query(fingerprint),
 ]);
 const report={appliedAt:new Date().toISOString(),schema:'public',before:results[4],after:results.at(-1),preserved:true,backfilledAgents:agents.length};
 writeFileSync('../logs/private-trials-rollout.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
