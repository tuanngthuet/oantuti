"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import Navbar from '@/components/Navbar';
type Agent={id:number;agent_name:string;username:string;can_use?:boolean;is_mine?:boolean};
type Match={id:number;status:string;agent1_name:string;agent2_name:string;pending_backend:boolean;winner_name:string|null;outcome:string|null;created_at:string};
type Quota={used:number;remaining:number;limit:number;resets_at:string};
export default function PrivateTrials(){
 const [agents,setAgents]=useState<Agent[]>([]),[matches,setMatches]=useState<Match[]>([]),[quota,setQuota]=useState<Quota|null>(null);
 const [own,setOwn]=useState(''),[opponent,setOpponent]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[page,setPage]=useState(1);
 const requestId=useRef<string|null>(null);
 const refresh=useCallback(async()=>{try{const r=await fetch(`/api/friendly?page=${page}`,{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error);setMatches(d.matches);setQuota(d.quota);}catch(e){setMessage(e instanceof Error?e.message:'Không thể tải dữ liệu.');}},[page]);
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),15000);return()=>clearInterval(timer);},[refresh]);
 useEffect(()=>{fetch('/api/arena/agents/all-active').then(r=>r.json()).then(d=>setAgents(d.agents??[])).catch(()=>setMessage('Không tải được agent.'));},[]);
 const mine=agents.filter(a=>a.can_use??a.is_mine),others=agents.filter(a=>!(a.can_use??a.is_mine));
 async function create(){setBusy(true);setMessage('');requestId.current??=crypto.randomUUID();try{
 const r=await fetch('/api/friendly',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent1_id:Number(own),agent2_id:Number(opponent),request_id:requestId.current})});
 const d=await r.json();if(!r.ok){if(r.status<500)requestId.current=null;throw Error(d.error);}
 requestId.current=null;setMessage(d.message);await refresh();
 }catch(e){setMessage(e instanceof Error?e.message:'Lỗi kết nối. Có thể gửi lại mà không mất thêm lượt.');}finally{setBusy(false);}}
 async function retry(id:number){setBusy(true);try{const r=await fetch('/api/friendly/process-pending',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({match_id:id})});const d=await r.json();setMessage(r.ok?(d.queued?'Đã gửi vào queue.':'Backend chưa sẵn sàng; trận vẫn được giữ.'):d.error);await refresh();}catch{setMessage('Không thể kết nối.');}finally{setBusy(false);}}
 return (
  <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]">
    <Navbar />
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">⚔️ Thách đấu</h1>
        </div>
      </header>

      {/* Box Quy tắc Đấu Giao hữu */}
      <div className="mb-6 rounded-none border border-[#ded8d3] bg-white p-5 shadow-sm">
        <p className="mb-2 text-sm font-bold text-[#1a1e29]">📖 Quy tắc Đấu Giao hữu</p>
        <ul className="space-y-1.5 text-xs text-slate-600">
          <li>• Thử agent cá nhân/team với agent public của người khác.</li>
          <li>• Không gửi thách đấu, không thông báo đối thủ và không ảnh hưởng rating.</li>
          <li>• Chỉ bạn hoặc thành viên hiện tại của team nguồn được xem lịch sử/replay (admin có quyền kỹ thuật).</li>
        </ul>
      </div>

      <div className="mb-4 border border-[#ded8d3] bg-white p-3 text-sm">
        {quota ? (
          <span>
            Đã dùng <strong>{quota.used}/{quota.limit}</strong> lượt · còn <strong>{quota.remaining}</strong>. Đặt lại lúc {new Date(quota.resets_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} (giờ Việt Nam).
          </span>
        ) : (
          'Đang tải hạn mức…'
        )}
      </div>
 <section className="grid gap-4 border border-[#ded8d3] bg-white p-6 shadow-sm md:grid-cols-2">
  <label className="text-sm font-bold text-[#1a1e29]">
    Agent của cá nhân/team
    <select aria-label="Agent của bạn" className="mt-2 w-full rounded-none border border-[#ded8d3] bg-white p-3 text-sm outline-none transition focus:border-[#253B80]" value={own} onChange={e=>{setOwn(e.target.value);requestId.current=null;}}>
      <option value="">Chọn agent</option>
      {mine.map(a=><option key={a.id} value={a.id}>{a.agent_name}</option>)}
    </select>
  </label>
  <label className="text-sm font-bold text-[#1a1e29]">
    Đối thủ public
    <select aria-label="Đối thủ public" className="mt-2 w-full rounded-none border border-[#ded8d3] bg-white p-3 text-sm outline-none transition focus:border-[#253B80]" value={opponent} onChange={e=>{setOpponent(e.target.value);requestId.current=null;}}>
      <option value="">Chọn đối thủ</option>
      {others.map(a=><option key={a.id} value={a.id}>{a.username} · {a.agent_name}</option>)}
    </select>
  </label>
  <p className="text-xs text-slate-500 md:col-span-2">
    Agent phải vượt self-play và đang hoạt động. Máy chủ chọn bên đi trước ngẫu nhiên 50/50. Lỗi hạ tầng hoặc hủy trước khi chạy được hoàn lượt; lỗi do agent vẫn tính lượt.
  </p>
  <div className="md:col-span-2">
    <button className="rounded-none bg-[#253B80] px-6 py-3 text-sm font-bold text-white transition hover:bg-[#1d2e66] disabled:opacity-50" disabled={busy||!own||!opponent||quota?.remaining===0} onClick={create}>
      {busy?'Đang xử lý…':'Tạo một trận thách đấu'}
    </button>
  </div>
 </section>
 {message&&<p role="alert" className="my-4 border border-[#ded8d3] bg-white p-3 text-sm">{message}</p>}
 <section className="mt-8">
  <h2 className="mb-4 text-xl font-bold">Lịch sử thách đấu riêng</h2>
  {matches.map(m=><article key={m.id} className="my-3 flex flex-wrap items-center justify-between gap-3 border border-[#ded8d3] bg-white p-4 shadow-sm"><div><span className="font-bold">#{m.id} · {m.agent1_name} vs {m.agent2_name}</span><p className="text-xs text-slate-500">{m.status} · {m.winner_name?`Thắng: ${m.winner_name}`:m.outcome??'Chờ kết quả'}</p></div><div className="flex items-center gap-4 text-sm"><Link className="font-semibold text-[#253B80] underline hover:text-[#1d2e66]" href={`/arena/replay/friendly/${m.id}`}>Replay</Link>{m.pending_backend&&m.status==='scheduled'&&<button className="rounded-none border border-[#ded8d3] bg-white px-3 py-1 text-xs hover:bg-stone-50" disabled={busy} onClick={()=>retry(m.id)}>Gửi lại vào queue</button>}</div></article>)}{!matches.length&&<p className="border border-[#ded8d3] bg-white p-6 text-sm text-slate-500">Chưa có trận thách đấu.</p>}
  <div className="mt-4 flex items-center gap-4 text-sm"><button className="rounded-none border border-[#ded8d3] bg-white px-3 py-1.5 disabled:opacity-40 hover:bg-stone-50" disabled={page===1} onClick={()=>setPage(p=>p-1)}>Trước</button><span>Trang {page}</span><button className="rounded-none border border-[#ded8d3] bg-white px-3 py-1.5 disabled:opacity-40 hover:bg-stone-50" disabled={matches.length<20} onClick={()=>setPage(p=>p+1)}>Sau</button><button className="rounded-none border border-[#ded8d3] bg-white px-3 py-1.5 hover:bg-stone-50" onClick={()=>void refresh()}>Làm mới</button></div>
 </section>
 </main>
 </div>
);
}
