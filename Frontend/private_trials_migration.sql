-- Run after teams_migration.sql. Additive; old rating participants stay public.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='arena_agents' AND column_name='is_public') THEN
    ALTER TABLE arena_agents ADD COLUMN is_public boolean NOT NULL DEFAULT true;
  END IF;
 END $$;
ALTER TABLE arena_agents ALTER COLUMN is_public SET DEFAULT false;
ALTER TABLE arena_agents ADD COLUMN IF NOT EXISTS code_fingerprint text;
ALTER TABLE arena_agents ADD COLUMN IF NOT EXISTS normalized_code text;
CREATE INDEX IF NOT EXISTS agents_code_identity_idx ON arena_agents(team_id,user_id,code_fingerprint);
ALTER TABLE friendly_matches ADD COLUMN IF NOT EXISTS trial_owner_team_id bigint REFERENCES teams(id);
ALTER TABLE friendly_matches ADD COLUMN IF NOT EXISTS trial_agent_id bigint REFERENCES arena_agents(id);
ALTER TABLE friendly_matches ADD COLUMN IF NOT EXISTS quota_day date;
ALTER TABLE friendly_matches ADD COLUMN IF NOT EXISTS request_id uuid;
UPDATE friendly_matches SET trial_owner_team_id=challenger_team_id,trial_agent_id=agent1_id WHERE trial_agent_id IS NULL;
UPDATE friendly_matches SET is_public=false WHERE is_public;
ALTER TABLE friendly_matches ALTER COLUMN is_public SET DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS trial_request_unique_idx ON friendly_matches(created_by,request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trial_quota_idx ON friendly_matches(created_by,quota_day);
UPDATE friendly_challenges SET status='cancelled',responded_at=now() WHERE status='pending';

CREATE OR REPLACE FUNCTION guard_agent_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_public AND NOT NEW.is_public THEN RAISE EXCEPTION 'PUBLICATION_IRREVERSIBLE'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agent_publication_guard ON arena_agents;
CREATE TRIGGER agent_publication_guard BEFORE UPDATE OF is_public ON arena_agents FOR EACH ROW EXECUTE FUNCTION guard_agent_publication();
CREATE OR REPLACE FUNCTION can_read_agent(p_user bigint,p_agent bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((a.is_public AND a.status='active') OR
   (a.team_id IS NULL AND a.user_id=p_user) OR (a.team_id IS NOT NULL AND a.team_id=current_team(p_user))
   OR EXISTS(SELECT 1 FROM users WHERE id=p_user AND is_admin),false) FROM arena_agents a WHERE a.id=p_agent
$$;
CREATE OR REPLACE FUNCTION can_read_trial(p_user bigint,p_match bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE(CASE WHEN f.trial_owner_team_id IS NULL THEN f.created_by=p_user
   ELSE f.trial_owner_team_id=current_team(p_user) END OR EXISTS(SELECT 1 FROM users WHERE id=p_user AND is_admin),false)
 FROM friendly_matches f WHERE f.id=p_match
$$;
CREATE OR REPLACE FUNCTION trial_quota(p_user bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('day',(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,'limit',10,'used',count(*),
   'remaining',GREATEST(0,10-count(*)),'resets_at',(((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))
 FROM friendly_matches WHERE created_by=p_user AND quota_day=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
  AND status<>'cancelled' AND NOT(status='error' AND is_infra_error)
$$;
CREATE OR REPLACE FUNCTION trial_scope_allowed(p_match bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE(a.status='active' AND a.is_active AND agent_scope_active(a.id)
  AND b.status='active' AND b.is_active AND b.is_public AND agent_scope_active(b.id)
  AND agent_participant_key(a.id)<>agent_participant_key(b.id)
  AND CASE WHEN f.trial_owner_team_id IS NULL THEN a.team_id IS NULL AND a.user_id=f.created_by
    ELSE a.team_id=f.trial_owner_team_id AND EXISTS(SELECT 1 FROM teams WHERE id=f.trial_owner_team_id AND status='active') END,false)
 FROM friendly_matches f JOIN arena_agents a ON a.id=f.trial_agent_id
 JOIN arena_agents b ON b.id=CASE WHEN f.agent1_id=a.id THEN f.agent2_id ELSE f.agent1_id END WHERE f.id=p_match
$$;
CREATE OR REPLACE FUNCTION match_scope_allowed(p_kind text,p_one bigint,p_two bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE(agent_scope_active(p_one) AND agent_scope_active(p_two) AND CASE WHEN p_kind='validation'
  THEN EXISTS(SELECT 1 FROM arena_agents WHERE id=p_one AND status='validating')
  ELSE agent_participant_key(p_one)<>agent_participant_key(p_two)
    AND (SELECT count(*) FROM arena_agents WHERE id IN(p_one,p_two) AND status='active' AND is_active AND is_public)=2 END,false)
$$;

CREATE OR REPLACE FUNCTION submit_private_agent(p_actor bigint,p_name text,p_description text,p_code text,p_expected text,p_public boolean,p_normalized text,p_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_team bigint;v_scope text;v_version integer;existing bigint;a arena_agents%ROWTYPE;
BEGIN
 PERFORM 1 FROM rating_scheduler_state WHERE id=true FOR UPDATE;
 PERFORM 1 FROM users WHERE id=p_actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
 v_team:=current_team(p_actor);v_scope:=CASE WHEN v_team IS NULL THEN 'user:'||p_actor ELSE 'team:'||v_team END;
 IF p_expected IS NOT NULL AND p_expected<>v_scope THEN RAISE EXCEPTION 'SCOPE_CHANGED'; END IF;
 SELECT id INTO existing FROM arena_agents WHERE ((v_team IS NULL AND team_id IS NULL AND user_id=p_actor) OR team_id=v_team)
  AND code_fingerprint=p_hash AND normalized_code=p_normalized ORDER BY (status='active') DESC,id LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('duplicate',true,'agent_id',existing); END IF;
 SELECT COALESCE(max(version),0)+1 INTO v_version FROM arena_agents WHERE (v_team IS NULL AND team_id IS NULL AND user_id=p_actor) OR team_id=v_team;
 INSERT INTO arena_agents(user_id,team_id,agent_name,description,code,version,status,is_active,is_public,normalized_code,code_fingerprint)
 VALUES(p_actor,v_team,p_name,p_description,p_code,v_version,'validating',false,p_public,p_normalized,p_hash) RETURNING * INTO a;
 INSERT INTO rated_matches(kind,agent1_id,agent2_id) VALUES('validation',a.id,a.id);
 RETURN jsonb_build_object('id',a.id,'agent_name',a.agent_name,'version',a.version,'submitted_at',a.submitted_at,'is_public',a.is_public);
END $$;
CREATE OR REPLACE FUNCTION publish_agent(p_actor bigint,p_agent bigint) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE a arena_agents%ROWTYPE;
BEGIN
 PERFORM 1 FROM rating_scheduler_state WHERE id=true FOR UPDATE;
 SELECT * INTO a FROM arena_agents WHERE id=p_agent FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_NOT_FOUND'; END IF;
 IF NOT COALESCE(can_use_agent(p_actor,p_agent),false) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF a.status<>'active' OR NOT a.is_active THEN RAISE EXCEPTION 'AGENT_INACTIVE'; END IF;
 UPDATE arena_agents SET is_public=true WHERE id=p_agent;
 RETURN jsonb_build_object('ok',true,'agent_id',p_agent,'is_public',true);
END $$;
CREATE OR REPLACE FUNCTION create_private_trial(p_actor bigint,p_own bigint,p_opponent bigint,p_request uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE result bigint;one bigint;two bigint;v_team bigint;quota jsonb;
BEGIN
 PERFORM 1 FROM rating_scheduler_state WHERE id=true FOR UPDATE;
 PERFORM 1 FROM users WHERE id=p_actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
 IF p_request IS NULL THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 SELECT id INTO result FROM friendly_matches WHERE created_by=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF NOT can_read_trial(p_actor,result) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN jsonb_build_object('id',result,'reused',true,'quota',trial_quota(p_actor));
 END IF;
 IF NOT COALESCE(can_use_agent(p_actor,p_own),false) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF agent_participant_key(p_own)=agent_participant_key(p_opponent) THEN RAISE EXCEPTION 'SAME_PARTICIPANT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM arena_agents WHERE id=p_own AND status='active' AND is_active)
   OR NOT EXISTS(SELECT 1 FROM arena_agents WHERE id=p_opponent AND is_public AND status='active' AND is_active AND agent_scope_active(id)) THEN RAISE EXCEPTION 'AGENT_INACTIVE'; END IF;
 quota:=trial_quota(p_actor);
 IF (quota->>'remaining')::int<=0 THEN RAISE EXCEPTION 'TRIAL_QUOTA_EXCEEDED'; END IF;
 IF random()<0.5 THEN one:=p_own;two:=p_opponent;ELSE one:=p_opponent;two:=p_own;END IF;
 v_team:=current_team(p_actor);
 INSERT INTO friendly_matches(created_by,agent1_id,agent2_id,status,pending_backend,is_public,trial_owner_team_id,trial_agent_id,quota_day,request_id)
 VALUES(p_actor,one,two,'scheduled',true,false,v_team,p_own,(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,p_request) RETURNING id INTO result;
 RETURN jsonb_build_object('id',result,'reused',false,'quota',trial_quota(p_actor));
END $$;

-- Retire old SQL entrypoints too; hidden UI must not bypass quotas/privacy.
CREATE OR REPLACE FUNCTION send_team_challenge(p_actor bigint,p_one bigint,p_two bigint,p_message text) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FEATURE_RETIRED'; END $$;
CREATE OR REPLACE FUNCTION respond_team_challenge(p_actor bigint,p_id bigint,p_action text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FEATURE_RETIRED'; END $$;
CREATE OR REPLACE FUNCTION create_scope_friendly(p_actor bigint,p_one bigint,p_two bigint) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FEATURE_RETIRED'; END $$;

CREATE OR REPLACE FUNCTION reconcile_team_participation() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE rated_matches SET status='cancelled',dispatch_token=NULL,dispatch_lease_until=NULL WHERE status='scheduled' AND execution_token IS NULL AND NOT match_scope_allowed(kind,agent1_id,agent2_id);
 UPDATE friendly_matches SET status='cancelled',pending_backend=false WHERE status='scheduled' AND execution_token IS NULL AND NOT trial_scope_allowed(id);
 UPDATE friendly_challenges SET status='cancelled',responded_at=now() WHERE status='pending';
 INSERT INTO rated_matches(kind,agent1_id,agent2_id) SELECT 'validation',a.id,a.id FROM arena_agents a WHERE a.status='validating' AND agent_scope_active(a.id)
  AND NOT EXISTS(SELECT 1 FROM rated_matches m WHERE m.kind='validation' AND m.agent1_id=a.id AND m.status IN('scheduled','running'));
END $$;

CREATE OR REPLACE VIEW rating_agent_schedule AS
WITH stats AS (
  SELECT a.id,a.user_id,a.agent_name,a.submitted_at,a.rating,a.trueskill_mu,a.trueskill_sigma,p.*,s.*
  FROM arena_agents a CROSS JOIN (SELECT minimum_games,stable_sigma,daily_budget,refresh_hours,pair_cooldown_seconds,exploration_every,aging_minutes,infra_error_limit,infra_backoff_minutes FROM rating_scheduler_policy WHERE id=true) p
  CROSS JOIN LATERAL (
    SELECT COUNT(*) FILTER(WHERE status='finished' AND NOT is_infra_error)::int AS valid_games,
      COUNT(*) FILTER(WHERE status='finished' AND NOT is_infra_error AND finished_at>now()-interval '24 hours')::int AS games_24h,
      COUNT(*) FILTER(WHERE status IN ('scheduled','running'))::int AS reserved_games,
      COALESCE(bool_or(status IN ('scheduled','running')),false) AS busy,
      MAX(finished_at) FILTER(WHERE status='finished' AND NOT is_infra_error) AS last_finished_at,
      (array_agg(finished_at+interval '24 hours' ORDER BY finished_at) FILTER(WHERE status='finished' AND NOT is_infra_error AND finished_at>now()-interval '24 hours'))[
        GREATEST(1,COUNT(*) FILTER(WHERE status='finished' AND NOT is_infra_error AND finished_at>now()-interval '24 hours')+COUNT(*) FILTER(WHERE status IN ('scheduled','running'))-p.daily_budget+1)::int] AS budget_reset_at,
      COUNT(*) FILTER(WHERE is_infra_error AND status='error' AND finished_at>now()-interval '1 hour')::int AS infra_errors,
      MAX(finished_at) FILTER(WHERE is_infra_error AND status='error') AS last_infra_at,
      COUNT(*) FILTER(WHERE scheduler_focal_id=a.id AND status<>'cancelled')::int AS focal_games
    FROM rated_matches WHERE kind='rating' AND (agent1_id=a.id OR agent2_id=a.id)
  ) s WHERE a.status='active' AND a.is_active AND a.is_public AND agent_scope_active(a.id)
), classified AS (
  SELECT *,GREATEST(0,daily_budget-games_24h-reserved_games)::int AS budget_remaining,
    CASE WHEN infra_errors>=infra_error_limit THEN last_infra_at+make_interval(mins=>infra_backoff_minutes) END AS backoff_until,
    last_finished_at+make_interval(hours=>refresh_hours) AS refresh_at FROM stats
)
SELECT *,CASE WHEN busy THEN 'busy' WHEN budget_remaining=0 THEN 'budget_exhausted' WHEN backoff_until>now() THEN 'infra_backoff'
  WHEN valid_games<minimum_games THEN 'calibrating' WHEN trueskill_sigma>stable_sigma THEN 'uncertain' WHEN refresh_at<=now() THEN 'refresh_due' ELSE 'stable' END AS schedule_state,
  CASE WHEN busy THEN NULL WHEN budget_remaining=0 THEN budget_reset_at WHEN backoff_until>now() THEN backoff_until
    WHEN valid_games<minimum_games OR trueskill_sigma>stable_sigma THEN now() ELSE refresh_at END AS next_evaluation_at FROM classified;
