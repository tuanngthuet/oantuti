import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {demoFixtures} from './demo-data-fixtures.mjs';
import {agentCodeIdentity} from '../lib/agent-code';

let db:PGlite;
const fixtures=demoFixtures('demo');
const payload={...fixtures,users:fixtures.users.map((u:{username:string})=>({...u,password_hash:'test-only-hash'})),
  agents:fixtures.agents.map((a:{code:string})=>{const identity=agentCodeIdentity(a.code);return {...a,normalized_code:identity.normalized,code_fingerprint:identity.fingerprint};})};
const migration=readFileSync(new URL('./seed-demo-data.sql',import.meta.url),'utf8');
beforeAll(async()=>{
 db=new PGlite();
 for(const file of ['database.sql','arena_schema.sql','tournament_schema.sql','trueskill_migration.sql','friendly_challenge_migration.sql','execution_token_migration.sql','adaptive_rating_migration.sql','teams_migration.sql','private_trials_migration.sql'])
   await db.exec(readFileSync(new URL(`../${file}`,import.meta.url),'utf8'));
},30000);
afterAll(async()=>db?.close());
it('builds 30 distinct players, 5 teams of every allowed size and 1–4 unique agents per submitter',()=>{
 expect(fixtures.users).toHaveLength(30);expect(fixtures.teams.map((t:{members:string[]})=>t.members.length)).toEqual([1,2,2,3,3]);
 expect(new Set(fixtures.teams.flatMap((t:{members:string[]})=>t.members)).size).toBe(11);
 expect(fixtures.agents).toHaveLength(73);expect(new Set(payload.agents.map((a:{code_fingerprint:string})=>a.code_fingerprint)).size).toBe(73);
 for(const user of fixtures.users){const agents=fixtures.agents.filter((a:{username:string})=>a.username===user.username);expect(agents.length).toBeGreaterThanOrEqual(1);expect(agents.length).toBeLessThanOrEqual(4);expect(agents.some((a:{is_public:boolean})=>a.is_public)).toBe(true);}
 expect(new Set(fixtures.agents.map((a:{level:number})=>a.level)).size).toBe(6);
 for(const agent of payload.agents)expect(agent.normalized_code).toBe(agent.code.replace(/\r\n?/g,'\n').split('\n').map((l:string)=>l.replace(/[\t ]+$/,'')).join('\n').replace(/^\n+|\n+$/g,''));
 expect(()=>demoFixtures("x';DROP TABLE users;--")).toThrow();
});
it('inserts atomically with correct team scopes, per-scope versions, password hashes and genuine validation jobs; preserves old data',async()=>{
 await db.exec("INSERT INTO users(username,password_hash) VALUES('original','keep-hash'); INSERT INTO arena_agents(user_id,agent_name,code,status,is_active,is_public) SELECT id,'Existing','private-code','active',true,true FROM users WHERE username='original';");
 const oldUsers=(await db.query('SELECT * FROM users ORDER BY id')).rows;
 const oldAgents=(await db.query('SELECT * FROM arena_agents ORDER BY id')).rows;
 await db.transaction(async tx=>{await tx.query("SELECT set_config('app.demo_payload',$1,true)",[JSON.stringify(payload)]);await tx.exec(migration);});
 expect((await db.query('SELECT * FROM users WHERE username NOT LIKE \'demo%\' ORDER BY id')).rows).toEqual(oldUsers);
 expect((await db.query("SELECT * FROM arena_agents WHERE agent_name='Existing' ORDER BY id")).rows).toEqual(oldAgents);
 expect((await db.query("SELECT * FROM users WHERE username LIKE 'demo%' AND NOT is_admin AND password_hash='test-only-hash'")).rows).toHaveLength(30);
 const agents=(await db.query<{team_id:number|null;scope:string;version:number;status:string;is_active:boolean}>("SELECT team_id,agent_participant_key(id) AS scope,version,status,is_active FROM arena_agents WHERE agent_name<>'Existing' ORDER BY id")).rows;
 expect(agents).toHaveLength(73);expect(agents.every(a=>a.status==='validating'&&!a.is_active)).toBe(true);
 for(const scope of new Set(agents.map(a=>a.scope)))expect(agents.filter(a=>a.scope===scope).map(a=>a.version)).toEqual(Array.from({length:agents.filter(a=>a.scope===scope).length},(_,i)=>i+1));
 expect((await db.query("SELECT * FROM arena_agents WHERE agent_name<>'Existing' AND team_id IS DISTINCT FROM current_team(user_id)")).rows).toHaveLength(0);
 expect((await db.query("SELECT * FROM rated_matches WHERE kind='validation' AND status='scheduled' AND agent1_id=agent2_id")).rows).toHaveLength(73);
 expect((await db.query("SELECT * FROM rated_matches WHERE kind='rating'")).rows).toHaveLength(0);
 expect((await db.query('SELECT * FROM team_members')).rows).toHaveLength(11);
 expect((await db.query('SELECT * FROM team_invitations WHERE status=\'accepted\'')).rows).toHaveLength(6);
 await expect(db.transaction(async tx=>{await tx.query("SELECT set_config('app.demo_payload',$1,true)",[JSON.stringify(payload)]);await tx.exec(migration);})).rejects.toThrow('DEMO_USERNAME_EXISTS');
 expect((await db.query('SELECT * FROM users')).rows).toHaveLength(oldUsers.length+30);
});
