import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import AuthForm from "@/components/auth-form";
import { safeReturnTo, authLink } from '@/lib/auth-navigation';
import logoImg from "@/source/images/logo.png";
import bannerImg from "@/source/images/banner.png";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ redirect?: string | string[] }> }) {
  const returnTo = safeReturnTo((await searchParams).redirect);
  const session = await getSession();
  if (session) redirect(returnTo);

  return (
    <main className="relative flex min-h-screen w-full items-center justify-center bg-[#F5F0ED] px-4 py-16 sm:px-6 lg:px-8">
      {/* Logo trường ở góc trái trên, cố định và không có tương tác */}
      <div className="fixed left-5 top-5 z-30 flex items-center select-none pointer-events-none sm:left-8 sm:top-8">
        <div className="relative h-12 w-12 sm:h-14 sm:w-14">
          <Image
            src={logoImg}
            alt="Logo trường"
            priority
            className="h-full w-full object-contain"
          />
        </div>
      </div>

      {/* Khung nội dung chính: Khung thẳng vuông vức */}
      <div className="w-full max-w-5xl pt-14 lg:pt-0">
        <div className="grid grid-cols-1 items-center justify-items-center gap-8 lg:grid-cols-2 lg:gap-12">
          
          {/* Cột Banner (cố định, không tương tác, khung thẳng) */}
          <div className="flex w-full justify-center select-none pointer-events-none">
            <div className="relative w-full max-w-[400px] overflow-hidden rounded-none border border-[#ded8d3] bg-white p-3 shadow-md">
              <div className="relative aspect-[448/557] w-full overflow-hidden rounded-none border border-[#ded8d3]">
                <Image
                  src={bannerImg}
                  alt="Banner cuộc thi"
                  priority
                  className="h-full w-full object-cover"
                />
              </div>
            </div>
          </div>

          {/* Cột Khung Login (khung thẳng) */}
          <div className="w-full max-w-md">
            <section className="w-full rounded-none border border-[#ded8d3] bg-white p-8 shadow-md sm:p-10">
              <div className="flex items-center justify-between border-b border-[#ded8d3] pb-4">
                <span className="inline-flex items-center gap-1.5 rounded-none border border-[#253B80] bg-[#253B80]/10 px-3 py-1 text-xs font-bold text-[#253B80]">
                  <span className="h-1.5 w-1.5 bg-[#253B80]" /> OTTv2 Arena
                </span>
                <Link
                  href="/"
                  className="text-xs font-semibold text-slate-500 transition hover:text-[#253B80]"
                >
                  ← Trang chủ
                </Link>
              </div>

              <h1 className="mt-6 text-3xl font-bold tracking-tight text-[#1a1e29]">
                Đăng nhập
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                Nhập tên đăng nhập và mật khẩu để tiếp tục.
              </p>

              <AuthForm mode="login" returnTo={returnTo} />

              <p className="mt-6 text-center text-sm text-slate-600">
                Chưa có tài khoản?{" "}
                <Link className="font-semibold text-[#253B80] hover:underline" href={authLink('register', returnTo)}>
                  Đăng ký
                </Link>
              </p>
            </section>
          </div>

        </div>
      </div>
    </main>
  );
}
