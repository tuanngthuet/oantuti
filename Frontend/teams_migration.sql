-- Additive only. Existing users remain individuals; never reset agents or ratings.
CREATE TABLE IF NOT EXISTS teams (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 30),
  creator_id bigint NOT NULL REFERENCES users(id),
  recruiting boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_active_creator_idx ON teams(creator_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS team_members (
  user_id bigint PRIMARY KEY REFERENCES users(id),
  team_id bigint NOT NULL REFERENCES teams(id),
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_members_team_idx ON team_members(team_id);
CREATE TABLE IF NOT EXISTS team_invitations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id bigint NOT NULL REFERENCES teams(id),
  recipient_id bigint NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days'
);
CREATE UNIQUE INDEX IF NOT EXISTS team_invitation_pending_idx ON team_invitations(team_id,recipient_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS team_invitation_recipient_idx ON team_invitations(recipient_id);
CREATE TABLE IF NOT EXISTS team_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id bigint NOT NULL REFERENCES teams(id),
  actor_id bigint NOT NULL REFERENCES users(id),
  action text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena_agents ADD COLUMN IF NOT EXISTS team_id bigint REFERENCES teams(id);
CREATE INDEX IF NOT EXISTS arena_agents_team_idx ON arena_agents(team_id);
ALTER TABLE friendly_challenges ADD COLUMN IF NOT EXISTS challenger_team_id bigint REFERENCES teams(id);
ALTER TABLE friendly_challenges ADD COLUMN IF NOT EXISTS opponent_team_id bigint REFERENCES teams(id);
ALTER TABLE friendly_matches ADD COLUMN IF NOT EXISTS challenger_team_id bigint REFERENCES teams(id);
ALTER TABLE friendly_matches ADD COLUMN IF NOT EXISTS opponent_team_id bigint REFERENCES teams(id);

CREATE OR REPLACE FUNCTION current_team(p_user bigint) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT m.team_id FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=p_user AND t.status='active'
$$;
CREATE OR REPLACE FUNCTION agent_scope_active(p_agent bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN a.team_id IS NULL THEN current_team(a.user_id) IS NULL
    ELSE EXISTS(SELECT 1 FROM teams t WHERE t.id=a.team_id AND t.status='active') END FROM arena_agents a WHERE a.id=p_agent
$$;
CREATE OR REPLACE FUNCTION agent_participant_key(p_agent bigint) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN team_id IS NULL THEN 'user:'||user_id ELSE 'team:'||team_id END FROM arena_agents WHERE id=p_agent
$$;
CREATE OR REPLACE FUNCTION can_use_agent(p_user bigint,p_agent bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(agent_scope_active(a.id) AND CASE WHEN a.team_id IS NULL THEN a.user_id=p_user
    ELSE a.team_id=current_team(p_user) END,false) FROM arena_agents a WHERE a.id=p_agent
$$;
CREATE OR REPLACE FUNCTION match_scope_allowed(p_kind text,p_one bigint,p_two bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(agent_scope_active(p_one) AND agent_scope_active(p_two) AND CASE WHEN p_kind='validation'
    THEN EXISTS(SELECT 1 FROM arena_agents WHERE id=p_one AND status='validating')
    ELSE agent_participant_key(p_one)<>agent_participant_key(p_two)
      AND (SELECT count(*) FROM arena_agents WHERE id IN(p_one,p_two) AND status='active' AND is_active)=2 END,false)
$$;
CREATE OR REPLACE FUNCTION guard_team_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t teams%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'MEMBERSHIP_UPDATE_FORBIDDEN'; END IF;
  SELECT * INTO t FROM teams WHERE id=CASE WHEN TG_OP='INSERT' THEN NEW.team_id ELSE OLD.team_id END FOR UPDATE;
  IF TG_OP='DELETE' THEN
    IF t.status='active' AND OLD.user_id=t.creator_id THEN RAISE EXCEPTION 'CREATOR_CANNOT_LEAVE'; END IF;
    RETURN OLD;
  END IF;
  IF t.status<>'active' THEN RAISE EXCEPTION 'TEAM_ARCHIVED'; END IF;
  IF (SELECT count(*) FROM team_members WHERE team_id=t.id)>=3 THEN RAISE EXCEPTION 'TEAM_FULL'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION send_team_challenge(p_actor bigint,p_one bigint,p_two bigint,p_message text) RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$
DECLARE a arena_agents%ROWTYPE; b arena_agents%ROWTYPE; opponent bigint; result bigint;
BEGIN
  PERFORM 1 FROM rating_scheduler_state WHERE id=true FOR UPDATE;
  SELECT * INTO a FROM arena_agents WHERE id=p_one;
  SELECT * INTO b FROM arena_agents WHERE id=p_two;
  IF a.id IS NULL OR b.id IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_FOUND'; END IF;
  IF NOT COALESCE(can_use_agent(p_actor,p_one),false) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF agent_participant_key(p_one)=agent_participant_key(p_two) THEN RAISE EXCEPTION 'SAME_PARTICIPANT'; END IF;
  IF a.status<>'active' OR b.status<>'active' OR NOT a.is_active OR NOT b.is_active OR NOT agent_scope_active(p_two) THEN RAISE EXCEPTION 'AGENT_INACTIVE'; END IF;
  opponent:=COALESCE((SELECT creator_id FROM teams WHERE id=b.team_id),b.user_id);
  IF EXISTS(SELECT 1 FROM friendly_challenges WHERE challenger_agent_id=p_one AND opponent_agent_id=p_two AND status='pending' AND expires_at>now()) THEN RAISE EXCEPTION 'INVITATION_EXISTS'; END IF;
  INSERT INTO friendly_challenges(challenger_id,opponent_id,challenger_agent_id,opponent_agent_id,message,challenger_team_id,opponent_team_id)
    VALUES(p_actor,opponent,p_one,p_two,p_message,a.team_id,b.team_id) RETURNING id INTO result;
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION respond_team_challenge(p_actor bigint,p_id bigint,p_action text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE c friendly_challenges%ROWTYPE; result bigint;
BEGIN
  PERFORM 1 FROM rating_scheduler_state WHERE id=true FOR UPDATE;
  SELECT * INTO c FROM friendly_challenges WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;
  IF NOT COALESCE(can_use_agent(p_actor,c.opponent_agent_id),false) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF c.status<>'pending' OR c.expires_at<=now() THEN RAISE EXCEPTION 'INVITATION_EXPIRED'; END IF;
  IF p_action='decline' THEN
    UPDATE friendly_challenges SET status='declined',responded_at=now() WHERE id=p_id;
    RETURN jsonb_build_object('ok',true,'action','declined');
  END IF;
  IF p_action<>'accept' THEN RAISE EXCEPTION 'INVALID_ACTION'; END IF;
  IF EXISTS(SELECT 1 FROM arena_agents WHERE id IN(c.challenger_agent_id,c.opponent_agent_id) AND (status<>'active' OR NOT is_active OR NOT agent_scope_active(id)))
    OR agent_participant_key(c.challenger_agent_id)=agent_participant_key(c.opponent_agent_id)
    OR c.challenger_team_id IS DISTINCT FROM (SELECT team_id FROM arena_agents WHERE id=c.challenger_agent_id)
    OR c.opponent_team_id IS DISTINCT FROM (SELECT team_id FROM arena_agents WHERE id=c.opponent_agent_id)
    THEN RAISE EXCEPTION 'AGENT_INACTIVE'; END IF;
  INSERT INTO friendly_matches(created_by,agent1_id,agent2_id,status,pending_backend,challenger_id,opponent_id,is_public,challenger_team_id,opponent_team_id)
    VALUES(c.challenger_id,c.challenger_agent_id,c.opponent_agent_id,'scheduled',true,c.challenger_id,c.opponent_id,true,c.challenger_team_id,c.opponent_team_id) RETURNING id INTO result;
  UPDATE friendly_challenges SET status='accepted',responded_at=now(),friendly_match_id=result WHERE id=p_id;
  RETURN jsonb_build_object('ok',true,'action','accepted','friendly_match_id',result);
END $$;

CREATE OR REPLACE FUNCTION create_scope_friendly(p_actor bigint,p_one bigint,p_two bigint) RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$
DECLARE result bigint; a arena_agents%ROWTYPE; b arena_agents%ROWTYPE;
BEGIN
  PERFORM 1 FROM rating_scheduler_state WHERE id=true FOR UPDATE;
  SELECT * INTO a FROM arena_agents WHERE id=p_one;
  SELECT * INTO b FROM arena_agents WHERE id=p_two;
  IF a.id IS NULL OR b.id IS NULL THEN RAISE EXCEPTION 'AGENT_NOT_FOUND'; END IF;
  IF NOT COALESCE(can_use_agent(p_actor,p_one),false) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF agent_participant_key(p_one)=agent_participant_key(p_two) THEN RAISE EXCEPTION 'SAME_PARTICIPANT'; END IF;
  IF a.status<>'active' OR b.status<>'active' OR NOT a.is_active OR NOT b.is_active OR NOT agent_scope_active(p_two) THEN RAISE EXCEPTION 'AGENT_INACTIVE'; END IF;
  INSERT INTO friendly_matches(created_by,agent1_id,agent2_id,status,pending_backend,challenger_id,opponent_id,challenger_team_id,opponent_team_id)
    VALUES(p_actor,p_one,p_two,'scheduled',true,p_actor,COALESCE((SELECT creator_id FROM teams WHERE id=b.team_id),b.user_id),a.team_id,b.team_id) RETURNING id INTO result;
  RETURN result;
END $$;
DROP TRIGGER IF EXISTS team_members_guard ON team_members;
CREATE TRIGGER team_members_guard BEFORE INSERT OR UPDATE OR DELETE ON team_members FOR EACH ROW EXECUTE FUNCTION guard_team_membership();

-- Scoped cancellation is terminal; existing worker callbacks ACK cancelled jobs without running them.
CREATE OR REPLACE FUNCTION reconcile_team_participation() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE rated_matches SET status='cancelled',dispatch_token=NULL,dispatch_lease_until=NULL
    WHERE status='scheduled' AND execution_token IS NULL AND
      (NOT agent_scope_active(agent1_id) OR NOT agent_scope_active(agent2_id)
       OR (kind='rating' AND agent_participant_key(agent1_id)=agent_participant_key(agent2_id)));
  UPDATE friendly_matches SET status='cancelled',pending_backend=false
    WHERE status='scheduled' AND execution_token IS NULL AND
      (NOT agent_scope_active(agent1_id) OR NOT agent_scope_active(agent2_id)
       OR agent_participant_key(agent1_id)=agent_participant_key(agent2_id));
  UPDATE friendly_challenges fc SET status='cancelled',responded_at=now() WHERE status='pending' AND
    (NOT agent_scope_active(challenger_agent_id) OR NOT agent_scope_active(opponent_agent_id)
      OR challenger_team_id IS DISTINCT FROM (SELECT team_id FROM arena_agents WHERE id=fc.challenger_agent_id)
      OR opponent_team_id IS DISTINCT FROM (SELECT team_id FROM arena_agents WHERE id=fc.opponent_agent_id));
  INSERT INTO rated_matches(kind,agent1_id,agent2_id)
    SELECT 'validation',a.id,a.id FROM arena_agents a WHERE a.status='validating' AND agent_scope_active(a.id)
      AND NOT EXISTS(SELECT 1 FROM rated_matches m WHERE m.kind='validation' AND m.agent1_id=a.id AND m.status IN ('scheduled','running'));
END $$;

CREATE OR REPLACE FUNCTION manage_team(p_actor bigint,p_action text,p_body jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_team bigint; v_id bigint; v_user bigint; v_name text; t teams%ROWTYPE; invitation team_invitations%ROWTYPE;
BEGIN
  -- Same serialization point as the scheduler and submissions; no lock is held across HTTP.
  PERFORM 1 FROM rating_scheduler_state WHERE id=true FOR UPDATE;
  PERFORM 1 FROM users WHERE id=p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  v_team:=current_team(p_actor);
  IF p_action='create' THEN
    IF v_team IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_IN_TEAM'; END IF;
    v_name:=btrim(p_body->>'name');
    IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'INVALID_TEAM_NAME'; END IF;
    INSERT INTO teams(name,creator_id) VALUES(v_name,p_actor) RETURNING id INTO v_team;
    INSERT INTO team_members(user_id,team_id) VALUES(p_actor,v_team);
    UPDATE arena_agents SET team_id=v_team WHERE user_id=p_actor AND team_id IS NULL;
    UPDATE team_invitations SET status='cancelled' WHERE recipient_id=p_actor AND status='pending';
  ELSIF p_action IN ('accept','decline') THEN
    SELECT * INTO invitation FROM team_invitations WHERE id=(p_body->>'invitation_id')::bigint FOR UPDATE;
    IF NOT FOUND OR invitation.recipient_id<>p_actor THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;
    IF invitation.status<>'pending' OR invitation.expires_at<=now() THEN RAISE EXCEPTION 'INVITATION_EXPIRED'; END IF;
    v_team:=invitation.team_id;
    IF p_action='accept' THEN
      IF current_team(p_actor) IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_IN_TEAM'; END IF;
      INSERT INTO team_members(user_id,team_id) VALUES(p_actor,v_team);
      UPDATE team_invitations SET status='cancelled' WHERE recipient_id=p_actor AND status='pending' AND id<>invitation.id;
    END IF;
    UPDATE team_invitations SET status=CASE WHEN p_action='accept' THEN 'accepted' ELSE 'declined' END WHERE id=invitation.id;
  ELSE
    IF p_action='archive' THEN
      IF NOT (SELECT is_admin FROM users WHERE id=p_actor) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
      v_team:=(p_body->>'team_id')::bigint;
    END IF;
    SELECT * INTO t FROM teams WHERE id=v_team FOR UPDATE;
    IF NOT FOUND OR t.status<>'active' THEN RAISE EXCEPTION 'TEAM_NOT_FOUND'; END IF;
    IF p_action='leave' THEN
      IF t.creator_id=p_actor THEN RAISE EXCEPTION 'CREATOR_CANNOT_LEAVE'; END IF;
      DELETE FROM team_members WHERE user_id=p_actor;
    ELSE
      IF p_action<>'archive' AND t.creator_id<>p_actor THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
      CASE p_action
        WHEN 'update' THEN
          v_name:=btrim(p_body->>'name');
          IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'INVALID_TEAM_NAME'; END IF;
          UPDATE teams SET name=v_name,recruiting=COALESCE((p_body->>'recruiting')::boolean,false) WHERE id=v_team;
        WHEN 'invite' THEN
          SELECT id INTO v_user FROM users WHERE username=p_body->>'username' FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
          IF current_team(v_user) IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_IN_TEAM'; END IF;
          IF (SELECT count(*) FROM team_members WHERE team_id=v_team)>=3 THEN RAISE EXCEPTION 'TEAM_FULL'; END IF;
          UPDATE team_invitations SET status='cancelled' WHERE team_id=v_team AND recipient_id=v_user AND status='pending' AND expires_at<=now();
          IF EXISTS(SELECT 1 FROM team_invitations WHERE team_id=v_team AND recipient_id=v_user AND status='pending') THEN RAISE EXCEPTION 'INVITATION_EXISTS'; END IF;
          INSERT INTO team_invitations(team_id,recipient_id) VALUES(v_team,v_user) RETURNING id INTO v_id;
        WHEN 'cancel' THEN
          UPDATE team_invitations SET status='cancelled' WHERE id=(p_body->>'invitation_id')::bigint AND team_id=v_team AND status='pending';
          IF NOT FOUND THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND'; END IF;
        WHEN 'remove' THEN
          v_user:=(p_body->>'user_id')::bigint;
          IF v_user=t.creator_id THEN RAISE EXCEPTION 'CREATOR_CANNOT_LEAVE'; END IF;
          DELETE FROM team_members WHERE team_id=v_team AND user_id=v_user;
          IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
        WHEN 'archive' THEN
          UPDATE teams SET status='archived',recruiting=false WHERE id=v_team;
          DELETE FROM team_members WHERE team_id=v_team;
          UPDATE team_invitations SET status='cancelled' WHERE team_id=v_team AND status='pending';
        ELSE RAISE EXCEPTION 'INVALID_ACTION';
      END CASE;
    END IF;
  END IF;
  PERFORM reconcile_team_participation();
  INSERT INTO team_audit(team_id,actor_id,action,details) VALUES(v_team,p_actor,p_action,p_body);
  RETURN jsonb_build_object('ok',true,'team_id',v_team,'invitation_id',v_id);
END $$;

CREATE OR REPLACE FUNCTION submit_arena_agent(p_actor bigint,p_name text,p_description text,p_code text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_team bigint; v_version integer; a arena_agents%ROWTYPE;
BEGIN
  PERFORM 1 FROM rating_scheduler_state WHERE id=true FOR UPDATE;
  PERFORM 1 FROM users WHERE id=p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  v_team:=current_team(p_actor);
  SELECT COALESCE(max(version),0)+1 INTO v_version FROM arena_agents
    WHERE (v_team IS NULL AND team_id IS NULL AND user_id=p_actor) OR team_id=v_team;
  INSERT INTO arena_agents(user_id,team_id,agent_name,description,code,version,status,is_active)
    VALUES(p_actor,v_team,p_name,p_description,p_code,v_version,'validating',false) RETURNING * INTO a;
  INSERT INTO rated_matches(kind,agent1_id,agent2_id) VALUES('validation',a.id,a.id);
  RETURN jsonb_build_object('id',a.id,'agent_name',a.agent_name,'version',a.version,'submitted_at',a.submitted_at,'team_id',a.team_id);
END $$;

-- Keep the pre-submit editor scope explicit: another tab may change membership.
CREATE OR REPLACE FUNCTION submit_scoped_agent(p_actor bigint,p_name text,p_description text,p_code text,p_expected text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_team bigint; v_scope text;
BEGIN
  PERFORM 1 FROM rating_scheduler_state WHERE id=true FOR UPDATE;
  v_team:=current_team(p_actor);
  v_scope:=CASE WHEN v_team IS NULL THEN 'user:'||p_actor ELSE 'team:'||v_team END;
  IF p_expected IS NOT NULL AND p_expected<>v_scope THEN RAISE EXCEPTION 'SCOPE_CHANGED'; END IF;
  RETURN submit_arena_agent(p_actor,p_name,p_description,p_code);
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
  ) s WHERE a.status='active' AND a.is_active AND agent_scope_active(a.id)
), classified AS (
  SELECT *,GREATEST(0,daily_budget-games_24h-reserved_games)::int AS budget_remaining,
    CASE WHEN infra_errors>=infra_error_limit THEN last_infra_at+make_interval(mins=>infra_backoff_minutes) END AS backoff_until,
    last_finished_at+make_interval(hours=>refresh_hours) AS refresh_at FROM stats
)
SELECT *,CASE WHEN busy THEN 'busy' WHEN budget_remaining=0 THEN 'budget_exhausted' WHEN backoff_until>now() THEN 'infra_backoff'
  WHEN valid_games<minimum_games THEN 'calibrating' WHEN trueskill_sigma>stable_sigma THEN 'uncertain' WHEN refresh_at<=now() THEN 'refresh_due' ELSE 'stable' END AS schedule_state,
  CASE WHEN busy THEN NULL WHEN budget_remaining=0 THEN budget_reset_at WHEN backoff_until>now() THEN backoff_until
    WHEN valid_games<minimum_games OR trueskill_sigma>stable_sigma THEN now() ELSE refresh_at END AS next_evaluation_at FROM classified;

-- Preserve the adaptive dispatch algorithm, replacing only its participant boundary.
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_functiondef('reserve_rating_dispatch(uuid,integer)'::regprocedure) INTO definition;
  IF position('o.user_id <> v_focal.user_id' IN definition)>0 THEN
    definition:=replace(definition,'o.user_id <> v_focal.user_id','agent_participant_key(o.id) <> agent_participant_key(v_focal.id)');
  ELSIF position('agent_participant_key(o.id)' IN definition)=0 THEN RAISE EXCEPTION 'Unsupported scheduler definition'; END IF;
  IF position('-- team_scope_guard' IN definition)=0 THEN
    IF position('  v_now := clock_timestamp();' IN definition)=0 THEN RAISE EXCEPTION 'Unsupported scheduler guard position'; END IF;
    definition:=replace(definition,'  v_now := clock_timestamp();',E'  v_now := clock_timestamp();\n  -- team_scope_guard\n  UPDATE rated_matches SET status=''cancelled'',dispatch_token=NULL,dispatch_lease_until=NULL WHERE status=''scheduled'' AND execution_token IS NULL AND NOT match_scope_allowed(kind,agent1_id,agent2_id);');
  END IF;
  EXECUTE definition;
END $$;
