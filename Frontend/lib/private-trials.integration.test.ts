import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {agentCodeIdentity} from './agent-code';
let db:PGlite;
const rows=async<T=Record<string,unknown>>(q:string,v:unknown[]=[])=> (await db.query<T>(q,v)).rows;
const trial=async(actor=1,own=1,opponent=2,key=randomUUID())=>(await rows<{r:{id:number;reused:boolean;quota:{remaining:number}}}>('SELECT create_private_trial($1,$2,$3,$4) AS r',[actor,own,opponent,key]))[0].r;
const submit=async(actor:number,code:string,pub=false)=>{const c=agentCodeIdentity(code);return(await rows<{r:{id:number;duplicate?:boolean;agent_id?:number}}>('SELECT submit_private_agent($1,\'Test\',\'\',$2,NULL,$3,$4,$5) AS r',[actor,code,pub,c.normalized,c.fingerprint]))[0].r;};
beforeAll(async()=>{
 db=new PGlite();
 for(const file of ['database.sql','arena_schema.sql','tournament_schema.sql','trueskill_migration.sql','friendly_challenge_migration.sql','execution_token_migration.sql','adaptive_rating_migration.sql','teams_migration.sql','private_trials_migration.sql'])await db.exec(readFileSync(new URL(`../${file}`,import.meta.url),'utf8'));
},30000);
afterAll(async()=>db?.close());
beforeEach(async()=>{await db.exec(`TRUNCATE users,arena_agents,rated_matches,teams RESTART IDENTITY CASCADE;
 INSERT INTO users(username,password_hash,is_admin) VALUES('one','x',false),('two','x',false),('mate','x',false),('admin','x',true);
 INSERT INTO arena_agents(user_id,agent_name,code,status,is_active,is_public,version) VALUES
  (1,'Private','private','active',true,false,1),(2,'Public','public','active',true,true,1),(3,'Other private','secret','active',true,false,1);
 UPDATE rating_scheduler_state SET enabled=true;`);});
it('allows validated private sources but only public opponents, without requiring consent',async()=>{
 const m=await trial();expect(m.quota.remaining).toBe(9);
 const stored=(await rows('SELECT is_public,trial_agent_id,created_by,status FROM friendly_matches'))[0];
 expect(stored).toEqual({is_public:false,trial_agent_id:1,created_by:1,status:'scheduled'});
 await expect(trial(1,1,3)).rejects.toThrow('AGENT_INACTIVE');
});
it('hides trial list/replay authorization from the opponent and outsiders',async()=>{
 const m=await trial();expect((await rows('SELECT can_read_trial(1,$1) AS own,can_read_trial(2,$1) AS opponent,can_read_trial(3,$1) AS other,can_read_trial(4,$1) AS admin',[m.id]))[0])
 .toEqual({own:true,opponent:false,other:false,admin:true});
});
it('admits at most ten concurrent requests per user and keeps ownership changes from resetting quota',async()=>{
 const result=await Promise.allSettled(Array.from({length:12},()=>trial()));
 expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(10);
 await rows("UPDATE friendly_matches SET status='finished'");
 await rows("SELECT manage_team(1,'create','{\"name\":\"T\"}')");
 await expect(trial()).rejects.toThrow('TRIAL_QUOTA_EXCEEDED');
});
it('reuses the same idempotency key and stored side even after the quota is exhausted',async()=>{
 const key=randomUUID(),first=await trial(1,1,2,key);
 const side=await rows('SELECT agent1_id,agent2_id FROM friendly_matches WHERE id=$1',[first.id]);
 for(let i=0;i<9;i++)await trial();
 const retry=await trial(1,1,2,key);expect(retry.id).toBe(first.id);expect(retry.reused).toBe(true);expect(retry.quota.remaining).toBe(0);
 expect(await rows('SELECT agent1_id,agent2_id FROM friendly_matches WHERE id=$1',[first.id])).toEqual(side);
});
it('refunds infra/cancelled jobs once, not agent losses, and uses Vietnam day boundaries',async()=>{
 for(let i=0;i<10;i++)await trial();
 await rows("UPDATE friendly_matches SET status='error',is_infra_error=true WHERE id=1");
 expect((await rows<{q:{remaining:number}}>('SELECT trial_quota(1) AS q'))[0].q.remaining).toBe(1);
 await rows("UPDATE friendly_matches SET status='error',is_infra_error=true WHERE id=1");
 expect((await rows<{q:{remaining:number}}>('SELECT trial_quota(1) AS q'))[0].q.remaining).toBe(1);
 await rows("UPDATE friendly_matches SET status='finished',outcome='agent2' WHERE id=2");await trial();
 await expect(trial()).rejects.toThrow('TRIAL_QUOTA_EXCEEDED');
 await rows("UPDATE friendly_matches SET quota_day=((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-1)");
 expect((await rows<{q:{remaining:number}}>('SELECT trial_quota(1) AS q'))[0].q.remaining).toBe(10);
});
it('shares team trials only with current source-team members, never opposing team members',async()=>{
 await rows("SELECT manage_team(1,'create','{\"name\":\"T\"}')");
 const invitation=(await rows<{r:{invitation_id:number}}>("SELECT manage_team(1,'invite','{\"username\":\"mate\"}') AS r"))[0].r;
 await rows("SELECT manage_team(3,'accept',$1::jsonb)",[JSON.stringify({invitation_id:invitation.invitation_id})]);
 const m=await trial(3,1,2);
 expect((await rows('SELECT can_read_trial(1,$1) AS leader,can_read_trial(3,$1) AS mate,can_read_trial(2,$1) AS opponent',[m.id]))[0]).toEqual({leader:true,mate:true,opponent:false});
 await rows("SELECT manage_team(3,'leave')");expect((await rows('SELECT can_read_trial(3,$1) AS allowed',[m.id]))[0].allowed).toBe(false);
});
it('never exposes a private agent publicly and never selects it for rating',async()=>{
 expect((await rows('SELECT can_read_agent(NULL,1) AS guest,can_read_agent(2,1) AS other,can_read_agent(1,1) AS own'))[0]).toEqual({guest:false,other:false,own:true});
 expect(await rows('SELECT id FROM rating_agent_schedule WHERE id=1')).toHaveLength(0);
 expect((await rows("SELECT match_scope_allowed('rating',1,2) AS allowed"))[0].allowed).toBe(false);
});
it('publishes only active owned agents and rejects the reverse direction at the database',async()=>{
 await expect(rows('SELECT publish_agent(2,1)')).rejects.toThrow('FORBIDDEN');
 await rows('SELECT publish_agent(1,1)');expect((await rows('SELECT is_public FROM arena_agents WHERE id=1'))[0].is_public).toBe(true);
 await expect(rows('UPDATE arena_agents SET is_public=false WHERE id=1')).rejects.toThrow('PUBLICATION_IRREVERSIBLE');
 const a=await submit(1,'def agent(): return 1');
 await expect(rows('SELECT publish_agent(1,$1)',[a.id])).rejects.toThrow('AGENT_INACTIVE');
 expect(await rows("SELECT id FROM rated_matches WHERE kind='validation' AND agent1_id=$1",[a.id])).toHaveLength(1);
});
it('blocks normalized duplicate submissions atomically but not another owner\'s private source',async()=>{
 const result=await Promise.all([submit(1,'def agent():\n    return 1  \n'),submit(1,'def agent():\r\n    return 1\r\n')]);
 expect(result.filter(r=>r.duplicate)).toHaveLength(1);
 expect((await submit(2,'def agent():\n    return 1')).duplicate).toBeUndefined();
 expect(await rows("SELECT * FROM rated_matches WHERE kind='validation'")).toHaveLength(2);
});
it('does not update rating stats and retires challenge entrypoints',async()=>{
 const before=await rows('SELECT rating,wins,losses,draws FROM arena_agents ORDER BY id');
 await trial();expect(await rows('SELECT rating,wins,losses,draws FROM arena_agents ORDER BY id')).toEqual(before);
 await expect(rows("SELECT send_team_challenge(1,1,2,'')")).rejects.toThrow('FEATURE_RETIRED');
 await expect(rows('SELECT create_scope_friendly(1,1,2)')).rejects.toThrow('FEATURE_RETIRED');
});
