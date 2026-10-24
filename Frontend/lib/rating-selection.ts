import { matchQuality, type TrueSkillRating } from "./trueskill.ts";

export type RatingCandidate = {
  id: number;
  user_id: number;
  trueskill_mu: number;
  trueskill_sigma: number;
};

/** Legacy quality-only helper; adaptive selection lives in reserve_rating_dispatch. */
export function selectOpponent(
  focal: RatingCandidate,
  candidates: RatingCandidate[],
  lastMatch?: { agent1_id: number; agent2_id: number },
) {
  let opponents = candidates.filter((agent) => agent.user_id !== focal.user_id);
  if (lastMatch) {
    const withoutImmediateRematch = opponents.filter((agent) =>
      !((lastMatch.agent1_id === focal.id && lastMatch.agent2_id === agent.id) ||
        (lastMatch.agent2_id === focal.id && lastMatch.agent1_id === agent.id)),
    );
    if (withoutImmediateRematch.length > 0) opponents = withoutImmediateRematch;
  }
  const focalRating: TrueSkillRating = { mu: Number(focal.trueskill_mu), sigma: Number(focal.trueskill_sigma) };
  return opponents.sort((left, right) => {
    const lQuality = matchQuality(focalRating, { mu: Number(left.trueskill_mu), sigma: Number(left.trueskill_sigma) });
    const rQuality = matchQuality(focalRating, { mu: Number(right.trueskill_mu), sigma: Number(right.trueskill_sigma) });
    return rQuality - lQuality || Number(right.trueskill_sigma) - Number(left.trueskill_sigma) || left.id - right.id;
  })[0] ?? null;
}
