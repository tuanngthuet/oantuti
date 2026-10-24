import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getSession } from "@/lib/session";
import { displayRating, rate1v1, TRUESKILL, type TrueSkillRating, type TrueSkillOutcome } from "@/lib/trueskill";

export const runtime = "nodejs";

export async function POST() {
  const session = await getSession();
  if (!session?.is_admin) return NextResponse.json({ error: "Không có quyền." }, { status: 403 });
  try {
    const existing = await sql`SELECT COUNT(*)::int AS count FROM rated_matches WHERE kind = 'rating' AND status = 'finished'` as { count: number }[];
    if (Number(existing[0]?.count ?? 0) > 0) {
      return NextResponse.json({ error: "Không thể rebuild sau khi queue TrueSkill đã có kết quả." }, { status: 409 });
    }
    const agents = await sql`SELECT id::int FROM arena_agents` as { id: number }[];
    const ratings = new Map<number, TrueSkillRating>();
    const stats = new Map<number, { wins: number; losses: number; draws: number }>();
    for (const agent of agents) {
      ratings.set(Number(agent.id), { mu: TRUESKILL.initialMu, sigma: TRUESKILL.initialSigma });
      stats.set(Number(agent.id), { wins: 0, losses: 0, draws: 0 });
    }
    const history = await sql`
      SELECT agent1_id::int, agent2_id::int, outcome
      FROM tournament_matches
      WHERE status = 'finished' AND is_infra_error = false AND outcome IN ('agent1', 'agent2', 'draw')
      ORDER BY finished_at ASC NULLS LAST, id ASC
    ` as { agent1_id: number; agent2_id: number; outcome: TrueSkillOutcome }[];
    for (const match of history) {
      const a = ratings.get(Number(match.agent1_id));
      const b = ratings.get(Number(match.agent2_id));
      if (!a || !b) continue;
      const after = rate1v1(a, b, match.outcome);
      ratings.set(Number(match.agent1_id), after.agent1);
      ratings.set(Number(match.agent2_id), after.agent2);
      const one = stats.get(Number(match.agent1_id))!, two = stats.get(Number(match.agent2_id))!;
      if (match.outcome === "agent1") { one.wins++; two.losses++; }
      else if (match.outcome === "agent2") { two.wins++; one.losses++; }
      else { one.draws++; two.draws++; }
    }
    for (const agent of agents) {
      const rating = ratings.get(Number(agent.id))!, stat = stats.get(Number(agent.id))!;
      await sql`
        UPDATE arena_agents SET trueskill_mu = ${rating.mu}, trueskill_sigma = ${rating.sigma},
          rating = ${displayRating(rating)}, wins = ${stat.wins}, losses = ${stat.losses}, draws = ${stat.draws}
        WHERE id = ${agent.id}
      `;
    }
    await sql`UPDATE rating_scheduler_state SET enabled = true, lease_until = NOW() WHERE id = true`;
    return NextResponse.json({ ok: true, replayed_matches: history.length, updated_agents: agents.length });
  } catch (error) {
    console.error("TrueSkill rebuild failed:", error);
    return NextResponse.json({ error: "Không thể dựng lại TrueSkill từ lịch sử." }, { status: 500 });
  }
}
