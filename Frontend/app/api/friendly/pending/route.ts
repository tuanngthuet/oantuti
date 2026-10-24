import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

/**
 * GET /api/friendly/pending
 *
 * Lấy danh sách các friendly_matches đang chờ backend xử lý.
 * Dùng bởi process-pending worker.
 *
 * Chỉ admin hoặc internal call (với header X-Internal-Key) mới được dùng.
 * Người dùng thường cũng có thể gọi để xem trận pending của mình.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  // mine=true: chỉ lấy trận của mình
  const mine = searchParams.get("mine") === "true";

  try {
    let rows: unknown[];

    if (mine) {
      // User thường: chỉ xem trận pending của mình
      rows = await sql`
        SELECT
          fm.id::int,
          fm.status,
          fm.pending_backend,
          fm.created_at,
          a1.id::int AS agent1_id,
          a1.agent_name AS agent1_name,
          u1.username AS agent1_username,
          a2.id::int AS agent2_id,
          a2.agent_name AS agent2_name,
          u2.username AS agent2_username,
          uc.username AS challenger_username,
          uo.username AS opponent_username
        FROM friendly_matches fm
        JOIN arena_agents a1 ON a1.id = fm.agent1_id
        JOIN users u1 ON u1.id = a1.user_id
        JOIN arena_agents a2 ON a2.id = fm.agent2_id
        JOIN users u2 ON u2.id = a2.user_id
        LEFT JOIN users uc ON uc.id = fm.challenger_id
        LEFT JOIN users uo ON uo.id = fm.opponent_id
        WHERE fm.pending_backend = true
          AND fm.status = 'scheduled'
          AND can_read_trial(${session.id},fm.id)
        ORDER BY fm.created_at ASC
        LIMIT 50
      `;
    } else {
      // Admin: xem tất cả
      if (!session.is_admin) {
        return NextResponse.json({ error: "Không có quyền." }, { status: 403 });
      }
      rows = await sql`
        SELECT
          fm.id::int,
          fm.status,
          fm.pending_backend,
          fm.created_at,
          a1.id::int AS agent1_id,
          a1.agent_name AS agent1_name,
          a1.code AS agent1_code,
          u1.username AS agent1_username,
          a2.id::int AS agent2_id,
          a2.agent_name AS agent2_name,
          a2.code AS agent2_code,
          u2.username AS agent2_username
        FROM friendly_matches fm
        JOIN arena_agents a1 ON a1.id = fm.agent1_id
        JOIN users u1 ON u1.id = a1.user_id
        JOIN arena_agents a2 ON a2.id = fm.agent2_id
        JOIN users u2 ON u2.id = a2.user_id
        WHERE fm.pending_backend = true
          AND fm.status = 'scheduled'
        ORDER BY fm.created_at ASC
        LIMIT 100
      `;
    }

    return NextResponse.json({ pending_matches: rows, count: (rows as unknown[]).length });
  } catch (error) {
    console.error("List pending failed:", error);
    return NextResponse.json({ error: "Không thể tải danh sách trận chờ." }, { status: 500 });
  }
}
