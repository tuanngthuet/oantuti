"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import LogoutButton from "@/components/logout-button";
import logoImg from "@/source/images/logo.png";

type UserSession = {
  id: number;
  username: string;
  is_admin: boolean;
};

export default function Navbar({ initialUser }: { initialUser?: UserSession | null }) {
  const [user, setUser] = useState<UserSession | null>(initialUser ?? null);
  const pathname = usePathname();
  const isDashboard = pathname === "/dashboard" || pathname === "/";
  const [scrolledPast, setScrolledPast] = useState(false);

  useEffect(() => {
    if (!isDashboard) {
      setScrolledPast(false);
      return;
    }
    const checkScroll = () => {
      const hero = document.getElementById("hero-banner-section");
      const threshold = hero ? Math.max(hero.offsetHeight - 80, 420) : 480;
      setScrolledPast(window.scrollY >= threshold);
    };
    checkScroll();
    window.addEventListener("scroll", checkScroll, { passive: true });
    return () => window.removeEventListener("scroll", checkScroll);
  }, [isDashboard, pathname]);

  useEffect(() => {
    setUser(initialUser ?? null);
    let controller = new AbortController();
    const load = () => {
      controller.abort(); controller = new AbortController();
      const active = controller;
      fetch("/api/auth/me", { signal: active.signal, cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!active.signal.aborted) setUser(data?.authenticated && data.user ? data.user : null);
        })
        .catch(() => {});
    };
    const authChanged = () => { setUser(null); load(); };
    const visible = () => { if (document.visibilityState === 'visible') load(); };
    load();
    window.addEventListener('arena:auth-changed', authChanged);
    window.addEventListener('pageshow', load);
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.abort();
      window.removeEventListener('arena:auth-changed', authChanged);
      window.removeEventListener('pageshow', load);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [initialUser, pathname]);

  const navLinks = [
    { label: "Dashboard", href: "/dashboard" },
    { label: "Tổng quan", href: "/overview" },
    { label: "Bảng Xếp Hạng", href: "/arena/leaderboard" },
    { label: "Chung kết", href: "/finals" },
    { label: "Nộp Agent", href: "/arena/submit" },
    { label: "Thách đấu", href: "/arena/friendly" },
  ];

  const isTransparent = isDashboard && !scrolledPast;

  return (
    <header
      className={`z-40 w-full transition-all duration-300 ${
        isDashboard ? "fixed top-0 left-0" : "sticky top-0"
      } ${
        isTransparent
          ? "border-b border-white/10 bg-gradient-to-b from-black/85 via-black/50 to-transparent backdrop-blur-[2px] text-white"
          : "border-b border-[#ded8d3] bg-[#F5F0ED]/95 backdrop-blur-md text-[#1a1e29] shadow-sm"
      }`}
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        {/* Nhóm bên trái: Logo trường + OTTv2 Arena + Menu links */}
        <div className="flex flex-wrap items-center gap-3 sm:gap-6">
          {/* Logo trường */}
          <Link
            href="/dashboard"
            onClick={() => {
              if (isDashboard) {
                setScrolledPast(false);
                if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
              }
            }}
            className="flex items-center gap-2.5"
          >
            <div className="relative h-10 w-10 select-none pointer-events-none sm:h-11 sm:w-11">
              <Image
                src={logoImg}
                alt="Logo trường"
                priority
                className="h-full w-full object-contain"
              />
            </div>
            <span
              className={`text-lg font-extrabold tracking-tight transition-colors sm:text-xl ${
                isTransparent ? "text-white drop-shadow-md" : "text-[#253B80]"
              }`}
            >
              OTTv2 Arena
            </span>
          </Link>

          <div
            className={`hidden h-5 w-px sm:block transition-colors ${
              isTransparent ? "bg-white/30" : "bg-[#ded8d3]"
            }`}
          />

          {/* Quick nav links với khung thẳng */}
          <nav className="hidden items-center gap-1 sm:flex flex-wrap">
            {navLinks.map((link) => {
              const isCurrentDashboard = link.href === "/dashboard" && isDashboard;
              const active =
                isCurrentDashboard ||
                (link.href !== "/dashboard" &&
                  (pathname === link.href || pathname.startsWith(link.href)));
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => {
                    if (link.href === "/dashboard") {
                      setScrolledPast(false);
                      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
                    }
                  }}
                  style={active ? { color: "#ffffff" } : undefined}
                  className={`rounded-none border px-3 py-1.5 text-xs font-semibold transition ${
                    isTransparent
                      ? active
                        ? "border-white/70 bg-white/30 !text-white text-white font-bold shadow-md backdrop-blur-md"
                        : "border-transparent text-white font-semibold hover:border-white/40 hover:bg-white/20 hover:text-white drop-shadow-sm"
                      : active
                      ? "border-[#253B80] bg-[#253B80] !text-white text-white font-bold shadow-sm"
                      : "border-transparent text-slate-700 hover:border-[#ded8d3] hover:bg-white/80 hover:text-[#253B80]"
                  }`}
                >
                  <span className={active ? "text-white font-bold" : ""}>{link.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Nhóm bên phải: Thông tin User, ID và Đăng xuất */}
        <div className="flex items-center gap-3 sm:gap-4">
          {user && (
            <div className="flex items-center gap-2">
              <span
                className={`text-sm font-bold transition-colors ${
                  isTransparent ? "text-white drop-shadow-sm" : "text-[#1a1e29]"
                }`}
              >
                {user.username}
              </span>
              <span
                className={`rounded-none border px-2 py-0.5 font-mono text-[11px] font-medium transition-colors ${
                  isTransparent
                    ? "border-white/40 bg-black/50 text-white"
                    : "border-[#ded8d3] bg-white text-slate-600"
                }`}
              >
                ID: {user.id}
              </span>
              {user.is_admin && (
                <span
                  className={`rounded-none px-2 py-0.5 text-[11px] font-bold ${
                    isTransparent
                      ? "border border-rose-400 bg-rose-600/90 text-white"
                      : "border border-rose-300 bg-rose-50 text-rose-700"
                  }`}
                >
                  Admin
                </span>
              )}
            </div>
          )}

          <div
            className={`hidden h-5 w-px sm:block transition-colors ${
              isTransparent ? "bg-white/30" : "bg-[#ded8d3]"
            }`}
          />

          <Link
            href="/team"
            className={`border px-3 py-1.5 text-xs font-semibold transition ${
              isTransparent
                ? "border-white/50 bg-white/25 text-white font-bold hover:bg-white/35 backdrop-blur-sm"
                : "border-[#ded8d3] bg-white text-[#253B80] hover:border-[#253B80]"
            }`}
          >
            Team
          </Link>
          {user ? (
            <LogoutButton
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs font-semibold transition ${
                isTransparent
                  ? "border border-rose-400/60 bg-rose-900/60 text-white hover:bg-rose-900/80 hover:border-rose-300"
                  : "border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 hover:border-rose-400"
              }`}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Link
                href="/login"
                className={`border px-3 py-1.5 text-xs font-semibold transition ${
                  isTransparent
                    ? "border-white/50 bg-white/25 text-white font-bold hover:bg-white/35"
                    : "border-[#ded8d3] bg-white text-[#253B80] hover:border-[#253B80]"
                }`}
              >
                Đăng nhập
              </Link>
              <Link
                href="/register"
                className="border border-[#253B80] bg-[#253B80] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1d2e66]"
              >
                Đăng ký
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
