import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { backendFetch } from "@/lib/backend";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session?.is_admin) return NextResponse.json({ error: "Không có quyền." }, { status: 403 });
  const { id } = await params;
  if (!/^[a-f0-9]{32}$/.test(id)) return NextResponse.json({ error: "Worker ID không hợp lệ." }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "JSON không hợp lệ." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });
  const value = body as Record<string, unknown>;
  const { revision, action, stop_mode, max_concurrent } = value;
  if (Object.keys(value).some(key => !["revision", "action", "stop_mode", "max_concurrent"].includes(key)) ||
      !Number.isSafeInteger(revision) || Number(revision) < 1 ||
      (action !== undefined && !["start", "pause", "resume", "stop"].includes(String(action))) ||
      (stop_mode !== undefined && !["graceful", "immediate"].includes(String(stop_mode))) ||
      (max_concurrent !== undefined && (!Number.isInteger(max_concurrent) || Number(max_concurrent) < 1 || Number(max_concurrent) > 64)) ||
      (action === undefined && max_concurrent === undefined)) {
    return NextResponse.json({ error: "Thao tác không hợp lệ; giới hạn job phải từ 1 đến 64." }, { status: 400 });
  }
  const result = await backendFetch(`/workers/admin/${id}`, { method: "PATCH", timeoutMs: 10000,
    body: JSON.stringify({ ...value, updated_by: `${session.id}:${session.username}` }) });
  if (!result.ok) return NextResponse.json({ error: result.status === 409
    ? "Worker đã thay đổi trạng thái hoặc mất kết nối. Dữ liệu mới đã được tải lại; hãy kiểm tra trước khi thử lại."
    : result.error }, { status: result.status || 503 });
  return NextResponse.json(result.data);
}
