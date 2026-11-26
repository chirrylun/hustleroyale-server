import type { Rng, Role, Stats, UnitInit } from "../../engine/index.js";
import { THEMES } from "../../world/floor.js";
import type { UnitMeta } from "./protocol.js";
import { toSkillDef, toSkillMeta, type SkillRow } from "./team.js";

/**
 * The arena's three modes (Challenge, Boss Rush, Floor Raid) and everything they build: level ranges, floor bosses, floor mobs.
 * Every balance number is in this file. The tests in arena.test.ts run a level-matched team through each mode so a change here
 * that makes a mode impossible, or free, fails the build.
 */

export const RANGE_IDS = ["10-20", "20-30", "30-40"] as const;
export type RangeId = (typeof RANGE_IDS)[number];
export const BOSS_IDS = ["goblin", "golem", "mushroom", "direwolf"] as const;
export type BossId = (typeof BOSS_IDS)[number];
type Rarity = "common" | "uncommon" | "rare" | "legendary";

export interface RangeDef {
  id: RangeId;
  min: number;
  max: number;
  /** The floor theme the Floor Raid climbs through (floors 11-20 are caves, 21-30 swamp, 31-40 ice: the level of the range). */
  theme: "cave" | "swamp" | "ice";
  /** The floor bosses on offer in Boss Rush: the one at each end of the range, the lower one the easier. */
  bosses: [BossId, BossId];
  /** Challenge: which rarities the AI team is drawn from. */
  foeRarity: Partial<Record<Rarity, number>>;
  /** Challenge: stands in for the gear the AI team would be wearing. */
  gear: number;
  /** Chance the AI sidesteps a danger zone in time (Challenge). */
  dodge: number;
  /** Floor Raid: the mobs' health and attack against a team of this level. Tuned by the simulation test. */
  raid: { hp: number; atk: number };
}

export const RANGES: Record<RangeId, RangeDef> = {
  "10-20": { id: "10-20", min: 10, max: 20, theme: "cave", bosses: ["goblin", "golem"], foeRarity: { common: 60, uncommon: 40 }, gear: 1.1, dodge: 0.45, raid: { hp: 1, atk: 1 } },
  "20-30": { id: "20-30", min: 20, max: 30, theme: "swamp", bosses: ["golem", "mushroom"], foeRarity: { common: 20, uncommon: 50, rare: 30 }, gear: 1.2, dodge: 0.55, raid: { hp: 0.85, atk: 0.75 } },
  "30-40": { id: "30-40", min: 30, max: 40, theme: "ice", bosses: ["mushroom", "direwolf"], foeRarity: { uncommon: 25, rare: 50, legendary: 25 }, gear: 1.3, dodge: 0.7, raid: { hp: 0.85, atk: 0.75 } },
};

/** Fighters grow +9% health and +7% everything else per level (the database's fighter_scale); foes follow the same curve. */
export const HP_RATE = 0.09;
export const STAT_RATE = 0.07;
const atLevel = (base: number, level: number, rate: number) => base * (1 + rate * (Math.max(1, level) - 1));
const RARITY_MUL: Record<Rarity, number> = { common: 1, uncommon: 1.08, rare: 1.18, legendary: 1.3 };

const sk = (slug: string, name: string, o: Partial<SkillRow> = {}): SkillRow => ({
  slug, name, kind: "damage", damage_type: "physical", power: 1, cooldown_ms: 1500, stamina_cost: 0, range_units: 2, target_rule: "enemy_nearest", effect: {}, ...o,
});

/* ------------------------------------------------------------------ the ordinary mobs of the floors */

interface MobDef { name: string; role: Role; mul: [hp: number, atk: number, def: number]; spd: number; magic?: boolean; skills: SkillRow[] }

/** Same builds as the floors (KIND_MUL in world/floor.ts), plus one special each so a fight has something to watch for. */
export const MOBS: Record<string, MobDef> = {
  slime: { name: "Slime", role: "dps", mul: [1.3, 0.7, 1], spd: 5, skills: [sk("slime-bump", "Slime Bump")] },
  bat: { name: "Cave Bat", role: "dps", mul: [0.6, 1, 0.7], spd: 11, skills: [sk("bat-nip", "Nip", { cooldown_ms: 1000, power: 0.9 }), sk("bat-screech", "Screech", { kind: "debuff", damage_type: "none", power: 0, cooldown_ms: 12000, stamina_cost: 12, range_units: 7, effect: { stat: "atk", pct: -15, duration_ms: 5000 } })] },
  beetle: { name: "Rock Beetle", role: "tank", mul: [1.2, 0.9, 1.4], spd: 5, skills: [sk("beetle-pinch", "Pinch", { cooldown_ms: 1500 }), sk("beetle-shell", "Shell Up", { kind: "shield", damage_type: "none", power: 1, cooldown_ms: 14000, stamina_cost: 12, range_units: 0, target_rule: "self", effect: { duration_ms: 4000 } })] },
  weaver: { name: "Web Weaver", role: "dps", mul: [0.8, 1, 0.8], spd: 8, skills: [sk("weaver-fang", "Fang", { cooldown_ms: 1200 }), sk("weaver-web", "Web Spit", { kind: "debuff", damage_type: "none", power: 0, cooldown_ms: 11000, stamina_cost: 12, range_units: 7, effect: { stat: "spd", pct: -30, duration_ms: 4000 } })] },
  goblin: { name: "Goblin", role: "dps", mul: [1, 1, 1], spd: 8, skills: [sk("goblin-stab", "Stab", { cooldown_ms: 1100 }), sk("goblin-cheap", "Cheap Shot", { power: 1.5, cooldown_ms: 9000, stamina_cost: 12, effect: { stun_ms: 500 } })] },
  golem: { name: "Stone Golem", role: "tank", mul: [1.6, 1.2, 1.5], spd: 3, skills: [sk("golem-fist", "Rock Fist", { power: 1.2, cooldown_ms: 1900 }), sk("golem-stomp", "Stomp", { power: 1.6, cooldown_ms: 10000, stamina_cost: 14, range_units: 6, effect: { telegraph_ms: 1300, radius: 3, knockback: 2 } })] },
  boar: { name: "Tusked Boar", role: "dps", mul: [1.8, 1.4, 1.1], spd: 7, skills: [sk("boar-gore", "Gore", { power: 1.1, cooldown_ms: 1400 }), sk("boar-charge", "Charge", { power: 1.7, cooldown_ms: 9000, stamina_cost: 14, range_units: 7, effect: { telegraph_ms: 1000, radius: 2.4, stun_ms: 400 } })] },
  direwolf: { name: "Dire Wolf", role: "dps", mul: [1, 1.15, 1], spd: 10, skills: [sk("wolf-bite", "Bite", { cooldown_ms: 1000 }), sk("wolf-rend", "Rend", { power: 1.5, cooldown_ms: 8000, stamina_cost: 12, effect: { bonus_low_hp: { below: 0.5, pct: 40 } } })] },
  mushroom: { name: "Sporecap", role: "dps", mul: [0.9, 0.8, 1], spd: 5, magic: true, skills: [sk("cap-smack", "Cap Smack"), sk("cap-spore", "Spore Burst", { damage_type: "magical", power: 0.6, cooldown_ms: 9000, stamina_cost: 12, range_units: 6, effect: { dot: { power: 0.3, duration_ms: 4000, interval_ms: 1000 } } })] },
  wisp: { name: "Frost Wisp", role: "dps", mul: [0.7, 1.2, 0.6], spd: 9, magic: true, skills: [sk("wisp-spark", "Spark", { damage_type: "magical", cooldown_ms: 1300, range_units: 6 }), sk("wisp-flare", "Flare", { damage_type: "magical", power: 1.6, cooldown_ms: 10000, stamina_cost: 14, range_units: 8, effect: { telegraph_ms: 1100, radius: 2.6 } })] },
};

/** Base numbers before level, kind and rarity: a little under a recruit, because there are three of them. */
const MOB_BASE = { hp: 88, atk: 11, def: 8, stamina: 14 };

export interface Foe { units: UnitInit[]; metas: UnitMeta[]; totalHp: number }

const statsOf = (hp: number, atk: number, def: number, spd: number, magic: number): Stats => ({
  hp: Math.max(1, Math.round(hp)), atk: Math.max(1, Math.round(atk)), def: Math.max(0, Math.round(def)), spd, stamina: MOB_BASE.stamina, magic: Math.round(magic),
});

function pushFoe(f: Foe, id: string, name: string, role: Role, stats: Stats, skills: SkillRow[], sprite: string, level: number): void {
  f.units.push({ id, side: 2, name, role, stats, skills: skills.map(toSkillDef) });
  f.metas.push({ id, side: 2, name, role, spriteKey: sprite, grade: null, level, spd: stats.spd, controlled: false, skills: toSkillMeta(skills) });
  f.totalHp += stats.hp;
}

function mobUnit(f: Foe, id: string, kind: string, rarity: Rarity, level: number, power = { hp: 1, atk: 1 }): void {
  const d = MOBS[kind]!;
  const r = RARITY_MUL[rarity];
  const hp = atLevel(MOB_BASE.hp, level, HP_RATE) * d.mul[0] * r * power.hp;
  const atk = atLevel(MOB_BASE.atk, level, STAT_RATE) * d.mul[1] * r * power.atk;
  const def = atLevel(MOB_BASE.def, level, STAT_RATE) * d.mul[2] * r;
  pushFoe(f, id, d.name, d.role, d.magic ? statsOf(hp, atk * 0.3, def, d.spd, atk) : statsOf(hp, atk, def, d.spd, 2), d.skills, `mob_${kind}_${rarity}`, level);
}

/* ------------------------------------------------------------------ floor bosses */

export interface BossDef {
  id: BossId;
  name: string;
  /** The floor it guards in the adventure, so the level matches the one the player met there (floor + 2). */
  floor: number;
  level: number;
  role: Role;
  blurb: string;
  mul: [hp: number, atk: number, def: number];
  spd: number;
  magic?: boolean;
  skills: SkillRow[];
}

export const BOSSES: Record<BossId, BossDef> = {
  goblin: {
    id: "goblin", name: "Goblin Warlord", floor: 10, level: 12, role: "dps", blurb: "Hits hard and often. Watch for the red circle of his Ground Slam.", mul: [7, 1.1, 1.2], spd: 9,
    skills: [
      sk("warlord-cleaver", "Cleaver", { power: 1, cooldown_ms: 1400 }),
      sk("warlord-warcry", "War Cry", { kind: "buff", damage_type: "none", power: 0, cooldown_ms: 15000, stamina_cost: 14, range_units: 0, target_rule: "self", effect: { stat: "atk", pct: 25, duration_ms: 6000 } }),
      sk("warlord-slam", "Ground Slam", { power: 1.8, cooldown_ms: 9000, stamina_cost: 15, range_units: 8, effect: { telegraph_ms: 1300, radius: 3, stun_ms: 600 } }),
    ],
  },
  golem: {
    id: "golem", name: "Stone Colossus", floor: 20, level: 22, role: "tank", blurb: "Slow and huge. Magic cracks its plating; its Quake covers half the arena.", mul: [4.5, 1.6, 1.4], spd: 4,
    skills: [
      sk("colossus-fist", "Stone Fist", { power: 1.1, cooldown_ms: 1800 }),
      sk("colossus-quake", "Quake", { power: 2, cooldown_ms: 10000, stamina_cost: 16, range_units: 8, effect: { telegraph_ms: 1500, radius: 4.5, knockback: 3, stun_ms: 500 } }),
      sk("colossus-skin", "Stone Skin", { kind: "shield", damage_type: "none", power: 1.5, cooldown_ms: 18000, stamina_cost: 14, range_units: 0, target_rule: "self", effect: { duration_ms: 5000 } }),
    ],
  },
  mushroom: {
    id: "mushroom", name: "Spore Matriarch", floor: 30, level: 32, role: "dps", blurb: "Poisons the whole team over time and grows back what you take off.", mul: [3.8, 2.8, 1.1], spd: 6, magic: true,
    skills: [
      sk("matriarch-smack", "Cap Smack", { power: 1, cooldown_ms: 1500 }),
      sk("matriarch-cloud", "Toxic Cloud", { damage_type: "magical", power: 0.7, cooldown_ms: 9000, stamina_cost: 16, range_units: 8, effect: { telegraph_ms: 1200, radius: 3.5, dot: { power: 0.4, duration_ms: 5000, interval_ms: 1000 } } }),
      sk("matriarch-regrow", "Regrow", { kind: "heal", damage_type: "magical", power: 0.5, cooldown_ms: 14000, stamina_cost: 14, range_units: 0, target_rule: "self", effect: { hot: { power: 0.5, duration_ms: 6000, interval_ms: 1000 } } }),
    ],
  },
  direwolf: {
    id: "direwolf", name: "Alpha Direwolf", floor: 40, level: 42, role: "dps", blurb: "Fast. Pounces on whoever is furthest out, then howls to hit even harder.", mul: [5, 1.3, 1.1], spd: 13,
    skills: [
      sk("alpha-fang", "Frost Fang", { power: 1, cooldown_ms: 1100 }),
      sk("alpha-pounce", "Pounce", { power: 1.8, cooldown_ms: 8000, stamina_cost: 14, range_units: 9, effect: { telegraph_ms: 900, radius: 2.8, stun_ms: 500 } }),
      sk("alpha-howl", "Howl", { kind: "buff", damage_type: "none", power: 0, cooldown_ms: 14000, stamina_cost: 14, range_units: 0, target_rule: "all_allies", effect: { stat: "atk", pct: 30, duration_ms: 6000 } }),
    ],
  },
};

/** What a floor boss is built from before its own multipliers: a recruit's numbers at the boss's level. */
const BOSS_BASE = { hp: 100, atk: 12, def: 9, stamina: 22 };

export function buildBoss(id: BossId, level = BOSSES[id].level, unitId = "foe-1"): Foe {
  const d = BOSSES[id];
  const hp = atLevel(BOSS_BASE.hp, level, HP_RATE) * d.mul[0];
  const atk = atLevel(BOSS_BASE.atk, level, STAT_RATE) * d.mul[1];
  const def = atLevel(BOSS_BASE.def, level, STAT_RATE) * d.mul[2];
  const f: Foe = { units: [], metas: [], totalHp: 0 };
  const stats = d.magic ? { ...statsOf(hp, atk * 0.3, def, d.spd, atk), stamina: BOSS_BASE.stamina } : { ...statsOf(hp, atk, def, d.spd, 2), stamina: BOSS_BASE.stamina };
  pushFoe(f, unitId, d.name, d.role, stats, d.skills, `mob_${id}_legendary`, level);
  return f;
}

/* ------------------------------------------------------------------ Floor Raid */

export const RAID_STAGES = 10;
/** Health a fighter gets back between floors, as a share of their maximum; a fallen fighter returns at REVIVE_FRAC. */
export const RAID_HEAL_FRAC = 0.3;
export const RAID_REVIVE_FRAC = 0.35;

/** The mob level of a raid stage: from the bottom of the range on floor 1 to its top on floor 9. The tenth floor is the boss. */
export const raidLevel = (range: RangeDef, stage: number) => range.min + Math.round(((range.max - range.min) * (Math.min(stage, RAID_STAGES - 1) - 1)) / (RAID_STAGES - 2));

export const raidFloorName = (range: RangeDef, stage: number) => `${THEMES[range.theme].name}, floor ${stage}`;

/** The foe for one stage of a raid: three mobs of the theme (rarer the higher you climb), and on the tenth floor its boss. */
export function raidFoe(range: RangeDef, stage: number, rng: Rng): Foe {
  if (stage >= RAID_STAGES) return buildBoss(range.bosses[1], range.max + 2);
  const rarity: Rarity = stage <= 3 ? "common" : stage <= 6 ? (rng.next() < 0.5 ? "uncommon" : "common") : rng.next() < 0.5 ? "rare" : "uncommon";
  const kinds = THEMES[range.theme].mobs.filter((k) => MOBS[k]);
  const f: Foe = { units: [], metas: [], totalHp: 0 };
  const level = raidLevel(range, stage);
  for (let i = 0; i < 3; i++) {
    const kind = kinds[Math.min(kinds.length - 1, Math.floor(rng.next() * kinds.length))]!;
    mobUnit(f, `foe-${i + 1}`, kind, rarity, level + (i === 1 ? 1 : 0), range.raid);
  }
  return f;
}

