"use client";
import {useEffect,useMemo,useRef,useState} from 'react';
import Link from 'next/link';
import Navbar from './Navbar';
import {GameBoard,type Piece} from './GameBoard';
import {ROUND_LABELS} from '@/lib/finals-constants';
type Display={board:Piece[];terrain?:{col:number;row:number}[];bonus_cells?:{col:number;row:number;points?:number}[];scores?:Record<string,number>};
type Move={display?:Display|null;move_number:number;player:number;from_col:number;from_row:number;to_col:number;to_row:number;piece_type:string;captured_type:string|null};
type Game={initial_state?:Display;engine_version?:string;engine_digest?:string;id:number;active_attempt:number;leg:number;round:number;seed1:number;seed2:number;pair_seed1:number;pair_status:string;name1:string;name2:string;agent1_name:string;agent2_name:string;status:string;outcome:string|null;source:string;reason:string;error?:string;edition_id:number;edition_name:string;points1:number|null;points2:number|null;move_count:number};
export function initialFinalsBoard():Piece[]{
 const board:Piece[]=Array(81).fill(null);
 const place=(player:number,type:string,positions:string[])=>positions.forEach(p=>{board[(Number(p[0])-1)*9+p.charCodeAt(1)-97]={player,type};});
 place(1,'SCISSORS',['5c','4d','3e']);place(1,'PAPER',['5b','4c','3d','2e']);place(1,'ROCK',['4b','3c','2d']);
 place(2,'SCISSORS',['7e','6f','5g']);place(2,'PAPER',['8e','7f','6g','5h']);place(2,'ROCK',['8f','7g','6h']);return board;
}
export default function FinalsReplay({id,admin=false}:{id:string;admin?:boolean}){
 const [game,setGame]=useState<Game|null>(null),[moves,setMoves]=useState<Move[]>([]),[step,setStep]=useState(0),[playing,setPlaying]=useState(false),[speed,setSpeed]=useState(1200),[error,setError]=useState(''),[presentation,setPresentation]=useState(false),[scale,setScale]=useState(1);
 const cursor=useRef(0),attempt=useRef(''),boardArea=useRef<HTMLDivElement>(null);
 const moveCount=useRef(0);
 useEffect(()=>{let active=true;let loading=false;async function load(){if(loading)return;loading=true;try{const r=await fetch(`/api/finals/games/${id}?after=${cursor.current}&attempt=${attempt.current}${admin?'&admin=true':''}`,{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error);if(!active)return;setGame(d.game);setError('');if(d.reset){setMoves(d.moves);setStep(0);setPlaying(false);}else if(d.moves.length)setMoves(old=>[...old,...d.moves]);attempt.current=String(d.game.active_attempt);cursor.current=d.moves.at(-1)?.move_number??(d.reset?0:cursor.current);}catch(e){if(active)setError(e instanceof Error?e.message:'Mất kết nối.');}finally{loading=false;}}
 void load();const timer=setInterval(()=>void load(),1000);return()=>{active=false;clearInterval(timer);};},[id,admin]);
 useEffect(()=>{moveCount.current=moves.length;},[moves.length]);
 useEffect(()=>{if(!playing)return;const timer=setInterval(()=>setStep(old=>Math.min(old+1,moveCount.current)),speed);return()=>clearInterval(timer);},[playing,speed]);
 useEffect(()=>{if(['ready','needs_attention','cancelled'].includes(game?.status??'')&&step===moves.length)setPlaying(false);},[game?.status,step,moves.length]);
 useEffect(()=>{const resize=()=>{const area=boardArea.current,width=area?.clientWidth??window.innerWidth;const controls=area?.nextElementSibling as HTMLElement|null;const remaining=window.innerHeight-(area?.getBoundingClientRect().top??200)-(controls?.offsetHeight??160)-32;setScale(Math.max(0.45,Math.min(width/550,remaining/550,presentation?2.5:1.3)));};resize();const observer=new ResizeObserver(resize);if(boardArea.current){observer.observe(boardArea.current);if(boardArea.current.nextElementSibling)observer.observe(boardArea.current.nextElementSibling);}window.addEventListener('resize',resize);return()=>{observer.disconnect();window.removeEventListener('resize',resize);};},[presentation,game?.id]);
 const boards=useMemo(()=>{const states=[game?.initial_state?.board??initialFinalsBoard()];for(const move of moves){if(move.display?.board){states.push(move.display.board);continue;}const next=[...states[states.length-1]];const source=move.from_row*9+move.from_col,target=move.to_row*9+move.to_col;
 // Imported records are deliberately trusted. Their declared piece supports arbitrary presentation.
 next[source]=null;next[target]={player:move.player,type:move.piece_type};states.push(next);}return states;},[moves,game?.initial_state]);
 const display=step?moves[step-1]?.display:game?.initial_state;
 const atEnd=game?.status==='ready'&&step===moves.length;
 const outcome=game?.outcome==='draw'?'Hòa':game?.outcome==='agent1'?`${game.name1} thắng`:game?.outcome==='agent2'?`${game.name2} thắng`:'';
 async function fullscreen(){setPresentation(true);try{await document.documentElement.requestFullscreen();}catch{/* Browser can deny fullscreen; presentation layout still works. */}}
 return <div className={presentation?'min-h-screen bg-slate-950 text-white':'min-h-screen bg-[#F5F0ED]'}>{!presentation&&<Navbar/>}<main className={`mx-auto ${presentation?'max-w-[2000px] p-4':'max-w-7xl p-4 sm:p-6'}`}>
 <header className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><Link className="text-sm underline" href={`/finals/${game?.edition_id??''}`}>← Sơ đồ chung kết</Link><h1 className="mt-1 text-xl font-bold">{game?.edition_name??'Trình chiếu chung kết'} · {game?ROUND_LABELS[game.round]:''} · Ván {game?.leg??'—'}</h1></div><button className="border px-3 py-2 text-sm" onClick={presentation?()=>{setPresentation(false);if(document.fullscreenElement)void document.exitFullscreen();}:fullscreen}>{presentation?'Thoát trình chiếu':'Toàn màn hình / Trình chiếu'}</button></header>
 {error&&<p role="alert" className="my-3 border border-red-300 p-3 text-red-500">{error}</p>}
 {game&&<><div className="grid grid-cols-2 gap-4 text-center"><div className="rounded border border-blue-400 p-3"><p className="font-bold">#{game.seed1} {game.name1}</p><p className="text-xs opacity-70">{game.agent1_name} · P1 đi trước</p></div><div className="rounded border border-rose-400 p-3"><p className="font-bold">#{game.seed2} {game.name2}</p><p className="text-xs opacity-70">{game.agent2_name} · P2</p></div></div>
 <p className="my-2 text-center text-sm opacity-75">{game.source==='import'?'📼 Bản ghi nhập thủ công · tin admin, không kiểm chứng luật':game.source==='admin'?'⚖ Kết quả do admin chỉ định':'Lịch sử từng nước từ chương trình chung kết'} · {game.status==='needs_attention'?'Cần admin xử lý':game.status==='running'?'Đang tính nước đi':game.status}</p>
 <p className="mb-2 text-center text-sm font-bold">Tỷ số cặp: {game.seed1===game.pair_seed1?game.points1??'—':game.points2??'—'} – {game.seed1===game.pair_seed1?game.points2??'—':game.points1??'—'} · {game.pair_status==='confirmed'?'Đã xác nhận':'Chờ admin xác nhận'}</p>
 {game.engine_version&&<p className="text-center text-xs">{game.engine_version} · {game.engine_digest?.slice(0,12)}</p>}
 {display?.scores&&<p className="text-center text-sm">Điểm: P1 {display.scores['1']??0} – P2 {display.scores['2']??0}</p>}
 <div ref={boardArea} className="flex min-w-0 justify-center overflow-hidden py-2"><div style={{zoom:scale}}><div className="relative"><GameBoard board={boards[Math.min(step,boards.length-1)]} lastMove={moves[step-1]??null} terrain={display?.terrain} bonusCells={display?.bonus_cells}/>{((display?.terrain?.length??0)>0||(display?.bonus_cells?.length??0)>0)&&<div className="mt-2 text-xs">{display?.terrain?.map((cell,i)=><span className="mr-2" key={`t${i}`}>■ Chướng ngại ({cell.col},{cell.row})</span>)}{display?.bonus_cells?.map((cell,i)=><span className="mr-2" key={`b${i}`}>★ Ô thưởng ({cell.col},{cell.row}): {cell.points??0}</span>)}</div>}</div></div></div>
 <section className={`rounded border p-4 ${presentation?'border-slate-700 bg-slate-900':'bg-white'}`}><div className="flex flex-wrap items-center justify-between gap-3"><p className="font-mono" aria-live="polite">Nước {step}/{moves.length}{game.status==='running'?' · Đang nhận thêm nước':''}</p><p className="font-bold">{atEnd?outcome:playing&&step===moves.length?'Đang chờ nước tiếp theo…':''}</p></div>
 {atEnd&&<p className="my-2 text-sm opacity-70">{game.reason} · Kết quả sơ đồ chờ admin xác nhận.</p>}{admin&&game.error&&<p className="my-2 text-red-500">{game.error}</p>}
 <input aria-label="Tua nước chung kết" className="my-3 w-full" type="range" min={0} max={moves.length} value={step} onChange={e=>{setStep(Number(e.target.value));setPlaying(false);}}/>
 <div className="flex flex-wrap items-center justify-center gap-3"><button className="border px-3 py-2" onClick={()=>{setStep(0);setPlaying(false);}}>Về đầu</button><button className="border px-3 py-2" disabled={!step} onClick={()=>{setStep(s=>Math.max(0,s-1));setPlaying(false);}}>Nước trước</button><button className="border bg-blue-800 px-5 py-2 text-white" onClick={()=>{if(atEnd)setStep(0);setPlaying(p=>!p);}}>{playing?'Tạm dừng':'Phát'}</button><button className="border px-3 py-2" disabled={step>=moves.length} onClick={()=>{setStep(s=>Math.min(moves.length,s+1));setPlaying(false);}}>Nước sau</button><label className="text-sm">Tốc độ <select aria-label="Tốc độ trình chiếu" className="ml-2 border bg-white p-2 text-slate-900" value={speed} onChange={e=>setSpeed(Number(e.target.value))}>{[2400,1200,600,300].map(ms=><option value={ms} key={ms}>{ms/1000}s/nước{ms===1200?' (mặc định)':''}</option>)}</select></label></div>
 </section></>}
 </main></div>;
}
