'use client';
import { useEffect,useState } from 'react';
import Navbar from '@/components/Navbar';
type Team={id:number;name:string;leader_username:string;status:string;member_count:number;agent_count:number};
export default function AdminTeams(){
  const [teams,setTeams]=useState<Team[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
  useEffect(()=>{fetch('/api/admin/teams').then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error);setTeams(d.teams);}).catch(e=>setError(e.message));},[refresh]);
  async function archive(team:Team){
    if(!confirm(`Giải thể ${team.name}? Thành viên trở về cá nhân; agent team bị dừng, lịch sử giữ nguyên.`))return;
    setBusy(true);setError('');
    try{const r=await fetch('/api/team',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'archive',team_id:Number(team.id)})});const d=await r.json();if(!r.ok)throw new Error(d.error);setRefresh(v=>v+1);}catch(e){setError(e instanceof Error?e.message:'Lỗi giải thể');}finally{setBusy(false);}
  }
  return <div className="min-h-screen bg-[#F5F0ED]"><Navbar/><main className="mx-auto max-w-5xl p-6"><h1 className="mb-6 text-2xl font-bold">Quản lý teams</h1>{error&&<p role="alert" className="text-rose-700">{error}</p>}<p className="mb-4 text-sm text-slate-500">Chỉ admin được giải thể; không xóa agent, rating hay replay. Hiển thị 200 đội mới nhất.</p>{teams.map(t=><div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-[#ded8d3] bg-white p-4" key={t.id}><span><strong>{t.name}</strong> · {t.leader_username} · {t.member_count}/3 người · {t.agent_count} agents · {t.status}</span>{t.status==='active'&&<button disabled={busy} className="border border-rose-300 px-3 py-2 text-rose-700" onClick={()=>void archive(t)}>Giải thể team</button>}</div>)}</main></div>;
}
