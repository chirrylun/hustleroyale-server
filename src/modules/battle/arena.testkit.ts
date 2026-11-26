import { createBattle, createRng, step, type BattleState, type Role, type UnitInit } from "../../engine/index.js";
import { HP_RATE, STAT_RATE, type Foe } from "./arena.js";
import { toSkillDef, type SkillRow } from "./team.js";

/** A level-matched reference team: the three Recruits (their database numbers), at `level`, in `gear` (1.15 = a modest set of equipment). Used by the balance tests. */
const S = (slug: string, o: Partial<SkillRow>): SkillRow => ({ slug, name: slug, kind: "damage", damage_type: "physical", power: 1, cooldown_ms: 1000, stamina_cost: 0, range_units: 2, target_rule: "enemy_nearest", effect: {}, ...o });
const RECRUITS: { id: string; name: string; role: Role; hp: number; atk: number; def: number; spd: number; stamina: number; magic: number; skills: SkillRow[] }[] = [
  { id: "p1", name: "Recruit Fighter", role: "tank", hp: 110, atk: 10, def: 12, spd: 6, stamina: 11, magic: 3, skills: [S("slash", { power: 1.15, cooldown_ms: 950 })] },
  { id: "p2", name: "Recruit Acolyte", role: "healer", hp: 84, atk: 4, def: 6, spd: 8, stamina: 10, magic: 13, skills: [S("basic-strike", {}), S("basic-heal", { kind: "heal", damage_type: "magical", cooldown_ms: 5000, stamina_cost: 10, range_units: 8, target_rule: "ally_lowest_hp" })] },
  { id: "p3", name: "Recruit Thief", role: "dps", hp: 80, atk: 13, def: 5, spd: 11, stamina: 10, magic: 2, skills: [S("stab", { power: 1.05, cooldown_ms: 750 }), S("dodge", { kind: "buff", damage_type: "none", power: 0, cooldown_ms: 10000, stamina_cost: 10, range_units: 0, target_rule: "self", effect: { evade_ms: 2000, evade_hits: 1, duration_ms: 2000 } })] },
];

export function referenceTeam(level: number, gear = 1.15, hpFrac: Record<string, number> = {}): UnitInit[] {
  return RECRUITS.map((r) => ({
    id: r.id, side: 1 as const, name: r.name, role: r.role, skills: r.skills.map(toSkillDef), hpFrac: hpFrac[r.id],
    stats: { hp: Math.round(r.hp * (1 + HP_RATE * (level - 1)) * gear), atk: Math.round(r.atk * (1 + STAT_RATE * (level - 1)) * gear), def: Math.round(r.def * (1 + STAT_RATE * (level - 1)) * gear), spd: r.spd, stamina: r.stamina, magic: Math.round(r.magic * (1 + STAT_RATE * (level - 1)) * gear) },
  }));
}

export function fight(team: UnitInit[], foe: Foe, seed: number, dodge = 0.55): BattleState {
  const state = createBattle([...team, ...foe.units], seed, { autoStance: [1, 2], dodge: { 1: 0.6, 2: dodge } });
  let guard = 0;
  while (!state.finished && guard++ < 4000) step(state, 100);
  return state;
}
export { createRng };
