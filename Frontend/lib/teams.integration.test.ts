import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
let db: PGlite;
const migration = readFileSync(new URL('../teams_migration.sql',import.meta.url),'utf8');
const rows = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) => (await db.query<T>(text,values)).rows;
const action = async (actor: number, kind: string, body: object = {}) => (await rows<{result: {team_id: number; invitation_id: number}}>('SELECT manage_team($1,$2,$3::jsonb) AS result',[actor,kind,JSON.stringify(body)]))[0].result;
beforeAll(async () => {
  db = new PGlite();
  for (const file of ['database.sql','arena_schema.sql','tournament_schema.sql','trueskill_migration.sql','friendly_challenge_migration.sql','execution_token_migration.sql','adaptive_rating_migration.sql'])
    await db.exec(readFileSync(new URL(`../${file}`,import.meta.url),'utf8'));
  await db.exec(migration);
},30000);
afterAll(async () => db?.close());
beforeEach(async () => {
  await db.exec(`TRUNCATE users,arena_agents,rated_matches,teams RESTART IDENTITY CASCADE;
    INSERT INTO users(username,password_hash,is_admin) VALUES ('admin','x',true),('alice','x',false),('bob','x',false),('charlie','x',false),('dave','x',false);
    INSERT INTO arena_agents(user_id,agent_name,code,status,is_active,version,rating) SELECT id,username,'private','active',true,1,1234 FROM users;
    UPDATE rating_scheduler_state SET enabled=true;`);
});
async function inviteJoin(actor = 2, member = 3) {
  const name = (await rows<{username:string}>('SELECT username FROM users WHERE id=$1',[member]))[0].username;
  const invite = await action(actor,'invite',{username:name});
  await action(member,'accept',{invitation_id:invite.invitation_id});
}
it('leaves existing/new users as individuals until they deliberately create a real team', async () => {
  expect(await rows('SELECT * FROM teams')).toHaveLength(0);
  expect((await rows('SELECT current_team(2) AS id'))[0].id).toBeNull();
});
it('moves only founder agents, keeps ratings, and preserves a real one-member team', async () => {
  const team = await action(2,'create',{name:'Đội thử nghiệm'});
  expect((await rows('SELECT team_id,rating,user_id FROM arena_agents WHERE id=2'))[0]).toMatchObject({team_id:team.team_id,rating:1234,user_id:2});
  expect(await rows('SELECT * FROM team_members')).toHaveLength(1);
  await inviteJoin();
  expect((await rows('SELECT team_id,agent_scope_active(id) AS enabled FROM arena_agents WHERE id=3'))[0]).toMatchObject({team_id:null,enabled:false});
});
it('prevents the founder leaving, being removed, transferring leadership, or archiving the team', async () => {
  await action(2,'create',{name:'Locked'});
  await expect(action(2,'leave')).rejects.toThrow('CREATOR_CANNOT_LEAVE');
  await expect(action(2,'remove',{user_id:2})).rejects.toThrow('CREATOR_CANNOT_LEAVE');
  await expect(action(2,'transfer',{user_id:3})).rejects.toThrow('INVALID_ACTION');
  await expect(action(2,'archive',{team_id:1})).rejects.toThrow('FORBIDDEN');
});
it('rejects invitations to existing team members, including solo founders', async () => {
  await action(2,'create',{name:'A'}); await action(3,'create',{name:'B'});
  await expect(action(2,'invite',{username:'bob'})).rejects.toThrow('ALREADY_IN_TEAM');
});
it('serializes acceptance so the team cannot exceed three members', async () => {
  await action(2,'create',{name:'A'}); await inviteJoin();
  const c = await action(2,'invite',{username:'charlie'}), d = await action(2,'invite',{username:'dave'});
  const result = await Promise.allSettled([action(4,'accept',{invitation_id:c.invitation_id}),action(5,'accept',{invitation_id:d.invitation_id})]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(await rows('SELECT * FROM team_members')).toHaveLength(3);
});
it('invalidates other pending invitations after joining and rejects expired invites', async () => {
  await action(2,'create',{name:'A'}); await action(4,'create',{name:'B'});
  const first = await action(2,'invite',{username:'bob'}), other = await action(4,'invite',{username:'bob'});
  await action(3,'accept',{invitation_id:first.invitation_id});
  await expect(action(3,'accept',{invitation_id:other.invitation_id})).rejects.toThrow('INVITATION_EXPIRED');
  const expired = await action(2,'invite',{username:'dave'});
  await rows("UPDATE team_invitations SET expires_at=now()-interval '1 day' WHERE id=$1",[expired.invitation_id]);
  await expect(action(5,'accept',{invitation_id:expired.invitation_id})).rejects.toThrow('INVITATION_EXPIRED');
});
it('limits settings/member controls to the founder and invitations to their recipient', async () => {
  await action(2,'create',{name:'A'}); await inviteJoin();
  await expect(action(3,'update',{name:'Stolen'})).rejects.toThrow('FORBIDDEN');
  await expect(action(3,'remove',{user_id:2})).rejects.toThrow('FORBIDDEN');
  const invite = await action(2,'invite',{username:'charlie'});
  await expect(action(5,'accept',{invitation_id:invite.invitation_id})).rejects.toThrow('INVITATION_NOT_FOUND');
});
it('shares team code without exposing suspended personal code to teammates, and revokes access on leave', async () => {
  await action(2,'create',{name:'A'}); await inviteJoin();
  expect((await rows('SELECT can_use_agent(3,2) AS allowed'))[0].allowed).toBe(true);
  expect((await rows('SELECT can_use_agent(2,3) AS allowed'))[0].allowed).toBe(false);
  await action(3,'leave');
  expect((await rows('SELECT can_use_agent(3,2) AS allowed,can_use_agent(3,3) AS personal'))[0]).toMatchObject({allowed:false,personal:true});
});
it('submits exclusively under the current scope and leaves team submissions behind', async () => {
  const team = await action(2,'create',{name:'A'}); await inviteJoin();
  const submitted = (await rows<{result:{id:number;team_id:number}}>("SELECT submit_arena_agent(3,'Shared','','def agent(): pass') AS result"))[0].result;
  expect(submitted.team_id).toBe(team.team_id);
  await action(3,'leave');
  expect((await rows('SELECT team_id,user_id FROM arena_agents WHERE id=$1',[submitted.id]))[0]).toMatchObject({team_id:team.team_id,user_id:3});
});
it('restores personal scope without re-enabling administratively disabled agents', async () => {
  await db.exec('UPDATE arena_agents SET is_active=false WHERE id=3');
  await action(2,'create',{name:'A'}); await inviteJoin(); await action(2,'remove',{user_id:3});
  expect((await rows('SELECT is_active,agent_scope_active(id) AS scope FROM arena_agents WHERE id=3'))[0]).toMatchObject({is_active:false,scope:true});
});
it('cancels scheduled suspended games but leaves running games to finish', async () => {
  await db.exec("INSERT INTO rated_matches(kind,agent1_id,agent2_id,status) VALUES ('rating',3,4,'scheduled'),('rating',3,5,'running')");
  await action(2,'create',{name:'A'}); await inviteJoin();
  expect((await rows('SELECT status FROM rated_matches ORDER BY id')).map(r=>r.status)).toEqual(['cancelled','running']);
});
it('archives teams only through admin and restores retained personal identities without moving team agents', async () => {
  const team = await action(2,'create',{name:'A'}); await inviteJoin();
  await action(1,'archive',{team_id:team.team_id});
  expect(await rows('SELECT * FROM team_members')).toHaveLength(0);
  expect((await rows('SELECT agent_scope_active(2) AS founder,agent_scope_active(3) AS member'))[0]).toMatchObject({founder:false,member:true});
  expect((await rows('SELECT rating FROM arena_agents WHERE id=2'))[0].rating).toBe(1234);
});
it('excludes suspended personal agents and never rates same-team agents', async () => {
  const team = await action(2,'create',{name:'A'}); await inviteJoin();
  await rows("SELECT submit_arena_agent(3,'Shared','','code')");
  await db.exec("UPDATE arena_agents SET status='active',is_active=true WHERE team_id IS NOT NULL; UPDATE rated_matches SET status='finished' WHERE kind='validation'; UPDATE arena_agents SET is_active=false WHERE id IN (1,4,5)");
  expect(await rows('SELECT id FROM rating_agent_schedule WHERE id=3')).toHaveLength(0);
  const result = (await rows<{result:{reason:string}}>("SELECT reserve_rating_dispatch(gen_random_uuid(),4) AS result"))[0].result;
  expect(result.reason).toBe('no_eligible_pair');
  expect(team.team_id).toBeTruthy();
});
it('allows another member to accept a challenge exactly once', async () => {
  await action(2,'create',{name:'A'}); await inviteJoin();
  const challenge = (await rows<{id:number}>("SELECT send_team_challenge(4,4,2,'hi') AS id"))[0].id;
  const results = await Promise.allSettled([rows("SELECT respond_team_challenge(2,$1,'accept')",[challenge]),rows("SELECT respond_team_challenge(3,$1,'accept')",[challenge])]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(await rows('SELECT * FROM friendly_matches')).toHaveLength(1);
});
it('rejects friendly use of another scope and internal team opponents', async () => {
  await action(2,'create',{name:'A'}); await inviteJoin();
  await expect(rows('SELECT create_scope_friendly(3,3,4)')).rejects.toThrow('FORBIDDEN');
  await expect(rows('SELECT send_team_challenge(2,2,2,\'\')')).rejects.toThrow('SAME_PARTICIPANT');
});
it('reapplies migration without changing team membership, agent ratings or scheduler policy', async () => {
  await action(2,'create',{name:'A'}); await inviteJoin();
  const before = await rows('SELECT id,user_id,team_id,rating,is_active FROM arena_agents ORDER BY id');
  await db.exec(migration);
  expect(await rows('SELECT id,user_id,team_id,rating,is_active FROM arena_agents ORDER BY id')).toEqual(before);
  expect(await rows('SELECT * FROM team_members')).toHaveLength(2);
});
it('rejects a stale editor scope rather than publishing private code to a newly-joined team',async()=>{
  await action(2,'create',{name:'A'});await inviteJoin();
  await expect(rows("SELECT submit_scoped_agent(3,'Private','','code','user:3')")).rejects.toThrow('SCOPE_CHANGED');
  expect(await rows("SELECT * FROM arena_agents WHERE agent_name='Private'")).toHaveLength(0);
});
