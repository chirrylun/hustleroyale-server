import { describe, expect, it } from "vitest";
import { mobBaseXp, questXp, xpAward, xpMultiplier, xpRequired } from "./xp.js";

describe("xp", () => {
  it("costs more per level", () => expect(xpRequired(10)).toBeGreaterThan(xpRequired(9)));
  it("pays less for low-level monsters and more for tougher ones", () => {
    expect(xpMultiplier(10, 10)).toBe(1);
    expect(xpMultiplier(10, 5)).toBeLessThan(0.2);
    expect(xpMultiplier(10, 2)).toBe(0.05);
    expect(xpMultiplier(10, 13)).toBeCloseTo(1.3);
    expect(xpMultiplier(10, 40)).toBe(1.5);
  });
  it("shares the pool across a party", () => {
    expect(xpAward(100, 5, 5, 1)).toBe(100);
    expect(xpAward(100, 5, 5, 3)).toBeLessThan(100);
    expect(xpAward(100, 5, 5, 3) * 3).toBeGreaterThan(100);
  });
});

describe("monster xp", () => {
  it("matches the database function at the levels the seed was checked against", () => {
    expect(mobBaseXp(1)).toBe(5);
    expect(mobBaseXp(10)).toBe(52);
    expect(mobBaseXp(40)).toBe(461);
    expect(mobBaseXp(10, true)).toBe(313);
  });

  it("keeps kills-per-level for an even-level team of three between 18 and 29 all the way up", () => {
    // About 18 at levels 1-2 (whole-number XP rounds a little in the player's favour on tiny pools), rising to 28 at level 40.
    let prev = 0;
    for (let lv = 1; lv <= 40; lv++) {
      const kills = xpRequired(lv) / xpAward(mobBaseXp(lv), lv, lv, 3);
      expect(kills).toBeGreaterThanOrEqual(17.5); // never a pushover
      expect(kills).toBeLessThan(29); // never a grind
      if (lv > 3) expect(kills).toBeGreaterThanOrEqual(prev - 1); // and it never gets noticeably easier as you climb
      prev = kills;
    }
  });

  it("makes a boss worth about six normal kills", () => {
    for (const lv of [3, 10, 25, 40]) expect(mobBaseXp(lv, true) / mobBaseXp(lv)).toBeGreaterThan(5.8);
  });

  it("makes out-levelling a floor pay less, so the ladder balances itself", () => {
    const even = xpAward(mobBaseXp(20), 20, 20, 3);
    expect(xpAward(mobBaseXp(20), 24, 20, 3)).toBeLessThan(even * 0.5);
    expect(xpAward(mobBaseXp(20), 30, 20, 3)).toBeLessThan(even * 0.2);
  });

  it("pays quests a flat fifth of a level at their floor, with a boss bonus", () => {
    expect(questXp(1)).toBe(11);
    expect(questXp(10)).toBe(130);
    expect(questXp(10, true)).toBe(195);
    for (const floor of [5, 20, 39]) expect(questXp(floor) / xpRequired(floor)).toBeCloseTo(0.2, 1);
  });

  it("lets a floor's two quests plus a couple of clears roughly equal one level at that floor", () => {
    // Simulates a team of three at floor-level fighting an average floor twice, then handing in both quests.
    for (const floor of [3, 12, 25, 38]) {
      const mobs = 4 + Math.floor((((floor - 1) % 10) + 1) / 2);
      const perClear = mobs * xpAward(mobBaseXp(floor), floor, floor, 3);
      const levels = (2 * perClear + 2 * questXp(floor)) / xpRequired(floor);
      expect(levels).toBeGreaterThan(0.7);
      expect(levels).toBeLessThan(2.2);
    }
  });
});
