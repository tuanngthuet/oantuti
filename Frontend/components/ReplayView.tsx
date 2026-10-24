"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import { GameBoard, applyMove, flattenBoard, getPieceCounts, PIECE_EMOJI, type Piece } from "@/components/GameBoard";
import Navbar from "@/components/Navbar";

type MoveEntry = {
  move_number: number;
  player: number;
  from_col: number;
  from_row: number;
  to_col: number;
  to_row: number;
  from_pos: string;
  to_pos: string;
  piece_type: string | null;
  captured_type: string | null;
};

type ReplayMatch = {
  id: number;
  status: string;
  outcome: string | null;
  win_reason: string;
  total_moves: number;
  is_infra_error: boolean;
  agent1_id: number;
  agent1_name: string;
  agent1_username: string;
  agent2_id: number;
  agent2_name: string;
  agent2_username: string;
  winner_name: string | null;
  session_name?: string;
  elo_delta_agent1?: number | null;
  elo_delta_agent2?: number | null;
  finished_at: string | null;
};

type ReplayData = {
  match: ReplayMatch;
  moves: MoveEntry[];
  initial_board: (Piece | null)[][];
};

export default function ReplayView({
  apiUrl,
  backLink,
  backLabel = "← Quay lại",
  embedded = false,
}: {
  apiUrl: string;
  backLink: string;
  backLabel?: string;
  embedded?: boolean;
}) {
  const [data, setData] = useState<ReplayData | null>(null);
  const [error, setError] = useState("");
  const [currentStep, setCurrentStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(800);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(''); setPlaying(false); setCurrentStep(0);
    fetch(apiUrl, { signal: controller.signal })
      .then((r) => r.json())
      .then((d: ReplayData | { error: string }) => {
        if ("error" in d) {
          setError(d.error);
          return;
        }
        setData(d);
      })
      .catch(() => { if (!controller.signal.aborted) setError("Không thể tải replay."); });
    return () => controller.abort();
  }, [apiUrl]);

  const boardStates = useMemo(() => {
    if (!data) return [];
    const flat0 = flattenBoard(data.initial_board as Piece[][]);
    const states: Piece[][] = [flat0];
    let current = flat0;
    for (const mv of data.moves) {
      current = applyMove(current, mv);
      states.push(current);
    }
    return states;
  }, [data]);

  const totalSteps = data?.moves.length ?? 0;
  const currentBoard =
    boardStates[currentStep] ??
    (data ? flattenBoard(data.initial_board as Piece[][]) : Array(81).fill(null));
  const currentMove = currentStep > 0 ? data?.moves[currentStep - 1] : null;
  const pieceCounts = getPieceCounts(currentBoard);

  const stepTo = useCallback(
    (step: number) => {
      setCurrentStep(Math.max(0, Math.min(step, totalSteps)));
    },
    [totalSteps]
  );

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setCurrentStep((prev) => {
          if (prev >= totalSteps) {
            setPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, speed);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, speed, totalSteps]);

  if (error && embedded) return <p role="alert" className="p-8 text-rose-700">{error}</p>;
  if (error)
    return (
      <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]">
        <Navbar />
        <main className="flex min-h-[60vh] items-center justify-center px-4">
          <div className="rounded-none border border-rose-300 bg-white p-8 text-center shadow-md">
            <p className="mb-4 text-base font-bold text-rose-700">⚠️ {error}</p>
            <Link
              href={backLink}
              className="rounded-none bg-[#253B80] px-4 py-2 text-xs font-bold text-white hover:bg-[#1d2e66]"
            >
              {backLabel}
            </Link>
          </div>
        </main>
      </div>
    );

  if (!data && embedded) return <p role="status" className="p-8 text-slate-500">Đang tải replay…</p>;
  if (!data)
    return (
      <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]">
        <Navbar />
        <main className="flex min-h-[60vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-none border-2 border-stone-300 border-t-[#253B80]" />
        </main>
      </div>
    );

  const { match, moves } = data;
  const isGameOver = currentStep === totalSteps && totalSteps > 0;

  return (
    <div className={`${embedded ? '' : 'min-h-screen'} bg-[#F5F0ED] text-[#1a1e29]`}>
      {!embedded && <Navbar />}

      <main className={embedded ? 'p-3 sm:p-5' : 'mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8'}>
        {!embedded && <div className="mb-6 flex items-center justify-between border-b border-[#ded8d3] pb-4">
          <Link
            href={backLink}
            className="rounded-none border border-[#ded8d3] bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-[#253B80] hover:text-[#253B80]"
          >
            {backLabel}
          </Link>
          <span className="font-mono text-xs font-bold text-slate-500">
            Trận #{match.id} · {match.session_name ?? "Replay"}
          </span>
        </div>}

        {/* Match header: Khung thẳng */}
        <div className="mb-6 rounded-none border border-[#ded8d3] bg-white p-5 shadow-md">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-6">
              <div className="text-left">
                <p className="text-lg font-bold text-[#253B80]">{match.agent1_name}</p>
                <p className="text-xs text-slate-500">@{match.agent1_username}</p>
                {match.elo_delta_agent1 != null && (
                  <p
                    className={`font-mono text-xs font-bold ${
                      match.elo_delta_agent1 >= 0 ? "text-emerald-700" : "text-rose-700"
                    }`}
                  >
                    {match.elo_delta_agent1 >= 0 ? "+" : ""}
                    {match.elo_delta_agent1} ELO
                  </p>
                )}
              </div>
              <span className="text-2xl font-black text-slate-300">VS</span>
              <div className="text-left">
                <p className="text-lg font-bold text-rose-700">{match.agent2_name}</p>
                <p className="text-xs text-slate-500">@{match.agent2_username}</p>
                {match.elo_delta_agent2 != null && (
                  <p
                    className={`font-mono text-xs font-bold ${
                      match.elo_delta_agent2 >= 0 ? "text-emerald-700" : "text-rose-700"
                    }`}
                  >
                    {match.elo_delta_agent2 >= 0 ? "+" : ""}
                    {match.elo_delta_agent2} ELO
                  </p>
                )}
              </div>
            </div>
            <div className="text-right">
              {match.outcome && (
                <p className="text-lg font-bold text-amber-800">
                  🏆 {match.winner_name ?? "Hòa"}
                </p>
              )}
              {match.is_infra_error && <p className="text-xs font-bold text-amber-700">⚠️ Lỗi hạ tầng</p>}
              <p className="mt-1 text-xs text-slate-600">{match.win_reason}</p>
              <p className="font-mono text-xs text-slate-500">
                Tổng: {totalSteps} nước · Ngày:{" "}
                {match.finished_at ? new Date(match.finished_at).toLocaleDateString("vi-VN") : "—"}
              </p>
            </div>
          </div>
        </div>

        <div className={`grid grid-cols-1 gap-6 ${embedded ? '2xl:grid-cols-[1fr_260px]' : 'xl:grid-cols-[1fr_320px]'}`}>
          {/* Board + controls */}
          <div className="rounded-none border border-[#ded8d3] bg-white p-5 shadow-md">
            {/* Piece counts: Khung thẳng */}
            <div className="mb-4 grid grid-cols-2 gap-3">
              {([1, 2] as const).map((p) => {
                const c = pieceCounts[p];
                const isP1 = p === 1;
                const border = isP1
                  ? "border-[#253B80] bg-[#253B80]/5 text-[#253B80]"
                  : "border-rose-400 bg-rose-50 text-rose-700";
                return (
                  <div key={p} className={`rounded-none border p-3 ${border}`}>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="font-bold text-sm">
                        {isP1 ? "Người chơi 1 (Xanh)" : "Người chơi 2 (Đỏ)"}
                      </span>
                    </div>
                    <div className="flex gap-3 font-mono text-xs text-slate-700">
                      <span>✊ <span className="font-bold text-[#1a1e29]">{c.ROCK}/3</span></span>
                      <span>✋ <span className="font-bold text-[#1a1e29]">{c.PAPER}/4</span></span>
                      <span>✌️ <span className="font-bold text-[#1a1e29]">{c.SCISSORS}/3</span></span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Winner overlay */}
            {isGameOver && match.outcome && (
              <div className="mb-4 rounded-none border border-amber-300 bg-amber-50 px-4 py-2.5 text-center">
                <p className="font-bold text-amber-800">
                  {match.winner_name ? `🏆 ${match.winner_name} thắng cuộc!` : "🤝 Hòa!"}
                </p>
              </div>
            )}

            <div className="flex justify-center bg-[#F5F0ED]/60 p-2 border border-[#ded8d3]">
              <GameBoard board={currentBoard} lastMove={currentMove} />
            </div>

            {/* Playback controls: Khung thẳng */}
            <div className="mt-5 space-y-3 border-t border-[#ded8d3] pt-4">
              {/* Step slider */}
              <div className="flex items-center gap-3">
                <span className="w-14 text-right font-mono text-xs font-bold text-slate-600">
                  {currentStep}/{totalSteps}
                </span>
                <input
                  type="range"
                  aria-label="Nước đi replay"
                  min={0}
                  max={totalSteps}
                  value={currentStep}
                  onChange={(e) => {
                    setPlaying(false);
                    stepTo(Number(e.target.value));
                  }}
                  className="flex-1 accent-[#253B80]"
                />
              </div>

              {/* Buttons: Khung thẳng */}
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  onClick={() => {
                    setPlaying(false);
                    stepTo(0);
                  }}
                  className="cursor-pointer rounded-none border border-[#ded8d3] bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-[#253B80]"
                  title="Về đầu"
                >
                  |◀ Đầu
                </button>
                <button
                  onClick={() => {
                    setPlaying(false);
                    stepTo(currentStep - 1);
                  }}
                  className="cursor-pointer rounded-none border border-[#ded8d3] bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-[#253B80]"
                  title="Lùi 1 bước"
                >
                  ◀ Lùi
                </button>
                <button
                  onClick={() =>
                    setPlaying((p) => {
                      if (p) return false;
                      if (currentStep >= totalSteps) stepTo(0);
                      return true;
                    })
                  }
                  className={`cursor-pointer rounded-none px-5 py-1.5 text-xs font-bold text-white transition ${
                    playing ? "bg-rose-700 hover:bg-rose-800" : "bg-[#253B80] hover:bg-[#1d2e66]"
                  }`}
                >
                  {playing ? "⏸ Dừng" : "▶ Tự động phát"}
                </button>
                <button
                  onClick={() => {
                    setPlaying(false);
                    stepTo(currentStep + 1);
                  }}
                  className="cursor-pointer rounded-none border border-[#ded8d3] bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-[#253B80]"
                  title="Tiến 1 bước"
                >
                  Tiến ▶
                </button>
                <button
                  onClick={() => {
                    setPlaying(false);
                    stepTo(totalSteps);
                  }}
                  className="cursor-pointer rounded-none border border-[#ded8d3] bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-[#253B80]"
                  title="Đến cuối"
                >
                  Cuối ▶|
                </button>
              </div>

              {/* Speed */}
              <div className="flex items-center justify-center gap-3 text-xs text-slate-600">
                <span>Nhanh</span>
                <input
                  type="range"
                  aria-label="Độ trễ mỗi nước (ms)"
                  min={100}
                  max={2000}
                  step={100}
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                  className="w-32 accent-[#253B80]"
                />
                <span>Chậm</span>
                <span className="w-16 font-mono text-slate-500">{speed}ms/nước</span>
              </div>
            </div>
          </div>

          {/* Move log: Khung thẳng */}
          <div className="flex flex-col rounded-none border border-[#ded8d3] bg-white p-5 shadow-md">
            <div className="mb-3 flex items-center justify-between border-b border-[#ded8d3] pb-2">
              <h3 className="text-sm font-bold text-[#1a1e29]">📜 Lịch sử nước đi</h3>
              <span className="font-mono text-xs font-bold text-slate-500">{moves.length} nước</span>
            </div>
            <div className="h-[480px] space-y-1 overflow-y-auto pr-1">
              {moves.map((mv, i) => {
                const step = i + 1;
                const isActive = step === currentStep;
                const pColor = mv.player === 1 ? "text-[#253B80]" : "text-rose-700";
                return (
                  <button
                    key={mv.move_number}
                    onClick={() => {
                      setPlaying(false);
                      stepTo(step);
                    }}
                    className={`w-full cursor-pointer text-left rounded-none px-2.5 py-1.5 text-xs font-mono transition border ${
                      isActive
                        ? "border-[#253B80] bg-[#253B80]/10 font-bold"
                        : "border-transparent text-slate-700 hover:bg-stone-50"
                    }`}
                  >
                    <span className="inline-block w-6 text-slate-400">{step}.</span>
                    <span className={`${pColor} font-bold mr-1`}>P{mv.player}</span>
                    {" "}{mv.from_pos} → {mv.to_pos}
                    {mv.captured_type && (
                      <span className="ml-1 text-amber-700 font-bold"> ×{PIECE_EMOJI[mv.captured_type]}</span>
                    )}
                  </button>
                );
              })}
              {moves.length === 0 && (
                <p className="py-8 text-center text-xs text-slate-400">Chưa có nước đi nào.</p>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
