import { NextResponse } from "next/server";
import { sql, withRetry } from "@/lib/db";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

function buildInitialBoard() {
  const board: (null | { player: number; type: string })[][] = Array.from({ length: 9 }, () => Array(9).fill(null));
  function place(player: number, type: string, jsPos: string) {
    let col = -1, row = -1;
    for (const ch of jsPos) {
      if (isNaN(Number(ch))) col = ch.charCodeAt(0) - 97;
      else row = parseInt(ch) - 1;
    }
    if (col >= 0 && row >= 0) board[row][col] = { player, type };
  }
  for (const p of ["5c","4d","3e"]) place(1, "SCISSORS", p);
  for (const p of ["5b","4c","3d","2e"]) place(1, "PAPER", p);
  for (const p of ["4b","3c","2d"]) place(1, "ROCK", p);
  for (const p of ["7e","6f","5g"]) place(2, "SCISSORS", p);
  for (const p of ["8e","7f","6g","5h"]) place(2, "PAPER", p);
  for (const p of ["8f","7g","6h"]) place(2, "ROCK", p);
  return board;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });

  const { id } = await params;
  const matchId = parseInt(id, 10);
  if (isNaN(matchId)) return NextResponse.json({ error: "ID không hợp lệ." }, { status: 400 });

  try {
    const matchRows = await withRetry(() => sql`
      SELECT
        fm.id, fm.status, fm.outcome, CASE WHEN fm.is_infra_error THEN 'Lỗi hạ tầng'
          WHEN fm.win_reason LIKE 'Agent P% lỗi:%' THEN 'Agent gặp lỗi thực thi'
          WHEN fm.win_reason LIKE 'Agent P% nước không hợp lệ:%' THEN 'Agent trả nước không hợp lệ' ELSE fm.win_reason END AS win_reason, fm.total_moves,
        fm.is_infra_error, fm.created_at, fm.finished_at,
        a1.id AS agent1_id, a1.agent_name AS agent1_name, (SELECT COALESCE((SELECT name FROM teams WHERE id=a1.team_id),u1.username)) AS agent1_username,
        a2.id AS agent2_id, a2.agent_name AS agent2_name, (SELECT COALESCE((SELECT name FROM teams WHERE id=a2.team_id),u2.username)) AS agent2_username,
        w.agent_name AS winner_name
      FROM friendly_matches fm
      JOIN arena_agents a1 ON a1.id = fm.agent1_id
      JOIN users u1 ON u1.id = a1.user_id
      JOIN arena_agents a2 ON a2.id = fm.agent2_id
      JOIN users u2 ON u2.id = a2.user_id
      LEFT JOIN arena_agents w ON w.id = fm.winner_agent_id
      WHERE fm.id = ${matchId} AND can_read_trial(${session.id},fm.id)
    `);
    if (matchRows.length === 0) return NextResponse.json({ error: "Trận không tồn tại." }, { status: 404 });

    const moveRows = await withRetry(() => sql`
      SELECT move_number, player, from_col, from_row, to_col, to_row,
             from_pos, to_pos, piece_type, captured_type
      FROM friendly_match_history
      WHERE friendly_match_id = ${matchId}
      ORDER BY move_number ASC
    `);

    return NextResponse.json({ match: matchRows[0], moves: moveRows, initial_board: buildInitialBoard() });
  } catch (error) {
    console.error("Friendly replay failed:", error);
    return NextResponse.json({ error: "Không thể tải replay." }, { status: 500 });
  }
}
