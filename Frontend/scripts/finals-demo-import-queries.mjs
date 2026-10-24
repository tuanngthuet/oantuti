// All graph mutations run together. Identifiers are validated; values remain parameters.
export function finalsDemoImportQueries({source,sourceFinals,target='finals',sourceEdition,requestId,name}){
 for(const schema of [source,sourceFinals,target])if(!/^[a-z_][a-z0-9_]*$/.test(schema))throw Error('Invalid schema');
 if(source==='public'||sourceFinals===target||!Number.isSafeInteger(sourceEdition)||sourceEdition<1)throw Error('Invalid demo source');
 const q=[];const add=(text,values)=>q.push({text,values});
 const S=source,F=sourceFinals,T=target,e=sourceEdition;
 add("SET LOCAL lock_timeout='10s'");
 // Public account/team triggers resolve their own unqualified tables in public.
 add("SET LOCAL search_path TO public,pg_catalog");
 add(`LOCK TABLE public.users,public.teams,public.team_members,public.arena_agents,${T}.control,${T}.editions,${T}.entrants,${T}.pairs,${T}.games,${T}.attempts,${T}.moves,${T}.audit,${T}.ck_rounds,${T}.ck_submissions,${T}.ck_round_entrants,${T}.ck_jobs IN SHARE ROW EXCLUSIVE MODE`);
 add(`LOCK TABLE ${S}.users,${S}.teams,${S}.team_members,${S}.arena_agents,${F}.editions,${F}.entrants,${F}.pairs,${F}.games,${F}.attempts,${F}.moves,${F}.audit,${F}.ck_rounds,${F}.ck_submissions,${F}.ck_round_entrants,${F}.ck_jobs IN SHARE MODE`);
 add(`DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM ${T}.editions WHERE status IN('locked','ready','running')) THEN RAISE EXCEPTION 'DEMO_TARGET_ACTIVE_EDITION';END IF;
 IF NOT EXISTS(SELECT 1 FROM ${F}.editions WHERE id=${e} AND status='finished') THEN RAISE EXCEPTION 'DEMO_SOURCE_NOT_FINISHED';END IF;
 IF EXISTS(SELECT 1 FROM ${F}.pairs WHERE edition_id=${e} AND status<>'confirmed') OR EXISTS(SELECT 1 FROM ${F}.ck_jobs WHERE edition_id=${e} AND status<>'passed') THEN RAISE EXCEPTION 'DEMO_SOURCE_UNFINISHED_WORK';END IF;
 IF EXISTS(SELECT 1 FROM ${F}.games g JOIN ${F}.pairs p ON p.id=g.pair_id WHERE p.edition_id=${e} AND (g.status<>'ready' OR NOT g.published)) THEN RAISE EXCEPTION 'DEMO_SOURCE_PRIVATE_OR_UNFINISHED_GAME';END IF;
 IF EXISTS(SELECT 1 FROM public.users u JOIN ${S}.users s ON s.username=u.username WHERE NOT s.is_admin) THEN RAISE EXCEPTION 'DEMO_USERNAME_COLLISION';END IF;
 IF (SELECT count(*) FROM ${S}.users WHERE is_admin)<>1 OR NOT EXISTS(SELECT 1 FROM public.users WHERE is_admin) THEN RAISE EXCEPTION 'DEMO_ADMIN_MAPPING_REQUIRED';END IF;
 IF EXISTS(SELECT 1 FROM ${T}.audit WHERE action='demo_import' AND payload->>'source_schema'='${F}' AND payload->>'source_edition_id'='${e}') THEN RAISE EXCEPTION 'DEMO_ALREADY_IMPORTED';END IF;
 END $$`);
 // Keep fingerprints inside the same transaction; pre-existing rows may never change.
 add(`CREATE TEMP TABLE ck_demo_existing_users ON COMMIT DROP AS SELECT id,md5(to_jsonb(u)::text) AS digest FROM public.users u`);
 add(`CREATE TEMP TABLE ck_demo_existing_agents ON COMMIT DROP AS SELECT id,md5(to_jsonb(a)::text) AS digest FROM public.arena_agents a`);
 add(`CREATE TEMP TABLE ck_demo_existing_teams ON COMMIT DROP AS SELECT id,md5(to_jsonb(t)::text) AS digest FROM public.teams t`);
 for(const [type,table,where] of [
  ['user','users','NOT is_admin'],['team','teams',`id IN(SELECT team_id FROM ${S}.arena_agents WHERE id IN(SELECT source_agent_id FROM ${F}.entrants WHERE edition_id=${e}))`],
  ['agent','arena_agents',`id IN(SELECT source_agent_id FROM ${F}.entrants WHERE edition_id=${e})`],
 ]){
  add(`CREATE TEMP TABLE ck_demo_${type}_map(source_id bigint PRIMARY KEY,target_id bigint UNIQUE NOT NULL) ON COMMIT DROP`);
  add(`INSERT INTO ck_demo_${type}_map SELECT id,nextval(pg_get_serial_sequence('public.${table}','id')) FROM ${S}.${table} WHERE ${where} ORDER BY id`);
 }
 add(`INSERT INTO ck_demo_user_map SELECT id,(SELECT id FROM public.users WHERE is_admin ORDER BY (username='admin') DESC,id LIMIT 1) FROM ${S}.users WHERE is_admin`);
 add(`INSERT INTO public.users(id,username,password_hash,is_admin,created_at) OVERRIDING SYSTEM VALUE SELECT m.target_id,s.username,s.password_hash,false,s.created_at FROM ${S}.users s JOIN ck_demo_user_map m ON m.source_id=s.id WHERE NOT s.is_admin`);
 add(`INSERT INTO public.teams(id,name,creator_id,recruiting,status,created_at) OVERRIDING SYSTEM VALUE SELECT m.target_id,s.name,u.target_id,false,s.status,s.created_at FROM ${S}.teams s JOIN ck_demo_team_map m ON m.source_id=s.id JOIN ck_demo_user_map u ON u.source_id=s.creator_id`);
 add(`INSERT INTO public.team_members(user_id,team_id,joined_at) SELECT u.target_id,t.target_id,s.joined_at FROM ${S}.team_members s JOIN ck_demo_user_map u ON u.source_id=s.user_id JOIN ck_demo_team_map t ON t.source_id=s.team_id`);
 // Archived references preserve honest provenance without entering public ranking or creating rating jobs.
 add(`INSERT INTO public.arena_agents(id,user_id,team_id,agent_name,description,code,version,status,validation_error,is_active,is_public,submitted_at)
 OVERRIDING SYSTEM VALUE SELECT a.target_id,u.target_id,t.target_id,s.agent_name,'Archived reference for completed Chung kết demo',s.code,s.version,'rejected','Archived demo reference; not a rated submission',false,false,s.submitted_at
 FROM ${S}.arena_agents s JOIN ck_demo_agent_map a ON a.source_id=s.id JOIN ck_demo_user_map u ON u.source_id=s.user_id LEFT JOIN ck_demo_team_map t ON t.source_id=s.team_id`);
 for(const [type,table,where] of [
  ['edition','editions',`id=${e}`],['pair','pairs',`edition_id=${e}`],['submission','ck_submissions',`edition_id=${e}`],
  ['game','games',`pair_id IN(SELECT id FROM ${F}.pairs WHERE edition_id=${e})`],
  ['attempt','attempts',`game_id IN(SELECT g.id FROM ${F}.games g JOIN ${F}.pairs p ON p.id=g.pair_id WHERE p.edition_id=${e})`],
 ]){
  add(`CREATE TEMP TABLE ck_demo_${type}_map(source_id bigint PRIMARY KEY,target_id bigint UNIQUE NOT NULL) ON COMMIT DROP`);
  add(`INSERT INTO ck_demo_${type}_map SELECT id,nextval(pg_get_serial_sequence('${T}.${table}','id')) FROM ${F}.${table} WHERE ${where} ORDER BY id`);
 }
 add(`INSERT INTO ${T}.editions(id,name,request_id,created_by,created_at,status,revision,rules,rules_locked_at,finished_at) OVERRIDING SYSTEM VALUE SELECT m.target_id,$1,$2::uuid,u.target_id,s.created_at,s.status,s.revision,s.rules,s.rules_locked_at,s.finished_at FROM ${F}.editions s JOIN ck_demo_edition_map m ON m.source_id=s.id JOIN ck_demo_user_map u ON u.source_id=s.created_by`,[name,requestId]);
 add(`INSERT INTO ${T}.entrants(edition_id,seed,participant_key,source_agent_id,name,members,agent_name,version,rating,code,code_hash)
 SELECT ed.target_id,s.seed,CASE WHEN s.participant_key LIKE 'user:%' THEN 'user:'||(SELECT target_id FROM ck_demo_user_map WHERE source_id=split_part(s.participant_key,':',2)::bigint) ELSE 'team:'||(SELECT target_id FROM ck_demo_team_map WHERE source_id=split_part(s.participant_key,':',2)::bigint) END,
 a.target_id,s.name,coalesce((SELECT jsonb_agg(jsonb_set(member,'{id}',to_jsonb(u.target_id)) ORDER BY ord) FROM jsonb_array_elements(s.members) WITH ORDINALITY AS x(member,ord) JOIN ck_demo_user_map u ON u.source_id=(member->>'id')::bigint),'[]'::jsonb),s.agent_name,s.version,s.rating,s.code,s.code_hash
 FROM ${F}.entrants s JOIN ck_demo_edition_map ed ON ed.source_id=s.edition_id JOIN ck_demo_agent_map a ON a.source_id=s.source_agent_id`);
 add(`INSERT INTO ${T}.ck_engines SELECT eng.* FROM ${F}.ck_engines eng WHERE EXISTS(SELECT 1 FROM ${F}.ck_rounds r WHERE r.edition_id=${e} AND r.round=eng.round AND r.engine_digest=eng.digest) ON CONFLICT DO NOTHING`);
 add(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM ${F}.ck_rounds r JOIN ${F}.ck_engines a ON a.round=r.round AND a.digest=r.engine_digest JOIN ${T}.ck_engines b ON b.round=a.round AND b.digest=a.digest WHERE r.edition_id=${e} AND (a.version<>b.version OR a.rules<>b.rules)) THEN RAISE EXCEPTION 'DEMO_ENGINE_COLLISION';END IF;END $$`);
 add(`INSERT INTO ${T}.ck_rounds(edition_id,round,generation,status,engine_digest,rules) SELECT ed.target_id,s.round,s.generation,s.status,s.engine_digest,s.rules FROM ${F}.ck_rounds s JOIN ck_demo_edition_map ed ON ed.source_id=s.edition_id`);
 add(`INSERT INTO ${T}.ck_submissions(id,edition_id,round,generation,seed,submitted_by,created_at,name,code,code_hash) OVERRIDING SYSTEM VALUE SELECT m.target_id,ed.target_id,s.round,s.generation,s.seed,u.target_id,s.created_at,s.name,s.code,s.code_hash FROM ${F}.ck_submissions s JOIN ck_demo_submission_map m ON m.source_id=s.id JOIN ck_demo_edition_map ed ON ed.source_id=s.edition_id JOIN ck_demo_user_map u ON u.source_id=s.submitted_by`);
 add(`INSERT INTO ${T}.ck_round_entrants(edition_id,round,seed,submission_id) SELECT ed.target_id,s.round,s.seed,m.target_id FROM ${F}.ck_round_entrants s JOIN ck_demo_edition_map ed ON ed.source_id=s.edition_id LEFT JOIN ck_demo_submission_map m ON m.source_id=s.submission_id`);
 add(`INSERT INTO ${T}.pairs(id,edition_id,round,slot,seed1,seed2,winner_seed,loser_seed,status,points1,points2) OVERRIDING SYSTEM VALUE SELECT m.target_id,ed.target_id,s.round,s.slot,s.seed1,s.seed2,s.winner_seed,s.loser_seed,s.status,s.points1,s.points2 FROM ${F}.pairs s JOIN ck_demo_pair_map m ON m.source_id=s.id JOIN ck_demo_edition_map ed ON ed.source_id=s.edition_id`);
 add(`INSERT INTO ${T}.games(id,pair_id,leg,seed1,seed2,status,published,outcome,active_attempt,created_at,engine_digest,engine_version,round_rules,submission1,submission2) OVERRIDING SYSTEM VALUE SELECT m.target_id,p.target_id,s.leg,s.seed1,s.seed2,s.status,s.published,s.outcome,NULL,s.created_at,s.engine_digest,s.engine_version,s.round_rules,a.target_id,b.target_id FROM ${F}.games s JOIN ck_demo_game_map m ON m.source_id=s.id JOIN ck_demo_pair_map p ON p.source_id=s.pair_id LEFT JOIN ck_demo_submission_map a ON a.source_id=s.submission1 LEFT JOIN ck_demo_submission_map b ON b.source_id=s.submission2`);
 add(`INSERT INTO ${T}.attempts(id,game_id,source,status,worker_id,token,lease_until,started_at,finished_at,state,move_count,outcome,reason,error,created_by,initial_state) OVERRIDING SYSTEM VALUE SELECT m.target_id,g.target_id,s.source,s.status,s.worker_id,NULL,NULL,s.started_at,s.finished_at,s.state,s.move_count,s.outcome,s.reason,s.error,u.target_id,s.initial_state FROM ${F}.attempts s JOIN ck_demo_attempt_map m ON m.source_id=s.id JOIN ck_demo_game_map g ON g.source_id=s.game_id LEFT JOIN ck_demo_user_map u ON u.source_id=s.created_by`);
 add(`INSERT INTO ${T}.moves(attempt_id,seq,move,state,created_at) SELECT m.target_id,s.seq,s.move,s.state,s.created_at FROM ${F}.moves s JOIN ck_demo_attempt_map m ON m.source_id=s.attempt_id`);
 add(`UPDATE ${T}.games t SET active_attempt=a.target_id FROM ${F}.games s JOIN ck_demo_game_map g ON g.source_id=s.id LEFT JOIN ck_demo_attempt_map a ON a.source_id=s.active_attempt WHERE t.id=g.target_id`);
 add(`INSERT INTO ${T}.ck_jobs(kind,edition_id,round,generation,engine_digest,submission_id,game_id,attempt_id,status,worker_id,instance,token,lease_until,error,created_at)
 SELECT s.kind,ed.target_id,s.round,s.generation,s.engine_digest,sub.target_id,g.target_id,a.target_id,s.status,s.worker_id,NULL,NULL,NULL,s.error,s.created_at FROM ${F}.ck_jobs s JOIN ck_demo_edition_map ed ON ed.source_id=s.edition_id LEFT JOIN ck_demo_submission_map sub ON sub.source_id=s.submission_id LEFT JOIN ck_demo_game_map g ON g.source_id=s.game_id LEFT JOIN ck_demo_attempt_map a ON a.source_id=s.attempt_id`);
 add(`INSERT INTO ${T}.audit(edition_id,actor,action,payload,created_at)
 SELECT ed.target_id,u.target_id,s.action,s.payload
 ||CASE WHEN s.payload?'game_id' THEN jsonb_build_object('game_id',(SELECT target_id FROM ck_demo_game_map WHERE source_id=(s.payload->>'game_id')::bigint)) ELSE '{}'::jsonb END
 ||CASE WHEN s.payload?'pair_id' THEN jsonb_build_object('pair_id',(SELECT target_id FROM ck_demo_pair_map WHERE source_id=(s.payload->>'pair_id')::bigint)) ELSE '{}'::jsonb END
 ||CASE WHEN s.payload?'edition_id' THEN jsonb_build_object('edition_id',ed.target_id) ELSE '{}'::jsonb END
 ||CASE WHEN s.payload?'submission_id' THEN jsonb_build_object('submission_id',(SELECT target_id FROM ck_demo_submission_map WHERE source_id=(s.payload->>'submission_id')::bigint)) ELSE '{}'::jsonb END,s.created_at
 FROM ${F}.audit s JOIN ck_demo_edition_map ed ON ed.source_id=s.edition_id JOIN ck_demo_user_map u ON u.source_id=s.actor`);
 // Verify exact snapshots/moves and preserve every pre-existing real account/agent/team.
 add(`DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM ck_demo_existing_users b LEFT JOIN public.users u ON u.id=b.id WHERE u.id IS NULL OR md5(to_jsonb(u)::text)<>b.digest)
 OR EXISTS(SELECT 1 FROM ck_demo_existing_agents b LEFT JOIN public.arena_agents a ON a.id=b.id WHERE a.id IS NULL OR md5(to_jsonb(a)::text)<>b.digest)
 OR EXISTS(SELECT 1 FROM ck_demo_existing_teams b LEFT JOIN public.teams t ON t.id=b.id WHERE t.id IS NULL OR md5(to_jsonb(t)::text)<>b.digest) THEN RAISE EXCEPTION 'DEMO_EXISTING_DATA_CHANGED';END IF;
 IF EXISTS(SELECT 1 FROM ${F}.moves s JOIN ck_demo_attempt_map m ON m.source_id=s.attempt_id LEFT JOIN ${T}.moves t ON t.attempt_id=m.target_id AND t.seq=s.seq WHERE t.seq IS NULL OR t.move<>s.move OR t.state IS DISTINCT FROM s.state) THEN RAISE EXCEPTION 'DEMO_REPLAY_MISMATCH';END IF;
 IF EXISTS(SELECT 1 FROM ${F}.ck_submissions s JOIN ck_demo_submission_map m ON m.source_id=s.id LEFT JOIN ${T}.ck_submissions t ON t.id=m.target_id WHERE t.id IS NULL OR t.code<>s.code OR t.code_hash<>s.code_hash OR t.seed<>s.seed OR t.round<>s.round) THEN RAISE EXCEPTION 'DEMO_SUBMISSION_MISMATCH';END IF;
 IF (SELECT count(*) FROM ${F}.entrants WHERE edition_id=${e})<>(SELECT count(*) FROM ${T}.entrants WHERE edition_id=(SELECT target_id FROM ck_demo_edition_map)) THEN RAISE EXCEPTION 'DEMO_ENTRANT_COUNT_MISMATCH';END IF;
 END $$`);
 add(`INSERT INTO ${T}.audit(edition_id,actor,action,payload) SELECT ed.target_id,e.created_by,'demo_import',jsonb_build_object('source_schema',$1::text,'source_edition_id',$2::text,'source_user_schema',$3::text,'note','Completed hosted test season copied with fresh identity mappings; ordinary rating history unchanged') FROM ck_demo_edition_map ed JOIN ${T}.editions e ON e.id=ed.target_id`,[F,String(e),S]);
 add(`SELECT (SELECT target_id FROM ck_demo_edition_map) AS edition_id,${['user','team','agent','pair','submission','game','attempt'].map(type=>`(SELECT jsonb_agg(jsonb_build_object('source',source_id,'target',target_id) ORDER BY source_id) FROM ck_demo_${type}_map) AS ${type}_map`).join(',')}`);
 return q;
}
