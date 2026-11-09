import { describe, expect, it } from "vitest";
import { createRng } from "../../engine/rng.js";
import { GRADE_MULTIPLIER, PACK_ROLES, rollStarterPack, type FighterTemplate } from "./roll.js";

const base = { base_hp: 100, base_atk: 10, base_def: 10, base_spd: 10, base_stamina: 10, base_magic: 10 };
const t = (id: string, role: FighterTemplate["role"], rarity: FighterTemplate["rarity"], extra: Partial<FighterTemplate> = {}): FighterTemplate => ({
  id,
  role,
  rarity,
  supply_cap: null,
  minted: 0,
  ...base,
  ...extra,
});

const catalog = [
  t("tank-c", "tank", "common"),
  t("tank-r", "tank", "rare", { supply_cap: 500 }),
  t("tank-l", "tank", "legendary", { supply_cap: 50 }),
  t("heal-c", "healer", "common"),
  t("heal-u", "healer", "uncommon", { supply_cap: 5000 }),
  t("dps-c", "dps", "common"),
  t("dps-r", "dps", "rare", { supply_cap: 500 }),
];

describe("rollStarterPack", () => {
  it("returns one fighter per role, in slot order", () => {
    const pack = rollStarterPack(catalog, createRng(1));
    expect(pack).toHaveLength(3);
    const roles = pack.map((p) => catalog.find((c) => c.id === p.template_id)!.role);
    expect(roles).toEqual(PACK_ROLES);
  });

  it("is deterministic for a given seed", () => {
    expect(rollStarterPack(catalog, createRng(42))).toEqual(rollStarterPack(catalog, createRng(42)));
  });

  it("never hands out legendaries or sold-out templates", () => {
    const soldOut = catalog.map((c) => (c.id === "tank-r" ? { ...c, minted: 500 } : c));
    for (let seed = 0; seed < 500; seed++) {
      for (const p of rollStarterPack(soldOut, createRng(seed))) {
        expect(p.template_id).not.toBe("tank-l");
        expect(p.template_id).not.toBe("tank-r");
      }
    }
  });

  it("keeps stats inside the grade multiplier and variance band", () => {
    for (let seed = 0; seed < 200; seed++) {
      for (const p of rollStarterPack(catalog, createRng(seed))) {
        const mult = GRADE_MULTIPLIER[p.grade];
        for (const stat of [p.hp, p.atk, p.def, p.spd, p.stamina, p.magic]) {
          expect(stat).toBeGreaterThanOrEqual(1);
        }
        expect(p.hp).toBeGreaterThanOrEqual(Math.floor(100 * mult * 0.95));
        expect(p.hp).toBeLessThanOrEqual(Math.ceil(100 * mult * 1.05));
      }
    }
  });

  it("throws when a role has nothing available", () => {
    expect(() => rollStarterPack(catalog.filter((c) => c.role !== "healer"), createRng(1))).toThrow("no_templates_for_role:healer");
  });
});
