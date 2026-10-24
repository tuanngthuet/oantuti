// Full hosted season: real Neon schemas, Next production server, five Docker workers, Chrome.
// Setup fixtures are isolated; every finals validation/move/result goes through the real application.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {existsSync,readFileSync,writeFileSync,mkdirSync,openSync,closeSync,readlinkSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import tls from 'node:tls';
import assert from 'node:assert/strict';
import {chromium,request as playwrightRequest} from 'playwright-core';
import {splitSql} from './sql-statements.mjs';
import {pinLookup} from './e2e-network.mjs';

const frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.dirname(frontend),require=createRequire(import.meta.url);
require('@next/env').loadEnvConfig(frontend);
const {neon,neonConfig}=require('@neondatabase/serverless');
const bcrypt=require('bcryptjs');
const sql=neon(process.env.DATABASE_URL);
const stateFile=path.join(root,'logs/ck-season-state.json');
const names=['round_16','quarterfinal','semifinal','final','third_place'];
const labels=['Vòng 16','Tứ kết','Bán kết','Chung kết','Tranh hạng ba'];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let state,secrets,browser,admin,guest,accounts=new Map();
const contexts=[],checks=[],browserErrors=[];
function save(file,value){writeFileSync(file,JSON.stringify(value,null,2),{mode:0o600});}
function saveState(){save(stateFile,state);save(path.join(state.logDir,'state.json'),state);}
function log(message){console.log(new Date().toISOString()+' '+message);}
function sanitize(error){let s=String(error?.stack||error);for(const secret of [process.env.DATABASE_URL,secrets?.password,secrets?.session,...Object.values(secrets?.tokens??{})])if(secret)s=s.replaceAll(secret,'[private]');return s;}
async function wait(label,fn,seconds=240){
 const end=Date.now()+seconds*1000;let last;
 while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(error){if(error.name==='AssertionError')throw error;last=error;}
  await pause(1000);
 }
 throw Error(`Timeout ${label}${last?': '+last.message:''}`);
}
async function retry(fn){for(let n=0;;n++){try{return await fn();}catch(error){if(n>=3||!/connect|timeout|fetch failed/i.test(error.message))throw error;await pause(500*(n+1));}}}
async function routeDatabase(){
 const host=new URL(neonConfig.fetchEndpoint(new URL(process.env.DATABASE_URL).hostname,5432)).hostname;
 const addresses=await lookup(host,{all:true});
 const address=await Promise.any(addresses.filter(a=>a.family===4).map(a=>new Promise((resolve,reject)=>{
  const s=tls.connect({host:a.address,port:443,servername:host});s.setTimeout(3500,()=>s.destroy(Error('TLS timeout')));s.once('error',reject);s.once('secureConnect',()=>{s.end();resolve(a.address);});
 })));
 pinLookup(host,address);return {host,address};
}
async function scoped(text,values=[],schema=state.finals){
 const result=await retry(()=>sql.transaction(tx=>[tx`SELECT set_config('search_path',${schema+',pg_catalog'},true)`,tx.query(text,values)]));return result[1];
}
async function fingerprint(schema,tables){
 const result={};for(const table of tables){
  assert.match(schema,/^[a-z_][a-z0-9_]*$/);assert.match(table,/^[a-z_][a-z0-9_]*$/);
  const exists=(await sql.query('SELECT to_regclass($1) IS NOT NULL AS present',[schema+'.'+table]))[0].present;
  if(exists)result[table]=(await sql.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS digest FROM ${schema}.${table} t`))[0];
 }return result;
}
async function command(program,args,logName,options={}){
 const fd=openSync(path.join(state.logDir,logName),'a',0o600);
 try{await new Promise((resolve,reject)=>{
  const child=spawn(program,args,{cwd:options.cwd??root,env:{...process.env,...options.env},stdio:['ignore',fd,fd]});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`${program} exited ${code}; see ${logName}`)));
 });}finally{closeSync(fd);}
}
async function api(client,url,data,expected=200){
 const response=data===undefined?await client.get(state.url+url):await client.post(state.url+url,{data});
 const body=await response.json();assert.equal(response.status(),expected,`${url}: ${JSON.stringify(body)}`);return body;
}
async function info(){return api(admin,`/api/admin/finals?id=${state.editionId}`);}
async function action(action,payload={}){
 const d=await info();return api(admin,'/api/admin/finals',{action,edition_id:Number(state.editionId),revision:d.edition.revision,...payload});
}
async function check(label,fn){await fn();checks.push(label);log('PASS '+label);save(path.join(state.logDir,'checks.json'),checks);}
async function clients(){
 admin=await playwrightRequest.newContext();guest=await playwrightRequest.newContext();contexts.push(admin,guest);
 await api(admin,'/api/auth/login',{username:'admin',password:secrets.password});
 const users=await scoped('SELECT id,username FROM users WHERE username<>$1 ORDER BY id',['admin'],state.source);
 save(path.join(state.logDir,'accounts.json'),{url:state.url,admin:{username:'admin',password:secrets.password},users:users.map(u=>({id:Number(u.id),username:u.username,password:secrets.password}))});
 for(const user of users){const client=await playwrightRequest.newContext();contexts.push(client);await api(client,'/api/auth/login',{username:user.username,password:secrets.password});accounts.set(Number(user.id),{...user,client});}
 browser=await chromium.launch({executablePath:process.env.CK_CHROME||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
}
function captureErrors(page){page.on('pageerror',e=>browserErrors.push(e.message));page.on('dialog',d=>d.type()==='prompt'?d.accept('Hosted season test'):d.accept());}
async function browserContext(client){const ctx=await browser.newContext({storageState:await client.storageState(),viewport:{width:1500,height:1100}});contexts.push(ctx);return ctx;}
function roundCard(page,round){return page.locator('article').filter({has:page.getByRole('heading',{level:3,name:new RegExp('^'+labels[round-1]+' · (Chưa mở nhận bài|submitting|locked|running)$')})});}
async function openRoundForSubmissions(page,round){
 await page.reload();const card=roundCard(page,round);await card.getByRole('button',{name:'Mở nhận bài',exact:true}).waitFor();
 await card.getByRole('button',{name:'Mở nhận bài',exact:true}).click();
 return wait('round '+round+' submissions',async()=>{const d=await info();const r=d.rounds.find(r=>r.round===round);return r?.status==='submitting'&&r;});
}
async function setup(){
 if(existsSync(stateFile)){const old=JSON.parse(readFileSync(stateFile,'utf8'));assert.ok(old.stopped,'A hosted season already exists; use --verify/--resume/--stop first.');}
 const suffix=Date.now()+'_'+randomUUID().slice(0,6),runId='ck_season_'+suffix;
 const port=Number(process.env.CK_SEASON_PORT||3305);assert.ok(Number.isInteger(port)&&port>1024&&port<65536);
 state={runId,source:'ott_'+runId,finals:'finals_'+runId,port,url:`http://127.0.0.1:${port}`,logDir:path.join(root,'logs',runId),startedAt:new Date().toISOString(),containers:[],processes:[],buildDir:'.next-ck-test'};
 assert.match(state.source,/^ott_ck_season_\d+_[a-f0-9]{6}$/);assert.match(state.finals,/^finals_ck_season_\d+_[a-f0-9]{6}$/);
 try{await fetch(state.url,{signal:AbortSignal.timeout(1000)});throw Error('Hosted test port already occupied');}catch(error){if(error.message==='Hosted test port already occupied')throw error;}
 mkdirSync(state.logDir,{recursive:true,mode:0o700});writeFileSync(path.join(state.logDir,'.gitignore'),'*\n');
 secrets={password:'Season_'+randomBytes(18).toString('hex'),session:randomBytes(40).toString('hex'),tokens:Object.fromEntries([1,2,3,4,5].map(r=>[r,randomBytes(40).toString('hex')]))};save(path.join(state.logDir,'secrets.json'),secrets);saveState();
 const route=await routeDatabase();state.route=route;saveState();
 state.productionBefore={public:await fingerprint('public',['users','arena_agents','rated_matches','friendly_matches','rated_match_move_history']),finals:await fingerprint('finals',['editions','entrants','pairs','games','attempts','moves','audit'])};saveState();
 await sql.query(`CREATE SCHEMA ${state.source}`);await sql.query(`CREATE SCHEMA ${state.finals}`);
 const normal=['database.sql','arena_schema.sql','tournament_schema.sql','trueskill_migration.sql','friendly_challenge_migration.sql','execution_token_migration.sql','adaptive_rating_migration.sql','teams_migration.sql','team_join_requests_migration.sql','private_trials_migration.sql'];
 for(const file of normal){const statements=splitSql(readFileSync(path.join(frontend,file),'utf8'));await sql.transaction(tx=>[tx`SELECT set_config('search_path',${state.source+',pg_catalog'},true)`,...statements.map(s=>tx.query(s))]);}
 for(const file of ['finals_migration.sql','finals_workers_migration.sql']){const statements=splitSql(readFileSync(path.join(frontend,file),'utf8').replaceAll('__FINALS_SCHEMA__',state.finals));await sql.transaction(tx=>statements.map(s=>tx.query(s)));}
 const hash=bcrypt.hashSync(secrets.password,10);
 await scoped('UPDATE users SET password_hash=$1 WHERE username=$2',[hash,'admin'],state.source);
 await scoped("INSERT INTO users(username,password_hash) SELECT 'ck_player'||lpad(n::text,2,'0'),$1 FROM generate_series(1,16)n",[hash],state.source);
 await scoped("INSERT INTO users(username,password_hash) VALUES('ck_teammate',$1),('ck_spectator',$1)",[hash],state.source);
 await scoped("SELECT manage_team(2,'create','{\"name\":\"CK Test Team 01\"}'::jsonb)",[],state.source);
 await scoped('INSERT INTO team_members(team_id,user_id) SELECT id,18 FROM teams',[],state.source);
 // Eligibility fixtures only, in the isolated source schema. No production rating is written.
 await scoped(`INSERT INTO arena_agents(user_id,agent_name,description,code,status,is_active,is_public,rating,team_id)
 SELECT n+1,'Eligibility fixture '||n,'TEST FIXTURE ONLY; never executed by finals','NEVER_EXECUTE_RATING_FIXTURE','active',true,true,2000-n*10,CASE WHEN n=1 THEN (SELECT id FROM teams LIMIT 1) END FROM generate_series(1,16)n`,[],state.source);
 await scoped("INSERT INTO arena_agents(user_id,agent_name,code,status,is_active,is_public) VALUES(19,'Fixture opponent','NEVER_EXECUTE_RATING_FIXTURE','active',false,false)",[],state.source);
 await scoped("INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,outcome,finished_at) SELECT 'rating',n,17,'finished','draw',now() FROM generate_series(1,16)n CROSS JOIN generate_series(1,10)k",[],state.source);
 await scoped('UPDATE rating_scheduler_state SET enabled=false WHERE id=true',[],state.source);
 state.sourceBefore=await fingerprint(state.source,['arena_agents','rated_matches','friendly_matches']);saveState();
 log('Isolated Neon schemas created; real source/season data preserved');
 const environment={DATABASE_SCHEMA:state.source,FINALS_SCHEMA:state.finals,CK_WORKER_TOKENS:JSON.stringify(secrets.tokens),SESSION_SECRET:secrets.session,NEXT_BUILD_DIR:state.buildDir,CK_SEASON_RUN_ID:state.runId,BACKEND_URL:'http://127.0.0.1:1',NEXT_PUBLIC_BACKEND_URL:'http://127.0.0.1:1',OTT_E2E_NEON_HOST:route.host,OTT_E2E_NEON_ADDRESS:route.address,NODE_OPTIONS:`${process.env.NODE_OPTIONS||''} --import=${path.join(frontend,'scripts/e2e-network.mjs')}`.trim()};
 log('Building the production host');
 await command(process.execPath,['node_modules/next/dist/bin/next','build'],'build.log',{cwd:frontend,env:environment});
 const fd=openSync(path.join(state.logDir,'frontend.log'),'a',0o600);
 const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(state.port)],{cwd:frontend,detached:true,stdio:['ignore',fd,fd],env:{...process.env,...environment}});child.unref();closeSync(fd);state.processes.push({name:'frontend',pid:child.pid});saveState();
 await wait('production host',async()=>{try{return(await fetch(state.url+'/api/finals',{signal:AbortSignal.timeout(10000)})).ok;}catch{return false;}},90);
 for(const [i,name] of names.entries()){
  const image=`oantuti-ck-${name}:season-${suffix}`;
  log('Building and starting actual round worker '+(i+1));
  await command('docker',['build','-q','-f',`worker_ck/${name}/Dockerfile`,'-t',image,'.'],`build-${name}.log`);
  const envFile=path.join(state.logDir,`${name}.env`);writeFileSync(envFile,`CK_FRONTEND_URL=${state.url}\nCK_WORKER_ID=${state.runId}-${name}\nCK_WORKER_TOKEN=${secrets.tokens[i+1]}\n`,{mode:0o600});
  const container=`${state.runId}-${name}`;
  await command('docker',['run','-d','--name',container,'--label','ck.season.run='+state.runId,'--network','host','--init','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--security-opt','seccomp=unconfined','--security-opt','apparmor=unconfined','--tmpfs','/tmp:rw,size=64m,mode=1777','--pids-limit','128','--memory','1g','--cpus','2','--env-file',envFile,image,'--concurrency','4'],`start-${name}.log`);
  state.containers.push({name:container,round:i+1,image});saveState();
 }
 await clients();
 log('Host and five worker containers online at '+state.url);
}
async function season(){
 const adminContext=await browserContext(admin),adminPage=await adminContext.newPage();captureErrors(adminPage);
 await check('guest cannot administer finals; 16 isolated eligible participants',async()=>{
  await api(guest,'/api/admin/finals?id=1',undefined,403);
  const index=await api(guest,'/api/finals');assert.equal(index.preview.length,16);
 });
 if(!state.editionId){
  await adminPage.goto(state.url+'/admin/finals');
  await adminPage.getByLabel('Tên đợt chung kết').fill('Hosted season '+state.runId);
  await adminPage.getByRole('button',{name:'Chốt top 16 (16/16)',exact:true}).click();
  state.editionId=await wait('snapshot from browser',async()=>{const d=await api(admin,'/api/finals');return d.editions[0]?.id;});saveState();
 }
 await adminPage.goto(state.url+'/admin/finals');
 await wait('five real worker registrations',async()=>{const d=await info();return d.workers.filter(w=>w.online).length===5;});
 const entrants=(await info()).entrants;
 assert.equal(entrants.length,16);assert.equal(entrants.find(e=>e.seed===1).members.length,2);
 const source=readFileSync(path.join(root,'worker_ck/testing/season_agent.py'),'utf8');
 for(const round of [1,2,3,4,5]){
  let data=await info();const roundPairs=data.pairs.filter(p=>p.round===round);
  if(roundPairs.every(p=>p.status==='confirmed')){log('Round '+round+' was already confirmed; verifying later');continue;}
  log('Starting '+labels[round-1]);
  let cfg=data.rounds.find(r=>r.round===round);
  if(!cfg)cfg=await openRoundForSubmissions(adminPage,round);
  data=await info();const seeds=[...new Set(data.pairs.filter(p=>p.round===round).flatMap(p=>[p.seed1,p.seed2]))].sort((a,b)=>a-b);
  assert.ok(seeds.every(Number.isInteger));
  if(cfg.status==='submitting'){
   await check(`round ${round}: blocked before all fresh valid submissions`,async()=>{
    const current=data.submissions.filter(s=>s.round===round);
    if(current.length!==seeds.length||!current.every(s=>s.validation_status==='passed'))await api(admin,'/api/admin/finals',{action:'lock_round',edition_id:Number(state.editionId),revision:data.edition.revision,round},409);
   });
   const spectator=accounts.get(19).client;
   await check(`round ${round}: spectator cannot read or submit competitors' code`,async()=>{
    assert.equal((await api(spectator,`/api/finals/submissions?edition_id=${state.editionId}`)).rounds.length,0);
    await api(spectator,'/api/finals/submissions',{edition_id:Number(state.editionId),round,generation:cfg.generation,seed:seeds[0],name:'Forbidden',code:'def agent(o,c): return {}'},403);
   });
   for(const [index,seed] of seeds.entries()){
    const existing=(await info()).submissions.find(s=>s.round===round&&s.seed===seed);
    if(existing?.latest_id)continue;
    const entrant=entrants.find(e=>e.seed===seed);
    const userId=entrant.participant_key.startsWith('team:')?18:Number(entrant.participant_key.split(':')[1]);
    const participant=accounts.get(userId).client;
    const code=`COMPETITOR = ${seed}\n`+source;
    if(index===0){
     const context=await browserContext(participant),page=await context.newPage();captureErrors(page);
     await page.goto(state.url+`/finals/${state.editionId}`);
     const select=page.locator('section select');await select.selectOption(`${round}:${seed}`);
     await page.getByLabel('Tên agent',{exact:true}).fill(`CK ${seed} round ${round}`);
     await page.getByLabel('Code agent Chung kết').fill(code);
     await page.getByRole('button',{name:'Nộp và kiểm tra self-play',exact:true}).click();
     await page.getByRole('status').filter({hasText:'Đã nộp'}).waitFor({timeout:30000});
     await page.screenshot({path:path.join(state.logDir,`round-${round}-submission.png`),fullPage:true});await page.close();
    }else await api(participant,'/api/finals/submissions',{edition_id:Number(state.editionId),round,generation:cfg.generation,seed,name:`CK ${seed} round ${round}`,code});
   }
   await check(`round ${round}: all ${seeds.length} self-plays run by the exact round worker`,async()=>{
    await wait('validations round '+round,async()=>{
     const d=await info();const rows=d.submissions.filter(s=>s.round===round);
     const failed=rows.filter(s=>['failed','needs_attention'].includes(s.validation_status));assert.equal(failed.length,0,JSON.stringify(failed));
     return rows.length===seeds.length&&rows.every(s=>s.validation_status==='passed');
    },240);
    const jobs=await scoped("SELECT j.round,w.round AS worker_round,j.status,j.kind FROM ck_jobs j JOIN ck_workers w ON w.id=j.worker_id AND w.instance=j.instance WHERE j.edition_id=$1 AND j.round=$2 AND j.kind='validation'",[state.editionId,round]);
    assert.equal(jobs.length,seeds.length);assert.ok(jobs.every(j=>j.round===j.worker_round&&j.status==='passed'));
   });
   await adminPage.reload();const card=roundCard(adminPage,round);
   const lock=card.getByRole('button',{name:`Khóa bài (${seeds.length}/${seeds.length})`,exact:true});await lock.waitFor();await lock.click();
   await wait('round locked',async()=>((await info()).rounds.find(r=>r.round===round)?.status==='locked'));
   cfg=(await info()).rounds.find(r=>r.round===round);
  }
  if(cfg.status==='locked'){
   await adminPage.reload();const card=roundCard(adminPage,round);await card.getByRole('button',{name:'Mở đấu',exact:true}).click();
   await wait('round running',async()=>((await info()).rounds.find(r=>r.round===round)?.status==='running'));
  }
  await check(`round ${round}: ${seeds.length} official games completed by engine, without adjudication/import`,async()=>{
   await wait('official games round '+round,async()=>{
    const d=await info();const ids=d.pairs.filter(p=>p.round===round).map(p=>String(p.id));const games=d.games.filter(g=>ids.includes(String(g.pair_id)));
    const failed=games.filter(g=>g.status==='needs_attention');assert.equal(failed.length,0,JSON.stringify(failed));
    return games.length===seeds.length&&games.every(g=>g.status==='ready'&&g.source==='ck_worker');
   },300);
  });
  data=await info();const ids=data.pairs.filter(p=>p.round===round).map(p=>String(p.id));const games=data.games.filter(g=>ids.includes(String(g.pair_id)));
  for(const game of games){
   if(!game.published){await api(guest,`/api/finals/games/${game.id}`,undefined,404);await action('publish',{game_id:Number(game.id)});}
   const replay=await api(guest,`/api/finals/games/${game.id}`);
   assert.equal(replay.moves.length,replay.game.move_count);assert.ok(replay.moves.length>0);assert.equal(replay.game.source,'ck_worker');
   assert.ok(!JSON.stringify(replay).includes('def agent'));assert.equal(replay.game.engine_digest,data.rounds.find(r=>r.round===round).engine_digest);
   assert.deepEqual(replay.moves.map(m=>m.move_number),Array.from({length:replay.moves.length},(_,i)=>i+1));
  }
  await adminPage.reload();
  for(const pair of data.pairs.filter(p=>p.round===round&&p.status!=='confirmed')){
   const article=adminPage.locator('article').filter({has:adminPage.getByRole('heading',{level:3,name:new RegExp('^'+labels[round-1]+' · Cặp '+pair.slot+' · ')})});
   await article.getByRole('button',{name:'Xác nhận kết quả cặp',exact:true}).click();
   await wait('pair '+pair.id+' confirmed',async()=>(await info()).pairs.find(p=>String(p.id)===String(pair.id))?.status==='confirmed');
  }
  await check(`round ${round}: every pair winner, loser and score follows the two real games`,async()=>{
   data=await info();for(const pair of data.pairs.filter(p=>p.round===round)){
    const records=data.games.filter(g=>String(g.pair_id)===String(pair.id));assert.equal(records.length,2);
    assert.deepEqual(records.sort((a,b)=>a.leg-b.leg).map(g=>[g.seed1,g.seed2]),[[pair.seed1,pair.seed2],[pair.seed2,pair.seed1]]);
    const points=records.reduce((n,g)=>n+(g.outcome==='draw'?.5:((g.outcome==='agent1'?g.seed1:g.seed2)===pair.seed1?1:0)),0);
    const winner=points>1?pair.seed1:points<1?pair.seed2:Math.min(pair.seed1,pair.seed2);
    assert.equal(pair.winner_seed,winner);assert.equal(Number(pair.points1),points);assert.equal(Number(pair.points2),2-points);assert.equal(pair.status,'confirmed');
   }
  });
  await adminPage.reload();await roundCard(adminPage,round).waitFor();await adminPage.screenshot({path:path.join(state.logDir,`round-${round}-admin.png`),fullPage:true});
  state.completedRound=round;saveState();
  log('Finished '+labels[round-1]+': '+data.pairs.filter(p=>p.round===round).map(p=>`#${p.winner_seed}`).join(', '));
 }
 await verify();
 const publicContext=await browser.newContext({viewport:{width:1500,height:1100}});contexts.push(publicContext);const page=await publicContext.newPage();captureErrors(page);
 await page.goto(state.url+`/finals/${state.editionId}`);await page.getByRole('heading',{name:'VÔ ĐỊCH',exact:true}).waitFor();await page.screenshot({path:path.join(state.logDir,'championship-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth+2));await page.screenshot({path:path.join(state.logDir,'championship-mobile.png'),fullPage:true});
 const finals=(await info()).pairs.find(p=>p.round===4);const game=(await info()).games.find(g=>String(g.pair_id)===String(finals.id));
 await page.goto(state.url+`/finals/games/${game.id}`);await page.getByText(new RegExp('^Nước 0/')).waitFor();await page.getByRole('button',{name:'Nước sau',exact:true}).click();await page.getByText(new RegExp('^Nước 1/')).waitFor();await page.screenshot({path:path.join(state.logDir,'championship-replay-mobile.png'),fullPage:true});
 assert.deepEqual(browserErrors,[]);
 checks.push('Chrome: real admin controls, real round submission, final bracket on desktop/mobile, real finals replay');
 state.passed=true;delete state.failure;state.completedAt=new Date().toISOString();save(path.join(state.logDir,'checks.json'),[...new Set(checks)]);saveState();await report();
}
async function verify(){
 const data=await info();assert.equal(data.edition.status,'finished');assert.equal(data.pairs.length,16);assert.ok(data.pairs.every(p=>p.status==='confirmed'));assert.equal(data.games.length,32);assert.ok(data.games.every(g=>g.published&&g.status==='ready'&&g.source==='ck_worker'));
 assert.ok(!data.audit.some(a=>['adjudicate','import','retry','interrupt'].includes(a.action)),'No manufactured or retried official result');
 const jobs=await scoped('SELECT j.*,w.round AS worker_round FROM ck_jobs j LEFT JOIN ck_workers w ON w.id=j.worker_id AND w.round=j.round WHERE j.edition_id=$1 ORDER BY j.id',[state.editionId]);
 assert.equal(jobs.filter(j=>j.kind==='validation').length,32);assert.equal(jobs.filter(j=>j.kind==='match').length,32);assert.ok(jobs.every(j=>j.status==='passed'&&j.round===j.worker_round&&j.worker_id===state.runId+'-'+names[j.round-1]));
 const bundle=await api(admin,`/api/admin/finals/${state.editionId}/bundle`);const records=[];
 for(const game of data.games){
  const record=await api(guest,`/api/finals/games/${game.id}`);
  for(const side of [1,2])assert.equal(record.game['agent'+side+'_name'],bundle.entrants.find(e=>e.round===record.game.round&&e.seed===record.game['seed'+side]).name,'Replay must identify the locked round submission, not the original rating agent');
  records.push(record);
 }
 save(path.join(state.logDir,'bundle.json'),bundle);save(path.join(state.logDir,'records.json'),records);
 await command(process.env.CK_TEST_PYTHON||'python3',['-B','-m','worker_ck.testing.verify_season',path.join(state.logDir,'bundle.json'),path.join(state.logDir,'records.json')],'replay-verification.log');
 state.replayVerification=JSON.parse(readFileSync(path.join(state.logDir,'replay-verification.log'),'utf8').trim().split(/\n/).at(-1));
 const multiRound=await scoped('SELECT seed,count(*)::int AS submissions,count(DISTINCT round)::int AS rounds,count(DISTINCT code_hash)::int AS hashes FROM ck_submissions WHERE edition_id=$1 GROUP BY seed HAVING count(*)>1',[state.editionId]);
 assert.ok(multiRound.length>0&&multiRound.every(s=>s.submissions===s.rounds&&s.hashes===1),'Same source must still be freshly submitted each round');
 const sourceAfter=await fingerprint(state.source,['arena_agents','rated_matches','friendly_matches']);assert.deepEqual(sourceAfter,state.sourceBefore,'Even isolated ordinary rating agents/results must be unchanged');
 const productionAfter={public:await fingerprint('public',['users','arena_agents','rated_matches','friendly_matches','rated_match_move_history']),finals:await fingerprint('finals',['editions','entrants','pairs','games','attempts','moves','audit'])};
 assert.deepEqual(productionAfter,state.productionBefore,'Existing production data changed during test; inspect before claiming preservation');
 state.productionAfter=productionAfter;state.sourceAfter=sourceAfter;
 checks.push('Full season: 32 fresh submissions, 32 real self-plays, 32 real official games, all 16 pairs confirmed; ordinary and original finals data unchanged');saveState();
 await report();
}
async function report(error){
 const data=state.editionId&&admin?await info().catch(()=>null):null;
 const entrant=seed=>data?.entrants.find(e=>e.seed===seed)?.name;
 const final=data?.pairs.find(p=>p.round===4),bronze=data?.pairs.find(p=>p.round===5);
 const summary={passed:state.passed??false,runId:state.runId,url:state.url,editionId:state.editionId,sourceSchema:state.source,finalsSchema:state.finals,
  champion:final?.winner_seed?{seed:final.winner_seed,name:entrant(final.winner_seed)}:null,runnerUp:final?.loser_seed?{seed:final.loser_seed,name:entrant(final.loser_seed)}:null,
  third:bronze?.winner_seed?{seed:bronze.winner_seed,name:entrant(bronze.winner_seed)}:null,fourth:bronze?.loser_seed?{seed:bronze.loser_seed,name:entrant(bronze.loser_seed)}:null,
  rounds:[1,2,3,4,5].map(round=>({round,label:labels[round-1],winners:data?.pairs.filter(p=>p.round===round).map(p=>({seed:p.winner_seed,name:entrant(p.winner_seed),score:[p.points1,p.points2]}))})),
  games:data?.games,attempts:data?.attempts,replayVerification:state.replayVerification,checks:[...new Set(checks)],productionDataPreserved:!!state.productionAfter,fixtureRatingDataPreserved:!!state.sourceAfter,
  artifacts:state.logDir,error:error?sanitize(error):undefined};
 save(path.join(state.logDir,'report.json'),summary);
 if(state.passed&&!error){
  const lines=['# Hosted Chung kết: toàn mùa đã hoàn tất','',`Host: ${state.url}/finals/${state.editionId}`,'',
   'Production build Next.js, Neon PostgreSQL thật, 5 container worker và sandbox thật. Dữ liệu thử nằm trong hai schema riêng; không dùng API giả lập hoặc chỉ định kết quả.',
   '',`- Vô địch: #${summary.champion?.seed} ${summary.champion?.name}`,`- Á quân: #${summary.runnerUp?.seed} ${summary.runnerUp?.name}`,
   `- Hạng ba: #${summary.third?.seed} ${summary.third?.name}`,`- Hạng tư: #${summary.fourth?.seed} ${summary.fourth?.name}`,'',
   '| Vòng | Người thắng từng cặp |','| --- | --- |',
   ...summary.rounds.map(r=>`| ${r.label} | ${r.winners?.map(w=>'#'+w.seed+' '+w.name).join(', ')} |`),'',
   '32 bài nộp mới; 32 self-play; 32 ván chính thức; 16 cặp đã xác nhận. Agent rating, rating/friendly và giải cũ được đối chiếu giữ nguyên.',
   '',summary.replayVerification?`Đã chạy lại độc lập ${summary.replayVerification.replays_verified} replay và kiểm tra ${summary.replayVerification.legal_moves_verified} nước đi hợp lệ.`:'',
   '', 'Tài khoản thử ở accounts.json (0600). Bản ghi kết quả ở report.json; ảnh từng vòng và sơ đồ cuối cùng cùng thư mục.'];
  writeFileSync(path.join(state.logDir,'REPORT.md'),lines.join('\n')+'\n',{mode:0o600});
 }

 if(!error&&state.passed)log(JSON.stringify({passed:true,url:state.url+`/finals/${state.editionId}`,champion:summary.champion,runnerUp:summary.runnerUp,third:summary.third,fourth:summary.fourth,report:path.join(state.logDir,'report.json')}));
}
async function rebuildHost(){
 assert.ok(state.completedAt,'Only rebuild an already completed hosted season');
 await stop(false);
 const route=await routeDatabase();state.route=route;
 const environment={DATABASE_SCHEMA:state.source,FINALS_SCHEMA:state.finals,CK_WORKER_TOKENS:JSON.stringify(secrets.tokens),SESSION_SECRET:secrets.session,NEXT_BUILD_DIR:state.buildDir,CK_SEASON_RUN_ID:state.runId,BACKEND_URL:'http://127.0.0.1:1',NEXT_PUBLIC_BACKEND_URL:'http://127.0.0.1:1',OTT_E2E_NEON_HOST:route.host,OTT_E2E_NEON_ADDRESS:route.address,NODE_OPTIONS:`${process.env.NODE_OPTIONS||''} --import=${path.join(frontend,'scripts/e2e-network.mjs')}`.trim()};
 log('Rebuilding the owned host; preserving all 32 completed games');
 await command(process.execPath,['node_modules/next/dist/bin/next','build'],'build.log',{cwd:frontend,env:environment});
 const fd=openSync(path.join(state.logDir,'frontend.log'),'a',0o600);
 const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(state.port)],{cwd:frontend,detached:true,stdio:['ignore',fd,fd],env:{...process.env,...environment}});child.unref();closeSync(fd);
 state.processes=[{name:'frontend',pid:child.pid}];state.stopped=false;delete state.stoppedAt;saveState();
 await wait('rebuilt host',async()=>{try{return(await fetch(state.url+'/api/finals')).ok;}catch{return false;}},90);
 for(const c of state.containers)await command('docker',['start',c.name],'restart-workers.log');
 await clients();await wait('five workers after rebuild',async()=>(await info()).workers.filter(w=>w.online).length===5);
 await verify();
 const context=await browser.newContext({viewport:{width:390,height:844}});contexts.push(context);const page=await context.newPage();captureErrors(page);
 const data=await info(),pair=data.pairs.find(p=>p.round===4),game=data.games.find(g=>String(g.pair_id)===String(pair.id));
 await page.goto(state.url+`/finals/games/${game.id}`);await page.getByText(new RegExp('^Nước 0/')).waitFor();
 await page.getByText('CK '+game.seed1+' round 4 · P1 đi trước',{exact:true}).waitFor();
 await page.getByText('CK '+game.seed2+' round 4 · P2',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Nước sau',exact:true}).click();await page.getByText(new RegExp('^Nước 1/')).waitFor();
 await page.screenshot({path:path.join(state.logDir,'championship-replay-mobile.png'),fullPage:true});
 assert.deepEqual(browserErrors,[]);checks.push('All 32 live replay APIs and Chrome use the correct locked per-round agent names; completed results remain unchanged');
 state.passed=true;delete state.failure;save(path.join(state.logDir,'checks.json'),[...new Set(checks)]);saveState();await report();
}

async function stop(cleanup){
 assert.match(state.source,/^ott_ck_season_\d+_[a-f0-9]{6}$/);assert.match(state.finals,/^finals_ck_season_\d+_[a-f0-9]{6}$/);
 for(const c of state.containers){
  const inspect=spawnSync('docker',['inspect','--format','{{index .Config.Labels "ck.season.run"}}',c.name],{encoding:'utf8'});
  if(inspect.status===0){assert.equal(inspect.stdout.trim(),state.runId);await command('docker',['stop','--time','15',c.name],'stop.log');}
 }
 for(const service of state.processes){
  try{const env=readFileSync(`/proc/${service.pid}/environ`,'utf8').split('\0');assert.ok(env.includes('CK_SEASON_RUN_ID='+state.runId));assert.equal(readlinkSync(`/proc/${service.pid}/cwd`),frontend);process.kill(service.pid,'SIGTERM');}catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}
 }
 if(cleanup){await sql.query(`DROP SCHEMA ${state.finals} CASCADE`);await sql.query(`DROP SCHEMA ${state.source} CASCADE`);state.cleanedUp=true;}
 state.stopped=true;state.stoppedAt=new Date().toISOString();saveState();log('Owned test services stopped'+(cleanup?' and isolated schemas removed':''));
}
try{
 if(process.argv.includes('--run')){await setup();await season();}
 else{
  assert.ok(existsSync(stateFile),'No hosted test state');state=JSON.parse(readFileSync(stateFile,'utf8'));secrets=JSON.parse(readFileSync(path.join(state.logDir,'secrets.json'),'utf8'));if(existsSync(path.join(state.logDir,'checks.json')))checks.push(...JSON.parse(readFileSync(path.join(state.logDir,'checks.json'),'utf8')));if(existsSync(path.join(state.logDir,'report.json'))){const previous=JSON.parse(readFileSync(path.join(state.logDir,'report.json'),'utf8'));if(previous.passed)checks.push(...previous.checks);}await routeDatabase();
  if(process.argv.includes('--rebuild'))await rebuildHost();
  else if(process.argv.includes('--stop'))await stop(process.argv.includes('--cleanup'));
  else if(process.argv.includes('--resume')){await clients();await season();}
  else if(process.argv.includes('--verify')){await clients();await verify();log('Hosted full-season verification passed');}
  else throw Error('Use --run, --resume, --verify, --rebuild, or --stop [--cleanup]');
 }
}catch(error){
 console.error(sanitize(error));if(state){state.passed=false;state.failure=sanitize(error);saveState();await report(error).catch(()=>{});for(const c of state.containers)await command('docker',['logs',c.name],`${c.round}-worker.log`).catch(()=>{});}process.exitCode=1;
}finally{
 await browser?.close();for(const context of contexts)await(context.dispose?.()??context.close?.()).catch(()=>{});
}
