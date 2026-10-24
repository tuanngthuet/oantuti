import {NextResponse} from 'next/server';
import {getSession} from '@/lib/session';
import {finalsQuery} from '@/lib/finals-db';
import {finalsError,validFinalsId} from '@/lib/finals';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const user=await getSession();if(!user)return NextResponse.json({rounds:[]},{headers:{'Cache-Control':'no-store'}});
 const id=Number(new URL(request.url).searchParams.get('edition_id'));if(!validFinalsId(id))return NextResponse.json({error:'ID không hợp lệ.'},{status:400});
 try{
  const rounds=await finalsQuery(`SELECT c.*,CASE WHEN e.status IN('finished','cancelled') THEN 'closed' ELSE c.status END AS status,re.seed,re.submission_id AS locked_submission_id,s.id AS latest_id,s.name,s.code,s.created_at,j.status AS validation_status,j.error AS validation_error
   FROM ck_round_entrants re JOIN ck_rounds c USING(edition_id,round) JOIN editions e ON e.id=c.edition_id
   LEFT JOIN LATERAL(SELECT * FROM ck_submissions sub WHERE sub.edition_id=c.edition_id AND sub.round=c.round AND sub.seed=re.seed AND sub.generation=c.generation ORDER BY sub.id DESC LIMIT 1) s ON true
   LEFT JOIN ck_jobs j ON j.submission_id=s.id
   WHERE c.edition_id=$1 AND ck_can_submit($2,c.edition_id,re.seed) ORDER BY c.round,re.seed`,[id,user.id]);
  return NextResponse.json({rounds},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return finalsError(error);}
}
export async function POST(request:Request){
 const user=await getSession();if(!user)return NextResponse.json({error:'Chưa đăng nhập.'},{status:401});
 try{
  const raw=await request.text();if(Buffer.byteLength(raw)>2097152)return NextResponse.json({error:'Tối đa 2 MB.'},{status:413});
  let b;try{b=JSON.parse(raw);}catch{return NextResponse.json({error:'JSON không hợp lệ.'},{status:400});}
  if(!b||!validFinalsId(b.edition_id)||!validFinalsId(b.generation)||!Number.isInteger(b.round)||b.round<1||b.round>5||!Number.isInteger(b.seed)||b.seed<1||b.seed>16||typeof b.name!=='string'||!b.name.trim()||b.name.trim().length>100||typeof b.code!=='string'||!b.code.trim()||Buffer.byteLength(b.code)>1048576)return NextResponse.json({error:'Cần tên và code Python (tối đa 1 MB), đúng giải/vòng/suất.'},{status:400});
  const rows=await finalsQuery('SELECT ck_submit($1,$2,$3,$4,$5,$6,$7) AS id',[user.id,b.edition_id,b.round,b.seed,b.name,b.code,b.generation]);
  return NextResponse.json({ok:true,id:rows[0].id},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return finalsError(error);}
}
