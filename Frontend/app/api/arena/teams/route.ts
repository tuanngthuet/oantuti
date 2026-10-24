import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { sql } from '@/lib/db';
import { positivePage } from '@/lib/leaderboard';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const page = positivePage(params.get('page'));
  const search = (params.get('search') ?? '').trim().slice(0,100);
  try {
    const session = await getSession();
    const actor = session?.id ?? null;
    const [teams, counts, own] = await Promise.all([
      sql`SELECT t.id,t.name,t.creator_id,t.recruiting,u.username AS leader_username,
        (SELECT count(*)::int FROM team_members WHERE team_id=t.id) AS member_count,
        COALESCE((SELECT json_agg(m ORDER BY m.id) FROM
          (SELECT u2.id,u2.username FROM team_members tm JOIN users u2 ON u2.id=tm.user_id WHERE tm.team_id=t.id) m),'[]'::json) AS members,
        (SELECT CASE WHEN r.status='pending' AND r.expires_at<=now() THEN 'expired' ELSE r.status END
          FROM team_join_requests r WHERE r.team_id=t.id AND r.requester_id=${actor}::bigint ORDER BY r.id DESC LIMIT 1) AS request_status,
        (SELECT r.id FROM team_join_requests r WHERE r.team_id=t.id AND r.requester_id=${actor}::bigint ORDER BY r.id DESC LIMIT 1) AS request_id
        FROM teams t JOIN users u ON u.id=t.creator_id
        WHERE t.status='active' AND (position(lower(${search}) in lower(t.name))>0
          OR position(lower(${search}) in lower(u.username))>0
          OR EXISTS(SELECT 1 FROM team_members tm JOIN users member ON member.id=tm.user_id
            WHERE tm.team_id=t.id AND position(lower(${search}) in lower(member.username))>0))
        ORDER BY t.recruiting DESC,t.id DESC LIMIT 20 OFFSET ${(page-1)*20}`,
      sql`SELECT count(*)::int AS total FROM teams t JOIN users u ON u.id=t.creator_id
        WHERE t.status='active' AND (position(lower(${search}) in lower(t.name))>0
          OR position(lower(${search}) in lower(u.username))>0
          OR EXISTS(SELECT 1 FROM team_members tm JOIN users member ON member.id=tm.user_id
            WHERE tm.team_id=t.id AND position(lower(${search}) in lower(member.username))>0))`,
      sql`SELECT current_team(${actor}::bigint) AS id`,
    ]);
    return NextResponse.json({teams,total:counts[0].total,page,authenticated:!!session,current_team_id:own[0].id});
  } catch(error) {
    console.error('Team directory failed',error);
    return NextResponse.json({error:'Không thể tải danh sách team.'},{status:500});
  }
}
