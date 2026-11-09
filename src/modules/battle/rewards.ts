import type { Side } from "../../engine/index.js";
import type { Difficulty } from "./protocol.js";

/**
 * Offline points economy. Every number a designer might want to tune is here, in one place.
 *
 * Why it looks like this: offline matches are *practice*. They pay a trickle so new players can
 * afford training and a first upgrade, but they must never become a faucet that floods the
 * economy before online play (where players stake points on each other) goes live.
 *
 *  - Pay is small and fixed per difficulty. The opponent is scaled to YOUR team's power, so a
 *    weak bot can't be farmed and a strong team doesn't earn more by stomping.
 *  - Diminishing returns by paid match count per UTC day (TIERS below).
 *  - A hard daily cap on offline income (DAILY_CAP). Whatever a player does, offline play adds at
 *    most DAILY_CAP points per account per day to the economy.
 *  - A match must be a real fight: instant results and idle losses pay nothing.
 *  - Offline results never touch rating, wins or losses; those belong to online play.
 *
 * The daily cap and tiers are enforced inside the database (settle_solo_match), atomically per
 * player. The numbers here are only passed in, so the server can never be raced into overpaying.
 */

export const DAILY_CAP = 250;

/** The Nth paid match of the day pays `mult` x base, using the first tier whose `upto` covers N. */
export const TIERS = [
  { upto: 5, mult: 1 },
  { upto: 15, mult: 0.5 },
  { upto: 30, mult: 0.25 },
] as const;

export const DIFFICULTY_CONFIG: Record<Difficulty, { power: number; win: number }> = {
  /** `power`: enemy team strength as a fraction of yours. `win`: base points for a win. */
  rookie: { power: 0.85, win: 12 },
  hustler: { power: 1.0, win: 20 },
  boss: { power: 1.15, win: 32 },
};

export const LOSS_CONSOLATION = 2;
export const MIN_WIN_DURATION_MS = 20_000;
export const MIN_LOSS_DURATION_MS = 45_000;
/** A loss only pays if you at least took this share of the enemy team's health. */
export const MIN_LOSS_DAMAGE_SHARE = 0.25;

export interface MatchOutcome {
  difficulty: Difficulty;
  winnerSide: Side | null;
  durationMs: number;
  /** Health damage the player's team actually dealt (shield-absorbed damage does not count). */
  damageDealt: number;
  enemyTotalHp: number;
}

/** Base points before the daily multiplier and cap. 0 means the match pays nothing. */
export function baseReward(o: MatchOutcome): number {
  if (o.winnerSide === 1) return o.durationMs >= MIN_WIN_DURATION_MS ? DIFFICULTY_CONFIG[o.difficulty].win : 0;
  if (o.winnerSide === 2) {
    const fought = o.durationMs >= MIN_LOSS_DURATION_MS && o.damageDealt >= o.enemyTotalHp * MIN_LOSS_DAMAGE_SHARE;
    return fought ? LOSS_CONSOLATION : 0;
  }
  return 0; // draws pay nothing
}
