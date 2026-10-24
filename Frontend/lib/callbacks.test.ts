/**
 * Tests for /api/rating/match-result và /api/friendly/result callback routes.
 *
 * Run with:
 *   cd Frontend && npm test
 *
 * Mock strategy:
 *   - Mock @/lib/db (sql + sqlTransaction) để không cần DB thật.
 *   - Mock @/lib/rating-scheduler (dispatchNextRatingTask) để không có side effects.
 *   - Mock @/lib/worker-auth (requireWorkerCallbackSecret) để luôn pass auth.
 *   - Test các scenario: happy path, duplicate, token fencing, 409, transaction rollback.
 *
 * NOTE: Các tests này verify logic flow và response codes.
 *       Integration tests với DB thật cần Neon test branch.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── Mock modules ──────────────────────────────────────────────────────────────

// Mock auth — luôn pass
vi.mock("@/lib/worker-auth", () => ({
  requireWorkerCallbackSecret: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/backend", () => ({ backendFetch: vi.fn().mockResolvedValue({ ok: true, data: { ok: false } }) }));

// Mock dispatcher
vi.mock("@/lib/rating-scheduler", () => ({
  dispatchNextRatingTask: vi.fn().mockResolvedValue({ dispatched: false }),
}));

// Mock db — được cấu hình riêng trong từng test
const mockSql = vi.fn();
const mockSqlTransaction = vi.fn();

vi.mock("@/lib/db", () => ({
  sql: mockSql,
  sqlTransaction: mockSqlTransaction,
}));

// Mock trueskill
vi.mock("@/lib/trueskill", () => ({
  rate1v1: vi.fn().mockReturnValue({
    agent1: { mu: 26, sigma: 8 },
    agent2: { mu: 24, sigma: 8 },
  }),
  displayRating: vi.fn().mockImplementation(({ mu }: { mu: number; sigma: number }) =>
    Math.round(1000 + 40 * (mu - 25))
  ),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/rating/match-result", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function makeFriendlyRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/friendly/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// sql template tag mock: sql`...` returns mockSql(...)
// We set mockSql.mockResolvedValueOnce() for each expected query in sequence.

beforeEach(() => {
  vi.clearAllMocks();
  // Default: sql returns empty array; sqlTransaction returns [[]]
  mockSql.mockResolvedValue([]);
  mockSqlTransaction.mockResolvedValue([[]]);
});

// ═════════════════════════════════════════════════════════════════════════════
// Rating match-result tests
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/rating/match-result — started", () => {

  it("401 khi thiếu auth", async () => {
    const { requireWorkerCallbackSecret } = await import("@/lib/worker-auth");
    (requireWorkerCallbackSecret as Mock).mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
    );
    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest({ event: "started", rated_match_id: 1, delivery_id: "d1" }));
    expect(res.status).toBe(401);
  });

  it("400 khi thiếu delivery_id", async () => {
    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest({ event: "started", rated_match_id: 1 }));
    expect(res.status).toBe(400);
  });

  it("200 + execution_token khi cấp token thành công", async () => {
    // UPDATE trả 1 row → token được cấp
    mockSql.mockResolvedValueOnce([{ id: 1, execution_token: "d1" }]);
    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest({ event: "started", rated_match_id: 1, delivery_id: "d1" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.execution_token).toBe("d1");
  });

  it("409 khi worker khác đang giữ token", async () => {
    // UPDATE trả 0 rows (có token rồi)
    mockSql.mockResolvedValueOnce([]);
    // SELECT check: status=running, execution_token=other-worker
    mockSql.mockResolvedValueOnce([{ status: "running", execution_token: "other-worker" }]);
    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest({ event: "started", rated_match_id: 1, delivery_id: "d1" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("another_worker");
  });

  it("409 khi match đã finished", async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([{ status: "finished", execution_token: null }]);
    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest({ event: "started", rated_match_id: 1, delivery_id: "d1" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("already_finished");
  });

  it("200 + duplicate:true khi cùng delivery_id gọi lại", async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([{ status: "running", execution_token: "d1" }]);
    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest({ event: "started", rated_match_id: 1, delivery_id: "d1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicate).toBe(true);
    expect(body.execution_token).toBe("d1");
  });
});

describe("POST /api/rating/match-result — finished (rating match)", () => {

  const finishedPayload = {
    event: "finished",
    rated_match_id: 1,
    delivery_id: "d1",
    execution_token: "d1",
    outcome: "agent1",
    win_reason: "Agent P2 thua",
    total_moves: 24,
    is_infra_error: false,
    agent_error: false,
    moves_history: [],
  };

  it("200 khi transaction thành công", async () => {
    // SELECT match
    mockSql.mockResolvedValueOnce([{
      id: 1, kind: "rating",
      agent1_id: 10, agent2_id: 20,
      status: "running",
      validation_attempts: 0,
      execution_token: "d1", execution_worker: "d1",
    }]);
    // SELECT agents cho TrueSkill
    mockSql.mockResolvedValueOnce([
      { id: 10, trueskill_mu: 25, trueskill_sigma: 8.33, rating: 1000 },
      { id: 20, trueskill_mu: 25, trueskill_sigma: 8.33, rating: 1000 },
    ]);
    // sqlTransaction → [RETURNING id, agent1 update, agent2 update, snapshot update]
    mockSqlTransaction.mockResolvedValueOnce([[{ id: 1 }], [], [], []]);
    // move history inserts (0 moves)

    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest(finishedPayload));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBeUndefined();
  });

  it("200 + duplicate:true khi match đã finished", async () => {
    mockSql.mockResolvedValueOnce([{
      id: 1, kind: "rating",
      agent1_id: 10, agent2_id: 20,
      status: "finished",
      validation_attempts: 0,
      execution_token: null, execution_worker: null,
    }]);
    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest(finishedPayload));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicate).toBe(true);
  });

  it("409 khi execution_token không khớp (fencing)", async () => {
    mockSql.mockResolvedValueOnce([{
      id: 1, kind: "rating",
      agent1_id: 10, agent2_id: 20,
      status: "running", validation_attempts: 0,
      execution_token: "other-token", execution_worker: "other-token",
    }]);
    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest({ ...finishedPayload, execution_token: "wrong-token" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("token_mismatch");
  });

  it("500 khi transaction thất bại → không finalize", async () => {
    mockSql.mockResolvedValueOnce([{
      id: 1, kind: "rating",
      agent1_id: 10, agent2_id: 20,
      status: "running", validation_attempts: 0,
      execution_token: "d1", execution_worker: "d1",
    }]);
    mockSql.mockResolvedValueOnce([
      { id: 10, trueskill_mu: 25, trueskill_sigma: 8.33, rating: 1000 },
      { id: 20, trueskill_mu: 25, trueskill_sigma: 8.33, rating: 1000 },
    ]);
    // Transaction fails (DB error)
    mockSqlTransaction.mockRejectedValueOnce(new Error("DB connection lost"));
    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest(finishedPayload));
    expect(res.status).toBe(500);
  });

  it("200 + duplicate khi transaction commit nhưng RETURNING rỗng", async () => {
    // Xảy ra khi callback thứ hai đến sau khi callback thứ nhất đã commit
    mockSql.mockResolvedValueOnce([{
      id: 1, kind: "rating",
      agent1_id: 10, agent2_id: 20,
      status: "running", validation_attempts: 0,
      execution_token: "d1", execution_worker: "d1",
    }]);
    mockSql.mockResolvedValueOnce([
      { id: 10, trueskill_mu: 25, trueskill_sigma: 8.33, rating: 1000 },
      { id: 20, trueskill_mu: 25, trueskill_sigma: 8.33, rating: 1000 },
    ]);
    // Transaction: UPDATE RETURNING trả [] (đã bị finalized trong lúc chạy)
    mockSqlTransaction.mockResolvedValueOnce([[], [], [], []]);
    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest(finishedPayload));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicate).toBe(true);
  });
});

describe("POST /api/rating/match-result — validation match", () => {

  it("agent pass validation → 200", async () => {
    mockSql.mockResolvedValueOnce([{
      id: 1, kind: "validation",
      agent1_id: 10, agent2_id: 10,
      status: "running", validation_attempts: 0,
      execution_token: "d1", execution_worker: "d1",
    }]);
    // No TrueSkill needed for validation
    // sqlTransaction: finalize + agent status update
    mockSqlTransaction.mockResolvedValueOnce([[{ id: 1 }], []]);

    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest({
      event: "finished",
      rated_match_id: 1,
      delivery_id: "d1",
      execution_token: "d1",
      outcome: "agent1",
      win_reason: "",
      total_moves: 10,
      is_infra_error: false,
      agent_error: false,
      moves_history: [],
    }));
    expect(res.status).toBe(200);

  });

  it("infra error attempt 1 → status=scheduled, retrying:true", async () => {
    mockSql.mockResolvedValueOnce([{
      id: 1, kind: "validation",
      agent1_id: 10, agent2_id: 10,
      status: "running", validation_attempts: 0,
      execution_token: "d1", execution_worker: "d1",
    }]);
    mockSqlTransaction.mockResolvedValueOnce([[{ id: 1, validation_attempts: 1 }]]);

    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest({
      event: "finished",
      rated_match_id: 1,
      delivery_id: "d1",
      execution_token: "d1",
      outcome: null,
      win_reason: "Judge0 timeout",
      total_moves: 0,
      is_infra_error: true,
      infra_error_detail: "Judge0 timeout",
      agent_error: false,
      moves_history: [],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retrying).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Friendly result tests
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/friendly/result — started", () => {

  it("200 + execution_token khi cấp token thành công", async () => {
    mockSql.mockResolvedValueOnce([{ id: 5, execution_token: "d2" }]);
    const { POST } = await import("@/app/api/friendly/result/route");
    const res = await POST(makeFriendlyRequest({
      event: "started", friendly_match_id: 5, delivery_id: "d2",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.execution_token).toBe("d2");
  });

  it("409 khi worker khác đang giữ token", async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([{ status: "running", execution_token: "other" }]);
    const { POST } = await import("@/app/api/friendly/result/route");
    const res = await POST(makeFriendlyRequest({
      event: "started", friendly_match_id: 5, delivery_id: "d2",
    }));
    expect(res.status).toBe(409);
  });
});

describe("POST /api/friendly/result — finished", () => {

  const finishedPayload = {
    event: "finished",
    friendly_match_id: 5,
    delivery_id: "d2",
    execution_token: "d2",
    outcome: "agent1",
    winner_agent_id: 10,
    win_reason: "Agent P2 thua",
    total_moves: 15,
    is_infra_error: false,
    moves_history: [
      {
        move_number: 1, player: 1,
        from_col: 0, from_row: 0, to_col: 0, to_row: 1,
        from_pos: "a1", to_pos: "a2",
        captured_type: null,
      },
    ],
  };

  it("200 khi transaction thành công", async () => {
    mockSql.mockResolvedValueOnce([{ id: 5, status: "running", execution_token: "d2" }]);
    // sqlTransaction: finalize + 1 move insert
    mockSqlTransaction.mockResolvedValueOnce([[{ id: 5 }], []]);
    const { POST } = await import("@/app/api/friendly/result/route");
    const res = await POST(makeFriendlyRequest(finishedPayload));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("200 + duplicate khi match đã finished", async () => {
    mockSql.mockResolvedValueOnce([{ id: 5, status: "finished", execution_token: null }]);
    const { POST } = await import("@/app/api/friendly/result/route");
    const res = await POST(makeFriendlyRequest(finishedPayload));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicate).toBe(true);
  });

  it("409 khi execution_token không khớp (fencing)", async () => {
    mockSql.mockResolvedValueOnce([{ id: 5, status: "running", execution_token: "correct-token" }]);
    const { POST } = await import("@/app/api/friendly/result/route");
    const res = await POST(makeFriendlyRequest({ ...finishedPayload, execution_token: "wrong-token" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("token_mismatch");
  });

  it("500 khi transaction fails → không finalize", async () => {
    mockSql.mockResolvedValueOnce([{ id: 5, status: "running", execution_token: "d2" }]);
    mockSqlTransaction.mockRejectedValueOnce(new Error("DB error"));
    const { POST } = await import("@/app/api/friendly/result/route");
    const res = await POST(makeFriendlyRequest(finishedPayload));
    expect(res.status).toBe(500);
  });

  it("200 + duplicate khi RETURNING rỗng (concurrent callback)", async () => {
    mockSql.mockResolvedValueOnce([{ id: 5, status: "running", execution_token: "d2" }]);
    mockSqlTransaction.mockResolvedValueOnce([[], []]);
    const { POST } = await import("@/app/api/friendly/result/route");
    const res = await POST(makeFriendlyRequest(finishedPayload));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicate).toBe(true);
  });

  it("move history được ghi trong cùng SQL statement với finalize", async () => {
    mockSql.mockResolvedValueOnce([{ id: 5, status: "running", execution_token: "d2" }]);

    let txnQueriesCount = 0;
    mockSqlTransaction.mockImplementationOnce(async (fn: (txn: (strings: TemplateStringsArray, ...values: unknown[]) => object) => object[]) => {
      const mockTxn = () => {
        txnQueriesCount++;
        return {};
      };
      fn(mockTxn);
      return Array(txnQueriesCount).fill([]);
    });

    const { POST } = await import("@/app/api/friendly/result/route");
    await POST(makeFriendlyRequest(finishedPayload));

    expect(txnQueriesCount).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Hai worker cùng nhận 1 match
// ═════════════════════════════════════════════════════════════════════════════

describe("Hai worker cùng match — execution token fencing", () => {

  it("Worker A bị reject (409) khi Worker B đã giữ token", async () => {
    // Worker B đã cấp token thành công trước.
    // Worker A gửi finished với token của mình → không khớp → 409.
    mockSql.mockResolvedValueOnce([{
      id: 1, kind: "rating",
      agent1_id: 10, agent2_id: 20,
      status: "running", validation_attempts: 0,
      execution_token: "worker-B-token",
      execution_worker: "worker-B-token",
    }]);
    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest({
      event: "finished",
      rated_match_id: 1,
      delivery_id: "worker-A-delivery",
      execution_token: "worker-A-token",    // ← sai token
      outcome: "agent1",
      total_moves: 10,
      is_infra_error: false,
      agent_error: false,
      moves_history: [],
    }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("token_mismatch");
    // Transaction không được gọi → TrueSkill không bị cập nhật 2 lần
    expect(mockSqlTransaction).not.toHaveBeenCalled();
  });

  it("Worker A gửi started khi Worker B đang running → 409 another_worker", async () => {
    mockSql.mockResolvedValueOnce([]);  // UPDATE trả 0 rows
    mockSql.mockResolvedValueOnce([{ status: "running", execution_token: "worker-B-token" }]);
    const { POST } = await import("@/app/api/rating/match-result/route");
    const res = await POST(makeRequest({
      event: "started", rated_match_id: 1, delivery_id: "worker-A-delivery",
    }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("another_worker");
  });
});
