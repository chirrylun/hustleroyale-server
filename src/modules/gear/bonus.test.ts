import { describe, expect, it } from "vitest";
import { gearBonus } from "./bonus.js";

describe("gearBonus", () => {
  it("adds up every worn piece and tolerates empty or array-shaped rows", () => {
    expect(gearBonus(null)).toEqual({ atk: 0, def: 0, magic: 0, hp: 0, spd: 0 });
    const sword = { base_slug: "sword", rank: 1, atk: 3, def: 0, magic: 0, hp: 0, spd: 0 };
    const armor = { base_slug: "armor_fighter", rank: 1, atk: 0, def: 4, magic: 1, hp: 20, spd: 1 };
    expect(gearBonus([{ slot: "weapon", item: sword }, { slot: "armor", item: [armor] }, { slot: "offhand", item: null }])).toEqual({ atk: 3, def: 4, magic: 1, hp: 20, spd: 1 });
  });
});

describe("gear cap", () => {
  it("keeps gear to at most 40% of a stat", () => {
    const big = { base_slug: "sword", rank: 4, atk: 500, def: 500, magic: 0, hp: 500, spd: 0 };
    expect(gearBonus([{ slot: "weapon", item: big }], { hp: 100, atk: 30, def: 20, magic: 10, spd: 10 })).toEqual({ atk: 20, def: 13, magic: 0, hp: 66, spd: 0 });
  });
});

import { lookKey } from "../../world/look.js";
describe("lookKey", () => {
  it("is the plain novice unless armour with art is worn", () => {
    expect(lookKey("female", [])).toBe("novice_female");
    expect(lookKey("male", [{ slot: "weapon", item: { base_slug: "sword", rank: 1 } }])).toBe("novice_male");
    expect(lookKey("female", [{ slot: "armor", item: { base_slug: "armor_novice", rank: 1 } }])).toBe("armor_novice_1_female");
    expect(lookKey("male", [{ slot: "armor", item: [{ base_slug: "armor_fighter", rank: 2 }] }])).toBe("armor_fighter_2");
    expect(lookKey("male", [{ slot: "armor", item: { base_slug: "armor_nothing", rank: 1 } }])).toBe("novice_male");
  });
});
