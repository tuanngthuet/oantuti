/**
 * HTTP client for calls to the FastAPI backend.
 * Tất cả request từ Next.js server → backend đều gửi X-Internal-Secret header.
 */

const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export const BACKEND_OFFLINE_MESSAGE =
  "Backend đang offline. Vui lòng thử lại sau.";

export function getBackendUrl(): string {
  return (
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    "http://localhost:8000"
  );
}

function getInternalSecret(): string {
  return process.env.INTERNAL_BACKEND_SECRET ?? "";
}

export function backendOfflineResponse(detail?: string) {
  return {
    error: detail ?? BACKEND_OFFLINE_MESSAGE,
    backend_offline: true,
  };
}

export async function isBackendOnline(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      HEALTH_CHECK_TIMEOUT_MS,
    );
    const res = await fetch(`${getBackendUrl()}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function backendFetch(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<
  | { ok: true; data: unknown; status: number }
  | { ok: false; status: number; error: string; isOffline?: boolean }
> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  const url = `${getBackendUrl()}${path}`;
  const secret = getInternalSecret();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Merge in the internal secret header
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(fetchOptions.headers as Record<string, string> | undefined),
    };
    if (secret) {
      headers["X-Internal-Secret"] = secret;
    }

    const res = await fetch(url, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      let errorMsg = `HTTP ${res.status}`;
      try {
        const body = await res.json() as { detail?: unknown; error?: unknown };
        const detail = body.detail ?? body.error;
        if (detail !== undefined) errorMsg = typeof detail === 'string' ? detail : JSON.stringify(detail);
      } catch { /* ignore parse error */ }
      return { ok: false, status: res.status, error: errorMsg };
    }

    const data = await res.json();
    return { ok: true, data, status: res.status };
  } catch (err) {
    const isTimeout =
      err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: isTimeout ? "Request timeout" : String(err),
      isOffline: true,
    };
  }
}
