import type { DamageType, ModStat, Role, Unit } from "./types.js";

/** Balance knobs. Tune these in one place. */
export const SPEED_SCALE = 50; // higher = speed matters less
export const DMG_SCALE = 0.5;
export const DEF_K = 20; // defense curve: dmg * K / (K + def)
export const MAGIC_DEF_FACTOR = 0.5; // defense is half as effective against magic
export const ENERGY_PER_STAMINA = 5;
export const ENERGY_REGEN_BASE = 2; // per second
export const ENERGY_REGEN_PER_STAMINA = 0.2;
export const DAMAGE_VARIANCE = 0.1; // +-10%

/** Stat after active buffs and debuffs. */
export function effStat(unit: Unit, stat: ModStat): number {
  const pct = unit.mods.reduce((sum, m) => (m.stat === stat ? sum + m.pct : sum), 0);
  return Math.max(0, unit.stats[stat] * (1 + pct / 100));
}

/** Speed shortens every cooldown: base * S / (S + spd). */
export function cooldownMs(baseMs: number, spd: number): number {
  return Math.round((baseMs * SPEED_SCALE) / (SPEED_SCALE + Math.max(0, spd)));
}

export function physicalDamage(atk: number, def: number, power: number): number {
  return (atk * power * DMG_SCALE * DEF_K) / (DEF_K + def);
}

export function magicalDamage(magic: number, def: number, power: number): number {
  return (magic * power * DMG_SCALE * DEF_K) / (DEF_K + def * MAGIC_DEF_FACTOR);
}

export function healAmount(magic: number, power: number): number {
  return magic * power * DMG_SCALE;
}

export function shieldAmount(def: number, power: number): number {
  return Math.max(5, def * power * DMG_SCALE);
}

export function maxEnergy(stamina: number): number {
  return stamina * ENERGY_PER_STAMINA;
}

export function energyRegenPerSec(stamina: number): number {
  return ENERGY_REGEN_BASE + stamina * ENERGY_REGEN_PER_STAMINA;
}

/**
 * Arena and movement. Units are in arena units; the client scales to pixels.
 * A fighter's body is UNIT_RADIUS * 2 wide and the client draws it at that size, so what you
 * see is what collides. Skill ranges are measured from the edge of the body (see reachOf).
 */
export const ARENA_W = 32;
export const ARENA_H = 20;
export const UNIT_RADIUS = 1.2;

/** Centre-to-centre distance at which a skill with this range can hit. 0 stays "no limit". */
export function reachOf(range: number): number {
  return range > 0 ? range + UNIT_RADIUS * 2 : 0;
}
export const CAST_LOCK_BASIC_MS = 150;
export const CAST_LOCK_SPECIAL_MS = 350;

/** Arena units per second. Speed debuffs slow movement too. */
export function moveSpeed(spd: number): number {
  return 3 + Math.max(0, spd) * 0.15;
}

/**
 * Damage-type matchups, by the role being hit. Tanks are plated: they shrug off physical hits
 * but magic goes through them. Healers are the opposite. Damage dealers are neutral.
 * Triangle: magic beats tanks, tanks beat physical, physical beats healers, healers beat magic.
 */
const ARMOR: Record<Role, { physical: number; magical: number }> = {
  tank: { physical: 0.8, magical: 1.25 },
  dps: { physical: 1, magical: 1 },
  healer: { physical: 1.2, magical: 0.8 },
};

export function typeMultiplier(targetRole: Role, damageType: DamageType): number {
  return damageType === "physical" || damageType === "magical" ? ARMOR[targetRole][damageType] : 1;
}

/** Stun rules. After a stun wears off the target can't be stunned again for a while. */
export const STUN_IMMUNITY_MS = 3000;
export const MAX_STUN_MS = 2000;
/** Hitting someone mid wind-up with a stun is how you cancel a big attack. */
export const KNOCK_LOCK_MS = 300;

/**
 * Match clock. A normal fight runs REGULAR_MS. Then sudden death begins: a ring closes in from
 * the edges of the arena over SUDDEN_SHRINK_MS and anyone outside it takes growing damage every
 * second, with healing halved, so every match ends. HARD_CAP_MS is only a safety net.
 */
export const REGULAR_MS = 150_000;
export const SUDDEN_SHRINK_MS = 30_000;
/** Small enough that two bodies can't both sit inside, so a standoff can't outlast the ring. */
export const SUDDEN_MIN_RADIUS = 1;
export const WARNING_BEFORE_MS = 10_000;
export const RING_TICK_MS = 1000;
export const HARD_CAP_MS = REGULAR_MS + SUDDEN_SHRINK_MS + 15_000;
export const SUDDEN_HEAL_FACTOR = 0.5;

/** Radius of the safe ring, `sinceMs` after sudden death began. Starts big enough to cover every corner. */
export function ringRadius(arena: { w: number; h: number }, sinceMs: number, shrinkMs: number, minRadius: number): number {
  const start = Math.hypot(arena.w / 2, arena.h / 2) + 1;
  const progress = Math.min(1, Math.max(0, sinceMs / shrinkMs));
  return start + (minRadius - start) * progress;
}

/** Share of max health the ring takes each second: 3% at first, rising to 10%. */
export function ringDamagePct(progress: number): number {
  return 0.03 + 0.07 * Math.min(1, Math.max(0, progress));
}
