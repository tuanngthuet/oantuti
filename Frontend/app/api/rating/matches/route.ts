import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { positivePage } from '@/lib/leaderboard';

export const runtime = "nodejs";

export async function GET(request: Request) {
  const page = positivePage(new URL(request.url).searchParams.get('page'));
  const offset = (page - 1) * 20;
  try {
    const matches = await sql`
      SELECT m.id, m.kind, m.status, m.outcome, CASE WHEN m.is_infra_error THEN 'Lỗi hạ tầng' ELSE m.win_reason END AS win_reason, m.total_moves, m.is_infra_error,
        m.rating_delta_agent1 AS elo_delta_agent1, m.rating_delta_agent2 AS elo_delta_agent2,
        m.scheduled_at, m.started_at, m.finished_at,
        a1.id AS agent1_id, a1.agent_name AS agent1_name, COALESCE(t1.name, u1.username) AS agent1_username,
        a2.id AS agent2_id, a2.agent_name AS agent2_name, COALESCE(t2.name, u2.username) AS agent2_username,
        w.agent_name AS winner_name, NULL::text AS session_name
      FROM rated_matches m
      JOIN arena_agents a1 ON a1.id = m.agent1_id
      JOIN users u1 ON u1.id = a1.user_id
      LEFT JOIN teams t1 ON t1.id = a1.team_id
      JOIN arena_agents a2 ON a2.id = m.agent2_id
      JOIN users u2 ON u2.id = a2.user_id
      LEFT JOIN teams t2 ON t2.id = a2.team_id
      LEFT JOIN arena_agents w ON w.id = m.winner_agent_id
      WHERE m.kind = 'rating' AND a1.is_public AND a2.is_public
      ORDER BY m.scheduled_at DESC
      LIMIT 20 OFFSET ${offset}
    `;
    return NextResponse.json({ matches, page, limit: 20 });
  } catch (error) {
    console.error("Rating matches list failed:", error);
    return NextResponse.json({ error: "Không thể tải lịch sử rating." }, { status: 500 });
  }
}
