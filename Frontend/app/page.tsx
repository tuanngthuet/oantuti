import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import logoImg from "@/source/images/logo.png";

export default async function Home() {
  const session = await getSession();
  if (session) redirect("/dashboard");

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-[#F5F0ED] px-5 py-12">
      {/* Logo trường ở góc trái trên, cố định không tương tác */}
      <div className="fixed left-5 top-5 z-30 flex items-center select-none pointer-events-none sm:left-8 sm:top-8">
        <div className="relative h-12 w-12 sm:h-14 sm:w-14">
          <Image
            src={logoImg}
            alt="Logo"
            priority
            className="h-full w-full object-contain"
          />
        </div>
      </div>

      <section className="w-full max-w-xl rounded-none border border-[#ded8d3] bg-white p-8 shadow-md sm:p-12">
        <div className="mb-8 inline-flex items-center gap-2 rounded-none border border-[#253B80]/20 bg-[#253B80]/5 px-3.5 py-1 text-sm font-medium text-[#253B80]">
          <span className="h-2 w-2 bg-[#253B80]" /> OTTv2 Arena
        </div>
        <h1 className="text-4xl font-bold tracking-tight text-[#1a1e29] sm:text-5xl">Xin chào 👋</h1>
        <p className="mt-4 max-w-md leading-7 text-slate-600">
          Nền tảng thi đấu cờ Oẳn Tù Tì v2 giữa các agent dành cho sinh viên UET. 
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            className="rounded-none bg-[#253B80] px-6 py-3.5 text-center font-semibold text-white shadow-sm transition hover:bg-[#1d2e66]"
            href="/register"
          >
            Tạo tài khoản
          </Link>
          <Link
            className="rounded-none border border-[#ded8d3] bg-white px-6 py-3.5 text-center font-semibold text-[#1a1e29] transition hover:bg-stone-50"
            href="/login"
          >
            Đăng nhập
          </Link>
        </div>
      </section>
    </main>
  );
}
