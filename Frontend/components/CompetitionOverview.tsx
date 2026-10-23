"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import overviewBannerImg from "@/source/images/overviewbanner.png";

type TabId =
  | "overview"
  | "rules"
  | "getting-started"
  | "local-runner"
  | "evaluation"
  | "finals"
  | "regulations";

export default function CompetitionOverview() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyCode = (code: string, index: number) => {
    navigator.clipboard.writeText(code);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const starterTemplate = `import random

def agent(observation, configuration):
    """
    Agent thi đấu OTTv2 Arena.
    
    observation:
      - valid_moves: list[{from_col, from_row, to_col, to_row, is_capture}]
      - board: list[81] -> None hoặc {player: 1|2, type: "ROCK"|"PAPER"|"SCISSORS"}
      - current_player: 1 hoặc 2
      - piece_counts: {"1": {ROCK:n, PAPER:n, SCISSORS:n}, "2": {...}}
      - move_count: int
      
    Trả về dict: {"from_col": int, "from_row": int, "to_col": int, "to_row": int}
    """
    moves = observation.get("valid_moves", [])
    if not moves:
        return None
    
    # Chọn ngẫu nhiên 1 nước đi hợp lệ
    chosen = random.choice(moves)
    return {
        "from_col": chosen["from_col"],
        "from_row": chosen["from_row"],
        "to_col": chosen["to_col"],
        "to_row": chosen["to_row"]
    }
`;


  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "overview", label: "Tổng quan", icon: "📌" },
    { id: "rules", label: "Luật thi đấu", icon: "📜" },
    { id: "getting-started", label: "Hướng dẫn & Code mẫu", icon: "💻" },
    { id: "local-runner", label: "Local Runner & Test máy", icon: "🛠️" },
    { id: "evaluation", label: "Đánh giá & Xếp hạng", icon: "📈" },
    { id: "finals", label: "Vòng Chung kết", icon: "🏆" },
    { id: "regulations", label: "Quy chế & Liêm chính", icon: "⚖️" },
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* ─── HEADER PHONG CÁCH KAGGLE COMPETITION (RÚT GỌN) ────────────── */}
      <div className="border border-[#ded8d3] bg-white p-6 shadow-md sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-extrabold tracking-tight text-[#1a1e29] sm:text-3xl">
              OTTv2 Arena – Oẳn Tù Tì v2
            </h1>
            <span className="inline-flex items-center gap-1.5 border border-[#253B80] bg-[#253B80]/10 px-2.5 py-1 text-xs font-bold text-[#253B80]">
              <span className="h-1.5 w-1.5 bg-[#253B80]" />
              Simulation Competition
            </span>
            <span className="border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
              Đang diễn ra
            </span>
          </div>
          <div className="text-xs text-slate-500">
            Nền tảng thi đấu cờ OTT
          </div>
        </div>

        {/* ─── SUB-NAVIGATION TABS (PHONG CÁCH KAGGLE) ────────────────── */}
        <div className="mt-6 flex overflow-x-auto border-b border-[#ded8d3] scrollbar-none">
          {tabs.map((tab) => {
            const isCurrent = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex shrink-0 items-center gap-2 border-b-2 px-5 py-3 text-sm font-bold transition-all ${
                  isCurrent
                    ? "border-[#253B80] text-[#253B80] bg-[#253B80]/5"
                    : "border-transparent text-slate-600 hover:border-slate-300 hover:text-[#1a1e29]"
                }`}
              >
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── NỘI DUNG TỪNG TAB ────────────────────────────────────────── */}
      <div className="mt-6 border border-[#ded8d3] bg-white p-6 shadow-md sm:p-8">
        {/* TAB 1: TỔNG QUAN */}
        {activeTab === "overview" && (
          <div className="space-y-8">
            <section>
              <h2 className="text-2xl font-bold text-[#1a1e29]">
                Giới thiệu Cuộc thi OTTv2 Arena
              </h2>
              <p className="mt-3 leading-relaxed text-slate-700">
                Mỗi thí sinh hoặc đội thi sẽ đóng vai trò là kiến trúc sư chiến lược, xây dựng một <strong>Agent (Bot Python)</strong> có khả năng nhận dữ liệu bàn cờ ở mỗi lượt đi, tính toán các nước đi hợp lệ, đánh giá tình thế và đưa ra quyết định tối ưu trong thời gian thực.
              </p>
            </section>
            <div className="overflow-hidden border border-[#ded8d3]">
              <div className="relative aspect-[16/9] w-full max-h-[420px]">
                <Image
                  src={overviewBannerImg}
                  alt="OTTv2 Arena"
                  fill
                  className="object-cover object-center"
                />
              </div>
            </div>

            {/* Lịch trình các giai đoạn */}
            <section className="border-t border-[#ded8d3] pt-6">
              <h3 className="text-xl font-bold text-[#1a1e29]">
                Quy trình Giải đấu
              </h3>
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-4">
                <div className="border border-[#ded8d3] bg-white p-4">
                  <span className="font-mono text-xs font-bold text-[#253B80]">GIAI ĐOẠN 1</span>
                  <h4 className="mt-1 font-bold text-[#1a1e29]">Lập trình & Nộp bài</h4>
                  <p className="mt-1 text-xs text-slate-600">
                    Viết code bot Python, kiểm tra self-play tự động và kích hoạt vào đấu trường.
                  </p>
                </div>
                <div className="border border-[#ded8d3] bg-white p-4">
                  <span className="font-mono text-xs font-bold text-[#253B80]">GIAI ĐOẠN 2</span>
                  <h4 className="mt-1 font-bold text-[#1a1e29]">Đấu Trường Xếp Hạng</h4>
                  <p className="mt-1 text-xs text-slate-600">
                    Matchmaker tự động ghép cặp 24/7. Tích lũy điểm Rating, cạnh tranh trên Leaderboard.
                  </p>
                </div>
                <div className="border border-[#ded8d3] bg-white p-4">
                  <span className="font-mono text-xs font-bold text-[#253B80]">GIAI ĐOẠN 3</span>
                  <h4 className="mt-1 font-bold text-[#1a1e29]">Thách Đấu Giao Hữu</h4>
                  <p className="mt-1 text-xs text-slate-600">
                    Sử dụng 10 lượt/ngày thử nghiệm chiến thuật ẩn danh với bot public của đối thủ mà không đổi điểm số.
                  </p>
                </div>
                <div className="border border-[#ded8d3] bg-white p-4">
                  <span className="font-mono text-xs font-bold text-[#253B80]">GIAI ĐOẠN 4</span>
                  <h4 className="mt-1 font-bold text-[#1a1e29]">Chung Kết Knockout</h4>
                  <p className="mt-1 text-xs text-slate-600">
                    Top 16 hạt giống thi đấu đối kháng trực tiếp Best-of-2 đổi bên, có engine khóa riêng theo từng vòng.
                  </p>
                </div>
              </div>
            </section>

            {/* Các đặc trưng then chốt: 1 Nhóm 1-3 thành viên/cá nhân, 2 Python 3 Sandbox an toàn, 3 Bàn cờ 9x9 (81 ô) với Tối đa 200 nước */}
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="border border-[#ded8d3] bg-[#F5F0ED]/40 p-5">
                <div className="text-2xl">👥</div>
                <h3 className="mt-2 text-base font-bold text-[#1a1e29]">
                  1. Nhóm 1–3 thành viên / Cá nhân
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                  Thí sinh có thể thi đấu độc lập với tư cách Cá nhân hoặc lập Đội nhóm từ 1 đến 3 thành viên. Agent nộp cho team là tài sản chung của đội.
                </p>
              </div>

              <div className="border border-[#ded8d3] bg-[#F5F0ED]/40 p-5">
                <div className="text-2xl">🛡️</div>
                <h3 className="mt-2 text-base font-bold text-[#1a1e29]">
                  2. Python 3 Sandbox an toàn
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                  Hệ thống worker thực thi Python trong môi trường Bubblewrap/seccomp cô lập, công bằng tuyệt đối về thời gian CPU (1.0s) và bộ nhớ (256MB).
                </p>
              </div>

              <div className="border border-[#ded8d3] bg-[#F5F0ED]/40 p-5">
                <div className="text-2xl">♟️</div>
                <h3 className="mt-2 text-base font-bold text-[#1a1e29]">
                  3. Bàn cờ 9×9 (81 ô) với Tối đa 200 nước
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                  Bàn cờ 81 ô với 10 quân mỗi bên. Mỗi trận đấu tối đa 200 nước; nếu hòa sẽ tính điểm trừ dựa vào vị trí quân và số quân còn lại trên bàn.
                </p>
              </div>
            </section>
          </div>
        )}

        {/* TAB 2: LUẬT THI ĐẤU */}
        {activeTab === "rules" && (
          <div className="space-y-8">
            <section>
              <h2 className="text-2xl font-bold text-[#1a1e29]">
                Luật thi đấu Bàn cờ Oẳn Tù Tì v2 (OTTv2)
              </h2>
              <p className="mt-2 text-slate-600">
                Thí sinh cần nắm vững các luật sau để thiết kế hàm đánh giá và tìm kiếm.
              </p>
            </section>

            {/* Bàn cờ và Tọa độ */}
            <section>
              <h3 className="text-lg font-bold text-[#1a1e29]">
                1. Bàn cờ 9×9 & Hệ tọa độ
              </h3>
              <div className="mt-3 border border-[#ded8d3] p-5 bg-[#F5F0ED]/20">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="text-sm leading-relaxed text-slate-700">
                    <ul className="list-disc space-y-1.5 pl-5">
                      <li>Bàn cờ có kích thước <strong>9 hàng × 9 cột</strong> (tổng cộng 81 ô).</li>
                      <li>Cột được đánh chữ cái: <code className="bg-slate-100 px-1 font-mono">a, b, c, d, e, f, g, h, i</code> (chỉ số <code>from_col</code>, <code>to_col</code> từ 0 đến 8).</li>
                      <li>Hàng được đánh số: <code className="bg-slate-100 px-1 font-mono">1, 2, 3, 4, 5, 6, 7, 8, 9</code> (chỉ số <code>from_row</code>, <code>to_row</code> từ 0 đến 8).</li>
                      <li>
                        <strong>Player 1 (Xanh #253B80)</strong>: Căn cứ tại góc dưới bên trái <code className="font-bold text-[#253B80]">a1</code> (col=0, row=0). Đi trước.
                      </li>
                      <li>
                        <strong>Player 2 (Đỏ #b91c1c)</strong>: Căn cứ tại góc trên bên phải <code className="font-bold text-rose-700">i9</code> (col=8, row=8).
                      </li>
                    </ul>
                  </div>
                  <div className="border border-[#ded8d3] bg-white p-4 text-xs font-mono">
                    <div className="font-bold text-slate-500 mb-2">{"// Vị trí căn cứ"}</div>
                    <p>• Player 1 Mục tiêu: Đi quân đến ô <strong>i9</strong> (col=8, row=8)</p>
                    <p>• Player 2 Mục tiêu: Đi quân đến ô <strong>a1</strong> (col=0, row=0)</p>
                    <p className="mt-2 text-slate-500">{"// Index chuyển đổi: index = row * 9 + col"}</p>
                  </div>
                </div>
              </div>
            </section>

            {/* Quân cờ và Bảng Tương khắc */}
            <section>
              <h3 className="text-lg font-bold text-[#1a1e29]">
                2. Lực lượng Quân cờ & Quy luật Tương khắc
              </h3>
              <p className="mt-2 text-sm text-slate-600">
                Mỗi người chơi khởi đầu với đúng <strong>10 quân cờ</strong>:
              </p>

              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="border border-[#ded8d3] bg-white p-4">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">✊</span>
                    <div>
                      <h4 className="font-bold text-[#1a1e29]">ĐẤM (ROCK)</h4>
                      <span className="text-xs font-semibold text-slate-500">Số lượng: 3 quân</span>
                    </div>
                  </div>
                  <div className="mt-3 text-xs text-slate-600 space-y-1">
                    <p className="text-emerald-700 font-semibold">✓ Thắng Kéo (Ăn KÉO)</p>
                    <p className="text-rose-700">✗ Thua Lá (Bị LÁ ăn)</p>
                    <p className="text-slate-500">= Hòa Đấm (Không thể đi vào)</p>
                  </div>
                </div>

                <div className="border border-[#ded8d3] bg-white p-4">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">✋</span>
                    <div>
                      <h4 className="font-bold text-[#1a1e29]">LÁ (PAPER)</h4>
                      <span className="text-xs font-semibold text-slate-500">Số lượng: 4 quân</span>
                    </div>
                  </div>
                  <div className="mt-3 text-xs text-slate-600 space-y-1">
                    <p className="text-emerald-700 font-semibold">✓ Thắng Đấm (Ăn ĐẤM)</p>
                    <p className="text-rose-700">✗ Thua Kéo (Bị KÉO ăn)</p>
                    <p className="text-slate-500">= Hòa Lá (Không thể đi vào)</p>
                  </div>
                </div>

                <div className="border border-[#ded8d3] bg-white p-4">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">✌️</span>
                    <div>
                      <h4 className="font-bold text-[#1a1e29]">KÉO (SCISSORS)</h4>
                      <span className="text-xs font-semibold text-slate-500">Số lượng: 3 quân</span>
                    </div>
                  </div>
                  <div className="mt-3 text-xs text-slate-600 space-y-1">
                    <p className="text-emerald-700 font-semibold">✓ Thắng Lá (Ăn LÁ)</p>
                    <p className="text-rose-700">✗ Thua Đấm (Bị ĐẤM ăn)</p>
                    <p className="text-slate-500">= Hòa Kéo (Không thể đi vào)</p>
                  </div>
                </div>
              </div>

              {/* Bảng tương tác ma trận */}
              <div className="mt-4 overflow-x-auto">
                <table className="w-full border-collapse border border-[#ded8d3] text-left text-xs sm:text-sm">
                  <thead className="bg-[#F5F0ED]">
                    <tr>
                      <th className="border border-[#ded8d3] p-2.5 font-bold">Quân đi vào \ Quân tại ô</th>
                      <th className="border border-[#ded8d3] p-2.5 font-bold">✊ Đấm (ROCK)</th>
                      <th className="border border-[#ded8d3] p-2.5 font-bold">✋ Lá (PAPER)</th>
                      <th className="border border-[#ded8d3] p-2.5 font-bold">✌️ Kéo (SCISSORS)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="border border-[#ded8d3] p-2.5 font-bold bg-[#F5F0ED]/50">✊ Đấm (ROCK)</td>
                      <td className="border border-[#ded8d3] p-2.5 text-slate-400">Không hợp lệ (cùng loại)</td>
                      <td className="border border-[#ded8d3] p-2.5 text-rose-600 font-medium">Bị chặn (Thua Lá)</td>
                      <td className="border border-[#ded8d3] p-2.5 text-emerald-700 font-bold bg-emerald-50/50">Ăn Kéo (Thắng)</td>
                    </tr>
                    <tr>
                      <td className="border border-[#ded8d3] p-2.5 font-bold bg-[#F5F0ED]/50">✋ Lá (PAPER)</td>
                      <td className="border border-[#ded8d3] p-2.5 text-emerald-700 font-bold bg-emerald-50/50">Ăn Đấm (Thắng)</td>
                      <td className="border border-[#ded8d3] p-2.5 text-slate-400">Không hợp lệ (cùng loại)</td>
                      <td className="border border-[#ded8d3] p-2.5 text-rose-600 font-medium">Bị chặn (Thua Kéo)</td>
                    </tr>
                    <tr>
                      <td className="border border-[#ded8d3] p-2.5 font-bold bg-[#F5F0ED]/50">✌️ Kéo (SCISSORS)</td>
                      <td className="border border-[#ded8d3] p-2.5 text-rose-600 font-medium">Bị chặn (Thua Đấm)</td>
                      <td className="border border-[#ded8d3] p-2.5 text-emerald-700 font-bold bg-emerald-50/50">Ăn Lá (Thắng)</td>
                      <td className="border border-[#ded8d3] p-2.5 text-slate-400">Không hợp lệ (cùng loại)</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* Quy tắc di chuyển */}
            <section>
              <h3 className="text-lg font-bold text-[#1a1e29]">
                3. Quy tắc Di chuyển
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">
                Ở mỗi lượt đi, một quân cờ có thể di chuyển <strong>1 bước theo 8 hướng</strong> (ngang, dọc, chéo) sang ô liền kề, với các điều kiện:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                <li>Không được di chuyển ra ngoài phạm vi bàn cờ (col 0..8, row 0..8).</li>
                <li>Không được đi vào ô đang có quân của chính mình.</li>
                <li>Được đi vào ô trống bất kỳ trong 8 hướng liền kề.</li>
                <li>Chỉ được đi vào ô có quân của đối thủ khi quân mình <strong>khắc chế thắng</strong> quân đối thủ.</li>
              </ul>
            </section>

            {/* 4 Điều kiện Chiến Thắng */}
            <section className="border-t border-[#ded8d3] pt-6">
              <h3 className="text-lg font-bold text-[#1a1e29]">
                4. Điều kiện Chiến Thắng
              </h3>
              <p className="mt-2 text-sm text-slate-600">
                Ván đấu kết thúc ngay lập tức khi một trong bốn điều kiện sau xảy ra:
              </p>

              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="border border-emerald-300 bg-emerald-50/50 p-4">
                  <span className="font-bold text-emerald-800">Điều kiện 1 & 2: Chiếm căn cứ địch</span>
                  <ul className="mt-2 space-y-1.5 text-xs sm:text-sm text-emerald-900">
                    <li>🎯 <strong>Player 1 thắng</strong>: Khi đưa bất kỳ quân nào của mình vào ô đích <code className="font-mono font-bold">i9</code>.</li>
                    <li>🎯 <strong>Player 2 thắng</strong>: Khi đưa bất kỳ quân nào của mình vào ô đích <code className="font-mono font-bold">a1</code>.</li>
                  </ul>
                </div>

                <div className="border border-indigo-300 bg-indigo-50/50 p-4">
                  <span className="font-bold text-indigo-800">Điều kiện 3 & 4: Tuyệt diệt 1 loại quân đối thủ</span>
                  <ul className="mt-2 space-y-1.5 text-xs sm:text-sm text-indigo-900">
                    <li>⚔️ <strong>Player 1 thắng</strong>: Khi tiêu diệt sạch 1 loại quân của Player 2 (bắt hết cả 3 Đấm, HOẶC hết cả 4 Lá, HOẶC hết cả 3 Kéo).</li>
                    <li>⚔️ <strong>Player 2 thắng</strong>: Khi tiêu diệt sạch 1 loại quân của Player 1.</li>
                  </ul>
                </div>
              </div>
            </section>

            {/* Giới hạn số nước & Luật xử hòa */}
            <section className="border-t border-[#ded8d3] pt-6">
              <h3 className="text-lg font-bold text-[#1a1e29]">
                5. Các quy tắc khác
              </h3>
              <div className="mt-2 space-y-2 text-sm text-slate-700">
                <p>
                  • Ván đấu giới hạn tối đa <strong>200 nước đi</strong> (tương đương mỗi bên thực hiện 100 lượt).
                </p>
                <p>
                  • Nếu sau 200 nước mà chưa có bên nào đạt điều kiện thắng, ván đấu kết thúc với kết quả <strong>HÒA (DRAW)</strong>.
                </p>
                <p>
                  • <strong>Luật phạt hòa (Draw Penalty)</strong>: Trong các trận đấu Xếp hạng (Rating), trận hòa sẽ áp dụng thuật toán trừ điểm phạt theo tương quan số lượng quân còn lại và vị trí trên bàn cờ. Điều này khuyến khích thí sinh lập trình bot có lối chơi chủ động tấn công thay vì phòng thủ thụ động.
                </p>
              </div>
            </section>
          </div>
        )}

        {/* TAB 3: HƯỚNG DẪN & CODE MẪU */}
        {activeTab === "getting-started" && (
          <div className="space-y-8">
            <section>
              <h2 className="text-2xl font-bold text-[#1a1e29]">
                Hướng dẫn Lập trình & Nộp Agent
              </h2>
              <p className="mt-2 text-slate-600">
                Tìm hiểu cấu trúc hàm Agent Python và tham khảo các đoạn code mẫu để bắt đầu nhanh chóng.
              </p>
            </section>

            {/* Đặc tả hàm Agent */}
            <section>
              <h3 className="text-lg font-bold text-[#1a1e29]">
                1. Đặc tả Giao thức Agent (Interface Specification)
              </h3>
              <p className="mt-2 text-sm text-slate-700">
                File code nộp lên hệ thống bắt buộc phải chứa hàm định nghĩa:
              </p>
              <div className="mt-3 border border-[#ded8d3] bg-[#F5F0ED]/30 p-5">
                <pre className="overflow-x-auto border border-[#ded8d3] bg-stone-900 p-4 font-mono text-xs text-stone-100">
{`def agent(observation, configuration):
    # Trả về dict xác định nước đi:
    return {"from_col": 0, "from_row": 0, "to_col": 0, "to_row": 1}`}
                </pre>

                <div className="mt-4 space-y-2 text-xs sm:text-sm text-slate-700">
                  <p><strong>Cấu trúc dữ liệu của tham số <code>observation</code>:</strong></p>
                  <ul className="list-disc pl-5 space-y-1">
                    <li><code>valid_moves</code>: Danh sách tất cả nước đi hợp lệ ở lượt hiện tại. Mỗi phần tử gồm <code>{"{from_col, from_row, to_col, to_row, is_capture}"}</code>.</li>
                    <li><code>board</code>: Danh sách 81 phần tử biểu diễn trạng thái bàn cờ (None nếu ô trống, hoặc <code>{"{player: 1|2, type: 'ROCK'|'PAPER'|'SCISSORS'}"}</code>).</li>
                    <li><code>current_player</code>: <code>1</code> hoặc <code>2</code> (cho biết bạn là người chơi nào).</li>
                    <li><code>piece_counts</code>: Thống kê số quân còn lại của 2 bên.</li>
                    <li><code>move_count</code>: Số nước đi đã thực hiện trong trận.</li>
                  </ul>
                </div>
              </div>
            </section>

            {/* Code mẫu khởi đầu */}
            <section>
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-[#1a1e29]">
                  2. Code mẫu cơ bản (Starter Agent)
                </h3>
                <button
                  onClick={() => copyCode(starterTemplate, 1)}
                  className="border border-[#ded8d3] bg-white px-3 py-1 text-xs font-semibold hover:border-[#253B80] hover:text-[#253B80]"
                >
                  {copiedIndex === 1 ? "✓ Đã sao chép" : "Sao chép code"}
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Agent đơn giản nhất: Lọc ngẫu nhiên 1 nước đi từ danh sách <code>valid_moves</code>.
              </p>
              <pre className="mt-3 overflow-x-auto border border-[#ded8d3] bg-stone-900 p-4 font-mono text-xs text-stone-100">
                {starterTemplate}
              </pre>
            </section>

            {/* Quy trình kiểm tra */}
            <section className="border-t border-[#ded8d3] pt-6">
              <h3 className="text-lg font-bold text-[#1a1e29]">
                3. Quy trình Tự động Kiểm duyệt (Validation)
              </h3>
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3 text-xs sm:text-sm">
                <div className="border border-[#ded8d3] p-4 bg-white">
                  <span className="font-bold text-[#253B80]">Bước 1: Kiểm tra AST</span>
                  <p className="mt-1 text-slate-600">
                    Phân tích cú pháp Python, loại bỏ các thư viện nguy hiểm hoặc truy cập tệp/mạng ngoài sandbox.
                  </p>
                </div>
                <div className="border border-[#ded8d3] p-4 bg-white">
                  <span className="font-bold text-[#253B80]">Bước 2: Chạy Self-play</span>
                  <p className="mt-1 text-slate-600">
                    Cho agent tự đấu với chính nó 60 nước trong worker sandbox độc lập để đảm bảo không gặp ngoại lệ runtime.
                  </p>
                </div>
                <div className="border border-[#ded8d3] p-4 bg-white">
                  <span className="font-bold text-[#253B80]">Bước 3: Kích hoạt</span>
                  <p className="mt-1 text-slate-600">
                    Agent chuyển sang trạng thái <code>active</code> và tự động tham gia hàng đợi ghép trận xếp hạng.
                  </p>
                </div>
              </div>
            </section>

            {/* Callout sang Local Runner */}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border border-[#253B80]/30 bg-[#253B80]/5 p-5">
              <div>
                <p className="font-bold text-[#253B80]">💡 Kiểm thử Agent trước khi nộp?</p>
                <p className="mt-1 text-xs sm:text-sm text-slate-600">
                  Bạn có thể tải bộ công cụ <strong>Local Runner</strong> về máy tính cá nhân để chạy thử mô phỏng 9×9, kiểm tra thời gian CPU và đánh với bot mẫu mà không cần kết nối server.
                </p>
              </div>
              <button
                onClick={() => setActiveTab("local-runner")}
                className="rounded-none border border-[#253B80] bg-[#253B80] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#1d2e66]"
              >
                Xem Hướng dẫn Local Runner →
              </button>
            </div>
          </div>
        )}

        {/* TAB: LOCAL RUNNER & TẢI ENGINE VỀ MÁY */}
        {activeTab === "local-runner" && (
          <div className="space-y-8">
            <section>
              <h2 className="text-2xl font-bold text-[#1a1e29]">
                Bộ Công Cụ Local Runner & Kiểm Thử Cục Bộ
              </h2>
              <p className="mt-2 text-slate-600">
                Tải game engine độc lập về máy tính để chạy mô phỏng, debug bot tự do, đo thời gian tính toán và chơi thử trực tiếp với bot của bạn.
              </p>
            </section>

            {/* Khung Tải về từ GitHub */}
            <div className="border-2 border-[#253B80] bg-[#F5F0ED]/30 p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <span className="inline-flex items-center gap-1.5 border border-[#253B80] bg-[#253B80]/10 px-2.5 py-0.5 text-xs font-bold text-[#253B80]">
                    📦 TẢI TỪ GITHUB
                  </span>
                  <h3 className="mt-2 text-xl font-extrabold text-[#1a1e29]">
                    Kho lưu trữ Git: OTTv2 Local Runner
                  </h3>
                  <p className="mt-1 text-xs text-slate-600">
                    Thư mục <code className="bg-white px-1.5 py-0.5 font-mono text-[#253B80] font-bold">local_runner/</code> trên nhánh <code>semi_final</code>.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a
                    href="https://github.com/tuanngthuet/oantuti/tree/semi_final/local_runner"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 border border-[#253B80] bg-[#253B80] px-5 py-2.5 text-sm font-bold text-white shadow transition hover:bg-[#1d2e66]"
                  >
                    <span>🔗 Mở thư mục trên GitHub</span>
                  </a>
                  <a
                    href="https://github.com/tuanngthuet/oantuti/archive/refs/heads/semi_final.zip"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 border border-[#ded8d3] bg-white px-4 py-2.5 text-sm font-bold text-slate-700 transition hover:border-[#253B80] hover:text-[#253B80]"
                  >
                    <span>⬇️ Tải file ZIP</span>
                  </a>
                </div>
              </div>

              {/* Lệnh Clone */}
              <div className="mt-5 border-t border-[#ded8d3] pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    Lệnh Clone nhanh qua Git:
                  </span>
                  <button
                    onClick={() => copyCode("git clone -b semi_final https://github.com/tuanngthuet/oantuti.git\ncd oantuti/local_runner", 99)}
                    className="border border-[#ded8d3] bg-white px-3 py-1 text-xs font-semibold text-[#253B80] hover:bg-stone-50"
                  >
                    {copiedIndex === 99 ? "✓ Đã sao chép" : "Sao chép lệnh"}
                  </button>
                </div>
                <pre className="mt-2 overflow-x-auto border border-[#ded8d3] bg-stone-900 p-3 font-mono text-xs text-stone-100">
{`git clone -b semi_final https://github.com/tuanngthuet/oantuti.git
cd oantuti/local_runner`}
                </pre>
                <p className="mt-2 text-xs text-slate-500">
                  ✨ <strong>Không cần cài thêm thư viện (Zero dependencies)</strong>: Chỉ cần máy bạn có Python 3.8+ là chạy được ngay lập tức, không cần cài package nào qua pip!
                </p>
              </div>
            </div>

            {/* Cấu trúc các file */}
            <section>
              <h3 className="text-lg font-bold text-[#1a1e29]">
                1. Cấu trúc Thư mục `local_runner/`
              </h3>
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3 text-xs sm:text-sm">
                <div className="border border-[#ded8d3] bg-white p-4 shadow-sm">
                  <div className="font-mono font-bold text-[#253B80]">game_engine.py</div>
                  <p className="mt-1 text-slate-600">
                    Mô phỏng 100% luật bàn cờ 9×9, di chuyển 8 hướng, tương khắc Búa-Kéo-Bao, điều kiện thắng và hàm vẽ bàn cờ Terminal.
                  </p>
                </div>
                <div className="border border-[#ded8d3] bg-white p-4 shadow-sm">
                  <div className="font-mono font-bold text-[#253B80]">runner.py</div>
                  <p className="mt-1 text-slate-600">
                    Công cụ dòng lệnh CLI để chạy trận đấu, hỗ trợ chế độ render bàn cờ, chơi trực tiếp với người (human), và đấu hàng loạt tính winrate.
                  </p>
                </div>
                <div className="border border-[#ded8d3] bg-white p-4 shadow-sm">
                  <div className="font-mono font-bold text-[#253B80]">sample_agents/</div>
                  <p className="mt-1 text-slate-600">
                    Thư mục chứa các bot mẫu: <code>starter_agent.py</code> (khung sườn), <code>random_agent.py</code>, và <code>greedy_agent.py</code> (chiến thuật tham lam).
                  </p>
                </div>
              </div>
            </section>

            {/* Hướng dẫn các lệnh sử dụng */}
            <section>
              <h3 className="text-lg font-bold text-[#1a1e29]">
                2. Các Lệnh Chạy Kiểm Thử Tiêu Biểu
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                Mở terminal hoặc PowerShell trong thư mục <code>local_runner/</code> và thử nghiệm:
              </p>

              <div className="mt-4 space-y-4">
                {/* Lệnh 1 */}
                <div className="border border-[#ded8d3] bg-white p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[#1a1e29] text-sm">
                      A. Chạy 1 ván đơn giản giữa bot của bạn và bot ngẫu nhiên
                    </span>
                    <button
                      onClick={() => copyCode("python runner.py sample_agents/starter_agent.py", 101)}
                      className="border border-[#ded8d3] px-2.5 py-0.5 text-xs text-[#253B80] hover:bg-stone-50"
                    >
                      {copiedIndex === 101 ? "✓ Đã chép" : "Sao chép"}
                    </button>
                  </div>
                  <pre className="mt-2 overflow-x-auto bg-stone-900 p-2.5 font-mono text-xs text-stone-100">
                    python runner.py sample_agents/starter_agent.py
                  </pre>
                </div>

                {/* Lệnh 2 */}
                <div className="border border-[#ded8d3] bg-white p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[#1a1e29] text-sm">
                      B. Xem bàn cờ trực quan sinh động từng nước đi (--render --delay)
                    </span>
                    <button
                      onClick={() => copyCode("python runner.py sample_agents/starter_agent.py sample_agents/greedy_agent.py --render --delay 0.2", 102)}
                      className="border border-[#ded8d3] px-2.5 py-0.5 text-xs text-[#253B80] hover:bg-stone-50"
                    >
                      {copiedIndex === 102 ? "✓ Đã chép" : "Sao chép"}
                    </button>
                  </div>
                  <pre className="mt-2 overflow-x-auto bg-stone-900 p-2.5 font-mono text-xs text-stone-100">
                    python runner.py sample_agents/starter_agent.py sample_agents/greedy_agent.py --render --delay 0.2
                  </pre>
                  <p className="mt-1.5 text-xs text-slate-500">
                    Bàn cờ ASCII/Unicode sẽ được cập nhật liên tục với màu quân P1 (Xanh), P2 (Đỏ) và căn cứ đích.
                  </p>
                </div>

                {/* Lệnh 3 */}
                <div className="border border-[#ded8d3] bg-white p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[#1a1e29] text-sm">
                      C. Tự chơi bằng tay với bot của bạn (Chế độ Human)
                    </span>
                    <button
                      onClick={() => copyCode("python runner.py human sample_agents/greedy_agent.py --render", 103)}
                      className="border border-[#ded8d3] px-2.5 py-0.5 text-xs text-[#253B80] hover:bg-stone-50"
                    >
                      {copiedIndex === 103 ? "✓ Đã chép" : "Sao chép"}
                    </button>
                  </div>
                  <pre className="mt-2 overflow-x-auto bg-stone-900 p-2.5 font-mono text-xs text-stone-100">
                    python runner.py human sample_agents/greedy_agent.py --render
                  </pre>
                  <p className="mt-1.5 text-xs text-slate-500">
                    Khi tới lượt, bạn chỉ cần gõ nước đi dạng <code className="bg-stone-100 px-1 font-mono">c5 d6</code> hoặc số thứ tự gợi ý trên màn hình.
                  </p>
                </div>

                {/* Lệnh 4 */}
                <div className="border border-[#ded8d3] bg-white p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[#1a1e29] text-sm">
                      D. Kiểm thử hàng loạt 50 ván có luân phiên đổi bên (--rounds --switch-sides)
                    </span>
                    <button
                      onClick={() => copyCode("python runner.py my_agent.py sample_agents/greedy_agent.py --rounds 50 --switch-sides --quiet", 104)}
                      className="border border-[#ded8d3] px-2.5 py-0.5 text-xs text-[#253B80] hover:bg-stone-50"
                    >
                      {copiedIndex === 104 ? "✓ Đã chép" : "Sao chép"}
                    </button>
                  </div>
                  <pre className="mt-2 overflow-x-auto bg-stone-900 p-2.5 font-mono text-xs text-stone-100">
                    python runner.py my_agent.py sample_agents/greedy_agent.py --rounds 50 --switch-sides --quiet
                  </pre>
                  <p className="mt-1.5 text-xs text-slate-500">
                    Tự động thống kê số ván Thắng / Thua / Hòa và Tỷ lệ thắng (Winrate) của bot bạn.
                  </p>
                </div>

                {/* Lệnh 5 */}
                <div className="border border-[#ded8d3] bg-white p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[#1a1e29] text-sm">
                      E. Xuất bản ghi trận đấu ra file JSON (--save-replay)
                    </span>
                    <button
                      onClick={() => copyCode("python runner.py my_agent.py sample_agents/greedy_agent.py --save-replay match_replay.json", 105)}
                      className="border border-[#ded8d3] px-2.5 py-0.5 text-xs text-[#253B80] hover:bg-stone-50"
                    >
                      {copiedIndex === 105 ? "✓ Đã chép" : "Sao chép"}
                    </button>
                  </div>
                  <pre className="mt-2 overflow-x-auto bg-stone-900 p-2.5 font-mono text-xs text-stone-100">
                    python runner.py my_agent.py sample_agents/greedy_agent.py --save-replay match_replay.json
                  </pre>
                  <p className="mt-1.5 text-xs text-slate-500">
                    Lưu lại toàn bộ lịch sử các bước đi để phân tích chiến thuật hoặc trực quan hóa sau này.
                  </p>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* TAB 4: ĐÁNH GIÁ & XẾP HẠNG */}
        {activeTab === "evaluation" && (
          <div className="space-y-8">
            <section>
              <h2 className="text-2xl font-bold text-[#1a1e29]">
                Hệ thống Đánh giá & Xếp hạng (Evaluation)
              </h2>
              <p className="mt-2 text-slate-600">
                OTTv2 Arena sử dụng thuật toán <strong>Bayesian TrueSkill</strong> để đo lường trình độ và xếp hạng các agent một cách chính xác và khoa học.
              </p>
            </section>

            {/* TrueSkill Formula */}
            <section>
              <h3 className="text-lg font-bold text-[#1a1e29]">
                1. Thuật toán Bayesian TrueSkill
              </h3>
              <p className="mt-2 text-sm text-slate-700">
                Kỹ năng của mỗi Agent được mô hình hóa dưới dạng một biến ngẫu nhiên tuân theo phân phối chuẩn Gaussian:
              </p>
              <div className="mt-3 border border-[#ded8d3] bg-[#F5F0ED]/30 p-5">
                <div className="my-2 rounded border border-[#ded8d3] bg-white p-4 font-mono text-xs sm:text-sm text-center">
                  Trình độ Agent ~ N(μ, σ²)
                </div>
                <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-slate-700">
                  <li><strong>μ (Mu)</strong>: Giá trị trung bình đại diện cho sức mạnh ước tính của Agent. Khởi tạo: <code>25.0</code>.</li>
                  <li><strong>σ (Sigma)</strong>: Độ bất định (Uncertainty) về trình độ thực sự. Khởi tạo: <code>25 / 3 ≈ 8.333</code>. Càng thi đấu nhiều trận, σ càng giảm.</li>
                  <li>
                    <strong>Điểm hiển thị trên Leaderboard</strong>: Được tính toán theo nguyên tắc thận trọng (Conservative Rating):
                    <div className="mt-1 font-mono font-bold text-[#253B80]">
                      Rating = max(0, round(100 × (μ - 3σ)))
                    </div>
                  </li>
                </ul>
              </div>
            </section>

            {/* Giai đoạn Calibrating */}
            <section>
              <h3 className="text-lg font-bold text-[#1a1e29]">
                2. Giai đoạn Hiệu chỉnh (Calibrating)
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">
                Mỗi Agent mới nộp sẽ bước vào giai đoạn <strong>Hiệu chỉnh (10 trận đầu tiên)</strong>. Trong giai đoạn này, hệ thống ưu tiên xếp các trận đấu để thu hẹp nhanh độ bất định σ.
              </p>
              <p className="mt-2 text-sm text-slate-700">
                Sau khi hoàn thành tối thiểu <strong>10 trận hợp lệ</strong>, Agent sẽ chính thức được cấp vị trí xếp hạng trên Bảng Xếp Hạng chính (Ranked Leaderboard).
              </p>
            </section>

            {/* Thách đấu riêng tư */}
            <section className="border-t border-[#ded8d3] pt-6">
              <h3 className="text-lg font-bold text-[#1a1e29]">
                3. Thách Đấu Riêng Tư (Private Trials)
              </h3>
              <p className="mt-2 text-sm text-slate-700">
                Nhằm hỗ trợ thí sinh thử nghiệm chiến thuật ẩn danh:
              </p>
              <div className="mt-3 border border-amber-300 bg-amber-50/50 p-4 text-xs sm:text-sm text-amber-900 space-y-1">
                <p>• Mỗi tài khoản được cấp <strong>10 lượt thách đấu riêng tư mỗi ngày</strong> (làm mới vào 00:00 hàng ngày).</p>
                <p>• Bạn có thể chọn bất kỳ Agent public nào của người khác làm đối thủ tập dượt.</p>
                <p>• Kết quả trận đấu hoàn toàn <strong>không ảnh hưởng đến điểm rating</strong> hay lịch sử công khai của đối thủ.</p>
                <p>• Chỉ người thách đấu mới có quyền xem lại bản ghi ván đấu (Replay).</p>
              </div>
            </section>
          </div>
        )}

        {/* TAB 5: VÒNG CHUNG KẾT TOP 16 */}
        {activeTab === "finals" && (
          <div className="space-y-8">
            <section>
              <h2 className="text-2xl font-bold text-[#1a1e29]">
                Thể thức Vòng Chung Kết Top 16 (Knockout Finals)
              </h2>
              <p className="mt-2 text-slate-600">
                Khi giai đoạn xếp hạng khép lại, 16 đội/thí sinh đứng đầu sẽ bước vào vòng chung kết tranh ngôi Vô địch.
              </p>
            </section>

            {/* Sơ đồ hạt giống */}
            <section>
              <h3 className="text-lg font-bold text-[#1a1e29]">
                1. Phân bổ Hạt giống & Cây Nhánh đấu (Bracket)
              </h3>
              <p className="mt-2 text-sm text-slate-700">
                Thứ hạng trên Leaderboard lúc chốt sổ quyết định hạt giống từ #1 đến #16. Nhánh thi đấu tiêu chuẩn:
              </p>
              <div className="mt-3 border border-[#ded8d3] bg-[#F5F0ED]/30 p-5">
                <div className="grid grid-cols-2 gap-2 text-xs font-mono sm:grid-cols-4">
                  <div className="border border-[#ded8d3] bg-white p-2.5 text-center">#1 vs #16</div>
                  <div className="border border-[#ded8d3] bg-white p-2.5 text-center">#8 vs #9</div>
                  <div className="border border-[#ded8d3] bg-white p-2.5 text-center">#4 vs #13</div>
                  <div className="border border-[#ded8d3] bg-white p-2.5 text-center">#5 vs #12</div>
                  <div className="border border-[#ded8d3] bg-white p-2.5 text-center">#2 vs #15</div>
                  <div className="border border-[#ded8d3] bg-white p-2.5 text-center">#7 vs #10</div>
                  <div className="border border-[#ded8d3] bg-white p-2.5 text-center">#3 vs #14</div>
                  <div className="border border-[#ded8d3] bg-white p-2.5 text-center">#6 vs #11</div>
                </div>
              </div>
            </section>

            {/* Thể thức Bo2 đổi bên */}
            <section>
              <h3 className="text-lg font-bold text-[#1a1e29]">
                2. Thể thức Best-of-2 (Bo2) Đổi bên
              </h3>
              <div className="mt-3 space-y-2 text-sm text-slate-700">
                <p>• Mỗi cặp đấu thi đấu đúng <strong>2 ván đổi bên</strong> (mỗi bên cầm quân P1 đi trước ở một ván).</p>
                <p>• Cách tính điểm: <strong>Thắng = 1 điểm</strong>, <strong>Hòa = 0.5 điểm</strong>, <strong>Thua = 0 điểm</strong>.</p>
                <p>• <strong>Quy tắc hòa điểm (Tie-break)</strong>: Nếu tỉ số hòa 1 – 1 sau 2 ván, <strong>hạt giống có thứ hạng cao hơn</strong> sẽ được phân định đi tiếp.</p>
              </div>
            </section>

            {/* Engine & Nộp bài riêng */}
            <section className="border-t border-[#ded8d3] pt-6">
              <h3 className="text-lg font-bold text-[#1a1e29]">
                3. Độc lập & Bảo mật từng Vòng
              </h3>
              <div className="mt-2 space-y-2 text-sm text-slate-700">
                <p>• Thí sinh bắt buộc phải <strong>nộp bài riêng cho từng vòng đấu</strong> (Vòng 16, Tứ kết, Bán kết, Chung kết & Tranh hạng ba).</p>
                <p>• Mỗi vòng có thể áp dụng phiên bản Engine riêng (ví dụ bổ sung ô chướng ngại vật terrain hoặc ô thưởng điểm bonus cells).</p>
                <p>• Mã nguồn được giữ bí mật tuyệt đối trong suốt thời gian diễn ra giải đấu.</p>
              </div>
            </section>
          </div>
        )}

        {/* TAB 6: QUY CHẾ & LIÊM CHÍNH */}
        {activeTab === "regulations" && (
          <div className="space-y-8">
            <section>
              <h2 className="text-2xl font-bold text-[#1a1e29]">
                Quy chế Thi đấu & Liêm chính Học thuật
              </h2>
              <p className="mt-2 text-slate-600">
                Các quy định bắt buộc đối với tất cả thí sinh tham gia đấu trường OTTv2 Arena.
              </p>
            </section>

            <section className="space-y-4 text-sm text-slate-700">
              <div className="border border-[#ded8d3] bg-white p-4">
                <h3 className="font-bold text-[#1a1e29]">1. Tư cách Tham gia & Quy mô Đội</h3>
                <p className="mt-1.5 leading-relaxed text-slate-600">
                  Thí sinh có thể thi đấu với tư cách <strong>Cá nhân</strong> hoặc <strong>Đội nhóm từ 1 đến 3 thành viên</strong>. Mỗi thí sinh chỉ được nộp bài ở một tư cách tại một thời điểm (khi gia nhập đội, bot cá nhân cũ sẽ được bảo lưu riêng).
                </p>
              </div>

              <div className="border border-[#ded8d3] bg-white p-4">
                <h3 className="font-bold text-[#1a1e29]">2. Giới hạn Tài nguyên Tính toán</h3>
                <ul className="mt-1.5 list-disc pl-5 space-y-1 text-slate-600">
                  <li><strong>Thời gian tính toán mỗi nước đi</strong>: Tối đa 1.0 giây (CPU Time limit). Nếu vượt quá timeout sẽ bị xử thua trận.</li>
                  <li><strong>Bộ nhớ RAM</strong>: Tối đa 256 MB trong sandbox.</li>
                  <li><strong>Môi trường mạng & file</strong>: Sandbox bị cô lập hoàn toàn, không có kết nối internet và không được lưu trữ dữ liệu vĩnh viễn trên đĩa.</li>
                </ul>
              </div>

              <div className="border border-[#ded8d3] bg-white p-4">
                <h3 className="font-bold text-[#1a1e29]">3. Hành vi Nghiêm cấm</h3>
                <ul className="mt-1.5 list-disc pl-5 space-y-1 text-rose-700 font-medium">
                  <li>Nghiêm cấm các hành vi tấn công sandbox hoặc cố ý gây sập worker máy chủ.</li>
                  <li>Nghiêm cấm dàn xếp tỉ số (win-trading) giữa các tài khoản để trục lợi điểm rating.</li>
                  <li>Nghiêm cấm sao chép nguyên văn mã nguồn từ các thí sinh khác mà không có sự đóng góp cá nhân.</li>
                </ul>
              </div>
            </section>
          </div>
        )}
      </div>

      {/* ─── FOOTER CTA ──────────────────────────────────────────────── */}
      <div className="mt-8 border border-[#ded8d3] bg-white p-6 text-center shadow-md sm:p-8">
        <h3 className="text-xl font-bold text-[#1a1e29]">
          Bạn đã sẵn sàng bước vào Đấu trường OTTv2 Arena?
        </h3>
        <p className="mt-2 text-sm text-slate-600">
          Hãy bắt đầu viết Agent đầu tiên của bạn ngay hôm nay và thử sức trên Bảng Xếp Hạng.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/arena/submit"
            className="border border-[#253B80] bg-[#253B80] px-6 py-3 text-sm font-bold text-white shadow hover:bg-[#1d2e66]"
          >
            Lập trình & Nộp Agent →
          </Link>
          <Link
            href="/arena/leaderboard"
            className="border border-[#ded8d3] bg-white px-6 py-3 text-sm font-bold text-slate-700 hover:border-[#253B80] hover:text-[#253B80]"
          >
            Xem Bảng Xếp Hạng
          </Link>
        </div>
      </div>
    </div>
  );
}
