import type { Floor, MobSpec } from "../../world/floor.js";
import { baseMobCount, rollGroup, miniFor, miniStats, MINI_APPEAR_MS, MINI_COOLDOWN_MS, MINI_LEVEL } from "../../world/floor.js";
import { nearestWalkable, type Nav } from "../../world/guild-nav.js";
import { bossScale, makeMob, pickSpawn, spawnPlan, tickMob, type Ally, type Mob } from "./mobs.js";

export const ROOM_SIZE = 4;
const CORPSE_MS = 2500;
const EMPTY_MS = 15_000;

export interface FighterInfo { id: string; sprite: string; name: string; role: string; level: number; max: number; atk: number; magic: number; def: number; frac: number }
export interface Member { uid: string; name: string; fighters: Map<string, Ally>; info: FighterInfo[]; buckets: Map<string, { tokens: number; at: number }>; dirty: boolean }

/** What a room tells its members; the manager turns these into socket messages. */
export interface RoomOut {
  toRoom(event: string, payload: unknown): void;
  toUser(uid: string, event: string, payload: unknown): void;
  /** A mob died: pay the players who hurt it (and their parties). `credit` is the damage each of them did. */
  kill(credit: ReadonlyMap<string, number>, mob: Mob): void;
}

export interface Hit { m: number; f: string; d: number }

/** Anything players can be placed in: a floor room or the lobby. */
export interface Place {
  readonly id: string;
  readonly code: string;
  readonly floor: number;
  readonly cap: number;
  readonly size: number;
  readonly full: boolean;
  readonly members: Map<string, Member>;
  expired(now: number): boolean;
  join(m: Member, now?: number): void;
  leave(uid: string, now?: number): void;
  report(uid: string, p: [string, number, number, number, number][]): void;
  attack(uid: string, hits: Hit[], now?: number): void;
  tick(now: number, dt: number): void;
  snapshot(): { mobs: unknown[]; players: { uid: string; name: string; fighters: unknown[] }[] };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export const mobWire = (m: Mob) => ({ id: m.id, kind: m.kind, rarity: m.rarity, sprite: m.sprite, level: m.level, boss: m.boss, mini: m.mini, x: r2(m.x), y: r2(m.y), hp: m.hp, max: m.max, home: m.home });

/**
 * One shared copy of a floor. The server owns the monsters here: it spawns them (more of them the more players are
 * in the room), moves them, lets them hit fighters, takes the damage fighters report (checked against their stats)
 * and decides when a mob dies and who is paid for it.
 */
export class Room implements Place {
  readonly cap = ROOM_SIZE;
  readonly members = new Map<string, Member>();
  readonly mobs = new Map<number, Mob>();
  private nextId = 0;
  private nextSpawn = 0;
  private nextMini = 0;
  private nextGrp = 1000;
  /** Mobs created outside the spawn step (slime splits), sent with the next snapshot. */
  private added: ReturnType<typeof mobWire>[] = [];
  private emptySince: number | null = null;
  private readonly baseCount: number;

  constructor(readonly id: string, readonly code: string, readonly floor: number, private readonly world: Floor, private readonly nav: Nav, private readonly out: RoomOut, now = Date.now(), readonly seed = 0) {
    this.baseCount = world.mobs.filter((m) => !m.boss).length || baseMobCount(floor);
    for (const s of world.mobs) this.addMob(s, now, s.boss ? 1 : 1);
    this.nextSpawn = now + 8000;
    this.nextMini = now + this.miniGap();
  }

  private miniGap() { return MINI_APPEAR_MS[0] + Math.random() * (MINI_APPEAR_MS[1] - MINI_APPEAR_MS[0]); }

  get size() { return this.members.size; }
  get full() { return this.members.size >= ROOM_SIZE; }
  get idleSince() { return this.emptySince; }
  expired(now: number) { return this.emptySince !== null && now - this.emptySince > EMPTY_MS; }

  private zoneOf(x: number, y: number): [number, number, number] {
    let best = this.world.zones[0] ?? [x, y, 2], bd = Infinity;
    for (const z of this.world.zones) { const d = Math.hypot(z[0] - x, z[1] - y); if (d < bd) { bd = d; best = z; } }
    return best as [number, number, number];
  }

  private addMob(s: Omit<MobSpec, "id">, now: number, hpMul = 1, home?: [number, number, number]): Mob {
    const m = makeMob(this.nextId++, s, this.nav, home ?? this.zoneOf(s.x, s.y), now, s.boss || s.mini ? bossScale(Math.max(1, this.size)) * hpMul : hpMul);
    this.mobs.set(m.id, m);
    return m;
  }

  allies(): Ally[] { const out: Ally[] = []; for (const m of this.members.values()) for (const a of m.fighters.values()) out.push(a); return out; }

  join(m: Member, now = Date.now()) {
    this.members.set(m.uid, m);
    this.emptySince = null;
    this.rescaleBosses();
    this.nextSpawn = Math.min(this.nextSpawn, now + 3000); // the extra mobs for the newcomer start arriving soon
  }

  leave(uid: string, now = Date.now()) {
    this.members.delete(uid);
    if (!this.members.size) this.emptySince = now;
    this.rescaleBosses();
  }

  /** Boss health follows the head count, keeping the share of health it has left. */
  private rescaleBosses() {
    for (const b of this.mobs.values()) {
      if (!(b.boss || b.mini) || b.dead) continue;
      const frac = b.hp / b.max;
      b.max = Math.round(b.baseMax * bossScale(Math.max(1, this.size)));
      b.hp = Math.max(1, Math.round(b.max * frac));
      b.dirty = true;
    }
  }

  /** Where the owner says its fighters are and how they are doing. */
  report(uid: string, p: [string, number, number, number, number][]) {
    const mem = this.members.get(uid);
    if (!mem) return;
    for (const [id, x, y, frac, dead] of p) {
      const a = mem.fighters.get(id);
      if (!a) continue;
      a.x = x; a.y = y; a.frac = Math.max(0, Math.min(1, frac)); a.dead = !!dead || a.frac <= 0;
    }
    mem.dirty = true;
  }

  /** Damage a player's fighters report having dealt. Checked against the fighter's stats and a rate limit. */
  attack(uid: string, hits: Hit[], now = Date.now()) {
    const mem = this.members.get(uid);
    if (!mem) return;
    for (const h of hits) {
      const a = mem.fighters.get(h.f), mob = this.mobs.get(h.m), info = mem.info.find((i) => i.id === h.f);
      if (!a || !mob || !info || mob.dead || a.dead) continue;
      if (Math.hypot(a.x - mob.x, a.y - mob.y) > 10) continue; // out of reach
      if (!Number.isFinite(h.d) || h.d < 1 || h.d > Math.max(info.atk, info.magic) * 4 + 12) continue;
      const b = mem.buckets.get(h.f) ?? { tokens: 8, at: now };
      b.tokens = Math.min(8, b.tokens + ((now - b.at) / 1000) * 3.5); b.at = now;
      if (b.tokens < 1) continue;
      b.tokens--;
      mem.buckets.set(h.f, b);
      mob.hp = Math.max(0, mob.hp - Math.round(h.d));
      mob.credit.set(uid, (mob.credit.get(uid) ?? 0) + Math.round(h.d));
      mob.provoked = true;
      if (!mob.target || !this.allies().some((x) => x.id === mob.target && !x.dead)) { mob.target = a.id; mob.path = []; }
      this.alert(mob, a);
      mob.dirty = true;
      if (mob.hp <= 0) this.die(mob, now);
    }
  }

  /** Packmates (same pack id) pile in on whoever the mob is fighting. */
  private alert(m: Mob, target: Ally) {
    if (m.grp === undefined) return;
    for (const o of this.mobs.values()) {
      if (o === m || o.dead || o.grp !== m.grp || o.target) continue;
      o.target = target.id; o.provoked = true; o.path = []; o.dirty = true;
    }
  }

  private die(mob: Mob, now: number) {
    mob.dead = true; mob.deadAt = now; mob.path = []; mob.target = null; mob.dirty = true;
    if (!mob.minion) {
      const here = new Map([...mob.credit].filter(([uid]) => this.members.has(uid)));
      if (here.size) this.out.kill(here, mob);
    }
    // A slime splits into two little ones that fight on (and pay nothing).
    if (mob.kind === "slime" && !mob.minion && !mob.boss && !mob.mini) {
      for (let i = 0; i < 2; i++) {
        const [x, y] = nearestWalkable(this.nav, mob.x + (i ? 0.5 : -0.5), mob.y + 0.2);
        const kid = this.addMob({ kind: "slime", rarity: mob.rarity as MobSpec["rarity"], sprite: mob.sprite, level: Math.max(1, mob.level - 2), boss: false, grp: mob.grp, hp: Math.max(5, Math.round(mob.baseMax * 0.3)), atk: Math.max(2, Math.round(mob.atk * 0.6)), def: mob.def, x, y }, now, 1, mob.home);
        kid.minion = true; kid.provoked = true; kid.born = now - 900;
        this.added.push(mobWire(kid));
      }
    }
    if (mob.minion) return;
    if (mob.mini) this.nextMini = now + MINI_COOLDOWN_MS + this.miniGap();
    if (!mob.boss && !mob.mini) this.nextSpawn = Math.max(this.nextSpawn, now + this.plan().afterKillMs[0] + Math.random() * (this.plan().afterKillMs[1] - this.plan().afterKillMs[0]));
  }

  plan() { return spawnPlan(this.baseCount, this.size); }

  tick(now: number, dt: number) {
    if (!this.members.size) return;
    const allies = this.allies();
    const ctx = {
      floor: this.floor, nav: this.nav, allies,
      hit: (m: Mob, a: Ally, dmg: number) => {
        a.frac = Math.max(0, a.frac - dmg / a.max);
        if (a.frac <= 0) a.dead = true;
        this.out.toRoom("hit", { m: m.id, f: a.id, d: dmg });
      },
      alert: (m: Mob, t: Ally) => this.alert(m, t),
    };
    // Poison and bleeding tick once a second.
    for (const a of allies) {
      const d = a.dot;
      if (!d || a.dead) { if (d) a.dot = undefined; continue; }
      if (now >= d.next) {
        d.next += 1000;
        const dmg = Math.max(1, Math.round(a.max * d.pct));
        a.frac = Math.max(0, a.frac - dmg / a.max);
        if (a.frac <= 0) a.dead = true;
        this.out.toRoom("hit", { m: -1, f: a.id, d: dmg });
      }
      if (now >= d.until) a.dot = undefined;
    }
    const gone: number[] = [];
    for (const m of this.mobs.values()) {
      if (m.dead) { if (now - m.deadAt > CORPSE_MS) gone.push(m.id); continue; }
      tickMob(m, dt, now, ctx);
    }
    for (const id of gone) this.mobs.delete(id);

    const add: ReturnType<typeof mobWire>[] = this.added;
    this.added = [];
    const live = [...this.mobs.values()].filter((m) => !m.dead && !m.boss && !m.mini && !m.minion).length;
    const plan = this.plan();
    if (live < plan.cap && now >= this.nextSpawn) {
      const spot = pickSpawn(this.world.zones as [number, number, number][], this.nav, allies, [...this.mobs.values()]);
      if (spot) {
        // One mob, or a pack of them, never past the floor cap.
        const group = rollGroup(this.floor, Math.random, this.nextGrp++).slice(0, Math.max(1, plan.cap - live));
        group.forEach((roll, i) => {
          const [x, y] = i === 0 ? spot.at : nearestWalkable(this.nav, spot.at[0] + (Math.random() - 0.5) * 2.4, spot.at[1] + (Math.random() - 0.5) * 1.6);
          add.push(mobWire(this.addMob({ ...roll, x, y }, now, 1, spot.home)));
        });
        this.nextSpawn = now + plan.gapMs[0] + Math.random() * (plan.gapMs[1] - plan.gapMs[0]);
      } else this.nextSpawn = now + 2000;
    }

    const mini = miniFor(this.floor);
    if (mini && now >= this.nextMini) {
      this.nextMini = now + 30_000; // retried soon if there was no room to place it; set properly once it is killed
      if (![...this.mobs.values()].some((m) => m.mini && !m.dead)) {
        const spot = pickSpawn(this.world.zones as [number, number, number][], this.nav, allies, [...this.mobs.values()]);
        if (spot) {
          const level = this.floor + MINI_LEVEL;
          const m = this.addMob({ kind: mini.kind, rarity: "mini", sprite: `mob_${mini.kind}_mini`, level, boss: false, mini: true, ...miniStats(level), x: spot.at[0], y: spot.at[1] }, now, 1, spot.home);
          add.push(mobWire(m));
          this.nextMini = now + 24 * 3600_000; // until it dies
          this.out.toRoom("mini", { kind: mini.kind });
        }
      }
    }

    const upd: [number, number, number, number, number][] = [], dead: number[] = [];
    for (const m of this.mobs.values()) {
      if (!m.dirty) continue;
      m.dirty = false;
      if (m.dead) dead.push(m.id); else upd.push([m.id, r2(m.x), r2(m.y), m.hp, m.swings]);
    }
    const mates: [string, [string, number, number, number, number][]][] = [];
    for (const mem of this.members.values()) {
      if (!mem.dirty) continue;
      mem.dirty = false;
      mates.push([mem.uid, [...mem.fighters.values()].map((a) => [a.id, r2(a.x), r2(a.y), r2(a.frac), a.dead ? 1 : 0])]);
    }
    if (upd.length || add.length || dead.length || gone.length || mates.length) this.out.toRoom("s", { m: upd, add, dead, del: gone, p: mates, n: this.size });
  }

  snapshot() {
    return {
      seed: this.seed,
      mobs: [...this.mobs.values()].map((m) => ({ ...mobWire(m), dead: m.dead })),
      players: [...this.members.values()].map((m) => ({ uid: m.uid, name: m.name, fighters: m.info.map((f) => ({ ...f, ...posOf(m, f.id) })) })),
    };
  }
}

const posOf = (m: Member, id: string) => { const a = m.fighters.get(id); return a ? { x: r2(a.x), y: r2(a.y), frac: r2(a.frac), dead: a.dead } : {}; };

