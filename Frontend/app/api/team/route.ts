import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { sql } from '@/lib/db';
import { isObject,validId,teamError } from '@/lib/teams';
export const dynamic='force-dynamic';
export async function GET() {
  const session=await getSession();
  if (!session) return NextResponse.json({error:'Chưa đăng nhập.'},{status:401});
  try {
    const teams=await sql`SELECT t.*,t.creator_id=${session.id}::bigint AS is_leader,
      (SELECT json_agg(m ORDER BY m.joined_at,m.id) FROM
        (SELECT u.id,u.username,tm.joined_at FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=t.id) m) AS members
      FROM teams t WHERE t.id=current_team(${session.id})`;
    const received=await sql`SELECT i.id,i.team_id,t.name,u.username AS leader_username,
      CASE WHEN i.status='pending' AND i.expires_at<=now() THEN 'expired' ELSE i.status END AS status,i.expires_at
      FROM team_invitations i JOIN teams t ON t.id=i.team_id JOIN users u ON u.id=t.creator_id
      WHERE i.recipient_id=${session.id} ORDER BY i.created_at DESC LIMIT 50`;
    const sent=await sql`SELECT i.id,u.username,
      CASE WHEN i.status='pending' AND i.expires_at<=now() THEN 'expired' ELSE i.status END AS status,i.expires_at
      FROM team_invitations i JOIN users u ON u.id=i.recipient_id
      WHERE i.team_id=current_team(${session.id}) ORDER BY i.created_at DESC LIMIT 50`;
    const join_requests_received=await sql`SELECT r.id,r.team_id,u.username,
      CASE WHEN r.status='pending' AND r.expires_at<=now() THEN 'expired' ELSE r.status END AS status,r.expires_at
      FROM team_join_requests r JOIN teams t ON t.id=r.team_id JOIN users u ON u.id=r.requester_id
      WHERE t.id=current_team(${session.id}) AND t.creator_id=${session.id}
      ORDER BY r.created_at DESC,r.id DESC LIMIT 50`;
    const join_requests_sent=await sql`SELECT r.id,r.team_id,t.name,
      CASE WHEN r.status='pending' AND r.expires_at<=now() THEN 'expired' ELSE r.status END AS status,r.expires_at
      FROM team_join_requests r JOIN teams t ON t.id=r.team_id WHERE r.requester_id=${session.id}
      ORDER BY r.created_at DESC,r.id DESC LIMIT 50`;
    return NextResponse.json({user_id:session.id,is_admin:session.is_admin,team:teams[0]??null,received,sent,join_requests_received,join_requests_sent});
  } catch(error) { return teamError(error); }
}
export async function POST(request: Request) {
  const session=await getSession();
  if (!session) return NextResponse.json({error:'Chưa đăng nhập.'},{status:401});
  let body:unknown; try { body=await request.json(); } catch { return NextResponse.json({error:'Dữ liệu không hợp lệ.'},{status:400}); }
  if (!isObject(body) || typeof body.action!=='string' || !['create','update','invite','accept','decline','cancel','leave','remove','archive','request_join','approve_join','decline_join','cancel_join'].includes(body.action))
    return NextResponse.json({error:'Thao tác không hợp lệ.'},{status:400});
  const action=body.action;
  if ((['create','update'].includes(action) && (typeof body.name!=='string' || [...body.name.trim()].length<1 || [...body.name.trim()].length>30))
    || (body.recruiting!==undefined && typeof body.recruiting!=='boolean')
    || (action==='invite' && (typeof body.username!=='string' || !/^[a-zA-Z0-9_]{3,32}$/.test(body.username)))
    || (['accept','decline','cancel'].includes(action) && !validId(body.invitation_id))
    || (action==='remove' && !validId(body.user_id)) || (['archive','request_join'].includes(action) && !validId(body.team_id))
    || (['approve_join','decline_join','cancel_join'].includes(action) && !validId(body.request_id)))
    return NextResponse.json({error:'Tham số team không hợp lệ.'},{status:400});
  if (action==='archive' && !session.is_admin) return NextResponse.json({error:'Chỉ admin được giải thể team.'},{status:403});
  try {
    if (['request_join','approve_join','decline_join','cancel_join'].includes(action)) {
      const rows=await sql`SELECT manage_team_join_request(${session.id},${action},${JSON.stringify(body)}::jsonb) AS result`;
      return NextResponse.json(rows[0].result);
    }
    const rows=await sql`SELECT manage_team(${session.id},${action},${JSON.stringify(body)}::jsonb) AS result`;
    return NextResponse.json(rows[0].result);
  } catch(error) { return teamError(error); }
}
