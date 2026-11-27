import { describe, expect, it, vi } from "vitest";
import { createBattle, type SkillDef, type UnitInit } from "../../engine/index.js";
import type { BattleEndPayload, UnitMeta } from "./protocol.js";
import { SoloSession, type BattleEmitter } from "./session.js";
import { ArenaStore } from "./arenaStore.js";
import { withSide } from "./team.js";

const basic: SkillDef = { slug: "basic-strike", kind: "damage", damageType: "physical", power: 1, cooldownMs: 1000, staminaCost: 0, range: 2, targetRule: "enemy_nearest", effect: {} };
const unit = (id: string, side: 1 | 2): UnitInit => ({ id, side, name: id, role: "dps", stats: { hp: 100, atk: 12, def: 8, spd: 8, stamina: 10, magic: 10 }, skills: [basic] });
const meta = (u: UnitInit): UnitMeta => ({ id: u.id, side: u.side, name: u.name, role: u.role, spriteKey: "x", grade: null, level: 1, spd: 8, controlled: false, skills: [] });

describe("a fight between two players", () => {
  it("moves a loaded team to the other side", () => {
    const team = { units: [unit("a", 1)], metas: [meta(unit("a", 1))] };
    const flipped = withSide(team, 2);
    expect(flipped.units.every((u) => u.side === 2)).toBe(true);
    expect(flipped.metas.every((m) => m.side === 2)).toBe(true);
  });

  it("lets each player set their own team's stance, with no AI commander on either side", () => {
    const state = createBattle([unit("a", 1), unit("b", 2)], 7);
    const ends: BattleEndPayload[] = [];
    const emitter: BattleEmitter = { start() {}, events() {}, sync() {}, end: (p) => void ends.push(p) };
    const s = new SoloSession({ matchId: "m", userId: "u1", difficulty: "hustler", state, metas: [meta(unit("a", 1)), meta(unit("b", 2))], controlledUnitId: null, enemyTotalHp: 1, store: new ArenaStore(), emitter, onDone: () => {}, pvp: true });
    s.start();
    s.stance("offensive", 1);
    s.stance("defensive", 2);
    expect(state.stances[1]).toBe("offensive");
    expect(state.stances[2]).toBe("defensive");
    s.halt();
  });

  it("gives the win to the player who stays when the other leaves", async () => {
    vi.useFakeTimers();
    const state = createBattle([unit("a", 1), unit("b", 2)], 7);
    const ends: BattleEndPayload[] = [];
    const done = vi.fn();
    const emitter: BattleEmitter = { start() {}, events() {}, sync() {}, end: (p) => void ends.push(p) };
    const s = new SoloSession({ matchId: "m", userId: "u1", difficulty: "hustler", state, metas: [], controlledUnitId: null, enemyTotalHp: 1, store: new ArenaStore(), emitter, onDone: done, pvp: true });
    s.start();
    await s.forfeit(2);
    expect(ends[0]).toMatchObject({ result: "win", winnerSide: 1 });
    expect(done).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
