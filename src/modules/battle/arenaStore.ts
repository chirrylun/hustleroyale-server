import { randomUUID } from "node:crypto";
import type { RewardSummary } from "./protocol.js";
import type { BattleStore } from "./store.js";

const NO_REWARD: RewardSummary = { coinsEarned: 0, base: 0, multiplier: 1, dailyCap: 0, earnedToday: 0, paidMatchesToday: 0, capped: false, balance: 0 };

/** Boss Rush and Floor Raid fights: nothing is paid, no skill uses are counted and nothing is stored per fight (the boss board is written separately). */
export class ArenaStore implements BattleStore {
  async startMatch(): Promise<string> {
    return randomUUID();
  }
  async settleMatch(): Promise<RewardSummary> {
    return NO_REWARD;
  }
  async saveLog(): Promise<void> {}
  async abandon(): Promise<void> {}
}
