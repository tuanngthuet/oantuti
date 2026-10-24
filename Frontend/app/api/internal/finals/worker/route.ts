import {NextResponse} from 'next/server';
import {workerRound,workerAction} from '@/lib/finals-workers';
import {finalsError} from '@/lib/finals';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 try{
  const round=workerRound(request.headers.get('authorization'));
  if(!round)return NextResponse.json({error:'Không có quyền.'},{status:403});
  const raw=await request.text();if(Buffer.byteLength(raw)>2097152)return NextResponse.json({error:'Tối đa 2 MB.'},{status:413});
  let body;try{body=JSON.parse(raw);}catch{return NextResponse.json({error:'JSON không hợp lệ.'},{status:400});}
  if(!body||typeof body!=='object'||Array.isArray(body))return NextResponse.json({error:'Dữ liệu không hợp lệ.'},{status:400});
  return NextResponse.json({result:await workerAction(round,body)},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return finalsError(error);}
}
