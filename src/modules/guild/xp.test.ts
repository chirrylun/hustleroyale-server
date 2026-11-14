import { describe, expect, it } from "vitest";
import { killXp, mobBaseXp, xpAward, xpMultiplier, xpRequired } from "./xp.js";

describe("xp", () => {
  it("costs more per level", () => expect(xpRequired(10)).toBeGreaterThan(xpRequired(9)));

  it("follows the level-gap table, with a multiplier of 0 five or more levels below", () => {
    const table = [[3, 1.3], [2, 1.2], [1, 1.1], [0, 1], [-1, 0.8], [-2, 0.55], [-3, 0.3], [-4, 0.12], [-5, 0], [-9, 0]];
    for (const [gap, want] of table) expect(xpMultiplier(10, 10 + gap)).toBe(want);
    expect(xpMultiplier(10, 40)).toBe(1.3);
  });

  it("shares the pool across a party", () => {
    expect(xpAward(100, 5, 5, 1)).toBe(100);
    expect(xpAward(100, 5, 5, 3)).toBeLessThan(100);
    expect(xpAward(100, 5, 5, 3) * 3).toBeGreaterThan(100);
  });

  it("takes about the planned number of same-level kills per level (party of three)", () => {
    const kills = (l: number) => xpRequired(l) / killXp(l, l, 3);
    expect(kills(1)).toBeGreaterThan(6); expect(kills(1)).toBeLessThan(8);
    expect(kills(10)).toBeGreaterThan(14); expect(kills(10)).toBeLessThan(16);
    expect(kills(20)).toBeGreaterThan(23); expect(kills(20)).toBeLessThan(25);
    expect(kills(40)).toBeGreaterThan(41); expect(kills(40)).toBeLessThan(43);
  });

  it("pays a flat 1 xp for monsters five or more levels below", () => {
    expect(killXp(20, 15, 3)).toBe(1);
    expect(killXp(40, 1, 3)).toBe(1);
    expect(killXp(20, 16, 3)).toBeGreaterThan(1);
  });

  it("keeps a roll of 80% to 120% around the usual amount", () => {
    const base = killXp(10, 10, 3);
    expect(killXp(10, 10, 3, 0.8)).toBeLessThan(base);
    expect(killXp(10, 10, 3, 1.2)).toBeGreaterThan(base);
  });

  it("lets a low level fighter be carried but never skip levels", () => {
    const carried = killXp(1, 40, 3);                // a level 1 on a level 40 floor
    expect(carried).toBeGreaterThan(killXp(1, 1, 3)); // faster than self-levelling...
    expect(carried).toBeLessThanOrEqual(Math.ceil(killXp(1, 1, 3) * 1.3));
    expect(carried).toBeLessThan(xpRequired(1) / 4);  // ...but a level still takes several kills
    expect(killXp(1, 40, 3)).toBe(killXp(1, 4, 3));   // however far above the mob is
  });

  it("pays a boss six times a normal kill", () => expect(mobBaseXp(10, true)).toBeCloseTo(mobBaseXp(10) * 6));
});
