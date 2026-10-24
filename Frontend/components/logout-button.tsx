"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LogoutButton({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function logout() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error('logout failed');
      window.dispatchEvent(new Event('arena:auth-changed'));
      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError('Không thể đăng xuất. Vui lòng thử lại.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1"><button
      onClick={logout}
      disabled={busy}
      className={
        className ||
        "inline-flex items-center gap-2 rounded-none border border-rose-200 bg-rose-50/70 px-3.5 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 hover:border-rose-300 disabled:opacity-60 cursor-pointer"
      }
      title="Đăng xuất khỏi hệ thống"
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
        />
      </svg>
      <span>{busy ? "Đang xử lý..." : "Đăng xuất"}</span>
    </button>
    {error && <span role="alert" className="max-w-56 text-xs text-rose-700">{error}</span>}</span>
  );
}
