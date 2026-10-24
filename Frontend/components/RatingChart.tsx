'use client';
import { useEffect, useState } from 'react';
type Point = { match_id: number; finished_at: string; before: number; after: number };
export default function RatingChart({ agentId, refresh = 0 }: { agentId: number; refresh?: number }) {
  const [points, setPoints] = useState<Point[]>([]);
  const [state, setState] = useState('loading');
  useEffect(() => { setPoints([]); setState('loading'); }, [agentId]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/arena/agents/${agentId}/rating-history`, { signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error();
      const data = await r.json(); setPoints(data.points); setState('ready');
    }).catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [agentId, refresh]);
  if (!points.length) return <p className="py-3 text-xs text-slate-500">{state === 'loading' ? 'Đang tải biểu đồ…' : state === 'error' ? 'Không thể tải biểu đồ điểm.' : 'Chưa có lịch sử điểm rating.'}</p>;
  const values = [points[0].before, ...points.map(p => p.after)];
  const times = [Date.parse(points[0].finished_at), ...points.map(p => Date.parse(p.finished_at))];
  const duration = times[times.length - 1] - times[0];
  const min = values.reduce((a, b) => Math.min(a, b)), max = values.reduce((a, b) => Math.max(a, b));
  const coords = values.map((v, i) => `${10 + (duration > 0 ? (times[i] - times[0]) / duration : i / Math.max(1, values.length - 1)) * 280},${70 - (v - min) / Math.max(1, max - min) * 55}`).join(' ');
  return <figure aria-label="Biểu đồ điểm rating" className="py-3">
    <div className="flex justify-between text-xs text-slate-500"><span>{min} – {max}</span><span>{points.length} trận</span></div>
    <svg viewBox="0 0 300 85" role="img" aria-label={`Điểm từ ${values[0]} đến ${values.at(-1)}`} className="w-full h-24">
      <polyline points={coords} fill="none" stroke="#253B80" strokeWidth="2" />
    </svg>
    <figcaption className="text-xs text-slate-500">Điểm hiện tại: {values.at(-1)} · Lịch sử riêng của agent</figcaption>
    <div className="mt-1 flex justify-between text-[10px] text-slate-400"><span>{new Date(times[0]).toLocaleString('vi-VN')}</span><span>{new Date(times[times.length - 1]).toLocaleString('vi-VN')}</span></div>
  </figure>;
}
