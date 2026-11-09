import { alliesOf, chooseTarget, dist, enemiesOf } from "./ai.js";
import { effStat, moveSpeed, reachOf, ringRadius, UNIT_RADIUS } from "./stats.js";
import type { BattleEvent, BattleState, Stance, Unit, Vec, Windup } from "./types.js";

const hpRatio = (u: Unit) => u.hp / u.maxHp;
const centroid = (us: Vec[]): Vec => ({ x: us.reduce((s, u) => s + u.x, 0) / us.length, y: us.reduce((s, u) => s + u.y, 0) / us.length });

/** A point `len` units from `from`, directly away from `threat`. */
function awayFrom(from: Vec, threat: Vec, len: number): Vec {
  const d = dist(from, threat) || 1;
  return { x: from.x + ((from.x - threat.x) / d) * len, y: from.y + ((from.y - threat.y) / d) * len };
}

/**
 * Close in on a target until it is inside ~90% of `reach`. Returns null once there (no jitter),
 * otherwise a point at 70% of reach. `fan` swings that point around the target, so several
 * fighters on one enemy surround it instead of stacking on the same spot.
 */
function approach(from: Vec, target: Vec, reach: number, fan = 0): Vec | null {
  const d = dist(from, target);
  if (d <= reach * 0.9) return null;
  const angle = Math.atan2(from.y - target.y, from.x - target.x) + fan;
  return { x: target.x + Math.cos(angle) * reach * 0.7, y: target.y + Math.sin(angle) * reach * 0.7 };
}

/** Each fighter gets its own slot around a shared target, evenly fanned out from the middle. */
function fanOffset(state: BattleState, unit: Unit): number {
  const mates = alliesOf(state, unit).sort((a, b) => (a.id < b.id ? -1 : 1));
  const i = mates.findIndex((m) => m.id === unit.id);
  // Mirrored for side 2, so the two teams fan out as reflections of each other.
  return (unit.side === 1 ? 1 : -1) * (i - (mates.length - 1) / 2) * 0.7;
}

export function clampToArena(state: BattleState, p: Vec): Vec {
  return {
    x: Math.min(state.arena.w - UNIT_RADIUS, Math.max(UNIT_RADIUS, p.x)),
    y: Math.min(state.arena.h - UNIT_RADIUS, Math.max(UNIT_RADIUS, p.y)),
  };
}

/** Nobody stands inside a pillar or a stall. */
export function pushOutOfObstacles(state: BattleState, u: Vec): void {
  for (const o of state.obstacles) {
    const min = o.r + UNIT_RADIUS;
    const d = dist(u, o);
    if (d >= min) continue;
    const nx = d === 0 ? 1 : (u.x - o.x) / d;
    const ny = d === 0 ? 0 : (u.y - o.y) / d;
    u.x = o.x + nx * min;
    u.y = o.y + ny * min;
  }
}

/**
 * If an obstacle sits on the straight line to `dest`, returns a waypoint past its edge instead,
 * on whichever side the unit is already leaning, so fighters walk around cover and don't stall behind it.
 */
export function steer(state: BattleState, from: Vec, dest: Vec): Vec {
  const dx = dest.x - from.x;
  const dy = dest.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return dest;
  const ux = dx / len;
  const uy = dy / len;

  let blocker: { o: (typeof state.obstacles)[number]; t: number } | null = null;
  for (const o of state.obstacles) {
    const clear = o.r + UNIT_RADIUS + 0.25;
    const t = (o.x - from.x) * ux + (o.y - from.y) * uy;
    if (t <= 0 || t >= len + clear) continue;
    if (Math.hypot(o.x - (from.x + ux * t), o.y - (from.y + uy * t)) >= clear) continue;
    if (!blocker || t < blocker.t) blocker = { o, t };
  }
  if (!blocker) return dest;

  const { o } = blocker;
  const nx = -uy;
  const ny = ux;
  const lean = (from.x - o.x) * nx + (from.y - o.y) * ny;
  const side = Math.abs(lean) > 0.05 ? Math.sign(lean) : from.y <= o.y ? -Math.sign(ny || 1) : Math.sign(ny || 1);
  const reach = o.r + UNIT_RADIUS + 0.6;
  const way = { x: o.x + nx * side * reach, y: o.y + ny * side * reach };
  return dist(from, way) < 0.3 ? dest : way;
}

/** Defensive teams hold a line at their own side of the arena until an enemy gets close. */
const ENGAGE_DIST = 9;
function holdLine(state: BattleState, unit: Unit): Vec | null {
  const lineX = state.arena.w * (unit.side === 1 ? 0.4 : 0.6);
  return Math.abs(unit.x - lineX) > 1 ? { x: lineX, y: unit.y } : null;
}

const RETREAT_HP: Record<Stance, number> = { offensive: 0.15, neutral: 0.3, defensive: 0.35 };

const arenaCentre = (state: BattleState): Vec => ({ x: state.arena.w / 2, y: state.arena.h / 2 });

/** Current radius of the sudden-death ring, or null before it starts. */
export function currentRing(state: BattleState): number | null {
  if (!state.sudden) return null;
  const { regularMs, shrinkMs, minRadius } = state.clock;
  return ringRadius(state.arena, state.timeMs - regularMs, shrinkMs, minRadius);
}

/** Pulls a destination back inside the ring so AI fighters don't chase targets out of it. */
function keepInRing(state: BattleState, dest: Vec | null, margin = 1.5): Vec | null {
  const ring = currentRing(state);
  if (ring === null || !dest) return dest;
  const c = arenaCentre(state);
  const limit = Math.max(UNIT_RADIUS, ring - margin);
  const d = dist(c, dest);
  return d <= limit ? dest : { x: c.x + ((dest.x - c.x) / d) * limit, y: c.y + ((dest.y - c.y) / d) * limit };
}

/** The nearest spot clear of a danger zone, with room to spare. */
function escapeZone(state: BattleState, unit: Unit, zone: Windup): Vec {
  const d = dist(unit, zone);
  const dir = d < 0.05 ? { x: unit.side === 1 ? -1 : 1, y: 0 } : { x: (unit.x - zone.x) / d, y: (unit.y - zone.y) / d };
  const out = zone.radius + 0.5;
  let spot = clampToArena(state, { x: zone.x + dir.x * out, y: zone.y + dir.y * out });
  // Backed into a wall or corner? Slide along the zone's edge instead.
  if (dist(spot, zone) < zone.radius + 0.1) {
    spot = clampToArena(state, { x: zone.x - dir.y * out, y: zone.y + dir.x * out });
  }
  return spot;
}

/**
 * Where a unit wants to be right now (null = stay put). This is the positioning brain:
 * role decides the shape of the behaviour, stance shifts how bold or cautious it is.
 */
export function planMove(state: BattleState, unit: Unit): Vec | null {
  if (state.timeMs < unit.stunUntil) return null;
  const enemies = enemiesOf(state, unit);
  const target = chooseTarget(state, unit);
  if (!target || enemies.length === 0) return null;
  unit.targetId = target.id;
  const now = state.timeMs;

  // 1. Sidestep a charging attack, once this fighter has had time to react.
  if (unit.dodge) {
    const zone = enemies.find((e) => e.windup?.id === unit.dodge?.zoneId)?.windup;
    if (!zone) unit.dodge = null;
    else if (now >= unit.dodge.reactAt) {
      return dist(unit, zone) < zone.radius + 0.2 ? escapeZone(state, unit, zone) : null;
    }
  }

  // 2. Sudden death: get inside the ring.
  const ring = currentRing(state);
  if (ring !== null) {
    const c = arenaCentre(state);
    const d = dist(unit, c);
    if (d > ring - 1.2) {
      const limit = Math.max(UNIT_RADIUS, ring - 2.2);
      return { x: c.x + ((unit.x - c.x) / (d || 1)) * limit, y: c.y + ((unit.y - c.y) / (d || 1)) * limit };
    }
  }

  const stance = state.stances[unit.side];
  const allies = alliesOf(state, unit).filter((a) => a.id !== unit.id);
  const nearest = enemies.reduce((n, e) => (dist(unit, e) < dist(unit, n) ? e : n));
  const basicRange = unit.skills[0].range > 0 ? unit.skills[0].range : 2;
  const basicReach = reachOf(basicRange);
  const ranged = basicRange > 3;

  // A queued player cast pulls the unit into range of its target.
  const pend = state.pending.get(unit.id);
  const pendSkill = pend ? unit.skills[pend.skillIndex] : undefined;
  const pendTarget = pend?.targetId ? enemies.find((e) => e.id === pend.targetId) : undefined;
  const aim = pendTarget ?? target;
  const reach = pendSkill && pendSkill.targetRule.startsWith("enemy") && pendSkill.range > 0 ? reachOf(pendSkill.range) : basicReach;

  // 3. The player is steering: go where they said, only breaking off to line up a skill they asked for.
  if (unit.controlled && unit.manual) {
    if (pendSkill && pendSkill.targetRule.startsWith("enemy") && dist(unit, aim) > reach * 0.9) return approach(unit, aim, reach);
    return unit.manualDest && dist(unit, unit.manualDest) > 0.2 ? unit.manualDest : null;
  }

  const fan = fanOffset(state, unit);
  const allyCenter = allies.length ? centroid(allies) : null;
  const nearestDist = dist(unit, nearest);

  // Healers: stay inside heal range of the most hurt ally, keep away from enemies.
  if (unit.role === "healer") {
    const healReach = reachOf(unit.skills.find((s) => s.kind === "heal")?.range || 6);
    const danger = (stance === "defensive" ? 7 : 6) + UNIT_RADIUS * 2;
    if (nearestDist < danger && allies.length > 0) {
      const flee = awayFrom(unit, nearest, 4);
      return keepInRing(state, allyCenter ? { x: flee.x + (allyCenter.x - flee.x) * 0.3, y: flee.y + (allyCenter.y - flee.y) * 0.3 } : flee);
    }
    if (allies.length) {
      const hurt = allies.reduce((l, a) => (hpRatio(a) < hpRatio(l) ? a : l));
      if (dist(unit, hurt) > healReach * 0.8) {
        const k = (healReach * 0.55) / dist(unit, hurt);
        return keepInRing(state, { x: hurt.x + (unit.x - hurt.x) * k, y: hurt.y + (unit.y - hurt.y) * k });
      }
    }
    return keepInRing(state, approach(unit, aim, basicReach, fan));
  }

  // Wounded fighters fall back to the healer. With no healer left there is nowhere to run, so they fight on.
  const retreatAt = RETREAT_HP[stance] * (unit.role === "tank" ? 0.5 : 1);
  if (hpRatio(unit) < retreatAt && nearestDist < 6 + UNIT_RADIUS * 2) {
    const healer = allies.find((a) => a.role === "healer");
    if (healer && dist(unit, healer) > 2 + UNIT_RADIUS * 2) return keepInRing(state, { x: healer.x, y: healer.y });
  }

  // Defensive: hold the line until the enemy commits, then fight.
  if (stance === "defensive" && nearestDist > ENGAGE_DIST + UNIT_RADIUS * 2) return keepInRing(state, holdLine(state, unit));

  // Tanks on defence body-block for the weakest ally.
  if (unit.role === "tank" && stance === "defensive" && allies.length) {
    const weak = allies.reduce((l, a) => (hpRatio(a) < hpRatio(l) ? a : l));
    if (hpRatio(weak) < 0.7) {
      const threat = enemies.reduce((n, e) => (dist(weak, e) < dist(weak, n) ? e : n));
      const d = dist(weak, threat) || 1;
      const guard = { x: weak.x + ((threat.x - weak.x) / d) * (2.5 + UNIT_RADIUS), y: weak.y + ((threat.y - weak.y) / d) * (2.5 + UNIT_RADIUS) };
      return dist(unit, guard) > 1 ? keepInRing(state, guard) : null;
    }
  }

  // Ranged attackers kite: back off when an enemy gets too close, close in when out of range.
  if (ranged) {
    const kite = basicReach * (stance === "defensive" ? 0.55 : stance === "offensive" ? 0.3 : 0.42);
    if (nearestDist < kite) {
      const flee = awayFrom(unit, nearest, 3);
      return keepInRing(state, allyCenter ? { x: flee.x + (allyCenter.x - flee.x) * 0.25, y: flee.y + (allyCenter.y - flee.y) * 0.25 } : flee);
    }
  }

  return keepInRing(state, approach(unit, aim, reach, fan));
}

/** Moves every unit one tick toward its planned position, keeps them apart and inside the arena. */
export function stepMovement(state: BattleState, dtMs: number): BattleEvent | null {
  const living = state.units.filter((u) => u.alive);
  const before = new Map(living.map((u) => [u.id, `${u.x.toFixed(2)},${u.y.toFixed(2)}`]));

  // Everyone plans from the same snapshot, then moves, so neither side gets a first-mover edge.
  const plans = living.map((u) => planMove(state, u));
  for (const [i, u] of living.entries()) {
    const plan = plans[i];
    if (!plan || state.timeMs < u.lockUntil || state.timeMs < u.stunUntil || u.windup) continue;
    const dest = steer(state, u, plan);
    const d = dist(u, dest);
    if (d < 0.05) continue;
    const step = Math.min(d, (moveSpeed(effStat(u, "spd")) * dtMs) / 1000);
    u.x += ((dest.x - u.x) / d) * step;
    u.y += ((dest.y - u.y) / d) * step;
  }

  // Separation: nobody stands inside anybody else. Pushes are summed first and applied together,
  // so list order can't favour one side in a melee scrum. Two passes settle a crowded scrum.
  const minGap = UNIT_RADIUS * 2;
  for (let pass = 0; pass < 2; pass++) {
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
  }
  for (const u of living) {
    pushOutOfObstacles(state, u);
    const c = clampToArena(state, u);
    u.x = c.x;
    u.y = c.y;
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
    let next: Stance =
      diff > (cur === "offensive" ? 0.08 : 0.2) ? "offensive" : diff < (cur === "defensive" ? -0.08 : -0.2) ? "defensive" : "neutral";
    // Nobody turtles once the ring is closing: it is fight or be squeezed out.
    if (state.sudden) next = "offensive";
    if (next !== cur) {
      state.stances[side] = next;
      events.push({ t: state.timeMs, type: "stance", side, stance: next });
    }
  }
  return events;
}
