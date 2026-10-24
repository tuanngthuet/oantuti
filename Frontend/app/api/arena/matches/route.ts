import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

// Legacy arena matches are retained for replay only. TrueSkill rating updates
// are exclusively performed by /api/rating/match-result.
export async function POST() { return NextResponse.json({error:'API ghi trận cũ đã ngừng hoạt động.'},{status:410}); }

// GET: lịch sử trận đấu arena
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Bạn chưa đăng nhập." }, { status: 401 });
  }

  try {
    const rows = await sql`
      SELECT
        m.id,
        m.backend_match_id,
        m.status,
        m.total_moves,
        m.win_reason,
        m.played_at,
        a1.agent_name AS agent1_name,
        u1.username AS agent1_username,
        a2.agent_name AS agent2_name,
        u2.username AS agent2_username,
        w.agent_name AS winner_name
      FROM arena_matches m
      JOIN arena_agents a1 ON a1.id = m.agent1_id
      JOIN users u1 ON u1.id = a1.user_id
      JOIN arena_agents a2 ON a2.id = m.agent2_id
      JOIN users u2 ON u2.id = a2.user_id
      LEFT JOIN arena_agents w ON w.id = m.winner_agent_id
      WHERE a1.is_public AND a2.is_public
      ORDER BY m.played_at DESC
      LIMIT 50
    `;
    return NextResponse.json({ matches: rows });
  } catch (error) {
    console.error("Arena matches failed:", error);
    return NextResponse.json({ error: "Không thể tải lịch sử trận đấu." }, { status: 500 });
  }
}
