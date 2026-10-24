/** Real worker + Linux sandbox + HTTP handler + isolated in-memory PostgreSQL. No external credentials. */
import {PGlite} from '@electric-sql/pglite';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFileSync,mkdtempSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {it,expect,vi} from 'vitest';
import {snapshotSQL} from './finals-snapshot';
const {state}=vi.hoisted(()=>({state:{db:null as PGlite|null}}));
vi.mock('@/lib/finals-db',()=>({finalsQuery:async(text:string,values:unknown[]=[])=>state.db!.transaction(async tx=>{await tx.query('SET LOCAL search_path TO finals,pg_catalog');return(await tx.query(text,values)).rows;})}));
import {finalsQuery as q} from './finals-db';
import {POST as workerEndpoint} from '@/app/api/internal/finals/worker/route';
const python=process.env.CK_TEST_PYTHON||'python3';
const root=path.resolve('..');
function runPython(source:string,env:Record<string,string>={}){
 return new Promise<string>((resolve,reject)=>{
  const child=spawn(python,['-B','-c',source],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
  const timer=setTimeout(()=>{child.kill('SIGKILL');},60000);
  child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);if(code===0)resolve(out);else reject(Error(`Python ${code}: ${err}`));});
 });
}
it.skipIf(process.env.CK_REAL_E2E!=='1')('executes self-play and official games through the actual scoped HTTP API and exports offline replay',async()=>{
 state.db=new PGlite();
 const server=createServer(async(req,res)=>{
  try{let raw='';for await(const part of req)raw+=part;
   const request=new Request('http://localhost/api/internal/finals/worker',{method:'POST',headers:{authorization:String(req.headers.authorization??'')},body:raw});
   const response=await workerEndpoint(request);res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
 });
 const dir=mkdtempSync(path.join(tmpdir(),'ck-e2e-'));
 try{
  for(const file of ['database.sql','arena_schema.sql','tournament_schema.sql','trueskill_migration.sql','friendly_challenge_migration.sql','execution_token_migration.sql','adaptive_rating_migration.sql','teams_migration.sql','private_trials_migration.sql'])await state.db.exec(readFileSync(file,'utf8'));
  for(const file of ['finals_migration.sql','finals_workers_migration.sql'])await state.db.exec('BEGIN;'+readFileSync(file,'utf8').replaceAll('__FINALS_SCHEMA__','finals')+'COMMIT;');
  await state.db.exec(`INSERT INTO public.users(username,password_hash,is_admin) SELECT 'e2e'||n,'hash',n=1 FROM generate_series(1,18)n;
   INSERT INTO public.arena_agents(user_id,agent_name,code,status,is_active,is_public,rating) SELECT n,'Ranked '||n,'NEVER_EXECUTE_RATING','active',n<18,true,1000+n FROM generate_series(1,18)n;
   INSERT INTO public.rated_matches(kind,agent1_id,agent2_id,status,outcome,finished_at) SELECT 'rating',n,18,'finished','draw',now() FROM generate_series(1,17)n CROSS JOIN generate_series(1,10)k;`);
  const before=(await state.db.query('SELECT * FROM public.arena_agents ORDER BY id')).rows;
  process.env.CK_WORKER_TOKENS=JSON.stringify(Object.fromEntries([1,2,3,4,5].map(n=>[n,('e2e-'+n).repeat(8)])));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  const env={CK_FRONTEND_URL:`http://127.0.0.1:${port}`,CK_WORKER_TOKEN:('e2e-1').repeat(8),CK_WORKER_ID:'real-round-16'};
  const manifest=JSON.parse(await runPython(`import asyncio,json\nfrom worker_ck.common.runtime import Service\nasync def go():\n s=Service('round_16',1)\n if not await s.sandbox.check(): raise RuntimeError('Sandbox unavailable')\n await s.call('heartbeat')\n print(json.dumps(s.manifest))\n await s.client.aclose()\nasyncio.run(go())`,env));
  // Claim subsequent jobs under the same worker instance in a single real service process.
  const eid=Number((await q(snapshotSQL('public'),[1,'Isolated E2E',randomUUID()]))[0].id);
  const act=async(action:string,payload:unknown)=>q('SELECT admin_action(1,$1,(SELECT revision FROM editions WHERE id=$1),$2,$3::jsonb)',[eid,action,JSON.stringify(payload)]);
  await act('open_submissions',{round:1,engine_digest:manifest.digest});
  const cycle=[{from_col:1,from_row:3,to_col:0,to_row:3},{from_col:7,from_row:5,to_col:8,to_row:5},{from_col:0,from_row:3,to_col:1,to_row:3},{from_col:8,from_row:5,to_col:7,to_row:5}];
  const code=`def agent(o,c):\n    assert c['round'] == 1\n    assert 'terrain' in o['finals']\n    return ${JSON.stringify(cycle)}[o['move_count'] % 4]\n`;
  for(const e of await q('SELECT seed,participant_key FROM entrants WHERE edition_id=$1',[eid]))await q('SELECT ck_submit($1,$2,1,$3,$4,$5,1)',[Number(e.participant_key.split(':')[1]),eid,e.seed,'Finals fresh',code]);
  // Retire manifest probe identity before starting the processing service.
  await q('DELETE FROM ck_workers');
  await runPython(`import asyncio\nfrom worker_ck.common.runtime import Service\nasync def go():\n s=Service('round_16',1)\n try:\n  await s.call('heartbeat')\n  for _ in range(16):\n   job=await s.call('claim')\n   assert job['kind']=='validation'\n   await s.run_job(job)\n finally: await s.client.aclose()\nasyncio.run(go())`,env);
  expect((await q("SELECT count(*)::int AS n FROM ck_jobs WHERE status='passed'"))[0].n).toBe(16);
  await act('lock_round',{round:1});await act('open_round',{round:1});
  await q('DELETE FROM ck_workers');
  await runPython(`import asyncio\nfrom worker_ck.common.runtime import Service\nasync def go():\n s=Service('round_16',1)\n try:\n  await s.call('heartbeat')\n  for _ in range(2):\n   job=await s.call('claim')\n   assert job['kind']=='match'\n   await s.run_job(job)\n finally: await s.client.aclose()\nasyncio.run(go())`,env);
  const games=await q('SELECT * FROM games ORDER BY id LIMIT 2');expect(games.map(g=>g.status)).toEqual(['ready','ready']);
  const finished=await q("SELECT g.*,a.move_count FROM games g JOIN attempts a ON a.id=g.active_attempt WHERE g.status='ready' ORDER BY g.id");expect(finished).toHaveLength(2);expect(finished[0].move_count).toBe(8);
  // A round-2 credential cannot complete or claim round-1 jobs.
  const denied=await workerEndpoint(new Request('http://localhost',{method:'POST',headers:{Authorization:'Bearer '+('e2e-2').repeat(8)},body:JSON.stringify({action:'heartbeat',worker_id:'wrong',instance:randomUUID(),manifest,concurrency:1})}));expect(denied.status).toBe(409);
  const exported={format:'ott-finals-bundle-v2',games:[{...finished[0],round:1}],entrants:(await q('SELECT re.seed,re.round,s.code FROM ck_round_entrants re JOIN ck_submissions s ON s.id=re.submission_id WHERE re.edition_id=$1',[eid]))};
  const bundle=path.join(dir,'bundle.json'),output=path.join(dir,'record.json');writeFileSync(bundle,JSON.stringify(exported),{mode:0o600});
  await runPython(`import asyncio\nfrom types import SimpleNamespace\nfrom worker_ck.common.runtime import offline\nasyncio.run(offline('round_16',SimpleNamespace(bundle=${JSON.stringify(bundle)},game=${finished[0].id},output=${JSON.stringify(output)})))`,env);
  const record=JSON.parse(readFileSync(output,'utf8'));expect(record.moves).toHaveLength(8);expect(record.initial_state.board).toHaveLength(81);expect(statSync(output).mode&0o777).toBe(0o600);
  expect((await state.db.query('SELECT * FROM public.arena_agents ORDER BY id')).rows).toEqual(before);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await state.db.close();rmSync(dir,{recursive:true,force:true});}
},120000);
