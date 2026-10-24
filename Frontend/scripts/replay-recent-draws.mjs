// Node 24+. Audit by default. --apply backs up, removes only the last 24h of
// rating/friendly draw results, rebuilds ranked effects and queues the same IDs.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {lookup} from 'node:dns/promises';
import tls from 'node:tls';
import {pinLookup} from './e2e-network.mjs';
import {displayRating,rate1v1,TRUESKILL} from '../lib/trueskill.ts';
import {evaluateDraw} from '../lib/draw-penalty.ts';
import {splitSql} from './sql-statements.mjs';
import {resetDrawQueries} from './replay-draws-queries.mjs';

const frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
require('@next/env').loadEnvConfig(frontend);
const {neon,neonConfig}=require('@neondatabase/serverless');
const sql=neon(process.env.DATABASE_URL);
const parseEnv=p=>Object.fromEntries(readFileSync(p,'utf8').split(/\r?\n/).flatMap(l=>{
  const m=l.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);return m?[[m[1],m[2].replace(/^(["'])(.*)\1$/,'$2')]]:[];
}));
const env=parseEnv(path.resolve(frontend,'../backend/.env'));
const host=new URL(neonConfig.fetchEndpoint(new URL(process.env.DATABASE_URL).hostname,5432)).hostname;
const address=await Promise.any((await lookup(host,{all:true})).filter(a=>a.family===4).map(a=>new Promise((resolve,reject)=>{
  const s=tls.connect({host:a.address,port:443,servername:host});s.setTimeout(4000,()=>s.destroy(new Error('TLS timeout')));
  s.once('error',reject);s.once('secureConnect',()=>{s.end();resolve(a.address);});
})));
pinLookup(host,address);
const since=new Date(Date.now()-24*3600*1000).toISOString();
const stateQuery=`SELECT jsonb_build_object(
 'scheduler',(SELECT to_jsonb(s) FROM rating_scheduler_state s WHERE id=true),
 'agents',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM arena_agents a),'[]'::jsonb),
 'rated',COALESCE((SELECT jsonb_agg(to_jsonb(m)||jsonb_build_object('scope_allowed',match_scope_allowed(kind,agent1_id,agent2_id)) ORDER BY id) FROM rated_matches m),'[]'::jsonb),
 'tournament',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM tournament_matches m),'[]'::jsonb),
 'friendly',COALESCE((SELECT jsonb_agg(to_jsonb(m)||jsonb_build_object('scope_allowed',trial_scope_allowed(id)) ORDER BY id) FROM friendly_matches m),'[]'::jsonb),
 'rated_moves',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY rated_match_id,move_number) FROM rated_match_move_history h WHERE rated_match_id IN
   (SELECT id FROM rated_matches WHERE kind='rating' AND status='finished' AND outcome='draw')),'[]'::jsonb),
 'friendly_moves',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY friendly_match_id,move_number) FROM friendly_match_history h WHERE friendly_match_id IN
   (SELECT id FROM friendly_matches WHERE status='finished' AND outcome='draw' AND finished_at>='${since}'::timestamptz)),'[]'::jsonb)
) AS data`;
const [{data,digest}]=await sql.query(`SELECT data,md5(data::text) AS digest FROM (${stateQuery}) s`);
const wasEnabled=data.scheduler.enabled;
const rated=data.rated.filter(m=>m.kind==='rating'&&m.status==='finished'&&m.outcome==='draw'&&!m.is_infra_error&&Date.parse(m.finished_at)>=Date.parse(since));
const friendly=data.friendly.filter(m=>m.status==='finished'&&m.outcome==='draw'&&!m.is_infra_error&&Date.parse(m.finished_at)>=Date.parse(since));
const ids=rated.map(m=>Number(m.id)), friendlyIds=friendly.map(m=>Number(m.id));
async function redis(command){
 const r=await fetch(env.UPSTASH_REDIS_REST_URL,{method:'POST',headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(15000)});
 const body=await r.json();if(!r.ok||body.error)throw Error(body.error||`Redis HTTP ${r.status}`);return body.result;
}
const managed=await redis(['SMEMBERS','workers:managed'])||[];
const owners=managed.length?await redis(['MGET',...managed.map(id=>`workers:owner:${id}`)]):[];
const activeOwners=managed.filter((_,i)=>owners[i]);
const known=JSON.parse(await redis(['GET','workers:known'])||'{}');
const legacyIds=Object.keys(known).filter(id=>!managed.includes(id));
const legacyStates=legacyIds.length?await redis(['MGET',...legacyIds.map(id=>`worker:${id}`)]):[];
const liveLegacy=legacyStates.filter(raw=>raw&&Date.now()/1000-JSON.parse(raw).last_seen<90).length;
const report={since,ratedResults:ids,friendlyResults:friendlyIds,eligibleRated:rated.filter(m=>m.scope_allowed).length,
 eligibleFriendly:friendly.filter(m=>m.scope_allowed).length,runningRating:data.rated.filter(m=>m.kind==='rating'&&m.status==='running').length,
 liveManagedWorkers:activeOwners.length,liveLegacyWorkers:liveLegacy};
console.log(JSON.stringify({dryRun:!process.argv.includes('--apply'),...report},null,2));
if(!process.argv.includes('--apply'))process.exit(0);
if(!ids.length&&!friendlyIds.length){console.log('No recent draws to replay.');process.exit(0);}
if(activeOwners.length||liveLegacy)throw Error('Live workers detected; pause/drain them before applying this maintenance');
if(report.runningRating)throw Error('Running rating matches detected; drain them before rebuilding scores');

// Rebuild all ranked effects in chronological order, excluding only reset games.
const ratings=new Map(data.agents.map(a=>[Number(a.id),{mu:TRUESKILL.initialMu,sigma:TRUESKILL.initialSigma,wins:0,losses:0,draws:0}]));
const history=[...data.tournament.map(m=>({...m,source:'tournament'})),...data.rated.filter(m=>m.kind==='rating'&&!ids.includes(Number(m.id))).map(m=>({...m,source:'rated'}))]
 .filter(m=>m.status==='finished'&&!m.is_infra_error&&['agent1','agent2','draw'].includes(m.outcome))
 .sort((a,b)=>Date.parse(a.finished_at||a.scheduled_at)-Date.parse(b.finished_at||b.scheduled_at)||a.source.localeCompare(b.source)||Number(a.id)-Number(b.id));
const snapshots=[];
for(const m of history){
 const a=ratings.get(Number(m.agent1_id)),b=ratings.get(Number(m.agent2_id));if(!a||!b)continue;
 const before1={mu:a.mu,sigma:a.sigma},before2={mu:b.mu,sigma:b.sigma};
 const after=rate1v1(before1,before2,m.outcome);
 if(m.source==='rated'&&m.outcome==='draw'&&m.total_moves===200){
  const penalty=evaluateDraw(data.rated_moves.filter(h=>Number(h.rated_match_id)===Number(m.id)));
  after.agent1.mu-=penalty.agent1.penalty/40;after.agent2.mu-=penalty.agent2.penalty/40;
 }
 if(m.outcome==='agent1'){a.wins++;b.losses++;}else if(m.outcome==='agent2'){b.wins++;a.losses++;}else{a.draws++;b.draws++;}
 Object.assign(a,after.agent1);Object.assign(b,after.agent2);
 if(m.source==='rated')snapshots.push({id:Number(m.id),agent1_mu_before:before1.mu,agent1_sigma_before:before1.sigma,
  agent1_mu_after:a.mu,agent1_sigma_after:a.sigma,agent2_mu_before:before2.mu,agent2_sigma_before:before2.sigma,
  agent2_mu_after:b.mu,agent2_sigma_after:b.sigma,rating_delta_agent1:displayRating(a)-displayRating(before1),rating_delta_agent2:displayRating(b)-displayRating(before2)});
}
const agentRows=[...ratings].map(([id,a])=>({id,...a,rating:displayRating(a)}));
const runId=`draw_replay_${Date.now()}`;
const logDir=path.resolve(frontend,'../logs',runId);mkdirSync(logDir,{recursive:true,mode:0o700});
writeFileSync(path.join(logDir,'.gitignore'),'*\n');
writeFileSync(path.join(logDir,'backup.json'),JSON.stringify({since,digest,data,report},null,2),{mode:0o600});
// Guard the exact audited state under write locks. A stale plan aborts entirely.
const commands=resetDrawQueries({stateQuery,digest,runId,data,report,ids,friendlyIds,agentRows,snapshots,wasEnabled,
 migration:splitSql(readFileSync(path.join(frontend,'draw_200_migration.sql'),'utf8'))});
const result=await sql.transaction(tx=>commands.map(q=>tx.query(q.text,q.values)));
// Keep reruns durable in PostgreSQL. The dispatcher now serializes pending
// matches sharing an agent, preventing stale concurrent rating overwrites.
const applied={...report,runId,backupTable:'draw_replay_backups',replayedHistoricalRatings:snapshots.length,
 resetRated:result[8].length,resetFriendly:result[9].length,scheduledRated:ids.length,scheduledFriendly:friendlyIds.length,
 schedulerEnabled:wasEnabled,dispatch:'serialized_by_agent'};
const [verification]=await sql`SELECT
 (SELECT count(*)::int FROM rated_matches WHERE id=ANY(${ids}::bigint[]) AND status='scheduled' AND outcome IS NULL AND total_moves=0) AS rated_scheduled,
 (SELECT count(*)::int FROM friendly_matches WHERE id=ANY(${friendlyIds}::bigint[]) AND status='scheduled' AND outcome IS NULL AND total_moves=0) AS friendly_scheduled,
 (SELECT count(*)::int FROM rated_match_move_history WHERE rated_match_id=ANY(${ids}::bigint[])) AS old_rated_moves,
 (SELECT count(*)::int FROM friendly_match_history WHERE friendly_match_id=ANY(${friendlyIds}::bigint[])) AS old_friendly_moves`;
applied.verification=verification;
writeFileSync(path.join(logDir,'report.json'),JSON.stringify(applied,null,2),{mode:0o600});
if(verification.rated_scheduled!==ids.length||verification.friendly_scheduled!==friendlyIds.length||verification.old_rated_moves||verification.old_friendly_moves)throw Error(`Post-commit verification failed; inspect ${logDir}`);
console.log(JSON.stringify(applied,null,2));console.log(`Report: ${path.join(logDir,'report.json')}`);
