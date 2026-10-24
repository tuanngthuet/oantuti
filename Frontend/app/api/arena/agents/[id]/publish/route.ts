import {NextResponse} from 'next/server';
import {getSession} from '@/lib/session';
import {sql} from '@/lib/db';
import {teamError} from '@/lib/teams';
import {dispatchNextRatingTask} from '@/lib/rating-scheduler';
export async function POST(_request:Request,{params}:{params:Promise<{id:string}>}) {
 const session=await getSession(); if(!session)return NextResponse.json({error:'Chưa đăng nhập.'},{status:401});
 const id=Number((await params).id);if(!Number.isSafeInteger(id)||id<=0)return NextResponse.json({error:'ID không hợp lệ.'},{status:400});
 try {const rows=await sql`SELECT publish_agent(${session.id},${id}) AS result`;
  await dispatchNextRatingTask().catch(()=>{});return NextResponse.json(rows[0].result);
 }catch(error){return teamError(error);}
}
