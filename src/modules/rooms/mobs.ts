import { hitDamage, type MobSpec } from "../../world/floor.js";
import { findPath, nearestWalkable, standable, walkable, type Nav, type Pt } from "../../world/guild-nav.js";

/*
 * Server-side monsters. The behaviour mirrors what used to run in the browser (FloorScreen.tsx): ambling about home,
 * noticing a fighter by the floor's temper, chasing within a leash, giving up, and hitting. Keep the numbers in step.
 */
export const ZOOM = 1.45; // src/lib/world/zoom.ts
const MOB_SPEED = 2.3;
const LEASH = 14;
const WANDER: Record<string, { speed: number; rest: [number, number] }> = {
  slime: { speed: 0.7, rest: [2, 6] }, bat: { speed: 1.7, rest: [0.4, 1.6] }, mushroom: { speed: 0.6, rest: [3, 7] },
  goblin: { speed: 1.1, rest: [1.5, 5] }, boar: { speed: 1.3, rest: [1, 4] }, weaver: { speed: 1.0, rest: [1.5, 5] }, wisp: { speed: 1.2, rest: [0.6, 2.5] }, beetle: { speed: 0.6, rest: [3, 7] }, slimeking: { speed: 0.8, rest: [2, 5] }, broodmother: { speed: 0.9, rest: [2, 5] }, rimewarden: { speed: 0.9, rest: [2, 5] }, direwolf: { speed: 1.5, rest: [1, 4] }, golem: { speed: 0.5, rest: [3, 8] },
};
const TEMPER: Record<string, number> = { slime: 0.5, mushroom: 0.5, golem: 0.8, goblin: 1.1, bat: 1.2, direwolf: 1.4, boar: 1.2, weaver: 0.9, wisp: 1.0, beetle: 0.6, slimeking: 1, broodmother: 1, rimewarden: 1 };
export const aggroRange = (floor: number, kind: string, boss: boolean) => {
  if (boss || kind === "slimeking" || kind === "broodmother" || kind === "rimewarden") return 6;
  const base = floor <= 2 ? 0 : floor <= 10 ? 1.5 + (floor - 3) * 0.35 : Math.min(6.5, 4 + (floor - 11) * 0.1);
  return base * (TEMPER[kind] ?? 1);
};
export const chaseRange = (floor: number, boss: boolean) => (boss ? LEASH : Math.min(LEASH, 3 + 0.3 * floor));
export const loseRange = (floor: number, boss: boolean) => (boss ? 14 : 4 + 0.2 * floor);

/** How many mobs a floor holds at once and how often a new one walks in, for `players` on it (same formula as the web's spawnPlan). */
export function spawnPlan(base: number, players: number) {
  const k = 1 + 0.5 * (Math.max(1, players) - 1);
  return { cap: Math.round(base * k), gapMs: [7000 / k, 12000 / k] as [number, number], afterKillMs: [6000 / k, 10000 / k] as [number, number] };
}
/** A boss has more health the more people fight it. */
export const bossScale = (players: number) => 1 + 0.6 * (Math.max(1, players) - 1);

export interface Ally {
  id: string; uid: string;
  x: number; y: number;
  max: number; def: number; level?: number;
  /** 0-1 health as the owner last reported it (and as hits since then have lowered it). */
  frac: number;
  dead: boolean;
}

export interface Mob {
  id: number; kind: string; rarity: string; sprite: string; level: number; boss: boolean; mini: boolean;
  x: number; y: number; hp: number; max: number; atk: number; def: number;
  home: [number, number, number];
  baseMax: number;
  target: string | null; provoked: boolean;
  path: Pt[]; repath: number; cd: number; wanderAt: number; speedMul: number;
  born: number; dead: boolean; deadAt: number;
  /** Players who hurt it: they share the kill. */
  credit: Set<string>;
  dirty: boolean;
  /** Bumped on each swing so clients can play the attack animation. */
  swings: number;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export function makeMob(id: number, s: Omit<MobSpec, "id">, nav: Nav, home: [number, number, number], now: number, hpMul = 1): Mob {
  const [x, y] = nearestWalkable(nav, s.x, s.y);
  const hp = Math.round(s.hp * hpMul);
  return {
    id, kind: s.kind, rarity: s.rarity, sprite: s.sprite, level: s.level, boss: s.boss, mini: !!s.mini, x, y, hp, max: hp, baseMax: s.hp, atk: s.atk, def: s.def,
    home: s.boss ? [x, y, 1.5] : home, target: null, provoked: false, path: [], repath: 0, cd: 1, wanderAt: now + rnd(0, 3000), speedMul: rnd(0.9, 1.1),
    born: now, dead: false, deadAt: 0, credit: new Set(), dirty: true, swings: 0,
  };
}

export interface MobCtx {
  floor: number;
  nav: Nav;
  allies: Ally[];
  /** A mob swings at an ally for `dmg`. */
  hit(m: Mob, a: Ally, dmg: number): void;
}

function step(m: Mob, dt: number, speed: number): boolean {
  const p = m.path[0];
  if (!p) return false;
  const dx = p[0] - m.x, dy = p[1] - m.y, d = Math.hypot(dx, dy), mv = (speed * dt) / ZOOM;
  if (d <= mv) { m.x = p[0]; m.y = p[1]; m.path.shift(); } else { m.x += (dx / d) * mv; m.y += (dy / d) * mv; }
  m.dirty = true;
  return true;
}

export function tickMob(m: Mob, dt: number, now: number, ctx: MobCtx) {
  if (m.dead) return;
  m.cd = Math.max(0, m.cd - dt);
  m.repath -= dt;
  if (now - m.born < 900) return; // just arrived
  const live = ctx.allies.filter((a) => !a.dead);
  let target = m.target ? live.find((a) => a.id === m.target) ?? null : null;
  if (m.target && (!target || Math.hypot(m.x - m.home[0], m.y - m.home[1]) > chaseRange(ctx.floor, m.boss) || dist(m, target) > loseRange(ctx.floor, m.boss))) {
    target = null; m.target = null; m.provoked = false; m.path = []; m.wanderAt = now + 600; // gives up and heads home
  }
  if (!target) {
    let best = m.provoked ? Infinity : aggroRange(ctx.floor, m.kind, m.boss);
    for (const a of live) { const d = dist(m, a); if (d < best) { best = d; target = a; } }
    if (target) { m.target = target.id; m.path = []; }
  }
  if (!target) {
    const w = WANDER[m.kind] ?? WANDER.slime;
    if (m.path.length) step(m, dt, w.speed * m.speedMul);
    else if (m.wanderAt === Infinity) m.wanderAt = now + rnd(w.rest[0], w.rest[1]) * 1000;
    else if (now >= m.wanderAt) {
      const rad = m.home[2] * 0.85, ang = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * rad;
      const to = nearestWalkable(ctx.nav, m.home[0] + Math.cos(ang) * d, m.home[1] + Math.sin(ang) * d * 0.7);
      m.path = findPath(ctx.nav, [m.x, m.y], to);
      m.wanderAt = m.path.length ? Infinity : now + 2000;
    }
    return;
  }
  if (dist(m, target) > 1.3 / ZOOM) {
    if (m.repath <= 0 || !m.path.length) {
      const ang = Math.atan2(m.y - target.y, m.x - target.x);
      m.path = findPath(ctx.nav, [m.x, m.y], [target.x + Math.cos(ang) * 0.95, target.y + Math.sin(ang) * 0.95]);
      m.repath = 0.6;
    }
    step(m, dt, MOB_SPEED * m.speedMul);
  } else {
    m.path = [];
    if (m.cd <= 0) {
      m.cd = 1.3;
      m.swings++; m.dirty = true;
      ctx.hit(m, target, hitDamage(m.atk, target.def, target.level ?? m.level, 0.9 + Math.random() * 0.2));
    }
  }
}

/** A walkable patch of a zone far enough from every fighter, or null when nowhere suits. */
export function pickSpawn(zones: [number, number, number][], nav: Nav, allies: Ally[], mobs: Mob[]): { at: Pt; home: [number, number, number] } | null {
  if (!zones.length) return null;
  for (let n = 0; n < 14; n++) {
    const z = zones[Math.floor(Math.random() * zones.length)];
    const ang = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * Math.max(0.6, z[2] - 1);
    const x = z[0] + Math.cos(ang) * d, y = z[1] + Math.sin(ang) * d * 0.7;
    if (!standable(nav, x, y)) continue;
    const away = n < 9 ? 10 : 6;
    if (allies.some((a) => !a.dead && dist(a, { x, y }) < away)) continue;
    if (mobs.some((f) => !f.dead && Math.hypot(f.x - x, f.y - y) < 1.6)) continue;
    return { at: [x, y], home: [z[0], z[1], z[2]] };
  }
  return null;
}
