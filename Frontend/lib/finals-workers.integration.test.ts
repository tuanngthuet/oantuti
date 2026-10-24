import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {snapshotSQL} from './finals-snapshot';
const {state,session}=vi.hoisted(()=>({state:{db:null as PGlite|null},session:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:session}));
vi.mock('@/lib/finals-db',()=>({finalsQuery:async(text:string,values:unknown[]=[])=>state.db!.transaction(async tx=>{await tx.query("SET LOCAL search_path TO finals,pg_catalog");return(await tx.query(text,values)).rows;})}));
import {finalsQuery} from './finals-db';
import {workerAction,workerRound} from './finals-workers';
import {GET as own,POST as submitAPI} from '@/app/api/finals/submissions/route';
import {GET as replay} from '@/app/api/finals/games/[id]/route';
import {GET as bundle} from '@/app/api/admin/finals/[id]/bundle/route';
import {editionData} from './finals';
import {finalsResetQueries} from '../scripts/finals-reset-queries.mjs';
const q=async(sql:string,values:unknown[]=[])=>finalsQuery(sql,values);
const upgrade=()=>state.db!.exec('BEGIN;'+readFileSync('finals_workers_migration.sql','utf8').replaceAll('__FINALS_SCHEMA__','finals')+'COMMIT;');
const digests=[1,2,3,4,5].map(n=>String(n).repeat(64));
const workers=[1,2,3,4,5].map(round=>({worker_id:'test-'+round,instance:randomUUID(),manifest:{round,contract_version:1,digest:digests[round-1],engine_version:'ott-finals-v1',rules:{engine_version:'ott-finals-v1',max_moves:150,repetition:3}},concurrency:1}));
const worker=(round:number,action:string,payload:Record<string,unknown>={})=>workerAction(round,{...workers[round-1],action,...payload});
const act=async(id:number,action:string,payload:Record<string,unknown>={})=>q('SELECT admin_action(1,$1,(SELECT revision FROM editions WHERE id=$1),$2,$3::jsonb)',[id,action,JSON.stringify(payload)]);
const create=async()=>Number((await q(snapshotSQL('public'),[1,'New finals',randomUUID()]))[0].id);
const open=async(id:number,round=1)=>act(id,'open_submissions',{round,engine_digest:digests[round-1]});
const request=(id:number)=>new Request('http://localhost/api/finals/submissions?edition_id='+id);
const body=(id:number,seed:number,round=1)=>({edition_id:id,generation:1,round,seed,name:'Finals only',code:'def agent(o,c): return o["valid_moves"][0]'});
const post=(value:unknown)=>new Request('http://localhost',{method:'POST',body:JSON.stringify(value)});
async function submitAll(id:number,round:number){
 const entrants=await q('SELECT re.seed,e.participant_key FROM ck_round_entrants re JOIN entrants e ON e.edition_id=re.edition_id AND e.seed=re.seed WHERE re.edition_id=$1 AND re.round=$2 ORDER BY re.seed',[id,round]);
 for(const e of entrants)await q('SELECT ck_submit($1,$2,$3,$4,$5,$6,1)',[Number(e.participant_key.split(':')[1]),id,round,e.seed,'New round code '+e.seed,'def agent(o,c): return o["valid_moves"][0]']);
 for(let i=0;i<entrants.length;i++){const job=await worker(round,'claim');expect(job.kind).toBe('validation');expect(await worker(round,'complete',{job_id:Number(job.id),token:job.token})).toBe(true);}
}
beforeAll(async()=>{
 state.db=new PGlite();
 for(const file of ['database.sql','arena_schema.sql','tournament_schema.sql','trueskill_migration.sql','friendly_challenge_migration.sql','execution_token_migration.sql','adaptive_rating_migration.sql','teams_migration.sql','private_trials_migration.sql'])await state.db.exec(readFileSync(file,'utf8'));
 await state.db.exec('BEGIN;'+readFileSync('finals_migration.sql','utf8').replaceAll('__FINALS_SCHEMA__','finals')+'COMMIT;');
 await upgrade();
},30000);
afterAll(async()=>state.db?.close());
beforeEach(async()=>{
 session.mockResolvedValue(null);
 await state.db!.exec(`TRUNCATE finals.editions,finals.ck_workers,public.users,public.arena_agents,public.rated_matches RESTART IDENTITY CASCADE;
 INSERT INTO public.users(username,password_hash,is_admin) SELECT 'p'||n,'hash',n=1 FROM generate_series(1,18)n;
 INSERT INTO public.arena_agents(user_id,agent_name,code,status,is_active,is_public,rating) SELECT n,'Rating '||n,'RATING_PRIVATE_'||n,'active',n<18,true,1000+n FROM generate_series(1,18)n;
 INSERT INTO public.rated_matches(kind,agent1_id,agent2_id,status,outcome,finished_at) SELECT 'rating',n,18,'finished','draw',now() FROM generate_series(1,17)n CROSS JOIN generate_series(1,10)k;`);
 for(const r of [1,2,3,4,5])await worker(r,'heartbeat');
});
it('pins scoped credentials and rejects mismatching engines and worker identities',async()=>{
 process.env.CK_WORKER_TOKENS=JSON.stringify(Object.fromEntries([1,2,3,4,5].map(n=>[n,('token'+n).repeat(8)])));
 expect(workerRound('Bearer '+('token3').repeat(8))).toBe(3);expect(workerRound('Bearer rating-secret')).toBeNull();
 await expect(workerAction(2,{...workers[0],action:'heartbeat'})).rejects.toThrow('CK_ENGINE_MISMATCH');
 await expect(workerAction(1,{...workers[0],instance:randomUUID(),action:'heartbeat'})).rejects.toThrow('CK_WORKER_ID_BUSY');
});
it('requires fresh latest passing submission, preserves code identity and hides code from others',async()=>{
 const id=await create();await open(id);
 const [entrant]=await q('SELECT * FROM entrants WHERE edition_id=$1 AND seed=1',[id]);const user=Number(entrant.participant_key.split(':')[1]);
 expect((await submitAPI(post(body(id,1)))).status).toBe(401);
 session.mockResolvedValue({id:18,is_admin:false});expect((await submitAPI(post(body(id,1)))).status).toBe(403);
 session.mockResolvedValue({id:user,is_admin:false});expect((await submitAPI(post(body(id,1)))).status).toBe(200);
 expect((await(await own(request(id))).json()).rounds[0].code).toContain('def agent');
 await expect(act(id,'lock_round',{round:1})).rejects.toThrow('CK_MISSING_VALID_SUBMISSIONS');
 expect(await worker(2,'claim')).toBeNull();
 const job=await worker(1,'claim');expect(job.agent1_code).toEqual(job.agent2_code);
 expect(await worker(2,'complete',{job_id:Number(job.id),token:job.token})).toBe(false);
 expect(await worker(1,'complete',{job_id:Number(job.id),token:job.token})).toBe(true);
 expect((await submitAPI(post(body(id,1)))).status).toBe(200); // identical code explicitly allowed
 await expect(act(id,'lock_round',{round:1})).rejects.toThrow('CK_MISSING_VALID_SUBMISSIONS');
 session.mockResolvedValue(null);expect((await(await own(request(id))).json()).rounds).toEqual([]);
 expect(JSON.stringify(await editionData(id))).not.toContain('def agent');
 await expect(q("UPDATE ck_submissions SET code='changed'")).rejects.toThrow('IMMUTABLE_SNAPSHOT');
});
it('uses snapshotted team members even after membership changes',async()=>{
 await state.db!.exec(`SELECT public.manage_team(15,'create','{"name":"Team"}');INSERT INTO public.team_members(team_id,user_id) SELECT id,14 FROM public.teams;`);
 const id=await create();await open(id);const [team]=await q("SELECT seed FROM entrants WHERE name='Team'");
 await state.db!.exec('DELETE FROM public.team_members WHERE user_id=14;INSERT INTO public.team_members(team_id,user_id) SELECT id,13 FROM public.teams;');
 await q('SELECT ck_submit(14,$1,1,$2,$3,$4,1)',[id,team.seed,'Team submission','def agent(o,c): return {}']);
 await expect(q('SELECT ck_submit(13,$1,1,$2,$3,$4,1)',[id,team.seed,'Outsider','def agent(o,c): return {}'])).rejects.toThrow('CK_FORBIDDEN');
});
it('runs every round with new submissions, inverted sides, pinned engines and untouched ratings',async()=>{
 const before=await state.db!.query('SELECT * FROM public.arena_agents ORDER BY id');const id=await create();
 for(const round of [1,2,3,4,5]){
  await open(id,round);await expect(act(id,'lock_round',{round})).rejects.toThrow('CK_MISSING_VALID_SUBMISSIONS');
  await submitAll(id,round);await act(id,'lock_round',{round});
  await expect(open(id,round)).rejects.toThrow('CK_ROUND_LOCKED');
  await expect(q('SELECT ck_submit(17,$1,$2,1,$3,$4,1)',[id,round,'Late','def agent(o,c): return {}'])).rejects.toThrow('CK_SUBMISSIONS_CLOSED');
  await act(id,'open_round',{round});
  const games=await q('SELECT g.*,p.seed1 AS pair_seed1,p.seed2 AS pair_seed2 FROM games g JOIN pairs p ON p.id=g.pair_id WHERE p.edition_id=$1 AND p.round=$2',[id,round]);
  for(const game of games){expect(game.engine_digest).toBe(digests[round-1]);expect(game.submission1).toBeTruthy();expect([game.seed1,game.seed2]).toEqual(game.leg===1?[game.pair_seed1,game.pair_seed2]:[game.pair_seed2,game.pair_seed1]);await act(id,'adjudicate',{game_id:Number(game.id),outcome:'draw',reason:'Controlled adjudication'});}
  for(const pair of await q('SELECT id FROM pairs WHERE edition_id=$1 AND round=$2',[id,round]))await act(id,'confirm_pair',{pair_id:Number(pair.id)});
 }
 expect((await q('SELECT status FROM editions WHERE id=$1',[id]))[0].status).toBe('finished');
 expect((await state.db!.query('SELECT * FROM public.arena_agents ORDER BY id')).rows).toEqual(before.rows);
 expect((await q('SELECT count(*)::int AS n FROM games'))[0].n).toBe(32);
});
it('fences game writes, retains display snapshots and retry pins, exports only finals submissions',async()=>{
 const id=await create();await open(id);await submitAll(id,1);await act(id,'lock_round',{round:1});await act(id,'open_round',{round:1});
 expect((await q("SELECT claim_job('old',$1::uuid) AS job",[randomUUID()]))[0].job).toBeNull();
 const job=await worker(1,'claim');expect(job.kind).toBe('match');expect(job.agent1_code).not.toContain('RATING');
 expect(await worker(1,'claim')).toBeNull();
 const display={board:Array(81).fill(null),terrain:[{col:2,row:2}],bonus_cells:[{col:3,row:3,points:5}],scores:{1:5,2:0}};
 expect(await worker(1,'initial',{job_id:Number(job.id),token:job.token,state:display})).toBe(true);
 const payload={job_id:Number(job.id),token:job.token,expected:0,move:{player:1,from_col:1,from_row:3,to_col:0,to_row:3,piece_type:'ROCK'},state:{engine:{board:[]},display},reason:''};
 expect(await worker(1,'step',{...payload,token:randomUUID()})).toBe(false);
 expect(await worker(2,'step',payload)).toBe(false);
 expect(await worker(1,'step',payload)).toBe(true);expect(await worker(1,'step',payload)).toBe(true);
 await act(id,'publish',{game_id:Number(job.game_id)});
 const record=await(await replay(new Request('http://localhost'),{params:Promise.resolve({id:String(job.game_id)})})).json();expect(record.game.initial_state).toEqual(display);expect(record.moves[0].display).toEqual(display);expect(record.game.agent1_name).toBe('New round code '+record.game.seed1);expect(record.game.agent2_name).toBe('New round code '+record.game.seed2);
 await act(id,'interrupt',{game_id:Number(job.game_id),reason:'Manual stop'});expect(await worker(1,'step',payload)).toBe(false);
 await act(id,'retry',{game_id:Number(job.game_id),reason:'Same pinned inputs'});const retry=await worker(1,'claim');expect(retry.game_id).toBe(job.game_id);expect(retry.agent1_code).toBe(job.agent1_code);
 session.mockResolvedValue({id:1,is_admin:true});const exported=await(await bundle(new Request('http://localhost'),{params:Promise.resolve({id:String(id)})})).json();expect(exported.format).toBe('ott-finals-bundle-v2');expect(JSON.stringify(exported)).not.toContain('RATING_PRIVATE');
});
it('invalidates previous generation on reopen and refuses stale validation writes',async()=>{
 const id=await create();await open(id);await q('SELECT ck_submit(17,$1,1,1,$2,$3,1)',[id,'First','def agent(o,c): return {}']);const job=await worker(1,'claim');
 await open(id);expect(await worker(1,'complete',{job_id:Number(job.id),token:job.token})).toBe(false);
 expect((await q('SELECT generation FROM ck_rounds'))[0].generation).toBe(2);await expect(q('SELECT ck_submit(17,$1,1,1,$2,$3,1)',[id,'Stale','def agent(o,c): return {}'])).rejects.toThrow('STALE_REVISION');await expect(act(id,'lock_round',{round:1})).rejects.toThrow('CK_MISSING_VALID_SUBMISSIONS');
});
it('expires leases without retry and reset backs up the new tables without touching ratings',async()=>{
 const id=await create();await open(id);await submitAll(id,1);await act(id,'lock_round',{round:1});await act(id,'open_round',{round:1});const job=await worker(1,'claim');
 await q("UPDATE ck_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);await worker(1,'claim');
 expect((await q('SELECT status FROM games WHERE id=$1',[job.game_id]))[0].status).toBe('needs_attention');
 await state.db!.transaction(async tx=>{for(const st of finalsResetQueries('finals','ck-test',false,true))await tx.query(st.text,st.values??[]);});
 expect((await q('SELECT count(*)::int AS n FROM ck_submissions'))[0].n).toBe(0);expect((await q("SELECT jsonb_array_length(data->'ck_submissions') AS n FROM reset_backups WHERE run_id='ck-test'"))[0].n).toBe(16);
 expect((await state.db!.query<{n:number}>('SELECT count(*)::int AS n FROM public.arena_agents')).rows[0].n).toBe(18);
});
it('upgrade is repeatable and blocks legacy active rounds before making changes',async()=>{
 await upgrade();
 const old=new PGlite();try{
 await old.exec('BEGIN;'+readFileSync('finals_migration.sql','utf8').replaceAll('__FINALS_SCHEMA__','finals')+"INSERT INTO finals.editions(name,request_id,created_by) VALUES('Legacy','"+randomUUID()+"',1);INSERT INTO finals.pairs(edition_id,round,slot,status) VALUES(1,1,1,'running');COMMIT;");
 await expect(old.exec('BEGIN;'+readFileSync('finals_workers_migration.sql','utf8').replaceAll('__FINALS_SCHEMA__','finals')+'COMMIT;')).rejects.toThrow('CK_LEGACY_ACTIVE_ROUND');
 await old.exec('ROLLBACK');expect((await old.query<{present:boolean}>("SELECT to_regclass('finals.ck_rounds') IS NOT NULL AS present")).rows[0].present).toBe(false);
 }finally{await old.close();}
},30000);
it('accepts identical final-step retries, fences expired tokens, and preserves imported display metadata',async()=>{
 const id=await create();await open(id);await submitAll(id,1);await act(id,'lock_round',{round:1});await act(id,'open_round',{round:1});
 const job=await worker(1,'claim');
 const display={board:Array(81).fill(null),terrain:[],bonus_cells:[],scores:{'1':0,'2':0}};
 await worker(1,'initial',{job_id:Number(job.id),token:job.token,state:display});
 const final={job_id:Number(job.id),token:job.token,expected:0,move:{player:1,from_col:1,from_row:3,to_col:0,to_row:3,piece_type:'ROCK'},state:{display},outcome:'draw',reason:'Terminal'};
 expect(await worker(1,'step',final)).toBe(true);expect(await worker(1,'step',final)).toBe(true);
 expect(await worker(1,'step',{...final,outcome:'agent1'})).toBe(false);
 await act(id,'adjudicate',{game_id:Number(job.game_id),outcome:'draw',reason:'Keep board'});
 const [attempt]=await q('SELECT a.initial_state FROM games g JOIN attempts a ON a.id=g.active_attempt WHERE g.id=$1',[job.game_id]);expect(attempt.initial_state).toEqual(display);
 const imported={...final.move,move_number:1,display:{...display,scores:{'1':7,'2':2}}};
 await act(id,'import',{game_id:Number(job.game_id),moves:[imported],outcome:'agent1',reason:'Trusted new record',initial_state:display});
 await act(id,'publish',{game_id:Number(job.game_id)});
 const record=await(await replay(new Request('http://localhost'),{params:Promise.resolve({id:String(job.game_id)})})).json();expect(record.moves[0].display.scores).toEqual({'1':7,'2':2});
});
it('migration preserves completed legacy replay and enables fresh submissions for unopened rounds',async()=>{
 const old=new PGlite();try{
 await old.exec('BEGIN;'+readFileSync('finals_migration.sql','utf8').replaceAll('__FINALS_SCHEMA__','finals')+`INSERT INTO finals.editions(name,request_id,created_by,status) VALUES('Legacy','${randomUUID()}',1,'running');
 INSERT INTO finals.entrants VALUES(1,1,'user:17',17,'Seventeen','[]','Legacy',1,1000,'LEGACY_CODE','legacyhash'),(1,2,'user:16',16,'Sixteen','[]','Legacy',1,1000,'LEGACY_CODE','legacyhash');
 INSERT INTO finals.pairs(edition_id,round,slot,seed1,seed2,status,winner_seed,loser_seed) VALUES(1,1,1,1,2,'confirmed',1,2);
 INSERT INTO finals.games(pair_id,leg,seed1,seed2,status,published,outcome) VALUES(1,1,1,2,'ready',true,'draw');
 INSERT INTO finals.attempts(game_id,source,status,outcome,move_count) VALUES(1,'runner','ready','draw',1);
 UPDATE finals.games SET active_attempt=1;
 INSERT INTO finals.moves(attempt_id,seq,move) VALUES(1,1,'{"player":1,"from_col":1,"from_row":3,"to_col":0,"to_row":3,"piece_type":"ROCK"}');COMMIT;`);
 const before=(await old.query('SELECT * FROM finals.moves')).rows;
 await old.exec('BEGIN;'+readFileSync('finals_workers_migration.sql','utf8').replaceAll('__FINALS_SCHEMA__','finals')+'COMMIT;');
 expect((await old.query('SELECT * FROM finals.moves')).rows).toEqual(before);
 expect((await old.query<{source:string}>('SELECT source FROM finals.attempts')).rows[0].source).toBe('runner');
 expect((await old.query<{n:number}>("SELECT jsonb_array_length(data->'moves') AS n FROM finals.ck_upgrade_backup")).rows[0].n).toBe(1);
 }finally{await old.close();}
},30000);
