import { describe, expect, it } from "vitest";
import { generateFloor } from "../../world/floor.js";
import { buildNav } from "../../world/guild-nav.js";
import { spawnPlan } from "./mobs.js";
import { Room, type FighterInfo, type Member, type RoomOut } from "./room.js";

const world = generateFloor(3), nav = buildNav(world.nav);
const events: { e: string; p: any }[] = [], kills: string[] = [];
const out: RoomOut = { toRoom: (e, p) => events.push({ e, p }), toUser: () => {}, kill: (credit) => kills.push(...credit.keys()) };

const member = (uid: string, x: number, y: number): Member => {
  const info: FighterInfo[] = [{ id: `${uid}-f`, sprite: "x", name: "F", role: "dps", level: 3, xp: 0, max: 100, atk: 20, magic: 5, def: 5, frac: 1 }];
  return { uid, name: uid, info, buckets: new Map(), dirty: false, fighters: new Map([[`${uid}-f`, { id: `${uid}-f`, uid, x, y, max: 100, def: 5, frac: 1, dead: false }]]) };
};

describe("spawn plan", () => {
  it("scales the mob cap with players", () => {
    expect(spawnPlan(10, 1).cap).toBe(10);
    expect(spawnPlan(10, 2).cap).toBe(15);
    expect(spawnPlan(10, 4).cap).toBe(25);
  });
});

describe("Room seed", () => {
  it("tells joiners which map it runs, so they build the same one", () => {
    const r = new Room("r", "ABCD", 3, generateFloor(3, 42), buildNav(generateFloor(3, 42).nav), out, 0, 42);
    expect(r.snapshot().seed).toBe(42);
  });
});

describe("Room", () => {
  const mk = () => new Room("r", "ABCD", 3, world, nav, out, 0);

  it("tops up mobs as players join, never past the cap", () => {
    const r = mk();
    const base = [...r.mobs.values()].filter((m) => !m.boss).length;
    for (const [i, u] of ["a", "b", "c"].entries()) r.join(member(u, world.start[0] + i, world.start[1]), 0);
    let now = 0;
    for (let i = 0; i < 6000; i++) { now += 100; r.tick(now, 0.1); }
    const live = [...r.mobs.values()].filter((m) => !m.dead && !m.boss && !m.mini && !m.minion).length;
    expect(live).toBe(r.plan().cap);
    expect(live).toBeGreaterThan(base);
  });

  it("pays every player who hurt a mob, and refuses forged or fast damage", () => {
    kills.length = 0;
    const r = mk();
    const a = member("a", 0, 0), b = member("b", 0, 0);
    r.join(a, 0); r.join(b, 0);
    const mob = [...r.mobs.values()].find((m) => !m.boss)!;
    for (const m of [a, b]) r.report(m.uid, [[`${m.uid}-f`, mob.x + 1, mob.y, 1, 0]]);
    r.attack("a", [{ m: mob.id, f: "a-f", d: 99999 }], 1000); // far over what a level-3 fighter can do
    expect(mob.hp).toBe(mob.max);
    r.attack("a", [{ m: mob.id, f: "b-f", d: 5 }], 1000); // someone else's fighter
    expect(mob.hp).toBe(mob.max);
    r.attack("a", [{ m: mob.id, f: "a-f", d: 20 }], 1000);
    mob.hp = 5;
    r.attack("b", [{ m: mob.id, f: "b-f", d: 20 }], 1100);
    expect(mob.dead).toBe(true);
    expect(kills.sort()).toEqual(["a", "b"]);
  });

  it("ignores damage from out of reach and rate-limits bursts", () => {
    const r = mk();
    const a = member("a", 0, 0);
    r.join(a, 0);
    const mob = [...r.mobs.values()].find((m) => !m.boss)!;
    r.report("a", [["a-f", mob.x + 30, mob.y, 1, 0]]);
    r.attack("a", [{ m: mob.id, f: "a-f", d: 10 }], 1000);
    expect(mob.hp).toBe(mob.max);
    r.report("a", [["a-f", mob.x + 1, mob.y, 1, 0]]);
    r.attack("a", Array.from({ length: 20 }, () => ({ m: mob.id, f: "a-f", d: 1 })), 2000);
    expect(mob.max - mob.hp).toBeLessThanOrEqual(8);
  });

  it("scales a boss's health with the head count", () => {
    const bw = generateFloor(10);
    const r = new Room("b", "BOSS", 10, bw, buildNav(bw.nav), out, 0);
    const boss = [...r.mobs.values()].find((m) => m.boss)!;
    const solo = boss.max;
    r.join(member("a", 0, 0), 0); r.join(member("b", 0, 0), 0);
    expect(boss.max).toBeGreaterThan(solo);
  });
});

describe("Lobby", () => {
  it("shares positions between players and fills up to its cap", async () => {
    const { Lobby, LOBBY_SIZE } = await import("./lobby.js");
    const sent: any[] = [];
    const lobby = new Lobby("l", "LOBY", { ...out, toRoom: (e, p) => sent.push({ e, p }) });
    lobby.join(member("a", 0, 0)); lobby.join(member("b", 0, 0));
    lobby.report("a", [["a-f", 4, 6, 1, 0]]);
    lobby.tick();
    expect(sent.length).toBe(1);
    expect(sent[0].p.p[0][0]).toBe("a");
    lobby.tick();
    expect(sent.length).toBe(1); // nothing moved since
    for (let i = 0; i < LOBBY_SIZE; i++) lobby.join(member(`x${i}`, 0, 0));
    expect(lobby.full).toBe(true);
  });
});
