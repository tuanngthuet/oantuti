import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sql } from "@/lib/db";

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session?.is_admin) return NextResponse.json({ error: "Không có quyền." }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "JSON không hợp lệ." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      typeof (body as { enabled?: unknown }).enabled !== "boolean") {
    return NextResponse.json({ error: "Cần enabled dạng boolean." }, { status: 400 });
  }
  try {
    const rows = await sql`UPDATE rating_scheduler_state SET enabled = ${(body as { enabled: boolean }).enabled}
      WHERE id = true RETURNING enabled`;
    if (!rows.length) return NextResponse.json({ error: "Thiếu cấu hình scheduler." }, { status: 503 });
    return NextResponse.json({ ok: true, enabled: rows[0].enabled });
  } catch {
    return NextResponse.json({ error: "Không thể cập nhật scheduler." }, { status: 503 });
  }
}
