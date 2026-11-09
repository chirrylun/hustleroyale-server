import type { BattleState, SkillDef, Stance, Unit, Vec } from "./types.js";

export const alive = (state: BattleState) => state.units.filter((u) => u.alive);
export const alliesOf = (state: BattleState, unit: Unit) => alive(state).filter((u) => u.side === unit.side);
export const enemiesOf = (state: BattleState, unit: Unit) => alive(state).filter((u) => u.side !== unit.side);
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
const hpRatio = (u: Unit) => u.hp / u.maxHp;

export function isReady(unit: Unit, skillIndex: number): boolean {
  const skill = unit.skills[skillIndex];
  return !!skill && unit.cooldowns[skillIndex] <= 0 && unit.energy >= skill.staminaCost;
}

/** How low an ally's health must be before healers react. Defensive teams heal early. */
const HEAL_BELOW: Record<Stance, number> = { offensive: 0.55, neutral: 0.7, defensive: 0.75 };

/**
 * Who a unit wants to fight. Scores distance, missing health, role and stance, with a stickiness
 * bonus so units don't flip targets every tick. A player's explicit focus always wins.
 */
export function chooseTarget(state: BattleState, unit: Unit): Unit | undefined {
  const enemies = enemiesOf(state, unit);
  if (enemies.length === 0) return undefined;
  const focus = unit.focusId ? enemies.find((e) => e.id === unit.focusId) : undefined;
  if (focus) return focus;

  const stance = state.stances[unit.side];
  const distW = stance === "offensive" ? 0.6 : 0.9; // offensive units will chase further

  let best = enemies[0];
  let bestScore = -Infinity;
  for (const e of enemies) {
    let s = -dist(unit, e) * distW;
    s += (1 - hpRatio(e)) * (stance === "offensive" ? 7 : 6); // finish the wounded
    if (e.role === "healer") s += unit.role === "dps" ? 5 : 1; // DPS hunt healers
    if (e.role === "tank") s += 1.5; // tanks draw aggro
    if (e.id === unit.targetId) s += 3; // stickiness
    if (s > bestScore) {
      bestScore = s;
      best = e;
    }
  }
  return best;
}

/** Targets a skill would hit right now, honouring its range. Empty means it can't be cast. */
export function resolveTargets(state: BattleState, unit: Unit, skill: SkillDef, explicitId?: string): Unit[] {
  const inRange = (u: Unit) => skill.range <= 0 || dist(unit, u) <= skill.range + 0.01;
  const allies = alliesOf(state, unit);
  const enemies = enemiesOf(state, unit);
  const lowestRatio = (pool: Unit[]) => pool.reduce((l, a) => (hpRatio(a) < hpRatio(l) ? a : l));
  const lowestHp = (pool: Unit[]) => pool.reduce((l, e) => (e.hp < l.hp ? e : l));

  switch (skill.targetRule) {
    case "self":
      return [unit];
    case "all_allies":
      return allies.filter(inRange);
    case "all_enemies":
      return enemies.filter(inRange);
    case "ally_lowest_hp": {
      if (explicitId) {
        const a = allies.find((u) => u.id === explicitId);
        return a && inRange(a) ? [a] : [];
      }
      const pool = allies.filter(inRange);
      return pool.length ? [lowestRatio(pool)] : [];
    }
    case "enemy_lowest_hp": {
      if (explicitId) {
        const e = enemies.find((u) => u.id === explicitId);
        return e && inRange(e) ? [e] : [];
      }
      const pool = enemies.filter(inRange);
      return pool.length ? [lowestHp(pool)] : [];
    }
    case "enemy_nearest": {
      if (explicitId) {
        const e = enemies.find((u) => u.id === explicitId);
        return e && inRange(e) ? [e] : [];
      }
      const pool = enemies.filter(inRange);
      if (!pool.length) return [];
      const preferred = pool.find((e) => e.id === (unit.focusId ?? unit.targetId));
      return [preferred ?? pool.reduce((n, e) => (dist(unit, e) < dist(unit, n) ? e : n))];
    }
  }
}

/** Is it worth using this special right now? Keeps fighters from wasting skills. */
function worthCasting(state: BattleState, unit: Unit, skill: SkillDef, stance: Stance): boolean {
  const targets = resolveTargets(state, unit, skill);
  if (targets.length === 0) return false;
  const below = HEAL_BELOW[stance];

  switch (skill.kind) {
    case "heal":
      if (skill.targetRule === "all_allies") {
        return targets.filter((a) => hpRatio(a) < below + 0.05).length >= (stance === "defensive" ? 1 : 2);
      }
      return targets.some((a) => hpRatio(a) < below);
    case "shield":
      return targets.some((a) => a.shield <= 0);
    case "buff": {
      const stat = skill.effect.stat;
      return !!stat && targets.some((a) => !a.mods.some((m) => m.stat === stat && m.pct > 0));
    }
    case "debuff": {
      const stat = skill.effect.stat;
      return !!stat && targets.some((e) => !e.mods.some((m) => m.stat === stat && m.pct < 0));
    }
    case "damage":
      return true;
  }
}

/**
 * Picks which skill a unit should use this tick, or null if nothing is ready and in range.
 * Specials are preferred over the basic attack. Healers keep energy in reserve for their heal;
 * defensive teams also bank some energy for shields and heals, offensive teams spend freely.
 * Controlled units only ever auto-use the basic attack; their player triggers specials.
 */
export function aiChoose(state: BattleState, unit: Unit): number | null {
  const stance = state.stances[unit.side];
  const healReserve =
    unit.role === "healer"
      ? Math.max(0, ...unit.skills.filter((s) => s.kind === "heal").map((s) => s.staminaCost))
      : 0;
  const reserve =
    stance === "offensive" ? 0 : stance === "defensive" ? Math.max(healReserve, unit.maxEnergy * 0.1) : healReserve;

  if (!unit.controlled) {
    for (let i = unit.skills.length - 1; i >= 1; i--) {
      const skill = unit.skills[i];
      if (!isReady(unit, i)) continue;
      if (skill.kind === "damage" && unit.energy - skill.staminaCost < reserve) continue;
      if (worthCasting(state, unit, skill, stance)) return i;
    }
  }
  if (isReady(unit, 0) && resolveTargets(state, unit, unit.skills[0]).length > 0) return 0;
  return null;
}
