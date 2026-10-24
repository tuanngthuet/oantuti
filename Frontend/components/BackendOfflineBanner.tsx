"use client";

/**
 * BackendOfflineBanner
 *
 * Hiển thị banner cảnh báo khi backend (máy cá nhân) offline.
 * Đặt ở đầu trang của các tính năng cần backend.
 *
 * Props:
 *   isOffline  — true = hiện banner, false = ẩn
 *   checking   — true = đang kiểm tra (hiện spinner nhỏ)
 *   className  — class tùy chỉnh thêm
 */
export default function BackendOfflineBanner({
  isOffline,
  checking = false,
  className = "",
}: {
  isOffline: boolean;
  checking?: boolean;
  className?: string;
}) {
  if (checking) {
    return (
      <div
        className={`flex items-center gap-2 rounded-none border border-[#ded8d3] bg-white px-4 py-2.5 text-sm text-slate-600 ${className}`}
      >
        <span className="inline-block h-3 w-3 animate-spin border-2 border-slate-300 border-t-[#253B80]" />
        Đang kiểm tra kết nối máy chủ...
      </div>
    );
  }

  if (!isOffline) return null;

  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-none border border-amber-300 bg-amber-50 px-4 py-3 text-sm ${className}`}
    >
      {/* Icon */}
      <span className="mt-0.5 shrink-0 text-lg leading-none">🔌</span>

      <div className="flex-1">
        <p className="font-semibold text-amber-800">Máy chủ cá nhân đang offline</p>
        <p className="mt-0.5 text-amber-700">
          Tính năng này cần backend FastAPI và worker Python đang chạy.
          Các tính năng khác như đăng nhập, nộp agent, bảng xếp hạng và replay vẫn hoạt động bình thường.
        </p>
      </div>
    </div>
  );
}
