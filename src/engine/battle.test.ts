import { describe, expect, it } from "vitest";
import { createBattle, step, submitIntent } from "./battle.js";
import type { BattleEvent, SkillDef, Stats, UnitInit } from "./types.js";

const basic: SkillDef = {
  slug: "basic-strike", kind: "damage", damageType: "physical", power: 1,
  cooldownMs: 1000, staminaCost: 0, range: 2, targetRule: "enemy_nearest", effect: {},
};
const slam: SkillDef = {
  slug: "power-slam", kind: "damage", damageType: "physical", power: 1.8,
  cooldownMs: 7000, staminaCost: 15, range: 2, targetRule: "enemy_nearest", effect: {},
};
const heal: SkillDef = {
  slug: "heal-pulse", kind: "heal", damageType: "magical", power: 1.1,
  cooldownMs: 6000, staminaCost: 12, range: 8, targetRule: "ally_lowest_hp", effect: {},
};

const stats = (over: Partial<Stats> = {}): Stats => ({ hp: 100, atk: 12, def: 8, spd: 8, stamina: 10, magic: 10, ...over });

function team(side: 1 | 2, over: Partial<Stats> = {}): UnitInit[] {
  return [
    { id: `s${side}-tank`, side, name: "Tank", role: "tank", stats: stats({ hp: 130, def: 14, ...over }), skills: [basic] },
    { id: `s${side}-heal`, side, name: "Healer", role: "healer", stats: stats({ magic: 14, ...over }), skills: [basic, heal] },
    { id: `s${side}-dps`, side, name: "DPS", role: "dps", stats: stats({ atk: 15, ...over }), skills: [basic, slam] },
  ];
}

function run(units: UnitInit[], seed: number, maxTicks = 3000): { events: BattleEvent[]; state: ReturnType<typeof createBattle> } {
  const state = createBattle(units, seed);
  const events: BattleEvent[] = [];
  for (let i = 0; i < maxTicks && !state.finished; i++) events.push(...step(state, 100));
  return { events, state };
}

describe("battle engine", () => {
  it("is deterministic for the same seed", () => {
    const a = run([...team(1), ...team(2)], 42);
    const b = run([...team(1), ...team(2)], 42);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it("finishes with an end event and a result", () => {
    const { events, state } = run([...team(1), ...team(2, { atk: 6 })], 7);
    expect(state.finished).toBe(true);
    expect(events.at(-1)?.type).toBe("end");
  });

  it("lets the stronger team win", () => {
    const { state } = run([...team(1, { atk: 25, hp: 200 }), ...team(2)], 3);
    expect(state.winnerSide).toBe(1);
  });

  it("faster fighters act more often", () => {
    const duel = (spd1: number, spd2: number) => {
      const units: UnitInit[] = [
        { id: "a", side: 1, name: "A", role: "dps", stats: stats({ hp: 99999, spd: spd1 }), skills: [basic] },
        { id: "b", side: 2, name: "B", role: "dps", stats: stats({ hp: 99999, spd: spd2 }), skills: [basic] },
      ];
      const state = createBattle(units, 5, { maxDurationMs: 20_000 });
      const casts = { a: 0, b: 0 };
      while (!state.finished) {
        for (const e of step(state, 100)) if (e.type === "cast") casts[e.actorId as "a" | "b"]++;
      }
      return casts;
    };
    const { a, b } = duel(40, 5);
    expect(a).toBeGreaterThan(b);
  });

  it("only lets a player trigger specials on the unit they control, and only when legal", () => {
    const units = team(1, { hp: 3000 }).map((u) => (u.id === "s1-dps" ? { ...u, controlled: true } : u));
    const state = createBattle([...units, ...team(2, { hp: 3000 })], 11);
    expect(submitIntent(state, "s1-tank", { type: "cast", skillIndex: 0 })).toBe(false); // not controlled
    expect(submitIntent(state, "s1-dps", { type: "cast", skillIndex: 9 })).toBe(false); // no such skill
    expect(submitIntent(state, "s1-dps", { type: "focus", targetId: "s1-heal" })).toBe(false); // ally
    expect(submitIntent(state, "s1-dps", { type: "focus", targetId: "s2-heal" })).toBe(true);

    // A controlled unit never auto-casts its special, only the basic attack.
    const autoSpecials: BattleEvent[] = [];
    for (let i = 0; i < 80 && !state.finished; i++) {
      autoSpecials.push(...step(state, 100).filter((e) => e.type === "cast" && e.actorId === "s1-dps" && e.skillIndex === 1));
    }
    expect(autoSpecials.length).toBe(0);

    // The queued intent fires once the skill is ready.
    expect(submitIntent(state, "s1-dps", { type: "cast", skillIndex: 1 })).toBe(true);
    const fired: BattleEvent[] = [];
    for (let i = 0; i < 40; i++) fired.push(...step(state, 100).filter((e) => e.type === "cast" && e.actorId === "s1-dps" && e.skillIndex === 1));
    expect(fired.length).toBe(1);
  });
});
