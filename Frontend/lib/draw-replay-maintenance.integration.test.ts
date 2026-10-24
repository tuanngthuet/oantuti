import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,afterAll,beforeEach,expect,it} from 'vitest';
import {resetDrawQueries} from '../scripts/replay-draws-queries.mjs';
import {splitSql} from '../scripts/sql-statements.mjs';
import {rate1v1,displayRating,TRUESKILL} from './trueskill';
let db:PGlite;
beforeAll(async()=>{
 db=new PGlite();
 for(const file of ['database.sql','arena_schema.sql','tournament_schema.sql','trueskill_migration.sql','friendly_challenge_migration.sql',
  'execution_token_migration.sql','adaptive_rating_migration.sql','teams_migration.sql','private_trials_migration.sql'])await db.exec(readFileSync(new URL(`../${file}`,import.meta.url),'utf8'));
},30000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
 await db.exec(`DROP TABLE IF EXISTS draw_replay_backups;
 TRUNCATE users,arena_agents,rated_matches,friendly_matches RESTART IDENTITY CASCADE;
 INSERT INTO users(username,password_hash) VALUES('one','x'),('two','x');
 INSERT INTO arena_agents(user_id,agent_name,code,status,is_active,is_public,draws) VALUES(1,'one','a','active',true,true,1),(2,'two','b','active',true,true,1);
 INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,outcome,finished_at,total_moves) VALUES
 ('rating',1,2,'finished','draw',now(),8),('rating',1,2,'finished','agent1',now()-interval '1 hour',11),('validation',1,1,'finished','draw',now(),60);
 INSERT INTO rated_match_move_history(rated_match_id,move_number,player,from_col,from_row,to_col,to_row,from_pos,to_pos) SELECT id,1,1,1,3,0,3,'b4','a4' FROM rated_matches;
 INSERT INTO friendly_matches(created_by,agent1_id,agent2_id,trial_agent_id,status,outcome,finished_at,total_moves) VALUES(1,1,2,1,'finished','draw',now(),8);
 INSERT INTO friendly_match_history(friendly_match_id,move_number,player,from_col,from_row,to_col,to_row,from_pos,to_pos) VALUES(1,1,1,1,3,0,3,'b4','a4');
 UPDATE rating_scheduler_state SET enabled=true;`);
});
async function plan(){
 const stateQuery="SELECT jsonb_agg(to_jsonb(m) ORDER BY id) AS data FROM rated_matches m";
 const [{data,digest}]=(await db.query<{data:unknown;digest:string}>(`SELECT data,md5(data::text) AS digest FROM (${stateQuery}) s`)).rows;
 const initial={mu:TRUESKILL.initialMu,sigma:TRUESKILL.initialSigma};
 const after=rate1v1(initial,initial,'agent1');
 const agentRows=[{id:1,...after.agent1,rating:displayRating(after.agent1),wins:1,losses:0,draws:0},{id:2,...after.agent2,rating:displayRating(after.agent2),wins:0,losses:1,draws:0}];
 const snapshots=[{id:2,agent1_mu_before:initial.mu,agent1_sigma_before:initial.sigma,agent1_mu_after:after.agent1.mu,agent1_sigma_after:after.agent1.sigma,
  agent2_mu_before:initial.mu,agent2_sigma_before:initial.sigma,agent2_mu_after:after.agent2.mu,agent2_sigma_after:after.agent2.sigma,
  rating_delta_agent1:displayRating(after.agent1)-1000,rating_delta_agent2:displayRating(after.agent2)-1000}];
 return resetDrawQueries({stateQuery,digest,runId:'fixture',data,report:{since:'24h'},ids:[1],friendlyIds:[1],agentRows,snapshots,wasEnabled:true,
  migration:splitSql(readFileSync(new URL('../draw_200_migration.sql',import.meta.url),'utf8'))});
}
async function apply(commands:Awaited<ReturnType<typeof plan>>){
 await db.transaction(async tx=>{for(const q of commands)await tx.query(q.text,q.values);});
}
it('backs up, erases only selected results/replays, rebuilds scores and schedules the same match IDs',async()=>{
 await apply(await plan());
 expect((await db.query('SELECT id,status,outcome,total_moves FROM rated_matches ORDER BY id')).rows).toEqual([
  {id:1,status:'scheduled',outcome:null,total_moves:0},{id:2,status:'finished',outcome:'agent1',total_moves:11},{id:3,status:'finished',outcome:'draw',total_moves:60}]);
 expect((await db.query('SELECT rated_match_id FROM rated_match_move_history ORDER BY rated_match_id')).rows).toEqual([{rated_match_id:2},{rated_match_id:3}]);
 expect((await db.query('SELECT id,status,outcome,pending_backend FROM friendly_matches')).rows).toEqual([{id:1,status:'scheduled',outcome:null,pending_backend:true}]);
 expect((await db.query('SELECT * FROM friendly_match_history')).rows).toHaveLength(0);
 expect((await db.query('SELECT wins,losses,draws FROM arena_agents ORDER BY id')).rows).toEqual([{wins:1,losses:0,draws:0},{wins:0,losses:1,draws:0}]);
 expect((await db.query('SELECT * FROM draw_replay_backups')).rows).toHaveLength(1);
 expect((await db.query('SELECT enabled FROM rating_scheduler_state')).rows).toEqual([{enabled:true}]);
});
it('rolls back the entire operation if audited data changed before acquiring the write lock',async()=>{
 const commands=await plan();await db.exec("UPDATE rated_matches SET win_reason='changed' WHERE id=2");
 await expect(apply(commands)).rejects.toThrow('State changed');
 expect((await db.query('SELECT status FROM rated_matches WHERE id=1')).rows).toEqual([{status:'finished'}]);
 expect((await db.query('SELECT * FROM friendly_match_history')).rows).toHaveLength(1);
});
it('upgrades an actual legacy scheduler with both guards while preserving team/privacy checks',async()=>{
 const [{definition}]=(await db.query<{definition:string}>("SELECT pg_get_functiondef('reserve_rating_dispatch(uuid,integer)'::regprocedure) AS definition")).rows;
 const legacy=definition.replace(/^.* AS pair_draws,\n/m,'').replace(/^.*draw_pair_daily_limit\n/m,'')
  .replace(/^\s*-- serialize_pending_rating_agents\n[\s\S]*?^\s*\)\)\n/m,'');
 expect(legacy).not.toContain('serialize_pending_rating_agents');expect(legacy).not.toContain('draw_pair_daily_limit');
 await db.exec(legacy);
 await apply(await plan());
 const [updated]=(await db.query<{definition:string}>("SELECT pg_get_functiondef('reserve_rating_dispatch(uuid,integer)'::regprocedure) AS definition")).rows;
 expect(updated.definition).toContain('serialize_pending_rating_agents');expect(updated.definition).toContain('draw_pair_daily_limit');
 expect(updated.definition).toContain('agent_participant_key(o.id)');expect(updated.definition).toContain('match_scope_allowed');
});
