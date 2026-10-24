-- Run after teams_migration.sql. Additive; never changes ratings or agent ownership.
CREATE TABLE IF NOT EXISTS team_join_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id bigint NOT NULL REFERENCES teams(id),
  requester_id bigint NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days'
);
CREATE UNIQUE INDEX IF NOT EXISTS team_join_request_pending_idx
  ON team_join_requests(team_id,requester_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS team_join_request_requester_idx ON team_join_requests(requester_id);

CREATE OR REPLACE FUNCTION close_obsolete_team_join_requests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='team_members' THEN
    UPDATE team_join_requests SET status='cancelled' WHERE requester_id=NEW.user_id AND status='pending';
  ELSIF NEW.status='archived' THEN
    UPDATE team_join_requests SET status='cancelled' WHERE team_id=NEW.id AND status='pending';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS team_join_requests_on_membership ON team_members;
CREATE TRIGGER team_join_requests_on_membership AFTER INSERT ON team_members
  FOR EACH ROW EXECUTE FUNCTION close_obsolete_team_join_requests();
DROP TRIGGER IF EXISTS team_join_requests_on_archive ON teams;
CREATE TRIGGER team_join_requests_on_archive AFTER UPDATE OF status ON teams
  FOR EACH ROW EXECUTE FUNCTION close_obsolete_team_join_requests();

CREATE OR REPLACE FUNCTION manage_team_join_request(p_actor bigint,p_action text,p_body jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE t teams%ROWTYPE; r team_join_requests%ROWTYPE; v_id bigint;
BEGIN
  -- Use the same serialization point as invitations, submissions and the scheduler.
  PERFORM 1 FROM rating_scheduler_state WHERE id=true FOR UPDATE;
  PERFORM 1 FROM users WHERE id=p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  IF p_action='request_join' THEN
    IF current_team(p_actor) IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_IN_TEAM'; END IF;
    SELECT * INTO t FROM teams WHERE id=(p_body->>'team_id')::bigint FOR UPDATE;
    IF NOT FOUND OR t.status<>'active' THEN RAISE EXCEPTION 'TEAM_NOT_FOUND'; END IF;
    IF NOT t.recruiting THEN RAISE EXCEPTION 'TEAM_NOT_RECRUITING'; END IF;
    IF (SELECT count(*) FROM team_members WHERE team_id=t.id)>=3 THEN RAISE EXCEPTION 'TEAM_FULL'; END IF;
    UPDATE team_join_requests SET status='cancelled'
      WHERE team_id=t.id AND requester_id=p_actor AND status='pending' AND expires_at<=now();
    IF EXISTS(SELECT 1 FROM team_join_requests WHERE team_id=t.id AND requester_id=p_actor AND status='pending')
      THEN RAISE EXCEPTION 'JOIN_REQUEST_EXISTS'; END IF;
    INSERT INTO team_join_requests(team_id,requester_id) VALUES(t.id,p_actor) RETURNING id INTO v_id;
  ELSIF p_action IN ('approve_join','decline_join','cancel_join') THEN
    SELECT * INTO r FROM team_join_requests WHERE id=(p_body->>'request_id')::bigint FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'JOIN_REQUEST_NOT_FOUND'; END IF;
    SELECT * INTO t FROM teams WHERE id=r.team_id FOR UPDATE;
    IF p_action='cancel_join' THEN
      IF r.requester_id<>p_actor THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
    ELSIF t.creator_id<>p_actor THEN RAISE EXCEPTION 'FORBIDDEN';
    END IF;
    IF r.status<>'pending' OR r.expires_at<=now() THEN RAISE EXCEPTION 'JOIN_REQUEST_EXPIRED'; END IF;
    IF t.status<>'active' THEN RAISE EXCEPTION 'TEAM_NOT_FOUND'; END IF;
    v_id:=r.id;
    IF p_action='approve_join' THEN
      PERFORM 1 FROM users WHERE id=r.requester_id FOR UPDATE;
      IF current_team(r.requester_id) IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_IN_TEAM'; END IF;
      -- The existing membership trigger also enforces the three-member limit.
      UPDATE team_join_requests SET status='accepted' WHERE id=r.id;
      INSERT INTO team_members(user_id,team_id) VALUES(r.requester_id,t.id);
      UPDATE team_invitations SET status='cancelled' WHERE recipient_id=r.requester_id AND status='pending';
      PERFORM reconcile_team_participation();
    ELSE
      UPDATE team_join_requests SET status=CASE WHEN p_action='cancel_join' THEN 'cancelled' ELSE 'declined' END WHERE id=r.id;
    END IF;
  ELSE RAISE EXCEPTION 'INVALID_ACTION';
  END IF;
  INSERT INTO team_audit(team_id,actor_id,action,details) VALUES(t.id,p_actor,p_action,p_body);
  RETURN jsonb_build_object('ok',true,'team_id',t.id,'request_id',v_id);
END $$;
