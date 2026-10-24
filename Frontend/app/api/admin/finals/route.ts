import {cleanDisplay} from '@/lib/finals-display';
import {NextResponse} from 'next/server';
import {getSession} from '@/lib/session';
import {finalsQuery,snapshotFinals} from '@/lib/finals-db';
import {editionData,finalsError,validFinalsId,cleanRecord} from '@/lib/finals';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const session=await getSession();if(!session?.is_admin)return NextResponse.json({error:'Không có quyền.'},{status:403});
 const id=Number(new URL(request.url).searchParams.get('id'));
 if(!validFinalsId(id))return NextResponse.json({error:'ID không hợp lệ.'},{status:400});
 try{const data=await editionData(id,true);return NextResponse.json(data??{error:'Không tìm thấy giải.'},{status:data?200:404});}catch(error){return finalsError(error);}
}
export async function POST(request:Request){
 const session=await getSession();if(!session?.is_admin)return NextResponse.json({error:'Không có quyền.'},{status:403});
 if(Number(request.headers.get('content-length'))>5242880)return NextResponse.json({error:'Tối đa 5 MB.'},{status:413});
 let body;try{const raw=await request.text();if(Buffer.byteLength(raw,'utf8')>5242880)return NextResponse.json({error:'Tối đa 5 MB.'},{status:413});body=JSON.parse(raw);}catch{return NextResponse.json({error:'JSON không hợp lệ.'},{status:400});}
 if(!body||typeof body!=='object'||Array.isArray(body))return NextResponse.json({error:'Dữ liệu không hợp lệ.'},{status:400});
 try{
  if(body.action==='create'){
   if(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>100||typeof body.request_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_id))return NextResponse.json({error:'Cần tên giải và request_id UUID hợp lệ.'},{status:400});
   const id=await snapshotFinals(session.id,body.name.trim(),body.request_id);return NextResponse.json({ok:true,edition_id:id});
  }
  if(!validFinalsId(body.edition_id)||!validFinalsId(body.revision)||!['open_submissions','lock_round','lock_rules','cancel','open_round','confirm_pair','publish','retry','adjudicate','import','interrupt'].includes(body.action))return NextResponse.json({error:'Thao tác không hợp lệ.'},{status:400});
  const payload={...body};delete payload.action;delete payload.edition_id;delete payload.revision;
  if(payload.reason!==undefined&&(typeof payload.reason!=='string'||payload.reason.length>2000))return NextResponse.json({error:'Lý do tối đa 2000 ký tự.'},{status:400});
  if(body.action==='import'){payload.moves=cleanRecord(body.moves);if(body.initial_state!==undefined)payload.initial_state=cleanDisplay(body.initial_state);}
  const rows=await finalsQuery('SELECT admin_action($1,$2,$3,$4,$5::jsonb) AS result',[session.id,body.edition_id,body.revision,body.action,JSON.stringify(payload)]);
  return NextResponse.json(rows[0].result);
 }catch(error){return finalsError(error);}
}
