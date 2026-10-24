import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

/**
 * GET /api/admin/agents?status=pending
 * Lists all agents (admin only), optionally filtered by status.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.is_admin) {
    return NextResponse.json({ error: "Không có quyền." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");

  const validStatuses = ["pending", "validating", "active", "rejected"];

  try {
    const rows = status && validStatuses.includes(status)
      ? await sql`
          SELECT
            a.id, a.agent_name, a.description, a.code, a.version,
            a.status, a.validation_error, a.is_active,
            a.wins, a.losses, a.draws, a.error_matches, a.rating AS elo,
            a.trueskill_mu, a.trueskill_sigma,
            a.submitted_at, a.user_id,
            u.username
          FROM arena_agents a
          JOIN users u ON u.id = a.user_id
          WHERE a.status = ${status}
          ORDER BY a.submitted_at DESC
          LIMIT 200
        `
      : await sql`
          SELECT
            a.id, a.agent_name, a.description, a.code, a.version,
            a.status, a.validation_error, a.is_active,
            a.wins, a.losses, a.draws, a.error_matches, a.rating AS elo,
            a.trueskill_mu, a.trueskill_sigma,
            a.submitted_at, a.user_id,
            u.username
          FROM arena_agents a
          JOIN users u ON u.id = a.user_id
          ORDER BY a.submitted_at DESC
          LIMIT 200
        `;

    return NextResponse.json({ agents: rows });
  } catch (error) {
    console.error("Admin agents list failed:", error);
    return NextResponse.json(
      { error: "Không thể tải danh sách agent." },
      { status: 500 },
    );
  }
}
