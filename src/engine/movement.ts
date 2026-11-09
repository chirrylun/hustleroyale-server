import { alliesOf, chooseTarget, dist, enemiesOf } from "./ai.js";
import { effStat, moveSpeed, UNIT_RADIUS } from "./stats.js";
import type { BattleEvent, BattleState, Stance, Unit, Vec } from "./types.js";

const hpRatio = (u: Unit) => u.hp / u.maxHp;
const centroid = (us: Vec[]): Vec => ({ x: us.reduce((s, u) => s + u.x, 0) / us.length, y: us.reduce((s, u) => s + u.y, 0) / us.length });

/** A point `len` units from `from`, directly away from `threat`. */
function awayFrom(from: Vec, threat: Vec, len: number): Vec {
  const d = dist(from, threat) || 1;
  return { x: from.x + ((from.x - threat.x) / d) * len, y: from.y + ((from.y - threat.y) / d) * len };
}

/**
 * Close in on a target until it is inside ~90% of `reach`. Returns null once there (no jitter),
 * otherwise a point at 70% of reach so the unit settles comfortably in range.
 */
function approach(from: Vec, target: Vec, reach: number): Vec | null {
  const d = dist(from, target);
  if (d <= reach * 0.9) return null;
  const k = (reach * 0.7) / d;
  return { x: target.x + (from.x - target.x) * k, y: target.y + (from.y - target.y) * k };
}

/** Defensive teams hold a line at their own side of the arena until an enemy gets close. */
const ENGAGE_DIST = 9;
function holdLine(state: BattleState, unit: Unit): Vec | null {
  const lineX = state.arena.w * (unit.side === 1 ? 0.4 : 0.6);
  return Math.abs(unit.x - lineX) > 1 ? { x: lineX, y: unit.y } : null;
}

const RETREAT_HP: Record<Stance, number> = { offensive: 0.15, neutral: 0.3, defensive: 0.35 };

/**
 * Where a unit wants to be right now (null = stay put). This is the positioning brain:
 * role decides the shape of the behaviour, stance shifts how bold or cautious it is.
 */
export function planMove(state: BattleState, unit: Unit): Vec | null {
  const enemies = enemiesOf(state, unit);
  const target = chooseTarget(state, unit);
  if (!target || enemies.length === 0) return null;
  unit.targetId = target.id;

  const stance = state.stances[unit.side];
  const allies = alliesOf(state, unit).filter((a) => a.id !== unit.id);
  const nearest = enemies.reduce((n, e) => (dist(unit, e) < dist(unit, n) ? e : n));
  const basicRange = unit.skills[0].range > 0 ? unit.skills[0].range : 2;
  const ranged = basicRange > 3;

  // A queued player cast pulls the unit into range of its target.
  const pend = state.pending.get(unit.id);
  const pendSkill = pend ? unit.skills[pend.skillIndex] : undefined;
  const pendTarget = pend?.targetId ? enemies.find((e) => e.id === pend.targetId) : undefined;
  const aim = pendTarget ?? target;
  const reach = pendSkill && pendSkill.targetRule.startsWith("enemy") && pendSkill.range > 0 ? pendSkill.range : basicRange;

  const allyCenter = allies.length ? centroid(allies) : null;
  const nearestDist = dist(unit, nearest);

  // Healers: stay inside heal range of the most hurt ally, keep away from enemies.
  if (unit.role === "healer") {
    const healRange = unit.skills.find((s) => s.kind === "heal")?.range || 6;
    const danger = stance === "defensive" ? 7 : 6;
    if (nearestDist < danger && allies.length > 0) {
      const flee = awayFrom(unit, nearest, 4);
      return allyCenter ? { x: flee.x + (allyCenter.x - flee.x) * 0.3, y: flee.y + (allyCenter.y - flee.y) * 0.3 } : flee;
    }
    if (allies.length) {
      const hurt = allies.reduce((l, a) => (hpRatio(a) < hpRatio(l) ? a : l));
      if (dist(unit, hurt) > healRange * 0.8) {
        const k = (healRange * 0.55) / dist(unit, hurt);
        return { x: hurt.x + (unit.x - hurt.x) * k, y: hurt.y + (unit.y - hurt.y) * k };
      }
    }
    return approach(unit, aim, basicRange);
  }

  // Wounded fighters fall back to the healer. With no healer left there is nowhere to run, so they fight on.
  const retreatAt = RETREAT_HP[stance] * (unit.role === "tank" ? 0.5 : 1);
  if (hpRatio(unit) < retreatAt && nearestDist < 6) {
    const healer = allies.find((a) => a.role === "healer");
    if (healer && dist(unit, healer) > 2) return { x: healer.x, y: healer.y };
  }

  // Defensive: hold the line until the enemy commits, then fight.
  if (stance === "defensive" && nearestDist > ENGAGE_DIST) return holdLine(state, unit);

  // Tanks on defence body-block for the weakest ally.
  if (unit.role === "tank" && stance === "defensive" && allies.length) {
    const weak = allies.reduce((l, a) => (hpRatio(a) < hpRatio(l) ? a : l));
    if (hpRatio(weak) < 0.7) {
      const threat = enemies.reduce((n, e) => (dist(weak, e) < dist(weak, n) ? e : n));
      const d = dist(weak, threat) || 1;
      const guard = { x: weak.x + ((threat.x - weak.x) / d) * 2.5, y: weak.y + ((threat.y - weak.y) / d) * 2.5 };
      if (dist(unit, guard) > 1) return guard;
      return null;
    }
  }

  // Ranged attackers kite: back off when an enemy gets too close, close in when out of range.
  if (ranged) {
    const kite = basicRange * (stance === "defensive" ? 0.55 : stance === "offensive" ? 0.3 : 0.42);
    if (nearestDist < kite) {
      const flee = awayFrom(unit, nearest, 3);
      return allyCenter ? { x: flee.x + (allyCenter.x - flee.x) * 0.25, y: flee.y + (allyCenter.y - flee.y) * 0.25 } : flee;
    }
  }

  return approach(unit, aim, reach);
}

/** Moves every unit one tick toward its planned position, keeps them apart and inside the arena. */
export function stepMovement(state: BattleState, dtMs: number): BattleEvent | null {
  const living = state.units.filter((u) => u.alive);
  const before = new Map(living.map((u) => [u.id, `${u.x.toFixed(2)},${u.y.toFixed(2)}`]));

  // Everyone plans from the same snapshot, then moves, so neither side gets a first-mover edge.
  const plans = living.map((u) => planMove(state, u));
  for (const [i, u] of living.entries()) {
    const dest = plans[i];
    if (!dest || state.timeMs < u.lockUntil) continue;
    const d = dist(u, dest);
    if (d < 0.05) continue;
    const step = Math.min(d, (moveSpeed(effStat(u, "spd")) * dtMs) / 1000);
    u.x += ((dest.x - u.x) / d) * step;
    u.y += ((dest.y - u.y) / d) * step;
  }

  // Separation: nobody stands inside anybody else. Pushes are summed first and applied together,
  // so list order can't favour one side in a melee scrum.
  const minGap = UNIT_RADIUS * 2;
  const push = living.map(() => ({ x: 0, y: 0 }));
  for (let i = 0; i < living.length; i++) {
    for (let j = i + 1; j < living.length; j++) {
      const a = living[i];
      const b = living[j];
      const d = dist(a, b);
      if (d >= minGap) continue;
      const nx = d === 0 ? 0 : (a.x - b.x) / d;
      const ny = d === 0 ? 0 : (a.y - b.y) / d;
      // Exactly overlapping units split along the side axis (side 1 left, side 2 right).
      const [ux, uy] = d === 0 ? [a.side === b.side ? 0 : a.side === 1 ? -1 : 1, a.side === b.side ? 1 : 0] : [nx, ny];
      const amount = (minGap - d) / 2;
      push[i].x += ux * amount;
      push[i].y += uy * amount;
      push[j].x -= ux * amount;
      push[j].y -= uy * amount;
    }
  }
  living.forEach((u, i) => {
    u.x += push[i].x;
    u.y += push[i].y;
  });
  for (const u of living) {
    u.x = Math.min(state.arena.w - UNIT_RADIUS, Math.max(UNIT_RADIUS, u.x));
    u.y = Math.min(state.arena.h - UNIT_RADIUS, Math.max(UNIT_RADIUS, u.y));
  }

  const moved = living
    .filter((u) => `${u.x.toFixed(2)},${u.y.toFixed(2)}` !== before.get(u.id))
    .map((u) => ({ id: u.id, x: Math.round(u.x * 100) / 100, y: Math.round(u.y * 100) / 100 }));
  return moved.length ? { t: state.timeMs, type: "move", units: moved } : null;
}

const COMMANDER_INTERVAL_MS = 2000;

/** The AI commander: picks a stance for AI-managed sides from how the fight is going. */
export function runCommander(state: BattleState): BattleEvent[] {
  if (state.timeMs < state.nextCommanderMs) return [];
  state.nextCommanderMs = state.timeMs + COMMANDER_INTERVAL_MS;
  const events: BattleEvent[] = [];
  const health = (side: 1 | 2) => {
    const us = state.units.filter((u) => u.side === side);
    return us.reduce((s, u) => s + (u.alive ? u.hp : 0), 0) / Math.max(1, us.reduce((s, u) => s + u.maxHp, 0));
  };
  for (const side of state.autoSides) {
    const diff = health(side) - health(side === 1 ? 2 : 1);
    const cur = state.stances[side];
    // Hysteresis: easier to stay in a stance than to enter it, so the stance doesn't flicker.
    const next: Stance =
      diff > (cur === "offensive" ? 0.08 : 0.2) ? "offensive" : diff < (cur === "defensive" ? -0.08 : -0.2) ? "defensive" : "neutral";
    if (next !== cur) {
      state.stances[side] = next;
      events.push({ t: state.timeMs, type: "stance", side, stance: next });
    }
  }
  return events;
}
