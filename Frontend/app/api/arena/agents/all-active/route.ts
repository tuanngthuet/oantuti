import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

/**
 * GET /api/arena/agents/all-active
 * Returns all active agents (from all users) for the friendly match selector.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });

  try {
    const rows = await sql`
      SELECT
        a.id,
        a.agent_name,
        a.rating AS elo,
        a.status,
        a.user_id,
        COALESCE(t.name,u.username) AS username,a.team_id,
        can_use_agent(${session.id},a.id) AS can_use
      FROM arena_agents a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN teams t ON t.id=a.team_id
      WHERE a.status = 'active' AND a.is_active AND agent_scope_active(a.id) AND (a.is_public OR can_use_agent(${session.id},a.id))
      ORDER BY u.username ASC, a.rating DESC
    `;
    return NextResponse.json({ agents: rows,current_user_id:session.id });
  } catch (error) {
    console.error("Fetch all-active agents failed:", error);
    return NextResponse.json({ error: "Không thể tải danh sách agent." }, { status: 500 });
  }
}
