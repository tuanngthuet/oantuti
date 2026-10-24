'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import ReplayView from '@/components/ReplayView';
import RatingChart from '@/components/RatingChart';

type Game = {
  id: number; status: string; outcome: string | null; result: string; replay_available: boolean;
  scheduled_at: string; finished_at: string | null; agent1_id: number; agent2_id: number;
  agent1_name: string; agent2_name: string; agent1_username: string; agent2_username: string;
  elo_delta_agent1: number | null; elo_delta_agent2: number | null;
};
type History = { agent: { id: number; agent_name: string; username: string; version: number; elo: number; is_active: boolean;scope_active:boolean;team_id:number|null }; matches: Game[]; selected: Game | null; total: number };
const labels: Record<string, string> = { all: 'Tất cả', win: 'Thắng', loss: 'Thua', draw: 'Hòa', error: 'Lỗi', scheduled: 'Đang chờ', running: 'Đang chạy', cancelled: 'Đã hủy', unknown: 'Chưa có kết quả' };
export default function GameHistory({ agentId }: { agentId: string }) {
  const router = useRouter();
  const query = useSearchParams();
  const matchId = query.get('matchId');
  const filter = query.get('result') ?? 'all';
  const [pages, setPages] = useState(1);
  const [data, setData] = useState<History | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileReplay, setMobileReplay] = useState(false);
  useEffect(() => {
    setData(null); setError(''); setPages(1); setMobileReplay(false); setCollapsed(false);
  }, [agentId]);
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') setRefresh(v => v + 1); }, 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all(Array.from({ length: pages }, async (_, i) => {
      const params = new URLSearchParams({ result: filter, page: String(i + 1) });
      if (matchId !== null) params.set('matchId', matchId);
      const res = await fetch(`/api/arena/agents/${agentId}/history?${params}`, { signal: controller.signal });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Không thể tải lịch sử.');
      return body as History;
    })).then(results => {
      if (controller.signal.aborted) return;
      const first = results[0];
      setData({ ...first, matches: [...new Map(results.flatMap(r => r.matches).map(m => [m.id, m])).values()] });
      setError('');
      if (matchId === null && first.selected) {
        const next = new URLSearchParams({ matchId: String(first.selected.id), result: filter });
        router.replace(`/arena/agents/${agentId}/history?${next}`, { scroll: false });
      }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [agentId, matchId, filter, pages, refresh, router]);
  const selected = !error && data && String(data.agent.id) === agentId && String(data.selected?.id) === matchId ? data.selected : null;
  function choose(id: number) {
    const params = new URLSearchParams({ matchId: String(id), result: filter });
    router.push(`/arena/agents/${agentId}/history?${params}`, { scroll: false });
    setMobileReplay(true);
  }
  function changeFilter(value: string) {
    setPages(1);
    const params = new URLSearchParams({ result: value });
    if (matchId) params.set('matchId', matchId);
    router.push(`/arena/agents/${agentId}/history?${params}`, { scroll: false });
  }
  return <div className="flex h-dvh flex-col bg-[#F5F0ED] text-[#1a1e29]">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#ded8d3] bg-white px-4 py-4">
      <div className="flex items-center gap-4"><Link aria-label="Quay lại leaderboard" href="/arena/leaderboard">←</Link><h1 className="text-xl font-semibold">Game History</h1></div>
      {data && <p className="text-sm text-slate-600">{data.agent.username} · {data.agent.agent_name} · v{data.agent.version}{data.agent.team_id?' · Team':' · Cá nhân'}{!data.agent.scope_active?' · Tạm ngừng rating':!data.agent.is_active?' · Đã ngừng':''}</p>}
      <button className="border border-[#ded8d3] px-3 py-1 text-sm" onClick={() => setRefresh(v => v + 1)}>↻ Làm mới</button>
    </header>
    <div className="flex gap-2 border-b border-[#ded8d3] bg-white p-2 lg:hidden"><button className="border px-3 py-1" onClick={() => setMobileReplay(false)}>Danh sách trận</button><button className="border px-3 py-1" onClick={() => setMobileReplay(true)}>Xem replay</button></div>
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Lịch sử trận đấu" className={`${mobileReplay ? 'hidden lg:block' : ''} ${collapsed ? 'lg:w-16' : 'lg:w-[380px] xl:w-[420px]'} w-full shrink-0 overflow-y-auto border-r border-[#ded8d3] bg-white`}>
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[#ded8d3] bg-white p-4">
          {!collapsed && <><h2 className="font-semibold">Games ({data?.total ?? 0})</h2><select aria-label="Lọc kết quả" className="min-w-0 border border-[#ded8d3] p-1 text-sm" value={filter} onChange={e => changeFilter(e.target.value)}>{Object.entries(labels).filter(([k]) => k !== 'unknown').map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></>}
          <button aria-label={collapsed ? 'Mở danh sách trận' : 'Thu gọn danh sách trận'} aria-expanded={!collapsed} className="hidden border px-2 py-1 lg:block" onClick={() => setCollapsed(v => !v)}>{collapsed ? '›' : '‹'}</button>
        </div>
        <div className={collapsed ? 'lg:hidden' : ''}>
          {data && <div className="border-b border-[#ded8d3] px-4 py-2"><strong className="text-lg">{data.agent.elo}</strong><RatingChart agentId={Number(agentId)} refresh={refresh} /></div>}
          {loading && <p role="status" className="px-4 py-2 text-xs text-slate-500">Đang cập nhật…</p>}
          {error && <p role="alert" className="p-4 text-rose-700">{error}</p>}
          {data?.matches.map(game => {
            const delta = Number(game.agent1_id) === Number(agentId) ? game.elo_delta_agent1 : game.elo_delta_agent2;
            return <div key={game.id} className="px-4 py-3">
              <div className="mb-2 flex justify-between text-xs text-slate-500"><time>{new Date(game.scheduled_at).toLocaleString('vi-VN')}</time><span>#{game.id}</span></div>
              <button aria-pressed={String(game.id) === matchId} onClick={() => choose(game.id)} className={`w-full rounded-2xl border bg-white px-3 text-left ${String(game.id) === matchId ? 'border-2 border-[#253B80]' : 'border-[#ded8d3] hover:border-slate-500'}`}>
                {[1, 2].map(player => <div key={player} className="flex items-center gap-3 border-b border-stone-100 py-3 last:border-0"><span aria-hidden="true">◎</span><span className={(game.outcome === `agent${player}` && game.status === 'finished') ? 'font-bold' : ''}>{player === 1 ? game.agent1_username : game.agent2_username}<span className="block text-xs font-normal text-slate-500">{player === 1 ? game.agent1_name : game.agent2_name}</span></span>{game.outcome === `agent${player}` && game.status === 'finished' && <span aria-label="Thắng">🏆</span>}</div>)}
                <div className="flex justify-between border-t border-stone-100 py-2 text-xs"><span>{labels[game.result] ?? game.result}</span><span>{delta !== null ? `${delta >= 0 ? '+' : ''}${delta} điểm` : '—'}</span></div>
              </button>
            </div>;
          })}
          {!loading && !error && !data?.matches.length && <p className="p-6 text-sm text-slate-500">Chưa có trận đấu phù hợp.</p>}
          {!!data && data.matches.length < data.total && <button className="m-4 border border-[#ded8d3] px-4 py-2" disabled={loading} onClick={() => setPages(v => v + 1)}>Tải thêm trận</button>}
        </div>
      </aside>
      <section aria-label="Replay ván đấu" className={`${mobileReplay ? '' : 'hidden lg:block'} min-w-0 flex-1 overflow-y-auto`}>
        {selected?.replay_available ? <ReplayView key={selected.id} embedded apiUrl={`/api/rating/matches/${selected.id}/replay`} backLink="/arena/leaderboard" />
          : <div className="flex min-h-64 items-center justify-center p-8 text-center text-slate-500">{error ? error : loading ? 'Đang tải trận…' : selected ? selected.status === 'scheduled' || selected.status === 'running' ? 'Trận chưa hoàn thành. Replay sẽ xuất hiện khi có kết quả.' : 'Trận này không có dữ liệu replay.' : 'Chọn một trận bên trái để xem replay.'}</div>}
      </section>
    </div>
  </div>;
}
