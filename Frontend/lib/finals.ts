import {cleanDisplay} from './finals-display';
import {NextResponse} from 'next/server';
import {finalsQuery} from './finals-db';
export {FINALS_RULES,ROUND_LABELS} from './finals-constants';
const errors:Record<string,string>={
 CK_FORBIDDEN:'Bạn không có quyền với suất Chung kết này.',CK_SUBMISSIONS_CLOSED:'Vòng chưa mở nhận bài hoặc đã khóa.',CK_ROUND_LOCKED:'Vòng đã khóa bài.',CK_ROUND_NOT_LOCKED:'Cần khóa bài hợp lệ của toàn bộ người tham gia trước khi mở đấu.',CK_MISSING_VALID_SUBMISSIONS:'Mọi suất phải có bản nộp mới nhất vượt self-play trong vòng này.',CK_ENGINE_UNKNOWN:'Chưa đăng ký engine của vòng này.',CK_ENGINE_MISMATCH:'Engine không khớp với cấu hình đã đăng ký.',CK_WORKER_ID_BUSY:'ID worker đang được một tiến trình khác sử dụng.',CK_LEGACY_READ_ONLY:'Ván cũ chỉ được xử lý thủ công; không chạy lại bằng worker mới.',
 NEED_SIXTEEN:'Cần đủ 16 đại diện đã có ít nhất 10 trận rating hợp lệ.',EDITION_ALREADY_OPEN:'Đã có một giải chưa kết thúc.',
 STALE_REVISION:'Dữ liệu đã thay đổi. Hãy tải lại trước khi thao tác.',EDITION_CLOSED:'Giải đã kết thúc hoặc đã hủy.',
 INVALID_STATE:'Thao tác không phù hợp với trạng thái hiện tại.',UNSUPPORTED_RULES:'Phiên bản này chỉ hỗ trợ luật ott-finals-v1: 150 nước, hòa lặp ba lần.',
 RULES_NOT_LOCKED:'Cần khóa luật trước khi mở vòng.',ROUND_ALREADY_OPEN:'Vòng này đã được mở.',PREVIOUS_ROUND_INCOMPLETE:'Cần xác nhận toàn bộ kết quả vòng trước.',
 MISSING_SEEDS:'Chưa xác định đủ hai đại diện của vòng này.',PAIR_NOT_READY:'Cần đủ hai ván đã có kết quả.',PAIR_CONFIRMED:'Cặp đã được xác nhận, không thể sửa kết quả.',
 GAME_RUNNING:'Ván đang chạy; hãy chờ kết thúc hoặc ngắt để xử lý.',NO_RECORD:'Ván chưa có lần chạy hoặc bản ghi để công bố.',REASON_REQUIRED:'Vui lòng nhập lý do.',
 INVALID_OUTCOME:'Kết quả phải là agent1, agent2 hoặc draw.',INVALID_RECORD:'Bản ghi không đúng cấu trúc an toàn hoặc vượt 10.000 nước.',
 INVALID_ACTION:'Thao tác không hợp lệ.',INVALID_ROUND:'Vòng đấu không hợp lệ.',NOT_FOUND:'Không tìm thấy giải/cặp/ván tương ứng.',
};
export function finalsError(error:unknown){
 const message=error instanceof Error?error.message:String(error);
 const codes=[...Object.keys(errors),'NEED_SIXTEEN','EDITION_ALREADY_OPEN','STALE_REVISION','EDITION_CLOSED','INVALID_STATE','UNSUPPORTED_RULES','RULES_NOT_LOCKED','ROUND_ALREADY_OPEN','PREVIOUS_ROUND_INCOMPLETE','MISSING_SEEDS','PAIR_NOT_READY','PAIR_CONFIRMED','GAME_RUNNING','NO_RECORD','REASON_REQUIRED','INVALID_OUTCOME','INVALID_RECORD','INVALID_ACTION','INVALID_ROUND','NOT_FOUND'];
 const code=codes.find(c=>message.includes(c));
 if(!code)console.error('Finals operation failed',error);
 return NextResponse.json({error:code?errors[code]:'Không thể xử lý chung kết.',code:code??'FINALS_ERROR'}, {status:code==='NOT_FOUND'?404:code==='CK_FORBIDDEN'?403:code?409:500});
}
export function validFinalsId(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>0;}
export function cleanRecord(value:unknown){
 if(!Array.isArray(value)||value.length>10000)throw Error('INVALID_RECORD');
 return value.map((move,i)=>{
  if(!move||typeof move!=='object'||Array.isArray(move))throw Error('INVALID_RECORD');
  for(const field of ['from_col','from_row','to_col','to_row'])if(!Number.isInteger(move[field])||move[field]<0||move[field]>8)throw Error('INVALID_RECORD');
  if(![1,2].includes(move.player)||!['ROCK','PAPER','SCISSORS'].includes(move.piece_type))throw Error('INVALID_RECORD');
  if(move.captured_type!=null&&!['ROCK','PAPER','SCISSORS'].includes(move.captured_type))throw Error('INVALID_RECORD');
  return {move_number:i+1,player:move.player,from_col:move.from_col,from_row:move.from_row,to_col:move.to_col,to_row:move.to_row,piece_type:move.piece_type,captured_type:move.captured_type??null,...(move.display?{display:cleanDisplay(move.display)}:{})};
 });
}
export async function editionData(id:number,admin=false){
 const editions=await finalsQuery('SELECT * FROM editions WHERE id=$1',[id]);
 if(!editions.length)return null;
 const entrants=await finalsQuery('SELECT seed,participant_key,source_agent_id,name,members,agent_name,version,rating,code_hash FROM entrants WHERE edition_id=$1 ORDER BY seed',[id]);
 const pairs=await finalsQuery('SELECT * FROM pairs WHERE edition_id=$1 ORDER BY round,slot',[id]);
 const games=await finalsQuery(`SELECT g.id,g.pair_id,g.leg,g.seed1,g.seed2,g.published,
 CASE WHEN $2 OR g.published THEN g.status ELSE 'private' END AS status,
 CASE WHEN $2 OR g.published THEN g.outcome END AS outcome,
 CASE WHEN $2 OR g.published THEN g.active_attempt END AS active_attempt,
 CASE WHEN $2 OR g.published THEN a.move_count END AS move_count,
 CASE WHEN $2 OR g.published THEN a.source END AS source,
 CASE WHEN $2 THEN a.error END AS error
 FROM games g JOIN pairs p ON p.id=g.pair_id LEFT JOIN attempts a ON a.id=g.active_attempt WHERE p.edition_id=$1 ORDER BY p.round,p.slot,g.leg`,[id,admin]);
 const attempts=admin?await finalsQuery('SELECT a.id,a.game_id,a.source,a.status,a.started_at,a.finished_at,a.move_count,a.outcome,a.reason,a.error,a.created_by FROM attempts a JOIN games g ON g.id=a.game_id JOIN pairs p ON p.id=g.pair_id WHERE p.edition_id=$1 ORDER BY a.id DESC',[id]):[];
 const audit=admin?await finalsQuery('SELECT * FROM audit WHERE edition_id=$1 ORDER BY id DESC LIMIT 100',[id]):[];
 const upgraded=(await finalsQuery("SELECT to_regclass('ck_rounds') IS NOT NULL AS present"))[0].present;
 const rounds=upgraded?await finalsQuery(`SELECT c.*,eng.version AS engine_version FROM ck_rounds c JOIN ck_engines eng ON eng.round=c.round AND eng.digest=c.engine_digest WHERE c.edition_id=$1 ORDER BY c.round`,[id]):[];
 const workers=admin?await finalsQuery(upgraded?"SELECT id,round,digest,last_seen,concurrency,last_seen>now()-interval '30 seconds' AS online FROM ck_workers ORDER BY round,id":"SELECT id,last_seen,concurrency,last_seen>now()-interval '30 seconds' AS online FROM workers ORDER BY id"):[];
 const engines=admin&&upgraded?await finalsQuery(`SELECT eng.*,EXISTS(SELECT 1 FROM ck_workers w WHERE w.round=eng.round AND w.digest=eng.digest AND w.last_seen>now()-interval '30 seconds') AS online FROM ck_engines eng ORDER BY eng.round,eng.version,eng.digest`):[];
 const submissions=admin&&upgraded?await finalsQuery(`SELECT re.round,re.seed,re.submission_id,c.generation,s.id AS latest_id,s.name,s.code_hash,s.submitted_by,s.created_at,j.status AS validation_status,j.error AS validation_error FROM ck_round_entrants re JOIN ck_rounds c USING(edition_id,round) LEFT JOIN LATERAL(SELECT * FROM ck_submissions sub WHERE sub.edition_id=re.edition_id AND sub.round=re.round AND sub.seed=re.seed AND sub.generation=c.generation ORDER BY sub.id DESC LIMIT 1) s ON true LEFT JOIN ck_jobs j ON j.submission_id=s.id WHERE re.edition_id=$1 ORDER BY re.round,re.seed`,[id]):[];
 return {edition:editions[0],entrants,pairs,games,rounds,...(admin?{attempts,audit,workers,engines,submissions,upgraded}:{})};
}
