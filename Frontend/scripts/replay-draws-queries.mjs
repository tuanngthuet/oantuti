import assert from 'node:assert/strict';

export function resetDrawQueries({stateQuery,digest,runId,data,report,ids,friendlyIds,agentRows,snapshots,wasEnabled,migration}) {
 assert.match(digest,/^[a-f0-9]{32}$/);
 const q=(text,...values)=>({text,values});
 return [
  q('SELECT id FROM rating_scheduler_state WHERE id=true FOR UPDATE'),
  q('LOCK TABLE arena_agents,rated_matches,tournament_matches,friendly_matches,rated_match_move_history,friendly_match_history IN SHARE ROW EXCLUSIVE MODE'),
  q(`DO $$ BEGIN IF (SELECT md5(data::text) FROM (${stateQuery}) s)<>'${digest}' THEN RAISE EXCEPTION 'State changed; rerun the audit'; END IF; END $$`),
  q('UPDATE rating_scheduler_state SET enabled=false WHERE id=true'),
  q('CREATE TABLE IF NOT EXISTS draw_replay_backups (run_id text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),payload jsonb NOT NULL)'),
  q('INSERT INTO draw_replay_backups(run_id,payload) VALUES($1,$2::jsonb)',runId,JSON.stringify({data,report})),
  q('DELETE FROM rated_match_move_history WHERE rated_match_id=ANY($1::bigint[])',ids),
  q('DELETE FROM friendly_match_history WHERE friendly_match_id=ANY($1::bigint[])',friendlyIds),
  q(`UPDATE rated_matches SET status='scheduled',outcome=NULL,winner_agent_id=NULL,is_infra_error=false,infra_error_detail=NULL,
    dispatched_at=NULL,started_at=NULL,finished_at=NULL,execution_token=NULL,execution_worker=NULL,dispatch_token=NULL,dispatch_lease_until=NULL,
    win_reason='',total_moves=0,agent1_mu_before=NULL,agent1_sigma_before=NULL,agent1_mu_after=NULL,agent1_sigma_after=NULL,
    agent2_mu_before=NULL,agent2_sigma_before=NULL,agent2_mu_after=NULL,agent2_sigma_after=NULL,rating_delta_agent1=NULL,rating_delta_agent2=NULL
    WHERE id=ANY($1::bigint[]) RETURNING id`,ids),
  q(`UPDATE friendly_matches SET status='scheduled',outcome=NULL,winner_agent_id=NULL,is_infra_error=false,
    finished_at=NULL,execution_token=NULL,execution_worker=NULL,win_reason='',total_moves=0,pending_backend=true
    WHERE id=ANY($1::bigint[]) RETURNING id`,friendlyIds),
  q(`UPDATE arena_agents a SET trueskill_mu=r.mu,trueskill_sigma=r.sigma,rating=r.rating,wins=r.wins,losses=r.losses,draws=r.draws
    FROM jsonb_to_recordset($1::jsonb) AS r(id bigint,mu float8,sigma float8,rating int,wins int,losses int,draws int) WHERE a.id=r.id`,JSON.stringify(agentRows)),
  q(`UPDATE rated_matches m SET agent1_mu_before=r.agent1_mu_before,agent1_sigma_before=r.agent1_sigma_before,agent1_mu_after=r.agent1_mu_after,agent1_sigma_after=r.agent1_sigma_after,
    agent2_mu_before=r.agent2_mu_before,agent2_sigma_before=r.agent2_sigma_before,agent2_mu_after=r.agent2_mu_after,agent2_sigma_after=r.agent2_sigma_after,
    rating_delta_agent1=r.rating_delta_agent1,rating_delta_agent2=r.rating_delta_agent2
    FROM jsonb_to_recordset($1::jsonb) AS r(id bigint,agent1_mu_before float8,agent1_sigma_before float8,agent1_mu_after float8,agent1_sigma_after float8,
      agent2_mu_before float8,agent2_sigma_before float8,agent2_mu_after float8,agent2_sigma_after float8,rating_delta_agent1 int,rating_delta_agent2 int) WHERE m.id=r.id`,JSON.stringify(snapshots)),
  ...migration.map(text=>q(text)),
  q('UPDATE rating_scheduler_state SET enabled=$1 WHERE id=true',wasEnabled),
 ];
}
