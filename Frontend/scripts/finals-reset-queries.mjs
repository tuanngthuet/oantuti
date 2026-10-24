export const finalsDataTables = ['editions', 'entrants', 'pairs', 'games', 'attempts', 'moves', 'audit'];

export const ckDataTables=['ck_jobs','ck_submissions','ck_round_entrants','ck_rounds'];

export function finalsResetQueries(schema, runId, includeRoundRules = false, includeCK = false) {
  if (!/^finals(?:_[a-z0-9_]+)?$/.test(schema)) throw Error('Invalid finals schema');
  const dataTables = [...finalsDataTables,...(includeRoundRules?['round_rules']:[]),...(includeCK?ckDataTables:[])];
  const tables = dataTables.map(table => `${schema}.${table}`).join(',');
  const snapshot = dataTables.map(table => `'${table}',(SELECT COALESCE(jsonb_agg(t),'[]'::jsonb) FROM ${schema}.${table} t)`).join(',');
  return [
    {text:"SET LOCAL lock_timeout='10s'"},
    {text:`LOCK TABLE ${schema}.control,${tables} IN ACCESS EXCLUSIVE MODE`},
    {text:`CREATE TABLE IF NOT EXISTS ${schema}.reset_backups(run_id text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),data jsonb NOT NULL)`},
    {text:`INSERT INTO ${schema}.reset_backups(run_id,data) SELECT $1,jsonb_build_object(${snapshot}) RETURNING run_id,created_at`,values:[runId]},
    // Retain identities so a stale runner cannot refer to a newly created game.
    // Explicit tables only: never cascade into unrelated competition data.
    {text:`TRUNCATE TABLE ${tables} CONTINUE IDENTITY`},
    {text:`SELECT run_id,created_at,data FROM ${schema}.reset_backups WHERE run_id=$1`,values:[runId]},
  ];
}
