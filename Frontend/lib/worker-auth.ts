/**
 * Auth helpers cho worker callback routes.
 * Worker gửi header X-Worker-Callback-Secret khi callback về Next.js.
 */

export function getWorkerCallbackSecret(): string {
  return process.env.WORKER_CALLBACK_SECRET ?? "";
}

/**
 * Verify X-Worker-Callback-Secret header.
 * Returns true nếu hợp lệ.
 */
export function verifyWorkerCallbackSecret(request: Request): boolean {
  const secret = getWorkerCallbackSecret();
  if (!secret) return false; // secret chưa cấu hình → từ chối tất cả
  const header = request.headers.get("x-worker-callback-secret");
  return header === secret;
}

/**
 * Returns a 401 NextResponse if secret is invalid.
 * Usage: const authErr = requireWorkerCallbackSecret(request); if (authErr) return authErr;
 */
import { NextResponse } from "next/server";

export function requireWorkerCallbackSecret(
  request: Request,
): NextResponse | null {
  if (!verifyWorkerCallbackSecret(request)) {
    return NextResponse.json(
      { error: "Missing or invalid X-Worker-Callback-Secret." },
      { status: 401 },
    );
  }
  return null;
}
