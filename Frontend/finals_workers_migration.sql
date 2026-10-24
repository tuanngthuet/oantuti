-- Apply after finals_migration.sql, in ONE transaction. Never modifies rating tables.
SET LOCAL search_path TO __FINALS_SCHEMA__,pg_catalog;
SET LOCAL lock_timeout='10s';
LOCK TABLE control,editions,pairs,games,attempts,workers IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF to_regclass('__FINALS_SCHEMA__.ck_rounds') IS NULL AND
 (EXISTS(SELECT 1 FROM pairs WHERE status='running') OR EXISTS(SELECT 1 FROM attempts WHERE status='running'))
 THEN RAISE EXCEPTION 'CK_LEGACY_ACTIVE_ROUND: ask owner before switching active rounds'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS ck_upgrade_backup(id boolean PRIMARY KEY DEFAULT true,created_at timestamptz DEFAULT now(),data jsonb NOT NULL);
INSERT INTO ck_upgrade_backup(id,data) SELECT true,jsonb_build_object(
 'editions',(SELECT coalesce(jsonb_agg(t),'[]') FROM editions t),'entrants',(SELECT coalesce(jsonb_agg(t),'[]') FROM entrants t),
 'pairs',(SELECT coalesce(jsonb_agg(t),'[]') FROM pairs t),'games',(SELECT coalesce(jsonb_agg(t),'[]') FROM games t),
 'attempts',(SELECT coalesce(jsonb_agg(t),'[]') FROM attempts t),'moves',(SELECT coalesce(jsonb_agg(t),'[]') FROM moves t),
 'audit',(SELECT coalesce(jsonb_agg(t),'[]') FROM audit t),'workers',(SELECT coalesce(jsonb_agg(t),'[]') FROM workers t)) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ck_engines(
 round integer NOT NULL CHECK(round BETWEEN 1 AND 5),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 version text NOT NULL,rules jsonb NOT NULL,PRIMARY KEY(round,digest)
);
CREATE TABLE IF NOT EXISTS ck_rounds(
 edition_id bigint REFERENCES editions(id),round integer CHECK(round BETWEEN 1 AND 5),
 generation integer NOT NULL DEFAULT 1,status text NOT NULL CHECK(status IN('submitting','locked','running')),
 engine_digest text NOT NULL,rules jsonb NOT NULL,PRIMARY KEY(edition_id,round),
 FOREIGN KEY(round,engine_digest) REFERENCES ck_engines(round,digest)
);
CREATE TABLE IF NOT EXISTS ck_submissions(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,edition_id bigint NOT NULL,round integer NOT NULL,
 generation integer NOT NULL,seed integer NOT NULL,submitted_by bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),code text NOT NULL CHECK(octet_length(code) BETWEEN 1 AND 1048576),code_hash text NOT NULL,
 FOREIGN KEY(edition_id,round) REFERENCES ck_rounds(edition_id,round),FOREIGN KEY(edition_id,seed) REFERENCES entrants(edition_id,seed)
);
CREATE TABLE IF NOT EXISTS ck_round_entrants(
 edition_id bigint,round integer,seed integer,submission_id bigint REFERENCES ck_submissions(id),
 PRIMARY KEY(edition_id,round,seed),FOREIGN KEY(edition_id,round) REFERENCES ck_rounds(edition_id,round),
 FOREIGN KEY(edition_id,seed) REFERENCES entrants(edition_id,seed)
);
CREATE TABLE IF NOT EXISTS ck_workers(
 round integer NOT NULL,id text NOT NULL,instance uuid NOT NULL,digest text NOT NULL,
 last_seen timestamptz NOT NULL DEFAULT now(),concurrency integer NOT NULL CHECK(concurrency BETWEEN 1 AND 8),
 PRIMARY KEY(round,id),FOREIGN KEY(round,digest) REFERENCES ck_engines(round,digest)
);
CREATE TABLE IF NOT EXISTS ck_jobs(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,kind text NOT NULL CHECK(kind IN('validation','match')),
 edition_id bigint NOT NULL,round integer NOT NULL,generation integer NOT NULL,engine_digest text NOT NULL,
 submission_id bigint UNIQUE REFERENCES ck_submissions(id),game_id bigint REFERENCES games(id),attempt_id bigint REFERENCES attempts(id),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','passed','failed','needs_attention','cancelled')),
 worker_id text,instance uuid,token uuid,lease_until timestamptz,error text,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(edition_id,round) REFERENCES ck_rounds(edition_id,round),
 CHECK((kind='validation' AND submission_id IS NOT NULL AND game_id IS NULL) OR (kind='match' AND submission_id IS NULL AND game_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ck_one_game_job ON ck_jobs(game_id) WHERE status IN('queued','running');
CREATE INDEX IF NOT EXISTS ck_queue ON ck_jobs(round,engine_digest,status,id);
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS initial_state jsonb;
ALTER TABLE games ADD COLUMN IF NOT EXISTS engine_digest text;
ALTER TABLE games ADD COLUMN IF NOT EXISTS engine_version text;
ALTER TABLE games ADD COLUMN IF NOT EXISTS round_rules jsonb;
ALTER TABLE games ADD COLUMN IF NOT EXISTS submission1 bigint REFERENCES ck_submissions(id);
ALTER TABLE games ADD COLUMN IF NOT EXISTS submission2 bigint REFERENCES ck_submissions(id);
ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_source_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_source_check CHECK(source IN('runner','import','admin','ck_worker'));
DROP TRIGGER IF EXISTS ck_code_guard ON ck_submissions;
CREATE TRIGGER ck_code_guard BEFORE UPDATE OR DELETE ON ck_submissions FOR EACH ROW EXECUTE FUNCTION immutable_snapshot();
DROP TRIGGER IF EXISTS ck_engine_guard ON ck_engines;
CREATE TRIGGER ck_engine_guard BEFORE UPDATE OR DELETE ON ck_engines FOR EACH ROW EXECUTE FUNCTION immutable_snapshot();

CREATE OR REPLACE FUNCTION ck_can_submit(actor bigint,eid bigint,s integer) RETURNS boolean
LANGUAGE sql STABLE SET search_path TO __FINALS_SCHEMA__,pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM entrants e WHERE e.edition_id=eid AND e.seed=s AND
 (e.participant_key='user:'||actor OR (e.participant_key LIKE 'team:%' AND EXISTS
 (SELECT 1 FROM jsonb_array_elements(e.members) m WHERE m->>'id'=actor::text))))
$$;
CREATE OR REPLACE FUNCTION ck_submit(actor bigint,eid bigint,r integer,s integer,title text,source text,expected_generation integer) RETURNS bigint
LANGUAGE plpgsql SET search_path TO __FINALS_SCHEMA__,pg_catalog AS $$
DECLARE cfg ck_rounds%ROWTYPE;sid bigint;
BEGIN
 PERFORM 1 FROM editions WHERE id=eid AND status IN('ready','running') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITION_CLOSED';END IF;
 SELECT * INTO cfg FROM ck_rounds WHERE edition_id=eid AND round=r FOR UPDATE;
 IF NOT FOUND OR cfg.status<>'submitting' THEN RAISE EXCEPTION 'CK_SUBMISSIONS_CLOSED';END IF;
 IF expected_generation IS DISTINCT FROM cfg.generation THEN RAISE EXCEPTION 'STALE_REVISION';END IF;
 IF NOT ck_can_submit(actor,eid,s) OR NOT EXISTS(SELECT 1 FROM ck_round_entrants WHERE edition_id=eid AND round=r AND seed=s) THEN RAISE EXCEPTION 'CK_FORBIDDEN';END IF;
 IF length(btrim(title)) NOT BETWEEN 1 AND 100 OR octet_length(source) NOT BETWEEN 1 AND 1048576 THEN RAISE EXCEPTION 'INVALID_RECORD';END IF;
 UPDATE ck_jobs j SET status='cancelled',token=NULL,lease_until=NULL FROM ck_submissions old WHERE j.submission_id=old.id AND old.edition_id=eid AND old.round=r AND old.seed=s AND old.generation=cfg.generation AND j.status IN('queued','running');
 INSERT INTO ck_submissions(edition_id,round,generation,seed,submitted_by,name,code,code_hash)
 VALUES(eid,r,cfg.generation,s,actor,btrim(title),source,encode(sha256(convert_to(source,'UTF8')),'hex')) RETURNING id INTO sid;
 INSERT INTO ck_jobs(kind,edition_id,round,generation,engine_digest,submission_id) VALUES('validation',eid,r,cfg.generation,cfg.engine_digest,sid);
 RETURN sid;
END $$;

-- Keep bracket/adjudication semantics, while all new execution is gated by round submissions.
DO $$ BEGIN
 IF to_regprocedure('__FINALS_SCHEMA__.admin_action_legacy(bigint,bigint,integer,text,jsonb)') IS NULL THEN
 ALTER FUNCTION admin_action(bigint,bigint,integer,text,jsonb) RENAME TO admin_action_legacy;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION admin_action(actor bigint,eid bigint,expected integer,action text,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO __FINALS_SCHEMA__,pg_catalog AS $$
DECLARE e editions%ROWTYPE;cfg ck_rounds%ROWTYPE;eng ck_engines%ROWTYPE;r integer;s integer;sid bigint;answer jsonb;gid bigint;previous_attempt bigint;
BEGIN
 SELECT * INTO e FROM editions WHERE id=eid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF e.revision<>expected THEN RAISE EXCEPTION 'STALE_REVISION';END IF;
 IF e.status IN('finished','cancelled') AND action<>'publish' THEN RAISE EXCEPTION 'EDITION_CLOSED';END IF;
 r:=(body->>'round')::integer;
 IF action IN('open_submissions','lock_round') THEN
  IF r IS NULL OR r NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'INVALID_ROUND';END IF;
  IF EXISTS(SELECT 1 FROM pairs WHERE edition_id=eid AND round=r AND status<>'pending') THEN RAISE EXCEPTION 'ROUND_ALREADY_OPEN';END IF;
  IF r>1 AND EXISTS(SELECT 1 FROM pairs WHERE edition_id=eid AND round=CASE WHEN r=5 THEN 3 ELSE r-1 END AND status<>'confirmed') THEN RAISE EXCEPTION 'PREVIOUS_ROUND_INCOMPLETE';END IF;
  SELECT * INTO cfg FROM ck_rounds WHERE edition_id=eid AND round=r FOR UPDATE;
  IF action='open_submissions' THEN
   IF cfg.status='locked' THEN RAISE EXCEPTION 'CK_ROUND_LOCKED';END IF;
   SELECT * INTO eng FROM ck_engines WHERE round=r AND digest=body->>'engine_digest';
   IF NOT FOUND THEN RAISE EXCEPTION 'CK_ENGINE_UNKNOWN';END IF;
   IF EXISTS(SELECT 1 FROM pairs WHERE edition_id=eid AND round=r AND (seed1 IS NULL OR seed2 IS NULL)) THEN RAISE EXCEPTION 'MISSING_SEEDS';END IF;
   UPDATE ck_jobs SET status='cancelled',token=NULL,lease_until=NULL WHERE edition_id=eid AND round=r AND status IN('queued','running');
   INSERT INTO ck_rounds(edition_id,round,status,engine_digest,rules) VALUES(eid,r,'submitting',eng.digest,eng.rules)
   ON CONFLICT(edition_id,round) DO UPDATE SET generation=ck_rounds.generation+1,status='submitting',engine_digest=excluded.engine_digest,rules=excluded.rules;
   INSERT INTO ck_round_entrants(edition_id,round,seed)
   SELECT eid,r,seed FROM (SELECT seed1 AS seed FROM pairs WHERE edition_id=eid AND round=r UNION SELECT seed2 FROM pairs WHERE edition_id=eid AND round=r) seeds
   ON CONFLICT DO NOTHING;
   UPDATE editions SET status=CASE WHEN status='locked' THEN 'ready' ELSE status END WHERE id=eid;
  ELSE
   IF cfg.status IS DISTINCT FROM 'submitting' THEN RAISE EXCEPTION 'CK_SUBMISSIONS_CLOSED';END IF;
   FOR s IN SELECT seed FROM ck_round_entrants WHERE edition_id=eid AND round=r LOOP
    SELECT sub.id INTO sid FROM ck_submissions sub WHERE sub.edition_id=eid AND sub.round=r AND sub.seed=s AND sub.generation=cfg.generation ORDER BY sub.id DESC LIMIT 1;
    IF sid IS NULL OR NOT EXISTS(SELECT 1 FROM ck_jobs WHERE submission_id=sid AND status='passed') THEN RAISE EXCEPTION 'CK_MISSING_VALID_SUBMISSIONS';END IF;
    UPDATE ck_round_entrants SET submission_id=sid WHERE edition_id=eid AND round=r AND seed=s;
   END LOOP;
   IF NOT FOUND THEN RAISE EXCEPTION 'MISSING_SEEDS';END IF;
   UPDATE ck_rounds SET status='locked' WHERE edition_id=eid AND round=r;
  END IF;
  UPDATE editions SET revision=revision+1 WHERE id=eid;
  INSERT INTO audit(edition_id,actor,action,payload) VALUES(eid,actor,action,body);
  RETURN jsonb_build_object('ok',true,'edition_id',eid);
 END IF;
 IF action='open_round' THEN
  SELECT * INTO cfg FROM ck_rounds WHERE edition_id=eid AND round=r FOR UPDATE;
  IF cfg.status IS DISTINCT FROM 'locked' THEN RAISE EXCEPTION 'CK_ROUND_NOT_LOCKED';END IF;
 END IF;
 IF action='retry' THEN
  gid:=(body->>'game_id')::bigint;
  IF NOT EXISTS(SELECT 1 FROM games g JOIN pairs p ON p.id=g.pair_id WHERE g.id=gid AND p.edition_id=eid AND g.engine_digest IS NOT NULL) THEN RAISE EXCEPTION 'CK_LEGACY_READ_ONLY';END IF;
  UPDATE ck_jobs SET status='cancelled',token=NULL WHERE game_id=gid AND status IN('queued','running');
 END IF;
 IF action IN('adjudicate','import') THEN SELECT active_attempt INTO previous_attempt FROM games WHERE id=(body->>'game_id')::bigint;END IF;
 answer:=admin_action_legacy(actor,eid,expected,action,body);
 IF action='open_round' THEN
  UPDATE ck_rounds SET status='running' WHERE edition_id=eid AND round=r;
  UPDATE games g SET engine_digest=cfg.engine_digest,engine_version=eng2.version,round_rules=cfg.rules,
   submission1=one.submission_id,submission2=two.submission_id
  FROM pairs p,ck_round_entrants one,ck_round_entrants two,ck_engines eng2
  WHERE g.pair_id=p.id AND p.edition_id=eid AND p.round=r AND one.edition_id=eid AND one.round=r AND one.seed=g.seed1
   AND two.edition_id=eid AND two.round=r AND two.seed=g.seed2 AND eng2.round=r AND eng2.digest=cfg.engine_digest;
  INSERT INTO ck_jobs(kind,edition_id,round,generation,engine_digest,game_id)
  SELECT 'match',eid,r,cfg.generation,cfg.engine_digest,g.id FROM games g JOIN pairs p ON p.id=g.pair_id WHERE p.edition_id=eid AND p.round=r;
 ELSIF action='retry' THEN
  INSERT INTO ck_jobs(kind,edition_id,round,generation,engine_digest,game_id)
  SELECT 'match',eid,p.round,c.generation,g.engine_digest,g.id FROM games g JOIN pairs p ON p.id=g.pair_id JOIN ck_rounds c ON c.edition_id=p.edition_id AND c.round=p.round WHERE g.id=gid;
 ELSIF action IN('cancel','interrupt','adjudicate','import') THEN
  IF action IN('adjudicate','import') THEN
   UPDATE attempts SET initial_state=coalesce(body->'initial_state',(SELECT initial_state FROM attempts old WHERE old.id=previous_attempt)) WHERE id=(SELECT active_attempt FROM games WHERE id=(body->>'game_id')::bigint);
   IF action='import' THEN UPDATE moves SET state=move->'display',move=move-'display' WHERE attempt_id=(SELECT active_attempt FROM games WHERE id=(body->>'game_id')::bigint) AND move ? 'display';END IF;
  END IF;
  UPDATE ck_jobs SET status='cancelled',token=NULL,lease_until=NULL WHERE edition_id=eid AND status IN('queued','running')
   AND (action='cancel' OR game_id=(body->>'game_id')::bigint);
 END IF;
 RETURN answer;
END $$;
-- Old binaries must not consume any more jobs, even if accidentally restarted.
CREATE OR REPLACE FUNCTION claim_job(wid text,instance uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;

CREATE OR REPLACE FUNCTION ck_worker_action(r integer,wid text,ins uuid,act text,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO __FINALS_SCHEMA__,pg_catalog AS $$
DECLARE w ck_workers%ROWTYPE;j ck_jobs%ROWTYPE;cfg ck_rounds%ROWTYPE;aid bigint;ok boolean;engine jsonb;code1 text;code2 text;x ck_jobs%ROWTYPE;
BEGIN
 IF act='heartbeat' THEN
  engine:=body->'manifest';
  INSERT INTO ck_engines(round,digest,version,rules) VALUES(r,engine->>'digest',engine->>'engine_version',engine->'rules') ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM ck_engines WHERE round=r AND digest=engine->>'digest' AND version=engine->>'engine_version' AND rules=engine->'rules') THEN RAISE EXCEPTION 'CK_ENGINE_MISMATCH';END IF;
  INSERT INTO ck_workers(round,id,instance,digest,concurrency) VALUES(r,wid,ins,engine->>'digest',(body->>'concurrency')::int)
  ON CONFLICT(round,id) DO UPDATE SET instance=excluded.instance,digest=excluded.digest,concurrency=excluded.concurrency,last_seen=now()
  WHERE ck_workers.last_seen<now()-interval '30 seconds' OR (ck_workers.instance=excluded.instance AND ck_workers.digest=excluded.digest);
  IF NOT FOUND THEN RAISE EXCEPTION 'CK_WORKER_ID_BUSY';END IF;
  RETURN 'true';
 END IF;
 SELECT * INTO w FROM ck_workers WHERE round=r AND id=wid AND instance=ins AND last_seen>now()-interval '30 seconds' FOR UPDATE;
 IF NOT FOUND THEN RETURN 'false';END IF;
 IF act='offline' THEN DELETE FROM ck_workers WHERE round=r AND id=wid AND instance=ins;RETURN 'true';END IF;
 IF act='claim' THEN
  PERFORM 1 FROM editions WHERE status IN('ready','running') FOR SHARE;
  FOR x IN SELECT * FROM ck_jobs WHERE round=r AND status='running' AND lease_until<now() FOR UPDATE LOOP
   IF x.kind='match' THEN
    PERFORM fail_attempt(x.attempt_id,x.token,'Execution lease expired; admin intervention required');
   END IF;
   UPDATE ck_jobs SET status=CASE WHEN kind='validation' THEN 'failed' ELSE 'needs_attention' END,error='Execution lease expired',token=NULL WHERE id=x.id;
  END LOOP;
  IF (SELECT count(*) FROM ck_jobs WHERE round=r AND worker_id=wid AND instance=ins AND status='running')>=w.concurrency THEN RETURN NULL;END IF;
  -- Edition then round locks match submission/admin lock order.
  SELECT jobs.* INTO j FROM ck_jobs jobs JOIN ck_rounds c ON c.edition_id=jobs.edition_id AND c.round=jobs.round
  JOIN editions e ON e.id=jobs.edition_id
  LEFT JOIN games g ON g.id=jobs.game_id
  WHERE jobs.round=r AND jobs.engine_digest=w.digest AND jobs.status='queued' AND c.generation=jobs.generation AND e.status IN('ready','running')
  AND ((jobs.kind='validation' AND c.status='submitting') OR (jobs.kind='match' AND c.status='running' AND g.status='queued'
   AND (g.leg=1 OR EXISTS(SELECT 1 FROM games first WHERE first.pair_id=g.pair_id AND first.leg=1 AND first.status='ready'))))
  ORDER BY (jobs.kind='validation') DESC,jobs.game_id,jobs.id FOR UPDATE OF jobs SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL;END IF;
  SELECT * INTO cfg FROM ck_rounds WHERE edition_id=j.edition_id AND round=r FOR SHARE;
  IF j.kind='match' THEN
   PERFORM 1 FROM games WHERE id=j.game_id AND status='queued' FOR UPDATE;
   IF NOT FOUND THEN RETURN NULL;END IF;
   INSERT INTO attempts(game_id,source,status,worker_id,token,lease_until) VALUES(j.game_id,'ck_worker','running',wid,(body->>'new_token')::uuid,now()+interval '45 seconds') RETURNING id INTO aid;
   UPDATE games SET status='running',active_attempt=aid WHERE id=j.game_id;
   SELECT one.code,two.code INTO code1,code2 FROM games g JOIN ck_submissions one ON one.id=g.submission1 JOIN ck_submissions two ON two.id=g.submission2 WHERE g.id=j.game_id;
  ELSE
   SELECT code,code INTO code1,code2 FROM ck_submissions WHERE id=j.submission_id;
  END IF;
  UPDATE ck_jobs SET status='running',worker_id=wid,instance=ins,token=(body->>'new_token')::uuid,attempt_id=aid,lease_until=now()+interval '45 seconds' WHERE id=j.id RETURNING * INTO j;
  RETURN to_jsonb(j)||jsonb_build_object('rules',cfg.rules,'agent1_code',code1,'agent2_code',code2);
 END IF;
 -- Same edition lock order as admin operations, so cancellation fences every write.
 PERFORM 1 FROM editions WHERE id=(SELECT edition_id FROM ck_jobs WHERE id=(body->>'job_id')::bigint) AND status IN('ready','running') FOR SHARE;
 IF NOT FOUND THEN RETURN 'false';END IF;
 SELECT * INTO j FROM ck_jobs WHERE id=(body->>'job_id')::bigint AND round=r AND worker_id=wid AND instance=ins
 AND engine_digest=w.digest AND token=(body->>'token')::uuid AND status IN('running','passed') AND lease_until>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN 'false';END IF;
 IF j.status='passed' THEN
  IF act='step' AND j.kind='match' THEN RETURN to_jsonb(record_step(j.attempt_id,j.token,(body->>'expected')::int,body->'move',body->'state',body->>'outcome',coalesce(body->>'reason','')));END IF;
  RETURN to_jsonb(act='complete' AND j.kind='validation');
 END IF;
 IF j.kind='match' AND NOT EXISTS(SELECT 1 FROM attempts a JOIN games g ON g.active_attempt=a.id WHERE a.id=j.attempt_id AND a.token=j.token AND a.status='running' AND g.status='running') THEN RETURN 'false';END IF;
 IF act='renew' THEN
  UPDATE ck_jobs SET lease_until=now()+interval '45 seconds' WHERE id=j.id;
  UPDATE attempts SET lease_until=now()+interval '45 seconds' WHERE id=j.attempt_id;
  RETURN 'true';
 ELSIF act='initial' AND j.kind='match' THEN
  UPDATE attempts SET initial_state=body->'state' WHERE id=j.attempt_id AND (initial_state IS NULL OR initial_state=body->'state');
  RETURN to_jsonb(FOUND);
 ELSIF act='step' AND j.kind='match' THEN
  IF NOT EXISTS(SELECT 1 FROM attempts WHERE id=j.attempt_id AND initial_state IS NOT NULL) THEN RETURN 'false';END IF;
  ok:=record_step(j.attempt_id,j.token,(body->>'expected')::int,body->'move',body->'state',body->>'outcome',coalesce(body->>'reason',''));
  IF ok THEN
   UPDATE moves SET state=body->'state'->'display' WHERE attempt_id=j.attempt_id AND seq=(body->>'expected')::int+1;
   UPDATE ck_jobs SET lease_until=now()+interval '45 seconds',status=CASE WHEN body->>'outcome' IS NULL THEN status ELSE 'passed' END WHERE id=j.id;
  END IF;
  RETURN to_jsonb(ok);
 ELSIF act='complete' AND j.kind='validation' THEN
  UPDATE ck_jobs SET status='passed' WHERE id=j.id;RETURN 'true';
 ELSIF act='fail' THEN
  IF j.kind='match' THEN PERFORM fail_attempt(j.attempt_id,j.token,left(body->>'error',2000));END IF;
  UPDATE ck_jobs SET status=CASE WHEN kind='validation' THEN 'failed' ELSE 'needs_attention' END,error=left(body->>'error',2000),token=NULL WHERE id=j.id;
  RETURN 'true';
 END IF;
 RAISE EXCEPTION 'INVALID_ACTION';
END $$;
