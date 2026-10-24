import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const { database } = vi.hoisted(() => ({ database: {
  current: null as PGlite | null,
  afterMatchRead: null as (() => Promise<void>) | null,
} }));
type Query = { text: string; values: unknown[] };
function query(strings: TemplateStringsArray, ...values: unknown[]): Query {
  return { text: strings.reduce((text, part, index) => text + (index ? `$${index}` : "") + part, ""), values };
}
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = query(strings, ...values);
    const rows = (await database.current!.query(q.text, q.values)).rows;
    if (/^\s*SELECT/.test(q.text) && q.text.includes("execution_token") && database.afterMatchRead) {
      await database.afterMatchRead();
    }
    return rows;
  },
  sqlTransaction: async (fn: (txn: typeof query) => Query[]) => database.current!.transaction(async tx => {
    const results = [];
    for (const q of fn(query)) results.push((await tx.query(q.text, q.values)).rows);
    return results;
  }),
}));
vi.mock("@/lib/worker-auth", () => ({ requireWorkerCallbackSecret: () => null }));
vi.mock("@/lib/session", () => ({ getSession: async () => ({ id: 1, is_admin: true }) }));
vi.mock("@/lib/backend", () => ({ backendFetch: vi.fn().mockResolvedValue({ ok: true, data: { ok: false } }) }));

import { POST as rating } from "@/app/api/rating/match-result/route";
import { POST as friendly } from "@/app/api/friendly/result/route";
import { POST as reset } from "@/app/api/admin/matches/reset-stuck/route";
import { POST as resetLost } from "@/app/api/worker/reset-lost/route";
import { backendFetch } from "@/lib/backend";
import {passiveDrawHistory} from './draw-fixtures';

const move = { move_number: 1, player: 1, from_col: 1, from_row: 3, to_col: 0, to_row: 3,
  from_pos: "b4", to_pos: "a4", piece_type: "ROCK", captured_type: null };
function request(body: unknown) {
  return new Request("http://localhost/api/result", { method: "POST", body: JSON.stringify(body) });
}
const finished = { event: "finished", rated_match_id: 1, friendly_match_id: 1,
  execution_token: "d1", outcome: "agent1", total_moves: 1, moves_history: [move] };

beforeAll(async () => {
  const db = new PGlite();
  database.current = db;
  // Use the project's actual migration chain in an in-memory PostgreSQL database.
  for (const file of ["database.sql", "arena_schema.sql", "tournament_schema.sql", "trueskill_migration.sql",
    "friendly_challenge_migration.sql", "execution_token_migration.sql", "adaptive_rating_migration.sql", "teams_migration.sql", "private_trials_migration.sql"]) {
    await db.exec(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
  }
}, 30000);
afterAll(async () => { await database.current?.close(); });
afterEach(() => { database.afterMatchRead = null; vi.restoreAllMocks(); });
beforeEach(async () => {
  vi.mocked(backendFetch).mockResolvedValue({ok:true,status:200,data:{ok:false}});
  await database.current!.exec(`
    TRUNCATE users, arena_agents, rated_matches, friendly_matches RESTART IDENTITY CASCADE;
    INSERT INTO users (username, password_hash) VALUES ('one', 'test'), ('two', 'test');
    INSERT INTO arena_agents (user_id, agent_name, code, status, is_active)
      VALUES (1, 'one', 'code', 'active', true), (2, 'two', 'code', 'active', true);
    UPDATE arena_agents SET is_public=true;
    INSERT INTO rated_matches (kind, agent1_id, agent2_id) VALUES ('rating', 1, 2);
    INSERT INTO friendly_matches (created_by, agent1_id, agent2_id,trial_agent_id) VALUES (1, 1, 2,1);
  `);
});

async function start(handler = rating) {
  const res = await handler(request({ event: "started", rated_match_id: 1, friendly_match_id: 1, delivery_id: "d1" }));
  expect(res.status).toBe(200);
}

function synchronizeMatchReads() {
  let remaining = 2;
  let release: () => void;
  const bothRead = new Promise<void>(resolve => { release = resolve; });
  database.afterMatchRead = async () => {
    if (--remaining === 0) release();
    await bothRead;
  };
}

describe("PostgreSQL callback transactions", () => {
  it.each([
    [25, 25 / 3, 25, 25 / 3],
    [35, 2, 20, 8],
  ])('debits both drawn agents from the verified final board exactly once (%s)', async (mu1, sigma1, mu2, sigma2) => {
    type AgentRating = {id:number;rating:number;trueskill_mu:number;trueskill_sigma:number;wins:number;losses:number};
    await database.current!.query('UPDATE arena_agents SET trueskill_mu=$1,trueskill_sigma=$2,rating=$3 WHERE id=1', [mu1, sigma1, Math.round(40 * mu1)]);
    await database.current!.query('UPDATE arena_agents SET trueskill_mu=$1,trueskill_sigma=$2,rating=$3 WHERE id=2', [mu2, sigma2, Math.round(40 * mu2)]);
    const before = (await database.current!.query<AgentRating>('SELECT id,rating,trueskill_mu,trueskill_sigma,wins,losses FROM arena_agents ORDER BY id')).rows;
    await start();
    const drawn={...finished,outcome:'draw',total_moves:200,moves_history:passiveDrawHistory()};
    expect((await rating(request(drawn))).status).toBe(200);
    const once = (await database.current!.query<AgentRating>('SELECT id,rating,trueskill_mu,trueskill_sigma,wins,losses FROM arena_agents ORDER BY id')).rows;
    expect((await rating(request(drawn))).status).toBe(200);
    const after = (await database.current!.query<AgentRating>('SELECT id,rating,trueskill_mu,trueskill_sigma,wins,losses FROM arena_agents ORDER BY id')).rows;
    expect(after).toEqual(once);
    for (let index=0; index<after.length; index++) {
      expect(after[index]).toMatchObject({...before[index],rating:Number(before[index].rating)-29,
        trueskill_mu:Number(before[index].trueskill_mu)-29/40,trueskill_sigma:expect.any(Number)});
      expect(Number(after[index].trueskill_sigma)).toBeGreaterThan(0);
      expect(Number(after[index].trueskill_sigma)).toBeLessThan(Number(before[index].trueskill_sigma));
    }
    expect((await database.current!.query('SELECT draws FROM arena_agents ORDER BY id')).rows).toEqual([{draws:1},{draws:1}]);
    expect((await database.current!.query('SELECT rating_delta_agent1,rating_delta_agent2 FROM rated_matches')).rows[0])
      .toEqual({rating_delta_agent1:-29,rating_delta_agent2:-29});
  });
  it('rejects a legacy short draw without finalizing or charging points',async()=>{
    await start();
    expect((await rating(request({...finished,outcome:'draw',total_moves:8,moves_history:passiveDrawHistory(8)}))).status).toBe(400);
    expect((await database.current!.query('SELECT rating FROM arena_agents ORDER BY id')).rows).toEqual([{rating:1000},{rating:1000}]);
    expect((await database.current!.query('SELECT status FROM rated_matches')).rows[0]).toEqual({status:'running'});
  });
  it('executes a private source against a public opponent without changing rating or ranked counters',async()=>{
    await database.current!.exec(`INSERT INTO arena_agents(user_id,agent_name,code,status,is_active,is_public) VALUES(1,'private','code','active',true,false);
      UPDATE friendly_matches SET agent1_id=3,trial_agent_id=3 WHERE id=1;`);
    const before=(await database.current!.query('SELECT id,rating,trueskill_mu,trueskill_sigma,wins,losses,draws FROM arena_agents ORDER BY id')).rows;
    await start(friendly);expect((await friendly(request(finished))).status).toBe(200);
    const after=(await database.current!.query('SELECT id,rating,trueskill_mu,trueskill_sigma,wins,losses,draws FROM arena_agents ORDER BY id')).rows;
    expect(after).toEqual(before);
    expect((await database.current!.query('SELECT winner_agent_id FROM friendly_matches WHERE id=1')).rows[0]).toEqual({winner_agent_id:3});
  });
  it("hands off crashed executions only to the delivery verified by Redis", async () => {
    for (const handler of [rating, friendly]) {
      await start(handler);
      const claim = { event: "started", rated_match_id: 1, friendly_match_id: 1, delivery_id: "d2" };
      expect((await handler(request(claim))).status).toBe(409);
      vi.mocked(backendFetch).mockResolvedValueOnce({ ok: false, status: 0, error: "offline" });
      expect((await handler(request(claim))).status).toBe(503);
      vi.mocked(backendFetch).mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true } });
      expect((await handler(request(claim))).status).toBe(200);
      expect((await handler(request(finished))).status).toBe(409);
      expect((await handler(request({ ...finished, execution_token: "d2" }))).status).toBe(200);
    }
  });
  it("applies a rating result and replay exactly once even when both requests read running", async () => {
    await start();
    synchronizeMatchReads();
    const responses = await Promise.all([rating(request(finished)), rating(request(finished))]);
    expect(responses.map(res => res.status)).toEqual([200, 200]);
    const agents = await database.current!.query<{ wins: number; losses: number }>("SELECT wins, losses FROM arena_agents ORDER BY id");
    expect(agents.rows).toEqual([{ wins: 1, losses: 0 }, { wins: 0, losses: 1 }]);
    expect((await database.current!.query("SELECT * FROM rated_match_move_history")).rows).toHaveLength(1);
    const match = (await database.current!.query<{ status: string; agent1_mu_after: number; rating_delta_agent1: number }>("SELECT status, agent1_mu_after, rating_delta_agent1 FROM rated_matches")).rows[0];
    expect(match.status).toBe("finished");
    expect(Number(match.agent1_mu_after)).toBeGreaterThan(25);
    expect(Number(match.rating_delta_agent1)).toBeGreaterThan(0);
  });

  it("rolls back rating, counters and status when replay storage fails, then retries successfully", async () => {
    await start();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await database.current!.exec("ALTER TABLE rated_match_move_history ADD CONSTRAINT reject_history CHECK (move_number <> 1)");
    try {
      expect((await rating(request(finished))).status).toBe(500);
      expect(errorLog).toHaveBeenCalled();
      expect((await database.current!.query<{ status: string }>("SELECT status FROM rated_matches")).rows[0].status).toBe("running");
      expect((await database.current!.query("SELECT wins, rating FROM arena_agents WHERE id = 1")).rows[0]).toEqual({ wins: 0, rating: 1000 });
    } finally {
      await database.current!.exec("ALTER TABLE rated_match_move_history DROP CONSTRAINT reject_history");
    }
    expect((await rating(request(finished))).status).toBe(200);
    expect((await database.current!.query("SELECT * FROM rated_match_move_history")).rows).toHaveLength(1);
  });

  it("rejects missing tokens, invalid events, coordinates and JSON bodies before any writes", async () => {
    await start();
    for (const payload of [null, [], { ...finished, event: "typo" }, { ...finished, execution_token: undefined },
      { ...finished, moves_history: [{ ...move, to_col: 9 }] }, { ...finished, outcome: "bad" }]) {
      expect((await rating(request(payload))).status).toBe(400);
      expect((await friendly(request(payload))).status).toBe(400);
    }
    expect((await database.current!.query<{ status: string }>("SELECT status FROM rated_matches")).rows[0].status).toBe("running");
  });

  it("resets tokens and rejects the old worker after a new delivery starts", async () => {
    await start();
    await start(friendly);
    expect((await reset(new Request("http://localhost/api/reset?mode=pending", { method: "POST" }))).status).toBe(200);
    for (const table of ["rated_matches", "friendly_matches"]) {
      expect((await database.current!.query(`SELECT status, execution_token FROM ${table}`)).rows[0])
        .toEqual({ status: "scheduled", execution_token: null });
    }
    for (const handler of [rating, friendly]) {
      expect((await handler(request({ event: "started", rated_match_id: 1, friendly_match_id: 1, delivery_id: "d2" }))).status).toBe(200);
      expect((await handler(request(finished))).status).toBe(409);
      expect((await handler(request({ ...finished, execution_token: "d2" }))).status).toBe(200);
    }
  });

  it("reset-lost makes friendly matches dispatchable and clears execution ownership", async () => {
    await start();
    await start(friendly);
    await database.current!.exec(`UPDATE rated_matches SET started_at = NOW() - INTERVAL '20 minutes';
      UPDATE friendly_matches SET created_at = NOW() - INTERVAL '20 minutes'`);
    expect((await resetLost(request({}))).status).toBe(200);
    expect((await database.current!.query("SELECT status, execution_token, pending_backend FROM friendly_matches")).rows[0])
      .toEqual({ status: "scheduled", execution_token: null, pending_backend: true });
    await start();
    await start(friendly);
  });

  it("counts validation infrastructure failures once per delivery and rejects after three attempts", async () => {
    await database.current!.exec(`UPDATE rated_matches SET kind = 'validation', agent2_id = 1;
      UPDATE arena_agents SET status = 'validating', is_active = false WHERE id = 1`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const token = `attempt-${attempt}`;
      expect((await rating(request({ event: "started", rated_match_id: 1, delivery_id: token }))).status).toBe(200);
      const payload = { ...finished, execution_token: token, is_infra_error: true, moves_history: [] };
      synchronizeMatchReads();
      const responses = await Promise.all([rating(request(payload)), rating(request(payload))]);
      database.afterMatchRead = null;
      expect(responses.every(res => [200, 409].includes(res.status))).toBe(true);
      expect((await database.current!.query<{ validation_attempts: number }>("SELECT validation_attempts FROM rated_matches")).rows[0].validation_attempts).toBe(attempt);
    }
    expect((await database.current!.query<{ status: string }>("SELECT status FROM arena_agents WHERE id = 1")).rows[0].status).toBe("rejected");
  });

  it("activates an agent only after successful self-play", async () => {
    await database.current!.exec(`UPDATE rated_matches SET kind = 'validation', agent2_id = 1;
      UPDATE arena_agents SET status = 'validating', is_active = false WHERE id = 1`);
    await start();
    expect((await rating(request(finished))).status).toBe(200);
    expect((await database.current!.query("SELECT status, is_active, wins FROM arena_agents WHERE id = 1")).rows[0])
      .toEqual({ status: "active", is_active: true, wins: 0 });
  });

  it("stores friendly replay once and derives the winner from the match's agents", async () => {
    await start(friendly);
    synchronizeMatchReads();
    const responses = await Promise.all([friendly(request({ ...finished, winner_agent_id: 999 })), friendly(request(finished))]);
    expect(responses.map(res => res.status)).toEqual([200, 200]);
    expect((await database.current!.query<{ winner_agent_id: number }>("SELECT winner_agent_id FROM friendly_matches")).rows[0].winner_agent_id).toBe(1);
    expect((await database.current!.query("SELECT piece_type FROM friendly_match_history")).rows).toEqual([{ piece_type: "ROCK" }]);
  });
  it('does not reactivate team agents when self-play finishes after admin dissolution',async()=>{
    await database.current!.exec(`SELECT manage_team(1,'create','{"name":"A"}');
      UPDATE rated_matches SET kind='validation',agent2_id=1;
      UPDATE arena_agents SET status='validating',is_active=false WHERE id=1;
      UPDATE users SET is_admin=true WHERE id=2;`);
    await start();
    await database.current!.exec(`SELECT manage_team(2,'archive','{"team_id":1}')`);
    expect((await rating(request(finished))).status).toBe(200);
    expect((await database.current!.query("SELECT status,is_active,agent_scope_active(id) AS scope FROM arena_agents WHERE id=1")).rows[0])
      .toEqual({status:'active',is_active:false,scope:false});
  });
  it('does not retry infrastructure failures for archived validation jobs',async()=>{
    await database.current!.exec(`SELECT manage_team(1,'create','{"name":"A"}');
      UPDATE rated_matches SET kind='validation',agent2_id=1;
      UPDATE arena_agents SET status='validating',is_active=false WHERE id=1;
      UPDATE users SET is_admin=true WHERE id=2;`);
    await start();await database.current!.exec(`SELECT manage_team(2,'archive','{"team_id":1}')`);
    const response=await rating(request({...finished,is_infra_error:true,moves_history:[]}));
    expect((await response.json()).retrying).toBe(false);
    expect((await database.current!.query('SELECT status FROM rated_matches WHERE id=1')).rows[0]).toEqual({status:'error'});
  });
  it('ACKs stale queued jobs restored after a team is archived without executing them',async()=>{
    await database.current!.exec(`SELECT manage_team(1,'create','{"name":"A"}');UPDATE users SET is_admin=true WHERE id=2;
      SELECT manage_team(2,'archive','{"team_id":1}');UPDATE rated_matches SET status='scheduled';UPDATE friendly_matches SET status='scheduled';`);
    for(const handler of [rating,friendly]){
      const response=await handler(request({event:'started',rated_match_id:1,friendly_match_id:1,delivery_id:'late'}));
      expect(response.status).toBe(409);expect((await response.json()).reason).toBe('already_finished');
    }
  });
});
