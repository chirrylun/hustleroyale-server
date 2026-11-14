import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBattle, type BattleEvent, type SkillDef, type Stats, type UnitInit } from "../../engine/index.js";
import type { BattleEndPayload, BattleStartPayload, RewardSummary, UnitMeta } from "./protocol.js";
import { DIFFICULTY_CONFIG } from "./rewards.js";
import { SoloSession, type BattleEmitter } from "./session.js";
import type { BattleStore, SettleArgs } from "./store.js";

const basic: SkillDef = {
  slug: "basic-strike", kind: "damage", damageType: "physical", power: 1,
  cooldownMs: 1000, staminaCost: 0, range: 2, targetRule: "enemy_nearest", effect: {},
};
const slam: SkillDef = {
  slug: "power-slam", kind: "damage", damageType: "physical", power: 1.8,
  cooldownMs: 7000, staminaCost: 15, range: 2, targetRule: "enemy_nearest", effect: {},
};

const stats = (over: Partial<Stats> = {}): Stats => ({ hp: 100, atk: 12, def: 8, spd: 8, stamina: 10, magic: 10, ...over });

function team(side: 1 | 2, over: Partial<Stats> = {}, controlled = false): UnitInit[] {
  return [
    { id: `s${side}-tank`, side, name: "Tank", role: "tank", stats: stats({ hp: 130, def: 14, ...over }), skills: [basic] },
    { id: `s${side}-dps`, side, name: "DPS", role: "dps", stats: stats({ atk: 15, ...over }), skills: [basic, slam], controlled },
  ];
}

const metaOf = (u: UnitInit): UnitMeta => ({
  id: u.id, side: u.side, name: u.name, role: u.role, spriteKey: "danfo_guard", grade: null, level: 1, spd: u.stats.spd,
  controlled: !!u.controlled, skills: [],
});

const reward = (coins: number): RewardSummary => ({
  coinsEarned: coins, base: coins, multiplier: 1, dailyCap: 250, earnedToday: coins, paidMatchesToday: 1, capped: false, balance: 500 + coins,
});

function fakeStore(over: Partial<BattleStore> = {}) {
  const settled: SettleArgs[] = [];
  const store: BattleStore & { settled: SettleArgs[]; logs: string[]; abandoned: string[] } = {
    settled,
    logs: [],
    abandoned: [],
    startMatch: async () => "m1",
    settleMatch: async (a) => {
      settled.push(a);
      return reward(a.baseReward);
    },
    saveLog: async (id) => void store.logs.push(id),
    abandon: async (id) => void store.abandoned.push(id),
    ...over,
  };
  return store;
}

function setup(units: UnitInit[], storeOver: Partial<BattleStore> = {}, controlledUnitId: string | null = null) {
  const store = fakeStore(storeOver);
  const started: BattleStartPayload[] = [];
  const events: BattleEvent[] = [];
  const ends: BattleEndPayload[] = [];
  let syncs = 0;
  let done = 0;
  const emitter: BattleEmitter = {
    start: (p) => void started.push(p),
    events: (p) => void events.push(...p.events),
    sync: () => void syncs++,
    end: (p) => void ends.push(p),
  };
  const state = createBattle(units, 11, { autoStance: [2] });
  const session = new SoloSession({
    matchId: "m1",
    userId: "u1",
    difficulty: "hustler",
    state,
    metas: units.map(metaOf),
    controlledUnitId,
    enemyTotalHp: units.filter((u) => u.side === 2).reduce((s, u) => s + u.stats.hp, 0),
    store,
    emitter,
    onDone: () => void done++,
  });
  return { session, store, started, events, ends, done: () => done, syncs: () => syncs };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SoloSession", () => {
  it("runs a real fight to the end, settles once, and stops ticking", async () => {
    // Strong enough to win, tanky enough that the fight lasts well past the 20 second minimum.
    const t = setup([...team(1, { atk: 18, hp: 320, def: 12 }), ...team(2, { hp: 420, atk: 5 })]);
    t.session.start();
    await vi.advanceTimersByTimeAsync(180_000);

    expect(t.started).toHaveLength(1);
    expect(t.started[0]?.snapshot.units).toHaveLength(4);
    expect(t.ends).toHaveLength(1);
    const end = t.ends[0]!;
    expect(end.result).toBe("win");
    expect(end.durationMs).toBeGreaterThanOrEqual(20_000);
    expect(end.reward?.coinsEarned).toBe(DIFFICULTY_CONFIG.hustler.win);

    expect(t.store.settled).toHaveLength(1);
    expect(t.store.settled[0]).toMatchObject({ matchId: "m1", userId: "u1", winnerSide: 1, baseReward: DIFFICULTY_CONFIG.hustler.win });
    expect(t.store.settled[0]!.damageDealt).toBeGreaterThan(0);
    expect(t.store.logs).toEqual(["m1"]);
    expect(t.events.at(-1)?.type).toBe("end");
    expect(t.syncs()).toBeGreaterThan(0);
    expect(t.done()).toBe(1);

    const seen = t.events.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.events.length).toBe(seen); // the loop is really stopped
  });

  it("pays nothing for a win that was over almost instantly", async () => {
    const t = setup([...team(1, { atk: 300, hp: 900 }), ...team(2, { hp: 40 })]);
    t.session.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(t.ends[0]?.result).toBe("win");
    expect(t.ends[0]!.durationMs).toBeLessThan(20_000);
    expect(t.store.settled[0]?.baseReward).toBe(0);
  });

  it("still ends the match when the payout can't be recorded", async () => {
    const t = setup([...team(1, { atk: 18, hp: 320, def: 12 }), ...team(2, { hp: 420, atk: 5 })], {
      settleMatch: async () => {
        throw new Error("db down");
      },
    });
    t.session.start();
    await vi.advanceTimersByTimeAsync(180_000);

    expect(t.ends).toHaveLength(1);
    expect(t.ends[0]?.reward).toBeNull();
    expect(t.store.logs).toEqual(["m1"]);
    expect(t.done()).toBe(1);
  });

  it("abandoning stops the loop with no result and no payout", async () => {
    const t = setup([...team(1), ...team(2)]);
    t.session.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await t.session.abandon();
    const seen = t.events.length;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(t.store.abandoned).toEqual(["m1"]);
    expect(t.store.settled).toHaveLength(0);
    expect(t.ends).toHaveLength(0);
    expect(t.events.length).toBe(seen);
    expect(t.done()).toBe(1);
  });

  it("ignores malformed input from the browser instead of crashing", async () => {
    const t = setup([...team(1, {}, true), ...team(2)], {}, "s1-dps");
    t.session.start();
    for (const junk of [null, 42, "cast", {}, { type: "cast", skillIndex: -1 }, { type: "cast", skillIndex: 99 }, { type: "focus" }]) {
      expect(() => t.session.intent(junk)).not.toThrow();
    }
    expect(() => t.session.stance("sideways")).not.toThrow();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.ends).toHaveLength(0);
  });

  it("only lets the player set a stance when they are not steering a fighter", async () => {
    const spectator = setup([...team(1), ...team(2)]);
    spectator.session.start();
    spectator.session.stance("defensive");
    await vi.advanceTimersByTimeAsync(300);
    expect(spectator.events.some((e) => e.type === "stance" && e.side === 1 && e.stance === "defensive")).toBe(true);

    const driver = setup([...team(1, {}, true), ...team(2)], {}, "s1-dps");
    driver.session.start();
    driver.session.stance("defensive");
    await vi.advanceTimersByTimeAsync(300);
    expect(driver.events.some((e) => e.type === "stance" && e.side === 1 && e.stance === "defensive")).toBe(false);
  });
});

describe("a fight that waits for Start", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays frozen until begin(), then runs", () => {
    const { session, started, events, ends } = setup([...team(1, {}, true), ...team(2)], {}, "s1-dps");
    session.start({ awaitStart: true });
    expect(started).toHaveLength(1);
    expect(started[0]!.awaitingStart).toBe(true);
    expect(session.awaitingStart).toBe(true);

    vi.advanceTimersByTime(30_000);
    expect(events).toHaveLength(0);
    expect(ends).toHaveLength(0);

    expect(session.begin()).toBe(true);
    expect(session.awaitingStart).toBe(false);
    expect(session.startPayload().awaitingStart).toBeUndefined();
    vi.advanceTimersByTime(5_000);
    expect(events.length).toBeGreaterThan(0);
    session.halt();
  });

  it("ignores moves and stances before Start", () => {
    const { session } = setup([...team(1, {}, true), ...team(2)], {}, "s1-dps");
    session.start({ awaitStart: true });
    session.intent({ type: "move", x: 3, y: 3 });
    session.stance("offensive");
    const unit = (session as unknown as { o: { state: { units: { id: string; intent?: unknown }[] } } }).o.state.units.find((u) => u.id === "s1-dps")!;
    expect(unit.intent).toBeFalsy();
    session.halt();
  });

  it("begin() is a no-op when running or after being dropped", async () => {
    const a = setup([...team(1), ...team(2)]);
    a.session.start();
    expect(a.session.begin()).toBe(false);
    a.session.halt();

    const b = setup([...team(1), ...team(2)]);
    b.session.start({ awaitStart: true });
    await b.session.abandon();
    expect(b.session.begin()).toBe(false);
    expect(b.done()).toBe(1);
  });

  it("is dropped if the player never presses Start", async () => {
    const { session, done, store } = setup([...team(1), ...team(2)]);
    session.start({ awaitStart: true });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(done()).toBe(1);
    expect(store.abandoned).toEqual(["m1"]);
  });
});
