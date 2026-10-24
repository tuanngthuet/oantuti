import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session?.is_admin) return NextResponse.json({ error: "Không có quyền." }, { status: 403 });
  try {
    const [summary, agents, matches, scheduler, policy] = await Promise.all([
      sql`
        SELECT
          COUNT(*) FILTER (WHERE kind = 'rating' AND status = 'scheduled')::int AS rating_scheduled,
          COUNT(*) FILTER (WHERE kind = 'rating' AND status = 'running')::int AS rating_running,
          COUNT(*) FILTER (WHERE kind = 'validation' AND status IN ('scheduled', 'running'))::int AS validating,
          COUNT(*) FILTER (WHERE kind = 'rating' AND status = 'finished')::int AS rating_finished
        FROM rated_matches
      `,
      sql`
        SELECT a.*, u.username, original.wins, original.losses, original.draws,
          CASE WHEN a.schedule_state IN ('calibrating','uncertain','refresh_due') AND NOT EXISTS (
            SELECT 1 FROM rating_agent_schedule opponent
            WHERE opponent.id <> a.id AND opponent.user_id <> a.user_id AND NOT opponent.busy
              AND opponent.budget_remaining > 0 AND (opponent.backoff_until IS NULL OR opponent.backoff_until <= NOW())
              AND (SELECT COUNT(*) FROM rated_matches draws WHERE draws.kind='rating' AND draws.status='finished'
                AND NOT draws.is_infra_error AND draws.outcome='draw' AND draws.finished_at>NOW()-INTERVAL '24 hours'
                AND LEAST(draws.agent1_id,draws.agent2_id)=LEAST(a.id,opponent.id)
                AND GREATEST(draws.agent1_id,draws.agent2_id)=GREATEST(a.id,opponent.id)) < 2
              AND NOT EXISTS (
                SELECT 1 FROM rated_matches recent WHERE recent.kind='rating' AND recent.status <> 'cancelled'
                  AND LEAST(recent.agent1_id,recent.agent2_id)=LEAST(a.id,opponent.id)
                  AND GREATEST(recent.agent1_id,recent.agent2_id)=GREATEST(a.id,opponent.id)
                  AND COALESCE(recent.finished_at,recent.started_at,recent.scheduled_at) > NOW()-make_interval(secs => a.pair_cooldown_seconds)
              )
          ) THEN 'no_available_opponent' ELSE NULL END AS waiting_reason
        FROM rating_agent_schedule a
        JOIN arena_agents original ON original.id = a.id
        JOIN users u ON u.id = a.user_id
        ORDER BY a.games_24h, a.last_finished_at ASC NULLS FIRST, a.trueskill_sigma DESC, a.id
      `,
      sql`
        SELECT m.id::int, m.status, m.outcome, m.is_infra_error, m.finished_at, m.scheduling_reason, m.selection_mode,
          a1.agent_name AS agent1_name, a2.agent_name AS agent2_name,
          m.agent1_mu_before, m.agent1_sigma_before, m.agent1_mu_after, m.agent1_sigma_after,
          m.agent2_mu_before, m.agent2_sigma_before, m.agent2_mu_after, m.agent2_sigma_after,
          m.rating_delta_agent1, m.rating_delta_agent2
        FROM rated_matches m
        JOIN arena_agents a1 ON a1.id = m.agent1_id
        JOIN arena_agents a2 ON a2.id = m.agent2_id
        WHERE m.kind = 'rating'
        ORDER BY m.scheduled_at DESC
        LIMIT 20
      `,
      sql`SELECT enabled FROM rating_scheduler_state WHERE id = true`,
      sql`SELECT * FROM rating_scheduler_policy WHERE id = true`,
    ]);
    return NextResponse.json({ summary: summary[0] ?? {}, agents, matches, scheduler_enabled: scheduler[0]?.enabled === true, policy: policy[0] });
  } catch (error) {
    console.error("Rating admin status failed:", error);
    return NextResponse.json({ error: "Không thể tải trạng thái rating." }, { status: 500 });
  }
}
