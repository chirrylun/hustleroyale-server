import { describe, expect, it } from "vitest";
import { createBattle, snapshot, step, submitIntent } from "./battle.js";
import { UNIT_RADIUS } from "./stats.js";
import type { BattleEvent, SkillDef, Stats, UnitInit } from "./types.js";

const melee: SkillDef = { slug: "strike", kind: "damage", damageType: "physical", power: 1, cooldownMs: 1000, staminaCost: 0, range: 2, targetRule: "enemy_nearest", effect: {} };
const bolt: SkillDef = { ...melee, slug: "bolt", damageType: "magical", range: 8 };
const slam: SkillDef = { ...melee, slug: "slam", power: 2, cooldownMs: 6000, staminaCost: 10, effect: { telegraph_ms: 1200, radius: 2.6, knockback: 3, stun_ms: 600 } };
const bash: SkillDef = { ...melee, slug: "bash", power: 0.5, cooldownMs: 6000, staminaCost: 5, effect: { stun_ms: 1500 } };
const hook: SkillDef = { ...melee, slug: "hook", range: 8, effect: { pull: 5 } };
const heal: SkillDef = { slug: "heal", kind: "heal", damageType: "magical", power: 1, cooldownMs: 6000, staminaCost: 12, range: 8, targetRule: "ally_lowest_hp", effect: {} };

const st = (o: Partial<Stats> = {}): Stats => ({ hp: 100, atk: 12, def: 8, spd: 8, stamina: 10, magic: 10, ...o });
const unit = (id: string, side: 1 | 2, role: UnitInit["role"], skills: SkillDef[], o: Partial<Stats> = {}, extra: Partial<UnitInit> = {}): UnitInit => ({
  id, side, name: id, role, stats: st(o), skills, ...extra,
});
type S = ReturnType<typeof createBattle>;
const get = (s: S, id: string) => s.units.find((u) => u.id === id)!;
const put = (s: S, id: string, x: number, y: number) => Object.assign(get(s, id), { x, y });
const run = (s: S, ms: number) => {
  const ev: BattleEvent[] = [];
  for (let t = 0; t < ms && !s.finished; t += 100) ev.push(...step(s, 100));
  return ev;
};
/** Two lone fighters with no skill cooldowns getting in the way, for isolating one mechanic. */
const duel = (a: UnitInit, b: UnitInit, opts: Parameters<typeof createBattle>[2] = { layout: -1 }) => createBattle([a, b], 5, opts);
const noCd = (s: S) => s.units.forEach((u) => (u.cooldowns = u.cooldowns.map(() => 0)));

describe("spacing and cover", () => {
  const team = (side: 1 | 2): UnitInit[] => [
    unit(`${side}t`, side, "tank", [melee], { hp: 400, def: 14 }),
    unit(`${side}d1`, side, "dps", [melee], { atk: 14, hp: 400 }),
    unit(`${side}d2`, side, "dps", [melee], { atk: 14, hp: 400 }),
  ];

  it("bodies never overlap, even in a melee scrum", () => {
    for (const layout of [-1, 0, 1, 2]) {
      const s = createBattle([...team(1), ...team(2)], 9, { layout });
      let tightest = Infinity;
      for (let t = 0; t < 40_000 && !s.finished; t += 100) {
        step(s, 100);
        const live = s.units.filter((u) => u.alive);
        for (let i = 0; i < live.length; i++)
          for (let j = i + 1; j < live.length; j++) tightest = Math.min(tightest, Math.hypot(live[i].x - live[j].x, live[i].y - live[j].y));
      }
      expect(tightest).toBeGreaterThan(UNIT_RADIUS * 2 - 0.4); // worst case is a squeeze between cover
    }
  });

  it("several attackers on one enemy fan out around it instead of stacking", () => {
    const s = createBattle(
      [unit("t", 2, "tank", [melee], { hp: 5000, def: 30, atk: 1 }), unit("a", 1, "dps", [melee], { hp: 900 }), unit("b", 1, "dps", [melee], { hp: 900 }), unit("c", 1, "dps", [melee], { hp: 900 })],
      3,
      { layout: -1 },
    );
    run(s, 14_000);
    const ys = ["a", "b", "c"].map((id) => get(s, id).y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(UNIT_RADIUS * 2); // spread across the target, not in one spot
  });

  it("walks around cover instead of getting stuck behind it", () => {
    // Layout 0 has a pillar dead centre. Put two fighters either side on the same line.
    const s = createBattle([unit("a", 1, "dps", [melee], { hp: 900 }), unit("b", 2, "tank", [melee], { hp: 900, atk: 1 })], 2, { layout: 0 });
    put(s, "a", 9, 10);
    put(s, "b", 25, 10);
    get(s, "b").lockUntil = Infinity; // the target stays put so the only way through is around the pillar
    run(s, 12_000);
    expect(get(s, "a").x).toBeGreaterThan(17); // got past the pillar
    for (const u of s.units) for (const o of s.obstacles) expect(Math.hypot(u.x - o.x, u.y - o.y)).toBeGreaterThanOrEqual(o.r + UNIT_RADIUS - 0.01);
  });

  it("is deterministic: same seed, same fight", () => {
    const go = () => {
      const s = createBattle([...team(1), ...team(2)], 77);
      return JSON.stringify(run(s, 30_000));
    };
    expect(go()).toBe(go());
  });
});

describe("danger zones", () => {
  const caster = () => unit("c", 1, "dps", [melee, slam], { atk: 20 });
  const victim = (extra: Partial<UnitInit> = {}) => unit("v", 2, "tank", [melee], { hp: 500, def: 10, atk: 1 }, extra);

  it("shows the zone first, then lands it after the wind-up", () => {
    const s = duel(caster(), victim(), { layout: -1, dodge: { 2: 0 } });
    put(s, "c", 14, 10);
    put(s, "v", 17, 10);
    noCd(s);
    const ev = run(s, 3000);
    const tele = ev.find((e) => e.type === "telegraph");
    const burst = ev.find((e) => e.type === "burst");
    expect(tele).toBeDefined();
    expect(burst).toBeDefined();
    expect(burst!.t - tele!.t).toBeGreaterThanOrEqual(1200);
    expect(ev.some((e) => e.type === "damage" && e.sourceId === "c" && e.t >= burst!.t)).toBe(true);
  });

  it("misses anyone who walks out in time", () => {
    const s = duel(caster(), victim(), { layout: -1, dodge: { 2: 0 } });
    put(s, "c", 14, 10);
    put(s, "v", 17, 10);
    noCd(s);
    let burst: BattleEvent | undefined;
    for (let t = 0; t < 4000 && !burst; t += 100) {
      const ev = step(s, 100);
      if (ev.some((e) => e.type === "telegraph")) put(s, "v", 17, 17.5); // sidestep out of the circle
      burst = ev.find((e) => e.type === "burst");
    }
    expect(burst).toBeDefined();
    expect(get(s, "v").hp).toBe(get(s, "v").maxHp);
  });

  it("AI fighters sidestep when their dodge roll succeeds, and eat it when it fails", () => {
    const hits = (chance: number) => {
      let took = 0;
      for (let seed = 1; seed <= 25; seed++) {
        const s = createBattle([caster(), victim()], seed, { layout: -1, dodge: { 2: chance } });
        put(s, "c", 14, 10);
        put(s, "v", 17, 10);
        noCd(s);
        const landed = run(s, 3000).find((e) => e.type === "cast" && e.skill === "slam");
        if (landed && landed.type === "cast" && landed.targetIds.includes("v")) took++;
      }
      return took;
    };
    expect(hits(0)).toBeGreaterThan(hits(1));
    expect(hits(1)).toBeLessThan(25);
  });

  it("is rooted while charging, so it can't be kited for free", () => {
    const s = duel(caster(), victim(), { layout: -1, dodge: { 2: 0 } });
    put(s, "c", 14, 10);
    put(s, "v", 17, 10);
    noCd(s);
    run(s, 300);
    const before = { x: get(s, "c").x, y: get(s, "c").y };
    expect(get(s, "c").windup).not.toBeNull();
    run(s, 500);
    expect(get(s, "c").x).toBeCloseTo(before.x, 5);
    expect(get(s, "c").y).toBeCloseTo(before.y, 5);
  });
});

describe("stun, interrupt, knockback and pull", () => {
  it("a stun cancels a charging attack", () => {
    const s = createBattle([unit("c", 1, "dps", [melee, slam], { atk: 20 }), unit("b", 2, "tank", [melee, bash], { hp: 500, atk: 1 })], 4, { layout: -1, dodge: { 2: 0 } });
    put(s, "c", 14, 10);
    put(s, "b", 17, 10);
    noCd(s);
    get(s, "b").cooldowns[1] = 400; // the bash comes online while the slam is charging
    const ev: BattleEvent[] = [];
    for (let t = 0; t < 300; t += 100) ev.push(...step(s, 100));
    expect(get(s, "c").windup).not.toBeNull();
    ev.push(...run(s, 1500)); // the AI sees a charging attack and bashes it
    expect(ev.some((e) => e.type === "stun" && e.targetId === "c")).toBe(true);
    expect(ev.some((e) => e.type === "interrupt" && e.unitId === "c")).toBe(true);
    expect(ev.some((e) => e.type === "burst")).toBe(false);
  });

  it("stunned fighters can't move or attack, then recover, then are briefly immune", () => {
    const s = createBattle([unit("a", 1, "dps", [melee, bash], { atk: 20 }), unit("b", 2, "dps", [melee], { hp: 900, atk: 10 })], 6, { layout: -1 });
    put(s, "a", 14, 10);
    put(s, "b", 17.2, 10);
    noCd(s);
    s.units.find((u) => u.id === "a")!.controlled = true;
    submitIntent(s, "a", { type: "cast", skillIndex: 1 });
    const ev = run(s, 300);
    expect(ev.some((e) => e.type === "stun" && e.targetId === "b")).toBe(true);
    const pos = { x: get(s, "b").x, y: get(s, "b").y };
    const during = run(s, 900);
    expect(during.some((e) => e.type === "damage" && e.sourceId === "b")).toBe(false);
    expect(get(s, "b").x).toBeCloseTo(pos.x, 5);
    // Stun again straight away: refused (immune).
    get(s, "a").cooldowns[1] = 0;
    get(s, "a").energy = 50;
    submitIntent(s, "a", { type: "cast", skillIndex: 1 });
    expect(run(s, 400).some((e) => e.type === "stun" && e.targetId === "b")).toBe(false);
  });

  it("knockback shoves away and stays inside the arena", () => {
    const s = createBattle([unit("a", 1, "dps", [melee, slam], { atk: 20 }), unit("b", 2, "tank", [melee], { hp: 900, atk: 1 })], 8, { layout: -1, dodge: { 2: 0 } });
    put(s, "a", 29, 10);
    put(s, "b", 30.6, 10); // against the right wall
    noCd(s);
    const ev = run(s, 2500);
    const d = ev.find((e) => e.type === "displace");
    for (const u of s.units) expect(u.x).toBeLessThanOrEqual(s.arena.w - UNIT_RADIUS + 1e-6);
    if (d && d.type === "displace") expect(d.x).toBeLessThanOrEqual(s.arena.w);
  });

  it("a pull drags the target in, stopping short of body contact", () => {
    const s = createBattle([unit("a", 1, "tank", [hook], { atk: 10 }), unit("b", 2, "dps", [melee], { hp: 900, atk: 1 })], 8, { layout: -1 });
    put(s, "a", 8, 10);
    put(s, "b", 18, 10);
    noCd(s);
    const ev = run(s, 400);
    const d = ev.find((e) => e.type === "displace");
    expect(d).toBeDefined();
    expect(get(s, "b").x).toBeLessThan(18);
    expect(Math.hypot(get(s, "a").x - get(s, "b").x, get(s, "a").y - get(s, "b").y)).toBeGreaterThanOrEqual(UNIT_RADIUS * 2 - 0.05);
  });
});

describe("damage type matchups", () => {
  const dealt = (attacker: SkillDef, role: UnitInit["role"]) => {
    const s = createBattle(
      [unit("a", 1, "dps", [attacker], { atk: 20, magic: 20 }), unit("b", 2, role, [melee], { hp: 900, atk: 1, def: 10 })],
      1,
      { layout: -1 },
    );
    put(s, "a", 14, 10);
    put(s, "b", 16.5, 10);
    noCd(s);
    const hit = run(s, 400).find((e) => e.type === "damage" && e.sourceId === "a");
    if (!hit || hit.type !== "damage") throw new Error("no hit");
    return hit;
  };

  it("tanks resist physical but not magic, healers the reverse", () => {
    expect(dealt(melee, "tank").amount).toBeLessThan(dealt(melee, "dps").amount);
    expect(dealt(bolt, "tank").amount).toBeGreaterThan(dealt(bolt, "dps").amount);
    expect(dealt(melee, "healer").amount).toBeGreaterThan(dealt(melee, "dps").amount);
    expect(dealt(bolt, "healer").amount).toBeLessThan(dealt(bolt, "dps").amount);
  });

  it("reports the multiplier so the screen can say STRONG or RESISTED", () => {
    expect(dealt(melee, "tank").mult).toBeLessThan(1);
    expect(dealt(bolt, "tank").mult).toBeGreaterThan(1);
    expect(dealt(melee, "dps").mult).toBeUndefined();
  });
});

describe("controlling a fighter", () => {
  it("walks where the player clicks, ignores nonsense, and hands back to the AI on request", () => {
    const s = createBattle([unit("a", 1, "dps", [melee], { hp: 900 }, { controlled: true }), unit("b", 2, "tank", [melee], { hp: 900, atk: 1 })], 3, { layout: -1 });
    put(s, "a", 8, 10);
    put(s, "b", 24, 10);
    expect(submitIntent(s, "a", { type: "move", x: NaN, y: 3 })).toBe(false);
    expect(submitIntent(s, "a", { type: "move", x: 8, y: 17 })).toBe(true);
    run(s, 4000);
    expect(get(s, "a").y).toBeGreaterThan(16);
    expect(get(s, "a").x).toBeLessThan(10); // stayed put horizontally instead of charging the enemy
    submitIntent(s, "a", { type: "move", x: 999, y: -50 });
    run(s, 8000);
    expect(get(s, "a").x).toBeLessThanOrEqual(s.arena.w - UNIT_RADIUS + 1e-6);
    expect(get(s, "a").y).toBeGreaterThanOrEqual(UNIT_RADIUS - 1e-6);
    submitIntent(s, "a", { type: "auto" });
    expect(get(s, "a").manual).toBe(false);
  });

  it("can't give orders to someone else's fighter", () => {
    const s = createBattle([unit("a", 1, "dps", [melee], {}, { controlled: true }), unit("b", 2, "dps", [melee])], 3, { layout: -1 });
    expect(submitIntent(s, "b", { type: "move", x: 5, y: 5 })).toBe(false);
  });
});

describe("sudden death", () => {
  // Two fighters that can't hurt each other: only the ring can end this.
  const stalemate = () =>
    createBattle([unit("a", 1, "healer", [{ ...melee, power: 0 }, heal], { atk: 0, hp: 200 }), unit("b", 2, "healer", [{ ...melee, power: 0 }, heal], { atk: 0, hp: 200 })], 2, {
      layout: -1,
      clock: { regularMs: 5000, shrinkMs: 6000, minRadius: 1 },
    });

  it("warns, starts, and always forces a finish", () => {
    const s = stalemate();
    const ev = run(s, 60_000);
    const phases = ev.filter((e) => e.type === "phase").map((e) => (e.type === "phase" ? e.phase : ""));
    expect(phases).toEqual(["warning", "sudden_death"]);
    expect(ev.some((e) => e.type === "damage" && e.ring)).toBe(true);
    expect(s.finished).toBe(true);
    expect(s.timeMs).toBeLessThan(s.maxDurationMs + 200);
  });

  it("does nothing before it starts and pulls fighters toward the middle once it does", () => {
    const s = stalemate();
    put(s, "a", 2, 2);
    run(s, 4000);
    expect(s.sudden).toBe(false);
    expect(ev(s)).toBeUndefined();
    run(s, 12_000);
    const centre = { x: s.arena.w / 2, y: s.arena.h / 2 };
    const d = (id: string) => Math.hypot(get(s, id).x - centre.x, get(s, id).y - centre.y);
    expect(d("a")).toBeLessThan(10);
  });

  it("halves healing", () => {
    const s = createBattle([unit("h", 1, "healer", [melee, heal], { magic: 20 }), unit("e", 2, "dps", [melee], { atk: 0, hp: 900 })], 3, { layout: -1, clock: { regularMs: 1000, shrinkMs: 9000 } });
    get(s, "h").hp = 10;
    noCd(s);
    const normal = (() => {
      const t = createBattle([unit("h", 1, "healer", [melee, heal], { magic: 20 }), unit("e", 2, "dps", [melee], { atk: 0, hp: 900 })], 3, { layout: -1 });
      get(t, "h").hp = 10;
      noCd(t);
      const e = run(t, 300).find((x) => x.type === "heal");
      return e && e.type === "heal" ? e.amount : 0;
    })();
    s.timeMs = 2000;
    s.sudden = true;
    const e = run(s, 300).find((x) => x.type === "heal");
    expect(e && e.type === "heal" ? e.amount : 0).toBeLessThan(normal);
  });
});

const ev = (s: S) => s.units.find((u) => !u.alive);

describe("snapshot", () => {
  it("includes cover, the match clock and who is stunned or charging", () => {
    const s = createBattle([unit("a", 1, "dps", [melee]), unit("b", 2, "dps", [melee])], 1, { layout: 0 });
    const snap = snapshot(s);
    expect(snap.obstacles.length).toBeGreaterThan(0);
    expect(snap.clock.regularMs).toBe(150_000);
    expect(snap.units[0]).toHaveProperty("stunMs");
    expect(snap.units[0]).toHaveProperty("windup");
  });
});
