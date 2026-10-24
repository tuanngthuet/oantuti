"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { safeReturnTo } from '@/lib/auth-navigation';

export default function AuthForm({ mode, returnTo = '/dashboard' }: { mode: "login" | "register"; returnTo?: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setBusy(true);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error || "Có lỗi xảy ra. Vui lòng thử lại.");
        return;
      }
      window.dispatchEvent(new Event('arena:auth-changed'));
      router.replace(safeReturnTo(returnTo));
      router.refresh();
    } catch {
      setMessage("Không thể kết nối máy chủ. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "mt-2 w-full rounded-none border border-[#ded8d3] bg-white px-4 py-3 text-[#1a1e29] outline-none transition placeholder:text-[#94a3b8] focus:border-[#253B80] focus:ring-1 focus:ring-[#253B80]";

  return (
    <form onSubmit={handleSubmit} className="mt-7 space-y-5">
      <label className="block text-sm font-semibold text-[#1a1e29]">
        Tên đăng nhập
        <input
          className={inputClass}
          type="text"
          autoComplete="username"
          required
          minLength={3}
          maxLength={32}
          pattern="[a-zA-Z0-9_]+"
          title="Chỉ dùng chữ cái, số và dấu gạch dưới"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="vd: nguyen_van_a"
        />
      </label>
      <label className="block text-sm font-semibold text-[#1a1e29]">
        Mật khẩu
        <div className="relative mt-2">
          <input
            className="w-full rounded-none border border-[#ded8d3] bg-white px-4 py-3 pr-11 text-[#1a1e29] outline-none transition placeholder:text-[#94a3b8] focus:border-[#253B80] focus:ring-1 focus:ring-[#253B80]"
            type={showPassword ? "text" : "password"}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={8}
            maxLength={72}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Ít nhất 8 ký tự"
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-[#253B80] transition cursor-pointer"
            title={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
          >
            {showPassword ? (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            )}
          </button>
        </div>
      </label>
      {message && (
        <p role="alert" className="rounded-none border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {message}
        </p>
      )}
      <button
        disabled={busy}
        className="w-full cursor-pointer rounded-none bg-[#253B80] px-4 py-3.5 font-bold text-white transition hover:bg-[#1d2e66] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Đang xử lý..." : mode === "login" ? "Đăng nhập" : "Đăng ký"}
      </button>
    </form>
  );
}
