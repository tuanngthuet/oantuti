import {NextResponse} from 'next/server';
import {getSession} from '@/lib/session';
import {finalsQuery} from '@/lib/finals-db';
import {finalsError} from '@/lib/finals';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await getSession();if(!user?.is_admin)return NextResponse.json({error:'Không có quyền.'},{status:403});
 const id=Number((await params).id);if(!Number.isSafeInteger(id)||id<1)return NextResponse.json({error:'ID không hợp lệ.'},{status:400});
 try{
  const editions=await finalsQuery('SELECT id,name,rules,rules_locked_at FROM editions WHERE id=$1',[id]);
  if(!editions.length)return NextResponse.json({error:'Không tìm thấy giải.'},{status:404});
  const upgraded=(await finalsQuery("SELECT to_regclass('ck_rounds') IS NOT NULL AS present"))[0].present;
  if(upgraded){
   const rounds=await finalsQuery(`SELECT c.*,eng.version AS engine_version FROM ck_rounds c JOIN ck_engines eng ON eng.round=c.round AND eng.digest=c.engine_digest WHERE c.edition_id=$1 AND c.status IN('locked','running') ORDER BY c.round`,[id]);
   if(!rounds.length)return NextResponse.json({error:'Khóa bài ít nhất một vòng trước khi xuất bundle.'},{status:409});
   const entrants=await finalsQuery(`SELECT re.round,re.seed,s.id,s.name,s.code,s.code_hash FROM ck_round_entrants re JOIN ck_submissions s ON s.id=re.submission_id WHERE re.edition_id=$1 ORDER BY re.round,re.seed`,[id]);
   const games=await finalsQuery('SELECT g.id,g.seed1,g.seed2,g.leg,g.engine_digest,g.round_rules,p.round FROM games g JOIN pairs p ON p.id=g.pair_id WHERE p.edition_id=$1 AND g.engine_digest IS NOT NULL ORDER BY g.id',[id]);
   await finalsQuery("INSERT INTO audit(edition_id,actor,action,payload) VALUES($1,$2,'export_bundle','{}')",[id,user.id]);
   return NextResponse.json({format:'ott-finals-bundle-v2',edition:{id,name:editions[0].name},rounds,entrants,games},{headers:{'Cache-Control':'no-store','Content-Disposition':`attachment; filename="finals-${id}.bundle.json"`}});
  }
  if(!editions[0].rules_locked_at)return NextResponse.json({error:'Khóa luật trước khi xuất bundle.'},{status:409});
  const entrants=await finalsQuery('SELECT * FROM entrants WHERE edition_id=$1 ORDER BY seed',[id]);
  const games=await finalsQuery('SELECT g.id,g.seed1,g.seed2,g.leg FROM games g JOIN pairs p ON p.id=g.pair_id WHERE p.edition_id=$1 ORDER BY g.id',[id]);
  await finalsQuery("INSERT INTO audit(edition_id,actor,action,payload) VALUES($1,$2,'export_bundle','{}')",[id,user.id]);
  return NextResponse.json({format:'ott-finals-bundle-v1',edition:editions[0],entrants,games},{headers:{'Cache-Control':'no-store','Content-Disposition':`attachment; filename="finals-${id}.bundle.json"`}});
 }catch(error){return finalsError(error);}
}
