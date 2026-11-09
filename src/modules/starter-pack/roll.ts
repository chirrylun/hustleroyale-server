import { randomInt } from "node:crypto";
import type { Rng, Role } from "../../engine/types.js";

export type Rarity = "common" | "uncommon" | "rare" | "legendary";
export type Grade = "E" | "D" | "C" | "B" | "A";

export interface FighterTemplate {
  id: string;
  role: Role;
  rarity: Rarity;
  base_hp: number;
  base_atk: number;
  base_def: number;
  base_spd: number;
  base_stamina: number;
  base_magic: number;
  supply_cap: number | null;
  minted: number;
}

/** Payload shape expected by the `open_starter_pack` database function. */
export interface PackFighter {
  template_id: string;
  grade: Grade;
  hp: number;
  atk: number;
  def: number;
  spd: number;
  stamina: number;
  magic: number;
}

/** Balance knobs for the starter pack. Legendary is intentionally not obtainable here. */
export const PACK_RARITY_WEIGHTS: Partial<Record<Rarity, number>> = { common: 70, uncommon: 25, rare: 5 };
export const PACK_GRADE_WEIGHTS: Record<Grade, number> = { E: 40, D: 30, C: 20, B: 8, A: 2 };
export const GRADE_MULTIPLIER: Record<Grade, number> = { E: 0.9, D: 1, C: 1.1, B: 1.2, A: 1.35 };
export const STAT_VARIANCE = 0.05; // +-5% on every stat

/** The pack always contains one fighter per role, in team-slot order. */
export const PACK_ROLES: Role[] = ["tank", "healer", "dps"];

/** Cryptographically strong RNG for real packs. Tests pass a seeded one instead. */
export const secureRng: Rng = { next: () => randomInt(0, 2 ** 32) / 2 ** 32 };

function weightedPick<T>(entries: [T, number][], rng: Rng): T {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.next() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1]![0];
}

const isAvailable = (t: FighterTemplate) => t.supply_cap === null || t.minted < t.supply_cap;

function rollStat(base: number, grade: Grade, rng: Rng): number {
  const variance = 1 - STAT_VARIANCE + rng.next() * STAT_VARIANCE * 2;
  return Math.max(1, Math.round(base * GRADE_MULTIPLIER[grade] * variance));
}

export function rollStarterPack(templates: FighterTemplate[], rng: Rng = secureRng): PackFighter[] {
  return PACK_ROLES.map((role) => {
    const pool = templates.filter((t) => t.role === role && isAvailable(t) && PACK_RARITY_WEIGHTS[t.rarity]);
    if (pool.length === 0) throw new Error(`no_templates_for_role:${role}`);

    const rarities = [...new Set(pool.map((t) => t.rarity))];
    const rarity = weightedPick(
      rarities.map((r): [Rarity, number] => [r, PACK_RARITY_WEIGHTS[r]!]),
      rng,
    );
    const ofRarity = pool.filter((t) => t.rarity === rarity);
    const template = ofRarity[Math.min(ofRarity.length - 1, Math.floor(rng.next() * ofRarity.length))]!;

    const grade = weightedPick(Object.entries(PACK_GRADE_WEIGHTS) as [Grade, number][], rng);
    return {
      template_id: template.id,
      grade,
      hp: rollStat(template.base_hp, grade, rng),
      atk: rollStat(template.base_atk, grade, rng),
      def: rollStat(template.base_def, grade, rng),
      spd: rollStat(template.base_spd, grade, rng),
      stamina: rollStat(template.base_stamina, grade, rng),
      magic: rollStat(template.base_magic, grade, rng),
    };
  });
}
