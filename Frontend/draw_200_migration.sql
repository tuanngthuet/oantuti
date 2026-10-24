-- Only scheduler behavior changes; scores are reconstructed by the maintenance
-- script after backing up the actual pre-change state.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('reserve_rating_dispatch(uuid,integer)'::regprocedure) INTO definition;
 IF position('-- draw_pair_daily_limit' IN definition)=0 THEN
   IF position(' AS pair_games,' IN definition)=0 OR position('AND (h.last_met IS NULL' IN definition)=0 THEN RAISE EXCEPTION 'Unsupported scheduler'; END IF;
   definition:=replace(definition,' AS pair_games,',E' AS pair_games,\n          COUNT(*) FILTER (WHERE m.status = ''finished'' AND NOT m.is_infra_error AND m.outcome = ''draw'' AND m.finished_at > v_now - INTERVAL ''24 hours'') AS pair_draws,');
   definition:=replace(definition,'AND (h.last_met IS NULL',E'AND h.pair_draws < 2 -- draw_pair_daily_limit\n        AND (h.last_met IS NULL');
 END IF;
 IF position('-- serialize_pending_rating_agents' IN definition)=0 THEN
   IF position('  ORDER BY CASE m.kind' IN definition)=0 THEN RAISE EXCEPTION 'Unsupported pending scheduler'; END IF;
   definition:=replace(definition,'  ORDER BY CASE m.kind',E'  -- serialize_pending_rating_agents\n    AND (m.kind=''validation'' OR NOT EXISTS (\n      SELECT 1 FROM rated_matches active WHERE active.id<>m.id AND active.kind=''rating''\n        AND active.status IN (''scheduled'',''running'')\n        AND (active.status=''running'' OR active.dispatched_at>=v_now-INTERVAL ''10 minutes'' OR active.dispatch_lease_until>v_now)\n        AND (active.agent1_id IN (m.agent1_id,m.agent2_id) OR active.agent2_id IN (m.agent1_id,m.agent2_id))\n    ))\n  ORDER BY CASE m.kind');
 END IF;
 EXECUTE definition;
END $$;
