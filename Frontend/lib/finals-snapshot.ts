export function snapshotSQL(sourceSchema:string){
 if(!/^[a-z_][a-z0-9_]*$/.test(sourceSchema))throw Error('Invalid source schema');
 const s='\"'+sourceSchema+'\"';
 return `WITH candidates AS (
 SELECT a.*,COALESCE(t.name,u.username) AS participant_name,
 CASE WHEN a.team_id IS NULL THEN 'user:'||a.user_id ELSE 'team:'||a.team_id END AS participant_key,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u2.id,'username',u2.username) ORDER BY u2.id)
 FROM ${s}.team_members tm JOIN ${s}.users u2 ON u2.id=tm.user_id WHERE tm.team_id=a.team_id),'[]'::jsonb) AS members,
 (SELECT count(*) FROM ${s}.rated_matches m WHERE m.kind='rating' AND m.status='finished' AND NOT m.is_infra_error AND (m.agent1_id=a.id OR m.agent2_id=a.id)) AS valid_games
 FROM ${s}.arena_agents a JOIN ${s}.users u ON u.id=a.user_id LEFT JOIN ${s}.teams t ON t.id=a.team_id
 WHERE a.status='active' AND a.is_active AND a.is_public
 AND ((a.team_id IS NULL AND NOT EXISTS(SELECT 1 FROM ${s}.team_members tm JOIN ${s}.teams active_team ON active_team.id=tm.team_id WHERE tm.user_id=a.user_id AND active_team.status='active'))
 OR (a.team_id IS NOT NULL AND t.status='active'))
 ), representatives AS (
 SELECT *,row_number() OVER(PARTITION BY participant_key ORDER BY rating DESC,wins DESC,submitted_at,id) AS representative FROM candidates WHERE valid_games>=10
 ), ranked AS (
 SELECT *,row_number() OVER(ORDER BY rating DESC,wins DESC,submitted_at,id) AS seed FROM representatives WHERE representative=1
 ), snapshot AS (
 SELECT jsonb_agg(jsonb_build_object('seed',seed,'participant_key',participant_key,'source_agent_id',id,'name',participant_name,'members',members,
 'agent_name',agent_name,'version',version,'rating',rating,'code',code,'code_hash',encode(sha256(convert_to(code,'UTF8')),'hex')) ORDER BY seed) AS entrants FROM ranked WHERE seed<=16
 ) SELECT create_edition($1,$2,$3::uuid,COALESCE(entrants,'[]'::jsonb)) AS id FROM snapshot`;
}
