'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

type Team = {
  id:number; name:string; creator_id:number; leader_username:string; recruiting:boolean;
  members:{id:number;username:string}[]; member_count:number;
  request_status:string|null; request_id:number|null;
};
type Directory = {teams:Team[]; total:number; authenticated:boolean; current_team_id:number|null};
const button='rounded-lg border border-[#ded8d3] bg-white px-4 py-2 text-sm hover:border-[#253B80] disabled:cursor-not-allowed disabled:opacity-50';

export default function TeamDirectory({search,onSearchChange,page,onPageChange,refresh}:{
  search:string; onSearchChange:(value:string)=>void; page:number; onPageChange:(value:number)=>void; refresh:number;
}) {
  const [data,setData]=useState<Directory|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState<number|null>(null);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);
    const timer=setTimeout(async()=>{
      try {
        const res=await fetch(`/api/arena/teams?page=${page}&search=${encodeURIComponent(search)}`,{signal:controller.signal});
        const body=await res.json();
        if(!res.ok)throw new Error(body.error);
        if(!controller.signal.aborted){setData(body);setError('');}
      }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Không thể tải danh sách team.');}
      finally{if(!controller.signal.aborted)setLoading(false);}
    },200);
    return()=>{clearTimeout(timer);controller.abort();};
  },[search,page,refresh,revision]);

  async function wave(team:Team,cancel=false) {
    setBusy(team.id);setError('');setMessage('');
    try {
      const res=await fetch('/api/team',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(
        cancel?{action:'cancel_join',request_id:Number(team.request_id)}:{action:'request_join',team_id:Number(team.id)}
      )});
      const body=await res.json();
      if(!res.ok)throw new Error(body.error);
      setData(current=>current?{...current,teams:current.teams.map(t=>t.id===team.id?{...t,request_status:cancel?'cancelled':'pending',request_id:body.request_id}:t)}:current);
      setMessage(cancel?`Đã hủy yêu cầu vào ${team.name}.`:`Đã vẫy tay với ${team.name}! Trưởng đội sẽ nhận được yêu cầu của bạn.`);
    }catch(e){setError(e instanceof Error?e.message:'Không thể gửi yêu cầu.');}
    finally{setBusy(null);setRevision(v=>v+1);}
  }

  return <section aria-label="Tìm team">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-2xl text-sm text-slate-600">Vẫy tay với đội bạn muốn tham gia. Trưởng đội sẽ xét duyệt yêu cầu; mỗi đội có tối đa 3 thành viên. Khi được duyệt, agent cá nhân được giữ riêng và tạm dừng rating.</p>
      <Link href="/team" className={button}>{data?.current_team_id?'Quản lý team →':'Tạo team →'}</Link>
    </div>
    <input aria-label="Tìm team" placeholder="Tìm tên đội, trưởng đội hoặc thành viên…" value={search}
      onChange={e=>onSearchChange(e.target.value)} className="mb-5 w-full rounded-full border border-[#ded8d3] bg-white px-5 py-3"/>
    {message&&<p role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{message}</p>}
    {error&&<p role="alert" className="mb-4 rounded-lg border border-rose-200 bg-white p-4 text-sm text-rose-700">{error}</p>}
    {loading&&<p role="status" className="mb-3 text-xs text-slate-500">Đang tải team…</p>}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {data?.teams.map(team=>{
        const mine=Number(data.current_team_id)===Number(team.id);
        const pending=team.request_status==='pending';
        const full=team.member_count>=3;
        return <article key={team.id} className={`flex flex-col rounded-xl border bg-white p-5 ${mine?'border-[#253B80]':'border-[#ded8d3]'}`}>
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0"><h2 className="break-words text-lg font-semibold">{team.name}</h2><p className="mt-1 text-xs text-slate-500">Trưởng đội · {team.leader_username}</p></div>
            <span className="shrink-0 rounded-full bg-stone-100 px-2.5 py-1 text-xs text-slate-600">{team.member_count}/3</span>
          </div>
          <div className="mb-5 flex flex-wrap gap-2">{team.members.map(member=><span key={member.id} className="max-w-full break-words rounded-full bg-[#F5F0ED] px-3 py-1 text-xs">{member.username}{Number(member.id)===Number(team.creator_id)&&' ♛'}</span>)}</div>
          <div className="mt-auto border-t border-stone-100 pt-4">
            <p className={`mb-3 text-xs ${team.recruiting&&!full?'text-emerald-700':'text-slate-500'}`}>{full?'Đã đủ thành viên':team.recruiting?'● Đang tìm đồng đội':'Đã đóng tuyển'}</p>
            {mine?<Link href="/team" className={`${button} inline-block text-[#253B80]`}>Đội của bạn →</Link>
              :pending?<div className="flex flex-wrap items-center gap-3"><span className="text-sm text-[#253B80]">👋 Đã gửi yêu cầu</span><button className="text-xs text-slate-500 underline disabled:opacity-50" disabled={busy!==null} onClick={()=>void wave(team,true)} aria-label={`Hủy yêu cầu vào ${team.name}`}>Hủy</button></div>
              :data.current_team_id?<p className="text-xs text-slate-500">Bạn đang thuộc một đội.</p>
              :!data.authenticated?<Link href="/login?redirect=%2Farena%2Fleaderboard" className={`${button} inline-block`}>Đăng nhập để vẫy tay</Link>
              :<button disabled={busy!==null||full||!team.recruiting} onClick={()=>void wave(team)} aria-label={`Vẫy tay xin vào ${team.name}`}
                className={`${button} group flex w-full items-center justify-center gap-2 text-[#253B80]`}>
                <span aria-hidden="true" className="team-wave text-xl">👋</span>{busy===team.id?'Đang gửi…':'Xin vào đội'}
              </button>}
          </div>
        </article>;
      })}
    </div>
    {!loading&&!data?.teams.length&&!error&&<div className="rounded-xl border border-[#ded8d3] bg-white p-10 text-center text-sm text-slate-500">{search?'Không tìm thấy team phù hợp.':'Chưa có team nào. Hãy tạo đội đầu tiên!'}</div>}
    <div className="mt-5 flex items-center justify-end gap-3">
      <button className={button} disabled={page<=1||loading} onClick={()=>onPageChange(page-1)}>← Trước</button>
      <span className="text-sm">Trang {page} / {Math.max(1,Math.ceil((data?.total??0)/20))}</span>
      <button className={button} disabled={loading||page*20>=(data?.total??0)} onClick={()=>onPageChange(page+1)}>Sau →</button>
    </div>
  </section>;
}
