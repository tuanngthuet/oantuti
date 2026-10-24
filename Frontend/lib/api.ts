/** Lightweight client for the FastAPI worker health endpoint. */

const BACKEND_URL =
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  "http://localhost:8000";

export interface HealthResponse {
  status: string;
  redis_connected: boolean;
  version: string;
}

async function apiFetch<T>(path: string): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(`${BACKEND_URL}${path}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { data: null, error: body?.detail ?? `HTTP ${response.status}` };
    }
    return { data: (await response.json()) as T, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : "Network error" };
  }
}

export const backendApi = {
  health(): Promise<{ data: HealthResponse | null; error: string | null }> {
    return apiFetch<HealthResponse>("/health");
  },
};
