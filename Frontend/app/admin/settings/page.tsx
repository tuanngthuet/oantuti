"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import { workerActivity } from "@/lib/worker-status";

type ActiveTask = {
  task_id: string;
  type: "rating" | "validation" | "friendly" | "unknown";
  match_id: number;
  agent1_name: string;
  agent2_name: string;
};

type WorkerInfo = {
  worker_id: string;
  judge0_url: string;
  active_jobs: number;
  max_concurrent: number;
  available_slots: number;
  seconds_ago: number;
  active_task_ids: string[];
  active_tasks?: ActiveTask[];
  state?: string | null;
  last_error?: string;
};

type WorkerStatus = {
  workers: WorkerInfo[];
  total_workers: number;
  total_active_jobs: number;
  total_available_slots: number;
  queue_depth: number;
};

type RecentMatch = {
  id: number;
  source: "friendly" | "rating" | "validation";
  queue_state?: string;
  status: string;
  outcome: string | null;
  total_moves: number | null;
  is_infra_error: boolean;
  created_at: string;
  finished_at: string | null;
  created_by_username: string | null;
  agent1_name: string;
  agent2_name: string;
  session_name: string | null;
};

type SystemStatus = {
  backend_online: boolean;
  worker_status_error?: string | null;
  worker_status: WorkerStatus | null;
  recent_matches: RecentMatch[];
  match_stats: { running: number; finished: number; error: number; pending: number };
  match_stats_by_kind?: Record<'rating'|'validation'|'friendly',{running:number;finished:number;error:number;pending:number}>;
};

type TestResult = "idle" | "testing" | "online" | "offline";
type ResetState = "idle" | "loading" | "done" | "error";

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    running:   "border-amber-300 bg-amber-50 text-amber-800",
    finished:  "border-emerald-300 bg-emerald-50 text-emerald-800",
    error:     "border-rose-300 bg-rose-50 text-rose-800",
    pending:   "border-slate-300 bg-slate-50 text-slate-700",
    scheduled: "border-slate-300 bg-slate-50 text-slate-700",
    cancelled: "border-stone-300 bg-stone-50 text-stone-500",
  };
  const label: Record<string, string> = {
    running: "⏳ Đang chạy", finished: "✅ Hoàn tất", error: "❌ Lỗi",
    pending: "🕐 Chờ xử lý", scheduled: "🕐 Scheduled", cancelled: "🚫 Đã hủy",
  };
  return (
    <span className={`rounded-none border px-2 py-0.5 text-[11px] font-bold ${map[status] ?? "border-slate-300 bg-slate-50 text-slate-700"}`}>
      {label[status] ?? status}
    </span>
  );
}

function TaskTypeBadge({ type }: { type: string }) {
  const map: Record<string, string> = {
    rating:   "border-purple-300 bg-purple-50 text-purple-700",
    friendly: "border-blue-200 bg-blue-50 text-blue-700",
    validation: "border-amber-300 bg-amber-50 text-amber-800",
  };
  const icon: Record<string, string> = {
    rating: "🧠", friendly: "🔒", validation: "🧪",
  };
  return (
    <span className={`rounded-none border px-1.5 py-0.5 text-[10px] font-bold ${map[type] ?? "border-slate-300 bg-slate-50 text-slate-500"}`}>
      {icon[type] ?? "?"} {{rating:'Rating',friendly:'Thách đấu riêng',validation:'Validation'}[type]??type}
    </span>
  );
}

export default function AdminSettingsPage() {
  const router = useRouter();
  const [sysStatus, setSysStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [testResult, setTestResult] = useState<TestResult>("idle");
  const [refreshing, setRefreshing] = useState(false);
  const [resetState, setResetState] = useState<ResetState>("idle");
  const [resetMsg, setResetMsg] = useState("");

  const load = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    try {
      const res = await fetch("/api/admin/system-status");
      if (res.status === 401 || res.status === 403) {
        router.push("/login");
        return;
      }
      const data = await res.json() as SystemStatus;
      setSysStatus(data);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => {
    load();
    const interval = setInterval(() => load(), 15_000);
    return () => clearInterval(interval);
  }, [load]);

  async function handleTestBackend() {
    setTestResult("testing");
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "backend_url" }),
      });
      const data = await res.json() as { online?: boolean };
      setTestResult(data.online ? "online" : "offline");
    } catch {
      setTestResult("offline");
    }
  }

  async function handleResetStuck(mode: "error" | "pending") {
    if (!confirm(
      mode === "error"
        ? "Reset tất cả trận RUNNING → ERROR?\n\nCác trận này sẽ không được thử lại tự động."
        : "Reset tất cả trận RUNNING → PENDING (scheduled)?\n\nWorker sẽ tự nhận lại các trận này."
    )) return;

    setResetState("loading");
    setResetMsg("");
    try {
      const res = await fetch(`/api/admin/matches/reset-stuck?mode=${mode}`, { method: "POST" });
      const data = await res.json() as { ok: boolean; reset_rated?: number; reset_friendly?: number; error?: string };
      if (data.ok) {
        const total = (data.reset_rated ?? 0) + (data.reset_friendly ?? 0);
        setResetMsg(
          total > 0
            ? `✅ Reset ${data.reset_rated} rated + ${data.reset_friendly} friendly → ${mode === "error" ? "error" : "scheduled"}`
            : "✅ Không có trận nào bị stuck."
        );
        setResetState("done");
        // Refresh ngay để thấy kết quả
        setTimeout(() => load(true), 500);
      } else {
        setResetMsg(`❌ Lỗi: ${data.error}`);
        setResetState("error");
      }
    } catch {
      setResetMsg("❌ Network error");
      setResetState("error");
    }
    setTimeout(() => { setResetState("idle"); setResetMsg(""); }, 5000);
  }

  const ws = sysStatus?.worker_status;
  const hasStuck = (sysStatus?.match_stats.running ?? 0) > 0;

  return (
    <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]">
      <Navbar />

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Breadcrumb */}
        <div className="mb-6 flex items-center justify-between border-b border-[#ded8d3] pb-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
            <Link href="/dashboard" className="hover:text-[#253B80]">Dashboard</Link>
            <span>/</span>
            <Link href="/admin/rating" className="hover:text-[#253B80]">Admin</Link>
            <span>/</span>
            <span className="text-[#1a1e29]">System Status</span>
          </div>
          <span className="rounded-none border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-700">
            Admin Area
          </span>
        </div>

        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="mb-1 text-3xl font-extrabold text-[#1a1e29]">⚙️ System Status</h1>
            <p className="text-sm text-slate-600">Trạng thái worker, queue và trận đấu gần đây.</p>
          </div>
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="cursor-pointer rounded-none border border-[#ded8d3] bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:border-[#253B80] disabled:opacity-50 transition"
          >
            {refreshing ? "⏳ Đang tải..." : "🔄 Làm mới"}
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-none border-2 border-stone-300 border-t-[#253B80]" />
          </div>
        ) : (
          <div className="space-y-6">

            {/* ── Backend & Queue Stats ── */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-none border border-[#ded8d3] bg-white p-4 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Backend</p>
                <p className={`mt-1 text-xl font-extrabold ${sysStatus?.backend_online ? "text-emerald-600" : "text-rose-600"}`}>
                  {sysStatus?.backend_online ? "🟢 Online" : "🔴 Offline"}
                </p>
              </div>
              <div className="rounded-none border border-[#ded8d3] bg-white p-4 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Workers Active</p>
                <p className="mt-1 text-2xl font-extrabold text-[#253B80]">{ws?.total_workers ?? "—"}</p>
              </div>
              <div className="rounded-none border border-[#ded8d3] bg-white p-4 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Queue Depth</p>
                <p className={`mt-1 text-2xl font-extrabold ${(ws?.queue_depth ?? 0) > 0 ? "text-amber-600" : "text-slate-700"}`}>
                  {ws?.queue_depth ?? "—"}
                </p>
              </div>
              <div className="rounded-none border border-[#ded8d3] bg-white p-4 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Jobs Đang Chạy</p>
                <p className="mt-1 text-2xl font-extrabold text-[#253B80]">{ws?.total_active_jobs ?? "—"}</p>
              </div>
            </div>

            {/* ── Workers List ── */}
            <div className="rounded-none border border-[#ded8d3] bg-white shadow-md">
              <div className="border-b border-[#ded8d3] px-5 py-3 flex items-center justify-between">
                <h2 className="text-sm font-bold text-[#1a1e29]">🖥️ Workers · <Link href="/admin/workers" className="text-[#253B80] underline">Quản lý worker →</Link></h2>
                <span className="text-xs text-slate-500">Cập nhật tự động mỗi 15s</span>
              </div>
              {sysStatus?.worker_status_error && <p role="alert" className="px-5 py-3 text-sm text-amber-700">
                Không lấy được trạng thái worker: {sysStatus.worker_status_error}. Trạng thái backend được kiểm tra riêng qua /health.
              </p>}
              {!ws || ws.workers.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-slate-500">
                  Không có worker nào đang online.{" "}
                  <span className="text-xs">Chạy <code className="bg-stone-100 px-1 font-mono text-[#253B80]">./dockerworker.sh</code> trên máy có Docker.</span>
                </div>
              ) : (
                <div className="divide-y divide-[#ded8d3]">
                  {ws.workers.map((w) => (
                    <div key={w.worker_id} className="px-5 py-4">
                      {/* Header row */}
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-bold text-[#1a1e29]">{w.worker_id}</p>
                          <p className="text-xs text-slate-500">{w.judge0_url}</p>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-slate-600">
                          <span>
                            <span className={`font-bold text-lg ${w.active_jobs > 0 ? "text-amber-600" : "text-[#1a1e29]"}`}>
                              {w.active_jobs}
                            </span>
                            <span className="text-slate-500">/{w.max_concurrent} jobs</span>
                          </span>
                          <span className={`font-bold ${w.available_slots > 0 ? "text-emerald-600" : "text-amber-600"}`}>
                            {w.available_slots} slot trống
                          </span>
                          <span className="text-slate-400">{w.seconds_ago}s trước</span>
                        </div>
                        {/* Progress bar */}
                        <div className="w-full sm:w-32 h-1.5 bg-stone-100 rounded-none">
                          <div
                            className="h-1.5 bg-[#253B80] transition-all"
                            style={{ width: `${Math.min(100, (w.active_jobs / Math.max(1, w.max_concurrent)) * 100)}%` }}
                          />
                        </div>
                      </div>

                      {/* Active task list */}
                      {w.active_tasks && w.active_tasks.length > 0 ? (
                        <div className="mt-3 space-y-1.5">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Đang xử lý:</p>
                          {w.active_tasks.map((task) => (
                            <div
                              key={task.task_id}
                              className="flex items-center gap-2 rounded-none border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs"
                            >
                              <TaskTypeBadge type={task.type} />
                              <span className="font-mono text-slate-500">#{task.match_id}</span>
                              <span className="font-medium text-[#253B80]">{task.agent1_name}</span>
                              <span className="text-slate-400">{task.type==='validation'?'· Self-play':'vs'}</span>
                              {task.type!=='validation'&&<span className="font-medium text-rose-600">{task.agent2_name}</span>}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-2 text-xs text-slate-400 italic">
                          {workerActivity(w, ws.queue_depth)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Match Stats + Reset Stuck ── */}
            <div className="rounded-none border border-[#ded8d3] bg-white shadow-md">
              <div className="border-b border-[#ded8d3] px-5 py-3 flex items-center justify-between gap-4 flex-wrap">
                <h2 className="text-sm font-bold text-[#1a1e29]">🎮 Tất cả tác vụ · Validation, Rating và Thách đấu</h2>
                {/* Reset stuck buttons */}
                <div className="flex items-center gap-2 flex-wrap">
                  {resetMsg && (
                    <span className={`text-xs font-semibold ${resetState === "error" ? "text-rose-600" : "text-emerald-700"}`}>
                      {resetMsg}
                    </span>
                  )}
                  <button
                    onClick={() => handleResetStuck("pending")}
                    disabled={resetState === "loading" || !hasStuck}
                    title="Reset các trận running → scheduled để worker tự nhận lại"
                    className={`cursor-pointer rounded-none border px-3 py-1 text-xs font-bold transition disabled:opacity-40
                      ${hasStuck
                        ? "border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100"
                        : "border-slate-300 bg-slate-50 text-slate-500"}`}
                  >
                    {resetState === "loading" ? "⏳..." : "🔁 Reset → Pending"}
                  </button>
                  <button
                    onClick={() => handleResetStuck("error")}
                    disabled={resetState === "loading" || !hasStuck}
                    title="Reset các trận running → error (dừng hoàn toàn)"
                    className={`cursor-pointer rounded-none border px-3 py-1 text-xs font-bold transition disabled:opacity-40
                      ${hasStuck
                        ? "border-rose-400 bg-rose-50 text-rose-800 hover:bg-rose-100"
                        : "border-slate-300 bg-slate-50 text-slate-500"}`}
                  >
                    {resetState === "loading" ? "⏳..." : "🗑️ Reset → Error"}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-4 divide-x divide-[#ded8d3]">
                {(["running", "finished", "error", "pending"] as const).map((s) => (
                  <div key={s} className="p-4 text-center">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{{running:'Đang chạy',finished:'Hoàn tất',error:'Lỗi',pending:'Chờ xử lý (scheduled)'}[s]}</p>
                    <p className={`mt-1 text-xl font-extrabold ${
                      s === "running" ? "text-amber-600" :
                      s === "finished" ? "text-emerald-600" :
                      s === "error" ? "text-rose-600" : "text-slate-700"
                    }`}>
                      {sysStatus?.match_stats[s] ?? 0}
                    </p>
                  </div>
                ))}
              </div>
              <div className="grid gap-3 border-t border-[#ded8d3] bg-stone-50 p-4 sm:grid-cols-3">
                {(['validation','rating','friendly'] as const).map(kind=>{const stats=sysStatus?.match_stats_by_kind?.[kind];return <div key={kind} className="border border-[#ded8d3] bg-white p-3"><TaskTypeBadge type={kind}/><p className="mt-2 text-xs text-slate-600">Chờ <strong>{stats?.pending??0}</strong> · Chạy <strong>{stats?.running??0}</strong> · Xong {stats?.finished??0} · Lỗi {stats?.error??0}</p></div>;})}
              </div>
            </div>

            {/* ── Recent Matches ── */}
            <div className="rounded-none border border-[#ded8d3] bg-white shadow-md">
              <div className="border-b border-[#ded8d3] px-5 py-3">
                <h2 className="text-sm font-bold text-[#1a1e29]">📋 Trận gần đây (20 trận mới nhất)</h2>
                <p className="mt-1 text-xs text-slate-500">Gồm cả self-play kiểm tra agent. Scheduled: đã tạo trận; “Đã gửi queue” chưa có nghĩa worker đã bắt đầu chạy.</p>
                <p className="mt-1 text-xs text-slate-500">Luật mới: Validation tối đa 60 nước; Rating/Thách đấu 150 nước tổng hai bên. Hòa khi hết nước hoặc cùng thế cờ, cùng bên tới lượt lặp lần thứ 3. Lịch sử cũ giữ nguyên.</p>
              </div>
              {!sysStatus?.recent_matches.length ? (
                <div className="px-5 py-8 text-center text-sm text-slate-500">Chưa có trận nào.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[#ded8d3] text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        <th className="px-4 py-2">ID</th>
                        <th className="px-4 py-2">Loại</th>
                        <th className="px-4 py-2">Tạo bởi</th>
                        <th className="px-4 py-2">Agent 1 vs 2</th>
                        <th className="px-4 py-2">Trạng thái</th>
                        <th className="px-4 py-2">Kết quả</th>
                        <th className="px-4 py-2">Nước</th>
                        <th className="px-4 py-2">Thời gian</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#ded8d3]">
                      {sysStatus.recent_matches.map((m, i) => (
                        <tr key={`${m.source}-${m.id}-${i}`} className="hover:bg-stone-50 transition">
                          <td className="px-4 py-2 font-mono text-slate-500">#{m.id}</td>
                          <td className="px-4 py-2">
                            <TaskTypeBadge type={m.source}/>
                          </td>
                          <td className="px-4 py-2 text-slate-600">{m.created_by_username?`@${m.created_by_username}`:'Tự động'}</td>
                          <td className="px-4 py-2 font-medium">
                            <span className="text-[#253B80]">{m.agent1_name}</span>
                            {m.source==='validation'?<span className="ml-2 text-slate-500">· Self-play</span>:<><span className="text-slate-400 mx-1">vs</span><span className="text-rose-600">{m.agent2_name}</span></>}
                          </td>
                          <td className="px-4 py-2"><StatusBadge status={m.status} />{m.status==='scheduled'&&<p className="mt-1 text-[10px] text-slate-500">{m.queue_state==='queued'?'Đã gửi queue · chờ worker':'Chờ gửi vào queue'}</p>}</td>
                          <td className="px-4 py-2 text-slate-600">
                            {m.status === "finished"
                              ? (m.source==='validation'?'Đã chạy self-play':m.outcome === "agent1" ? "🏆 A1 thắng" : m.outcome === "agent2" ? "🏆 A2 thắng" : "🤝 Hòa")
                              : m.is_infra_error ? "⚠️ lỗi hạ tầng" : "—"}
                          </td>
                          <td className="px-4 py-2 text-slate-600">{m.total_moves ?? "—"}</td>
                          <td className="px-4 py-2 text-slate-400 whitespace-nowrap">
                            {new Date(m.created_at).toLocaleString("vi-VN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── Backend URL Info ── */}
            <div className="rounded-none border border-[#ded8d3] bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-bold text-[#1a1e29]">🌐 Backend URL</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Đọc từ biến môi trường <code className="bg-stone-100 px-1 font-mono text-[#253B80]">BACKEND_URL</code> trên Vercel.
                    Để thay đổi: cập nhật env var → redeploy.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {testResult !== "idle" && (
                    <span className={`rounded-none border px-3 py-1 text-xs font-bold ${
                      testResult === "testing" ? "border-amber-300 bg-amber-50 text-amber-800" :
                      testResult === "online"  ? "border-emerald-300 bg-emerald-50 text-emerald-800" :
                                                 "border-rose-300 bg-rose-50 text-rose-800"
                    }`}>
                      {testResult === "testing" ? "⏳ Testing..." : testResult === "online" ? "🟢 Online" : "🔴 Offline"}
                    </span>
                  )}
                  <button
                    onClick={handleTestBackend}
                    disabled={testResult === "testing"}
                    className="cursor-pointer rounded-none border border-[#ded8d3] bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:border-[#253B80] disabled:opacity-50 transition"
                  >
                    🔌 Test kết nối
                  </button>
                </div>
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
}
