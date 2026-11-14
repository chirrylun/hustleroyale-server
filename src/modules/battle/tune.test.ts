import { describe, expect, it } from "vitest";
import { tuneSkill, type SkillRow } from "./team.js";

const row: SkillRow = { slug: "x", name: "X", kind: "damage", damage_type: "physical", power: 2, cooldown_ms: 4000, stamina_cost: 3, range_units: 2, target_rule: "enemy_nearest", effect: {} };

describe("tuneSkill", () => {
  it("leaves the basic attack alone", () => {
    expect(tuneSkill(row, 0, 5, [{ power_pct: 0.5 }])).toEqual(row);
  });
  it("adds 8% per skill level", () => {
    expect(Number(tuneSkill(row, 1, 3, []).power)).toBeCloseTo(2 * 1.16, 5);
  });
  it("stacks tree boosts, with cooldowns capped at 50% off", () => {
    const t = tuneSkill(row, 1, 1, [{ power_pct: 0.06 }, { power_pct: 0.06 }, { cooldown_pct: 0.4 }, { cooldown_pct: 0.4 }]);
    expect(Number(t.power)).toBeCloseTo(2 * 1.12, 5);
    expect(t.cooldown_ms).toBe(2000);
  });
});
