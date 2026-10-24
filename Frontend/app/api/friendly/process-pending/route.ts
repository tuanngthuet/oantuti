import {NextResponse} from 'next/server';
import {sql} from '@/lib/db';
import {getSession} from '@/lib/session';
import {enqueuePrivateTrial} from '@/lib/private-trials';
import {validId} from '@/lib/teams';
export async function POST(request:Request){
 const session=await getSession();if(!session)return NextResponse.json({error:'Chưa đăng nhập.'},{status:401});
 let body;try{body=await request.json();}catch{body={};}
 const id=validId(body?.match_id)?body.match_id:null;
 if(!id&&!session.is_admin)return NextResponse.json({error:'Cần ID trận hợp lệ.'},{status:400});
 const rows=await sql`SELECT id FROM friendly_matches WHERE pending_backend AND status='scheduled'
 AND can_read_trial(${session.id},id) AND (${id}::bigint IS NULL OR id=${id}) ORDER BY created_at LIMIT 50`;
 if(id&&!rows.length)return NextResponse.json({error:'Trận không tồn tại hoặc không pending.'},{status:404});
 let queued=0;for(const row of rows)if(await enqueuePrivateTrial(Number(row.id)).catch(()=>false))queued++;
 return NextResponse.json({ok:true,queued,errors:rows.length-queued});
}
