import { randomBytes } from "node:crypto";
import { generateFloor, type Floor } from "../../world/floor.js";
import { buildNav, type Nav } from "../../world/guild-nav.js";
import { Room, ROOM_SIZE, type Member, type RoomOut } from "./room.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from(randomBytes(4), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");

const worlds = new Map<number, { floor: Floor; nav: Nav }>();
/** A floor's map and walking grid never change, so each is built once and shared by every room on it. */
function worldOf(n: number) {
  let w = worlds.get(n);
  if (!w) { const floor = generateFloor(n); w = { floor, nav: buildNav(floor.nav) }; worlds.set(n, w); }
  return w;
}

export type OutFactory = (roomId: string) => RoomOut;

/** Finds or makes the room a player should be in, and keeps every room ticking from one timer. */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private byFloor = new Map<number, Set<Room>>();
  private byCode = new Map<string, Room>();
  private where = new Map<string, Room>(); // user id -> their room
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

  private create(floor: number): Room {
    const { floor: world, nav } = worldOf(floor);
    let code = newCode();
    while (this.byCode.has(code)) code = newCode();
    const id = `r_${randomBytes(6).toString("hex")}`;
    const room = new Room(id, code, floor, world, nav, this.outFor(id));
    this.rooms.set(id, room);
    this.byCode.set(code, room);
    (this.byFloor.get(floor) ?? this.byFloor.set(floor, new Set()).get(floor)!).add(room);
    return room;
  }

  /** The fullest open room for this floor, so people end up together; a new one when none has space. */
  place(uid: string, floor: number, code?: string): { room: Room } | { error: "no_such_room" | "room_full" | "wrong_floor" } {
    this.leave(uid);
    if (code) {
      const r = this.byCode.get(code.toUpperCase());
      if (!r) return { error: "no_such_room" };
      if (r.floor !== floor) return { error: "wrong_floor" };
      if (r.full) return { error: "room_full" };
      return { room: r };
    }
    let best: Room | null = null;
    for (const r of this.byFloor.get(floor) ?? []) if (!r.full && (!best || r.size > best.size)) best = r;
    return { room: best ?? this.create(floor) };
  }

  add(room: Room, m: Member) {
    room.join(m);
    this.where.set(m.uid, room);
  }

  leave(uid: string): Room | undefined {
    const r = this.where.get(uid);
    if (!r) return;
    this.where.delete(uid);
    r.leave(uid);
    return r;
  }

  private drop(r: Room) {
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
