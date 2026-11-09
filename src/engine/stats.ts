import type { ModStat, Unit } from "./types.js";

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

/** Arena and movement. Units are in arena units; the client scales to pixels. */
export const ARENA_W = 30;
export const ARENA_H = 20;
export const UNIT_RADIUS = 0.6;
export const CAST_LOCK_BASIC_MS = 150;
export const CAST_LOCK_SPECIAL_MS = 350;

/** Arena units per second. Speed debuffs slow movement too. */
export function moveSpeed(spd: number): number {
  return 3 + Math.max(0, spd) * 0.15;
}
