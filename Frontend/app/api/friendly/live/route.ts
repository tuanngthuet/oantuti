import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * The per-move SSE execution path was retired. Friendly games are queued as
 * full-match tasks through POST /api/friendly and completed by the worker.
 */
export async function GET() {
  return NextResponse.json(
    {
      error: "Luồng chạy từng nước đã bị ngừng. Tạo trận qua POST /api/friendly; worker sẽ chạy trọn trận.",
    },
    { status: 410 },
  );
}
