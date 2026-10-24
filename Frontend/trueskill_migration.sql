-- TrueSkill continuous-rating migration
-- Run once after tournament_schema.sql in Neon SQL Editor.

ALTER TABLE arena_agents
  ADD COLUMN IF NOT EXISTS trueskill_mu DOUBLE PRECISION NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS trueskill_sigma DOUBLE PRECISION NOT NULL DEFAULT (25.0 / 3.0),
  ADD COLUMN IF NOT EXISTS rating INT NOT NULL DEFAULT 1000;

CREATE INDEX IF NOT EXISTS arena_agents_rating_idx ON arena_agents(rating DESC);
CREATE INDEX IF NOT EXISTS arena_agents_trueskill_sigma_idx ON arena_agents(trueskill_sigma DESC);

CREATE TABLE IF NOT EXISTS rated_matches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('validation', 'rating')),
  agent1_id BIGINT NOT NULL REFERENCES arena_agents(id) ON DELETE CASCADE,
  agent2_id BIGINT NOT NULL REFERENCES arena_agents(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'running', 'finished', 'error', 'cancelled')),
  outcome VARCHAR(10) CHECK (outcome IN ('agent1', 'agent2', 'draw')),
  winner_agent_id BIGINT REFERENCES arena_agents(id) ON DELETE SET NULL,
  is_infra_error BOOLEAN NOT NULL DEFAULT false,
  infra_error_detail TEXT,
  validation_attempts INT NOT NULL DEFAULT 0,
  dispatched_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  win_reason TEXT NOT NULL DEFAULT '',
  total_moves INT NOT NULL DEFAULT 0,
  -- Snapshot lets administrators audit each TrueSkill update.
  agent1_mu_before DOUBLE PRECISION,
  agent1_sigma_before DOUBLE PRECISION,
  agent1_mu_after DOUBLE PRECISION,
  agent1_sigma_after DOUBLE PRECISION,
  agent2_mu_before DOUBLE PRECISION,
  agent2_sigma_before DOUBLE PRECISION,
  agent2_mu_after DOUBLE PRECISION,
  agent2_sigma_after DOUBLE PRECISION,
  rating_delta_agent1 INT,
  rating_delta_agent2 INT,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rated_match_agents CHECK (
    (kind = 'validation' AND agent1_id = agent2_id) OR
    (kind = 'rating' AND agent1_id <> agent2_id)
  )
);

CREATE INDEX IF NOT EXISTS rated_matches_status_idx ON rated_matches(status, kind, scheduled_at);
CREATE INDEX IF NOT EXISTS rated_matches_agent1_idx ON rated_matches(agent1_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS rated_matches_agent2_idx ON rated_matches(agent2_id, scheduled_at DESC);

CREATE TABLE IF NOT EXISTS rated_match_move_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rated_match_id BIGINT NOT NULL REFERENCES rated_matches(id) ON DELETE CASCADE,
  move_number INT NOT NULL,
  player INT NOT NULL,
  from_col INT NOT NULL,
  from_row INT NOT NULL,
  to_col INT NOT NULL,
  to_row INT NOT NULL,
  from_pos VARCHAR(3) NOT NULL,
  to_pos VARCHAR(3) NOT NULL,
  piece_type VARCHAR(10),
  captured_type VARCHAR(10),
  UNIQUE (rated_match_id, move_number)
);

-- A lease serializes dispatchers without relying on a long-lived database connection.
CREATE TABLE IF NOT EXISTS rating_scheduler_state (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  lease_until TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  enabled BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE rating_scheduler_state ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT false;
INSERT INTO rating_scheduler_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Rebuild TrueSkill state from valid historical tournament results. The application
-- migration runner performs the math; these resets make reruns deterministic.
UPDATE arena_agents
SET trueskill_mu = 25,
    trueskill_sigma = 25.0 / 3.0,
    rating = 1000,
    wins = 0,
    losses = 0,
    draws = 0;
