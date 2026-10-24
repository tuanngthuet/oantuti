import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,beforeEach,afterAll,expect,it,vi} from 'vitest';
const {state,session}=vi.hoisted(()=>({state:{db:null as PGlite|null},session:vi.fn()}));
vi.mock('@/lib/db',()=>({sql:async(strings:TemplateStringsArray,...values:unknown[])=>{
  const text=strings.reduce((result,part,i)=>result+(i?`$${i}`:'')+part,'');
  return (await state.db!.query(text,values)).rows;
}}));
vi.mock('@/lib/session',()=>({getSession:session}));
import {GET as directory} from '@/app/api/arena/teams/route';
import {GET as myTeam,POST as teamAction} from '@/app/api/team/route';
const migration=readFileSync(new URL('../team_join_requests_migration.sql',import.meta.url),'utf8');
const rows=async<T=Record<string,unknown>>(text:string,values:unknown[]=[]) => (await state.db!.query<T>(text,values)).rows;
const manage=async(actor:number,action:string,body:object={})=>(await rows<{result:{team_id:number;invitation_id:number}}>(
  'SELECT manage_team($1,$2,$3::jsonb) AS result',[actor,action,JSON.stringify(body)]))[0].result;
const join=async(actor:number,action:string,body:object)=>(await rows<{result:{team_id:number;request_id:number}}>(
  'SELECT manage_team_join_request($1,$2,$3::jsonb) AS result',[actor,action,JSON.stringify(body)]))[0].result;
const post=(body:unknown)=>teamAction(new Request('http://localhost/api/team',{method:'POST',body:JSON.stringify(body)}));
const list=(query='')=>directory(new Request('http://localhost/api/arena/teams'+query));
async function create(leader=2,name='Wave Team'){
  const team=await manage(leader,'create',{name});
  await manage(leader,'update',{name,recruiting:true});
  return team.team_id;
}
beforeAll(async()=>{
  state.db=new PGlite();
  for(const file of ['database.sql','arena_schema.sql','tournament_schema.sql','trueskill_migration.sql','friendly_challenge_migration.sql','execution_token_migration.sql','adaptive_rating_migration.sql','teams_migration.sql'])
    await state.db.exec(readFileSync(new URL('../'+file,import.meta.url),'utf8'));
  await state.db.exec(migration);
},30000);
afterAll(async()=>{await state.db?.close();});
beforeEach(async()=>{
  session.mockResolvedValue(null);
  await state.db!.exec(`TRUNCATE users RESTART IDENTITY CASCADE;
    INSERT INTO users(username,password_hash,is_admin) VALUES ('admin','PRIVATE_HASH',true),('alice','PRIVATE_HASH',false),('bob','PRIVATE_HASH',false),('charlie','PRIVATE_HASH',false),('dave','PRIVATE_HASH',false),('eve','PRIVATE_HASH',false);
    INSERT INTO arena_agents(user_id,agent_name,code,status,is_active,version,rating) SELECT id,username,'PRIVATE_CODE','active',true,1,1234 FROM users;`);
});
it('lists active teams without agents and exposes only the caller’s request state',async()=>{
  const id=await create();
  await state.db!.exec('DELETE FROM arena_agents');
  const request=await join(3,'request_join',{team_id:id});
  let body=await(await list()).json();
  expect(body).toMatchObject({total:1,authenticated:false,current_team_id:null});
  expect(body.teams[0]).toMatchObject({name:'Wave Team',member_count:1,request_status:null,request_id:null});
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE_HASH|PRIVATE_CODE|requester_id/);
  session.mockResolvedValue({id:3,is_admin:false});
  body=await(await list()).json();
  expect(body.teams[0]).toMatchObject({request_status:'pending',request_id:request.request_id});
  session.mockResolvedValue({id:4,is_admin:false});
  expect((await(await list()).json()).teams[0].request_id).toBeNull();
});
it('sends a wave through the authenticated API and lets only the leader approve',async()=>{
  const id=await create();
  expect((await post({action:'request_join',team_id:id})).status).toBe(401);
  session.mockResolvedValue({id:3,is_admin:false});
  const request=await(await post({action:'request_join',team_id:id})).json();
  expect((await post({action:'request_join',team_id:id})).status).toBe(409);
  expect((await post({action:'approve_join',request_id:request.request_id})).status).toBe(403);
  session.mockResolvedValue({id:2,is_admin:false});
  expect((await(await myTeam()).json()).join_requests_received[0]).toMatchObject({username:'bob',status:'pending'});
  expect((await post({action:'approve_join',request_id:request.request_id})).status).toBe(200);
  expect((await rows('SELECT current_team(3) AS id'))[0].id).toBe(id);
  expect((await rows('SELECT team_id,agent_scope_active(id) AS active,rating FROM arena_agents WHERE user_id=3'))[0]).toMatchObject({team_id:null,active:false,rating:1234});
  expect((await post({action:'approve_join',request_id:request.request_id})).status).toBe(409);
});
it('does not let a normal teammate approve or inspect requests',async()=>{
  const id=await create();
  const invite=await manage(2,'invite',{username:'charlie'});
  await manage(4,'accept',{invitation_id:invite.invitation_id});
  const request=await join(3,'request_join',{team_id:id});
  session.mockResolvedValue({id:4,is_admin:false});
  expect((await(await myTeam()).json()).join_requests_received).toEqual([]);
  expect((await post({action:'approve_join',request_id:request.request_id})).status).toBe(403);
});
it('allows the applicant to cancel and leader to decline; rejects third-party cancellation',async()=>{
  const id=await create();
  let request=await join(3,'request_join',{team_id:id});
  await expect(join(4,'cancel_join',{request_id:request.request_id})).rejects.toThrow('FORBIDDEN');
  await join(3,'cancel_join',{request_id:request.request_id});
  request=await join(3,'request_join',{team_id:id});
  await join(2,'decline_join',{request_id:request.request_id});
  expect((await rows('SELECT status FROM team_join_requests ORDER BY id')).map(r=>r.status)).toEqual(['cancelled','declined']);
});
it('rejects closed/full/archived teams and players who already belong to a team',async()=>{
  const id=await create();
  await manage(2,'update',{name:'Closed',recruiting:false});
  await expect(join(3,'request_join',{team_id:id})).rejects.toThrow('TEAM_NOT_RECRUITING');
  await manage(2,'update',{name:'Open',recruiting:true});
  await expect(join(2,'request_join',{team_id:id})).rejects.toThrow('ALREADY_IN_TEAM');
  for(const user of [3,4]){const r=await join(user,'request_join',{team_id:id});await join(2,'approve_join',{request_id:r.request_id});}
  await expect(join(5,'request_join',{team_id:id})).rejects.toThrow('TEAM_FULL');
  await manage(1,'archive',{team_id:id});
  await expect(join(5,'request_join',{team_id:id})).rejects.toThrow('TEAM_NOT_FOUND');
  expect((await(await list()).json()).total).toBe(0);
});
it('does not overfill the last seat when an invitation competes with approval',async()=>{
  const id=await create();
  let r=await join(3,'request_join',{team_id:id});await join(2,'approve_join',{request_id:r.request_id});
  r=await join(4,'request_join',{team_id:id});
  const invite=await manage(2,'invite',{username:'dave'});
  const results=await Promise.allSettled([join(2,'approve_join',{request_id:r.request_id}),manage(5,'accept',{invitation_id:invite.invitation_id})]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(await rows('SELECT * FROM team_members WHERE team_id=$1',[id])).toHaveLength(3);
});
it('expires requests after seven days and permits a fresh request',async()=>{
  const id=await create();
  const request=await join(3,'request_join',{team_id:id});
  await rows("UPDATE team_join_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[request.request_id]);
  await expect(join(2,'approve_join',{request_id:request.request_id})).rejects.toThrow('JOIN_REQUEST_EXPIRED');
  session.mockResolvedValue({id:3,is_admin:false});
  expect((await(await list()).json()).teams[0].request_status).toBe('expired');
  const next=await join(3,'request_join',{team_id:id});expect(next.request_id).not.toBe(request.request_id);
});
it('cancels other applications and invitations when approval changes participation',async()=>{
  const a=await create(),b=await create(4,'Other Team');
  const request=await join(3,'request_join',{team_id:a});await join(3,'request_join',{team_id:b});
  await manage(4,'invite',{username:'bob'});
  await state.db!.exec("INSERT INTO rated_matches(kind,agent1_id,agent2_id,status) VALUES('rating',3,5,'scheduled'),('rating',3,5,'running')");
  await join(2,'approve_join',{request_id:request.request_id});
  expect((await rows('SELECT status FROM team_join_requests ORDER BY id')).map(r=>r.status)).toEqual(['accepted','cancelled']);
  expect((await rows('SELECT status FROM team_invitations'))[0].status).toBe('cancelled');
  expect((await rows('SELECT status FROM rated_matches ORDER BY id')).map(r=>r.status)).toEqual(['cancelled','running']);
});
it('cancels pending requests when joining by invitation, creating a team, or archiving',async()=>{
  const a=await create(),b=await create(4,'Other Team');
  await join(3,'request_join',{team_id:a});await join(5,'request_join',{team_id:a});await join(6,'request_join',{team_id:a});
  const invite=await manage(4,'invite',{username:'bob'});await manage(3,'accept',{invitation_id:invite.invitation_id});
  await manage(5,'create',{name:'New'});await manage(1,'archive',{team_id:a});
  expect((await rows('SELECT status FROM team_join_requests')).every(r=>r.status==='cancelled')).toBe(true);
  expect(b).toBeTruthy();
});
it('validates numeric IDs and prevents client-supplied actor spoofing',async()=>{
  const id=await create();session.mockResolvedValue({id:3,is_admin:false});
  for(const body of [{action:'request_join',team_id:'1'},{action:'approve_join',request_id:-1},{action:'cancel_join',request_id:1.5}])
    expect((await post(body)).status).toBe(400);
  const request=await(await post({action:'request_join',team_id:id,requester_id:4})).json();
  expect((await rows('SELECT requester_id FROM team_join_requests WHERE id=$1',[request.request_id]))[0].requester_id).toBe(3);
});
it('filters by team/member names and paginates independently of agents',async()=>{
  await create();
  expect((await(await list('?search=ALICE')).json()).total).toBe(1);
  expect((await(await list('?search=missing')).json()).total).toBe(0);
  await state.db!.exec("INSERT INTO users(username,password_hash) SELECT 'leader'||n,'x' FROM generate_series(1,22)n; INSERT INTO teams(name,creator_id) SELECT username,id FROM users WHERE username LIKE 'leader%'");
  expect((await(await list()).json()).teams).toHaveLength(20);
  expect((await(await list('?page=2')).json()).teams).toHaveLength(3);
});
it('reapplies the migration without changing membership, agents, ratings or requests',async()=>{
  const id=await create();await join(3,'request_join',{team_id:id});
  const before=await rows('SELECT * FROM arena_agents ORDER BY id');
  await state.db!.exec(migration);
  expect(await rows('SELECT * FROM arena_agents ORDER BY id')).toEqual(before);
  expect(await rows('SELECT * FROM team_join_requests')).toHaveLength(1);
  expect(await rows('SELECT * FROM team_members')).toHaveLength(1);
});
