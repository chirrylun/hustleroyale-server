import { randomBytes } from "node:crypto";

export const PARTY_MAX = 4;
export const PASSWORD_MAX = 10;
export const LEVEL_MAX = 99;

export type PartyError =
  | "in_party" | "no_party" | "not_host" | "not_member" | "no_such" | "full" | "closed"
  | "wrong_password" | "level_low" | "level_high" | "bad_range" | "bad_password" | "no_target";

export interface PartyMember { uid: string; name: string; level: number }
export interface Party {
  id: string;
  host: string;
  members: PartyMember[];
  /** Anyone may join an open party; otherwise they need the password. */
  open: boolean;
  password: string;
  min: number;
  max: number;
  /** The host is looking for members (the join icon over their head, and a place in the room's list). */
  recruiting: boolean;
}

export interface PartyOptions { open: boolean; password?: string; min: number; max: number; recruiting?: boolean }
export type Result<T> = ({ ok: true } & T) | { ok: false; error: PartyError; min?: number; max?: number };

const cleanPassword = (p: string | undefined) => (p ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, PASSWORD_MAX);

function checkOptions(o: PartyOptions): PartyError | null {
  if (!Number.isInteger(o.min) || !Number.isInteger(o.max) || o.min < 1 || o.max > LEVEL_MAX || o.min > o.max) return "bad_range";
  if (!o.open && !cleanPassword(o.password)) return "bad_password";
  return null;
}

/** Parties of up to four players. Nothing here touches sockets or the database: callers say who is acting and which players to tell. */
export class PartyManager {
  private parties = new Map<string, Party>();
  private of = new Map<string, string>();

  partyOf(uid: string): Party | undefined {
    const id = this.of.get(uid);
    return id ? this.parties.get(id) : undefined;
  }
  get(id: string) { return this.parties.get(id); }
  all() { return [...this.parties.values()]; }

  /** Start a party with you as host. */
  create(me: PartyMember, o: PartyOptions): Result<{ party: Party }> {
    if (this.of.has(me.uid)) return { ok: false, error: "in_party" };
    const bad = checkOptions(o);
    if (bad) return { ok: false, error: bad };
    const party: Party = { id: randomBytes(5).toString("hex"), host: me.uid, members: [me], open: o.open, password: o.open ? "" : cleanPassword(o.password), min: o.min, max: o.max, recruiting: o.recruiting ?? true };
    this.parties.set(party.id, party);
    this.of.set(me.uid, party.id);
    return { ok: true, party };
  }

  /** Join a recruiting party. The level range and the password are checked here. */
  join(me: PartyMember, id: string, password?: string, invited = false): Result<{ party: Party }> {
    if (this.of.has(me.uid)) return { ok: false, error: "in_party" };
    const p = this.parties.get(id);
    if (!p) return { ok: false, error: "no_such" };
    if (p.members.length >= PARTY_MAX) return { ok: false, error: "full" };
    if (!invited) { // an invitation from the host skips the request rules
      if (!p.recruiting) return { ok: false, error: "closed" };
      if (me.level < p.min) return { ok: false, error: "level_low", min: p.min, max: p.max };
      if (me.level > p.max) return { ok: false, error: "level_high", min: p.min, max: p.max };
      if (!p.open && cleanPassword(password) !== p.password) return { ok: false, error: "wrong_password" };
    }
    p.members.push(me);
    this.of.set(me.uid, p.id);
    return { ok: true, party: p };
  }

  /** The host changes the rules or opens/closes the request. Members who are already in stay in. */
  edit(host: string, o: PartyOptions): Result<{ party: Party }> {
    const p = this.partyOf(host);
    if (!p) return { ok: false, error: "no_party" };
    if (p.host !== host) return { ok: false, error: "not_host" };
    const bad = checkOptions(o);
    if (bad) return { ok: false, error: bad };
    p.open = o.open; p.password = o.open ? "" : cleanPassword(o.password); p.min = o.min; p.max = o.max;
    if (o.recruiting !== undefined) p.recruiting = o.recruiting;
    return { ok: true, party: p };
  }

  /** Leave your party. The host leaving hands the party to the next member; the last one out closes it. */
  leave(uid: string): Result<{ left: Party; party: Party | null }> {
    const p = this.partyOf(uid);
    if (!p) return { ok: false, error: "no_party" };
    this.of.delete(uid);
    p.members = p.members.filter((m) => m.uid !== uid);
    if (!p.members.length) { this.parties.delete(p.id); return { ok: true, left: p, party: null }; }
    if (p.host === uid) p.host = p.members[0].uid;
    return { ok: true, left: p, party: p };
  }

  kick(host: string, target: string): Result<{ party: Party }> {
    const p = this.partyOf(host);
    if (!p) return { ok: false, error: "no_party" };
    if (p.host !== host) return { ok: false, error: "not_host" };
    if (target === host || !p.members.some((m) => m.uid === target)) return { ok: false, error: "no_target" };
    p.members = p.members.filter((m) => m.uid !== target);
    this.of.delete(target);
    return { ok: true, party: p };
  }

  /** The host closes the party: everyone is out. Returns the members who were in it. */
  disband(host: string): Result<{ party: Party }> {
    const p = this.partyOf(host);
    if (!p) return { ok: false, error: "no_party" };
    if (p.host !== host) return { ok: false, error: "not_host" };
    for (const m of p.members) this.of.delete(m.uid);
    this.parties.delete(p.id);
    return { ok: true, party: p };
  }
}

/**
 * Who gets the drops from a kill: a weighted draw among the party members who are in the room. A member's weight is the damage they did,
 * but never less than a quarter of the average, so healers and tanks who barely scratched it still have a real chance.
 */
export function pickLootWinner(present: string[], damage: ReadonlyMap<string, number>, rnd: () => number = Math.random): string {
  if (present.length === 1) return present[0];
  const dealt = present.map((u) => damage.get(u) ?? 0);
  const avg = dealt.reduce((a, b) => a + b, 0) / present.length;
  const floor = avg > 0 ? avg * 0.25 : 1;
  const weights = dealt.map((d) => Math.max(d, floor));
  let roll = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < present.length; i++) { roll -= weights[i]; if (roll < 0) return present[i]; }
  return present[present.length - 1];
}

export interface InviteInfo { from: string; name: string; level: number; classes: { archetype: string; level: number }[]; t: number }

/** Party invitations waiting for an answer. They lapse after a minute. */
export class InviteBook {
  private book = new Map<string, Map<string, InviteInfo>>();
  constructor(private ttlMs = 60_000) {}

  add(to: string, info: InviteInfo) {
    const m = this.book.get(to) ?? this.book.set(to, new Map()).get(to)!;
    m.set(info.from, info);
  }
  /** Live invitations for a player, newest first. */
  list(to: string, now = Date.now()): InviteInfo[] {
    const m = this.book.get(to);
    if (!m) return [];
    for (const [k, v] of m) if (now - v.t > this.ttlMs) m.delete(k);
    return [...m.values()].sort((a, b) => b.t - a.t);
  }
  /** Take (and remove) one invitation if it is still good. */
  take(to: string, from: string, now = Date.now()): InviteInfo | null {
    const hit = this.list(to, now).find((i) => i.from === from) ?? null;
    if (hit) this.book.get(to)?.delete(from);
    return hit;
  }
  /** Was this player invited by that one a moment ago? (To stop invite spam.) */
  recent(to: string, from: string, withinMs: number, now = Date.now()): boolean {
    const i = this.book.get(to)?.get(from);
    return !!i && now - i.t < withinMs;
  }
  clear(to: string) { this.book.delete(to); }
}
