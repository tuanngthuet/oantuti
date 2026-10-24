import {NextResponse} from 'next/server';
import {getSession} from '@/lib/session';
import {finalsQuery} from '@/lib/finals-db';
import {finalsError} from '@/lib/finals';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const id=Number((await params).id),query=new URL(request.url).searchParams;
 const after=Number(query.get('after')||0);const admin=query.get('admin')==='true'&&(await getSession())?.is_admin===true;
 if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(after)||after<0)return NextResponse.json({error:'Tham số không hợp lệ.'},{status:400});
 try{
  const rows=await finalsQuery(`SELECT g.id,g.leg,g.seed1,g.seed2,g.status,g.outcome,g.published,g.active_attempt,p.round,p.slot,p.points1,p.points2,
   p.status AS pair_status,p.seed1 AS pair_seed1,p.seed2 AS pair_seed2,a.move_count,a.source,a.reason,a.status AS attempt_status,
   CASE WHEN $2 THEN a.error END AS error,e.rules,e.name AS edition_name,e.id AS edition_id,
   one.name AS name1,one.agent_name AS agent1_name,two.name AS name2,two.agent_name AS agent2_name
   FROM games g JOIN pairs p ON p.id=g.pair_id JOIN editions e ON e.id=p.edition_id
   JOIN entrants one ON one.edition_id=e.id AND one.seed=g.seed1 JOIN entrants two ON two.edition_id=e.id AND two.seed=g.seed2
   LEFT JOIN attempts a ON a.id=g.active_attempt WHERE g.id=$1 AND ($2 OR g.published)`,[id,admin]);
  if(!rows.length)return NextResponse.json({error:'Ván chưa được công bố hoặc không tồn tại.'},{status:404});
  const game=rows[0];
  const upgraded=(await finalsQuery("SELECT to_regclass('ck_rounds') IS NOT NULL AS present"))[0].present;
  if(upgraded){
   const metadata=await finalsQuery(`SELECT g.engine_digest,g.engine_version,g.round_rules,a.initial_state,
    coalesce(one.name,$2::text) AS agent1_name,coalesce(two.name,$3::text) AS agent2_name
    FROM games g LEFT JOIN attempts a ON a.id=g.active_attempt
    LEFT JOIN ck_submissions one ON one.id=g.submission1 LEFT JOIN ck_submissions two ON two.id=g.submission2
    WHERE g.id=$1`,[id,game.agent1_name,game.agent2_name]);
   Object.assign(game,metadata[0]);
  }
  const sameAttempt=query.get('attempt')===String(game.active_attempt);
  const moves=game.active_attempt?await finalsQuery('SELECT seq,move,state FROM moves WHERE attempt_id=$1 AND seq>$2 ORDER BY seq',[game.active_attempt,sameAttempt?after:0]):[];
  return NextResponse.json({game,moves: moves.map(m=>({...m.move,move_number:m.seq,display:m.state})),reset:!sameAttempt},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return finalsError(error);}
}
