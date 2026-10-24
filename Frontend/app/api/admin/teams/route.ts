import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { sql } from '@/lib/db';
import { teamError } from '@/lib/teams';
export async function GET() {
  const session=await getSession();
  if (!session?.is_admin) return NextResponse.json({error:'Không có quyền.'},{status:403});
  try {
    const teams=await sql`SELECT t.id,t.name,t.status,u.username AS leader_username,t.created_at,
      (SELECT count(*)::int FROM team_members WHERE team_id=t.id) AS member_count,
      (SELECT count(*)::int FROM arena_agents WHERE team_id=t.id) AS agent_count
      FROM teams t JOIN users u ON u.id=t.creator_id ORDER BY t.created_at DESC LIMIT 200`;
    return NextResponse.json({teams});
  } catch(error) { return teamError(error); }
}
