/**
 * Experience rules, mirrored from the database functions (xp_required, xp_multiplier, award_xp) so the
 * server can preview rewards and tests can pin the numbers. The database is the source of truth.
 *
 *  - A level costs 30 + 22L + 4L^2 xp.
 *  - Monsters below you pay less the further below they are (down to 5%); monsters above you pay up to 50% more.
 *  - A quest party of n fighters shares a pool of base * (1 + 0.35 (n - 1)): more fighters finish faster
 *    but each one levels slower, so sending everyone is never strictly best.
 */
export const xpRequired = (level: number) => 30 + 22 * level + 4 * level * level;


export const xpMultiplier = (fighterLevel: number, enemyLevel: number) =>
  enemyLevel >= fighterLevel ? Math.min(1.5, 1 + 0.1 * (enemyLevel - fighterLevel)) : Math.max(0.05, 1 + 0.18 * (enemyLevel - fighterLevel));

export const xpAward = (baseXp: number, fighterLevel: number, enemyLevel: number, partySize = 1) => {
  const n = Math.max(1, partySize);
  return Math.max(1, Math.round((baseXp * xpMultiplier(fighterLevel, enemyLevel) * (1 + 0.35 * (n - 1))) / n));
};
