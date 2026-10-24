import { NextResponse } from "next/server";
import { sql, sqlTransaction } from "@/lib/db";
import { requireWorkerCallbackSecret } from "@/lib/worker-auth";
import { isExecutionToken, isMatchId, isRecord, parseFinishedCallback, verifyDelivery } from "@/lib/match-callback";
import { displayRating, rate1v1 } from "@/lib/trueskill";
import { evaluateDraw } from '@/lib/draw-penalty';

export const runtime = "nodejs";

type RatedMatch = {
  id: number; kind: "validation" | "rating";
  agent1_id: number; agent2_id: number; status: string;
  execution_token: string | null;
};

export async function POST(request: Request) {
  const authErr = requireWorkerCallbackSecret(request);
  if (authErr) return authErr;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!isRecord(body) || !isMatchId(body.rated_match_id) || !["started", "finished"].includes(String(body.event))) {
    return NextResponse.json({ error: "Valid rated_match_id and event required." }, { status: 400 });
  }
  const matchId = body.rated_match_id;

  try {
    if (body.event === "started") {
      if (!isExecutionToken(body.delivery_id)) {
        return NextResponse.json({ error: "delivery_id required for started." }, { status: 400 });
      }
      const deliveryId = body.delivery_id;
      const rows = await sql`
        UPDATE rated_matches
        SET status = CASE WHEN match_scope_allowed(kind,agent1_id,agent2_id) THEN 'running' ELSE 'cancelled' END, started_at = NOW(),
            execution_token = ${deliveryId}, execution_worker = ${deliveryId}
        WHERE id = ${matchId} AND status = 'scheduled' AND execution_token IS NULL
        RETURNING id, execution_token,status
      `;
      if (rows.length) return rows[0].status==='cancelled'
        ? NextResponse.json({ok:false,reason:'already_finished'},{status:409})
        : NextResponse.json({ ok: true, execution_token: rows[0].execution_token });
      const check = await sql`SELECT status, execution_token FROM rated_matches WHERE id = ${matchId}`;
      if (!check.length) return NextResponse.json({ error: "Match not found." }, { status: 404 });
      if (check[0].status === "running" && check[0].execution_token === deliveryId) {
        return NextResponse.json({ ok: true, execution_token: deliveryId, duplicate: true });
      }
      if (check[0].status === "running") {
        const verified = await verifyDelivery(`rating-${matchId}`, deliveryId);
        if (verified === null) return NextResponse.json({ error: "Cannot verify delivery." }, { status: 503 });
        if (verified) {
          const claimed = await sql`
            UPDATE rated_matches
            SET execution_token = ${deliveryId}, execution_worker = ${deliveryId}, started_at = NOW()
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
    const { token, isInfra, outcome, infraDetail, totalMoves, moves, agentError } = result;
    let winReason = result.winReason;
    const rows = await sql`
      SELECT id::int, kind, agent1_id::int, agent2_id::int, status, execution_token
      FROM rated_matches WHERE id = ${matchId}
    ` as RatedMatch[];
    const match = rows[0];
    if (!match) return NextResponse.json({ error: "Match not found." }, { status: 404 });
    if (match.status === "finished" || match.status === "error") return NextResponse.json({ ok: true, duplicate: true });
    if (match.status !== "running" || !match.execution_token || token !== match.execution_token) {
      return NextResponse.json({ ok: false, reason: "token_mismatch" }, { status: 409 });
    }

    if (isInfra && match.kind === "validation") {
      // The attempt increment and rejection depend on winning the token-guarded
      // UPDATE. Concurrent callbacks for an old delivery cannot consume retries.
      const [updated] = await sqlTransaction(txn => [txn`
        WITH finalized AS (
          UPDATE rated_matches
          SET validation_attempts = validation_attempts + 1,
              status = CASE WHEN validation_attempts + 1 < 3 AND agent_scope_active(agent1_id) THEN 'scheduled' ELSE 'error' END,
              dispatched_at = NULL, started_at = NULL,
              finished_at = CASE WHEN validation_attempts + 1 >= 3 THEN NOW() ELSE NULL END,
              is_infra_error = true, infra_error_detail = ${infraDetail}, win_reason = ${winReason},
              execution_token = NULL, execution_worker = NULL
          WHERE id = ${matchId} AND status = 'running' AND execution_token = ${token}
          RETURNING id, agent1_id, validation_attempts,status
        ), rejected AS (
          UPDATE arena_agents SET status = 'rejected', is_active = false,
            validation_error = 'Không thể tự kiểm tra agent sau 3 lần do lỗi hạ tầng.'
          FROM finalized f WHERE arena_agents.id = f.agent1_id AND f.validation_attempts >= 3
          RETURNING arena_agents.id
        ) SELECT id, validation_attempts,status FROM finalized
      `]);
      const finalized = updated as { id: number; validation_attempts: number;status?:string }[];
      if (!finalized.length) return NextResponse.json({ ok: true, duplicate: true });
      return NextResponse.json({ ok: true, retrying: Number(finalized[0].validation_attempts) < 3 && finalized[0].status!=='error' });
    }

    let tsUpdate = null;
    if (!isInfra && outcome && match.kind === "rating") {
      let draw = null;
      if (outcome === 'draw') {
        try {
          if (totalMoves !== 200) throw new Error('A rated draw must last 200 plies; upgrade the worker');
          draw = evaluateDraw(moves);
        } catch(error) {
          return NextResponse.json({error:error instanceof Error ? error.message : 'Invalid draw replay'}, {status:400});
        }
        winReason = `Hòa sau 200 nước. Phạt P1: -${draw.agent1.penalty}; P2: -${draw.agent2.penalty} điểm.`;
      }
      const agents = await sql`
        SELECT id::int, trueskill_mu, trueskill_sigma, rating
        FROM arena_agents WHERE id IN (${match.agent1_id}, ${match.agent2_id})
      `;
      const a1 = agents.find(a => Number(a.id) === Number(match.agent1_id));
      const a2 = agents.find(a => Number(a.id) === Number(match.agent2_id));
      if (!a1 || !a2) throw new Error("Missing rating agents");
      const before1 = { mu: Number(a1.trueskill_mu), sigma: Number(a1.trueskill_sigma) };
      const before2 = { mu: Number(a2.trueskill_mu), sigma: Number(a2.trueskill_sigma) };
      const { agent1: after1, agent2: after2 } = rate1v1(before1, before2, outcome);
      // Draws increase confidence; board penalties separately lower strength. Keep the point debit
      // exact even while an existing deployment is switching score scales.
      if (draw) {
        after1.mu -= draw.agent1.penalty/40;
        after2.mu -= draw.agent2.penalty/40;
      }
      const rating1 = draw ? Number(a1.rating)-draw.agent1.penalty : displayRating(after1);
      const rating2 = draw ? Number(a2.rating)-draw.agent2.penalty : displayRating(after2);
      tsUpdate = { before1, before2, after1, after2, rating1, rating2,
        delta1: rating1 - Number(a1.rating), delta2: rating2 - Number(a2.rating) };
    }
    const ts = tsUpdate;
    const winnerId = outcome === "agent1" ? match.agent1_id : outcome === "agent2" ? match.agent2_id : null;
    // All effects read finalized's RETURNING rows. A losing callback writes
    // nothing, including rating counters and replay. A bad history rolls back all.
    const [updated] = await sqlTransaction(txn => [txn`
      WITH finalized AS (
        UPDATE rated_matches
        SET status = ${isInfra ? "error" : "finished"}, outcome = ${outcome},
            winner_agent_id = ${winnerId}, is_infra_error = ${isInfra},
            infra_error_detail = ${infraDetail}, win_reason = ${winReason},
            total_moves = ${totalMoves}, finished_at = NOW(),
            execution_token = NULL, execution_worker = NULL,
            agent1_mu_before = ${ts?.before1.mu ?? null}, agent1_sigma_before = ${ts?.before1.sigma ?? null},
            agent1_mu_after = ${ts?.after1.mu ?? null}, agent1_sigma_after = ${ts?.after1.sigma ?? null},
            agent2_mu_before = ${ts?.before2.mu ?? null}, agent2_sigma_before = ${ts?.before2.sigma ?? null},
            agent2_mu_after = ${ts?.after2.mu ?? null}, agent2_sigma_after = ${ts?.after2.sigma ?? null},
            rating_delta_agent1 = ${ts?.delta1 ?? null}, rating_delta_agent2 = ${ts?.delta2 ?? null}
        WHERE id = ${matchId} AND status = 'running' AND execution_token = ${token}
        RETURNING id, agent1_id, agent2_id
      ), rated AS (
        UPDATE arena_agents a
        SET trueskill_mu = CASE WHEN a.id = f.agent1_id THEN ${ts?.after1.mu ?? null}::double precision ELSE ${ts?.after2.mu ?? null}::double precision END,
            trueskill_sigma = CASE WHEN a.id = f.agent1_id THEN ${ts?.after1.sigma ?? null}::double precision ELSE ${ts?.after2.sigma ?? null}::double precision END,
            rating = CASE WHEN a.id = f.agent1_id THEN ${ts?.rating1 ?? null}::int ELSE ${ts?.rating2 ?? null}::int END,
            wins = a.wins + CASE WHEN a.id = ${winnerId} THEN 1 ELSE 0 END,
            losses = a.losses + CASE WHEN ${outcome}::text <> 'draw' AND a.id <> ${winnerId} THEN 1 ELSE 0 END,
            draws = a.draws + CASE WHEN ${outcome}::text = 'draw' THEN 1 ELSE 0 END
        FROM finalized f
        WHERE ${ts !== null} AND a.id IN (f.agent1_id, f.agent2_id)
        RETURNING a.id
      ), validated AS (
        UPDATE arena_agents a
        SET status = ${agentError ? "rejected" : "active"}, is_active = ${!agentError} AND (a.team_id IS NULL OR EXISTS(SELECT 1 FROM teams WHERE id=a.team_id AND status='active')),
            validation_error = ${agentError ? winReason || "Agent gặp lỗi khi tự đấu." : null}
        FROM finalized f
        WHERE ${match.kind === "validation" && !isInfra} AND a.id = f.agent1_id AND a.status = 'validating'
        RETURNING a.id
      ), infra AS (
        UPDATE arena_agents a SET error_matches = a.error_matches + 1
        FROM finalized f WHERE ${isInfra && match.kind === "rating"} AND a.id IN (f.agent1_id, f.agent2_id)
        RETURNING a.id
      ), history AS (
        INSERT INTO rated_match_move_history
          (rated_match_id, move_number, player, from_col, from_row, to_col, to_row,
           from_pos, to_pos, piece_type, captured_type)
        SELECT f.id, m.move_number, m.player, m.from_col, m.from_row, m.to_col, m.to_row,
               m.from_pos, m.to_pos, m.piece_type, m.captured_type
        FROM finalized f CROSS JOIN jsonb_to_recordset(${JSON.stringify(moves)}::jsonb) AS m(
          move_number int, player int, from_col int, from_row int, to_col int, to_row int,
          from_pos text, to_pos text, piece_type text, captured_type text)
        ON CONFLICT (rated_match_id, move_number) DO NOTHING
        RETURNING id
      ) SELECT id FROM finalized
    `]);
    if (!(updated as unknown[]).length) return NextResponse.json({ ok: true, duplicate: true });
    // Workers request dispatch when capacity is available; avoid racing a retry
    // enqueue against the ACK of the current Redis delivery.
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[rating/match-result] error:", error);
    return NextResponse.json({ error: "DB error." }, { status: 500 });
  }
}
