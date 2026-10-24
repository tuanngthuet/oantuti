'use client';
import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import Navbar from '@/components/Navbar';
import TeamDirectory from '@/components/TeamDirectory';
import type { RankedAgent } from '@/lib/leaderboard';

type Entry = { user_id: number; participant_key:string;team_id:number|null;kind:string;members:{id:number;username:string}[];recruiting:boolean;username: string; agent: RankedAgent; rank: number | null; approved_agents: number };
type Data = { leaderboard: Entry[]; total: number; authenticated: boolean; me: (Entry & { page: number; eligible: boolean }) | null; counts: { rankings: number; calibrating: number } };
const button = 'border border-[#ded8d3] bg-white px-4 py-2 text-sm hover:border-[#253B80] disabled:opacity-40';
function AgentMenu({ entry }: { entry: Entry }) {
  const [agents, setAgents] = useState<RankedAgent[] | null>(null);
  const [error, setError] = useState('');
  const [position, setPosition] = useState({ top: 160, left: 16 });
  async function load() {
    if (agents) return;
    setError('');
    try {
      const res = await fetch(entry.team_id?`/api/arena/teams/${entry.team_id}/agents`:`/api/arena/users/${entry.user_id}/agents`);
      if (!res.ok) throw new Error();
      setAgents((await res.json()).agents);
    } catch { setError('Không thể tải agents. Đóng và mở lại để thử.'); }
  }
  return <div className="flex items-center gap-2">
    <Link aria-label={`Game History của ${entry.agent.agent_name}`} title="Game History của agent tốt nhất" href={`/arena/agents/${entry.agent.id}/history`} className="border border-[#ded8d3] px-2 py-1 text-[#253B80]">▣</Link>
    {entry.approved_agents > 1 && <details className="relative" onKeyDown={e => { if (e.key === 'Escape') e.currentTarget.open = false; }} onToggle={e => {
      if (e.currentTarget.open) {
        const rect = e.currentTarget.getBoundingClientRect();
        setPosition({ top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 340)), left: Math.max(8, Math.min(rect.right - 288, window.innerWidth - 296)) });
        void load();
      }
    }}>
      <summary aria-label={`Các agents của ${entry.username}`} className="cursor-pointer list-none px-2 py-1 text-xl">⋮</summary>
      <div style={position} className="fixed z-50 max-h-80 w-72 overflow-y-auto border border-[#ded8d3] bg-white p-3 shadow-lg">
        <p className="mb-2 text-xs text-slate-500">Agents đã qua validation</p>
        {error && <p role="alert">{error}</p>}
        {!agents && !error && <p>Đang tải…</p>}
        {agents?.map(a => <Link key={a.id} href={`/arena/agents/${a.id}/history`} className="block border-b border-stone-100 py-3 hover:text-[#253B80]">
          <strong>{a.agent_name}</strong><span className="block text-xs text-slate-500">v{a.version} · {a.elo} điểm · {a.scope_active===false?'Tạm ngừng rating':a.is_active ? Number(a.valid_games) >= 10 ? 'Đủ điều kiện' : `Hiệu chỉnh ${a.valid_games}/10` : 'Đã ngừng'} · Xem lịch sử →</span>
        </Link>)}
      </div>
    </details>}
  </div>;
}
type RecentMatch = { id: number; agent1_name: string; agent2_name: string; status: string; outcome: string | null };
export default function ArenaLeaderboardPage() {
  const [tab, setTab] = useState<'rankings' | 'calibrating' | 'matches' | 'teams'>('rankings');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Data | null>(null);
  const [matches, setMatches] = useState<RecentMatch[]>([]);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [restored, setRestored] = useState(false);
  const restoreScroll = useRef<number | null>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem('arena-leaderboard-view') ?? 'null');
      if (saved && ['rankings', 'calibrating', 'matches', 'teams'].includes(saved.tab)) {
        setTab(saved.tab); setSearch(typeof saved.search === 'string' ? saved.search : '');
        setPage(Number.isSafeInteger(saved.page) && saved.page > 0 ? saved.page : 1);
        restoreScroll.current = Number(saved.scroll) || 0;
      }
    } catch { /* Storage is optional. */ }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    const save = () => { try { sessionStorage.setItem('arena-leaderboard-view', JSON.stringify({ tab, search, page, scroll: window.scrollY })); } catch { /* Storage is optional. */ } };
    save(); window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, [restored, tab, search, page]);
  useEffect(() => {
    if (!loading && restoreScroll.current !== null) { window.scrollTo(0, restoreScroll.current); restoreScroll.current = null; }
  }, [loading]);
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') setRefresh(v => v + 1); }, 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (tab === 'teams') { setLoading(false); setError(''); return; }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const url = tab === 'matches' ? `/api/rating/matches?page=${page}` : `/api/arena/leaderboard?tab=${tab}&page=${page}&search=${encodeURIComponent(search)}`;
        const res = await fetch(url, { signal: controller.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        if (tab === 'matches') setMatches(body.matches); else setData(body);
        setError('');
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Không thể tải dữ liệu.'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [tab, search, page, refresh]);
  return <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]"><Navbar />
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div><h1 className="text-3xl font-bold">📊 Bảng Xếp Hạng</h1></div>
        <div className="flex gap-2"><Link href="/arena/submit" className={button}>+ Nộp agent</Link><button className={button} onClick={() => setRefresh(v => v + 1)}>↻ Làm mới</button></div>
      </header>
      <div className="mb-5 flex flex-wrap gap-2" role="tablist" aria-label="Bảng xếp hạng">
        {(['rankings', 'calibrating', 'matches', 'teams'] as const).map(t => <button role="tab" aria-selected={tab === t} key={t} className={`${button} ${tab === t ? 'font-bold text-[#253B80] border-[#253B80]' : ''}`} onClick={() => { if (t !== tab && (t === 'teams' || tab === 'teams')) setSearch(''); setTab(t); setPage(1); setData(null); setMatches([]); }}>
          {t === 'rankings' ? `Bảng xếp hạng (${data?.counts.rankings ?? '—'})` : t === 'calibrating' ? `Đang hiệu chỉnh (${data?.counts.calibrating ?? '—'})` : t === 'teams' ? 'Team👋' : 'Trận gần đây'}
        </button>)}
      </div>
      {tab !== 'matches' && tab !== 'teams' && <>
        <input aria-label="Tìm leaderboard" placeholder="Tìm username hoặc agent…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} className="mb-4 w-full rounded-full border border-[#ded8d3] bg-white px-5 py-3" />
        <div className="mb-6 rounded-none border border-[#ded8d3] bg-white p-5 shadow-sm">
          <p className="mb-2 text-sm font-bold text-[#1a1e29]">📖 Quy tắc BXH</p>
          <ul className="space-y-1.5 text-xs text-slate-600">
            <li>• Bảng Xếp hạng theo rating được cập nhật liên tục.</li>
            <li>• Top 16 theo các đợt sẽ thi đấu vòng Chung kết.</li>
            <li>• Mỗi cá nhân hoặc team được xếp hạng bằng agent tốt nhất có ít nhất 10 trận rating hợp lệ.</li>
            <li>• Khi bạn đang thuộc team, agent cá nhân được giữ riêng nhưng tạm ngừng rating và không tạo thêm vị trí cá nhân.</li>
            <li>• Agent của bạn được bắt đầu ở 1000 điểm.</li>
            <li>• Hòa sau 200 nước bị trừ 4–32 điểm mỗi bên dựa vào số quân trên bàn.</li>
          </ul>
        </div>
        {data?.me ? <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border border-[#ded8d3] bg-white p-3 text-sm">
          <span>Vị trí của tôi: <strong>{data.me.rank ? `#${data.me.rank}` : 'Đang hiệu chỉnh'}</strong> · {data.me.agent.elo} điểm</span>
          <button className="text-[#253B80] underline" onClick={() => { setSearch(''); setTab(data.me!.eligible ? 'rankings' : 'calibrating'); setPage(data.me!.page); }}>Vị trí của tôi →</button>
        </div> : data && <p className="mb-4 text-sm"><Link className="text-[#253B80] underline" href={data.authenticated ? '/arena/submit' : '/login'}>{data.authenticated ? 'Nộp agent để tham gia xếp hạng' : 'Đăng nhập để nộp agent và xem vị trí của bạn'}</Link></p>}
      </>}
      {error && <p role="alert" className="mb-4 border border-rose-200 bg-white p-4 text-rose-700">{error}</p>}
      {loading && <p role="status" className="mb-2 text-xs text-slate-500">Đang cập nhật…</p>}
      {tab === 'teams' ? <TeamDirectory search={search} onSearchChange={value => { setSearch(value); setPage(1); }} page={page} onPageChange={setPage} refresh={refresh} /> : tab !== 'matches' ? <div className="min-h-64 rounded-xl border border-[#ded8d3] bg-white">
        <div className="overflow-x-auto pb-3"><table className="w-full text-left text-sm">
          <thead><tr className="border-b border-[#ded8d3] bg-[#F5F0ED]/40 text-black">{['#', 'Người chơi', 'Agent tốt nhất', 'Điểm', 'W / L / D', 'Lần đấu cuối', 'Agents'].map(h => <th key={h} className="px-5 py-4 whitespace-nowrap text-black font-extrabold">{h}</th>)}</tr></thead>
          <tbody>{data?.leaderboard.map(e => {
            const isTop16 = tab === 'rankings' && e.rank !== null && e.rank >= 1 && e.rank <= 16;
            const isMe = e.participant_key === data.me?.participant_key;
            return <tr key={e.participant_key} data-user-id={e.user_id} data-participant={e.participant_key} className={`border-b transition-colors ${isTop16 ? isMe ? 'border-amber-300 bg-amber-100/90 hover:bg-amber-100 text-amber-950 font-medium' : 'border-amber-200/80 bg-amber-50/70 hover:bg-amber-100/60 text-amber-950' : isMe ? 'border-stone-100 bg-blue-50 hover:bg-blue-100/60' : 'border-stone-100 hover:bg-stone-50/70'}`}>
              <td className="px-5 py-5">{isTop16 ? <span className="inline-flex items-center gap-1 font-bold text-amber-900"><span className="text-xs">🏆</span>#{e.rank}</span> : (e.rank ?? '—')}</td>
              <td aria-label={e.username} className="px-5 py-5 font-semibold"><span>{e.username}</span>{isMe && <span className="ml-2 text-xs font-bold text-[#253B80]">(Bạn)</span>}<p className="text-xs font-normal text-slate-500">{e.kind==='team'?`Team · ${e.members.map(m=>m.username).join(', ')}`:'Cá nhân'}{e.recruiting&&' · Đang tìm đồng đội'}</p></td>
              <td className="px-5 py-5"><Link className="font-semibold text-[#253B80] hover:underline" href={`/arena/agents/${e.agent.id}`}>{e.agent.agent_name}</Link><p className="text-xs text-slate-500">v{e.agent.version}{!e.rank && ` · Hiệu chỉnh ${e.agent.valid_games}/10`}</p></td>
              <td className="px-5 py-5 font-mono font-bold text-[#1a1e29]">{e.agent.elo}</td>
              <td className="px-5 py-5 whitespace-nowrap text-slate-700">{e.agent.wins} / {e.agent.losses} / {e.agent.draws}</td>
              <td className="px-5 py-5 text-xs text-slate-500">{e.agent.last_finished_at ? new Date(e.agent.last_finished_at).toLocaleString('vi-VN') : 'Chưa đấu'}</td>
              <td className="px-5 py-5"><AgentMenu entry={e} /></td>
            </tr>;
          })}</tbody>
        </table></div>
        {!loading && !data?.leaderboard.length && <p className="p-10 text-center text-slate-500">{search ? 'Không tìm thấy người chơi.' : tab === 'rankings' ? 'Chưa có người chơi đủ 10 trận rating. Xem tab Đang hiệu chỉnh.' : 'Không có người chơi đang hiệu chỉnh.'}</p>}
      </div> : <div className="divide-y border border-[#ded8d3] bg-white">{matches.map(m => <div key={m.id} className="flex flex-wrap justify-between gap-2 p-4"><span>#{m.id} · {m.agent1_name} vs {m.agent2_name} · {m.status}</span><Link className="text-[#253B80]" href={`/arena/replay/rating/${m.id}`}>Xem trận →</Link></div>)}{!loading && !matches.length && <p className="p-8 text-slate-500">Chưa có trận đấu.</p>}</div>}
      {tab !== 'teams' && <div className="mt-5 flex items-center justify-end gap-3"><button className={button} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Trước</button><span className="text-sm">Trang {page}{tab !== 'matches' && data ? ` / ${Math.max(1, Math.ceil(data.total / 20))}` : ''}</span><button className={button} disabled={loading || (tab === 'matches' ? matches.length < 20 : page * 20 >= (data?.total ?? 0))} onClick={() => setPage(p => p + 1)}>Sau →</button></div>}
    </main>
  </div>;
}
