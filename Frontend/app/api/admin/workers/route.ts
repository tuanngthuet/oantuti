import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { backendFetch } from "@/lib/backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session?.is_admin) return NextResponse.json({ error: "Không có quyền." }, { status: 403 });
  const result = await backendFetch("/workers/admin", { timeoutMs: 10000, cache: "no-store" });
  if (!result.ok) return NextResponse.json({ error: result.error, backend_offline: result.isOffline }, { status: result.status || 503 });
  return NextResponse.json(result.data);
}
