import { NextResponse } from 'next/server';
import {getSession} from '@/lib/session';
import { sql } from '@/lib/db';
import { displayRating } from '@/lib/trueskill';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: 'ID không hợp lệ.' }, { status: 400 });
  const session=await getSession();
  try {
    const agents = await sql`SELECT id FROM arena_agents WHERE id = ${id} AND status = 'active' AND can_read_agent(${session?.id??null}::bigint,id)`;
    if (!agents.length) return NextResponse.json({ error: 'Agent không tồn tại.' }, { status: 404 });
    const points = await sql`
      SELECT id AS match_id, finished_at,
        CASE WHEN agent1_id = ${id} THEN agent1_mu_before ELSE agent2_mu_before END AS mu_before,
        CASE WHEN agent1_id = ${id} THEN agent1_sigma_before ELSE agent2_sigma_before END AS sigma_before,
        CASE WHEN agent1_id = ${id} THEN agent1_mu_after ELSE agent2_mu_after END AS mu_after,
        CASE WHEN agent1_id = ${id} THEN agent1_sigma_after ELSE agent2_sigma_after END AS sigma_after
      FROM rated_matches WHERE kind = 'rating' AND status = 'finished' AND NOT is_infra_error
        AND (agent1_id = ${id} OR agent2_id = ${id}) ORDER BY finished_at, id`;
    return NextResponse.json({ points: points.filter(p => [p.mu_before, p.sigma_before, p.mu_after, p.sigma_after].every(v => v !== null)).map(p => ({
      match_id: p.match_id, finished_at: p.finished_at,
      before: displayRating({ mu: Number(p.mu_before), sigma: Number(p.sigma_before) }),
      after: displayRating({ mu: Number(p.mu_after), sigma: Number(p.sigma_after) }),
    })) });
  } catch { return NextResponse.json({ error: 'Không thể tải lịch sử điểm.' }, { status: 500 }); }
}
