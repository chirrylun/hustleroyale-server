import { aiChoose, alive, dist, enemiesOf, isReady, resolveTargets } from "./ai.js";
import { clampToArena, currentRing, pushOutOfObstacles, runCommander, stepMovement } from "./movement.js";
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
  HARD_CAP_MS,
  healAmount,
  CRIT_MULT,
  KNOCK_LOCK_MS,
  magicalDamage,
  maxEnergy,
  MAX_STUN_MS,
  physicalDamage,
  REGULAR_MS,
  RING_TICK_MS,
  ringDamagePct,
  shieldAmount,
  STUN_IMMUNITY_MS,
  SUDDEN_HEAL_FACTOR,
  SUDDEN_MIN_RADIUS,
  SUDDEN_SHRINK_MS,
  typeMultiplier,
  UNIT_RADIUS,
  WARNING_BEFORE_MS,
} from "./stats.js";
import {
  STANCES,
  type BattleEvent,
  type BattleState,
  type Intent,
  type ModStat,
  type Obstacle,
  type Role,
  type SkillDef,
  type Side,
  type Stance,
  type Unit,
  type UnitInit,
} from "./types.js";

export const DEFAULT_MAX_DURATION_MS = HARD_CAP_MS;
const INTENT_TTL_MS = 3000; // long enough for the unit to walk into range

/** How far from its own edge each role starts: tanks up front, healers at the back. */
const START_X: Record<Role, number> = { tank: 9, dps: 6.5, healer: 4 };

/**
 * Arena layouts. Every one is mirror-symmetric left to right, exactly like the starting lineups,
 * so cover never favours a side. They are in arena units for the default 48 x 24 arena.
 */
const LAYOUTS: { name: string; obstacles: Omit<Obstacle, "id">[] }[] = [
  {
    name: "junction",
    obstacles: [
      { x: 24, y: 12, r: 1.9, kind: "pillar" },
      { x: 24, y: 4.1, r: 1.3, kind: "stall" },
      { x: 24, y: 19.9, r: 1.3, kind: "stall" },
    ],
  },
  {
    name: "gate",
    obstacles: [
      { x: 24, y: 7.6, r: 1.8, kind: "pillar" },
      { x: 24, y: 16.4, r: 1.8, kind: "pillar" },
    ],
  },
  {
    name: "market",
    obstacles: [
      { x: 16.5, y: 6.6, r: 1.4, kind: "stall" },
      { x: 16.5, y: 17.4, r: 1.4, kind: "stall" },
      { x: 31.5, y: 6.6, r: 1.4, kind: "stall" },
      { x: 31.5, y: 17.4, r: 1.4, kind: "stall" },
    ],
  },
];

export interface BattleOptions {
  maxDurationMs?: number;
  stances?: Partial<Record<Side, Stance>>;
  autoStance?: Side[];
  /** Chance (0-1) an AI-driven fighter sidesteps a danger zone, per side. */
  dodge?: Partial<Record<Side, number>>;
  /** Override the match clock (mostly for tests). */
  clock?: Partial<{ regularMs: number; shrinkMs: number; minRadius: number }>;
  /** Pick an obstacle layout by index. Default (-1) = open arena with no obstacles. */
  layout?: number;
}

const MINION_STRIKE: SkillDef = { slug: "minion-strike", kind: "damage", damageType: "physical", power: 1, cooldownMs: 1000, staminaCost: 0, range: 2, targetRule: "enemy_nearest", effect: {} };

/** A summoned minion waits out of the fight (not alive) until its owner calls it. */
export function minionInit(owner: UnitInit): UnitInit {
  return {
    id: `${owner.id}:minion`,
    side: owner.side,
    name: "Skeleton",
    role: "dps",
    stats: { hp: 1, atk: 1, def: 1, spd: 9, stamina: 6, magic: 0 },
    skills: [MINION_STRIKE],
    summonOf: owner.id,
  };
}

export function createBattle(init: UnitInit[], seed: number, opts: BattleOptions = {}): BattleState {
  const rng = createRng(seed);
  // Open arena by default (no cover). Pass `layout` to bring obstacles back.
  const layoutIndex = opts.layout ?? -1;
  const layout = layoutIndex >= 0 ? LAYOUTS[layoutIndex % LAYOUTS.length] : undefined;
  const withMinions = [...init, ...init.filter((u) => u.skills.some((s) => s.effect.summon)).map(minionInit)];
  const units: Unit[] = withMinions.map((u) => {
    const energyCap = maxEnergy(u.stats.stamina);
    const mates = init.filter((m) => m.side === (u.side));
    const row = Math.max(0, mates.indexOf(u));
    return {
      ...u,
      // Small seeded jitter so mirrored lineups never tie exactly (and no two games open identically).
      x: (u.side === 1 ? START_X[u.role] : ARENA_W - START_X[u.role]) + (rng.next() - 0.5),
      y: (ARENA_H * (row + 1)) / (mates.length + 1) + (rng.next() - 0.5) * 1.5,
      lockUntil: 0,
      stunUntil: 0,
      stunImmuneUntil: 0,
      windup: null,
      manual: false,
      manualDest: null,
      dodge: null,
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
      alive: !u.summonOf,
      focusId: null,
      overTime: [],
      evadeHits: 0,
      evadeUntil: 0,
      tauntId: null,
      tauntUntil: 0,
      silenceUntil: 0,
      expiresAt: 0,
    };
  });
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
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
    lastHitMs: 0,
    queued: [],
    obstacles: (layout?.obstacles ?? []).map((o, i) => ({ ...o, id: `ob-${i + 1}` })),
    layout: layout?.name ?? "open",
    clock: {
      regularMs: opts.clock?.regularMs ?? REGULAR_MS,
      shrinkMs: opts.clock?.shrinkMs ?? SUDDEN_SHRINK_MS,
      minRadius: opts.clock?.minRadius ?? SUDDEN_MIN_RADIUS,
    },
    warned: false,
    sudden: false,
    nextRingTickMs: 0,
    zoneSeq: 0,
    dodgeChance: { 1: opts.dodge?.[1] ?? 0.55, 2: opts.dodge?.[2] ?? 0.55 },
    maxDurationMs,
    finished: false,
    winnerSide: null,
    lastRegenMs: 0,
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

  if (intent.type === "move") {
    if (!Number.isFinite(intent.x) || !Number.isFinite(intent.y)) return false;
    unit.manual = true;
    const spot = clampToArena(state, intent);
    pushOutOfObstacles(state, spot);
    unit.manualDest = spot;
    return true;
  }

  if (intent.type === "auto") {
    unit.manual = false;
    unit.manualDest = null;
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

function kill(state: BattleState, target: Unit, events: BattleEvent[]) {
  target.alive = false;
  state.pending.delete(target.id);
  if (target.windup) {
    events.push({ t: state.timeMs, type: "interrupt", unitId: target.id, id: target.windup.id });
    target.windup = null;
  }
  events.push({ t: state.timeMs, type: "death", unitId: target.id });
}

/** Stuns a unit and cancels any attack it was charging. Returns false if it is still immune from a recent stun. */
function stun(state: BattleState, source: Unit, target: Unit, ms: number, events: BattleEvent[]): boolean {
  const t = state.timeMs;
  if (!target.alive || t < target.stunImmuneUntil) return false;
  const duration = Math.min(MAX_STUN_MS, ms);
  target.stunUntil = t + duration;
  target.stunImmuneUntil = target.stunUntil + STUN_IMMUNITY_MS;
  state.pending.delete(target.id);
  events.push({ t, type: "stun", sourceId: source.id, targetId: target.id, durationMs: duration });
  if (target.windup) {
    events.push({ t, type: "interrupt", unitId: target.id, id: target.windup.id });
    target.windup = null;
  }
  return true;
}

/** Shoves (positive) or yanks (negative) a unit along the line from `from`, stopping at walls and cover. */
function displace(state: BattleState, target: Unit, from: { x: number; y: number }, amount: number, events: BattleEvent[]) {
  const d = dist(from, target) || 0.001;
  const dir = d < 0.01 ? { x: target.side === 1 ? -1 : 1, y: 0 } : { x: (target.x - from.x) / d, y: (target.y - from.y) / d };
  // A pull never carries the target through the puller: it stops just outside body contact.
  const travel = amount >= 0 ? amount : -Math.min(-amount, Math.max(0, d - (UNIT_RADIUS * 2 + 0.2)));
  if (Math.abs(travel) < 0.05) return;
  const fromX = target.x;
  const fromY = target.y;
  const to = clampToArena(state, { x: target.x + dir.x * travel, y: target.y + dir.y * travel });
  target.x = to.x;
  target.y = to.y;
  pushOutOfObstacles(state, target);
  target.lockUntil = Math.max(target.lockUntil, state.timeMs + KNOCK_LOCK_MS);
  events.push({
    t: state.timeMs,
    type: "displace",
    unitId: target.id,
    x: Math.round(target.x * 100) / 100,
    y: Math.round(target.y * 100) / 100,
    fromX: Math.round(fromX * 100) / 100,
    fromY: Math.round(fromY * 100) / 100,
  });
}

/**
 * One hit of damage, whether from a skill or from damage over time. Handles dodges, the rarity
 * passives (crit, resist, thorns, lifesteal) and the shield. Returns the damage dealt, or null if
 * the target dodged it. The target dying is handled here.
 */
function dealDamage(
  state: BattleState,
  source: Unit,
  target: Unit,
  damageType: "physical" | "magical",
  power: number,
  events: BattleEvent[],
  opts: { dot?: boolean; lifesteal?: number; bonus?: { below: number; pct: number } } = {},
): number | null {
  const t = state.timeMs;
  if (!opts.dot && target.evadeHits > 0 && t < target.evadeUntil) {
    target.evadeHits -= 1;
    events.push({ t, type: "evade", sourceId: source.id, targetId: target.id });
    return null;
  }
  const variance = 1 + (state.rng.next() * 2 - 1) * DAMAGE_VARIANCE;
  const raw =
    damageType === "magical"
      ? magicalDamage(effStat(source, "magic"), effStat(target, "def"), power)
      : physicalDamage(effStat(source, "atk"), effStat(target, "def"), power);
  const mult = typeMultiplier(target.role, damageType);
  let amount = raw * variance * mult;
  if (opts.bonus && target.hp / target.maxHp < opts.bonus.below) amount *= 1 + opts.bonus.pct / 100;
  let crit = false;
  if (!opts.dot && source.passive?.type === "crit" && state.rng.next() < source.passive.value) {
    amount *= CRIT_MULT;
    crit = true;
  }
  if (target.passive?.type === "resist") amount *= 1 - target.passive.value;
  amount = Math.max(1, Math.round(amount));
  const absorbed = Math.min(target.shield, amount);
  target.shield -= absorbed;
  target.hp = Math.max(0, target.hp - (amount - absorbed));
  events.push({
    t, type: "damage", sourceId: source.id, targetId: target.id, amount, absorbed, hp: target.hp,
    ...(mult !== 1 ? { mult } : {}), ...(opts.dot ? { dot: true } : {}), ...(crit ? { crit: true } : {}),
  });

  const steal = (opts.lifesteal ?? 0) + (source.passive?.type === "lifesteal" ? source.passive.value : 0);
  if (steal > 0 && source.alive) healUnit(state, source, source, Math.round(amount * steal), events, true);
  const thorns = target.passive?.type === "thorns" ? target.passive.value : 0;
  if (thorns > 0 && !opts.dot && source.alive && target.hp > 0 && source.side !== target.side) {
    const back = Math.max(1, Math.round(amount * thorns));
    source.hp = Math.max(0, source.hp - back);
    events.push({ t, type: "damage", sourceId: target.id, targetId: source.id, amount: back, absorbed: 0, hp: source.hp, dot: true });
    if (source.hp <= 0) kill(state, source, events);
  }
  if (target.hp <= 0) kill(state, target, events);
  return amount;
}

function healUnit(state: BattleState, source: Unit, target: Unit, amount: number, events: BattleEvent[], quiet = false) {
  const before = target.hp;
  target.hp = Math.min(target.maxHp, target.hp + Math.round(amount * (state.sudden ? SUDDEN_HEAL_FACTOR : 1)));
  if (target.hp > before) events.push({ t: state.timeMs, type: "heal", sourceId: source.id, targetId: target.id, amount: target.hp - before, hp: target.hp, ...(quiet ? { quiet: true } : {}) });
}

function addMod(state: BattleState, source: Unit, target: Unit, stat: ModStat, pct: number, durationMs: number, events: BattleEvent[]) {
  const t = state.timeMs;
  target.mods = target.mods.filter((m) => !(m.stat === stat && Math.sign(m.pct) === Math.sign(pct)));
  target.mods.push({ stat, pct, untilMs: t + durationMs });
  events.push({ t, type: "mod", sourceId: source.id, targetId: target.id, stat, pct, durationMs });
}

/** One skill's effect on one target. Used both for instant skills and when a danger zone lands. */
function applyEffect(state: BattleState, unit: Unit, skill: SkillDef, target: Unit, events: BattleEvent[]) {
  const t = state.timeMs;
  const fx = skill.effect;
  switch (skill.kind) {
    case "damage": {
      if (skill.damageType === "none") break;
      const dealt = dealDamage(state, unit, target, skill.damageType, skill.power, events, { lifesteal: fx.lifesteal, bonus: fx.bonus_low_hp });
      if (dealt === null || !target.alive) return;
      break;
    }
    case "heal": {
      healUnit(state, unit, target, healAmount(effStat(unit, "magic"), skill.power), events);
      break;
    }
    case "shield": {
      const amount = Math.round(shieldAmount(effStat(unit, "def"), skill.power));
      target.shield = Math.max(target.shield, amount);
      target.shieldUntil = t + (fx.duration_ms ?? 5000);
      events.push({ t, type: "shield", sourceId: unit.id, targetId: target.id, amount });
      break;
    }
    case "buff":
    case "debuff": {
      const list = fx.mods ?? (fx.stat && fx.pct !== undefined ? [{ stat: fx.stat, pct: fx.pct }] : []);
      for (const m of list) addMod(state, unit, target, m.stat, m.pct, fx.duration_ms ?? 5000, events);
      if (fx.evade_hits) {
        target.evadeHits = fx.evade_hits;
        target.evadeUntil = t + (fx.evade_ms ?? 3000);
      }
      break;
    }
  }

  if (fx.cleanse && target.alive) {
    target.mods = target.mods.filter((m) => m.pct >= 0);
    target.overTime = target.overTime.filter((o) => o.kind !== "dot");
    target.silenceUntil = 0;
    events.push({ t, type: "cleanse", targetId: target.id });
  }
  const over = fx.dot ?? fx.hot;
  if (over && target.alive) {
    const kind = fx.dot ? "dot" : "hot";
    target.overTime = target.overTime.filter((o) => !(o.slug === skill.slug && o.sourceId === unit.id));
    const interval = over.interval_ms ?? 1000;
    target.overTime.push({ sourceId: unit.id, kind, damageType: skill.damageType === "none" ? "magical" : skill.damageType, power: over.power, intervalMs: interval, nextMs: t + interval, untilMs: t + over.duration_ms, slug: skill.slug });
  }

  // Crowd control only ever lands on enemies.
  if (target.side === unit.side || !target.alive) return;
  const { stun_ms, knockback, pull, taunt_ms, silence_ms } = fx;
  if (taunt_ms) {
    target.tauntId = unit.id;
    target.tauntUntil = t + taunt_ms;
  }
  if (silence_ms) target.silenceUntil = t + silence_ms;
  if (stun_ms) stun(state, unit, target, stun_ms, events);
  if (knockback) displace(state, target, unit, knockback, events);
  else if (pull) displace(state, target, unit, -pull, events);
}

/** Ticks damage and healing over time, and retires summoned minions whose time is up. */
function runOverTime(state: BattleState, events: BattleEvent[]) {
  const t = state.timeMs;
  for (const u of state.units) {
    if (!u.alive) continue;
    if (u.expiresAt > 0 && t >= u.expiresAt) {
      u.hp = 0;
      kill(state, u, events);
      continue;
    }
    if (u.passive?.type === "regen" && u.hp < u.maxHp) healUnit(state, u, u, Math.max(1, Math.round(u.maxHp * u.passive.value)), events, true);
  }
}

function tickOverTime(state: BattleState, events: BattleEvent[]) {
  const t = state.timeMs;
  for (const u of state.units) {
    if (!u.alive || u.overTime.length === 0) continue;
    for (const o of [...u.overTime]) {
      while (u.alive && o.nextMs <= t && o.nextMs <= o.untilMs) {
        o.nextMs += o.intervalMs;
        const src = state.units.find((x) => x.id === o.sourceId);
        if (!src) continue;
        if (o.kind === "dot") dealDamage(state, src, u, o.damageType === "none" ? "magical" : o.damageType, o.power, events, { dot: true });
        else healUnit(state, src, u, healAmount(effStat(src, "magic"), o.power), events, true);
      }
    }
    u.overTime = u.overTime.filter((o) => o.untilMs > t);
  }
}

/** Calls a dormant minion onto the field next to its owner. */
function summonMinion(state: BattleState, owner: Unit, skill: SkillDef, events: BattleEvent[]) {
  const cfg = skill.effect.summon;
  const m = state.units.find((u) => u.summonOf === owner.id && !u.alive);
  if (!cfg || !m) return;
  const hp = Math.max(10, Math.round(owner.maxHp * cfg.hp_pct));
  const atk = Math.max(6, Math.round(Math.max(owner.stats.magic, owner.stats.atk) * cfg.atk_pct));
  m.stats = { ...m.stats, hp, atk, def: Math.round(owner.stats.def * 0.7) };
  m.hp = m.maxHp = hp;
  m.shield = 0;
  m.mods = [];
  m.overTime = [];
  m.stunUntil = 0;
  m.windup = null;
  m.cooldowns = m.skills.map(() => 0);
  const spot = clampToArena(state, { x: owner.x + (owner.side === 1 ? 2.4 : -2.4), y: owner.y + (state.rng.next() - 0.5) * 3 });
  m.x = spot.x;
  m.y = spot.y;
  m.alive = true;
  m.expiresAt = state.timeMs + cfg.duration_ms;
  events.push({ t: state.timeMs, type: "summon", ownerId: owner.id, unitId: m.id, x: round2(m.x), y: round2(m.y) });
}

/** A big attack starts charging: show the danger zone, root the caster, and let the AI react. */
function beginWindup(state: BattleState, unit: Unit, skillIndex: number, aimAt: Unit, events: BattleEvent[]) {
  const skill = unit.skills[skillIndex];
  const t = state.timeMs;
  const ms = skill.effect.telegraph_ms ?? 1000;
  const radius = skill.effect.radius ?? 2.5;
  const id = ++state.zoneSeq;

  unit.energy -= skill.staminaCost;
  unit.cooldowns[skillIndex] = cooldownMs(skill.cooldownMs, effStat(unit, "spd"));
  unit.windup = { id, skillIndex, x: aimAt.x, y: aimAt.y, radius, startedAt: t, resolveAt: t + ms };
  unit.lockUntil = t + ms + CAST_LOCK_SPECIAL_MS;
  events.push({ t, type: "telegraph", id, actorId: unit.id, skill: skill.slug, skillIndex, x: round2(aimAt.x), y: round2(aimAt.y), radius, durationMs: ms });

  // AI fighters inside the zone may decide to step out. Players steering by hand have to do it themselves.
  for (const foe of enemiesOf(state, unit)) {
    if (foe.controlled && foe.manual) continue;
    if (state.rng.next() < state.dodgeChance[foe.side]) foe.dodge = { zoneId: id, reactAt: t + 250 + Math.round(state.rng.next() * 250) };
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The charge finishes: everyone still standing in the zone is hit. */
function resolveWindup(state: BattleState, unit: Unit, events: BattleEvent[]) {
  const w = unit.windup;
  if (!w) return;
  unit.windup = null;
  const skill = unit.skills[w.skillIndex];
  const t = state.timeMs;
  // What you see is what hits: a fighter is caught if their centre is inside the drawn circle.
  const hit = enemiesOf(state, unit).filter((e) => dist(e, w) <= w.radius);
  for (const u of state.units) if (u.dodge?.zoneId === w.id) u.dodge = null;

  events.push({ t, type: "burst", id: w.id, actorId: unit.id, x: round2(w.x), y: round2(w.y), radius: w.radius });
  events.push({ t, type: "cast", actorId: unit.id, skill: skill.slug, skillIndex: w.skillIndex, targetIds: hit.map((h) => h.id) });
  for (const target of hit) applyEffect(state, unit, skill, target, events);
}

function perform(state: BattleState, unit: Unit, skillIndex: number, explicitId: string | undefined, events: BattleEvent[]) {
  const skill = unit.skills[skillIndex];
  const targets = resolveTargets(state, unit, skill, explicitId);
  if (targets.length === 0) return;

  if (skill.kind === "damage" && skill.effect.telegraph_ms) {
    beginWindup(state, unit, skillIndex, targets[0], events);
    return;
  }

  unit.energy -= skill.staminaCost;
  unit.cooldowns[skillIndex] = cooldownMs(skill.cooldownMs, effStat(unit, "spd"));
  unit.lockUntil = state.timeMs + (skillIndex === 0 ? CAST_LOCK_BASIC_MS : CAST_LOCK_SPECIAL_MS);
  events.push({ t: state.timeMs, type: "cast", actorId: unit.id, skill: skill.slug, skillIndex, targetIds: targets.map((x) => x.id) });
  if (skill.effect.summon) summonMinion(state, unit, skill, events);
  else for (const target of targets) applyEffect(state, unit, skill, target, events);
}

/** Warning, then sudden death: a closing ring that hurts anyone caught outside it. */
function runSuddenDeath(state: BattleState, events: BattleEvent[]) {
  const t = state.timeMs;
  const { regularMs, shrinkMs } = state.clock;
  if (!state.warned && t >= regularMs - WARNING_BEFORE_MS) {
    state.warned = true;
    events.push({ t, type: "phase", phase: "warning" });
  }
  if (!state.sudden && t >= regularMs) {
    state.sudden = true;
    state.nextRingTickMs = t + RING_TICK_MS;
    events.push({ t, type: "phase", phase: "sudden_death" });
  }
  if (!state.sudden || t < state.nextRingTickMs) return;
  state.nextRingTickMs += RING_TICK_MS;

  const ring = currentRing(state) ?? 0;
  const progress = (t - regularMs) / shrinkMs;
  const centre = { x: state.arena.w / 2, y: state.arena.h / 2 };
  for (const u of state.units) {
    if (!u.alive || dist(u, centre) <= ring) continue;
    const amount = Math.max(1, Math.round(u.maxHp * ringDamagePct(progress)));
    u.hp = Math.max(0, u.hp - amount);
    events.push({ t, type: "damage", sourceId: "ring", targetId: u.id, amount, absorbed: 0, hp: u.hp, ring: true });
    if (u.hp <= 0) kill(state, u, events);
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
      state.units.filter((u) => u.side === side && !u.summonOf).reduce((sum, u) => sum + u.hp / u.maxHp, 0);
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
    const boost = u.passive?.type === "energy" ? 1 + u.passive.value : 1;
    u.energy = Math.min(u.maxEnergy, u.energy + (energyRegenPerSec(u.stats.stamina) * boost * dtMs) / 1000);
    u.mods = u.mods.filter((m) => m.untilMs > state.timeMs);
    if (u.shield > 0 && u.shieldUntil <= state.timeMs) u.shield = 0;
  }

  tickOverTime(state, events);
  if (state.timeMs - state.lastRegenMs >= 1000) {
    state.lastRegenMs = state.timeMs;
    runOverTime(state, events);
  }
  runSuddenDeath(state, events);
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

    // Big attacks land when their charge ends, unless the caster was stunned or killed first.
    if (unit.windup) {
      if (state.timeMs >= unit.windup.resolveAt) {
        resolveWindup(state, unit, events);
        evaluateEnd(state, events);
      }
      continue;
    }
    if (state.timeMs < unit.stunUntil) continue;

    const pending = state.pending.get(unit.id);
    if (pending) {
      if (pending.expiresAt < state.timeMs) {
        state.pending.delete(unit.id);
      } else if (pending.skillIndex > 0 && state.timeMs < unit.silenceUntil) {
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

  if (events.some((e) => e.type === "damage" && !(e as { ring?: boolean }).ring)) state.lastHitMs = state.timeMs;
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
    layout: state.layout,
    obstacles: state.obstacles.map((o) => ({ id: o.id, x: o.x, y: o.y, r: o.r, kind: o.kind })),
    clock: { regularMs: state.clock.regularMs, shrinkMs: state.clock.shrinkMs, minRadius: state.clock.minRadius, capMs: state.maxDurationMs },
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
      stunMs: Math.max(0, Math.round(u.stunUntil - state.timeMs)),
      manual: u.manual,
      windup: u.windup
        ? { id: u.windup.id, x: round2(u.windup.x), y: round2(u.windup.y), radius: u.windup.radius, remainingMs: Math.max(0, Math.round(u.windup.resolveAt - state.timeMs)), totalMs: Math.round(u.windup.resolveAt - u.windup.startedAt) }
        : null,
      cooldowns: u.cooldowns.map((c) => Math.round(c)),
    })),
  };
}

export { alive };
