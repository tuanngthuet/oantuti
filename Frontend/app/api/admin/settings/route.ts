import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isBackendOnline, getBackendUrl } from "@/lib/backend";

export const runtime = "nodejs";

/** GET /api/admin/settings — lấy settings */
export async function GET() {
  const session = await getSession();
  if (!session?.is_admin) {
    return NextResponse.json({ error: "Không có quyền." }, { status: 403 });
  }

  // Trả về backend_url từ env var (không còn lưu trong DB)
  const backendUrl = getBackendUrl();
  return NextResponse.json({
    settings: [
      {
        key: "backend_url",
        value: backendUrl,
        source: "env",
        note: "Thay đổi qua biến môi trường BACKEND_URL trên Vercel rồi redeploy.",
      },
    ],
  });
}

/** POST /api/admin/settings — chỉ còn dùng để test kết nối backend */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.is_admin) {
    return NextResponse.json({ error: "Không có quyền." }, { status: 403 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });
  }

  const { key } = body as Record<string, unknown>;

  // Chỉ hỗ trợ test kết nối
  if (key === "backend_url") {
    const online = await isBackendOnline();
    return NextResponse.json({
      ok: true,
      online,
      current_url: getBackendUrl(),
      message: online
        ? "Backend đang online."
        : "Backend offline. Kiểm tra BACKEND_URL và worker.",
    });
  }

  return NextResponse.json({ error: `Key '${key}' không hỗ trợ.` }, { status: 400 });
}
