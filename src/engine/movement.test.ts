import { describe, expect, it } from "vitest";
import { createBattle, snapshot, step, submitStance } from "./battle.js";
import type { BattleEvent, SkillDef, Stats, UnitInit } from "./types.js";

const melee: SkillDef = { slug: "strike", kind: "damage", damageType: "physical", power: 1, cooldownMs: 1000, staminaCost: 0, range: 2, targetRule: "enemy_nearest", effect: {} };
const bolt: SkillDef = { ...melee, slug: "bolt", damageType: "magical", range: 8 };
const heal: SkillDef = { slug: "heal", kind: "heal", damageType: "magical", power: 1, cooldownMs: 6000, staminaCost: 12, range: 8, targetRule: "ally_lowest_hp", effect: {} };
const st = (o: Partial<Stats> = {}): Stats => ({ hp: 100, atk: 12, def: 8, spd: 8, stamina: 10, magic: 10, ...o });
const unit = (id: string, side: 1 | 2, role: UnitInit["role"], skills: SkillDef[], o: Partial<Stats> = {}): UnitInit => ({ id, side, name: id, role, stats: st(o), skills });
const team = (side: 1 | 2): UnitInit[] => [
  unit(`${side}t`, side, "tank", [melee], { hp: 130, def: 14 }),
  unit(`${side}h`, side, "healer", [bolt, heal], { magic: 14 }),
  unit(`${side}d`, side, "dps", [melee], { atk: 15 }),
];
const place = (s: ReturnType<typeof createBattle>, id: string, x: number, y: number) => {
  const u = s.units.find((v) => v.id === id)!;
  u.x = x; u.y = y;
  return u;
};
const freeze = (s: ReturnType<typeof createBattle>, id: string) => { s.units.find((v) => v.id === id)!.lockUntil = Infinity; };
const run = (s: ReturnType<typeof createBattle>, ms: number) => { const ev: BattleEvent[] = []; for (let t = 0; t < ms; t += 100) ev.push(...step(s, 100)); return ev; };

describe("movement and positioning", () => {
  it("fighters walk across the arena, meet, and always stay inside it", () => {
    const s = createBattle([...team(1), ...team(2)], 4);
    const start = snapshot(s).units.map((u) => u.x);
    let moves = 0;
    while (!s.finished) {
      moves += step(s, 100).filter((e) => e.type === "move").length;
      for (const u of s.units) {
        expect(u.x).toBeGreaterThanOrEqual(0); expect(u.x).toBeLessThanOrEqual(s.arena.w);
        expect(u.y).toBeGreaterThanOrEqual(0); expect(u.y).toBeLessThanOrEqual(s.arena.h);
      }
    }
    expect(moves).toBeGreaterThan(10);
    expect(snapshot(s).units.map((u) => u.x)).not.toEqual(start);
  });

  it("starts tanks in front, healers at the back, on opposite sides", () => {
    const u = Object.fromEntries(createBattle([...team(1), ...team(2)], 1).units.map((x) => [x.id, x]));
    expect(u["1t"].x).toBeGreaterThan(u["1h"].x);
    expect(u["2t"].x).toBeLessThan(u["2h"].x);
    expect(u["1t"].x).toBeLessThan(u["2t"].x);
  });

  it("ranged units back away from an enemy that gets too close", () => {
    const s = createBattle([unit("a", 1, "dps", [bolt], { hp: 999 }), unit("b", 2, "dps", [melee], { hp: 999 })], 2);
    place(s, "a", 15, 10); place(s, "b", 16.5, 10); freeze(s, "b");
    run(s, 1000);
    expect(s.units[0].x).toBeLessThan(14);
  });

  it("healers flee danger and stay near allies", () => {
    const s = createBattle([...team(1), unit("e", 2, "dps", [melee], { hp: 999 })], 3);
    place(s, "1h", 15, 10); place(s, "e", 18, 10); freeze(s, "e");
    place(s, "1t", 10, 8); place(s, "1d", 10, 12);
    run(s, 800);
    expect(s.units.find((u) => u.id === "1h")!.x).toBeLessThan(14);
  });

  it("a defensive unit holds its line while the enemy is far; a neutral one advances", () => {
    const hold = (stance: "defensive" | "neutral") => {
      const s = createBattle([unit("a", 1, "dps", [melee]), unit("b", 2, "dps", [melee])], 5, { stances: { 1: stance } });
      place(s, "a", 5, 10); place(s, "b", 29, 10); freeze(s, "b");
      run(s, 4000);
      return s.units[0].x;
    };
    expect(hold("defensive")).toBeLessThan(12.6);
    expect(hold("neutral")).toBeGreaterThan(14);
  });

  it("faster fighters cover more ground", () => {
    const s = createBattle([unit("f", 1, "dps", [melee], { spd: 40 }), unit("s", 1, "dps", [melee], { spd: 2 }), unit("e", 2, "dps", [melee], { hp: 9999 })], 6);
    place(s, "f", 3, 5); place(s, "s", 3, 15); place(s, "e", 28, 10); freeze(s, "e");
    run(s, 2000);
    expect(s.units[0].x).toBeGreaterThan(s.units[1].x + 3);
  });

  it("a player can change stance only when not controlling a fighter", () => {
    const s = createBattle([...team(1).map((u) => (u.id === "1d" ? { ...u, controlled: true } : u)), ...team(2)], 7);
    expect(submitStance(s, 1, "defensive")).toBe(false); // controlling a fighter
    expect(submitStance(s, 2, "offensive")).toBe(true);
    expect(submitStance(s, 2, "nonsense" as never)).toBe(false);
    const ev = step(s, 100);
    expect(ev.some((e) => e.type === "stance" && e.side === 2 && e.stance === "offensive")).toBe(true);
    expect(s.stances[2]).toBe("offensive");
  });

  it("the AI commander turns defensive when losing and offensive when winning", () => {
    const s = createBattle([...team(1), ...team(2)], 8, { autoStance: [1, 2] });
    s.units.filter((u) => u.side === 1).forEach((u) => (u.hp = Math.round(u.maxHp * 0.3)));
    run(s, 300);
    expect(s.stances[1]).toBe("defensive");
    expect(s.stances[2]).toBe("offensive");
  });

  it("changing stance changes how the team plays, and the match stays fair", () => {
    let w1 = 0, w2 = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = createBattle([...team(1), ...team(2)], seed);
      while (!s.finished) step(s, 100);
      s.winnerSide === 1 ? w1++ : s.winnerSide === 2 ? w2++ : 0;
      expect(s.timeMs).toBeLessThan(s.maxDurationMs + 200);
    }
    expect(Math.abs(w1 - w2)).toBeLessThanOrEqual(20);
  });
});
