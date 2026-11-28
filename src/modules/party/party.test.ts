import { describe, expect, it } from "vitest";
import { PartyManager, pickLootWinner, type PartyMember } from "./party.js";

const m = (uid: string, level = 15): PartyMember => ({ uid, name: uid, level });
const rules = { open: true, min: 10, max: 20 };

describe("parties", () => {
  it("starts with the host and fills to four", () => {
    const pm = new PartyManager();
    const r = pm.create(m("a"), rules);
    expect(r.ok).toBe(true);
    const id = r.ok ? r.party.id : "";
    for (const u of ["b", "c", "d"]) expect(pm.join(m(u), id).ok).toBe(true);
    expect(pm.join(m("e"), id)).toMatchObject({ ok: false, error: "full" });
  });
  it("tells players outside the level range", () => {
    const pm = new PartyManager();
    const id = (pm.create(m("a"), rules) as { party: { id: string } }).party.id;
    expect(pm.join(m("b", 5), id)).toMatchObject({ ok: false, error: "level_low", min: 10, max: 20 });
    expect(pm.join(m("c", 30), id)).toMatchObject({ ok: false, error: "level_high" });
  });
  it("checks the password on a locked party", () => {
    const pm = new PartyManager();
    const id = (pm.create(m("a"), { open: false, password: "Secret1", min: 1, max: 99 }) as { party: { id: string } }).party.id;
    expect(pm.join(m("b"), id, "nope")).toMatchObject({ ok: false, error: "wrong_password" });
    expect(pm.join(m("b"), id, "Secret1").ok).toBe(true);
    expect(pm.create(m("z"), { open: false, password: "  ", min: 1, max: 9 })).toMatchObject({ ok: false, error: "bad_password" });
  });
  it("lets the host put the request down without removing members, and edit the rules", () => {
    const pm = new PartyManager();
    const id = (pm.create(m("a"), rules) as { party: { id: string } }).party.id;
    pm.join(m("b"), id);
    expect(pm.edit("a", { ...rules, recruiting: false }).ok).toBe(true);
    expect(pm.join(m("c"), id)).toMatchObject({ ok: false, error: "closed" });
    expect(pm.partyOf("b")?.members).toHaveLength(2);
    expect(pm.edit("b", rules)).toMatchObject({ ok: false, error: "not_host" });
    expect(pm.edit("a", { open: false, password: "pw", min: 12, max: 18, recruiting: true }).ok).toBe(true);
    expect(pm.partyOf("a")).toMatchObject({ min: 12, max: 18, password: "pw", recruiting: true });
  });
  it("only the host kicks or disbands; the host leaving passes the party on", () => {
    const pm = new PartyManager();
    const id = (pm.create(m("a"), rules) as { party: { id: string } }).party.id;
    pm.join(m("b"), id); pm.join(m("c"), id);
    expect(pm.kick("b", "c")).toMatchObject({ ok: false, error: "not_host" });
    expect(pm.kick("a", "c").ok).toBe(true);
    expect(pm.partyOf("c")).toBeUndefined();
    pm.leave("a");
    expect(pm.partyOf("b")?.host).toBe("b");
    expect(pm.disband("b").ok).toBe(true);
    expect(pm.partyOf("b")).toBeUndefined();
    expect(pm.all()).toHaveLength(0);
  });
});

describe("loot winner", () => {
  it("favours the biggest damage dealer but gives everyone a chance", () => {
    const dmg = new Map([["a", 900], ["b", 100], ["c", 0]]);
    const wins: Record<string, number> = { a: 0, b: 0, c: 0 };
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 6000; i++) wins[pickLootWinner(["a", "b", "c"], dmg, rnd)]++;
    expect(wins.a).toBeGreaterThan(wins.b);
    expect(wins.b).toBeGreaterThan(wins.c);
    expect(wins.c).toBeGreaterThan(300); // a member who did no damage still has a real chance
  });
  it("a lone member always wins", () => { expect(pickLootWinner(["x"], new Map())).toBe("x"); });
});
