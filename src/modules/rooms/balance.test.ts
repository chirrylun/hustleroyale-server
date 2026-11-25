import { describe, expect, it } from "vitest";
import { hitDamage, mobStats } from "../../world/floor.js";

// Fighter stats as the database grows them: HP +9% and ATK/DEF +7% of the level-1 value per level.
const at = (b: number, L: number, r: number) => Math.round(b * (1 + r * (L - 1)));
const classes = { tank: [127, 9, 14], recruit: [110, 10, 12], thief: [80, 13, 5], mage: [75, 15, 4] } as const;

describe("same-level mob balance", () => {
  for (const L of [1, 5, 10, 20, 30, 40]) {
    for (const [name, [hp, atk, def]] of Object.entries(classes)) {
      it(`${name} L${L}: ungeared: survives 4+ mob hits, kills in 25 or fewer`, () => {
        const m = mobStats(L, false);
        const dies = at(hp, L, 0.09) / hitDamage(m.atk, at(def, L, 0.07), L);
        const kills = m.hp / hitDamage(at(atk, L, 0.07), m.def, L);
        expect(dies).toBeGreaterThanOrEqual(4); // mobs hit hard on purpose; gear, skills, the tank and the healer carry the rest
        expect(kills).toBeLessThanOrEqual(25);
      });
    }
  }
});
