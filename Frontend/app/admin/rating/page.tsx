"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";

type Status = {
  summary: { rating_scheduled?: number; rating_running?: number; validating?: number; rating_finished?: number };
  agents: Array<ScheduledAgent & { id: number; agent_name: string; username: string; rating: number; trueskill_mu: number; trueskill_sigma: number }>;
  matches: Array<{
    id: number; status: string; outcome: string | null; is_infra_error: boolean; finished_at: string | null;
    agent1_name: string; agent2_name: string;
    agent1_mu_before: number | null; agent1_sigma_before: number | null; agent1_mu_after: number | null; agent1_sigma_after: number | null;
    agent2_mu_before: number | null; agent2_sigma_before: number | null; agent2_mu_after: number | null; agent2_sigma_after: number | null;
    rating_delta_agent1: number | null; rating_delta_agent2: number | null;
  }>;
  scheduler_enabled: boolean;
  policy?: { minimum_games: number; stable_sigma: number; daily_budget: number; refresh_hours: number };
};

const scheduleLabels: Record<string, string> = { busy: "Có trận chờ/đang chạy", budget_exhausted: "Hết ngân sách hôm nay",
  infra_backoff: "Tạm nghỉ do lỗi hạ tầng", calibrating: "Đang hiệu chỉnh", uncertain: "Cần tăng độ tin cậy",
  refresh_due: "Đến hạn kiểm tra", stable: "Đã ổn định" };
type ScheduledAgent = { valid_games: number; games_24h: number; budget_remaining: number;
  schedule_state: string; next_evaluation_at: string | null; waiting_reason?: string | null };

function confidence(sigma: number) {
  return Math.max(0, Math.min(100, Math.round((1 - sigma / (25 / 3)) * 100)));
}

export default function AdminRatingPage() {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMessage, setRebuildMessage] = useState("");
  const [changing, setChanging] = useState(false);
  const load = () => {
    fetch("/api/admin/rating/status")
      .then(async (response) => ({ ok: response.ok, body: await response.json() as Status & { error?: string } }))
      .then(({ ok, body }) => { if (ok) { setData(body); setError(""); } else setError(body.error ?? "Không có quyền."); })
      .catch(() => setError("Không thể tải trạng thái rating."));
  };
  useEffect(() => { load(); const timer = setInterval(load, 15000); return () => clearInterval(timer); }, []);
  async function toggleScheduler() {
    setChanging(true);
    try {
      const response = await fetch("/api/admin/rating/control", { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !data?.scheduler_enabled }) });
      if (!response.ok) throw new Error("Không thể cập nhật scheduler.");
      load();
    } catch (err) { setError(err instanceof Error ? err.message : "Có lỗi xảy ra."); }
    finally { setChanging(false); }
  }
  async function rebuildHistory() {
    setRebuilding(true);
    setRebuildMessage("");
    try {
      const response = await fetch("/api/admin/rating/rebuild", { method: "POST" });
      const body = await response.json() as { ok?: boolean; replayed_matches?: number; updated_agents?: number; error?: string };
      if (!response.ok) {
        setRebuildMessage(body.error ?? "Không thể dựng lại lịch sử.");
        return;
      }
      setRebuildMessage(`Đã dựng lại ${body.replayed_matches ?? 0} trận cho ${body.updated_agents ?? 0} agent.`);
      load();
    } catch {
      setRebuildMessage("Không thể kết nối máy chủ.");
    } finally {
      setRebuilding(false);
    }
  }
  const summary = data?.summary;
  return (
    <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]">
      <Navbar />
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-start justify-between border-b border-[#ded8d3] pb-5">
          <div>
            <h1 className="text-3xl font-extrabold">TrueSkill Queue</h1>
            <p className="mt-1 text-sm text-slate-600">Rating thích ứng · công bằng theo agent · kiểm tra lại mỗi {data?.policy?.refresh_hours ?? 24} giờ.</p>
          </div>
          <div className="flex gap-2">
            <button disabled={!data || changing} onClick={toggleScheduler} className="border border-[#253B80] bg-white px-4 py-2 text-xs font-bold disabled:opacity-50">{changing ? "Đang lưu…" : data?.scheduler_enabled ? "Tạm dừng tạo rating" : "Bật tạo rating"}</button>
            <button onClick={rebuildHistory} disabled={rebuilding} className="border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-50">{rebuilding ? "Đang dựng lại..." : "Dựng lại từ lịch sử"}</button>
            <button onClick={load} className="border border-[#ded8d3] bg-white px-4 py-2 text-xs font-bold hover:border-[#253B80]">Làm mới</button>
          </div>
        </div>
        {error && <p className="mb-4 border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
        {rebuildMessage && <p className="mb-4 border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">{rebuildMessage}</p>}
        {data && !data.scheduler_enabled && <p className="mb-4 border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">Đang tạm dừng tạo rating. Validation và các job đã vào queue vẫn tiếp tục; không cần rebuild điểm để bật lại.</p>}
        <p className="mb-4 text-xs text-slate-600">Ổn định khi đủ {data?.policy?.minimum_games ?? 10} trận hợp lệ và σ ≤ {data?.policy?.stable_sigma ?? 2.5}. Ngân sách {data?.policy?.daily_budget ?? 20} trận/agent/24 giờ, gồm lượt đã dành cho trận chờ/chạy. Agent ổn định vẫn có thể giúp đánh giá agent mới. Worker rảnh không đồng nghĩa phải tạo thêm rating.</p>
        <p className="mb-4 text-xs text-slate-600">Agent bắt đầu ở 1000 điểm. Sau 200 nước chưa thắng thì hòa; mỗi bên bị trừ 4–32 điểm theo số quân địch còn lại và khoảng cách trung bình quân mình tới đích. Hòa vẫn giảm σ để tăng độ tin cậy; đủ số trận và đạt ngưỡng σ thì agent chuyển sang ổn định. Mỗi cặp tối đa 2 trận hòa trong 24 giờ; sau đó tìm đối thủ khác.</p>
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Đang self-play", summary?.validating ?? 0], ["Đang chờ", summary?.rating_scheduled ?? 0],
            ["Đang chạy", summary?.rating_running ?? 0], ["Đã xong", summary?.rating_finished ?? 0],
          ].map(([label, value]) => <div key={String(label)} className="border border-[#ded8d3] bg-white p-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-2xl font-bold text-[#253B80]">{value}</p></div>)}
        </div>
        <div className="overflow-hidden border border-[#ded8d3] bg-white">
          <div className="border-b border-[#ded8d3] px-4 py-3 text-sm font-bold">Nhu cầu đánh giá theo agent</div>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-stone-50 text-xs text-slate-500"><tr><th className="px-4 py-3">Agent</th><th className="px-4 py-3">Trạng thái / đánh giá tiếp</th><th className="px-4 py-3 text-right">Trận hợp lệ</th><th className="px-4 py-3 text-right">Còn lượt/24h</th><th className="px-4 py-3 text-right">Rating</th><th className="px-4 py-3 text-right">μ / σ</th><th className="px-4 py-3 text-right">Tin cậy</th></tr></thead>
            <tbody>{data?.agents.map((agent) => <tr key={agent.id} className="border-t border-[#eee]">
              <td className="px-4 py-3"><Link className="font-bold text-[#253B80] hover:underline" href={`/arena/agents/${agent.id}`}>{agent.agent_name}</Link><span className="ml-2 text-xs text-slate-500">@{agent.username}</span></td>
              <td className="px-4 py-3"><span>{scheduleLabels[agent.schedule_state] ?? agent.schedule_state}</span>
                <p className="mt-1 text-xs text-slate-500">{agent.waiting_reason ? "Chờ đối thủ khác chủ, còn ngân sách và hết cooldown."
                  : agent.next_evaluation_at ? new Date(agent.next_evaluation_at).toLocaleString("vi-VN") : "Sau khi trận hiện tại kết thúc"}</p>
              </td>
              <td className="px-4 py-3 text-right font-mono">{agent.valid_games}</td>
              <td className="px-4 py-3 text-right font-mono">{agent.budget_remaining}</td>
              <td className="px-4 py-3 text-right font-mono">{agent.rating}</td>
              <td className="px-4 py-3 text-right font-mono">{Number(agent.trueskill_mu).toFixed(2)} / {Number(agent.trueskill_sigma).toFixed(2)}</td>
              <td className="px-4 py-3 text-right font-mono">{confidence(Number(agent.trueskill_sigma))}%</td>
            </tr>)}</tbody>
          </table></div>
        </div>
        <div className="mt-6 overflow-hidden border border-[#ded8d3] bg-white">
          <div className="border-b border-[#ded8d3] px-4 py-3 text-sm font-bold">Lịch sử cập nhật TrueSkill</div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs"><thead className="bg-stone-50 text-slate-500"><tr><th className="px-4 py-3">Trận</th><th className="px-4 py-3">Kết quả</th><th className="px-4 py-3">Agent 1: μ / σ</th><th className="px-4 py-3">Agent 2: μ / σ</th><th className="px-4 py-3">Rating ±</th></tr></thead>
              <tbody>{data?.matches.map((match) => {
                const hasSnapshot = match.agent1_mu_after !== null && match.agent2_mu_after !== null;
                const outcome = match.is_infra_error ? "Lỗi hạ tầng" : match.outcome === "draw" ? "Hòa" : match.outcome === "agent1" ? `${match.agent1_name} thắng` : match.outcome === "agent2" ? `${match.agent2_name} thắng` : match.status;
                const metric = (before: number | null, after: number | null) => hasSnapshot ? `${Number(before).toFixed(2)} → ${Number(after).toFixed(2)}` : "—";
                const delta = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value}`;
                return <tr key={match.id} className="border-t border-[#eee]"><td className="px-4 py-3 font-medium">{match.agent1_name} <span className="text-slate-400">vs</span> {match.agent2_name}</td><td className="px-4 py-3">{outcome}</td><td className="px-4 py-3 font-mono">{metric(match.agent1_mu_before, match.agent1_mu_after)} / {metric(match.agent1_sigma_before, match.agent1_sigma_after)}</td><td className="px-4 py-3 font-mono">{metric(match.agent2_mu_before, match.agent2_mu_after)} / {metric(match.agent2_sigma_before, match.agent2_sigma_after)}</td><td className="px-4 py-3 font-mono">{delta(match.rating_delta_agent1)} / {delta(match.rating_delta_agent2)}</td></tr>;
              })}</tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
