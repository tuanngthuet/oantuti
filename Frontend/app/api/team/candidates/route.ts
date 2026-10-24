import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { sql } from '@/lib/db';
import { teamError } from '@/lib/teams';
export async function GET(request: Request) {
  const session=await getSession();
  if (!session) return NextResponse.json({error:'Chưa đăng nhập.'},{status:401});
  const search=(new URL(request.url).searchParams.get('search')??'').trim().slice(0,32);
  try {
    const leader=await sql`SELECT id FROM teams WHERE id=current_team(${session.id}) AND creator_id=${session.id} AND status='active'`;
    if (!leader.length) return NextResponse.json({error:'Chỉ trưởng đội được tìm người để mời.'},{status:403});
    if (!search) return NextResponse.json({users:[]});
    const users=await sql`SELECT id,username FROM users WHERE id<>${session.id} AND current_team(id) IS NULL
      AND position(lower(${search}) in lower(username))>0 ORDER BY username LIMIT 20`;
    return NextResponse.json({users});
  } catch(error) { return teamError(error); }
}
