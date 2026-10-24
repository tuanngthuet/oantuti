import { NextResponse } from "next/server";
import { dispatchNextRatingTask } from "@/lib/rating-scheduler";
import { requireWorkerCallbackSecret } from "@/lib/worker-auth";

export const runtime = "nodejs";

/**
 * POST /api/rating/dispatch
 * Worker gọi khi có slot trống để yêu cầu tạo thêm trận TrueSkill.
 * Auth: X-Worker-Callback-Secret
 */
export async function POST(request: Request) {
  const authErr = requireWorkerCallbackSecret(request);
  if (authErr) return authErr;

  try {
    return NextResponse.json(await dispatchNextRatingTask());
  } catch (error) {
    console.error("Rating dispatcher failed:", error);
    return NextResponse.json({ error: "Không thể tạo trận rating." }, { status: 500 });
  }
}
