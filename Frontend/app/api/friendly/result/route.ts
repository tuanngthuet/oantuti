import { NextResponse } from "next/server";
import { sql, sqlTransaction } from "@/lib/db";
import { requireWorkerCallbackSecret } from "@/lib/worker-auth";
import { isExecutionToken, isMatchId, isRecord, parseFinishedCallback, verifyDelivery } from "@/lib/match-callback";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const authErr = requireWorkerCallbackSecret(request);
  if (authErr) return authErr;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!isRecord(body) || !isMatchId(body.friendly_match_id) || !["started", "finished"].includes(String(body.event))) {
    return NextResponse.json({ error: "Valid friendly_match_id and event required." }, { status: 400 });
  }
  const matchId = body.friendly_match_id;
  try {
    if (body.event === "started") {
      if (!isExecutionToken(body.delivery_id)) return NextResponse.json({ error: "delivery_id required for started." }, { status: 400 });
      const deliveryId = body.delivery_id;
      const rows = await sql`
        UPDATE friendly_matches
        SET status = CASE WHEN trial_scope_allowed(id) THEN 'running' ELSE 'cancelled' END, execution_token = ${deliveryId}, execution_worker = ${deliveryId}
        WHERE id = ${matchId} AND status = 'scheduled' AND execution_token IS NULL
        RETURNING id, execution_token,status
      `;
      if (rows.length) return rows[0].status==='cancelled'
        ? NextResponse.json({ok:false,reason:'already_finished'},{status:409})
        : NextResponse.json({ ok: true, execution_token: rows[0].execution_token });
      const check = await sql`SELECT status, execution_token FROM friendly_matches WHERE id = ${matchId}`;
      if (!check.length) return NextResponse.json({ error: "Match not found." }, { status: 404 });
      if (check[0].status === "running" && check[0].execution_token === deliveryId) {
        return NextResponse.json({ ok: true, execution_token: deliveryId, duplicate: true });
      }
      if (check[0].status === "running") {
        const verified = await verifyDelivery(`friendly-${matchId}`, deliveryId);
        if (verified === null) return NextResponse.json({ error: "Cannot verify delivery." }, { status: 503 });
        if (verified) {
          const claimed = await sql`
            UPDATE friendly_matches
            SET execution_token = ${deliveryId}, execution_worker = ${deliveryId}
            WHERE id = ${matchId} AND status = 'running'
              AND execution_token IS NOT DISTINCT FROM ${check[0].execution_token}::text
            RETURNING id
          `;
          if (claimed.length) return NextResponse.json({ ok: true, execution_token: deliveryId });
        }
      }
      return NextResponse.json({ ok: false, reason: ["finished", "error", "cancelled"].includes(check[0].status)
        ? "already_finished" : "another_worker" }, { status: 409 });
    }

    const result = parseFinishedCallback(body);
    if (!result) return NextResponse.json({ error: "Invalid finished payload or missing execution_token." }, { status: 400 });
    const { token, isInfra, outcome, winReason, totalMoves, moves } = result;
    const rows = await sql`SELECT id, status, execution_token FROM friendly_matches WHERE id = ${matchId}`;
    if (!rows.length) return NextResponse.json({ error: "Match not found." }, { status: 404 });
    const match = rows[0];
    if (match.status === "finished" || match.status === "error") return NextResponse.json({ ok: true, duplicate: true });
    if (match.status !== "running" || !match.execution_token || token !== match.execution_token) {
      return NextResponse.json({ ok: false, reason: "token_mismatch" }, { status: 409 });
    }
    const [updated] = await sqlTransaction(txn => [txn`
      WITH finalized AS (
        UPDATE friendly_matches
        SET status = ${isInfra ? "error" : "finished"}, outcome = ${outcome},
            winner_agent_id = CASE WHEN ${outcome}::text = 'agent1' THEN agent1_id
                                   WHEN ${outcome}::text = 'agent2' THEN agent2_id ELSE NULL END,
            win_reason = ${winReason}, total_moves = ${totalMoves}, is_infra_error = ${isInfra},
            pending_backend = false, finished_at = NOW(), execution_token = NULL, execution_worker = NULL
        WHERE id = ${matchId} AND status = 'running' AND execution_token = ${token}
        RETURNING id
      ), history AS (
        INSERT INTO friendly_match_history
          (friendly_match_id, move_number, player, from_col, from_row, to_col, to_row,
           from_pos, to_pos, piece_type, captured_type)
        SELECT f.id, m.move_number, m.player, m.from_col, m.from_row, m.to_col, m.to_row,
               m.from_pos, m.to_pos, m.piece_type, m.captured_type
        FROM finalized f CROSS JOIN jsonb_to_recordset(${JSON.stringify(moves)}::jsonb) AS m(
          move_number int, player int, from_col int, from_row int, to_col int, to_row int,
          from_pos text, to_pos text, piece_type text, captured_type text)
        ON CONFLICT (friendly_match_id, move_number) DO NOTHING
        RETURNING id
      ) SELECT id FROM finalized
    `]);
    return NextResponse.json((updated as unknown[]).length ? { ok: true } : { ok: true, duplicate: true });
  } catch (error) {
    console.error("[friendly/result] error:", error);
    return NextResponse.json({ error: "DB error." }, { status: 500 });
  }
}
