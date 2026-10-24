import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
const { database, session } = vi.hoisted(() => ({ database: { current: null as PGlite | null }, session: vi.fn() }));
vi.mock('@/lib/db', () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((r, part, i) => r + (i ? `$${i}` : '') + part, '');
    return (await database.current!.query(text, values)).rows;
  },
  withRetry: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/session', () => ({ getSession: session }));
vi.mock('@/lib/backend',()=>({backendFetch:vi.fn().mockResolvedValue({ok:false})}));
vi.mock('@/lib/rating-scheduler', () => ({ dispatchNextRatingTask: vi.fn().mockResolvedValue({}) }));
import { GET as leaderboard } from '@/app/api/arena/leaderboard/route';
import { GET as agents } from '@/app/api/arena/users/[id]/agents/route';
import { GET as history } from '@/app/api/arena/agents/[id]/history/route';
import { GET as points } from '@/app/api/arena/agents/[id]/rating-history/route';
import { GET as detail, PATCH as update } from '@/app/api/arena/agents/[id]/route';
import { GET as replay } from '@/app/api/rating/matches/[id]/replay/route';
import { GET as matches } from '@/app/api/rating/matches/route';
import {GET as myTeam,POST as teamAction} from '@/app/api/team/route';
import {GET as myAgents,POST as submitAgent} from '@/app/api/arena/agents/route';
import {GET as trialList,POST as createTrial} from '@/app/api/friendly/route';
import {GET as trialReplay} from '@/app/api/friendly/[id]/replay/route';
import {POST as publish} from '@/app/api/arena/agents/[id]/publish/route';
import {POST as validateCode} from '@/app/api/arena/agents/validate/route';
import { buildStandings, matchResult, positivePage } from '@/lib/leaderboard';
const request = (query = '') => new Request(`http://localhost/api/test${query}`);
const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
const exec = (text: string) => database.current!.exec(text);
const postBody=(body:unknown)=>new Request('http://localhost/api/test',{method:'POST',body:JSON.stringify(body)});
beforeAll(async () => {
  database.current = new PGlite();
  for (const name of ['database.sql','arena_schema.sql','tournament_schema.sql','trueskill_migration.sql','friendly_challenge_migration.sql','execution_token_migration.sql','adaptive_rating_migration.sql','teams_migration.sql','team_join_requests_migration.sql','private_trials_migration.sql'])
    await exec(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}, 30000);
afterAll(async () => { await database.current?.close(); });
beforeEach(async () => {
  session.mockResolvedValue(null);
  await exec(`TRUNCATE users, arena_agents, rated_matches RESTART IDENTITY CASCADE;
    INSERT INTO users(username,password_hash) SELECT 'player' || n, 'PRIVATE_HASH' FROM generate_series(1,23) n;
    INSERT INTO arena_agents(user_id,agent_name,code,status,is_active,rating)
      SELECT n, 'Agent ' || n, 'PRIVATE_SOURCE', 'active', n<>22, 1000 + n*10 FROM generate_series(1,23) n;
    INSERT INTO arena_agents(user_id,agent_name,code,status,is_active,rating) VALUES
      (1,'New uncalibrated','PRIVATE_SOURCE','active',true,9000),
      (1,'Archived','PRIVATE_SOURCE','active',false,8000),
      (1,'Rejected','PRIVATE_SOURCE','rejected',false,9999);
    UPDATE arena_agents SET is_public=true;
    INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,outcome,finished_at,scheduled_at,
      agent1_mu_before,agent1_sigma_before,agent1_mu_after,agent1_sigma_after)
      SELECT 'rating',a,22,'finished','agent1',NOW()- n*INTERVAL '1 hour',NOW()-n*INTERVAL '1 hour',25,8.333333333333334,30,3
      FROM generate_series(1,21) a CROSS JOIN generate_series(1,10) n;
    INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,outcome,finished_at)
      SELECT 'rating',23,22,'finished','draw',NOW() FROM generate_series(1,9);
    INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,is_infra_error,win_reason) VALUES
      ('validation',23,23,'finished',false,''),('rating',23,22,'error',true,'PRIVATE_INFRA'),
      ('rating',1,22,'scheduled',false,''),('rating',1,22,'running',false,'');
    INSERT INTO rated_match_move_history(rated_match_id,move_number,player,from_col,from_row,to_col,to_row,from_pos,to_pos,piece_type)
      VALUES (1,1,1,1,3,0,3,'b4','a4','ROCK'),(2,1,1,1,3,0,3,'b4','a4','ROCK');`);
});
it('keeps private agents out of every public agent endpoint and version menu',async()=>{
 await exec("INSERT INTO arena_agents(user_id,agent_name,code,status,is_active) VALUES(1,'Secret draft','secret','active',true)");
 const id=27;
 for(const handler of [detail,history,points])expect((await handler(request(),params(id))).status).toBe(404);
 const listing=await(await agents(request(),params(1))).json();expect(listing.agents.some((a:{id:number})=>a.id===id)).toBe(false);
 const d=await(await detail(request(),params(1))).json();expect(d.versions.some((a:{id:number})=>a.id===id)).toBe(false);
 session.mockResolvedValue({id:1,is_admin:false});expect((await detail(request(),params(id))).status).toBe(200);
});
it('defaults to private, blocks normalized duplicate without extra jobs, then allows only owned active publication',async()=>{
 session.mockResolvedValue({id:1,is_admin:false});const body={agent_name:'Draft',code:'def agent(observation, configuration):\n    return {}\n',expected_scope:'user:1'};
 const first=await(await submitAgent(postBody(body))).json();expect(first.is_public).toBe(false);
 const preflight=await(await validateCode(postBody({code:body.code}))).json();expect(preflight.valid).toBe(false);expect(preflight.agent_id).toBe(first.agent_id);
 session.mockResolvedValue({id:2,is_admin:false});expect((await(await validateCode(postBody({code:body.code}))).json()).valid).toBe(true);
 session.mockResolvedValue({id:1,is_admin:false});
 const duplicate=await submitAgent(postBody({...body,code:'\r\ndef agent(observation, configuration):  \r\n    return {}\r\n'}));
 expect(duplicate.status).toBe(409);expect((await duplicate.json()).agent_id).toBe(first.agent_id);
 expect((await publish(request(),params(first.agent_id))).status).toBe(409);
 await exec(`UPDATE arena_agents SET status='active',is_active=true WHERE id=${Number(first.agent_id)}`);
 session.mockResolvedValue({id:2,is_admin:false});expect((await publish(request(),params(first.agent_id))).status).toBe(403);
 session.mockResolvedValue({id:1,is_admin:false});expect((await publish(request(),params(first.agent_id))).status).toBe(200);
 session.mockResolvedValue(null);expect((await detail(request(),params(first.agent_id))).status).toBe(200);
});
it('persists offline trials, retries idempotently at exhausted quota, and hides them from the opponent',async()=>{
 session.mockResolvedValue({id:1,is_admin:false});
 const body={agent1_id:1,agent2_id:2,request_id:'00000000-0000-4000-8000-000000000001'};
 const first=await(await createTrial(postBody(body))).json();expect(first.queued).toBe(false);expect(first.quota.remaining).toBe(9);
 for(let i=2;i<=10;i++)expect((await createTrial(postBody({...body,request_id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`}))).status).toBe(200);
 expect((await createTrial(postBody({...body,request_id:'00000000-0000-4000-8000-000000000011'}))).status).toBe(429);
 expect((await(await createTrial(postBody(body))).json()).friendly_match_id).toBe(first.friendly_match_id);
 expect((await(await trialList(request())).json()).matches).toHaveLength(10);
 await exec("UPDATE friendly_matches SET win_reason='Agent P2 lỗi: Runtime error with PRIVATE_SOURCE_SNIPPET' WHERE id=1");
 expect(JSON.stringify(await(await trialList(request())).json())).not.toContain('PRIVATE_SOURCE_SNIPPET');
 expect(JSON.stringify(await(await trialReplay(request(),params(first.friendly_match_id))).json())).not.toContain('PRIVATE_SOURCE_SNIPPET');
 session.mockResolvedValue({id:2,is_admin:false});expect((await(await trialList(request())).json()).matches).toHaveLength(0);
 expect((await trialReplay(request(),params(first.friendly_match_id))).status).toBe(404);
});
it('ranks once per user, ignores higher uncalibrated/disabled submissions, and paginates after ranking', async () => {
  const first = await (await leaderboard(request())).json();
  expect(first.total).toBe(21); expect(first.leaderboard).toHaveLength(20);
  expect(first.leaderboard[0]).toMatchObject({ user_id: 21, rank: 1 });
  const second = await (await leaderboard(request('?page=2'))).json();
  expect(second.leaderboard[0]).toMatchObject({ user_id: 1, rank: 21, agent: { id: 1 }, approved_agents: 3 });
  expect(second.authenticated).toBe(false); expect(second.me).toBeNull();
});
it('keeps global ranks when searching any approved agent name', async () => {
  const data = await (await leaderboard(request('?search=New%20uncalibrated'))).json();
  expect(data.total).toBe(1); expect(data.leaderboard[0].rank).toBe(21);
});
it('does not count validation or infrastructure errors towards the tenth game', async () => {
  const data = await (await leaderboard(request('?tab=calibrating'))).json();
  expect(data.leaderboard).toHaveLength(1);
  expect(data.leaderboard[0]).toMatchObject({ user_id: 23, rank: null, agent: { valid_games: 9 } });
});
it('finds my page outside page one without leaking session credentials', async () => {
  session.mockResolvedValue({ id: 1, is_admin: false });
  const data = await (await leaderboard(request())).json();
  expect(data.me).toMatchObject({ user_id: 1, rank: 21, page: 2 });
});
it('falls back to another eligible agent when the representative is disabled', async () => {
  await exec(`UPDATE rated_matches SET agent1_id=24 WHERE agent1_id=1 AND kind='rating';
    UPDATE arena_agents SET is_active=false WHERE id=24;
    UPDATE arena_agents SET is_active=true WHERE id=25;
    INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,outcome) SELECT 'rating',25,22,'finished','draw' FROM generate_series(1,10)`);
  const data = await (await leaderboard(request('?search=player1'))).json();
  expect(data.leaderboard.find((e: {user_id: number}) => e.user_id === 1).agent.id).toBe(25);
});
it('lists approved inactive agents but not rejected submissions, and never returns source', async () => {
  const data = await (await agents(request(), params(1))).json();
  expect(data.agents).toHaveLength(3);
  expect(data.agents.some((a: {id: number}) => a.id === 25)).toBe(true);
  expect(JSON.stringify(data)).not.toContain('PRIVATE');
});
it('loads only this agent rating games and chooses the newest replayable match', async () => {
  const data = await (await history(request(), params(1))).json();
  expect(data.total).toBe(12); expect(data.selected.id).toBe(1);
  expect(data.matches.every((m: {agent1_id: number}) => m.agent1_id === 1)).toBe(true);
});
it('filters pending games without treating them as losses and preserves explicit selection', async () => {
  const data = await (await history(request('?result=scheduled'), params(1))).json();
  expect(data.total).toBe(1); expect(data.matches[0].result).toBe('scheduled');
  expect(data.matches[0].replay_available).toBe(false);
  const selected = await (await history(request(`?matchId=${data.matches[0].id}`), params(1))).json();
  expect(selected.selected.id).toBe(data.matches[0].id);
});
it('rejects cross-agent match IDs and malformed IDs/filters', async () => {
  expect((await history(request('?matchId=11'), params(1))).status).toBe(404);
  expect((await history(request('?matchId=abc'), params(1))).status).toBe(400);
  expect((await history(request('?result=invalid'), params(1))).status).toBe(400);
  expect((await history(request(), params('1abc'))).status).toBe(400);
});
it('allows public agent details and replay, but still protects writes', async () => {
  const data = await (await detail(request(), params(1))).json();
  expect(data.agent.id).toBe(1); expect(data.matches[0].agent1_id).toBe(1);
  expect(JSON.stringify(data)).not.toContain('PRIVATE');
  expect((await replay(request(), params(1))).status).toBe(200);
  expect((await update(new Request('http://localhost', {method:'PATCH',body:'{"status":"active"}'}),params(1))).status).toBe(403);
});
it('does not return an empty replay as a playable board', async () => {
  expect((await replay(request(), params(3))).status).toBe(409);
});
it('builds score history from real per-agent snapshots only', async () => {
  const data = await (await points(request(), params(1))).json();
  expect(data.points).toHaveLength(10);
  expect(data.points[0]).toMatchObject({ before: 1000, after: 1200 });
});
it('sanitizes infrastructure errors in public match lists', async () => {
  const data = await (await matches(request())).json();
  expect(JSON.stringify(data)).not.toContain('PRIVATE_INFRA');
});
it('uses stable tie ordering and does not give pending games a loss', async () => {
  const data = await (await agents(request(),params(1))).json();
  const base = {...data.agents.find((a: {id:number}) => a.id === 1), valid_games: 10, elo: 1000, wins: 0, submitted_at: '2026-01-01'};
  expect(buildStandings([{...base,id:2,user_id:2}, {...base,id:1,user_id:1}]).map(e => e.user_id)).toEqual([1,2]);
  expect(matchResult({status:'running',is_infra_error:false,outcome:null,agent1_id:1},1)).toBe('running');
  expect(positivePage('Infinity')).toBe(1); expect(positivePage('1.5')).toBe(1);
});
it('uses live membership for API ownership, shared code, leaderboard and revocation',async()=>{
  session.mockResolvedValue({id:1,is_admin:false});
  const post=(body:object)=>teamAction(new Request('http://localhost/api/team',{method:'POST',body:JSON.stringify(body)}));
  expect((await post({action:'create',name:'API team'})).status).toBe(200);
  const team=(await(await myTeam()).json()).team;expect(team.members).toHaveLength(1);
  expect((await post({action:'invite',username:'player2'})).status).toBe(200);
  session.mockResolvedValue({id:2,is_admin:false});
  const invitation=(await(await myTeam()).json()).received[0];
  expect((await post({action:'accept',invitation_id:Number(invitation.id)})).status).toBe(200);
  const own=await(await myAgents()).json();
  expect(own.agents.some((a:{id:number})=>Number(a.id)===1)).toBe(true);
  expect(own.agents.some((a:{id:number})=>Number(a.id)===2)).toBe(false);
  expect(own.personal_agents[0].code).toBe('PRIVATE_SOURCE');
  expect((await submitAgent(new Request('http://localhost/api/arena/agents',{method:'POST',body:JSON.stringify({agent_name:'Do not share',code:'def agent(): pass',expected_scope:'user:2'})}))).status).toBe(409);
  const submittedResponse=await submitAgent(new Request('http://localhost/api/arena/agents',{method:'POST',body:JSON.stringify({agent_name:'New shared',code:'def agent(observation, configuration): return {}',team_id:999})}));
  const result=await submittedResponse.json();expect(submittedResponse.status,JSON.stringify(result)).toBe(200);
  const submitted=(await database.current!.query<{team_id:number;user_id:number}>('SELECT team_id,user_id FROM arena_agents WHERE id=$1',[result.agent_id])).rows[0];
  expect(submitted).toEqual({team_id:team.id,user_id:2});
  const board=await(await leaderboard(request())).json();
  expect(board.me).toMatchObject({kind:'team',team_id:team.id,username:'API team'});
  expect((await post({action:'leave'})).status).toBe(200);
  const after=await(await myAgents()).json();expect(after.agents.every((a:{team_id:number|null})=>a.team_id===null)).toBe(true);
  expect(after.agents.some((a:{id:number})=>a.id===result.agent_id)).toBe(false);
});
it('rejects malformed or unauthorized team API actions without mutating data',async()=>{
  expect((await teamAction(new Request('http://localhost/api/team',{method:'POST',body:'{}'}))).status).toBe(401);
  session.mockResolvedValue({id:1,is_admin:false});
  for(const body of [null,[],{action:'accept',invitation_id:'1'},{action:'create',name:''},{action:'transfer',user_id:2}])
    expect((await teamAction(new Request('http://localhost/api/team',{method:'POST',body:JSON.stringify(body)}))).status).toBe(400);
  expect((await teamAction(new Request('http://localhost/api/team',{method:'POST',body:'{"action":"archive","team_id":1}'}))).status).toBe(403);
});
