import { describe, expect, it } from "vitest";
import { createRng, type Role, type Stats } from "../../engine/index.js";
import { buildOpponent, FOE_RARITY_WEIGHTS, statPower, type PoolTemplate } from "./opponent.js";
import { DIFFICULTY_CONFIG } from "./rewards.js";
import type { SkillRow } from "./team.js";

const basicRow: SkillRow = {
  slug: "basic-strike", name: "Strike", kind: "damage", damage_type: "physical", power: "1.00",
  cooldown_ms: 1000, stamina_cost: 0, range_units: 2, target_rule: "enemy_nearest", effect: {},
};

const tpl = (id: string, role: Role, rarity: PoolTemplate["rarity"], k = 1): PoolTemplate => ({
  id, name: id, role, rarity, sprite_key: id,
  base_hp: 100 * k, base_atk: 12 * k, base_def: 8 * k, base_spd: 8 * k, base_stamina: 10 * k, base_magic: 10 * k,
  skills: [basicRow],
});

const POOL: PoolTemplate[] = [
  tpl("t-common", "tank", "common"), tpl("t-unc", "tank", "uncommon", 1.2), tpl("t-rare", "tank", "rare", 1.5), tpl("t-leg", "tank", "legendary", 2),
  tpl("h-common", "healer", "common"), tpl("h-unc", "healer", "uncommon", 1.2), tpl("h-rare", "healer", "rare", 1.5), tpl("h-leg", "healer", "legendary", 2),
  tpl("d-common", "dps", "common"), tpl("d-unc", "dps", "uncommon", 1.2), tpl("d-rare", "dps", "rare", 1.5), tpl("d-leg", "dps", "legendary", 2),
];

const ROLES: Role[] = ["tank", "healer", "dps"];
const PLAYER_STATS: Stats = { hp: 110, atk: 13, def: 9, spd: 9, stamina: 11, magic: 11 };
const PLAYER_POWER = ROLES.length * statPower(PLAYER_STATS);

describe("buildOpponent", () => {
  it("mirrors the player's roles", () => {
    const foe = buildOpponent(POOL, ROLES, PLAYER_POWER, "hustler", createRng(1));
    expect(foe.units.map((u) => u.role)).toEqual(ROLES);
    expect(foe.units.every((u) => u.side === 2)).toBe(true);
    expect(foe.metas.map((m) => m.spriteKey)).toHaveLength(3);
  });

  it("is deterministic for a seed", () => {
    const a = buildOpponent(POOL, ROLES, PLAYER_POWER, "boss", createRng(99));
    const b = buildOpponent(POOL, ROLES, PLAYER_POWER, "boss", createRng(99));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("scales its total strength to the player's, per difficulty", () => {
    for (const d of ["rookie", "hustler", "boss"] as const) {
      for (let seed = 1; seed <= 25; seed++) {
        const foe = buildOpponent(POOL, ROLES, PLAYER_POWER, d, createRng(seed));
        const power = foe.units.reduce((sum, u) => sum + statPower(u.stats), 0);
        // Allow a little slack for rounding each stat to a whole number.
        expect(power / PLAYER_POWER).toBeCloseTo(DIFFICULTY_CONFIG[d].power, 1);
      }
    }
  });

  it("can't be farmed with a weak team: a much weaker player still faces a matched opponent", () => {
    const weak = PLAYER_POWER * 0.2;
    const foe = buildOpponent(POOL, ROLES, weak, "hustler", createRng(5));
    const power = foe.units.reduce((sum, u) => sum + statPower(u.stats), 0);
    // Scaling is clamped, so it can't shrink the foe to nothing, but it does track the player down.
    expect(power).toBeLessThan(PLAYER_POWER);
    expect(power).toBeGreaterThan(weak * 0.9);
  });

  it("only draws the rarities a difficulty allows", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      for (const m of buildOpponent(POOL, ROLES, PLAYER_POWER, "rookie", createRng(seed)).metas) seen.add(m.spriteKey);
    }
    const allowed = Object.keys(FOE_RARITY_WEIGHTS.rookie);
    for (const key of seen) {
      const rarity = POOL.find((p) => p.sprite_key === key)!.rarity;
      expect(allowed).toContain(rarity);
    }
  });

  it("throws a clear error when the catalogue has no fighter for a role", () => {
    expect(() => buildOpponent(POOL.filter((t) => t.role !== "healer"), ROLES, PLAYER_POWER, "hustler", createRng(1))).toThrow(
      "no_opponent_for_role:healer",
    );
  });
});
