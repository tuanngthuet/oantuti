/** PostgreSQL owns selection/reservations; network operations run after commit. */
import { randomUUID } from "node:crypto";
import { backendFetch } from "@/lib/backend";
import { sql } from "@/lib/db";

type Reservation = {
  reason: string; retry_after_seconds: number; match_id?: number; kind?: "validation" | "rating";
  agent1_id?: number; agent2_id?: number; agent1_code?: string; agent2_code?: string;
};

export async function dispatchNextRatingTask() {
  const status = await backendFetch("/workers/status", { timeoutMs: 10_000, cache: "no-store" });
  if (!status.ok) return { dispatched: false, reason: "backend_unavailable", retry_after_seconds: 15 };
  const capacity = status.data as { queue_depth: number; total_available_slots: number };
  const slots = capacity.queue_depth === 0 ? Math.max(0, Math.floor(capacity.total_available_slots)) : 0;
  const token = randomUUID();
  const rows = await sql`SELECT reserve_rating_dispatch(${token}::uuid, ${slots}::integer) AS reservation`;
  const match = rows[0].reservation as Reservation;
  if (!match.match_id) return { dispatched: false, reason: capacity.queue_depth > 0 && match.reason === "no_capacity"
    ? "queue_backlog" : match.reason, retry_after_seconds: match.retry_after_seconds };
  const response = await backendFetch("/rating/enqueue", {
    method: "POST", timeoutMs: 10_000,
    body: JSON.stringify({ rated_match_id: match.match_id, kind: match.kind,
      agent1_id: match.agent1_id, agent2_id: match.agent2_id,
      agent1_code: match.agent1_code, agent2_code: match.agent2_code, max_moves: match.kind === 'validation' ? 60 : 200 }),
  });
  if (!response.ok) {
    await sql`UPDATE rated_matches SET dispatch_token = NULL, dispatch_lease_until = NULL
      WHERE id = ${match.match_id} AND dispatch_token = ${token}::uuid`;
    return { dispatched: false, queued: false, match_id: match.match_id, kind: match.kind,
      reason: "enqueue_failed", error: response.error, retry_after_seconds: 15 };
  }
  await sql`UPDATE rated_matches SET dispatched_at = NOW(), dispatch_token = NULL, dispatch_lease_until = NULL
    WHERE id = ${match.match_id} AND dispatch_token = ${token}::uuid`;
  return { dispatched: true, queued: true, match_id: match.match_id, kind: match.kind,
    reason: "queued", retry_after_seconds: 5 };
}
