import { randomBytes } from "node:crypto";
import { generateFloor, newSeed, type Floor } from "../../world/floor.js";
import { buildNav, type Nav } from "../../world/guild-nav.js";
import { Lobby } from "./lobby.js";
import { Room, ROOM_SIZE, type Member, type Place, type RoomOut } from "./room.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from(randomBytes(4), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");

/** Each room has its own map: the same floor number with a different seed is a different layout. */
function worldOf(n: number, seed: number): { floor: Floor; nav: Nav } {
  const floor = generateFloor(n, seed);
  return { floor, nav: buildNav(floor.nav) };
}

export type OutFactory = (roomId: string) => RoomOut;

/** Finds or makes the room a player should be in, and keeps every room ticking from one timer. */
export class RoomManager {
  private rooms = new Map<string, Place>();
  private byFloor = new Map<number, Set<Place>>();
  private byCode = new Map<string, Place>();
  private where = new Map<string, Place>(); // user id -> their room
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = Date.now();

  constructor(private readonly outFor: OutFactory) {}

  start(hz = 10) {
    this.timer = setInterval(() => this.tick(), 1000 / hz);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  roomOf(uid: string) { return this.where.get(uid); }
  get roomCount() { return this.rooms.size; }

  private create(floor: number, seed: number): Place {
    let code = newCode();
    while (this.byCode.has(code)) code = newCode();
    const id = `r_${randomBytes(6).toString("hex")}`;
    const out = this.outFor(id);
    let room: Place;
    if (floor === 0) room = new Lobby(id, code, out); // the Main Lobby: no map to build, nothing to fight
    else { const { floor: world, nav } = worldOf(floor, seed); room = new Room(id, code, floor, world, nav, out, Date.now(), seed); }
    this.rooms.set(id, room);
    this.byCode.set(code, room);
    (this.byFloor.get(floor) ?? this.byFloor.set(floor, new Set()).get(floor)!).add(room);
    return room;
  }

  /** The fullest open room for this floor, so people end up together; a new one when none has space. Boss floors are always private (join by code). */
  place(uid: string, floor: number, code?: string, seed?: number): { room: Place } | { error: "no_such_room" | "room_full" | "wrong_floor" } {
    this.leave(uid);
    if (code) {
      const r = this.byCode.get(code.toUpperCase());
      if (!r) return { error: "no_such_room" };
      if (r.floor !== floor) return { error: "wrong_floor" };
      if (r.full) return { error: "room_full" };
      return { room: r };
    }
    // Boss floors are never matched with strangers: each visit gets its own room, which friends can join with its code.
    if (floor > 0 && floor % 10 === 0) return { room: this.create(floor, seed ?? newSeed()) };
    let best: Place | null = null;
    for (const r of this.byFloor.get(floor) ?? []) if (!r.full && (!best || r.size > best.size)) best = r;
    return { room: best ?? this.create(floor, seed ?? newSeed()) };
  }

  add(room: Place, m: Member) {
    room.join(m);
    this.where.set(m.uid, room);
  }

  leave(uid: string): Place | undefined {
    const r = this.where.get(uid);
    if (!r) return;
    this.where.delete(uid);
    r.leave(uid);
    return r;
  }

  private drop(r: Place) {
    this.rooms.delete(r.id);
    this.byCode.delete(r.code);
    this.byFloor.get(r.floor)?.delete(r);
  }

  tick() {
    const now = Date.now(), dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    for (const r of [...this.rooms.values()]) {
      if (r.expired(now)) { this.drop(r); continue; }
      try { r.tick(now, dt); } catch (e) { console.error("room tick failed", r.id, e); }
    }
  }
}

export { ROOM_SIZE };
