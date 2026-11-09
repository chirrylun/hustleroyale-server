import type { SupabaseClient } from "@supabase/supabase-js";
import type { Rng, Role, Stats, UnitInit } from "../../engine/index.js";
import type { Difficulty, UnitMeta } from "./protocol.js";
import { DIFFICULTY_CONFIG } from "./rewards.js";
import { one, toSkillDef, toSkillMeta, type SkillRow } from "./team.js";

type Rarity = "common" | "uncommon" | "rare" | "legendary";

export interface PoolTemplate {
  id: string;
  name: string;
  role: Role;
  rarity: Rarity;
  sprite_key: string;
  base_hp: number;
  base_atk: number;
  base_def: number;
  base_spd: number;
  base_stamina: number;
  base_magic: number;
  skills: SkillRow[];
}

/** Which rarities each difficulty draws its opponents from. Legendaries only show up in Boss fights. */
export const FOE_RARITY_WEIGHTS: Record<Difficulty, Partial<Record<Rarity, number>>> = {
  rookie: { common: 80, uncommon: 20 },
  hustler: { common: 45, uncommon: 40, rare: 15 },
  boss: { uncommon: 35, rare: 45, legendary: 20 },
};

const STAT_VARIANCE = 0.05;
const SCALE_MIN = 0.5;
const SCALE_MAX = 1.8;

export function statPower(s: Stats): number {
  return s.hp * 0.1 + s.atk + s.def + s.spd + s.magic + s.stamina * 0.5;
}

interface PoolRow extends Omit<PoolTemplate, "skills"> {
  skills: { slot: number; skill: SkillRow | SkillRow[] | null }[] | null;
}

export async function loadOpponentPool(supabase: SupabaseClient): Promise<PoolTemplate[]> {
  const { data, error } = await supabase
    .from("fighter_templates")
    .select(
      "id, name, role, rarity, sprite_key, base_hp, base_atk, base_def, base_spd, base_stamina, base_magic, skills:fighter_template_skills(slot, skill:skills(slug, name, kind, damage_type, power, cooldown_ms, stamina_cost, range_units, target_rule, effect))",
    );
  if (error) throw error;
  return ((data ?? []) as unknown as PoolRow[]).map((t) => ({
    ...t,
    skills: [...(t.skills ?? [])]
      .sort((a, b) => a.slot - b.slot)
      .map((s) => one(s.skill))
      .filter((s): s is SkillRow => s !== null),
  }));
}

function weightedPick<T>(entries: [T, number][], rng: Rng): T {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.next() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1]![0];
}

export interface Opponent {
  units: UnitInit[];
  metas: UnitMeta[];
  totalHp: number;
}

/**
 * Builds the AI team for an offline match. It mirrors the player's roles (a tank, healer and
 * damage dealer if they have one of each) and is then scaled so its total strength is
 * `difficulty.power` x the player's. Matching strength is the anti-farming trick: there is no
 * weak opponent to grind and no point stacking a far stronger team to stomp for the same pay.
 */
export function buildOpponent(
  pool: PoolTemplate[],
  playerRoles: Role[],
  playerPower: number,
  difficulty: Difficulty,
  rng: Rng,
): Opponent {
  const weights = FOE_RARITY_WEIGHTS[difficulty];

  const picked = playerRoles.map((role) => {
    const ofRole = pool.filter((t) => t.role === role && t.skills.length > 0);
    if (ofRole.length === 0) throw new Error(`no_opponent_for_role:${role}`);
    const rarities = [...new Set(ofRole.map((t) => t.rarity))].filter((r) => weights[r]);
    const rarity = rarities.length
      ? weightedPick(rarities.map((r): [Rarity, number] => [r, weights[r]!]), rng)
      : undefined;
    const candidates = rarity ? ofRole.filter((t) => t.rarity === rarity) : ofRole;
    return candidates[Math.min(candidates.length - 1, Math.floor(rng.next() * candidates.length))]!;
  });

  const vary = (base: number) => base * (1 - STAT_VARIANCE + rng.next() * STAT_VARIANCE * 2);
  const raw: Stats[] = picked.map((t) => ({
    hp: vary(t.base_hp),
    atk: vary(t.base_atk),
    def: vary(t.base_def),
    spd: vary(t.base_spd),
    stamina: vary(t.base_stamina),
    magic: vary(t.base_magic),
  }));

  const rawPower = raw.reduce((sum, s) => sum + statPower(s), 0);
  const k = Math.min(SCALE_MAX, Math.max(SCALE_MIN, (DIFFICULTY_CONFIG[difficulty].power * playerPower) / rawPower));
  const scale = (n: number) => Math.max(1, Math.round(n * k));

  const units: UnitInit[] = [];
  const metas: UnitMeta[] = [];
  picked.forEach((t, i) => {
    const s = raw[i]!;
    const id = `foe-${i + 1}`;
    units.push({
      id,
      side: 2,
      name: t.name,
      role: t.role,
      stats: { hp: scale(s.hp), atk: scale(s.atk), def: scale(s.def), spd: scale(s.spd), stamina: scale(s.stamina), magic: scale(s.magic) },
      skills: t.skills.map(toSkillDef),
    });
    metas.push({
      id,
      side: 2,
      name: t.name,
      role: t.role,
      spriteKey: t.sprite_key,
      grade: null,
      level: 1,
      spd: units[i]!.stats.spd,
      controlled: false,
      skills: toSkillMeta(t.skills),
    });
  });

  return { units, metas, totalHp: units.reduce((sum, u) => sum + u.stats.hp, 0) };
}
