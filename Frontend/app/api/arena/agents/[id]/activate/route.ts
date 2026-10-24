import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Manual activation was replaced by queued self-play validation. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  void _req;
  void params;
  return NextResponse.json(
    { error: "Agent được tự duyệt bằng self-play sau khi nộp." },
    { status: 410 },
  );
}
