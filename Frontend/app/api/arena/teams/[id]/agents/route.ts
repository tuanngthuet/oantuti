import { NextResponse } from 'next/server';
import { publicAgents } from '@/lib/leaderboard-data';
import { compareAgents } from '@/lib/leaderboard';
export const dynamic='force-dynamic';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
  const id=Number((await params).id);
  if(!Number.isSafeInteger(id)||id<1)return NextResponse.json({error:'ID không hợp lệ.'},{status:400});
  try{return NextResponse.json({agents:(await publicAgents()).filter(a=>Number(a.team_id)===id).sort(compareAgents)});}
  catch{return NextResponse.json({error:'Không thể tải agents của team.'},{status:500});}
}
