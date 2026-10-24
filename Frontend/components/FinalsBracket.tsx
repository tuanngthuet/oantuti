import Link from 'next/link';
export type FinalsEntrant={seed:number;name:string;agent_name:string;rating?:number;members?:{username:string}[]};
export type FinalsPair={id:number|string;round:number;slot:number;seed1:number|null;seed2:number|null;winner_seed:number|null;loser_seed?:number|null;status:string;points1:number|null;points2:number|null};
export type FinalsGameRow={id:number|string;pair_id:number|string;leg:number;seed1:number;seed2:number;status:string;outcome:string|null;published:boolean;move_count?:number;source?:string;error?:string};
export const SEED_ORDER=[1,16,8,9,4,13,5,12,2,15,7,10,3,14,6,11];
export function previewPairs():FinalsPair[]{return [1,2,3,4,5].flatMap(round=>Array.from({length:round===1?8:round===2?4:round===3?2:1},(_,i)=>({id:`preview-${round}-${i}`,round,slot:i+1,seed1:round===1?SEED_ORDER[i*2]:null,seed2:round===1?SEED_ORDER[i*2+1]:null,winner_seed:null,status:'pending',points1:null,points2:null})));}
export function FinalsBracket({entrants,pairs,games=[]}:{entrants:FinalsEntrant[];pairs:FinalsPair[];games?:FinalsGameRow[]}){
 const names=new Map(entrants.map(e=>[e.seed,e]));
 const card=(pair:FinalsPair|undefined)=>!pair?null:<article key={String(pair.id)} className="relative w-40 rounded border border-stone-300 bg-white shadow-sm">
  {[pair.seed1,pair.seed2].map((seed,i)=><div key={i} className={`flex items-center gap-2 border-b border-stone-100 px-2 py-2 text-xs ${seed&&pair.winner_seed===seed?'bg-amber-50 font-bold text-amber-900':''}`}><span className="w-5 shrink-0 text-slate-400">{seed?`#${seed}`:'—'}</span><span className="min-w-0 flex-1 break-words">{seed?names.get(seed)?.name??'Chưa đủ suất':'Chờ kết quả'}</span>{pair.status==='confirmed'&&<span>{i?pair.points2:pair.points1}</span>}</div>)}
  <div className="flex flex-wrap gap-2 px-2 py-1 text-[10px] text-slate-500">{pair.status==='confirmed'?'Đã xác nhận':pair.status==='running'?'Đang thi đấu':'Chưa mở'}{games.filter(g=>String(g.pair_id)===String(pair.id)&&g.published).map(g=><Link key={String(g.id)} className="text-blue-700 underline" href={`/finals/games/${g.id}`}>Ván {g.leg}</Link>)}</div>
 </article>;
 const column=(title:string,round:number,start:number,end:number)=><div className="relative z-10 flex min-h-[612px] flex-col"><h3 className="mb-4 h-5 text-center text-xs font-bold uppercase text-slate-500">{title}</h3><div className="grid h-[576px] items-center" style={{gridTemplateRows:`repeat(${end-start+1},1fr)`}}>{pairs.filter(p=>p.round===round&&p.slot>=start&&p.slot<=end).map(p=><div key={String(p.id)}>{card(p)}</div>)}</div></div>;
 const final=pairs.find(p=>p.round===4),bronze=pairs.find(p=>p.round===5);
 return <div className="overflow-x-auto rounded-lg border border-stone-200 bg-stone-50 p-5" aria-label="Sơ đồ chung kết 16 hạt giống"><div className="relative mx-auto grid w-[1302px] grid-cols-[repeat(3,184px)_198px_repeat(3,184px)] gap-0">
 <svg aria-hidden="true" className="pointer-events-none absolute inset-0" width="1302" height="612" viewBox="0 0 1302 612" fill="none" stroke="#c5ad83" strokeWidth="2">
 {[0,288].map(y=><path key={'left'+y} d={`M160 ${108+y} H172 V${252+y} H160 M172 ${180+y} H184`}/>)}
 <path d="M344 180 H356 V468 H344 M356 324 H368 M528 324 H571 M731 324 H750 M910 324 H922 M934 180 H922 V468 H934"/>
 {[0,288].map(y=><path key={'right'+y} d={`M1118 ${108+y} H1106 V${252+y} H1118 M1106 ${180+y} H1094`}/>)}
 </svg>
 {column('Vòng 16',1,1,4)}{column('Tứ kết',2,1,2)}{column('Bán kết',3,1,1)}
 <div className="relative z-10 min-h-[612px]"><div className="absolute inset-x-0 top-20 flex flex-col items-center text-center"><p className="text-3xl">🏆</p><h3 className="font-bold text-amber-700">VÔ ĐỊCH</h3><p className="mt-2 max-w-40 break-words font-bold">{final?.winner_seed?names.get(final.winner_seed)?.name:'Chờ nhà vô địch'}</p></div><div className="absolute left-[19px] top-[324px] -translate-y-1/2"><h3 className="absolute -top-7 w-full text-center text-xs font-bold">CHUNG KẾT</h3>{card(final)}</div><div className="absolute left-[19px] top-[510px] -translate-y-1/2"><h3 className="absolute -top-7 w-full text-center text-xs font-bold">TRANH HẠNG BA</h3>{card(bronze)}</div></div>
 {column('Bán kết',3,2,2)}{column('Tứ kết',2,3,4)}{column('Vòng 16',1,5,8)}
 </div></div>;
}
