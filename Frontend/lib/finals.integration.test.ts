import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {snapshotSQL} from './finals-snapshot';
import {finalsDataTables,finalsResetQueries} from '../scripts/finals-reset-queries.mjs';
const {state,session}=vi.hoisted(()=>({state:{db:null as PGlite|null},session:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:session}));
vi.mock('@/lib/finals-db',()=>({
 finalsQuery:async(text:string,values:unknown[]=[])=>state.db!.transaction(async tx=>{await tx.query("SELECT set_config('search_path','finals,pg_catalog',true)");return(await tx.query(text,values)).rows;}),
 snapshotFinals:async(actor:number,name:string,key:string)=>state.db!.transaction(async tx=>{await tx.query("SELECT set_config('search_path','finals,pg_catalog',true)");return(await tx.query<{id:number}>(snapshotSQL('public'),[actor,name,key])).rows[0].id;}),
}));
import {finalsQuery,snapshotFinals} from './finals-db';
import {editionData,cleanRecord,FINALS_RULES} from './finals';
import {POST as admin} from '@/app/api/admin/finals/route';
import {GET as replay} from '@/app/api/finals/games/[id]/route';
import {GET as bundle} from '@/app/api/admin/finals/[id]/bundle/route';
type Row={id:number;seed1:number;seed2:number;winner_seed:number;status:string;revision:number;n:number;[key:string]:unknown};
const q=async(text:string,values:unknown[]=[])=> (await state.db!.query<Row>(text,values)).rows;
const create=()=>snapshotFinals(1,'Finals test',randomUUID());
const act=async(id:number,action:string,body:unknown={})=>{
 const version=(await q('SELECT revision FROM finals.editions WHERE id=$1',[id]))[0].revision;
 return finalsQuery('SELECT admin_action(1,$1,$2,$3,$4::jsonb)',[id,version,action,JSON.stringify(body)]);
};
const param=(id:number)=>({params:Promise.resolve({id:String(id)})});
const req=(query='')=>new Request('http://localhost/api/finals/game'+query);
it('backs up and clears finals atomically, retaining ordinary data and fencing stale runner IDs',async()=>{
 const before=await q('SELECT * FROM public.arena_agents ORDER BY id');
 const matches=await q('SELECT * FROM public.rated_matches ORDER BY id');
 const id=Number(await create());await act(id,'lock_rules',{rules:FINALS_RULES});await act(id,'open_round',{round:1});
 await q('CREATE TABLE IF NOT EXISTS finals.round_rules(edition_id bigint REFERENCES finals.editions(id),round integer,rules jsonb)');
 await q("INSERT INTO finals.round_rules VALUES($1,1,'{}')",[id]);
 const token=randomUUID();await finalsQuery('INSERT INTO workers VALUES($1,$2,now(),1)',['reset-test',token]);
 const job=(await finalsQuery('SELECT claim_job($1,$2::uuid) AS job',['reset-test',token]))[0].job;
 const reset=()=>state.db!.transaction(async tx=>{
  for(const statement of finalsResetQueries('finals','test-reset',true))await tx.query(statement.text,statement.values??[]);
 });
 // A failure after truncation must restore both the data and backup transaction.
 await expect(state.db!.transaction(async tx=>{
  for(const statement of finalsResetQueries('finals','rollback-reset',true))await tx.query(statement.text,statement.values??[]);
  throw Error('forced rollback');
 })).rejects.toThrow('forced rollback');
 expect((await q('SELECT count(*)::int AS n FROM finals.editions'))[0].n).toBe(1);
 await reset();
 for(const table of [...finalsDataTables,'round_rules'])expect((await q(`SELECT count(*)::int AS n FROM finals.${table}`))[0].n).toBe(0);
 const backup=(await q("SELECT data FROM finals.reset_backups WHERE run_id='test-reset'"))[0].data as Record<string,unknown[]>;
 expect(backup.editions).toHaveLength(1);expect(backup.entrants).toHaveLength(16);
 expect(backup.games).toHaveLength(16);expect(backup.attempts).toHaveLength(1);
 expect(backup.round_rules).toHaveLength(1);
 expect(await q('SELECT * FROM public.arena_agents ORDER BY id')).toEqual(before);
 expect(await q('SELECT * FROM public.rated_matches ORDER BY id')).toEqual(matches);
 expect((await finalsQuery("SELECT record_step($1,$2::uuid,0,'{}','{}',NULL,'') AS ok",[job.attempt_id,token]))[0].ok).toBe(false);
 expect(Number(await create())).toBeGreaterThan(id);
});
beforeAll(async()=>{
 state.db=new PGlite();
 for(const file of ['database.sql','arena_schema.sql','tournament_schema.sql','trueskill_migration.sql','friendly_challenge_migration.sql','execution_token_migration.sql','adaptive_rating_migration.sql','teams_migration.sql','private_trials_migration.sql'])await state.db.exec(readFileSync(new URL('../'+file,import.meta.url),'utf8'));
 await state.db.exec('BEGIN;'+readFileSync(new URL('../finals_migration.sql',import.meta.url),'utf8').replaceAll('__FINALS_SCHEMA__','finals')+'COMMIT;');
},30000);
afterAll(async()=>state.db?.close());
beforeEach(async()=>{
 session.mockResolvedValue(null);
 await state.db!.exec(`TRUNCATE finals.editions,finals.workers,public.users,public.arena_agents,public.rated_matches RESTART IDENTITY CASCADE;
 INSERT INTO public.users(username,password_hash,is_admin) SELECT 'player'||n,'hash',n=1 FROM generate_series(1,18) n;
 INSERT INTO public.arena_agents(user_id,agent_name,code,status,is_active,is_public,rating) SELECT n,'Agent '||n,'PRIVATE_SOURCE_'||n,'active',n<18,true,1000+n FROM generate_series(1,18) n;
 INSERT INTO public.rated_matches(kind,agent1_id,agent2_id,status,outcome,finished_at) SELECT 'rating',n,18,'finished','draw',now() FROM generate_series(1,17) n CROSS JOIN generate_series(1,10) k;`);
});
it('atomically snapshots the same top sixteen eligible representatives, SHA256 code, and seeded bracket',async()=>{
 await q("INSERT INTO public.arena_agents(user_id,agent_name,code,status,is_active,is_public,rating) VALUES(17,'Uncalibrated','PRIVATE_NEW','active',true,true,9000),(16,'Private','PRIVATE_SECRET','active',true,false,9999)");
 const id=await create();const data=await editionData(Number(id));
 expect(data!.entrants).toHaveLength(16);expect(data!.entrants[0]).toMatchObject({seed:1,source_agent_id:17,name:'player17'});
 expect(data!.pairs.filter(p=>p.round===1).map(p=>[p.seed1,p.seed2])).toEqual([[1,16],[8,9],[4,13],[5,12],[2,15],[7,10],[3,14],[6,11]]);
 await expect(finalsQuery("UPDATE entrants SET code='changed' WHERE edition_id=$1",[id])).rejects.toThrow('IMMUTABLE_SNAPSHOT');
 expect(JSON.stringify(data)).not.toContain('PRIVATE');expect(data!.entrants[0].code_hash).toHaveLength(64);
 await q("UPDATE public.arena_agents SET rating=90000,code='CHANGED' WHERE id=1");
 expect((await editionData(Number(id)))!.entrants).toEqual(data!.entrants);
});
it('snapshots team membership independently of future team changes',async()=>{
 await q("SELECT public.manage_team(15,'create','{\"name\":\"Team Fifteen\"}')");
 await q('INSERT INTO public.team_members(team_id,user_id) SELECT id,14 FROM public.teams');
 const id=Number(await create());const first=(await editionData(id))!.entrants.find(e=>e.name==='Team Fifteen')!;
 expect(first.members).toHaveLength(2);
 await q("UPDATE public.teams SET name='RENAMED'");await q('DELETE FROM public.team_members WHERE user_id=14');
 expect((await editionData(id))!.entrants.find(e=>e.seed===first.seed)).toEqual(first);
});
it('requires sixteen, one open edition, stable request ID and revision checks',async()=>{
 await q('UPDATE public.arena_agents SET is_active=false WHERE id IN(1,2)');
 await expect(create()).rejects.toThrow('NEED_SIXTEEN');
 await q('UPDATE public.arena_agents SET is_active=true WHERE id IN(1,2)');
 const key=randomUUID(),id=Number(await snapshotFinals(1,'One',key));expect(Number(await snapshotFinals(1,'One',key))).toBe(id);
 await expect(create()).rejects.toThrow('EDITION_ALREADY_OPEN');
 await expect(finalsQuery("SELECT admin_action(1,$1,99,'lock_rules',$2::jsonb)",[id,JSON.stringify({rules:FINALS_RULES})])).rejects.toThrow('STALE_REVISION');
 await expect(act(id,'open_round',{round:1})).rejects.toThrow('RULES_NOT_LOCKED');
 await act(id,'lock_rules',{rules:FINALS_RULES});await expect(act(id,'lock_rules',{rules:FINALS_RULES})).rejects.toThrow('INVALID_STATE');
 await expect(finalsQuery("UPDATE editions SET rules='{}' WHERE id=$1",[id])).rejects.toThrow('RULES_IMMUTABLE');
});
it('runs all five stages, reversed sides, seed tiebreak and bronze without touching normal ratings',async()=>{
 const before=await q('SELECT id,rating,wins,losses,draws,code FROM public.arena_agents ORDER BY id');
 const id=Number(await create());await act(id,'lock_rules',{rules:FINALS_RULES});
 for(const round of [1,2,3,4,5]){
  await act(id,'open_round',{round});
  const pairs=await q('SELECT * FROM finals.pairs WHERE edition_id=$1 AND round=$2 ORDER BY slot',[id,round]);
  for(const pair of pairs){
   const games=await q('SELECT * FROM finals.games WHERE pair_id=$1 ORDER BY leg',[pair.id]);
   expect(games.map(g=>[g.seed1,g.seed2])).toEqual([[pair.seed1,pair.seed2],[pair.seed2,pair.seed1]]);
   for(const game of games)await act(id,'adjudicate',{game_id:game.id,outcome:'draw',reason:'Test adjudication'});
   await act(id,'confirm_pair',{pair_id:pair.id});
   const confirmed=(await q('SELECT * FROM finals.pairs WHERE id=$1',[pair.id]))[0];expect(confirmed.winner_seed).toBe(Math.min(pair.seed1,pair.seed2));
  }
 }
 expect((await q('SELECT status FROM finals.editions WHERE id=$1',[id]))[0].status).toBe('finished');
 const last=(await finalsQuery('SELECT id FROM games ORDER BY id DESC LIMIT 1'))[0];
 await act(id,'publish',{game_id:last.id});expect((await replay(req(),param(last.id))).status).toBe(200);
 expect((await q('SELECT count(*)::int AS n FROM finals.games'))[0].n).toBe(32);
 expect(await q('SELECT id,rating,wins,losses,draws,code FROM public.arena_agents ORDER BY id')).toEqual(before);
});
it('fences move commits, hides private records, supports incremental publication and keeps attempt history',async()=>{
 const id=Number(await create());await act(id,'lock_rules',{rules:FINALS_RULES});await act(id,'open_round',{round:1});
 const instance=randomUUID();await finalsQuery('INSERT INTO workers VALUES($1,$2,now(),1)',['test',instance]);
 const job=(await finalsQuery('SELECT claim_job($1,$2::uuid) AS job',['test',instance]))[0].job;
 expect((await finalsQuery('SELECT claim_job($1,$2::uuid) AS job',['test',instance]))[0].job).toBeNull();
 const move={move_number:1,player:1,from_col:1,from_row:3,to_col:0,to_row:3,piece_type:'ROCK'};
 expect((await replay(req(),param(job.game_id))).status).toBe(404);
 const commit=(token=instance)=>finalsQuery('SELECT record_step($1,$2::uuid,0,$3::jsonb,$4::jsonb,NULL,$5) AS ok',[job.attempt_id,token,JSON.stringify(move),'{}','']);
 expect((await commit(randomUUID()))[0].ok).toBe(false);expect((await commit())[0].ok).toBe(true);expect((await commit())[0].ok).toBe(true);
 await act(id,'publish',{game_id:job.game_id});
 const record=await(await replay(req(),param(job.game_id))).json();expect(record.moves).toHaveLength(1);expect(JSON.stringify(record)).not.toContain('PRIVATE');
 expect((await(await replay(req(`?attempt=${job.attempt_id}&after=1`),param(job.game_id))).json()).moves).toHaveLength(0);
 await act(id,'interrupt',{game_id:job.game_id,reason:'Stop for inspection'});
 expect((await commit())[0].ok).toBe(false);
 await act(id,'retry',{game_id:job.game_id,reason:'Retry with same snapshots'});
 expect((await replay(req(),param(job.game_id))).status).toBe(404);
 expect((await editionData(id,true))!.attempts).toHaveLength(1);
});
it('expired lease waits for admin instead of silently rerunning and cancellation revokes running work',async()=>{
 const id=Number(await create());await act(id,'lock_rules',{rules:FINALS_RULES});await act(id,'open_round',{round:1});
 const instance=randomUUID();await finalsQuery('INSERT INTO workers VALUES($1,$2,now(),1)',['test',instance]);
 const first=(await finalsQuery('SELECT claim_job($1,$2::uuid) AS job',['test',instance]))[0].job;
 await finalsQuery("UPDATE attempts SET lease_until=now()-interval '1 second'");
 const next=(await finalsQuery('SELECT claim_job($1,$2::uuid) AS job',['test',instance]))[0].job;
 expect(next.game_id).not.toBe(first.game_id);
 expect((await finalsQuery('SELECT status FROM games WHERE id=$1',[first.game_id]))[0].status).toBe('needs_attention');
 await act(id,'cancel',{reason:'Cancel edition'});
 expect((await finalsQuery('SELECT claim_job($1,$2::uuid) AS job',['test',instance]))[0].job).toBeNull();
 expect((await finalsQuery('SELECT status FROM attempts WHERE id=$1',[next.attempt_id]))[0].status).toBe('cancelled');
});
it('authorizes admin operations and private bundle export; imports arbitrary but safe records',async()=>{
 expect((await admin(new Request('http://localhost',{method:'POST',body:'{}'}))).status).toBe(403);
 const id=Number(await create());expect((await bundle(req(),param(id))).status).toBe(403);
 session.mockResolvedValue({id:1,is_admin:true});
 expect((await bundle(req(),param(id))).status).toBe(409);await act(id,'lock_rules',{rules:FINALS_RULES});await act(id,'open_round',{round:1});
 expect(JSON.stringify(await(await bundle(req(),param(id))).json())).toContain('PRIVATE_SOURCE');
 const game=(await finalsQuery('SELECT * FROM games ORDER BY id LIMIT 1'))[0];
 const moves=cleanRecord([{player:1,from_col:0,from_row:0,to_col:8,to_row:8,piece_type:'ROCK',code:'SHOULD_NOT_LEAK'}]);
 await act(id,'import',{game_id:game.id,moves,outcome:'agent1',reason:'Trusted manual import'});
 expect((await replay(req(),param(game.id))).status).toBe(404);
 await act(id,'publish',{game_id:game.id});const record=await(await replay(req(),param(game.id))).json();
 expect(record.game.source).toBe('import');expect(record.moves[0].to_col).toBe(8);expect(JSON.stringify(record)).not.toContain('SHOULD_NOT_LEAK');
 expect(()=>cleanRecord([{...moves[0],to_col:99}])).toThrow('INVALID_RECORD');
});
