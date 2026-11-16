import type { Floor, MobSpec } from "../../world/floor.js";
import { baseMobCount, rollMob } from "../../world/floor.js";
import type { Nav } from "../../world/guild-nav.js";
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
  /** A mob died: pay each credited player. */
  kill(uid: string, mob: Mob): void;
}

export interface Hit { m: number; f: string; d: number }

const r2 = (n: number) => Math.round(n * 100) / 100;
export const mobWire = (m: Mob) => ({ id: m.id, kind: m.kind, rarity: m.rarity, sprite: m.sprite, level: m.level, boss: m.boss, x: r2(m.x), y: r2(m.y), hp: m.hp, max: m.max, home: m.home });

/**
 * One shared copy of a floor. The server owns the monsters here: it spawns them (more of them the more players are
 * in the room), moves them, lets them hit fighters, takes the damage fighters report (checked against their stats)
 * and decides when a mob dies and who is paid for it.
 */
export class Room {
  readonly members = new Map<string, Member>();
  readonly mobs = new Map<number, Mob>();
  private nextId = 0;
  private nextSpawn = 0;
  private emptySince: number | null = null;
  private readonly baseCount: number;

  constructor(readonly id: string, readonly code: string, readonly floor: number, private readonly world: Floor, private readonly nav: Nav, private readonly out: RoomOut, now = Date.now(), readonly seed = 0) {
    this.baseCount = world.mobs.filter((m) => !m.boss).length || baseMobCount(floor);
    for (const s of world.mobs) this.addMob(s, now, s.boss ? 1 : 1);
    this.nextSpawn = now + 8000;
  }

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
    const m = makeMob(this.nextId++, s, this.nav, home ?? this.zoneOf(s.x, s.y), now, s.boss ? bossScale(Math.max(1, this.size)) * hpMul : hpMul);
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
      if (!b.boss || b.dead) continue;
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
      mob.credit.add(uid);
      mob.provoked = true;
      if (!mob.target || !this.allies().some((x) => x.id === mob.target && !x.dead)) { mob.target = a.id; mob.path = []; }
      mob.dirty = true;
      if (mob.hp <= 0) this.die(mob, now);
    }
  }

  private die(mob: Mob, now: number) {
    mob.dead = true; mob.deadAt = now; mob.path = []; mob.target = null; mob.dirty = true;
    for (const uid of mob.credit) if (this.members.has(uid)) this.out.kill(uid, mob);
    if (!mob.boss) this.nextSpawn = Math.max(this.nextSpawn, now + this.plan().afterKillMs[0] + Math.random() * (this.plan().afterKillMs[1] - this.plan().afterKillMs[0]));
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
    };
    const gone: number[] = [];
    for (const m of this.mobs.values()) {
      if (m.dead) { if (now - m.deadAt > CORPSE_MS) gone.push(m.id); continue; }
      tickMob(m, dt, now, ctx);
    }
    for (const id of gone) this.mobs.delete(id);

    const add: ReturnType<typeof mobWire>[] = [];
    const live = [...this.mobs.values()].filter((m) => !m.dead && !m.boss).length;
    const plan = this.plan();
    if (live < plan.cap && now >= this.nextSpawn) {
      const spot = pickSpawn(this.world.zones as [number, number, number][], this.nav, allies, [...this.mobs.values()]);
      if (spot) {
        const roll = rollSpec(this.floor);
        const m = this.addMob({ ...roll, x: spot.at[0], y: spot.at[1] }, now, 1, spot.home);
        add.push(mobWire(m));
        this.nextSpawn = now + plan.gapMs[0] + Math.random() * (plan.gapMs[1] - plan.gapMs[0]);
      } else this.nextSpawn = now + 2000;
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

const rollSpec = (floor: number) => rollMob(floor, Math.random);
