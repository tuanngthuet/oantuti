import { beforeEach, expect, it, vi } from "vitest";
const { session, backend, health, sql } = vi.hoisted(() => ({ session: vi.fn(), backend: vi.fn(), health: vi.fn(), sql: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSession: session }));
vi.mock("@/lib/backend", () => ({ backendFetch: backend, isBackendOnline: health }));
vi.mock("@/lib/db", () => ({ sql }));
import { GET } from "@/app/api/admin/system-status/route";
import { workerActivity } from "@/lib/worker-status";
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';

beforeEach(() => {
  vi.clearAllMocks();
  session.mockResolvedValue({ is_admin: true });
  sql.mockResolvedValue([]);
});
it("keeps backend online when worker status times out", async () => {
  health.mockResolvedValue(true);
  backend.mockResolvedValue({ ok: false, error: "Request timeout" });
  expect(await (await GET()).json()).toMatchObject({ backend_online: true, worker_status: null, worker_status_error: "Request timeout" });
  expect(health).toHaveBeenCalledOnce();
});
it("does not infer backend health from a successful worker request", async () => {
  health.mockResolvedValue(false);
  backend.mockResolvedValue({ ok: true, data: { workers: [], queue_depth: 5 } });
  expect(await (await GET()).json()).toMatchObject({ backend_online: false, worker_status: { queue_depth: 5 }, worker_status_error: null });
});
it("does not probe services for non-admin users", async () => {
  session.mockResolvedValue(null);
  expect((await GET()).status).toBe(403);
  expect(health).not.toHaveBeenCalled();
  expect(backend).not.toHaveBeenCalled();
});
it.each(["stopped", "paused", "error", "starting", "draining", "stopping"])("never calls %s worker idle", state => {
  expect(workerActivity({ state, active_jobs: 0, available_slots: 0 }, 5)).not.toContain("Đang rảnh");
});
it("distinguishes a waiting queue from an empty queue", () => {
  const running = { state: "running", active_jobs: 0, available_slots: 4 };
  expect(workerActivity(running, 5)).toContain("Queue còn 5 job");
  expect(workerActivity(running, 0)).toContain("queue không có job");
  expect(workerActivity({ ...running, available_slots: 0 }, 5)).toContain("chưa sẵn sàng");
});

it('includes validation in recent matches, per-kind totals and active worker labels with real SQL',async()=>{
 const db=new PGlite();
 try{
  for(const file of ['database.sql','arena_schema.sql','tournament_schema.sql','trueskill_migration.sql','friendly_challenge_migration.sql','execution_token_migration.sql','adaptive_rating_migration.sql','teams_migration.sql','private_trials_migration.sql'])
   await db.exec(readFileSync(new URL(`../${file}`,import.meta.url),'utf8'));
  await db.exec(`TRUNCATE users,arena_agents,rated_matches RESTART IDENTITY CASCADE;
   INSERT INTO users(username,password_hash) VALUES('owner','x'),('other','x');
   INSERT INTO arena_agents(user_id,agent_name,code,status) VALUES(1,'Self play agent','code','validating'),(2,'Opponent','code','active');
   INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,dispatched_at) VALUES
    ('validation',1,1,'scheduled',now()),('validation',1,1,'scheduled',NULL),('rating',1,2,'running',now());
   INSERT INTO friendly_matches(created_by,agent1_id,agent2_id,status,pending_backend) VALUES(1,1,2,'scheduled',true);`);
  sql.mockImplementation(async(strings:TemplateStringsArray,...values:unknown[])=>
   (await db.query(strings.reduce((q,part,i)=>q+(i?`$${i}`:'')+part,''),values)).rows);
  health.mockResolvedValue(true);
  backend.mockResolvedValue({ok:true,data:{workers:[{worker_id:'test',active_task_ids:['rating-1'],active_jobs:1,max_concurrent:4,available_slots:3}],queue_depth:1}});
  const data=await(await GET()).json();
  expect(data.recent_matches).toHaveLength(4);
  expect(data.recent_matches.find((m:{source:string;id:number})=>m.source==='validation'&&m.id===1)).toMatchObject({status:'scheduled',queue_state:'queued',created_by_username:'owner',agent1_name:'Self play agent'});
  expect(data.recent_matches.find((m:{source:string;id:number})=>m.source==='validation'&&m.id===2)).toMatchObject({queue_state:'waiting_dispatch'});
  expect(data.match_stats).toEqual({pending:3,running:1,finished:0,error:0});
  expect(data.match_stats_by_kind.validation.pending).toBe(2);
  expect(data.match_stats_by_kind.rating.running).toBe(1);
  expect(data.match_stats_by_kind.friendly.pending).toBe(1);
  expect(data.worker_status.workers[0].active_tasks[0]).toMatchObject({type:'validation',match_id:1,agent1_name:'Self play agent'});
 }finally{await db.close();}
},30000);
