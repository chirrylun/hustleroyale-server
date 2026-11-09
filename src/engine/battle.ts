import { aiChoose, alive, enemiesOf, isReady, resolveTargets } from "./ai.js";
import { runCommander, stepMovement } from "./movement.js";
import { createRng } from "./rng.js";
import {
  ARENA_H,
  ARENA_W,
  CAST_LOCK_BASIC_MS,
  CAST_LOCK_SPECIAL_MS,
  cooldownMs,
  DAMAGE_VARIANCE,
  effStat,
  energyRegenPerSec,
  healAmount,
  magicalDamage,
  maxEnergy,
  physicalDamage,
  shieldAmount,
} from "./stats.js";
import { STANCES, type BattleEvent, type BattleState, type Intent, type Role, type Side, type Stance, type Unit, type UnitInit } from "./types.js";

export const DEFAULT_MAX_DURATION_MS = 120_000;
const INTENT_TTL_MS = 3000; // long enough for the unit to walk into range

/** How far from its own edge each role starts: tanks up front, healers at the back. */
const START_X: Record<Role, number> = { tank: 7, dps: 5, healer: 3 };

export function createBattle(
  init: UnitInit[],
  seed: number,
  opts: { maxDurationMs?: number; stances?: Partial<Record<Side, Stance>>; autoStance?: Side[] } = {},
): BattleState {
  const rng = createRng(seed);
  const units: Unit[] = init.map((u) => {
    const energyCap = maxEnergy(u.stats.stamina);
    const mates = init.filter((m) => m.side === u.side);
    const row = mates.indexOf(u);
    return {
      ...u,
      // Small seeded jitter so mirrored lineups never tie exactly (and no two games open identically).
      x: (u.side === 1 ? START_X[u.role] : ARENA_W - START_X[u.role]) + (rng.next() - 0.5),
      y: (ARENA_H * (row + 1)) / (mates.length + 1) + (rng.next() - 0.5) * 1.5,
      lockUntil: 0,
      targetId: null,
      hp: u.stats.hp,
      maxHp: u.stats.hp,
      energy: energyCap * 0.5,
      maxEnergy: energyCap,
      shield: 0,
      shieldUntil: 0,
      // Basic attacks start slightly desynced; specials start 30% charged so nobody opens with a nuke.
      cooldowns: u.skills.map((s, i) => (i === 0 ? Math.round(rng.next() * 500) : Math.round(s.cooldownMs * 0.7))),
      mods: [],
      alive: true,
      focusId: null,
    };
  });
  return {
    timeMs: 0,
    tick: 0,
    arena: { w: ARENA_W, h: ARENA_H },
    units,
    rng,
    pending: new Map(),
    stances: { 1: opts.stances?.[1] ?? "neutral", 2: opts.stances?.[2] ?? "neutral" },
    // A side whose player controls a fighter can't also micro-manage stance: the AI commander does it.
    autoSides: new Set<Side>([...(opts.autoStance ?? []), ...init.filter((u) => u.controlled).map((u) => u.side)]),
    nextCommanderMs: 0,
    queued: [],
    maxDurationMs: opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
    finished: false,
    winnerSide: null,
  };
}

/**
 * A player's request for the one unit they control. The server decides if it is legal; the
 * client can never make a unit do something its stats, cooldowns or energy do not allow.
 */
export function submitIntent(state: BattleState, unitId: string, intent: Intent): boolean {
  if (state.finished) return false;
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit || !unit.alive || !unit.controlled) return false;

  if (intent.type === "focus") {
    const target = state.units.find((u) => u.id === intent.targetId);
    if (!target || !target.alive || target.side === unit.side) return false;
    unit.focusId = target.id;
    return true;
  }

  if (!Number.isInteger(intent.skillIndex) || intent.skillIndex < 0 || intent.skillIndex >= unit.skills.length) return false;
  state.pending.set(unit.id, {
    skillIndex: intent.skillIndex,
    targetId: intent.targetId,
    expiresAt: state.timeMs + INTENT_TTL_MS,
  });
  return true;
}

/** A player sets their team's stance. Only allowed when they are spectating (not controlling a fighter). */
export function submitStance(state: BattleState, side: Side, stance: Stance): boolean {
  if (state.finished || !STANCES.includes(stance) || state.autoSides.has(side)) return false;
  if (state.stances[side] !== stance) {
    state.stances[side] = stance;
    state.queued.push({ t: state.timeMs, type: "stance", side, stance });
  }
  return true;
}

function perform(state: BattleState, unit: Unit, skillIndex: number, explicitId: string | undefined, events: BattleEvent[]) {
  const skill = unit.skills[skillIndex];
  const targets = resolveTargets(state, unit, skill, explicitId);
  if (targets.length === 0) return;

  unit.energy -= skill.staminaCost;
  unit.cooldowns[skillIndex] = cooldownMs(skill.cooldownMs, effStat(unit, "spd"));
  unit.lockUntil = state.timeMs + (skillIndex === 0 ? CAST_LOCK_BASIC_MS : CAST_LOCK_SPECIAL_MS);
  const t = state.timeMs;
  events.push({ t, type: "cast", actorId: unit.id, skill: skill.slug, skillIndex, targetIds: targets.map((x) => x.id) });

  for (const target of targets) {
    switch (skill.kind) {
      case "damage": {
        const variance = 1 + (state.rng.next() * 2 - 1) * DAMAGE_VARIANCE;
        const raw =
          skill.damageType === "magical"
            ? magicalDamage(effStat(unit, "magic"), effStat(target, "def"), skill.power)
            : physicalDamage(effStat(unit, "atk"), effStat(target, "def"), skill.power);
        const amount = Math.max(1, Math.round(raw * variance));
        const absorbed = Math.min(target.shield, amount);
        target.shield -= absorbed;
        target.hp = Math.max(0, target.hp - (amount - absorbed));
        events.push({ t, type: "damage", sourceId: unit.id, targetId: target.id, amount, absorbed, hp: target.hp });
        if (target.hp <= 0) {
          target.alive = false;
          state.pending.delete(target.id);
          events.push({ t, type: "death", unitId: target.id });
        }
        break;
      }
      case "heal": {
        const before = target.hp;
        target.hp = Math.min(target.maxHp, target.hp + Math.round(healAmount(effStat(unit, "magic"), skill.power)));
        events.push({ t, type: "heal", sourceId: unit.id, targetId: target.id, amount: target.hp - before, hp: target.hp });
        break;
      }
      case "shield": {
        const amount = Math.round(shieldAmount(effStat(unit, "def"), skill.power));
        target.shield = Math.max(target.shield, amount);
        target.shieldUntil = t + (skill.effect.duration_ms ?? 5000);
        events.push({ t, type: "shield", sourceId: unit.id, targetId: target.id, amount });
        break;
      }
      case "buff":
      case "debuff": {
        const { stat, pct, duration_ms } = skill.effect;
        if (!stat || pct === undefined) break;
        const durationMs = duration_ms ?? 5000;
        target.mods = target.mods.filter((m) => !(m.stat === stat && Math.sign(m.pct) === Math.sign(pct)));
        target.mods.push({ stat, pct, untilMs: t + durationMs });
        events.push({ t, type: "mod", sourceId: unit.id, targetId: target.id, stat, pct, durationMs });
        break;
      }
    }
  }
}

function evaluateEnd(state: BattleState, events: BattleEvent[]) {
  const sides: Side[] = [1, 2];
  const aliveCount = (side: Side) => state.units.filter((u) => u.alive && u.side === side).length;
  const [a, b] = [aliveCount(1), aliveCount(2)];
  let winner: Side | null | undefined;

  if (a === 0 && b === 0) winner = null;
  else if (a === 0) winner = 2;
  else if (b === 0) winner = 1;
  else if (state.timeMs >= state.maxDurationMs) {
    const score = (side: Side) =>
      state.units.filter((u) => u.side === side).reduce((sum, u) => sum + u.hp / u.maxHp, 0);
    const [s1, s2] = sides.map(score);
    winner = s1 > s2 ? 1 : s2 > s1 ? 2 : null;
  }

  if (winner !== undefined) {
    state.finished = true;
    state.winnerSide = winner;
    events.push({ t: state.timeMs, type: "end", winnerSide: winner });
  }
}

/** Advances the battle by dtMs and returns everything that happened. */
export function step(state: BattleState, dtMs: number): BattleEvent[] {
  if (state.finished) return [];
  const events: BattleEvent[] = state.queued.splice(0);
  state.timeMs += dtMs;

  for (const u of state.units) {
    if (!u.alive) continue;
    u.cooldowns = u.cooldowns.map((c) => Math.max(0, c - dtMs));
    u.energy = Math.min(u.maxEnergy, u.energy + (energyRegenPerSec(u.stats.stamina) * dtMs) / 1000);
    u.mods = u.mods.filter((m) => m.untilMs > state.timeMs);
    if (u.shield > 0 && u.shieldUntil <= state.timeMs) u.shield = 0;
  }

  events.push(...runCommander(state));
  const moved = stepMovement(state, dtMs);
  if (moved) events.push(moved);

  // Seeded random act order each tick, so neither side has a built-in first-strike edge.
  const order = [...state.units];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(state.rng.next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const unit of order) {
    if (state.finished) break;
    if (!unit.alive || enemiesOf(state, unit).length === 0) continue;

    const pending = state.pending.get(unit.id);
    if (pending) {
      if (pending.expiresAt < state.timeMs) {
        state.pending.delete(unit.id);
      } else if (
        isReady(unit, pending.skillIndex) &&
        resolveTargets(state, unit, unit.skills[pending.skillIndex], pending.targetId).length > 0
      ) {
        // Ready and in range. If not in range yet, the intent stays queued while the unit walks over.
        state.pending.delete(unit.id);
        perform(state, unit, pending.skillIndex, pending.targetId, events);
        evaluateEnd(state, events);
        continue;
      }
    }

    const choice = aiChoose(state, unit);
    if (choice !== null) {
      perform(state, unit, choice, undefined, events);
      evaluateEnd(state, events);
    }
  }

  state.tick += 1;
  if (!state.finished) evaluateEnd(state, events);
  return events;
}

/** Compact view for a spectator who joins mid-battle. */
export function snapshot(state: BattleState) {
  return {
    timeMs: state.timeMs,
    arena: state.arena,
    stances: state.stances,
    finished: state.finished,
    winnerSide: state.winnerSide,
    units: state.units.map((u) => ({
      id: u.id,
      side: u.side,
      name: u.name,
      role: u.role,
      x: Math.round(u.x * 100) / 100,
      y: Math.round(u.y * 100) / 100,
      hp: u.hp,
      maxHp: u.maxHp,
      energy: Math.round(u.energy),
      maxEnergy: u.maxEnergy,
      shield: u.shield,
      alive: u.alive,
      cooldowns: u.cooldowns.map((c) => Math.round(c)),
    })),
  };
}

export { alive };
