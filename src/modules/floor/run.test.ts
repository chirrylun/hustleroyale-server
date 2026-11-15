import { describe, expect, it } from "vitest";
import { FloorRuns } from "./run.js";
import { plausibleMob } from "./rules.js";

describe("plausibleMob", () => {
  it("accepts mobs of the floor's theme and level, refuses the rest", () => {
    expect(plausibleMob(1, { kind: "bat", level: 1, boss: false })).toBe(true);
    expect(plausibleMob(1, { kind: "bat", level: 2, boss: false })).toBe(true);
    expect(plausibleMob(1, { kind: "golem", level: 1, boss: false })).toBe(false);
    expect(plausibleMob(1, { kind: "bat", level: 9, boss: false })).toBe(false);
    expect(plausibleMob(5, { kind: "goblin", level: 12, boss: true })).toBe(false); // not a boss floor
    expect(plausibleMob(10, { kind: "goblin", level: 12, boss: true })).toBe(true);
    expect(plausibleMob(10, { kind: "slime", level: 12, boss: true })).toBe(false);
  });
});

describe("FloorRuns", () => {
  it("needs a run, the right floor, and no double boss", () => {
    const r = new FloorRuns();
    const bat = { kind: "bat", level: 1, boss: false };
    expect(r.check("u", 1, bat, 1000)).toBe("no_run");
    r.start("u", 1, 1000);
    expect(r.check("u", 2, bat, 1000)).toBe("wrong_floor");
    expect(r.check("u", 1, bat, 2000)).toBeNull();
    expect(r.check("u", 1, bat, 2050)).toBe("too_fast");
    r.start("u", 10, 3000);
    const boss = { kind: "goblin", level: 12, boss: true };
    expect(r.check("u", 10, boss, 4000)).toBeNull();
    r.paid("u", boss);
    expect(r.check("u", 10, boss, 5000)).toBe("boss_done");
  });
});
