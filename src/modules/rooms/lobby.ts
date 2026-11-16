import { mobWire, type Hit, type Member, type Place, type RoomOut } from "./room.js";

export const LOBBY_SIZE = 24;
const EMPTY_MS = 15_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The Main Lobby: a room that always looks the same, where players see each other's fighters move about. There are no
 * mobs and nothing to pay, so all it does is pass positions along (only the ones that changed, ten times a second).
 * Each lobby holds a limited crowd; when one is full the next player starts another.
 */
export class Lobby implements Place {
  readonly members = new Map<string, Member>();
  readonly cap = LOBBY_SIZE;
  readonly floor = 0;
  private emptySince: number | null = null;

  constructor(readonly id: string, readonly code: string, private readonly out: RoomOut, now = Date.now()) { void now; }

  get size() { return this.members.size; }
  get full() { return this.members.size >= this.cap; }
  expired(now: number) { return this.emptySince !== null && now - this.emptySince > EMPTY_MS; }

  join(m: Member) { this.members.set(m.uid, m); this.emptySince = null; }
  leave(uid: string, now = Date.now()) { this.members.delete(uid); if (!this.members.size) this.emptySince = now; }

  report(uid: string, p: [string, number, number, number, number][]) {
    const mem = this.members.get(uid);
    if (!mem) return;
    for (const [id, x, y, frac, dead] of p) {
      const a = mem.fighters.get(id);
      if (!a) continue;
      a.x = x; a.y = y; a.frac = Math.max(0, Math.min(1, frac)); a.dead = !!dead;
    }
    mem.dirty = true;
  }

  attack(_uid: string, _hits: Hit[]) { /* nobody fights in the lobby */ }

  tick() {
    const mates: [string, [string, number, number, number, number][]][] = [];
    for (const mem of this.members.values()) {
      if (!mem.dirty) continue;
      mem.dirty = false;
      mates.push([mem.uid, [...mem.fighters.values()].map((a) => [a.id, r2(a.x), r2(a.y), r2(a.frac), a.dead ? 1 : 0])]);
    }
    if (mates.length) this.out.toRoom("s", { m: [], add: [], dead: [], del: [], p: mates, n: this.size });
  }

  snapshot() {
    return {
      mobs: [],
      players: [...this.members.values()].map((m) => ({
        uid: m.uid, name: m.name,
        fighters: m.info.map((f) => { const a = m.fighters.get(f.id); return { ...f, ...(a ? { x: r2(a.x), y: r2(a.y), frac: r2(a.frac), dead: a.dead } : {}) }; }),
      })),
    };
  }
}

export { mobWire };
