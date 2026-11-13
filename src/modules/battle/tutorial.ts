import { randomUUID } from "node:crypto";
import type { UnitInit } from "../../engine/index.js";
import type { RewardSummary, UnitMeta } from "./protocol.js";
import type { BattleStore } from "./store.js";
import { toSkillDef, toSkillMeta, type SkillRow } from "./team.js";

/** Stage 1: one fighter steers itself against one slime. Stage 2: the whole crew against three. */
export const TUTORIAL_STAGES = { 1: { foes: 1 }, 2: { foes: 3 } } as const;
export type TutorialStage = keyof typeof TUTORIAL_STAGES;

const SLIME_LEVEL = 1;
const SLIME_BUMP: SkillRow = {
  slug: "slime-bump", name: "Slime Bump", kind: "damage", damage_type: "physical", power: 1,
  cooldown_ms: 1500, stamina_cost: 0, range_units: 2, target_rule: "enemy_nearest", effect: {},
};

/** Level 1 slimes: soft and slow on purpose, so the first fights teach and never punish. */
export function buildSlimes(count: number): { units: UnitInit[]; metas: UnitMeta[]; totalHp: number } {
  const units: UnitInit[] = [];
  const metas: UnitMeta[] = [];
  for (let i = 0; i < count; i++) {
    const id = `foe-${i + 1}`;
    const stats = { hp: 34, atk: 5, def: 2, spd: 4, stamina: 6, magic: 0 };
    units.push({ id, side: 2, name: "Slime", role: "dps", stats, skills: [toSkillDef(SLIME_BUMP)] });
    metas.push({ id, side: 2, name: "Slime", role: "dps", spriteKey: "mob_slime_common", grade: null, level: SLIME_LEVEL, spd: stats.spd, controlled: false, skills: toSkillMeta([SLIME_BUMP]) });
  }
  return { units, metas, totalHp: units.reduce((s, u) => s + u.stats.hp, 0) };
}

const NO_REWARD: RewardSummary = { coinsEarned: 0, base: 0, multiplier: 1, dailyCap: 0, earnedToday: 0, paidMatchesToday: 0, capped: false, balance: 0 };

/** Tutorial fights are never stored and never pay: they only teach. */
export class TutorialStore implements BattleStore {
  async startMatch(): Promise<string> {
    return randomUUID();
  }
  async settleMatch(): Promise<RewardSummary> {
    return NO_REWARD;
  }
  async saveLog(): Promise<void> {}
  async abandon(): Promise<void> {}
}
