import {NextResponse} from 'next/server';
import {sql} from '@/lib/db';
import {getSession} from '@/lib/session';
import {isObject,validId,teamError} from '@/lib/teams';
import {enqueuePrivateTrial} from '@/lib/private-trials';
export const runtime='nodejs';
export async function GET(request:Request){
 const session=await getSession();if(!session)return NextResponse.json({error:'Chưa đăng nhập.'},{status:401});
 const raw=Number(new URL(request.url).searchParams.get('page')||1);
 const page=Number.isSafeInteger(raw)&&raw>0?raw:1;
 try{
 const matches=await sql`SELECT f.id,f.status,f.outcome,
 CASE WHEN f.is_infra_error THEN 'Lỗi hạ tầng' WHEN f.win_reason LIKE 'Agent P% lỗi:%' THEN 'Agent gặp lỗi thực thi'
 WHEN f.win_reason LIKE 'Agent P% nước không hợp lệ:%' THEN 'Agent trả nước không hợp lệ' ELSE f.win_reason END AS win_reason,
 f.total_moves,f.is_infra_error,f.pending_backend,f.created_at,f.finished_at,
 f.agent1_id,f.agent2_id,f.trial_agent_id,a.agent_name AS agent1_name,b.agent_name AS agent2_name,w.agent_name AS winner_name
 FROM friendly_matches f JOIN arena_agents a ON a.id=f.agent1_id JOIN arena_agents b ON b.id=f.agent2_id
 LEFT JOIN arena_agents w ON w.id=f.winner_agent_id WHERE can_read_trial(${session.id},f.id)
 ORDER BY f.created_at DESC,f.id DESC LIMIT 20 OFFSET ${(page-1)*20}`;
 const quota=await sql`SELECT trial_quota(${session.id}) AS quota`;
 return NextResponse.json({matches,page,quota:quota[0].quota});
 }catch(error){return teamError(error);}
}
export async function POST(request:Request){
 const session=await getSession();if(!session)return NextResponse.json({error:'Chưa đăng nhập.'},{status:401});
 let body:unknown;try{body=await request.json();}catch{return NextResponse.json({error:'Dữ liệu không hợp lệ.'},{status:400});}
 if(!isObject(body)||!validId(body.agent1_id)||!validId(body.agent2_id)||typeof body.request_id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_id))
 return NextResponse.json({error:'Cần hai agent và mã yêu cầu UUID hợp lệ.'},{status:400});
 try{
 const rows=await sql`SELECT create_private_trial(${session.id},${body.agent1_id},${body.agent2_id},${body.request_id}::uuid) AS result`;
 const result=rows[0].result;
 const queued=await enqueuePrivateTrial(Number(result.id)).catch(()=>false);
 return NextResponse.json({ok:true,friendly_match_id:result.id,reused:result.reused,quota:result.quota,queued,
 message:queued?'Đã xếp trận thách đấu vào queue.':'Trận đã được lưu; gửi lại cùng mã yêu cầu sẽ không trừ thêm lượt.'});
 }catch(error){return teamError(error);}
}
