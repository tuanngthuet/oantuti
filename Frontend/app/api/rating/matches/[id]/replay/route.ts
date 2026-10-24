import { NextResponse } from "next/server";
import { sql, withRetry } from "@/lib/db";

export const runtime = "nodejs";

function buildInitialBoard() {
  const board: (null | { player: number; type: string })[][] = Array.from({ length: 9 }, () => Array(9).fill(null));
  const place = (player: number, type: string, position: string) => {
    const row = Number(position[0]) - 1;
    const col = position.charCodeAt(1) - 97;
    board[row][col] = { player, type };
  };
  for (const position of ["5c", "4d", "3e"]) place(1, "SCISSORS", position);
  for (const position of ["5b", "4c", "3d", "2e"]) place(1, "PAPER", position);
  for (const position of ["4b", "3c", "2d"]) place(1, "ROCK", position);
  for (const position of ["7e", "6f", "5g"]) place(2, "SCISSORS", position);
  for (const position of ["8e", "7f", "6g", "5h"]) place(2, "PAPER", position);
  for (const position of ["8f", "7g", "6h"]) place(2, "ROCK", position);
  return board;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const matchId = Number(id);
  if (!Number.isSafeInteger(matchId) || matchId < 1) return NextResponse.json({ error: "ID không hợp lệ." }, { status: 400 });

  try {
    const matches = await withRetry(() => sql`
      SELECT m.id, m.status, m.outcome, CASE WHEN m.is_infra_error THEN 'Lỗi hạ tầng' ELSE m.win_reason END AS win_reason, m.total_moves, m.is_infra_error,
        m.rating_delta_agent1 AS elo_delta_agent1, m.rating_delta_agent2 AS elo_delta_agent2,
        m.finished_at,
        a1.id AS agent1_id, a1.agent_name AS agent1_name, COALESCE(t1.name, u1.username) AS agent1_username,
        a2.id AS agent2_id, a2.agent_name AS agent2_name, COALESCE(t2.name, u2.username) AS agent2_username,
        winner.agent_name AS winner_name, NULL::text AS session_name
      FROM rated_matches m
      JOIN arena_agents a1 ON a1.id = m.agent1_id
      JOIN users u1 ON u1.id = a1.user_id
      LEFT JOIN teams t1 ON t1.id = a1.team_id
      JOIN arena_agents a2 ON a2.id = m.agent2_id
      JOIN users u2 ON u2.id = a2.user_id
      LEFT JOIN teams t2 ON t2.id = a2.team_id
      LEFT JOIN arena_agents winner ON winner.id = m.winner_agent_id
      WHERE m.id = ${matchId} AND m.kind = 'rating' AND a1.is_public AND a2.is_public
    `);
    if (matches.length === 0) return NextResponse.json({ error: "Trận không tồn tại." }, { status: 404 });
    if (matches[0].status !== 'finished' || matches[0].is_infra_error)
      return NextResponse.json({ error: 'Trận chưa hoàn thành hoặc không có replay hợp lệ.' }, { status: 409 });

    const moves = await withRetry(() => sql`
      SELECT move_number, player, from_col, from_row, to_col, to_row,
        from_pos, to_pos, piece_type, captured_type
      FROM rated_match_move_history
      WHERE rated_match_id = ${matchId}
      ORDER BY move_number ASC
    `);
    if (!moves.length) return NextResponse.json({ error: 'Trận này không có dữ liệu replay.' }, { status: 409 });
    return NextResponse.json(
      { match: matches[0], moves, initial_board: buildInitialBoard() },
      { headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400" } },
    );
  } catch (error) {
    console.error("Rating replay fetch failed:", error);
    return NextResponse.json({ error: "Không thể tải replay." }, { status: 500 });
  }
}
