import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import {getSession} from '@/lib/session';
import { positivePage } from '@/lib/leaderboard';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const query = new URL(request.url).searchParams;
  const page = positivePage(query.get('page'));
  const filter = query.get('result') ?? 'all';
  const matchId = query.has('matchId') ? Number(query.get('matchId')) : null;
  if (!Number.isSafeInteger(id) || id < 1 || (matchId !== null && (!Number.isSafeInteger(matchId) || matchId < 1))
    || !['all', 'win', 'loss', 'draw', 'error', 'scheduled', 'running', 'cancelled'].includes(filter))
    return NextResponse.json({ error: 'Tham số không hợp lệ.' }, { status: 400 });
  const session=await getSession();
  try {
    const agents = await sql`SELECT a.id,a.agent_name,a.version,a.rating AS elo,a.is_active,
      agent_scope_active(a.id) AS scope_active,a.team_id,COALESCE((SELECT name FROM teams WHERE id=a.team_id),u.username) AS username
      FROM arena_agents a JOIN users u ON u.id = a.user_id WHERE a.id = ${id} AND a.status = 'active' AND can_read_agent(${session?.id??null}::bigint,a.id)`;
    if (!agents.length) return NextResponse.json({ error: 'Agent không tồn tại.' }, { status: 404 });
    if (matchId !== null) {
      const selected = await sql`SELECT id FROM rated_matches WHERE id = ${matchId} AND kind = 'rating'
        AND (agent1_id = ${id} OR agent2_id = ${id})`;
      if (!selected.length) return NextResponse.json({ error: 'Trận không thuộc agent này.' }, { status: 404 });
    }
    const rows = await sql`
      WITH history AS (
        SELECT m.id, m.status, m.outcome, m.total_moves, m.is_infra_error,
          m.scheduled_at, m.finished_at,
          m.rating_delta_agent1 AS elo_delta_agent1, m.rating_delta_agent2 AS elo_delta_agent2,
          a1.id AS agent1_id, a1.agent_name AS agent1_name, COALESCE(t1.name, u1.username) AS agent1_username,
          a2.id AS agent2_id, a2.agent_name AS agent2_name, COALESCE(t2.name, u2.username) AS agent2_username,
          CASE WHEN m.is_infra_error OR m.status = 'error' THEN 'error'
            WHEN m.status <> 'finished' THEN m.status WHEN m.outcome = 'draw' THEN 'draw'
            WHEN m.outcome IS NULL THEN 'unknown'
            WHEN (m.outcome = 'agent1') = (m.agent1_id = ${id}) THEN 'win' ELSE 'loss' END AS result,
          (m.status = 'finished' AND NOT m.is_infra_error AND EXISTS
            (SELECT 1 FROM rated_match_move_history h WHERE h.rated_match_id = m.id)) AS replay_available
        FROM rated_matches m
        JOIN arena_agents a1 ON a1.id = m.agent1_id JOIN users u1 ON u1.id = a1.user_id LEFT JOIN teams t1 ON t1.id = a1.team_id
        JOIN arena_agents a2 ON a2.id = m.agent2_id JOIN users u2 ON u2.id = a2.user_id LEFT JOIN teams t2 ON t2.id = a2.team_id
        WHERE m.kind = 'rating' AND (m.agent1_id = ${id} OR m.agent2_id = ${id})
      ), filtered AS (SELECT * FROM history WHERE ${filter} = 'all' OR result = ${filter})
      SELECT (SELECT COUNT(*)::int FROM filtered) AS total,
        COALESCE((SELECT json_agg(p) FROM (SELECT * FROM filtered ORDER BY scheduled_at DESC, id DESC
          LIMIT 20 OFFSET ${(page - 1) * 20}) p), '[]'::json) AS matches,
        (SELECT row_to_json(h) FROM history h WHERE (${matchId}::bigint IS NULL AND replay_available)
          OR id = ${matchId} ORDER BY scheduled_at DESC, id DESC LIMIT 1) AS selected
    `;
    return NextResponse.json({ agent: agents[0], ...rows[0], page, limit: 20 });
  } catch (error) {
    console.error('Agent history failed', error);
    return NextResponse.json({ error: 'Không thể tải lịch sử trận đấu.' }, { status: 500 });
  }
}
