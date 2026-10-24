"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import Navbar from "@/components/Navbar";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });

type Agent = {
  id: number;
  agent_name: string;
  description: string;
  code: string;
  version: number;
  status: string;
  validation_error: string | null;
  is_active: boolean;
  wins: number;
  losses: number;
  draws: number;
  error_matches: number;
  elo: number;
  trueskill_mu: number;
  trueskill_sigma: number;
  submitted_at: string;
  username: string;
  user_id: number;
};

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-300",
  pending: "bg-slate-100 text-slate-700 border-slate-300",
  validating: "bg-amber-50 text-amber-700 border-amber-300",
  rejected: "bg-rose-50 text-rose-700 border-rose-300",
};

const FILTER_TABS = [
  { value: "", label: "Tất cả" },
  { value: "pending", label: "Chờ duyệt" },
  { value: "validating", label: "Đang kiểm tra" },
  { value: "active", label: "Active" },
  { value: "rejected", label: "Từ chối" },
];

export default function AdminAgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("pending");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const url = filter
        ? `/api/admin/agents?status=${filter}`
        : "/api/admin/agents";
      const res = await fetch(url);
      const data = (await res.json()) as { agents?: Agent[]; error?: string };
      if (data.error) {
        setError(data.error);
        return;
      }
      setAgents(data.agents ?? []);
    } catch {
      setError("Không thể tải danh sách agent.");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  async function patchStatus(agentId: number, status: string, validationError: string | null) {
    setBusy(agentId);
    setError("");
    try {
      const res = await fetch(`/api/arena/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, validation_error: validationError }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Cập nhật thất bại.");
        return;
      }
      await loadAgents();
    } catch {
      setError("Không thể cập nhật agent.");
    } finally {
      setBusy(null);
    }
  }

  async function handleReject(agent: Agent) {
    const reason = prompt(
      `Lý do từ chối agent "${agent.agent_name}" (@${agent.username})?`,
      "Agent không đáp ứng yêu cầu thuật toán."
    );
    if (reason === null) return;
    await patchStatus(agent.id, "rejected", reason || "Bị từ chối bởi admin.");
  }

  async function handleReset(agent: Agent) {
    await patchStatus(agent.id, "validating", null);
  }

  const pendingCount = agents.filter((a) => a.status === "pending").length;

  return (
    <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]">
      <Navbar />

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center justify-between border-b border-[#ded8d3] pb-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
            <Link href="/dashboard" className="hover:text-[#253B80]">Dashboard</Link>
            <span>/</span>
            <Link href="/admin/rating" className="hover:text-[#253B80]">TrueSkill Queue</Link>
            <span>/</span>
            <span className="text-[#1a1e29]">Duyệt Agent</span>
          </div>
          <span className="rounded-none border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-700">
            Admin Area
          </span>
        </div>

        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold text-[#1a1e29]">🤖 Quản lý Agent</h1>
            <p className="mt-1 text-sm text-slate-600">
              Agent tự duyệt qua self-play. Chỉ agent trạng thái active mới được ghép cặp thi đấu.
            </p>
          </div>
          <button
            onClick={loadAgents}
            className="cursor-pointer rounded-none border border-[#ded8d3] bg-white px-4 py-2 text-xs font-bold text-slate-700 transition hover:border-[#253B80]"
          >
            🔄 Làm mới
          </button>
        </div>

        {error && (
          <div className="mb-6 rounded-none border border-rose-300 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
            {error}
          </div>
        )}

        {/* Filter tabs: Khung thẳng */}
        <div className="mb-6 flex flex-wrap gap-1 rounded-none border border-[#ded8d3] bg-white p-1">
          {FILTER_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setFilter(t.value)}
              className={`cursor-pointer rounded-none px-4 py-1.5 text-xs font-bold transition ${
                filter === t.value
                  ? "bg-[#253B80] text-white"
                  : "text-slate-600 hover:text-[#253B80] hover:bg-stone-50"
              }`}
            >
              {t.label}
              {t.value === "pending" && pendingCount > 0 && (
                <span className="ml-1.5 rounded-none bg-rose-600 px-1.5 py-0.2 text-[10px] font-bold text-white">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Agent list */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-none border-2 border-stone-300 border-t-[#253B80]" />
          </div>
        ) : agents.length === 0 ? (
          <div className="rounded-none border border-[#ded8d3] bg-white py-16 text-center shadow-sm">
            <p className="text-sm text-slate-500">
              Không có agent nào{filter ? ` với trạng thái "${filter}"` : ""}.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className="rounded-none border border-[#ded8d3] bg-white p-5 shadow-sm"
              >
                {/* Header row */}
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/arena/agents/${agent.id}`}
                        className="text-lg font-bold text-[#253B80] hover:underline"
                      >
                        {agent.agent_name}
                      </Link>
                      <span className="font-mono text-xs text-slate-500">v{agent.version}</span>
                      <span
                        className={`rounded-none border px-2 py-0.5 text-xs font-bold ${
                          STATUS_BADGE[agent.status] ?? "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {agent.status}
                      </span>
                      {agent.is_active && (
                        <span className="rounded-none border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-700">
                          ✓ Arena Active
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      Tác giả: <strong className="text-[#1a1e29]">@{agent.username}</strong>
                      <span className="ml-2 text-slate-400">
                        · nộp {new Date(agent.submitted_at).toLocaleString("vi-VN")}
                      </span>
                    </p>
                    {agent.description && (
                      <p className="mt-1 text-xs italic text-slate-500">{agent.description}</p>
                    )}
                    {agent.validation_error && (
                      <p className="mt-1 text-xs font-bold text-rose-700">
                        ❌ Lỗi: {agent.validation_error}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-4 font-mono text-xs text-slate-600">
                      <span>
                        Rating: <strong className="text-[#253B80]">{agent.elo}</strong>
                      </span>
                      <span>
                        μ: <strong>{Number(agent.trueskill_mu).toFixed(2)}</strong>
                      </span>
                      <span>
                        σ: <strong>{Number(agent.trueskill_sigma).toFixed(2)}</strong>
                      </span>
                      <span>
                        Tin cậy: <strong>{Math.max(0, Math.min(100, Math.round((1 - Number(agent.trueskill_sigma) / (25 / 3)) * 100)))}%</strong>
                      </span>
                      <span className="font-bold text-emerald-700">W:{agent.wins}</span>
                      <span className="font-bold text-rose-700">L:{agent.losses}</span>
                      <span className="text-slate-700">D:{agent.draws}</span>
                      {agent.error_matches > 0 && (
                        <span className="font-bold text-amber-700">⚠️ {agent.error_matches} lỗi</span>
                      )}
                    </div>
                  </div>

                  {/* Action buttons: Khung thẳng */}
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {(agent.status === "pending" || agent.status === "validating") && (
                      <button
                        onClick={() => handleReject(agent)}
                        disabled={busy === agent.id}
                        className="cursor-pointer rounded-none bg-rose-700 px-4 py-2 text-xs font-bold text-white transition hover:bg-rose-800 disabled:opacity-50"
                      >
                        ❌ Từ chối
                      </button>
                    )}
                    {agent.status === "active" && (
                      <button
                        onClick={() => patchStatus(agent.id, "pending", null)}
                        disabled={busy === agent.id}
                        className="cursor-pointer rounded-none border border-[#ded8d3] bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-[#253B80] disabled:opacity-50"
                      >
                        ↩ Hủy kích hoạt
                      </button>
                    )}
                    {agent.status === "rejected" && (
                      <button
                        onClick={() => handleReset(agent)}
                        disabled={busy === agent.id}
                        className="cursor-pointer rounded-none border border-[#ded8d3] bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-[#253B80] disabled:opacity-50"
                      >
                        ↩ Tự kiểm tra lại
                      </button>
                    )}
                    <button
                      onClick={() => setExpandedId(expandedId === agent.id ? null : agent.id)}
                      className="cursor-pointer rounded-none border border-[#ded8d3] bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-[#253B80]"
                    >
                      {expandedId === agent.id ? "Ẩn code" : "Xem code"}
                    </button>
                  </div>
                </div>

                {/* Code viewer: Khung thẳng */}
                {expandedId === agent.id && (
                  <div className="mt-4 overflow-hidden rounded-none border border-[#ded8d3]">
                    <div className="flex items-center justify-between border-b border-[#ded8d3] bg-stone-100 px-3 py-2">
                      <span className="font-mono text-xs font-bold text-slate-700">
                        {agent.agent_name} v{agent.version} · {agent.code.length.toLocaleString()} ký tự
                      </span>
                    </div>
                    <CodeMirror
                      value={agent.code}
                      height="300px"
                      extensions={[python()]}
                      theme={oneDark}
                      editable={false}
                      basicSetup={{ lineNumbers: true, syntaxHighlighting: true }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
