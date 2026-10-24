import { backendFetch } from "@/lib/backend";

// A replacement worker may take over a crashed execution only after Redis
// confirms it owns the current delivery, never just by presenting a new token.
export async function verifyDelivery(taskId: string, deliveryId: string): Promise<boolean | null> {
  const response = await backendFetch("/worker/tasks/verify", {
    method: "POST", body: JSON.stringify({ task_id: taskId, delivery_id: deliveryId }), timeoutMs: 5000,
  });
  if (!response.ok) return null;
  return isRecord(response.data) && response.data.ok === true;
}

export type MoveEntry = {
  move_number: number; player: number;
  from_col: number; from_row: number; to_col: number; to_row: number;
  from_pos: string; to_pos: string;
  piece_type?: string | null; captured_type?: string | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isMatchId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isExecutionToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function parseFinishedCallback(body: Record<string, unknown>) {
  if (!isExecutionToken(body.execution_token)) return null;
  const isInfra = body.is_infra_error === true;
  const outcome: "agent1" | "agent2" | "draw" | null = body.outcome === "agent1" || body.outcome === "agent2" || body.outcome === "draw"
    ? body.outcome : null;
  if (!isInfra && outcome === null) return null;
  const totalMoves = body.total_moves ?? 0;
  if (typeof totalMoves !== "number" || !Number.isInteger(totalMoves) || totalMoves < 0 || totalMoves > 1000) return null;
  const moves = body.moves_history ?? [];
  if (!Array.isArray(moves) || moves.length > 1000) return null;
  const seen = new Set<number>();
  for (const move of moves) {
    if (!isRecord(move) || !isMatchId(move.move_number) || move.move_number > 1000 || seen.has(move.move_number)) return null;
    if (move.player !== 1 && move.player !== 2) return null;
    for (const key of ["from_col", "from_row", "to_col", "to_row"]) {
      const value = move[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 8) return null;
    }
    if (move.from_pos !== `${"abcdefghi"[move.from_col as number]}${(move.from_row as number) + 1}` ||
        move.to_pos !== `${"abcdefghi"[move.to_col as number]}${(move.to_row as number) + 1}`) return null;
    for (const key of ["piece_type", "captured_type"]) {
      if (move[key] != null && !["ROCK", "PAPER", "SCISSORS"].includes(String(move[key]))) return null;
    }
    seen.add(move.move_number);
  }
  return {
    token: body.execution_token,
    isInfra,
    outcome: isInfra ? null : outcome,
    totalMoves,
    moves: moves as MoveEntry[],
    agentError: body.agent_error === true,
    winReason: typeof body.win_reason === "string" ? body.win_reason.slice(0, 500) : "",
    infraDetail: typeof body.infra_error_detail === "string" ? body.infra_error_detail.slice(0, 1000) : null,
  };
}
