import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sql } from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/admin/matches/reset-stuck
 *
 * Admin gọi từ UI để reset tất cả trận bị kẹt status='running'.
 * Yêu cầu đăng nhập admin.
 *
 * Query param: ?mode=error  (default) → running → error
 *              ?mode=pending          → running → scheduled (để worker retry)
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.is_admin) {
    return NextResponse.json({ error: "Không có quyền." }, { status: 403 });
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") ?? "error";

  try {
    if (mode === "pending") {
      // Reset về scheduled → dispatcher sẽ pick up lại
      const ratedRows = await sql`
        UPDATE rated_matches
        SET status = 'scheduled',
            dispatched_at = NULL,
            started_at = NULL,
            execution_token = NULL,
            execution_worker = NULL
        WHERE status = 'running'
        RETURNING id
      ` as { id: number }[];
      const friendlyRows = await sql`
        UPDATE friendly_matches
        SET status = 'scheduled', pending_backend = true,
            execution_token = NULL, execution_worker = NULL
        WHERE status = 'running'
        RETURNING id
      ` as { id: number }[];
      return NextResponse.json({
        ok: true,
        mode: "pending",
        reset_rated: ratedRows.length,
        reset_friendly: friendlyRows.length,
      });
    } else {
      // Reset về error (default)
      const ratedRows = await sql`
        UPDATE rated_matches
        SET status = 'error',
            finished_at = NOW(), is_infra_error = true,
            execution_token = NULL, execution_worker = NULL,
            win_reason = 'Manual reset by admin - worker stuck'
        WHERE status = 'running'
        RETURNING id
      ` as { id: number }[];
      const friendlyRows = await sql`
        UPDATE friendly_matches
        SET status = 'error',
            finished_at = NOW(), is_infra_error = true,
            execution_token = NULL, execution_worker = NULL,
            win_reason = 'Manual reset by admin - worker stuck'
        WHERE status = 'running'
        RETURNING id
      ` as { id: number }[];
      return NextResponse.json({
        ok: true,
        mode: "error",
        reset_rated: ratedRows.length,
        reset_friendly: friendlyRows.length,
      });
    }
  } catch (error) {
    console.error("[reset-stuck] DB error:", error);
    return NextResponse.json({ ok: false, error: "DB error" }, { status: 500 });
  }
}
