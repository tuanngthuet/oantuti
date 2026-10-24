import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sql } from "@/lib/db";
import { backendFetch, isBackendOnline } from "@/lib/backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// active_task_ids từ worker: ["rating-12", "friendly-5"]
function parseTaskId(tid: string): { type: string; matchId: number } | null {
  const m = tid.match(/^(rating|friendly)-(\d+)$/);
  if (!m) return null;
  return { type: m[1], matchId: parseInt(m[2], 10) };
}

export async function GET() {
  const session = await getSession();
  if (!session?.is_admin) {
    return NextResponse.json({ error: "Không có quyền." }, { status: 403 });
  }

  // 1. Worker status từ backend
  const [backendOnline, workerResult] = await Promise.all([
    isBackendOnline(),
    backendFetch("/workers/status", { timeoutMs: 8_000 }),
  ]);
  const workerStatus = workerResult.ok
    ? (workerResult.data as {
        workers: {
          worker_id: string;
          judge0_url: string;
          active_jobs: number;
          max_concurrent: number;
          available_slots: number;
          seconds_ago: number;
          active_task_ids: string[];
          state?: string;
          last_error?: string;
        }[];
        total_workers: number;
        total_active_jobs: number;
        total_available_slots: number;
        queue_depth: number;
      })
    : null;

  // 2. Enrich active_task_ids với thông tin DB (agent names)
  type ActiveTask = {
    task_id: string;
    type: string;
    match_id: number;
    agent1_name: string;
    agent2_name: string;
  };

  type EnrichedWorker = NonNullable<typeof workerStatus>["workers"][number] & {
    active_tasks: ActiveTask[];
  };

  let enrichedWorkers: EnrichedWorker[] = [];

  if (workerStatus && workerStatus.workers.length > 0) {
    const ratingIds: number[] = [];
    const friendlyIds: number[] = [];

    for (const w of workerStatus.workers) {
      for (const tid of (w.active_task_ids ?? [])) {
        const parsed = parseTaskId(tid);
        if (!parsed) continue;
        if (parsed.type === "rating") ratingIds.push(parsed.matchId);
        else if (parsed.type === "friendly") friendlyIds.push(parsed.matchId);
      }
    }

    // Batch lookup từ DB
    type AgentRow = { id: number; kind?: string; agent1_name: string; agent2_name: string };
    const ratingInfo: Record<number, AgentRow> = {};
    const friendlyInfo: Record<number, AgentRow> = {};

    try {
      if (ratingIds.length > 0) {
        const rows = await sql`
          SELECT rm.id::int AS id, rm.kind,
                 a1.agent_name AS agent1_name,
                 a2.agent_name AS agent2_name
          FROM rated_matches rm
          LEFT JOIN arena_agents a1 ON a1.id = rm.agent1_id
          LEFT JOIN arena_agents a2 ON a2.id = rm.agent2_id
          WHERE rm.id = ANY(${ratingIds})
        ` as AgentRow[];
        for (const r of rows) ratingInfo[r.id] = r;
      }
      if (friendlyIds.length > 0) {
        const rows = await sql`
          SELECT fm.id::int AS id,
                 a1.agent_name AS agent1_name,
                 a2.agent_name AS agent2_name
          FROM friendly_matches fm
          LEFT JOIN arena_agents a1 ON a1.id = fm.agent1_id
          LEFT JOIN arena_agents a2 ON a2.id = fm.agent2_id
          WHERE fm.id = ANY(${friendlyIds})
        ` as AgentRow[];
        for (const r of rows) friendlyInfo[r.id] = r;
      }
    } catch { /* ignore DB errors for enrichment */ }

    enrichedWorkers = workerStatus.workers.map((w) => ({
      ...w,
      active_tasks: (w.active_task_ids ?? []).map((tid): ActiveTask => {
        const parsed = parseTaskId(tid);
        if (!parsed) return { task_id: tid, type: "unknown", match_id: 0, agent1_name: "?", agent2_name: "?" };
        const info = parsed.type === "rating"
          ? ratingInfo[parsed.matchId]
          : friendlyInfo[parsed.matchId];
        return {
          task_id: tid,
          type: info?.kind === 'validation' ? 'validation' : parsed.type,
          match_id: parsed.matchId,
          agent1_name: info?.agent1_name ?? "?",
          agent2_name: info?.agent2_name ?? "?",
        };
      }),
    }));
  }

  // 3. Match stats
  const matchStats = { running: 0, finished: 0, error: 0, pending: 0 };
  const statsByKind = {
    validation: {running:0,finished:0,error:0,pending:0},
    rating: {running:0,finished:0,error:0,pending:0},
    friendly: {running:0,finished:0,error:0,pending:0},
  };
  try {
    const [friendlyStats, ratingStats] = await Promise.all([
      sql`SELECT 'friendly' AS kind, status, COUNT(*)::int AS cnt FROM friendly_matches GROUP BY status`,
      sql`SELECT kind, status, COUNT(*)::int AS cnt FROM rated_matches GROUP BY kind,status`,
    ]) as [{kind:string;status:string;cnt:number}[],{kind:string;status:string;cnt:number}[]];

    for (const row of [...friendlyStats, ...ratingStats]) {
      const kind=row.kind as keyof typeof statsByKind;
      const state=row.status==='scheduled'?'pending':row.status;
      if(statsByKind[kind]&&state in statsByKind[kind])statsByKind[kind][state as keyof typeof matchStats]+=row.cnt;
      if (row.status === "running")   matchStats.running   += row.cnt;
      if (row.status === "finished")  matchStats.finished  += row.cnt;
      if (row.status === "error")     matchStats.error     += row.cnt;
      if (row.status === "scheduled") matchStats.pending   += row.cnt;
    }
  } catch { /* ignore */ }

  // 4. Recent matches
  let recentMatches: unknown[] = [];
  try {
    recentMatches = await sql`
      SELECT
        id,
        source,
        queue_state,
        status,
        outcome,
        total_moves,
        is_infra_error,
        created_at,
        finished_at,
        created_by_username,
        agent1_name,
        agent2_name,
        session_name
      FROM (
        SELECT
          fm.id,
          'friendly'                  AS source,
          CASE WHEN fm.status='scheduled' THEN CASE WHEN fm.pending_backend THEN 'waiting_dispatch' ELSE 'queued' END ELSE fm.status END AS queue_state,
          fm.status,
          fm.outcome,
          fm.total_moves,
          fm.is_infra_error,
          fm.created_at,
          fm.finished_at,
          u.username                  AS created_by_username,
          a1.agent_name               AS agent1_name,
          a2.agent_name               AS agent2_name,
          NULL::text                  AS session_name
        FROM friendly_matches fm
        LEFT JOIN users u         ON u.id  = fm.created_by
        LEFT JOIN arena_agents a1 ON a1.id = fm.agent1_id
        LEFT JOIN arena_agents a2 ON a2.id = fm.agent2_id

        UNION ALL

        SELECT
          rm.id,
          rm.kind                     AS source,
          CASE WHEN rm.status='scheduled' THEN CASE WHEN rm.dispatched_at IS NULL THEN 'waiting_dispatch' ELSE 'queued' END ELSE rm.status END AS queue_state,
          rm.status,
          rm.outcome,
          rm.total_moves,
          rm.is_infra_error,
          rm.scheduled_at              AS created_at,
          rm.finished_at,
          CASE WHEN rm.kind='validation' THEN u.username ELSE NULL END AS created_by_username,
          a1.agent_name                AS agent1_name,
          a2.agent_name                AS agent2_name,
          NULL::text                   AS session_name
        FROM rated_matches rm
        LEFT JOIN arena_agents a1 ON a1.id = rm.agent1_id
        LEFT JOIN arena_agents a2 ON a2.id = rm.agent2_id
        LEFT JOIN users u ON u.id=a1.user_id
        WHERE rm.kind IN ('rating','validation')
      ) combined
      ORDER BY created_at DESC, id DESC, source
      LIMIT 20
    `;
  } catch { /* ignore */ }

  return NextResponse.json({
    backend_online: backendOnline,
    worker_status_error: workerResult.ok ? null : workerResult.error,
    worker_status: workerStatus
      ? { ...workerStatus, workers: enrichedWorkers }
      : null,
    recent_matches: recentMatches,
    match_stats: matchStats,
    match_stats_by_kind: statsByKind,
  });
}
