import { describe, expect, it } from "vitest";
import { baseReward, DAILY_CAP, DIFFICULTY_CONFIG, LOSS_CONSOLATION, TIERS } from "./rewards.js";

const base = { difficulty: "hustler" as const, winnerSide: 1 as const, durationMs: 60_000, damageDealt: 500, enemyTotalHp: 400 };

describe("baseReward", () => {
  it("pays the difficulty's win amount for a real win", () => {
    for (const d of ["rookie", "hustler", "boss"] as const) {
      expect(baseReward({ ...base, difficulty: d })).toBe(DIFFICULTY_CONFIG[d].win);
    }
  });

  it("pays harder fights more", () => {
    expect(DIFFICULTY_CONFIG.rookie.win).toBeLessThan(DIFFICULTY_CONFIG.hustler.win);
    expect(DIFFICULTY_CONFIG.hustler.win).toBeLessThan(DIFFICULTY_CONFIG.boss.win);
  });

  it("pays nothing for an instant win", () => {
    expect(baseReward({ ...base, durationMs: 5_000 })).toBe(0);
  });

  it("pays a small consolation only for a loss that was a real fight", () => {
    const loss = { ...base, winnerSide: 2 as const, durationMs: 70_000, damageDealt: 200 };
    expect(baseReward(loss)).toBe(LOSS_CONSOLATION);
    expect(baseReward({ ...loss, durationMs: 20_000 })).toBe(0); // gave up early
    expect(baseReward({ ...loss, damageDealt: 50 })).toBe(0); // barely scratched them
  });

  it("pays nothing for a draw", () => {
    expect(baseReward({ ...base, winnerSide: null })).toBe(0);
  });
});

describe("economy invariants", () => {
  it("a loss is always worth far less than a win", () => {
    expect(LOSS_CONSOLATION * 5).toBeLessThanOrEqual(DIFFICULTY_CONFIG.rookie.win);
  });

  it("tiers only ever pay less as the day goes on", () => {
    const mults = TIERS.map((t) => t.mult);
    expect(mults).toEqual([...mults].sort((a, b) => b - a));
    const uptos = TIERS.map((t) => t.upto);
    expect(uptos).toEqual([...uptos].sort((a, b) => a - b));
  });

  it("the daily cap bounds a best-case grind", () => {
    // Best case: every match is a Boss win, paid at the tier multipliers, ignoring the cap.
    let uncapped = 0;
    let n = 0;
    for (const tier of TIERS) {
      while (n < tier.upto) {
        uncapped += Math.floor(DIFFICULTY_CONFIG.boss.win * tier.mult);
        n++;
      }
    }
    expect(uncapped).toBeGreaterThan(DAILY_CAP); // the cap is what binds, not the tiers
    expect(Math.min(uncapped, DAILY_CAP)).toBe(DAILY_CAP);
  });
});
