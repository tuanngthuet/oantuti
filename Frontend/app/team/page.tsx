'use client';
import { useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Navbar from '@/components/Navbar';
type Member={id:number;username:string};
type Invitation={id:number;name?:string;username?:string;leader_username?:string;status:string};
type JoinRequest={id:number;team_id:number;name?:string;username?:string;status:string};
type Team={id:number;name:string;creator_id:number;recruiting:boolean;is_leader:boolean;members:Member[]};
type Data={user_id:number;team:Team|null;received:Invitation[];sent:Invitation[];join_requests_received:JoinRequest[];join_requests_sent:JoinRequest[]};
const button='border border-[#ded8d3] bg-white px-4 py-2 text-sm hover:border-[#253B80] disabled:opacity-40';
export default function TeamPage(){
  const router=useRouter();
  const [data,setData]=useState<Data|null>(null),[name,setName]=useState(''),[recruiting,setRecruititing]=useState(false);
  const [search,setSearch]=useState(''),[users,setUsers]=useState<Member[]>([]),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
  const synced=useRef<number|null|undefined>(undefined);
  useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==='visible')setRefresh(v=>v+1);},15000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    const controller=new AbortController();
    fetch('/api/team',{signal:controller.signal}).then(async res=>{
      if(res.status===401){router.replace('/login?redirect=%2Fteam');return;}
      const body=await res.json();if(!res.ok)throw new Error(body.error);
      setData(body);setError('');
      if(synced.current!==(body.team?.id??null)){setName(body.team?.name??'');setRecruititing(body.team?.recruiting??false);synced.current=body.team?.id??null;}
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[router,refresh]);
  useEffect(()=>{
    const controller=new AbortController();
    if(!data?.team?.is_leader||!search.trim()){setUsers([]);return;}
    const timer=setTimeout(()=>fetch(`/api/team/candidates?search=${encodeURIComponent(search)}`,{signal:controller.signal}).then(async res=>{
      const body=await res.json();if(!res.ok)throw new Error(body.error);setUsers(body.users);
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);}),250);
    return()=>{clearTimeout(timer);controller.abort();};
  },[search,data?.team?.is_leader,refresh]);
  async function action(kind:string,body:Record<string,unknown>={}){
    setBusy(true);setError('');setMessage('');
    try{
      const res=await fetch('/api/team',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:kind,...body})});
      const result=await res.json();if(!res.ok)throw new Error(result.error);
      setMessage(kind==='approve_join'?'Đã chấp nhận thành viên mới.':kind==='decline_join'?'Đã từ chối yêu cầu.':kind==='cancel_join'?'Đã hủy yêu cầu.':'Đã cập nhật team.');setRefresh(v=>v+1);router.refresh();
    }catch(e){setError(e instanceof Error?e.message:'Không thể cập nhật team.');}finally{setBusy(false);}
  }
  const team=data?.team;
  const statuses:Record<string,string>={pending:'Đang chờ',accepted:'Đã chấp nhận',declined:'Đã từ chối',cancelled:'Đã hủy',expired:'Hết hạn'};
  return <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]"><Navbar/><main className="mx-auto max-w-4xl px-4 py-10 sm:px-8">
    <h1 className="mb-2 text-3xl font-bold">Your Team</h1><p className="mb-8 text-sm text-slate-600">Thi đấu cá nhân hoặc cùng team tối đa 3 người. Bạn chỉ nộp agent ở một tư cách tại một thời điểm.</p>
    {error&&<p role="alert" className="mb-4 border border-rose-200 bg-white p-4 text-rose-700">{error}</p>}{message&&<p role="status" className="mb-4 text-emerald-700">{message}</p>}
    {!data?<p>Đang tải team…</p>:<>
      <section className="border-b border-[#ded8d3] py-6"><h2 className="mb-4 text-xl font-semibold">{team?'Thông tin team':'Bạn đang thi đấu cá nhân'}</h2>
        <label className="block max-w-lg text-sm">Tên team<input aria-label="Tên team" value={name} disabled={!!team&&!team.is_leader} onChange={e=>setName(e.target.value)} className="mt-2 block w-full border border-[#ded8d3] bg-white px-4 py-3"/></label><p className="mt-2 text-xs text-slate-500">{[...name.trim()].length}/30 · Tên hiển thị trên leaderboard.</p>
        {!team&&<><p className="my-4 text-sm text-amber-800">Khi tạo team, agent cá nhân hiện có của bạn trở thành tài sản chung. Bạn luôn là trưởng đội và không thể tự rời hoặc giải thể.</p><button className={button} disabled={busy||![...name.trim()].length||[...name.trim()].length>30} onClick={()=>{if(confirm('Tạo team và chuyển agent cá nhân hiện có sang đội? Chỉ admin được giải thể đội.'))void action('create',{name});}}>Tạo team</button></>}
      </section>
      {team&&<>
        <section className="border-b border-[#ded8d3] py-6"><h2 className="mb-4 text-xl font-semibold">Tìm đồng đội</h2><label className="flex gap-3 text-sm"><input type="checkbox" checked={recruiting} disabled={!team.is_leader} onChange={e=>setRecruititing(e.target.checked)}/>Hiển thị trạng thái tìm đồng đội trên leaderboard</label></section>
        <section className="border-b border-[#ded8d3] py-6"><h2 className="mb-2 text-xl font-semibold">Thành viên ({team.members.length}/3)</h2><p className="mb-4 text-sm text-slate-500">Team một người vẫn là team, không phải tư cách cá nhân.</p>
          {team.members.map(member=><div key={member.id} className="flex items-center justify-between gap-3 border-b border-stone-200 py-4"><div><strong>{member.username}{Number(member.id)===Number(data.user_id)&&' (Bạn)'}</strong><p className="text-xs text-slate-500">{Number(member.id)===Number(team.creator_id)?'Người tạo · Trưởng đội':'Thành viên'}</p></div>{team.is_leader&&Number(member.id)!==Number(team.creator_id)&&<button className={button} disabled={busy} onClick={()=>{if(confirm(`Xóa ${member.username} khỏi team? Agent của đội vẫn ở lại.`))void action('remove',{user_id:Number(member.id)});}}>Xóa thành viên</button>}</div>)}
          {team.is_leader?<p className="mt-4 text-sm text-slate-500">Người tạo không thể rời hoặc chuyển quyền. Cần giải thể? Liên hệ admin.</p>:<button className={`${button} mt-4 text-rose-700`} disabled={busy} onClick={()=>{if(confirm('Rời đội? Bạn mất quyền đọc code team; agent của đội vẫn ở lại. Agent cá nhân cũ được tham gia lại nếu hợp lệ.'))void action('leave');}}>Rời team</button>}
        </section>
        {team.is_leader&&<section className="border-b border-[#ded8d3] py-6" aria-label="Yêu cầu xin vào đội">
          <h2 className="mb-2 text-xl font-semibold">👋 Yêu cầu xin vào đội</h2>
          <p className="mb-4 text-sm text-slate-500">Người chơi vẫy tay từ tab Team trên leaderboard. Yêu cầu có hiệu lực 7 ngày, không giữ chỗ.</p>
          {!data.join_requests_received.length&&<p className="text-sm text-slate-500">Chưa có yêu cầu gia nhập.</p>}
          {data.join_requests_received.map(request=><div key={request.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 py-4">
            <span className="text-sm"><strong>{request.username}</strong> · {statuses[request.status]}</span>
            {request.status==='pending'&&<div className="flex gap-2">
              <button className={button} disabled={busy||team.members.length>=3} onClick={()=>void action('approve_join',{request_id:Number(request.id)})} aria-label={`Chấp nhận ${request.username}`}>Chấp nhận</button>
              <button className={button} disabled={busy} onClick={()=>void action('decline_join',{request_id:Number(request.id)})} aria-label={`Từ chối ${request.username}`}>Từ chối</button>
            </div>}
          </div>)}
        </section>}
        {team.is_leader&&<section className="border-b border-[#ded8d3] py-6"><h2 className="mb-3 text-xl font-semibold">Gửi lời mời</h2><p className="mb-3 text-sm text-slate-500">Chỉ mời người chưa có team. Lời mời có hiệu lực 7 ngày; không giữ chỗ.</p><input aria-label="Tìm người chưa có team" placeholder="Tìm username chưa có team…" value={search} onChange={e=>setSearch(e.target.value)} className="w-full rounded-full border border-[#ded8d3] bg-white px-4 py-3"/>{users.map(user=><div key={user.id} className="flex items-center justify-between py-3"><span>{user.username}</span><button className={button} disabled={busy||team.members.length>=3||data.sent.some(i=>i.username===user.username&&i.status==='pending')} onClick={()=>void action('invite',{username:user.username})}>Mời</button></div>)}
          <h3 className="mt-6 font-semibold">Lời mời đã gửi</h3>{!data.sent.length&&<p className="mt-2 text-sm text-slate-500">Chưa gửi lời mời.</p>}{data.sent.map(i=><div key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><span>{i.username} · {statuses[i.status]}</span>{i.status==='pending'&&<button className={button} disabled={busy} onClick={()=>void action('cancel',{invitation_id:Number(i.id)})}>Hủy lời mời</button>}</div>)}
        </section>}
        <section className="py-6"><p className="mb-4 text-sm text-slate-600">Agent và code team dùng chung. Agent cá nhân cũ của thành viên gia nhập vẫn giữ riêng, tạm ngừng rating và không tính vào team.</p><Link className="mr-4 text-[#253B80] underline" href="/arena/submit">Agents của team →</Link>{team.is_leader&&<button className="bg-[#253B80] px-5 py-2 text-white disabled:opacity-40" disabled={busy||![...name.trim()].length||[...name.trim()].length>30} onClick={()=>void action('update',{name,recruiting})}>Lưu thay đổi</button>}</section>
      </>}
      <section className="border-t border-[#ded8d3] py-6" aria-label="Yêu cầu gia nhập đã gửi">
        <h2 className="mb-3 text-xl font-semibold">Yêu cầu gia nhập đã gửi</h2>
        {!data.join_requests_sent.length&&<p className="text-sm text-slate-500">Bạn chưa gửi yêu cầu. <Link className="text-[#253B80] underline" href="/arena/leaderboard">Tìm team trên leaderboard →</Link></p>}
        {data.join_requests_sent.map(request=><div key={request.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 py-4 text-sm">
          <span>{request.name} · {statuses[request.status]}</span>
          {request.status==='pending'&&<button className={button} disabled={busy} onClick={()=>void action('cancel_join',{request_id:Number(request.id)})}>Hủy yêu cầu</button>}
        </div>)}
      </section>
      <section className="border-t border-[#ded8d3] py-6"><h2 className="mb-3 text-xl font-semibold">Lời mời nhận được</h2>{!data.received.length&&<p className="text-sm text-slate-500">Bạn chưa nhận lời mời nào.</p>}{data.received.map(i=><div key={i.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 py-4"><span>{i.name} · {i.leader_username} · {statuses[i.status]}</span>{i.status==='pending'&&!team&&<div className="flex gap-2"><button className={button} disabled={busy} onClick={()=>{if(confirm('Gia nhập đội? Agent cá nhân được giữ riêng nhưng tạm dừng rating trong thời gian ở đội.'))void action('accept',{invitation_id:Number(i.id)});}}>Chấp nhận</button><button className={button} disabled={busy} onClick={()=>void action('decline',{invitation_id:Number(i.id)})}>Từ chối</button></div>}</div>)}</section>
    </>}
  </main></div>;
}
