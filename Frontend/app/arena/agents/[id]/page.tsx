"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import Navbar from "@/components/Navbar";
import RatingChart from '@/components/RatingChart';
import { matchResult } from '@/lib/leaderboard';

type AgentDetail = {
  id: number;
  agent_name: string;
  description: string;
  username: string;
  version: number;
  status: string;
  validation_error: string | null;
  is_active: boolean;
  is_public: boolean;
  wins: number;
  losses: number;
  draws: number;
  error_matches: number;
  elo: number;
  submitted_at: string;
  team_id:number|null;team_name:string|null;scope_active:boolean;
};

type MatchRow = {
  id: number;
  status: string;
  outcome: string | null;
  win_reason: string;
  total_moves: number;
  is_infra_error: boolean;
  elo_delta_agent1: number | null;
  elo_delta_agent2: number | null;
  scheduled_at: string;
  finished_at: string | null;
  agent1_id: number;
  agent1_name: string;
  agent1_username: string;
  agent2_id: number;
  agent2_name: string;
  agent2_username: string;
  winner_name: string | null;
  session_name: string | null;
};

type VersionRow = {
  id: number;
  version: number;
  agent_name: string;
  status: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  submitted_at: string;
};

function getTier(elo: number) {
  if (elo >= 2000) return { label: "Grandmaster", color: "text-amber-800", emoji: "👑" };
  if (elo >= 1800) return { label: "Master", color: "text-purple-800", emoji: "💎" };
  if (elo >= 1600) return { label: "Expert", color: "text-[#253B80]", emoji: "🔷" };
  if (elo >= 1400) return { label: "Intermediate", color: "text-teal-800", emoji: "🟢" };
  return { label: "Novice", color: "text-slate-600", emoji: "⚪" };
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-300",
  pending: "bg-slate-100 text-slate-700 border-slate-300",
  validating: "bg-amber-50 text-amber-700 border-amber-300",
  rejected: "bg-rose-50 text-rose-700 border-rose-300",
};

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const agentId = params.id;

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setAgent(null); setError(''); setMatches([]); setVersions([]);
    fetch(`/api/arena/agents/${agentId}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d: { agent?: AgentDetail; matches?: MatchRow[]; versions?: VersionRow[]; error?: string }) => {
        if (d.error) {
          setError(d.error);
          return;
        }
        setAgent(d.agent!);
        setMatches(d.matches ?? []);
        setVersions(d.versions ?? []);
      })
      .catch(() => { if (!controller.signal.aborted) setError("Không thể tải thông tin agent."); });
    return () => controller.abort();
  }, [agentId]);

  if (error)
    return (
      <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]">
        <Navbar />
        <main className="flex min-h-[60vh] items-center justify-center px-4">
          <div className="rounded-none border border-rose-300 bg-white p-8 text-center shadow-md">
            <p className="mb-4 text-sm font-bold text-rose-700">⚠️ {error}</p>
            <Link
              href="/arena/leaderboard"
              className="rounded-none bg-[#253B80] px-4 py-2 text-xs font-bold text-white hover:bg-[#1d2e66]"
            >
              ← Về Bảng Xếp Hạng
            </Link>
          </div>
        </main>
      </div>
    );

  if (!agent)
    return (
      <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]">
        <Navbar />
        <main className="flex min-h-[60vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-none border-2 border-stone-300 border-t-[#253B80]" />
        </main>
      </div>
    );

  const tier = getTier(agent.elo);
  const totalGames = agent.wins + agent.losses + agent.draws;
  const winRate = totalGames > 0 ? Math.round((agent.wins / totalGames) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]">
      <Navbar />

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center justify-between border-b border-[#ded8d3] pb-4">
          <Link
            href="/arena/leaderboard"
            className="rounded-none border border-[#ded8d3] bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-[#253B80] hover:text-[#253B80]"
          >
            ← Bảng Xếp Hạng
          </Link>
          <span className="font-mono text-xs font-bold text-slate-500">Agent #{agent.id}</span>
        </div>

        {/* Agent header: Khung thẳng */}
        <div className="mb-6 rounded-none border border-[#ded8d3] bg-white p-6 shadow-md">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-extrabold text-[#1a1e29]">{agent.agent_name}</h1>
                <span className="font-mono text-xs text-slate-500">v{agent.version}</span>
                <span className="border px-2.5 py-0.5 text-xs">{agent.is_public?'Public · tham gia rating':'Riêng tư · chỉ thách đấu'}</span>
                <span
                  className={`rounded-none border px-2.5 py-0.5 text-xs font-bold ${
                    STATUS_BADGE[agent.status] ?? "bg-slate-100 text-slate-700 border-slate-300"
                  }`}
                >
                  {agent.status}
                </span>
                {agent.is_active && (
                  <span className="rounded-none border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-700">
                    Đang thi đấu
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-slate-600">
                Tác giả: <span className="font-bold text-[#1a1e29]">{agent.username}</span>
              </p>
              {agent.description && <p className="mt-2 text-sm text-slate-600">{agent.description}</p>}
            </div>
            <div className="text-right">
              <p className={`font-mono text-3xl font-black ${tier.color}`}>{agent.elo}</p>
              <p className={`text-xs font-bold ${tier.color}`}>
                {tier.emoji} {tier.label}
              </p>
            </div>
          </div>

          {/* Stats row: Khung thẳng */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 border-t border-[#ded8d3] pt-5">
            {[
              { label: "Thắng", value: agent.wins, color: "text-emerald-700" },
              { label: "Thua", value: agent.losses, color: "text-rose-700" },
              { label: "Hòa", value: agent.draws, color: "text-slate-700" },
              { label: "Lỗi", value: agent.error_matches, color: "text-amber-700" },
              { label: "Win Rate", value: `${winRate}%`, color: "text-[#253B80]" },
              { label: "Tổng trận", value: totalGames, color: "text-[#1a1e29]" },
            ].map((s) => (
              <div
                key={s.label}
                className="rounded-none border border-[#ded8d3] bg-[#F5F0ED]/40 p-3 text-center"
              >
                <p className={`font-mono text-xl font-bold ${s.color}`}>{s.value}</p>
                <p className="mt-0.5 text-xs text-slate-500 font-semibold">{s.label}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="mb-4 text-sm text-slate-500">Chủ sở hữu: {agent.team_name?`Team ${agent.team_name}`:`Cá nhân ${agent.username}`} · Tác giả: {agent.username}{!agent.scope_active&&' · Tạm ngừng tham gia rating'}</p>
        <section className="mb-6 border border-[#ded8d3] bg-white p-5">
          <div className="flex items-center justify-between gap-3"><h2 className="font-bold">Lịch sử điểm rating</h2><Link className="text-sm text-[#253B80] underline" href={`/arena/agents/${agentId}/history`}>▣ Game History · Xem tất cả trận →</Link></div>
          <RatingChart agentId={Number(agentId)} />
        </section>
        {/* Match history: Khung thẳng */}
        <div className="mb-6 overflow-hidden rounded-none border border-[#ded8d3] bg-white shadow-md">
          <div className="border-b border-[#ded8d3] bg-stone-50 px-5 py-3.5">
            <h2 className="text-sm font-bold text-[#1a1e29]">📋 Lịch sử trận đấu của Agent</h2>
          </div>
          {matches.length === 0 ? (
            <p className="py-8 text-center text-xs text-slate-500">Chưa có trận nào.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#ded8d3] bg-stone-50 text-left text-xs font-bold text-slate-600">
                    <th className="px-4 py-3">Đối thủ</th>
                    <th className="px-4 py-3">Kết quả</th>
                    <th className="px-4 py-3 text-right">Rating ±</th>
                    <th className="px-4 py-3 text-right">Nước</th>
                    <th className="px-4 py-3 text-right">Ngày</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#ded8d3]">
                  {matches.map((m) => {
                    const isAgent1 = m.agent1_id === Number(agentId);
                    const opponent = isAgent1
                      ? { name: m.agent2_name, user: m.agent2_username, id: m.agent2_id }
                      : { name: m.agent1_name, user: m.agent1_username, id: m.agent1_id };
                    const myOutcome = matchResult(m, Number(agentId));
                    const eloDelta = isAgent1 ? m.elo_delta_agent1 : m.elo_delta_agent2;
                    const resultBadge: Record<string, string> = {
                      win: "text-emerald-700 font-bold",
                      loss: "text-rose-700 font-bold",
                      draw: "text-slate-600 font-bold",
                      error: "text-amber-700 font-bold",
                    };
                    const resultLabel: Record<string, string> = {
                      win: "Thắng ✓",
                      loss: "Thua ✗",
                      draw: "Hòa",
                      error: "⚠️ Lỗi",
                      scheduled: 'Đang chờ', running: 'Đang chạy', cancelled: 'Đã hủy', unknown: 'Chưa có kết quả',
                    };
                    return (
                      <tr key={m.id} className="hover:bg-stone-50 transition">
                        <td className="px-4 py-2.5">
                          <Link
                            href={`/arena/agents/${opponent.id}`}
                            className="font-bold text-[#253B80] hover:underline"
                          >
                            {opponent.name}
                          </Link>
                          <p className="text-xs text-slate-500">@{opponent.user}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`text-xs ${resultBadge[myOutcome] ?? 'text-slate-500'}`}>{resultLabel[myOutcome] ?? myOutcome}</span>
                          {m.win_reason && (
                            <p className="max-w-[200px] truncate text-xs text-slate-500">{m.win_reason}</p>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs">
                          {!m.is_infra_error && eloDelta != null && (
                            <span
                              className={`font-bold ${
                                eloDelta >= 0 ? "text-emerald-700" : "text-rose-700"
                              }`}
                            >
                              {eloDelta >= 0 ? "+" : ""}
                              {eloDelta}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-600">
                          {m.total_moves}
                        </td>
                        <td className="px-4 py-2.5 text-right text-xs text-slate-500">
                          {m.finished_at ? new Date(m.finished_at).toLocaleDateString("vi-VN") : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {m.status === "finished" && !m.is_infra_error && (
                            <Link
                              href={`/arena/replay/rating/${m.id}`}
                              className="rounded-none border border-[#253B80] px-2.5 py-1 text-xs font-bold text-[#253B80] hover:bg-[#253B80] hover:text-white transition"
                            >
                              ▶ Replay
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Version history: Khung thẳng */}
        {versions.length > 1 && (
          <div className="overflow-hidden rounded-none border border-[#ded8d3] bg-white shadow-md">
            <div className="border-b border-[#ded8d3] bg-stone-50 px-5 py-3.5">
              <h2 className="text-sm font-bold text-[#1a1e29]">🕐 Lịch sử phiên bản</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#ded8d3] bg-stone-50 text-left text-xs font-bold text-slate-600">
                    <th className="px-4 py-3">Phiên bản</th>
                    <th className="px-4 py-3">Tên</th>
                    <th className="px-4 py-3">Trạng thái</th>
                    <th className="px-4 py-3 text-right">Rating</th>
                    <th className="px-4 py-3 text-right">W / L / D</th>
                    <th className="px-4 py-3 text-right">Ngày nộp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#ded8d3]">
                  {versions.map((v) => (
                    <tr
                      key={v.id}
                      className={`hover:bg-stone-50 transition ${
                        v.id === Number(agentId) ? "bg-[#253B80]/5 font-semibold" : ""
                      }`}
                    >
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/arena/agents/${v.id}`}
                          className={`font-mono text-xs font-bold hover:underline ${
                            v.id === Number(agentId) ? "text-[#253B80]" : "text-slate-600"
                          }`}
                        >
                          v{v.version}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-[#1a1e29] font-bold">{v.agent_name}</td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`rounded-none border px-2 py-0.5 text-xs font-bold ${
                            STATUS_BADGE[v.status] ?? "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {v.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-bold text-[#253B80]">
                        {v.elo}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs">
                        <span className="font-bold text-emerald-700">{v.wins}</span>
                        <span className="text-slate-400"> / </span>
                        <span className="font-bold text-rose-700">{v.losses}</span>
                        <span className="text-slate-400"> / </span>
                        <span className="text-slate-600">{v.draws}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-slate-500">
                        {new Date(v.submitted_at).toLocaleDateString("vi-VN")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
