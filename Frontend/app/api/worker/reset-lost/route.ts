import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { requireWorkerCallbackSecret } from "@/lib/worker-auth";

export const runtime = "nodejs";

/**
 * POST /api/worker/reset-lost
 *
 * Worker gọi khi startup nếu có task bị lost (Redis TTL hết).
 * Reset rated_matches + friendly_matches đang 'running' > 15 phút về 'scheduled'
 * để dispatch_rating_task có thể pick up lại.
 *
 * Auth: X-Worker-Callback-Secret
 */
export async function POST(request: Request) {
  const authErr = requireWorkerCallbackSecret(request);
  if (authErr) return authErr;

  try {
    const ratedRows = await sql`
      UPDATE rated_matches
      SET status = 'scheduled',
          dispatched_at = NULL,
          started_at = NULL,
          execution_token = NULL,
          execution_worker = NULL
      WHERE status = 'running'
        AND (started_at IS NULL OR started_at < NOW() - INTERVAL '15 minutes')
      RETURNING id
    ` as { id: number }[];

    const friendlyRows = await sql`
      UPDATE friendly_matches
      SET status = 'scheduled', pending_backend = true,
          execution_token = NULL, execution_worker = NULL
      WHERE status = 'running'
        AND created_at < NOW() - INTERVAL '15 minutes'
      RETURNING id
    ` as { id: number }[];

    const nRated = ratedRows.length;
    const nFriendly = friendlyRows.length;

    if (nRated + nFriendly > 0) {
      console.log(`[reset-lost] ${nRated} rated + ${nFriendly} friendly → scheduled`);
    }
    return NextResponse.json({ ok: true, reset_rated: nRated, reset_friendly: nFriendly });
  } catch (error) {
    console.error("[reset-lost] DB error:", error);
    return NextResponse.json({ ok: false, error: "DB error" }, { status: 500 });
  }
}
