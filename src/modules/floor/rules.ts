/**
 * What a floor can legitimately hold. Mirrors the web's src/lib/world/floor.ts (THEMES, baseMobCount): if the
 * monster tables or the floor-count formula change there, change them here too.
 */
import { miniFor } from "../../world/floor.js";
export const MAX_FLOOR = 40;
const THEME_MOBS: string[][] = [
  ["slime", "bat", "mushroom", "boar"], // floors 1-10
  ["bat", "slime", "goblin", "weaver", "beetle"], // 11-20
  ["slime", "mushroom", "goblin", "boar"], // 21-30
  ["slime", "direwolf", "golem", "wisp", "beetle"], // 31-40
];
const THEME_BOSS = ["goblin", "golem", "mushroom", "direwolf"];

const theme = (floor: number) => Math.min(3, Math.floor((floor - 1) / 10));
export const isBossFloor = (floor: number) => floor % 10 === 0;

export interface KillClaim {
  kind: string;
  level: number;
  boss: boolean;
  mini?: boolean;
}

/** True when a mob like this could have been spawned on this floor. */
export function plausibleMob(floor: number, m: KillClaim): boolean {
  if (!Number.isInteger(floor) || floor < 1 || floor > MAX_FLOOR || !Number.isInteger(m.level)) return false;
  const t = theme(floor);
  if (m.mini) return !m.boss && miniFor(floor)?.kind === m.kind && m.level === floor + 3;
  if (m.boss) return isBossFloor(floor) && m.kind === THEME_BOSS[t] && m.level === floor + 2;
  return THEME_MOBS[t].includes(m.kind) && m.level >= floor && m.level <= floor + 3;
}
