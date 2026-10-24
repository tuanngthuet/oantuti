-- Replace __FINALS_SCHEMA__ with a validated identifier before execution.
CREATE SCHEMA IF NOT EXISTS __FINALS_SCHEMA__;
SET LOCAL search_path TO __FINALS_SCHEMA__,pg_catalog;
CREATE TABLE IF NOT EXISTS control(id boolean PRIMARY KEY DEFAULT true CHECK(id));
INSERT INTO control VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS editions(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 request_id uuid UNIQUE NOT NULL,created_by bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'locked' CHECK(status IN('locked','ready','running','finished','cancelled')),
 revision integer NOT NULL DEFAULT 1,rules jsonb NOT NULL DEFAULT '{"engine_version":"ott-finals-v1","max_moves":150,"repetition":3}',
 rules_locked_at timestamptz,finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS finals_one_open ON editions((true)) WHERE status IN('locked','ready','running');
CREATE TABLE IF NOT EXISTS entrants(
 edition_id bigint REFERENCES editions(id),seed integer CHECK(seed BETWEEN 1 AND 16),
 participant_key text NOT NULL,source_agent_id bigint NOT NULL,name text NOT NULL,members jsonb NOT NULL,
 agent_name text NOT NULL,version integer NOT NULL,rating double precision NOT NULL,code text NOT NULL,code_hash text NOT NULL,
 PRIMARY KEY(edition_id,seed),UNIQUE(edition_id,participant_key)
);
CREATE TABLE IF NOT EXISTS pairs(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,edition_id bigint NOT NULL REFERENCES editions(id),
 round integer NOT NULL CHECK(round BETWEEN 1 AND 5),slot integer NOT NULL,
 seed1 integer,seed2 integer,winner_seed integer,loser_seed integer,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','confirmed')),
 points1 numeric,points2 numeric,UNIQUE(edition_id,round,slot),
 FOREIGN KEY(edition_id,seed1) REFERENCES entrants(edition_id,seed),FOREIGN KEY(edition_id,seed2) REFERENCES entrants(edition_id,seed)
);
CREATE TABLE IF NOT EXISTS games(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,pair_id bigint NOT NULL REFERENCES pairs(id),leg integer NOT NULL CHECK(leg IN(1,2)),
 seed1 integer NOT NULL,seed2 integer NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','ready','needs_attention','cancelled')),
 published boolean NOT NULL DEFAULT false,outcome text CHECK(outcome IN('agent1','agent2','draw')),
 active_attempt bigint,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(pair_id,leg)
);
CREATE TABLE IF NOT EXISTS attempts(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,game_id bigint NOT NULL REFERENCES games(id),
 source text NOT NULL CHECK(source IN('runner','import','admin')),
 status text NOT NULL CHECK(status IN('running','ready','needs_attention','cancelled')),
 worker_id text,token uuid,lease_until timestamptz,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 state jsonb,move_count integer NOT NULL DEFAULT 0,outcome text CHECK(outcome IN('agent1','agent2','draw')),
 reason text NOT NULL DEFAULT '',error text,created_by bigint
);
CREATE TABLE IF NOT EXISTS moves(
 attempt_id bigint REFERENCES attempts(id),seq integer CHECK(seq>0),move jsonb NOT NULL,state jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(attempt_id,seq)
);
CREATE TABLE IF NOT EXISTS workers(
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),instance_id uuid NOT NULL,last_seen timestamptz NOT NULL DEFAULT now(),concurrency integer NOT NULL CHECK(concurrency BETWEEN 1 AND 8)
);
CREATE TABLE IF NOT EXISTS audit(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,edition_id bigint REFERENCES editions(id),actor bigint NOT NULL,
 action text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finals_lease ON attempts(lease_until) WHERE status='running';

CREATE OR REPLACE FUNCTION immutable_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_SNAPSHOT';END $$;
DROP TRIGGER IF EXISTS finals_snapshot_guard ON entrants;
CREATE TRIGGER finals_snapshot_guard BEFORE UPDATE OR DELETE ON entrants FOR EACH ROW EXECUTE FUNCTION immutable_snapshot();
CREATE OR REPLACE FUNCTION immutable_locked_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.rules_locked_at IS NOT NULL AND (NEW.rules IS DISTINCT FROM OLD.rules OR NEW.rules_locked_at IS DISTINCT FROM OLD.rules_locked_at) THEN RAISE EXCEPTION 'RULES_IMMUTABLE';END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS finals_rules_guard ON editions;
CREATE TRIGGER finals_rules_guard BEFORE UPDATE ON editions FOR EACH ROW EXECUTE FUNCTION immutable_locked_rules();

CREATE OR REPLACE FUNCTION create_edition(actor bigint,title text,key uuid,snapshot jsonb) RETURNS bigint
LANGUAGE plpgsql SET search_path TO __FINALS_SCHEMA__,pg_catalog AS $$
DECLARE eid bigint;x jsonb;i integer;r integer;n integer;
BEGIN
 PERFORM 1 FROM control WHERE id=true FOR UPDATE;
 SELECT id INTO eid FROM editions WHERE request_id=key AND created_by=actor;
 IF FOUND THEN RETURN eid;END IF;
 IF jsonb_array_length(snapshot)<>16 THEN RAISE EXCEPTION 'NEED_SIXTEEN';END IF;
 IF EXISTS(SELECT 1 FROM editions WHERE status IN('locked','ready','running')) THEN RAISE EXCEPTION 'EDITION_ALREADY_OPEN';END IF;
 INSERT INTO editions(name,request_id,created_by) VALUES(title,key,actor) RETURNING id INTO eid;
 FOR x IN SELECT value FROM jsonb_array_elements(snapshot) LOOP
  INSERT INTO entrants VALUES(eid,(x->>'seed')::int,x->>'participant_key',(x->>'source_agent_id')::bigint,x->>'name',x->'members',
   x->>'agent_name',(x->>'version')::int,(x->>'rating')::double precision,x->>'code',x->>'code_hash');
 END LOOP;
 FOR r IN 1..5 LOOP
  n:=CASE r WHEN 1 THEN 8 WHEN 2 THEN 4 WHEN 3 THEN 2 ELSE 1 END;
  FOR i IN 1..n LOOP
   INSERT INTO pairs(edition_id,round,slot,seed1,seed2) VALUES(eid,r,i,
    CASE WHEN r=1 THEN (ARRAY[1,8,4,5,2,7,3,6])[i] END,
    CASE WHEN r=1 THEN (ARRAY[16,9,13,12,15,10,14,11])[i] END);
  END LOOP;
 END LOOP;
 INSERT INTO audit(edition_id,actor,action,payload) VALUES(eid,actor,'snapshot','{}');
 RETURN eid;
END $$;

CREATE OR REPLACE FUNCTION admin_action(actor bigint,eid bigint,expected integer,action text,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO __FINALS_SCHEMA__,pg_catalog AS $$
DECLARE e editions%ROWTYPE;p pairs%ROWTYPE;g games%ROWTYPE;a attempts%ROWTYPE;
 r integer;aid bigint;win integer;lose integer;one numeric;two numeric;result text;reason text;item jsonb;seq integer;
BEGIN
 SELECT * INTO e FROM editions WHERE id=eid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF e.revision<>expected THEN RAISE EXCEPTION 'STALE_REVISION';END IF;
 IF e.status='cancelled' OR (e.status='finished' AND action<>'publish') THEN RAISE EXCEPTION 'EDITION_CLOSED';END IF;
 IF action='lock_rules' THEN
  IF e.status<>'locked' THEN RAISE EXCEPTION 'INVALID_STATE';END IF;
  IF body->'rules' IS DISTINCT FROM '{"engine_version":"ott-finals-v1","max_moves":150,"repetition":3}'::jsonb THEN RAISE EXCEPTION 'UNSUPPORTED_RULES';END IF;
  UPDATE editions SET rules=body->'rules',rules_locked_at=now(),status='ready' WHERE id=eid;
 ELSIF action='cancel' THEN
  IF length(btrim(COALESCE(body->>'reason','')))=0 THEN RAISE EXCEPTION 'REASON_REQUIRED';END IF;
  UPDATE editions SET status='cancelled',finished_at=now() WHERE id=eid;
  UPDATE games SET status='cancelled' WHERE pair_id IN(SELECT id FROM pairs WHERE edition_id=eid) AND status IN('queued','running','needs_attention');
  UPDATE attempts SET status='cancelled',token=NULL,lease_until=NULL WHERE game_id IN(SELECT g2.id FROM games g2 JOIN pairs p2 ON p2.id=g2.pair_id WHERE p2.edition_id=eid) AND status='running';
 ELSIF action='open_round' THEN
  IF e.status NOT IN('ready','running') THEN RAISE EXCEPTION 'RULES_NOT_LOCKED';END IF;
  r:=(body->>'round')::int;
  IF r NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'INVALID_ROUND';END IF;
  IF EXISTS(SELECT 1 FROM pairs WHERE edition_id=eid AND round=r AND status<>'pending') THEN RAISE EXCEPTION 'ROUND_ALREADY_OPEN';END IF;
  IF r>1 AND EXISTS(SELECT 1 FROM pairs WHERE edition_id=eid AND round=CASE WHEN r=5 THEN 3 ELSE r-1 END AND status<>'confirmed') THEN RAISE EXCEPTION 'PREVIOUS_ROUND_INCOMPLETE';END IF;
  IF EXISTS(SELECT 1 FROM pairs WHERE edition_id=eid AND round=r AND (seed1 IS NULL OR seed2 IS NULL)) THEN RAISE EXCEPTION 'MISSING_SEEDS';END IF;
  UPDATE pairs SET status='running' WHERE edition_id=eid AND round=r;
  INSERT INTO games(pair_id,leg,seed1,seed2) SELECT id,1,seed1,seed2 FROM pairs WHERE edition_id=eid AND round=r;
  INSERT INTO games(pair_id,leg,seed1,seed2) SELECT id,2,seed2,seed1 FROM pairs WHERE edition_id=eid AND round=r;
  UPDATE editions SET status='running' WHERE id=eid;
 ELSIF action='confirm_pair' THEN
  SELECT * INTO p FROM pairs WHERE id=(body->>'pair_id')::bigint AND edition_id=eid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
  IF p.status<>'running' OR (SELECT count(*) FROM games WHERE pair_id=p.id AND status='ready' AND outcome IS NOT NULL)<>2 THEN RAISE EXCEPTION 'PAIR_NOT_READY';END IF;
  SELECT sum(CASE WHEN outcome='draw' THEN 0.5 WHEN (outcome='agent1' AND seed1=p.seed1) OR (outcome='agent2' AND seed2=p.seed1) THEN 1 ELSE 0 END) INTO one FROM games WHERE pair_id=p.id;
  two:=2-one;
  win:=CASE WHEN one>two THEN p.seed1 WHEN two>one THEN p.seed2 ELSE LEAST(p.seed1,p.seed2) END;
  lose:=CASE WHEN win=p.seed1 THEN p.seed2 ELSE p.seed1 END;
  UPDATE pairs SET status='confirmed',winner_seed=win,loser_seed=lose,points1=one,points2=two WHERE id=p.id;
  IF p.round<3 THEN
   UPDATE pairs SET seed1=CASE WHEN p.slot%2=1 THEN win ELSE seed1 END,seed2=CASE WHEN p.slot%2=0 THEN win ELSE seed2 END WHERE edition_id=eid AND round=p.round+1 AND slot=(p.slot+1)/2;
  ELSIF p.round=3 THEN
   UPDATE pairs SET seed1=CASE WHEN p.slot=1 THEN win ELSE seed1 END,seed2=CASE WHEN p.slot=2 THEN win ELSE seed2 END WHERE edition_id=eid AND round=4;
   UPDATE pairs SET seed1=CASE WHEN p.slot=1 THEN lose ELSE seed1 END,seed2=CASE WHEN p.slot=2 THEN lose ELSE seed2 END WHERE edition_id=eid AND round=5;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pairs WHERE edition_id=eid AND status<>'confirmed') THEN UPDATE editions SET status='finished',finished_at=now() WHERE id=eid;END IF;
 ELSE
  SELECT g2.* INTO g FROM games g2 JOIN pairs p2 ON p2.id=g2.pair_id WHERE g2.id=(body->>'game_id')::bigint AND p2.edition_id=eid FOR UPDATE OF g2;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
  SELECT * INTO p FROM pairs WHERE id=g.pair_id;
  IF p.status='confirmed' AND action<>'publish' THEN RAISE EXCEPTION 'PAIR_CONFIRMED';END IF;
  IF action='publish' THEN
   IF g.active_attempt IS NULL THEN RAISE EXCEPTION 'NO_RECORD';END IF;
   UPDATE games SET published=true WHERE id=g.id;
  ELSIF action='interrupt' THEN
   reason:=btrim(COALESCE(body->>'reason',''));
   IF length(reason)=0 THEN RAISE EXCEPTION 'REASON_REQUIRED';END IF;
   IF g.status<>'running' THEN RAISE EXCEPTION 'INVALID_STATE';END IF;
   UPDATE attempts SET status='needs_attention',error=body->>'reason',token=NULL,lease_until=NULL WHERE id=g.active_attempt AND status='running';
   UPDATE games SET status='needs_attention' WHERE id=g.id;
  ELSIF action IN('retry','adjudicate','import') THEN
   IF g.status='running' THEN RAISE EXCEPTION 'GAME_RUNNING';END IF;
   IF g.active_attempt IS NOT NULL THEN SELECT * INTO a FROM attempts WHERE id=g.active_attempt;END IF;
   reason:=btrim(COALESCE(body->>'reason',''));
   IF length(reason)=0 THEN RAISE EXCEPTION 'REASON_REQUIRED';END IF;
   IF action='retry' THEN
    IF g.status<>'needs_attention' THEN RAISE EXCEPTION 'INVALID_STATE';END IF;
    UPDATE games SET status='queued',active_attempt=NULL,outcome=NULL,published=false WHERE id=g.id;
   ELSE
    result:=body->>'outcome';
    IF result IS NULL OR result NOT IN('agent1','agent2','draw') THEN RAISE EXCEPTION 'INVALID_OUTCOME';END IF;
    INSERT INTO attempts(game_id,source,status,finished_at,outcome,reason,created_by) VALUES(g.id,CASE WHEN action='import' THEN 'import' ELSE 'admin' END,'ready',now(),result,reason,actor) RETURNING id INTO aid;
    IF action='import' THEN
     IF jsonb_typeof(body->'moves') IS DISTINCT FROM 'array' OR jsonb_array_length(body->'moves')>10000 THEN RAISE EXCEPTION 'INVALID_RECORD';END IF;
     seq:=0;
     FOR item IN SELECT value FROM jsonb_array_elements(body->'moves') LOOP
      seq:=seq+1;INSERT INTO moves(attempt_id,seq,move) VALUES(aid,seq,item);
     END LOOP;
    ELSIF a.id IS NOT NULL THEN
     INSERT INTO moves(attempt_id,seq,move,state) SELECT aid,m.seq,m.move,m.state FROM moves m WHERE m.attempt_id=a.id;
    END IF;
    UPDATE attempts SET move_count=(SELECT count(*) FROM moves WHERE attempt_id=aid) WHERE id=aid;
    UPDATE games SET active_attempt=aid,outcome=result,status='ready',published=false WHERE id=g.id;
   END IF;
  ELSE RAISE EXCEPTION 'INVALID_ACTION';END IF;
 END IF;
 UPDATE editions SET revision=revision+1 WHERE id=eid;
 INSERT INTO audit(edition_id,actor,action,payload) VALUES(eid,actor,action,body-'moves');
 RETURN jsonb_build_object('ok',true,'edition_id',eid);
END $$;

CREATE OR REPLACE FUNCTION claim_job(wid text,instance uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO __FINALS_SCHEMA__,pg_catalog AS $$
DECLARE g games%ROWTYPE;aid bigint;t uuid;e editions%ROWTYPE;
BEGIN
 -- Lost executions are never silently replayed. Admin chooses the next attempt.
 WITH expired AS (UPDATE attempts SET status='needs_attention',error='Execution lease expired',token=NULL WHERE status='running' AND lease_until<now() RETURNING id)
 UPDATE games SET status='needs_attention' WHERE active_attempt IN(SELECT id FROM expired) AND status='running';
 PERFORM 1 FROM workers WHERE id=wid AND instance_id=instance AND last_seen>now()-interval '30 seconds' FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF (SELECT count(*) FROM attempts WHERE worker_id=wid AND token=instance AND status='running')>=(SELECT concurrency FROM workers WHERE id=wid) THEN RETURN NULL;END IF;
 SELECT * INTO e FROM editions WHERE status='running' FOR SHARE;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT g2.* INTO g FROM games g2 JOIN pairs p ON p.id=g2.pair_id
 WHERE g2.status='queued' AND p.edition_id=e.id AND p.status='running'
 AND (g2.leg=1 OR EXISTS(SELECT 1 FROM games first WHERE first.pair_id=g2.pair_id AND first.leg=1 AND first.status='ready'))
 ORDER BY p.round,p.slot,g2.leg FOR UPDATE OF g2 SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL;END IF;
 -- Instance UUID + sequence gives a fenced token without requiring extensions.
 INSERT INTO attempts(game_id,source,status,worker_id,token,lease_until) VALUES(g.id,'runner','running',wid,instance,now()+interval '45 seconds') RETURNING id INTO aid;
 UPDATE games SET status='running',active_attempt=aid WHERE id=g.id;
 RETURN (SELECT jsonb_build_object('game_id',g.id,'attempt_id',aid,'token',instance,'edition_id',e.id,'rules',e.rules,'seed1',g.seed1,'seed2',g.seed2,
  'agent1_code',a.code,'agent2_code',b.code,'agent1_hash',a.code_hash,'agent2_hash',b.code_hash) FROM entrants a JOIN entrants b ON b.edition_id=a.edition_id WHERE a.edition_id=e.id AND a.seed=g.seed1 AND b.seed=g.seed2);
END $$;

CREATE OR REPLACE FUNCTION record_step(aid bigint,t uuid,expected integer,p_move jsonb,p_state jsonb,p_outcome text,p_reason text) RETURNS boolean
LANGUAGE plpgsql SET search_path TO __FINALS_SCHEMA__,pg_catalog AS $$
DECLARE a attempts%ROWTYPE;
BEGIN
 SELECT * INTO a FROM attempts WHERE id=aid FOR UPDATE;
 IF NOT FOUND OR a.token IS DISTINCT FROM t THEN RETURN false;END IF;
 IF a.move_count=expected+1 THEN RETURN EXISTS(SELECT 1 FROM moves WHERE attempt_id=aid AND seq=expected+1 AND move=p_move) AND a.state=p_state AND a.outcome IS NOT DISTINCT FROM p_outcome;END IF;
 IF a.status<>'running' OR a.lease_until<now() THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM games WHERE id=a.game_id AND active_attempt=aid AND status='running') THEN RETURN false;END IF;
 IF a.move_count<>expected THEN RETURN false;END IF;
 INSERT INTO moves(attempt_id,seq,move,state) VALUES(aid,expected+1,p_move,p_state->'engine'->'board');
 UPDATE attempts SET move_count=expected+1,state=p_state,lease_until=now()+interval '45 seconds',
  status=CASE WHEN p_outcome IS NULL THEN 'running' ELSE 'ready' END,outcome=p_outcome,reason=p_reason,
  finished_at=CASE WHEN p_outcome IS NOT NULL THEN now() END WHERE id=aid;
 IF p_outcome IS NOT NULL THEN UPDATE games SET status='ready',outcome=p_outcome WHERE id=a.game_id AND active_attempt=aid;END IF;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION fail_attempt(aid bigint,t uuid,message text) RETURNS boolean
LANGUAGE plpgsql SET search_path TO __FINALS_SCHEMA__,pg_catalog AS $$
DECLARE gid bigint;
BEGIN
 UPDATE attempts SET status='needs_attention',error=left(message,2000),lease_until=NULL,token=NULL
 WHERE id=aid AND token=t AND status='running' RETURNING game_id INTO gid;
 IF NOT FOUND THEN RETURN false;END IF;
 UPDATE games SET status='needs_attention' WHERE id=gid AND active_attempt=aid;
 RETURN true;
END $$;
