import Image from "next/image";
import Link from "next/link";
import { getSession } from "@/lib/session";
import Navbar from "@/components/Navbar";
import overviewBannerImg from "@/source/images/overviewbanner.png";
import leaderboardImg from "@/source/images/leaderboard.png";
import submitImg from "@/source/images/submit.png";
import competeImg from "@/source/images/compete.png";
import finalsImg from "@/source/images/finals.svg";

export const runtime = "nodejs";

export default async function DashboardPage() {
  const session = await getSession();

  const features = [
    {
      title: "Bảng Xếp Hạng",
      description: "Theo dõi thứ hạng, xem lại trận đấu được cập nhật liên tục.",
      href: "/arena/leaderboard",
      image: leaderboardImg,
    },
    {
      title: "Nộp Agent",
      description: "Đưa Agent của bản thân lên đấu trường.",
      href: "/arena/submit",
      image: submitImg,
    },
    {
      title: "Thách đấu",
      description: "Thách đấu giao hữu. Không ảnh hưởng rating.",
      href: "/arena/friendly",
      image: competeImg,
    },
    {
      title: "Chung kết",
      description: "Vòng knock-out cho 16 Agent xuất sắc nhất trên Bảng xếp hạng để tìm ra nhà vô địch.",
      href: "/finals",
      image: finalsImg,
    },
  ];

  return (
    <div className="relative min-h-screen bg-[#F5F0ED]">
      {/* ─── THANH HEADER TRÊN CÙNG (TRÀN TRÊN BANNER KHI Ở ĐẦU TRANG) ── */}
      <Navbar initialUser={session} />

      {/* ─── HERO SECTION BANNER ĐỘNG TRÀN MÀN HÌNH (FULL-BLEED) ──────── */}
      <section
        id="hero-banner-section"
        className="relative w-full h-[80vh] min-h-[520px] max-h-[760px] overflow-hidden select-none"
      >
        {/* Ảnh banner kích thước lớn tràn màn hình với hiệu ứng zoom nhẹ */}
        <div className="absolute inset-0 h-full w-full overflow-hidden">
          <Image
            src={overviewBannerImg}
            alt="OTTv2 Arena Overview Banner"
            priority
            fill
            className="animate-hero-zoom object-cover object-[center_35%] transition-transform duration-1000 ease-out"
          />
          {/* Lớp phủ chuyển sắc đa tầng bảo vệ độ tương phản của chữ và navbar */}
          <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-black/25 to-black/65" />
          <div className="absolute inset-0 bg-black/10 backdrop-blur-[0.5px]" />
        </div>

        {/* Nội dung giới thiệu ở góc trái dưới của Hero banner */}
        <div className="relative z-10 mx-auto flex h-full max-w-7xl flex-col justify-end px-4 pb-14 sm:px-6 lg:px-8">
          <div className="max-w-2xl drop-shadow-lg">
            <div className="mb-3 inline-flex items-center gap-2 border border-white/30 bg-black/40 px-3.5 py-1 text-xs font-bold uppercase tracking-wider text-amber-300 backdrop-blur-md">
              <span>🏆</span>
              <span>Đấu Trường Oản Tù Tì</span>
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-5xl lg:text-6xl drop-shadow-md">
              OTTv2 Arena
            </h1>
            <p className="mt-3 max-w-xl text-sm font-medium leading-relaxed text-stone-200 sm:text-base drop-shadow">
              Sân chơi code Python cạnh tranh, công bằng!
            </p>
          </div>
        </div>

        {/* Ô nhỏ ở dưới phải, hơi lệch vào giữa ghi chữ "Tìm hiểu thêm" */}
        <div className="absolute bottom-12 right-6 sm:right-16 md:right-28 lg:right-36 z-20">
          <Link
            href="/overview"
            className="group inline-flex items-center gap-3 border border-white/80 bg-white/95 px-5 py-3.5 shadow-2xl backdrop-blur-md transition-all duration-300 hover:scale-105 hover:border-[#253B80] hover:bg-white hover:shadow-[#253B80]/30"
            title="Đến trang Tổng quan giải đấu"
          >
            <span className="text-sm font-bold tracking-wide text-[#253B80] sm:text-base group-hover:text-[#1d2e66]">
              Tìm hiểu thêm
            </span>
            <span className="flex h-7 w-7 items-center justify-center bg-[#253B80] text-sm font-bold text-white transition-transform duration-300 group-hover:translate-x-1">
              →
            </span>
          </Link>
        </div>
      </section>

      {/* ─── NỘI DUNG TÍNH NĂNG CHÍNH DƯỚI BANNER ─────────────────────── */}
      <main className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="mb-8 border-b border-[#ded8d3] pb-4">
          <h2 className="text-2xl font-bold tracking-tight text-[#1a1e29] sm:text-3xl">
            Khu Vực Thi Đấu
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Khám phá các chức năng trên đấu trường OTTv2 Arena
          </p>
        </div>

        <div className="grid grid-cols-1 items-stretch gap-6 sm:grid-cols-2 sm:gap-8 xl:grid-cols-4">
          {features.map((feature) => (
            <Link
              key={feature.href}
              href={feature.href}
              className="group flex flex-col overflow-hidden rounded-none border border-[#ded8d3] bg-white p-4 shadow-md transition-all duration-300 hover:-translate-y-1.5 hover:border-[#253B80] hover:shadow-xl hover:shadow-[#253B80]/15"
            >
              {/* Ảnh ở phía trên: Khung thẳng */}
              <div className="relative aspect-[4/3] w-full overflow-hidden rounded-none bg-stone-100 border border-[#ded8d3]">
                <Image
                  src={feature.image}
                  alt={feature.title}
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
              </div>

              {/* Tính năng ở phía dưới: Khi di chuột thì thay tên bằng mô tả */}
              <div className="relative flex min-h-[84px] w-full items-center justify-center p-3 text-center">
                {/* Tên tính năng (mặc định hiện, hover ẩn) */}
                <h3 className="text-lg font-bold tracking-tight text-[#1a1e29] transition-all duration-300 group-hover:invisible group-hover:scale-90 group-hover:opacity-0">
                  {feature.title}
                </h3>

                {/* Mô tả tính năng (mặc định ẩn, hover hiện thay thế) */}
                <p className="absolute inset-x-2 text-xs font-medium leading-relaxed text-[#253B80] opacity-0 scale-95 invisible transition-all duration-300 group-hover:visible group-hover:scale-100 group-hover:opacity-100">
                  {feature.description}
                </p>
              </div>
            </Link>
          ))}
        </div>

        {/* ─── KHU VỰC DÀNH CHO ADMIN (NẾU CÓ) ─────────────────────────── */}
        {session?.is_admin && (
          <section className="mt-12 w-full rounded-none border border-[#ded8d3] bg-white p-6 shadow-md sm:p-7">
            <div className="mb-4 flex items-center justify-between border-b border-[#ded8d3] pb-3">
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-rose-700">🛠 Quản Trị Hệ Thống (Admin)</span>
                <span className="rounded-none bg-rose-50 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700 border border-rose-300">
                  Chỉ định cho Admin
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Link href="/admin/teams" className="border border-[#ded8d3] bg-[#F5F0ED]/50 p-3.5 text-center text-sm font-bold">
                Quản lý teams
              </Link>
              <Link href="/admin/finals" className="border border-[#ded8d3] bg-[#F5F0ED]/50 p-3.5 text-center text-sm font-bold">
                🏆 Quản lý Chung kết
              </Link>
              <Link
                href="/admin/rating"
                className="flex flex-col items-center gap-1.5 rounded-none border border-[#ded8d3] bg-[#F5F0ED]/50 p-3.5 text-center transition hover:border-[#253B80] hover:bg-[#253B80]/5"
              >
                <span className="text-xl">🎮</span>
                <span className="text-xs font-bold text-[#1a1e29]">TrueSkill Queue</span>
                <span className="text-[10px] text-slate-500">Bật/tắt worker giải</span>
              </Link>

              <Link
                href="/admin/agents"
                className="flex flex-col items-center gap-1.5 rounded-none border border-[#ded8d3] bg-[#F5F0ED]/50 p-3.5 text-center transition hover:border-[#253B80] hover:bg-[#253B80]/5"
              >
                <span className="text-xl">🤖</span>
                <span className="text-xs font-bold text-[#1a1e29]">Duyệt Agent</span>
                <span className="text-[10px] text-slate-500">Xem xét & kích hoạt</span>
              </Link>

              <Link
                href="/admin/settings"
                className="flex flex-col items-center gap-1.5 rounded-none border border-[#ded8d3] bg-[#F5F0ED]/50 p-3.5 text-center transition hover:border-[#253B80] hover:bg-[#253B80]/5"
              >
                <span className="text-xl">⚙️</span>
                <span className="text-xs font-bold text-[#1a1e29]">Cài Đặt</span>
                <span className="text-[10px] text-slate-500">Backend Tunnel URL</span>
              </Link>
              <Link
                href="/admin/workers"
                className="flex flex-col items-center gap-1.5 border border-[#ded8d3] bg-[#F5F0ED]/50 p-3.5 text-center transition hover:border-[#253B80]"
              >
                <span className="text-xl">🖥️</span>
                <span className="text-xs font-bold">Quản lý worker</span>
                <span className="text-[10px] text-slate-500">Bật/dừng & giới hạn job</span>
              </Link>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
