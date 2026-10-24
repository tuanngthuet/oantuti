import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";

const { database, backend, session } = vi.hoisted(() => ({ database: { current: null as PGlite | null }, backend: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/db", () => ({ sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.reduce((result, part, index) => result + (index ? `$${index}` : "") + part, "");
  return (await database.current!.query(text, values)).rows;
} }));
vi.mock("@/lib/backend", () => ({ backendFetch: backend }));
vi.mock("@/lib/session", () => ({ getSession: session }));
import { dispatchNextRatingTask } from "@/lib/rating-scheduler";
import { PATCH } from "@/app/api/admin/rating/control/route";
import { GET as status } from "@/app/api/admin/rating/status/route";
import { rate1v1, TRUESKILL, type TrueSkillRating } from "@/lib/trueskill";

type Reservation = { match_id?: number; kind?: string; reason: string; retry_after_seconds: number; agent1_id?: number; agent2_id?: number };
const exec = (text: string) => database.current!.exec(text);
async function rows<T = Record<string, unknown>>(text: string, values: unknown[] = []) { return (await database.current!.query<T>(text, values)).rows; }
async function reserve(capacity = 4, token = randomUUID()) {
  return (await rows<{ result: Reservation }>("SELECT reserve_rating_dispatch($1::uuid, $2) AS result", [token, capacity]))[0].result;
}
const migration = readFileSync(new URL("../adaptive_rating_migration.sql", import.meta.url), "utf8");
beforeAll(async () => {
  database.current = new PGlite();
  for (const file of ["database.sql", "arena_schema.sql", "tournament_schema.sql", "trueskill_migration.sql", "execution_token_migration.sql"]) {
    await exec(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
  }
  await exec(migration);
}, 30000);
afterAll(async () => { await database.current?.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  session.mockResolvedValue({ id: 1, is_admin: true });
  backend.mockImplementation(async (url: string) => url === "/workers/status"
    ? { ok: true, data: { queue_depth: 0, total_available_slots: 4 } } : { ok: true });
  await exec(`TRUNCATE users, arena_agents, rated_matches RESTART IDENTITY CASCADE;
    UPDATE rating_scheduler_state SET enabled = true, lease_until = 'epoch';
    UPDATE rating_scheduler_policy SET minimum_games=10, stable_sigma=2.5, daily_budget=20, refresh_hours=24,
      pair_cooldown_seconds=60, exploration_every=5, aging_minutes=30, infra_error_limit=3, infra_backoff_minutes=15;
    INSERT INTO users(username,password_hash) VALUES ('one','x'),('two','x'),('three','x'),('four','x'),('archive','x');
    INSERT INTO arena_agents(user_id,agent_name,code,status,is_active) VALUES
      (1,'one','code','active',true),(2,'two','code','active',true),(3,'three','code','active',true),
      (4,'four','code','active',true),(5,'archive','code','rejected',false);`);
});
async function history(one: number, two: number, count: number, age = "2 hours", extra = "") {
  await exec(`INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,outcome,finished_at${extra ? ",scheduler_focal_id" : ""})
    SELECT 'rating',${one},${two},'finished','agent1', NOW() - INTERVAL '${age}' ${extra ? "," + extra : ""}
    FROM generate_series(1,${count});`);
}
async function onlyTwo() { await exec("UPDATE arena_agents SET is_active=false WHERE id IN (3,4)"); }

it("creates disjoint reservations for concurrent dispatchers without overlapping agents", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => reserve()));
  const created = results.filter(result => result.match_id);
  expect(created).toHaveLength(2);
  expect(new Set(created.flatMap(result => [result.agent1_id, result.agent2_id])).size).toBe(4);
});
it('serializes replayed scheduled matches sharing agents while allowing disjoint matches',async()=>{
 await exec("INSERT INTO rated_matches(kind,agent1_id,agent2_id) VALUES('rating',1,2),('rating',1,3),('rating',3,4)");
 const first=await reserve(),second=await reserve();
 expect(first.match_id).toBe(1);expect(second.match_id).toBe(3);
 expect(new Set([first.agent1_id,first.agent2_id,second.agent1_id,second.agent2_id]).size).toBe(4);
 expect((await reserve()).match_id).toBeUndefined();
});
it("does not create rating without available capacity", async () => {
  expect((await reserve(0)).reason).toBe("no_capacity");
  expect(await rows("SELECT id FROM rated_matches")).toHaveLength(0);
});
it("dispatches validation first, even while rating is disabled and workers are stopped", async () => {
  await exec("UPDATE rating_scheduler_state SET enabled=false; INSERT INTO rated_matches(kind,agent1_id,agent2_id) VALUES ('validation',1,1)");
  expect((await reserve(0)).kind).toBe("validation");
  expect((await reserve(0)).reason).toBe("paused");
});
it("fences stale dispatch completions and retries the same match ID after expiry", async () => {
  await onlyTwo();
  const old = randomUUID(), current = randomUUID();
  const first = await reserve(4, old);
  expect((await reserve()).match_id).toBeUndefined();
  await exec("UPDATE rated_matches SET dispatch_lease_until=NOW()-INTERVAL '1 second'");
  expect((await reserve(4, current)).match_id).toBe(first.match_id);
  expect(await rows("UPDATE rated_matches SET dispatched_at=NOW() WHERE dispatch_token=$1::uuid RETURNING id", [old])).toHaveLength(0);
  expect((await rows("SELECT dispatch_token FROM rated_matches"))[0].dispatch_token).toBe(current);
});
it("parks stable agents until the daily refresh is due", async () => {
  await onlyTwo(); await history(1, 2, 10);
  await exec("UPDATE arena_agents SET trueskill_sigma=2");
  expect((await reserve()).reason).toBe("no_eligible_pair");
  expect((await rows("SELECT schedule_state FROM rating_agent_schedule"))[0].schedule_state).toBe("stable");
  await exec("UPDATE rated_matches SET finished_at=NOW()-INTERVAL '25 hours'");
  const result = await reserve(); expect(result.match_id).toBeDefined();
  expect((await rows("SELECT scheduling_reason FROM rated_matches WHERE id=$1", [result.match_id]))[0].scheduling_reason).toBe("refresh_due");
});
it("lets stable agents anchor an uncertain new agent", async () => {
  await history(2, 5, 10); await history(3, 5, 10); await history(4, 5, 10);
  await exec("UPDATE arena_agents SET trueskill_sigma=2 WHERE id<>1");
  const match = await reserve(); expect([match.agent1_id, match.agent2_id]).toContain(1);
});
it('counts draws toward confidence and parks calibrated agents instead of repeatedly evaluating them', async () => {
  await onlyTwo();
  let model: TrueSkillRating = {mu:TRUESKILL.initialMu,sigma:TRUESKILL.initialSigma};
  let games = 0;
  while (games < 10 || model.sigma > 2.5) {
    model = rate1v1(model, model, 'draw').agent1;
    model.mu -= 29/40;
    games++;
    expect(games).toBeLessThanOrEqual(20);
  }
  // Spread completed draws across days: the budget and pair cap must not be
  // what parks these agents; their newly calibrated confidence must do so.
  await history(1,2,games,'48 hours');
  await exec("UPDATE rated_matches SET outcome='draw',total_moves=200; UPDATE rated_matches SET finished_at=NOW()-INTERVAL '2 hours' WHERE id=1");
  await database.current!.query('UPDATE arena_agents SET trueskill_mu=$1,trueskill_sigma=$2,rating=$3', [model.mu,model.sigma,Math.round(40*model.mu)]);
  const agents = await rows('SELECT valid_games,schedule_state,budget_remaining FROM rating_agent_schedule WHERE id IN (1,2) ORDER BY id');
  expect(agents).toEqual(Array.from({length:2},()=>({valid_games:games,schedule_state:'stable',budget_remaining:19})));
  expect((await reserve()).reason).toBe('no_eligible_pair');
});
it("limits daily games and counts pending reservations without resetting history", async () => {
  await onlyTwo(); await history(1, 2, 20);
  expect((await reserve()).match_id).toBeUndefined();
  expect((await rows("SELECT budget_remaining,schedule_state FROM rating_agent_schedule WHERE id=1"))[0])
    .toMatchObject({ budget_remaining: 0, schedule_state: "budget_exhausted" });
  await exec("UPDATE rated_matches SET finished_at=NOW()-INTERVAL '25 hours'");
  expect((await reserve()).match_id).toBeDefined();
  expect((await rows("SELECT reserved_games,budget_remaining FROM rating_agent_schedule WHERE id=1"))[0])
    .toMatchObject({ reserved_games: 1, budget_remaining: 19 });
});

it("reports the actual budget recovery time when legacy history already exceeds the daily cap", async () => {
  await onlyTwo();
  await history(1, 2, 5, '23 hours'); await history(1, 2, 20, '1 hour');
  const [agent] = await rows<{ remaining: number; hours: number }>(`SELECT budget_remaining AS remaining,
    EXTRACT(EPOCH FROM (next_evaluation_at-NOW()))/3600 AS hours FROM rating_agent_schedule WHERE id=1`);
  expect(agent.remaining).toBe(0); expect(Number(agent.hours)).toBeGreaterThan(22);
});
it("backs off repeated infrastructure errors without counting them as valid games", async () => {
  await onlyTwo();
  await exec(`INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,is_infra_error,finished_at)
    SELECT 'rating',1,2,'error',true,NOW() FROM generate_series(1,3)`);
  expect((await reserve()).match_id).toBeUndefined();
  expect((await rows("SELECT valid_games,budget_remaining,schedule_state FROM rating_agent_schedule WHERE id=1"))[0])
    .toMatchObject({ valid_games: 0, budget_remaining: 20, schedule_state: "infra_backoff" });
  await exec("UPDATE rated_matches SET finished_at=NOW()-INTERVAL '16 minutes'");
  expect((await reserve()).match_id).toBeDefined();
});
it("enforces pair cooldown but permits a two-agent pool to play again afterwards", async () => {
  await onlyTwo(); await history(1, 2, 1, "10 seconds");
  expect((await reserve()).match_id).toBeUndefined();
  await exec("UPDATE rated_matches SET finished_at=NOW()-INTERVAL '61 seconds'");
  const match = await reserve(); expect(match.agent1_id).toBe(2); expect(match.agent2_id).toBe(1);
});
it('parks a pair after two draws in 24 hours, even after normal cooldown expires', async () => {
  await onlyTwo(); await history(1, 2, 2, '2 hours');
  await exec("UPDATE rated_matches SET outcome='draw'");
  expect((await reserve()).reason).toBe('no_eligible_pair');
  await exec("UPDATE rated_matches SET finished_at=NOW()-INTERVAL '25 hours'");
  expect((await reserve()).match_id).toBeDefined();
});
it('still allows the color-swapped rematch after a first draw', async () => {
  await onlyTwo(); await history(1, 2, 1, '2 hours');
  await exec("UPDATE rated_matches SET outcome='draw'");
  const next = await reserve();
  expect([next.agent1_id, next.agent2_id]).toEqual([2, 1]);
});
it('moves on to a different opponent when the closest pair keeps drawing', async () => {
  await history(1, 2, 2, '2 hours');
  await exec("UPDATE rated_matches SET outcome='draw'; UPDATE arena_agents SET is_active=false WHERE id=4");
  const next = await reserve();
  expect([next.agent1_id, next.agent2_id]).toContain(3);
});
it("never matches same-owner agents", async () => {
  await onlyTwo(); await exec("UPDATE arena_agents SET user_id=1 WHERE id=2");
  expect((await reserve()).match_id).toBeUndefined();
});
it("skips an unmatchable focal rather than blocking other eligible pairs", async () => {
  await exec("UPDATE arena_agents SET is_active=false WHERE id=4");
  await history(1, 2, 1, "10 seconds"); await history(1, 3, 1, "10 seconds");
  const match = await reserve(); expect([match.agent1_id, match.agent2_id].sort()).toEqual([2, 3]);
});
it("uses the fifth focal selection to explore a less-played pair", async () => {
  await exec("UPDATE arena_agents SET is_active=false WHERE id=4");
  await history(2, 5, 10); await history(3, 5, 10);
  await exec("UPDATE arena_agents SET trueskill_sigma=2 WHERE id IN (2,3); UPDATE arena_agents SET trueskill_mu=50 WHERE id=3");
  await history(1, 2, 3, "2 hours", "1"); await history(1, 3, 1, "2 hours", "1");
  const match = await reserve(); expect([match.agent1_id, match.agent2_id]).toContain(3);
  expect((await rows("SELECT selection_mode FROM rated_matches WHERE id=$1", [match.match_id]))[0].selection_mode).toBe("exploration");
});
it("reapplies the additive migration without changing historical ratings or matches", async () => {
  await history(1, 2, 1); await exec("UPDATE arena_agents SET rating=1234");
  await exec(migration);
  expect((await rows("SELECT rating FROM arena_agents WHERE id=1"))[0].rating).toBe(1234);
  expect(await rows("SELECT id FROM rated_matches")).toHaveLength(1);
});

it("promotes a long-waiting uncertain agent ahead of newer bootstrap agents", async () => {
  await history(1, 5, 10, '1 hour');
  const match = await reserve();
  expect((await rows('SELECT scheduler_focal_id FROM rated_matches WHERE id=$1', [match.match_id]))[0].scheduler_focal_id).toBe(1);
});
it("retries failed enqueue with the original ID and never releases a newer dispatch token", async () => {
  await onlyTwo();
  backend.mockImplementation(async (url: string) => url === "/workers/status"
    ? { ok: true, data: { queue_depth: 0, total_available_slots: 4 } } : { ok: false, error: "timeout" });
  const first = await dispatchNextRatingTask(); expect(first.reason).toBe("enqueue_failed");
  const second = await dispatchNextRatingTask(); expect(second).toMatchObject({ reason: "enqueue_failed", match_id: first.match_id });
  expect(await rows("SELECT id FROM rated_matches")).toHaveLength(1);
});
it('enqueues validation with sixty plies and rating with two hundred',async()=>{
 await exec("UPDATE arena_agents SET status='validating',is_active=false WHERE id=5; INSERT INTO rated_matches(kind,agent1_id,agent2_id) VALUES('validation',5,5)");
 expect((await dispatchNextRatingTask()).kind).toBe('validation');
 let enqueue=backend.mock.calls.find(call=>call[0]==='/rating/enqueue');
 expect(JSON.parse(enqueue![1].body).max_moves).toBe(60);
 backend.mockClear();
 expect((await dispatchNextRatingTask()).kind).toBe('rating');
 enqueue=backend.mock.calls.find(call=>call[0]==='/rating/enqueue');
 expect(JSON.parse(enqueue![1].body).max_moves).toBe(200);
});
it("does not create matches when backend is unreachable or queue already has jobs", async () => {
  backend.mockResolvedValueOnce({ ok: false });
  expect((await dispatchNextRatingTask()).reason).toBe("backend_unavailable");
  backend.mockResolvedValueOnce({ ok: true, data: { queue_depth: 2, total_available_slots: 4 } });
  expect((await dispatchNextRatingTask()).reason).toBe("queue_backlog");
  expect(await rows("SELECT id FROM rated_matches")).toHaveLength(0);
});
it("toggles scheduling independently of rebuild, validating admin access and input", async () => {
  const request = (body: unknown) => new Request("http://local/api/admin/rating/control", { method: "PATCH", body: JSON.stringify(body) });
  session.mockResolvedValueOnce(null); expect((await PATCH(request({ enabled: false }))).status).toBe(403);
  for (const body of [null, [], {}, { enabled: "yes" }, { enabled: true, reset: true }]) {
    expect((await PATCH(request(body))).status).toBe(400);
  }
  expect((await PATCH(request({ enabled: false }))).status).toBe(200);
  expect((await reserve()).reason).toBe("paused");
});

it("explains missing opponents and preserves existing statistics in the admin API", async () => {
  await onlyTwo(); await exec('UPDATE arena_agents SET user_id=1 WHERE id=2');
  const result = await (await status()).json();
  expect(result.agents).toHaveLength(2);
  expect(result.agents[0]).toMatchObject({ waiting_reason: 'no_available_opponent', wins: 0, losses: 0, draws: 0, budget_remaining: 20 });
  expect(result.policy).toMatchObject({ minimum_games: 10, stable_sigma: 2.5, daily_budget: 20 });
});
