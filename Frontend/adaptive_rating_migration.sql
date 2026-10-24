-- Additive migration only: never reset ratings or replay history.
CREATE TABLE IF NOT EXISTS rating_scheduler_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  minimum_games integer NOT NULL DEFAULT 10 CHECK (minimum_games > 0),
  stable_sigma double precision NOT NULL DEFAULT 2.5 CHECK (stable_sigma > 0),
  daily_budget integer NOT NULL DEFAULT 20 CHECK (daily_budget > 0),
  refresh_hours integer NOT NULL DEFAULT 24 CHECK (refresh_hours > 0),
  pair_cooldown_seconds integer NOT NULL DEFAULT 60 CHECK (pair_cooldown_seconds >= 0),
  exploration_every integer NOT NULL DEFAULT 5 CHECK (exploration_every > 0),
  aging_minutes integer NOT NULL DEFAULT 30 CHECK (aging_minutes > 0),
  infra_error_limit integer NOT NULL DEFAULT 3 CHECK (infra_error_limit > 0),
  infra_backoff_minutes integer NOT NULL DEFAULT 15 CHECK (infra_backoff_minutes > 0)
);
INSERT INTO rating_scheduler_policy(id) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE rated_matches ADD COLUMN IF NOT EXISTS dispatch_token uuid;
ALTER TABLE rated_matches ADD COLUMN IF NOT EXISTS dispatch_lease_until timestamptz;
ALTER TABLE rated_matches ADD COLUMN IF NOT EXISTS scheduler_focal_id bigint REFERENCES arena_agents(id) ON DELETE SET NULL;
ALTER TABLE rated_matches ADD COLUMN IF NOT EXISTS scheduling_reason text;
ALTER TABLE rated_matches ADD COLUMN IF NOT EXISTS selection_mode text;
CREATE INDEX IF NOT EXISTS rated_matches_dispatch_idx ON rated_matches(kind, dispatched_at, dispatch_lease_until) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS rated_matches_pair_idx ON rated_matches(LEAST(agent1_id, agent2_id), GREATEST(agent1_id, agent2_id), finished_at DESC) WHERE kind = 'rating';

CREATE OR REPLACE VIEW rating_agent_schedule AS
WITH stats AS (
  SELECT a.id, a.user_id, a.agent_name, a.submitted_at, a.rating, a.trueskill_mu, a.trueskill_sigma,
    p.*, s.*
  FROM arena_agents a CROSS JOIN (SELECT minimum_games, stable_sigma, daily_budget, refresh_hours,
    pair_cooldown_seconds, exploration_every, aging_minutes, infra_error_limit, infra_backoff_minutes
    FROM rating_scheduler_policy WHERE id = true) p
  CROSS JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE status = 'finished' AND NOT is_infra_error)::int AS valid_games,
      COUNT(*) FILTER (WHERE status = 'finished' AND NOT is_infra_error AND finished_at > NOW() - INTERVAL '24 hours')::int AS games_24h,
      COUNT(*) FILTER (WHERE status IN ('scheduled', 'running'))::int AS reserved_games,
      COALESCE(BOOL_OR(status IN ('scheduled', 'running')), false) AS busy,
      MAX(finished_at) FILTER (WHERE status = 'finished' AND NOT is_infra_error) AS last_finished_at,
      (ARRAY_AGG(finished_at + INTERVAL '24 hours' ORDER BY finished_at)
        FILTER (WHERE status = 'finished' AND NOT is_infra_error AND finished_at > NOW() - INTERVAL '24 hours'))[
          GREATEST(1, COUNT(*) FILTER (WHERE status = 'finished' AND NOT is_infra_error AND finished_at > NOW() - INTERVAL '24 hours')
            + COUNT(*) FILTER (WHERE status IN ('scheduled','running')) - p.daily_budget + 1)::integer] AS budget_reset_at,
      COUNT(*) FILTER (WHERE is_infra_error AND status = 'error' AND finished_at > NOW() - INTERVAL '1 hour')::int AS infra_errors,
      MAX(finished_at) FILTER (WHERE is_infra_error AND status = 'error') AS last_infra_at,
      COUNT(*) FILTER (WHERE scheduler_focal_id = a.id AND status <> 'cancelled')::int AS focal_games
    FROM rated_matches WHERE kind = 'rating' AND (agent1_id = a.id OR agent2_id = a.id)
  ) s WHERE a.status = 'active' AND a.is_active
), classified AS (
  SELECT *, GREATEST(0, daily_budget - games_24h - reserved_games)::int AS budget_remaining,
    CASE WHEN infra_errors >= infra_error_limit THEN last_infra_at + make_interval(mins => infra_backoff_minutes) END AS backoff_until,
    last_finished_at + make_interval(hours => refresh_hours) AS refresh_at FROM stats
)
SELECT *, CASE WHEN busy THEN 'busy' WHEN budget_remaining = 0 THEN 'budget_exhausted'
    WHEN backoff_until > NOW() THEN 'infra_backoff' WHEN valid_games < minimum_games THEN 'calibrating'
    WHEN trueskill_sigma > stable_sigma THEN 'uncertain' WHEN refresh_at <= NOW() THEN 'refresh_due' ELSE 'stable' END AS schedule_state,
  CASE WHEN busy THEN NULL WHEN budget_remaining = 0 THEN budget_reset_at WHEN backoff_until > NOW() THEN backoff_until
    WHEN valid_games < minimum_games OR trueskill_sigma > stable_sigma THEN NOW() ELSE refresh_at END AS next_evaluation_at
FROM classified;

-- Fresh statement snapshots after the row lock; never hold it during HTTP calls.
CREATE OR REPLACE FUNCTION reserve_rating_dispatch(p_token uuid, p_capacity integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_enabled boolean;
  v_now timestamptz;
  v_match rated_matches%ROWTYPE;
  v_focal record;
  v_opponent record;
  v_one bigint;
  v_two bigint;
  v_explore boolean;
  v_last_first bigint;
BEGIN
  SELECT enabled INTO v_enabled FROM rating_scheduler_state WHERE id = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Scheduler state missing'; END IF;
  v_now := clock_timestamp();
  SELECT m.* INTO v_match FROM rated_matches m
  WHERE m.status = 'scheduled' AND m.execution_token IS NULL
    AND (m.kind = 'validation' OR (v_enabled AND p_capacity > 0))
    AND (m.dispatch_lease_until IS NULL OR m.dispatch_lease_until <= v_now)
    AND (m.dispatched_at IS NULL OR m.dispatched_at < v_now - INTERVAL '10 minutes')
    -- serialize_pending_rating_agents
    AND (m.kind='validation' OR NOT EXISTS (
      SELECT 1 FROM rated_matches active WHERE active.id<>m.id AND active.kind='rating'
        AND active.status IN ('scheduled','running')
        AND (active.status='running' OR active.dispatched_at>=v_now-INTERVAL '10 minutes' OR active.dispatch_lease_until>v_now)
        AND (active.agent1_id IN (m.agent1_id,m.agent2_id) OR active.agent2_id IN (m.agent1_id,m.agent2_id))
    ))
  ORDER BY CASE m.kind WHEN 'validation' THEN 0 ELSE 1 END, m.scheduled_at, m.id LIMIT 1;
  IF v_match.id IS NULL THEN
    IF NOT v_enabled THEN RETURN jsonb_build_object('reason', 'paused', 'retry_after_seconds', 60); END IF;
    IF p_capacity <= 0 THEN RETURN jsonb_build_object('reason', 'no_capacity', 'retry_after_seconds', 5); END IF;
    IF (SELECT COUNT(*) FROM rated_matches WHERE kind = 'rating' AND status = 'scheduled') >= p_capacity THEN
      RETURN jsonb_build_object('reason', 'pending_backlog', 'retry_after_seconds', 5);
    END IF;
    FOR v_focal IN
      SELECT * FROM rating_agent_schedule WHERE schedule_state IN ('calibrating', 'uncertain', 'refresh_due')
      ORDER BY ((CASE WHEN schedule_state = 'refresh_due' THEN refresh_at ELSE COALESCE(last_finished_at, submitted_at) END)
          < v_now - make_interval(mins => aging_minutes)) DESC,
        CASE schedule_state WHEN 'calibrating' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
        games_24h, COALESCE(last_finished_at, submitted_at), trueskill_sigma DESC, id
    LOOP
      v_explore := MOD(v_focal.focal_games + 1, v_focal.exploration_every) = 0;
      SELECT o.*, h.focal_first, h.other_first INTO v_opponent
      FROM rating_agent_schedule o
      CROSS JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE m.status = 'finished' AND NOT m.is_infra_error AND m.finished_at > v_now - INTERVAL '24 hours') AS pair_games,
          COUNT(*) FILTER (WHERE m.status = 'finished' AND NOT m.is_infra_error AND m.outcome = 'draw' AND m.finished_at > v_now - INTERVAL '24 hours') AS pair_draws,
          MAX(COALESCE(m.finished_at, m.started_at, m.scheduled_at)) FILTER (WHERE m.status <> 'cancelled') AS last_met,
          COUNT(*) FILTER (WHERE m.status = 'finished' AND NOT m.is_infra_error AND m.agent1_id = v_focal.id) AS focal_first,
          COUNT(*) FILTER (WHERE m.status = 'finished' AND NOT m.is_infra_error AND m.agent1_id = o.id) AS other_first
        FROM rated_matches m WHERE m.kind = 'rating'
          AND LEAST(m.agent1_id, m.agent2_id) = LEAST(v_focal.id, o.id)
          AND GREATEST(m.agent1_id, m.agent2_id) = GREATEST(v_focal.id, o.id)
      ) h
      CROSS JOIN LATERAL (
        SELECT SQRT((2 * POWER(25.0/6, 2)) / (POWER(v_focal.trueskill_sigma, 2) + POWER(o.trueskill_sigma, 2) + 2 * POWER(25.0/6, 2)))
          * EXP(-POWER(v_focal.trueskill_mu - o.trueskill_mu, 2) / (2 * (POWER(v_focal.trueskill_sigma, 2) + POWER(o.trueskill_sigma, 2) + 2 * POWER(25.0/6, 2)))) AS quality
      ) q
      WHERE o.id <> v_focal.id AND o.user_id <> v_focal.user_id AND NOT o.busy AND o.budget_remaining > 0
        AND (o.backoff_until IS NULL OR o.backoff_until <= v_now)
        AND h.pair_draws < 2 -- draw_pair_daily_limit
        AND (h.last_met IS NULL OR h.last_met <= v_now - make_interval(secs => v_focal.pair_cooldown_seconds))
      ORDER BY (o.id IN (
        SELECT CASE WHEN m.agent1_id = v_focal.id THEN m.agent2_id ELSE m.agent1_id END
        FROM rated_matches m WHERE m.kind = 'rating' AND m.status = 'finished' AND NOT m.is_infra_error
          AND (m.agent1_id = v_focal.id OR m.agent2_id = v_focal.id)
        GROUP BY CASE WHEN m.agent1_id = v_focal.id THEN m.agent2_id ELSE m.agent1_id END
        ORDER BY MAX(m.finished_at) DESC LIMIT 3
      )), CASE WHEN v_explore THEN h.pair_games ELSE 0 END, q.quality DESC, o.trueskill_sigma DESC, o.id LIMIT 1;
      IF v_opponent.id IS NULL THEN CONTINUE; END IF;
      v_one := v_focal.id; v_two := v_opponent.id;
      IF v_opponent.focal_first > v_opponent.other_first THEN
        v_one := v_opponent.id; v_two := v_focal.id;
      ELSIF v_opponent.focal_first = v_opponent.other_first THEN
        SELECT agent1_id INTO v_last_first FROM rated_matches
        WHERE kind = 'rating' AND status = 'finished' AND NOT is_infra_error
          AND LEAST(agent1_id, agent2_id) = LEAST(v_one, v_two)
          AND GREATEST(agent1_id, agent2_id) = GREATEST(v_one, v_two)
        ORDER BY finished_at DESC, id DESC LIMIT 1;
        IF v_last_first = v_one THEN v_one := v_opponent.id; v_two := v_focal.id; END IF;
      END IF;
      INSERT INTO rated_matches(kind, agent1_id, agent2_id, scheduler_focal_id, scheduling_reason, selection_mode)
      VALUES ('rating', v_one, v_two, v_focal.id, v_focal.schedule_state,
        CASE WHEN v_explore THEN 'exploration' ELSE 'quality' END) RETURNING * INTO v_match;
      EXIT;
    END LOOP;
  END IF;
  IF v_match.id IS NULL THEN RETURN jsonb_build_object('reason', 'no_eligible_pair', 'retry_after_seconds', 60); END IF;
  UPDATE rated_matches SET dispatch_token = p_token, dispatch_lease_until = v_now + INTERVAL '30 seconds' WHERE id = v_match.id;
  RETURN jsonb_build_object('reason', 'reserved', 'retry_after_seconds', 5, 'match_id', v_match.id, 'kind', v_match.kind,
    'agent1_id', v_match.agent1_id, 'agent2_id', v_match.agent2_id,
    'agent1_code', (SELECT code FROM arena_agents WHERE id = v_match.agent1_id),
    'agent2_code', (SELECT code FROM arena_agents WHERE id = v_match.agent2_id));
END;
$$;
