-- Insert-only, atomic fixture import. Never reset identities, truncate, or alter old rows.
DO $$
DECLARE payload jsonb:=current_setting('app.demo_payload')::jsonb;
  item jsonb; member text; actor bigint; tid bigint; uid bigint; submitted jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(20261021, 30);
  PERFORM 1 FROM rating_scheduler_state WHERE id=true FOR UPDATE;
  IF EXISTS(SELECT 1 FROM users u JOIN jsonb_array_elements(payload->'users') x ON u.username=x->>'username') THEN
    RAISE EXCEPTION 'DEMO_USERNAME_EXISTS: no data changed; choose another --prefix';
  END IF;
  IF EXISTS(SELECT 1 FROM teams t JOIN jsonb_array_elements(payload->'teams') x ON t.name=x->>'name') THEN
    RAISE EXCEPTION 'DEMO_TEAM_EXISTS: no data changed; choose another --prefix';
  END IF;
  INSERT INTO users(username,password_hash,is_admin)
    SELECT x->>'username',x->>'password_hash',false FROM jsonb_array_elements(payload->'users') x;
  FOR item IN SELECT * FROM jsonb_array_elements(payload->'teams') LOOP
    SELECT id INTO STRICT actor FROM users WHERE username=item->'members'->>0;
    INSERT INTO teams(name,creator_id,recruiting) VALUES(item->>'name',actor,(item->>'recruiting')::boolean) RETURNING id INTO tid;
    FOR member IN SELECT jsonb_array_elements_text(item->'members') LOOP
      SELECT id INTO STRICT uid FROM users WHERE username=member;
      INSERT INTO team_members(user_id,team_id) VALUES(uid,tid);
      IF uid<>actor THEN
        INSERT INTO team_invitations(team_id,recipient_id,status) VALUES(tid,uid,'accepted');
      END IF;
    END LOOP;
    INSERT INTO team_audit(team_id,actor_id,action,details) VALUES(tid,actor,'create',jsonb_build_object('source','demo-data','members',item->'members'));
  END LOOP;
  FOR item IN SELECT * FROM jsonb_array_elements(payload->'agents') LOOP
    SELECT id INTO STRICT actor FROM users WHERE username=item->>'username';
    SELECT submit_private_agent(actor,item->>'agent_name',item->>'description',item->>'code',NULL,
      (item->>'is_public')::boolean,item->>'normalized_code',item->>'code_fingerprint') INTO submitted;
    IF COALESCE((submitted->>'duplicate')::boolean,false) THEN RAISE EXCEPTION 'UNEXPECTED_DEMO_DUPLICATE'; END IF;
  END LOOP;
END $$;
