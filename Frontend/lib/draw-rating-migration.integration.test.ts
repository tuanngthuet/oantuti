import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';

let db: PGlite;
const file = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const migration = file('draw_rating_migration.sql');
beforeAll(async () => {
  db = new PGlite();
  for (const name of ['database.sql', 'arena_schema.sql', 'tournament_schema.sql', 'trueskill_migration.sql',
    'friendly_challenge_migration.sql', 'execution_token_migration.sql', 'adaptive_rating_migration.sql',
    'teams_migration.sql', 'private_trials_migration.sql']) {
    let source = file(name);
    // Exercise an actual upgrade from the scheduler deployed before this change.
    if (name === 'adaptive_rating_migration.sql') source = source
      .replace(/^.* AS pair_draws,\n/m, '').replace(/^.*draw_pair_daily_limit\n/m, '');
    await db.exec(source);
  }
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`DROP TABLE IF EXISTS rating_policy_migrations;
    TRUNCATE users,arena_agents,rated_matches RESTART IDENTITY CASCADE;
    UPDATE rating_scheduler_state SET enabled=false;
    INSERT INTO users(username,password_hash) VALUES ('one','x'),('two','x');
    INSERT INTO arena_agents(user_id,agent_name,code,status,is_active,is_public,rating,trueskill_mu,trueskill_sigma,draws)
      VALUES (1,'one','code1','active',true,true,1760,25,2,2),(2,'two','code2','active',true,true,1760,25,2,2);
    INSERT INTO rated_matches(kind,agent1_id,agent2_id,status,outcome,total_moves,finished_at,
      agent1_mu_before,agent1_mu_after,agent1_sigma_before,agent1_sigma_after,
      agent2_mu_before,agent2_mu_after,agent2_sigma_before,agent2_sigma_after,rating_delta_agent1,rating_delta_agent2)
      SELECT 'rating',1,2,'finished','draw',8,now()-interval '2 hours',25,25,25.0/3,2,25,25,25.0/3,2,760,760 FROM generate_series(1,2);`);
});
async function apply() { await db.transaction(tx => tx.exec(migration)); }

it('corrects draw-inflated scores/deltas, preserves outcomes/model/stats and backs up original scores', async () => {
  const before = (await db.query('SELECT id,code,trueskill_mu,trueskill_sigma,wins,losses,draws,status,is_public FROM arena_agents ORDER BY id')).rows;
  await apply();
  expect((await db.query('SELECT rating FROM arena_agents ORDER BY id')).rows).toEqual([{rating:1000},{rating:1000}]);
  expect((await db.query('SELECT rating_delta_agent1,rating_delta_agent2 FROM rated_matches')).rows)
    .toEqual([{rating_delta_agent1:0,rating_delta_agent2:0},{rating_delta_agent1:0,rating_delta_agent2:0}]);
  expect((await db.query('SELECT id,code,trueskill_mu,trueskill_sigma,wins,losses,draws,status,is_public FROM arena_agents ORDER BY id')).rows).toEqual(before);
  expect((await db.query<{agents_before:{rating:number}[]}>('SELECT agents_before FROM rating_policy_migrations')).rows[0].agents_before.map(a => a.rating)).toEqual([1760,1760]);
  expect((await db.query("SELECT count(*)::int AS n FROM rated_matches WHERE outcome='draw' AND total_moves=8")).rows[0]).toEqual({n:2});
});
it('upgrades the legacy scheduler without removing participant/privacy fencing', async () => {
  await apply();
  const [{definition}] = (await db.query<{definition:string}>("SELECT pg_get_functiondef('reserve_rating_dispatch(uuid,integer)'::regprocedure) AS definition")).rows;
  expect(definition).toContain('draw_pair_daily_limit');
  expect(definition).toContain('agent_participant_key(o.id)');
  expect(definition).toContain('match_scope_allowed');
  await db.exec('UPDATE rating_scheduler_state SET enabled=true');
  const result = (await db.query<{result:{reason:string}}>('SELECT reserve_rating_dispatch(gen_random_uuid(),4) AS result')).rows[0].result;
  expect(result.reason).toBe('no_eligible_pair');
});
it('is idempotent and never overwrites the original backup on a second apply', async () => {
  await apply();
  const backup = (await db.query('SELECT * FROM rating_policy_migrations')).rows;
  await apply();
  expect((await db.query('SELECT * FROM rating_policy_migrations')).rows).toEqual(backup);
  expect((await db.query('SELECT rating FROM arena_agents ORDER BY id')).rows).toEqual([{rating:1000},{rating:1000}]);
});
it('refuses live scheduling or pending rating deliveries before any score writes', async () => {
  await db.exec('UPDATE rating_scheduler_state SET enabled=true');
  await expect(apply()).rejects.toThrow('Pause automatic rating');
  await db.exec("UPDATE rating_scheduler_state SET enabled=false; UPDATE rated_matches SET status='running' WHERE id=1");
  await expect(apply()).rejects.toThrow('Drain pending rating matches');
  expect((await db.query('SELECT rating FROM arena_agents ORDER BY id')).rows).toEqual([{rating:1760},{rating:1760}]);
});
