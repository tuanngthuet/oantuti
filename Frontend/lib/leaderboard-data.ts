import { sql } from '@/lib/db';
import type { RankedAgent } from '@/lib/leaderboard';

const CACHE_TTL_MS = 2000;
let cachedAllAgents: { expiresAt: number; data: RankedAgent[] } | null = null;
let inFlightAllAgents: Promise<RankedAgent[]> | null = null;

async function queryPublicAgents(userId: number | null = null): Promise<RankedAgent[]> {
  return await sql`
    WITH target_agents AS (
      SELECT a.*
      FROM arena_agents a
      WHERE a.status = 'active' AND a.is_public AND (${userId}::bigint IS NULL OR a.user_id = ${userId})
    ),
    match_stats AS (
      SELECT agent_id, COUNT(*)::int AS valid_games, MAX(finished_at) AS last_finished_at
      FROM (
        SELECT m.agent1_id AS agent_id, m.finished_at
        FROM rated_matches m
        WHERE m.kind = 'rating' AND m.status = 'finished' AND NOT m.is_infra_error
          AND m.agent1_id IN (SELECT id FROM target_agents)
        UNION ALL
        SELECT m.agent2_id AS agent_id, m.finished_at
        FROM rated_matches m
        WHERE m.kind = 'rating' AND m.status = 'finished' AND NOT m.is_infra_error
          AND m.agent2_id IN (SELECT id FROM target_agents)
      ) mp
      GROUP BY agent_id
    ),
    team_rosters AS (
      SELECT tm.team_id, json_agg(json_build_object('id', u2.id, 'username', u2.username) ORDER BY u2.id) AS members
      FROM team_members tm
      JOIN users u2 ON u2.id = tm.user_id
      WHERE tm.team_id IN (SELECT DISTINCT team_id FROM target_agents WHERE team_id IS NOT NULL)
      GROUP BY tm.team_id
    )
    SELECT a.id, a.user_id, u.username, a.agent_name, a.version, a.status,
      a.is_active, a.rating AS elo, a.wins, a.losses, a.draws, a.submitted_at,
      COALESCE(s.valid_games, 0)::int AS valid_games, s.last_finished_at,
      a.team_id, t.name AS team_name, t.recruiting, agent_scope_active(a.id) AS scope_active,
      COALESCE(tr.members, '[]'::json) AS members
    FROM target_agents a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN teams t ON t.id = a.team_id
    LEFT JOIN match_stats s ON s.agent_id = a.id
    LEFT JOIN team_rosters tr ON tr.team_id = a.team_id
  ` as RankedAgent[];
}

// Explicit projection: never expose submission source or private account data.
export async function publicAgents(userId: number | null = null) {
  if (userId === null && process.env.NODE_ENV === 'production') {
    const now = Date.now();
    if (cachedAllAgents && cachedAllAgents.expiresAt > now) {
      return cachedAllAgents.data;
    }
    if (!inFlightAllAgents) {
      inFlightAllAgents = queryPublicAgents(null)
        .then(data => {
          cachedAllAgents = { expiresAt: Date.now() + CACHE_TTL_MS, data };
          return data;
        })
        .finally(() => {
          inFlightAllAgents = null;
        });
    }
    return await inFlightAllAgents;
  }
  return await queryPublicAgents(userId);
}
