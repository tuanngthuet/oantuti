-- Apply once to existing deployments in a transaction, after the application is
-- upgraded, automatic rating is paused and pending rating matches have drained.
-- Fresh databases already get the pair limit from adaptive_rating_migration.sql.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM rating_scheduler_state WHERE id=true AND enabled) THEN
    RAISE EXCEPTION 'Pause automatic rating before migrating scores';
  END IF;
  IF EXISTS (SELECT 1 FROM rated_matches WHERE kind='rating' AND status IN ('scheduled','running')) THEN
    RAISE EXCEPTION 'Drain pending rating matches before migrating scores';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS rating_policy_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  agents_before jsonb NOT NULL,
  matches_before jsonb NOT NULL
);
INSERT INTO rating_policy_migrations(version,agents_before,matches_before)
SELECT 'draw-neutral-v1',
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'rating',rating) ORDER BY id) FROM arena_agents),'[]'::jsonb),
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'rating_delta_agent1',rating_delta_agent1,
    'rating_delta_agent2',rating_delta_agent2) ORDER BY id) FROM rated_matches WHERE kind='rating'),'[]'::jsonb)
ON CONFLICT(version) DO NOTHING;

-- Reproject existing strength estimates, without resetting mu/sigma, match
-- outcomes, W/L/D, code or replay. The original score columns are backed up above.
UPDATE arena_agents SET rating=floor(1000+40*(trueskill_mu-25)+0.5)::int;
UPDATE rated_matches SET
  rating_delta_agent1=floor(1000+40*(agent1_mu_after-25)+0.5)::int-floor(1000+40*(agent1_mu_before-25)+0.5)::int,
  rating_delta_agent2=floor(1000+40*(agent2_mu_after-25)+0.5)::int-floor(1000+40*(agent2_mu_before-25)+0.5)::int
WHERE kind='rating' AND status='finished' AND NOT is_infra_error
  AND agent1_mu_before IS NOT NULL AND agent1_mu_after IS NOT NULL
  AND agent2_mu_before IS NOT NULL AND agent2_mu_after IS NOT NULL;

-- Preserve existing participant/team/privacy fencing while adding the pair quota.
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_functiondef('reserve_rating_dispatch(uuid,integer)'::regprocedure) INTO definition;
  IF position('-- draw_pair_daily_limit' IN definition)=0 THEN
    IF position(' AS pair_games,' IN definition)=0 OR position('AND (h.last_met IS NULL' IN definition)=0 THEN
      RAISE EXCEPTION 'Unsupported scheduler definition; migration rolled back';
    END IF;
    definition:=replace(definition,' AS pair_games,',E' AS pair_games,\n          COUNT(*) FILTER (WHERE m.status = ''finished'' AND NOT m.is_infra_error AND m.outcome = ''draw'' AND m.finished_at > v_now - INTERVAL ''24 hours'') AS pair_draws,');
    definition:=replace(definition,'AND (h.last_met IS NULL',E'AND h.pair_draws < 2 -- draw_pair_daily_limit\n        AND (h.last_met IS NULL');
    EXECUTE definition;
  END IF;
END $$;
