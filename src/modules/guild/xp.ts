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

/**
 * XP pool a monster pays (mirrors mob_base_xp in the database).
 *
 * It is sized off the level curve instead of a flat formula: at equal level, a team of three needs about
 * KILLS_PER_LEVEL_BASE + KILLS_PER_LEVEL_SLOPE * level kills for a level (20 at level 1, 28 at level 40).
 * The 0.5667 is the share each fighter of three gets from xpAward's party formula, (1 + 0.35 * 2) / 3.
 * Bosses pay six normal kills. Fighters above a monster's level earn less through xpMultiplier, so out-levelling
 * a floor makes it worth less and the ladder balances itself.
 */
export const KILLS_PER_LEVEL_BASE = 20;
export const KILLS_PER_LEVEL_SLOPE = 0.2;
export const BOSS_XP_FACTOR = 6;
export const mobBaseXp = (level: number, boss = false) => {
  const lv = Math.max(1, level);
  const killsPerLevel = KILLS_PER_LEVEL_BASE + KILLS_PER_LEVEL_SLOPE * lv;
  return Math.round((xpRequired(lv) / (killsPerLevel * ((1 + 0.35 * 2) / 3))) * (boss ? BOSS_XP_FACTOR : 1));
};

/** XP each team fighter gets for handing in a quest on `floor` (mirrors the seed): a flat 20% of a level there, 1.5x for a boss kill. */
export const QUEST_XP_SHARE = 0.2;
export const questXp = (floor: number, boss = false) => Math.round(Math.round(QUEST_XP_SHARE * xpRequired(floor)) * (boss ? 1.5 : 1));
