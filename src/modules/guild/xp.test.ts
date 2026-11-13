import { describe, expect, it } from "vitest";
import { xpAward, xpMultiplier, xpRequired } from "./xp.js";

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
