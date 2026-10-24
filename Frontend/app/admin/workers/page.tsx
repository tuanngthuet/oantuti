"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";

type Control = { revision: number; mode: "running" | "paused" | "stopped"; max_concurrent: number; stop_mode: string };
type Worker = {
  worker_id: string; machine_id?: string; hostname: string; worker_name: string;
  managed: boolean; online: boolean; state?: string; max_concurrent?: number; active_jobs?: number;
  active_task_ids?: string[]; seconds_ago?: number; last_error?: string; applied_revision?: number;
  pid?: number; supervisor_pid?: number; control?: Control;
};
const labels: Record<string, string> = { starting: "Đang khởi động", running: "Đang hoạt động", paused: "Tạm dừng nhận job",
  draining: "Đang hoàn tất các trận", stopping: "Đang dừng", stopped: "Đã dừng xử lý", error: "Cần kiểm tra" };
const button = "cursor-pointer border border-[#ded8d3] bg-white px-3 py-2 text-sm font-semibold hover:border-[#253B80] disabled:cursor-not-allowed disabled:opacity-40";

function WorkerCard({ worker: w, refresh }: { worker: Worker; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState(String(w.control?.max_concurrent ?? w.max_concurrent ?? 4));
  const [dirty, setDirty] = useState(false);
  const [editRevision, setEditRevision] = useState(w.control?.revision ?? 1);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const control = w.control;
  useEffect(() => {
    if (!dirty && control) { setDraft(String(control.max_concurrent)); setEditRevision(control.revision); }
  }, [dirty, control]);
  const pending = Boolean(control && (w.applied_revision ?? 0) < control.revision);
  const active = w.active_jobs ?? 0;
  const busy = saving || !w.online;

  async function change(value: Record<string, unknown>, configuration = false) {
    setSaving(true); setError(""); setMessage("");
    try {
      const res = await fetch(`/api/admin/workers/${w.worker_id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: configuration ? editRevision : control?.revision, ...value }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không gửi được yêu cầu.");
      if (configuration) setDirty(false);
      setMessage(w.online ? "Đã gửi yêu cầu. Đang chờ máy worker xác nhận." : "Đã lưu cấu hình; sẽ áp dụng khi máy kết nối lại.");
    } catch (err) { setError(err instanceof Error ? err.message : "Có lỗi xảy ra."); }
    finally { setSaving(false); await refresh(); }
  }

  return <article className="border border-[#ded8d3] bg-white p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-lg font-bold text-[#253B80]">{w.worker_name}</h3>
        <p className="mt-1 text-sm text-slate-600">{!w.online ? "Mất kết nối supervisor" : w.managed ? labels[w.state ?? "starting"] : "Worker phiên bản cũ"}</p>
        {w.seconds_ago !== undefined && <p className="mt-1 text-xs text-slate-400">Cập nhật {w.seconds_ago}s trước{w.pid ? ` · PID xử lý ${w.pid}` : ""}</p>}
      </div>
      <span className={`border px-3 py-1 text-xs font-bold ${w.online ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-300 text-slate-500"}`}>{w.online ? "Supervisor online" : "Offline"}</span>
    </div>
    <div className="my-4 flex flex-wrap items-center gap-4">
      <p className="text-2xl font-bold">{active}<span className="text-sm font-normal text-slate-500"> / {w.max_concurrent ?? control?.max_concurrent ?? "—"} job đang xử lý</span></p>
      {w.managed && control && <span className={`text-xs ${pending ? "text-amber-700" : "text-emerald-700"}`}>
        {!w.online ? "Cấu hình được giữ lại" : w.state === "error" ? "Cần xử lý lỗi" : pending ? "Đang áp dụng yêu cầu…" : "Đã áp dụng"}
      </span>}
    </div>
    {w.last_error && <p role="alert" className="mb-4 border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{w.last_error}</p>}
    {!w.managed || !control ? <p className="text-sm text-slate-500">Cần nâng cấp worker để điều khiển từ giao diện. Worker này chỉ hỗ trợ xem trạng thái.</p> : <>
      <div className="flex flex-wrap items-end gap-3 border-y border-[#eee] py-4">
        <label className="text-sm font-semibold" htmlFor={`limit-${w.worker_id}`}>Số job đồng thời
          <input id={`limit-${w.worker_id}`} type="number" min={1} max={64} value={draft} disabled={saving}
            onChange={event => { if (!dirty) setEditRevision(control.revision); setDraft(event.target.value); setDirty(true); }}
            className="mt-1 block w-28 border border-[#ded8d3] p-2 font-mono" />
        </label>
        <button className={button} disabled={saving || !dirty || !Number.isInteger(Number(draft)) || Number(draft) < 1 || Number(draft) > 64}
          onClick={() => change({ max_concurrent: Number(draft) }, true)}>Lưu giới hạn</button>
        {dirty && <button className={button} disabled={saving} onClick={() => { setDirty(false); setError(""); }}>Bỏ chỉnh sửa</button>}
        <p className="max-w-md text-xs text-slate-500">Giảm giới hạn sẽ chờ các trận hiện có hoàn tất, không hủy trận đang chạy.</p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className={button} disabled={busy || !["stopped", "error"].includes(w.state ?? "")}
          onClick={() => change({ action: "start" })}>Bật worker</button>
        <button className={button} disabled={busy || control.mode !== "running"} onClick={() => change({ action: "pause" })}>Tạm dừng</button>
        <button className={button} disabled={busy || control.mode !== "paused"} onClick={() => change({ action: "resume" })}>Tiếp tục</button>
        <button className={button} disabled={busy || ["stopped", "draining", "stopping"].includes(w.state ?? "")}
          onClick={() => change({ action: "stop", stop_mode: "graceful" })}>Dừng an toàn</button>
        <button className={`${button} text-rose-700`} disabled={busy || w.state === "stopped"} onClick={() => setConfirmStop(true)}>Dừng ngay</button>
      </div>
      <p className="mt-3 text-xs text-slate-500">Dừng xử lý vẫn giữ supervisor online, nên bạn có thể bật lại từ đây.</p>
    </>}
    {w.active_task_ids && w.active_task_ids.length > 0 && <div className="mt-4 border-t border-[#eee] pt-3">
      <p className="mb-2 text-xs font-bold uppercase text-slate-500">Các trận đang xử lý</p>
      <div className="flex flex-wrap gap-2">{w.active_task_ids.map(task => <span key={task} className="border border-amber-200 bg-amber-50 px-2 py-1 font-mono text-xs">{task}</span>)}</div>
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
    {message && <p role="status" className="mt-3 text-sm text-slate-600">{message}</p>}
    {confirmStop && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby={`stop-${w.worker_id}`}>
      <div className="max-w-md border border-[#ded8d3] bg-white p-6 shadow-xl">
        <h3 id={`stop-${w.worker_id}`} className="text-lg font-bold">Dừng ngay {w.worker_name}?</h3>
        <p className="my-4 text-sm text-slate-600">{active} job đang chạy sẽ bị ngắt và trả về queue để chạy lại. Các worker khác vẫn hoạt động.</p>
        <div className="flex gap-3"><button autoFocus className={button} onClick={() => setConfirmStop(false)}>Quay lại</button>
          <button className={`${button} text-rose-700`} disabled={saving} onClick={() => { setConfirmStop(false); void change({ action: "stop", stop_mode: "immediate" }); }}>Xác nhận dừng ngay</button></div>
      </div>
    </div>}
  </article>;
}

export default function WorkersPage() {
  const router = useRouter();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [depth, setDepth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const inFlight = useRef<Promise<void> | null>(null);
  const load = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const request = (async () => {
      try {
        const response = await fetch("/api/admin/workers", { cache: "no-store" });
        if (response.status === 403) { router.replace("/403"); return; }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Không tải được trạng thái worker.");
        setWorkers(data.workers); setDepth(data.queue_depth); setError("");
      } catch (err) { setError(err instanceof Error ? err.message : "Không tải được trạng thái."); }
      finally { setLoading(false); inFlight.current = null; }
    })();
    inFlight.current = request;
    return request;
  }, [router]);
  useEffect(() => { void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 3000); return () => clearInterval(timer); }, [load]);
  const machines = new Map<string, Worker[]>();
  for (const worker of workers) {
    const key = worker.machine_id ?? worker.hostname;
    machines.set(key, [...(machines.get(key) ?? []), worker]);
  }
  return <div className="min-h-screen bg-[#F5F0ED]"><Navbar />
    <main className="mx-auto max-w-6xl px-4 py-8">
      <Link href="/admin/settings" className="text-sm text-[#253B80] hover:underline">← Trạng thái hệ thống</Link>
      <div className="my-6 flex flex-wrap items-center justify-between gap-4"><div>
        <h1 className="text-3xl font-extrabold">Quản lý worker</h1>
        <p className="mt-2 text-sm text-slate-600">Điều khiển từng worker theo máy · {depth} job đang chờ · cập nhật mỗi 3 giây</p>
      </div><button className={button} onClick={() => void load()}>Làm mới</button></div>
      {error && <p role="alert" className="mb-6 border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error} Dữ liệu cũ được giữ lại.</p>}
      {loading ? <p>Đang tải worker…</p> : workers.length === 0 ? <div className="border bg-white p-8 text-center text-slate-600">
        Chưa có worker. Chạy <code>./dockerworker.sh</code> trên máy Linux có Docker. Worker xử lý agent bằng Python sandbox.
      </div> : [...machines.entries()].map(([id, group]) => <section key={id} className="mb-8">
        <h2 className="mb-1 text-xl font-bold">{group[0].hostname}</h2>
        <p className="mb-4 text-xs text-slate-500">{group.filter(w => w.online).length}/{group.length} supervisor online · {group.reduce((n, w) => n + (w.online ? w.active_jobs ?? 0 : 0), 0)} job đang chạy · tổng giới hạn đã cấu hình {group.reduce((n, w) => n + (w.control?.max_concurrent ?? w.max_concurrent ?? 0), 0)}</p>
        <div className="grid gap-4 lg:grid-cols-2">{group.map(w => <WorkerCard key={w.worker_id} worker={w} refresh={load} />)}</div>
      </section>)}
    </main>
  </div>;
}
