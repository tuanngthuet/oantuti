import assert from "node:assert/strict";
import { test } from "vitest";
import {
  TRUESKILL,
  confidence,
  displayRating,
  matchQuality,
  rate1v1,
  type TrueSkillRating,
} from "./trueskill.ts";
import { selectOpponent } from "./rating-selection.ts";

const initial: TrueSkillRating = { mu: TRUESKILL.initialMu, sigma: TRUESKILL.initialSigma };

test("a win raises the winner's mean and lowers both uncertainties", () => {
  const rated = rate1v1(initial, initial, "agent1");
  assert.ok(rated.agent1.mu > initial.mu);
  assert.ok(rated.agent2.mu < initial.mu);
  assert.ok(rated.agent1.sigma < initial.sigma);
  assert.ok(rated.agent2.sigma < initial.sigma);
  assert.ok(displayRating(rated.agent1) > 1000);
  assert.ok(displayRating(rated.agent2) < 1000);
});

test("a draw improves confidence without raising strength or score", () => {
  const rated = rate1v1(initial, initial, "draw");
  assert.ok(Math.abs(rated.agent1.mu - rated.agent2.mu) < 1e-10);
  assert.equal(rated.agent1.mu, initial.mu);
  assert.ok(rated.agent1.sigma < initial.sigma);
  assert.deepEqual(rated.agent1, rated.agent2);
  assert.ok(confidence(rated.agent1) > confidence(initial));
  assert.equal(displayRating(rated.agent1), 1000);
});

test("a draw against a stronger opponent improves confidence without farming points", () => {
  const stronger = { mu: 30, sigma: 5 };
  const weaker = { mu: 20, sigma: 5 };
  const rated = rate1v1(stronger, weaker, "draw");
  assert.equal(rated.agent1.mu, stronger.mu);
  assert.equal(rated.agent2.mu, weaker.mu);
  assert.ok(rated.agent1.sigma < stronger.sigma);
  assert.ok(rated.agent2.sigma < weaker.sigma);
  const reversed = rate1v1(weaker, stronger, "draw");
  assert.deepEqual(rated.agent1, reversed.agent2);
  assert.deepEqual(rated.agent2, reversed.agent1);
});

test('repeated draws reach stable confidence within the daily budget without inflating rank', () => {
  let one = { ...initial }, two = { ...initial };
  for (let index = 0; index < 20; index++) {
    const next = rate1v1(one, two, 'draw');
    assert.ok(next.agent1.sigma < one.sigma);
    one = next.agent1; two = next.agent2;
  }
  assert.ok(one.sigma <= 2.5);
  for (let index = 0; index < 1000; index++) {
    const next = rate1v1(one, two, 'draw');
    one = next.agent1; two = next.agent2;
  }
  assert.ok(Number.isFinite(one.sigma) && one.sigma > 0);
  assert.deepEqual(one, two);
  assert.equal(one.mu, initial.mu);
  assert.equal(displayRating(one), 1000);
});

test('draw confidence stays finite for extreme mean gaps and unequal uncertainty', () => {
  const known = {mu: 10000, sigma: 0.01}, fresh = {mu: -10000, sigma: initial.sigma};
  const rated = rate1v1(known, fresh, 'draw');
  assert.ok(rated.agent1.sigma > 0 && rated.agent1.sigma < known.sigma);
  assert.ok(rated.agent2.sigma > 0 && rated.agent2.sigma < fresh.sigma);
  assert.equal(rated.agent1.mu, known.mu);
  assert.equal(rated.agent2.mu, fresh.mu);
});

test('confidence alone never changes displayed strength', () => {
  for (const sigma of [25 / 3, 5, 2, 0.01]) {
    assert.equal(displayRating({ mu: 25, sigma }), 1000);
  }
});

test("match quality favors nearby ratings and confidence rises as sigma falls", () => {
  const close = matchQuality(initial, { mu: 25.5, sigma: initial.sigma });
  const far = matchQuality(initial, { mu: 45, sigma: initial.sigma });
  assert.ok(close > far);
  assert.equal(confidence(initial), 0);
  assert.ok(confidence({ mu: 25, sigma: initial.sigma / 2 }) > 0);
});

test("scheduler excludes same-user agents and avoids an immediate rematch", () => {
  const focal = { id: 1, user_id: 10, trueskill_mu: 25, trueskill_sigma: 8 };
  const sameUser = { id: 2, user_id: 10, trueskill_mu: 25, trueskill_sigma: 8 };
  const closest = { id: 3, user_id: 20, trueskill_mu: 25.1, trueskill_sigma: 8 };
  const alternative = { id: 4, user_id: 30, trueskill_mu: 26, trueskill_sigma: 8 };
  assert.equal(selectOpponent(focal, [focal, sameUser, closest, alternative])?.id, closest.id);
  assert.equal(selectOpponent(focal, [focal, sameUser, closest, alternative], { agent1_id: 1, agent2_id: 3 })?.id, alternative.id);
});
