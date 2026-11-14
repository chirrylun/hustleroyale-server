/**
 * Experience rules, mirrored from the database functions (xp_required, xp_multiplier, mob_base_xp, award_xp,
 * report_floor_kill) so the server can preview rewards and tests can pin the numbers. The database is the source of truth.
 *
 *  - A level costs 30 + 22L + 4L^2 xp.
 *  - The level gap (monster level - fighter level) sets what a kill pays:
 *      +3 or more 1.3, +2 1.2, +1 1.1, 0 1.0, -1 0.8, -2 0.55, -3 0.3, -4 0.12, -5 or lower nothing.
 *  - A kill pays xp_required(L) / (6 + 0.9L) per fighter for a party of three (about 7 kills a level at level 1,
 *    15 at level 10, 24 at level 20, 42 at level 40), rolled between 80% and 120%.
 *  - A party of n fighters shares a pool of base * (1 + 0.35 (n - 1)): more fighters finish faster
 *    but each one levels slower, so sending everyone is never strictly best.
 *  - Power-levelling is allowed but bounded: a fighter is paid as if the monster were no higher than itself, and the
 *    gap table adds at most 30%, so being carried through a tougher floor never skips levels.
 *  - Reported kills are rate limited (a bucket of 15 that refills one every 5 s; a boss costs 5).
 */
export const xpRequired = (level: number) => 30 + 22 * level + 4 * level * level;

const GAP: Record<number, number> = { 2: 1.2, 1: 1.1, 0: 1, [-1]: 0.8, [-2]: 0.55, [-3]: 0.3, [-4]: 0.12 };

export const xpMultiplier = (fighterLevel: number, enemyLevel: number) => {
  const gap = enemyLevel - fighterLevel;
  return gap >= 3 ? 1.3 : (GAP[gap] ?? 0);
};

/** The pool for one kill of a level-`level` monster (before the party split and the level-gap multiplier). */
export const mobBaseXp = (level: number, boss = false) => {
  const l = Math.max(1, level);
  return (xpRequired(l) / (((6 + 0.9 * l) * (1 + 0.35 * 2)) / 3)) * (boss ? 6 : 1);
};

export const xpAward = (baseXp: number, fighterLevel: number, enemyLevel: number, partySize = 1) => {
  const n = Math.max(1, partySize);
  const m = xpMultiplier(fighterLevel, enemyLevel);
  return m <= 0 ? 0 : Math.max(1, Math.round((baseXp * m * (1 + 0.35 * (n - 1))) / n));
};

/** What one fighter is paid for a kill on a floor; `roll` is the shared 0.8 to 1.2 roll. */
export const killXp = (fighterLevel: number, mobLevel: number, partySize: number, roll = 1, boss = false) =>
  xpAward(mobBaseXp(Math.min(mobLevel, fighterLevel), boss) * roll, fighterLevel, mobLevel, partySize);
