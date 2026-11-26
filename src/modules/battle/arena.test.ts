import { describe, expect, it } from "vitest";
import { createRng, fight, referenceTeam } from "./arena.testkit.js";
import { BOSSES, BOSS_IDS, MOBS, RANGES, RANGE_IDS, RAID_HEAL_FRAC, RAID_REVIVE_FRAC, RAID_STAGES, buildBoss, raidFoe, raidLevel, type RangeId } from "./arena.js";
import { THEMES } from "../../world/floor.js";
import { startRequestSchema } from "./protocol.js";

/**
 * Balance guard rails. The reference team is the three Recruits (their database numbers) in modest gear, at a given level, with the
 * AI driving every fighter. Bounds are loose on purpose: they catch "impossible" and "free", not a tweak of a few percent.
 */
const SEEDS = 12;
const wins = (level: number, id: (typeof BOSS_IDS)[number]) => {
  let w = 0, t = 0;
  for (let i = 1; i <= SEEDS; i++) { const s = fight(referenceTeam(level), buildBoss(id), i * 7919); if (s.winnerSide === 1) { w++; t += s.timeMs / 1000; } }
  return { rate: w / SEEDS, secs: w ? t / w : 0 };
};

describe("boss rush", () => {
  for (const id of BOSS_IDS) {
    it(`${BOSSES[id].name}: a team at its level usually wins in a sensible time, and a much weaker one does not`, () => {
      const at = wins(BOSSES[id].level, id);
      expect(at.rate).toBeGreaterThanOrEqual(0.5);
      expect(at.secs).toBeGreaterThan(50);
      expect(at.secs).toBeLessThan(175);
      expect(wins(BOSSES[id].level - 8, id).rate).toBeLessThanOrEqual(0.35);
    });
  }
  it("each range offers two floor bosses, the lower one the easier", () => {
    for (const r of RANGE_IDS) { const [a, b] = RANGES[r].bosses; expect(BOSSES[a].level).toBeLessThan(BOSSES[b].level); }
  });
});

function raid(range: RangeId, level: number, seed: number) {
  const r = RANGES[range];
  const frac: Record<string, number> = {};
  let cleared = 0;
  for (let stage = 1; stage <= RAID_STAGES; stage++) {
    const s = fight(referenceTeam(level, 1.15, frac), raidFoe(r, stage, createRng(seed + stage)), seed * 31 + stage, r.dodge);
    if (s.winnerSide !== 1) return cleared;
    cleared++;
    for (const u of s.units.filter((x) => x.side === 1)) frac[u.id] = u.alive ? Math.min(1, (u.hp + RAID_HEAL_FRAC * u.maxHp) / u.maxHp) : RAID_REVIVE_FRAC;
  }
  return cleared;
}
const avg = (range: RangeId, level: number) => Array.from({ length: 8 }, (_, i) => raid(range, level, 100 + i)).reduce((a, b) => a + b, 0) / 8;

describe("floor raid", () => {
  for (const r of RANGE_IDS) {
    it(`${r}: a team at the top of the range gets most of the way, one at the bottom does not`, () => {
      expect(avg(r, RANGES[r].max)).toBeGreaterThanOrEqual(7);
      expect(avg(r, RANGES[r].min)).toBeLessThanOrEqual(5.5);
    });
  }
  it("mob levels climb from the bottom of the range to its top, then the floor boss", () => {
    for (const r of RANGE_IDS) {
      const range = RANGES[r];
      expect(raidLevel(range, 1)).toBe(range.min);
      expect(raidLevel(range, RAID_STAGES - 1)).toBe(range.max);
      expect(raidFoe(range, RAID_STAGES, createRng(1)).metas[0]!.spriteKey).toMatch(/^mob_[a-z]+_legendary$/);
      expect(raidFoe(range, 1, createRng(1)).units).toHaveLength(3);
    }
  });
  it("every mob of every raid theme has a definition and art for the rarities used", () => {
    for (const r of RANGE_IDS) for (const kind of THEMES[RANGES[r].theme].mobs) expect(MOBS[kind], kind).toBeDefined();
  });
});

describe("start request", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  it("accepts each mode, and the old practice request", () => {
    expect(startRequestSchema.safeParse({ mode: "challenge", range: "10-20" }).success).toBe(true);
    expect(startRequestSchema.safeParse({ mode: "boss", range: "20-30", boss: "golem", controlledFighterId: id }).success).toBe(true);
    expect(startRequestSchema.safeParse({ mode: "raid", range: "30-40" }).success).toBe(true);
    expect(startRequestSchema.safeParse({ difficulty: "hustler", controlledFighterId: null }).success).toBe(true);
  });
  it("refuses anything else", () => {
    expect(startRequestSchema.safeParse({ mode: "raid", range: "1-5" }).success).toBe(false);
    expect(startRequestSchema.safeParse({ mode: "boss", range: "10-20", boss: "dragon" }).success).toBe(false);
    expect(startRequestSchema.safeParse({ mode: "boss", range: "10-20" }).success).toBe(false);
    expect(startRequestSchema.safeParse({}).success).toBe(false);
  });
});
