import { describe, expect, it } from "vitest";
import { gearBonus } from "./bonus.js";

describe("gearBonus", () => {
  it("adds up every worn piece and tolerates empty or array-shaped rows", () => {
    expect(gearBonus(null)).toEqual({ atk: 0, def: 0, magic: 0, hp: 0, spd: 0 });
    const sword = { atk: 3, def: 0, magic: 0, hp: 0, spd: 0 };
    const armor = { atk: 0, def: 4, magic: 1, hp: 20, spd: 1 };
    expect(gearBonus([{ item: sword }, { item: [armor] }, { item: null }])).toEqual({ atk: 3, def: 4, magic: 1, hp: 20, spd: 1 });
  });
});
