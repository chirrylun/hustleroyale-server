import type { SupabaseClient } from "@supabase/supabase-js";
import type { Namespace, Server, Socket } from "socket.io";
import { z } from "zod";
import { verifyAccessToken } from "../../plugins/auth.js";
import type { RoomManager } from "../rooms/manager.js";
import { InviteBook, PARTY_MAX, type InviteInfo, type Party, type PartyError, type PartyManager, type PartyOptions } from "../party/party.js";

export const MAX_CHAT = 160;
const sayBody = z.object({ scope: z.enum(["world", "room", "party", "whisper"]), text: z.string().max(400), to: z.string().min(1).max(32).optional() });

/** One line of chat: no control characters or line breaks, single spaces, at most MAX_CHAT characters. Empty means "nothing to send". */
export function cleanChat(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_CHAT);
}

/** At most `max` messages per `windowMs`, and the same text twice in a row within `dupMs` is dropped. */
export class ChatLimiter {
  private times: number[] = [];
  private last = { text: "", at: 0 };
  constructor(private max = 5, private windowMs = 8000, private dupMs = 5000) {}
  allow(text: string, now = Date.now()): "ok" | "slow" | "dup" {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    if (this.times.length >= this.max) return "slow";
    if (text === this.last.text && now - this.last.at < this.dupMs) return "dup";
    this.times.push(now);
    this.last = { text, at: now };
    return "ok";
  }
}

export interface ChatDeps {
  io: Server;
  supabase: SupabaseClient;
  rooms: RoomManager;
  parties: PartyManager;
  log: { error: (obj: unknown, msg?: string) => void };
}

/**
 * The `/chat` namespace: chat and parties (they share a connection and the player's name). World goes to everyone connected, Room to everyone in the sender's shared room (the lobby or a floor room
 * from the `/floor` namespace), Whisper to one player by name. Nothing is stored: chat is live only.
 */
export function registerChatNamespace({ io, supabase, rooms, parties, log }: ChatDeps): Namespace {
  const ns: Namespace = io.of("/chat");
  const userRoom = (uid: string) => `u:${uid}`;
  let seq = 0;


  // ---- Parties ---------------------------------------------------------------------------------------------------------------------
  const levels = new Map<string, { level: number; at: number }>();
  /** A player's level for party rules: their strongest fighter on the team. */
  const levelOf = async (uid: string): Promise<number> => {
    const hit = levels.get(uid);
    if (hit && Date.now() - hit.at < 30_000) return hit.level;
    const { data } = await supabase.from("fighters").select("level").eq("owner_id", uid).gt("team_slot", 0).order("level", { ascending: false }).limit(1);
    const level = (data?.[0]?.level as number | undefined) ?? 1;
    levels.set(uid, { level, at: Date.now() });
    return level;
  };
  const hostRoom = (uid: string) => { const r = rooms.roomOf(uid); return r ? { floor: r.floor, code: r.code } : null; };
  /** What a member sees of their party. The password is for the host's eyes only. */
  const view = (p: Party, forUid: string) => ({
    id: p.id, host: p.host, members: p.members, open: p.open, min: p.min, max: p.max, recruiting: p.recruiting, full: p.members.length >= PARTY_MAX,
    password: forUid === p.host ? p.password : undefined, room: hostRoom(p.host),
  });
  const push = (uids: string[], party: Party | null, note?: string) => {
    for (const u of uids) ns.to(userRoom(u)).emit("party", { party: party ? view(party, u) : null, note });
  };
  const fail = (r: { error: PartyError; min?: number; max?: number }) => ({ error: r.error, min: r.min, max: r.max });
  const optionsSchema = z.object({ open: z.boolean(), password: z.string().max(40).optional(), min: z.number().int(), max: z.number().int(), recruiting: z.boolean().optional() });
  const idSchema = z.object({ id: z.string().min(4).max(40), password: z.string().max(40).optional() });
  const uidSchema = z.object({ uid: z.string().min(1).max(60) });
  const leaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const invites = new InviteBook();
  const online = async (uid: string) => (await ns.in(userRoom(uid)).fetchSockets()).length > 0;
  /** Who is asking: their level and the classes of the fighters they bring, for the invitation box. */
  const describe = async (uid: string, name: string): Promise<InviteInfo> => {
    const { data } = await supabase.from("fighters").select("level, template:fighter_templates(archetype)").eq("owner_id", uid).gt("team_slot", 0).order("team_slot");
    const classes = ((data ?? []) as unknown as { level: number; template: { archetype: string } | { archetype: string }[] | null }[])
      .map((f) => ({ archetype: (Array.isArray(f.template) ? f.template[0] : f.template)?.archetype ?? "novice", level: f.level }));
    return { from: uid, name, level: Math.max(1, ...classes.map((c) => c.level)), classes, t: Date.now() };
  };
  const sendInvites = (uid: string) => ns.to(userRoom(uid)).emit("invites", invites.list(uid));

  /** Open parties in the player's own room that they could still join. */
  const nearby = async (uid: string) => {
    const mine = rooms.roomOf(uid);
    if (!mine || parties.partyOf(uid)) return [];
    const level = await levelOf(uid);
    return parties.all()
      .filter((p) => p.recruiting && p.members.length < PARTY_MAX && p.host !== uid && rooms.roomOf(p.host)?.id === mine.id)
      .map((p) => ({ id: p.id, host: p.host, hostName: p.members.find((m) => m.uid === p.host)?.name ?? "Player", n: p.members.length, open: p.open, min: p.min, max: p.max, fits: level >= p.min && level <= p.max }));
  };

  ns.use(async (socket, next) => {
    const user = await verifyAccessToken(supabase, socket.handshake.auth?.token as string | undefined);
    if (!user) return next(new Error("unauthorized"));
    socket.data.uid = user.id;
    next();
  });

  const nameOf = async (uid: string): Promise<string | null> => {
    const { data } = await supabase.from("profiles").select("username").eq("id", uid).maybeSingle();
    return (data?.username as string | undefined) ?? null;
  };

  ns.on("connection", async (socket: Socket) => {
    const uid = socket.data.uid as string;
    socket.join(userRoom(uid));
    const limiter = new ChatLimiter();
    let name: string | null = null;
    try { name = await nameOf(uid); } catch (e) { log.error({ err: e }, "chat name lookup failed"); }
    socket.emit("ready", { name, online: ns.sockets.size });

    socket.on("say", async (raw: unknown, ack?: (r: unknown) => void) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const body = sayBody.safeParse(raw);
      if (!body.success) return reply({ error: "bad_request" });
      const text = cleanChat(body.data.text);
      if (!text) return reply({ error: "empty" });
      try {
        name ??= await nameOf(uid);
        if (!name) return reply({ error: "no_name" });
        const verdict = limiter.allow(text);
        if (verdict !== "ok") return reply({ error: verdict });
        const msg = { id: `${Date.now().toString(36)}${(seq++).toString(36)}`, s: body.data.scope, from: name, text, t: Date.now() } as Record<string, unknown>;

        if (body.data.scope === "world") {
          ns.emit("msg", msg);
        } else if (body.data.scope === "party") {
          const party = parties.partyOf(uid);
          if (!party) return reply({ error: "no_party" });
          for (const m of party.members) ns.to(userRoom(m.uid)).emit("msg", msg);
        } else if (body.data.scope === "room") {
          const room = rooms.roomOf(uid);
          if (!room) return reply({ error: "no_room" });
          for (const memberId of room.members.keys()) ns.to(userRoom(memberId)).emit("msg", msg);
        } else {
          const target = (body.data.to ?? "").trim();
          if (!target) return reply({ error: "no_target" });
          const { data } = await supabase.from("profiles").select("id, username").ilike("username", target.replace(/[\\%_]/g, "\\$&")).limit(1).maybeSingle();
          if (!data) return reply({ error: "no_such_player" });
          const tid = data.id as string;
          if (tid === uid) return reply({ error: "self" });
          if (!(await ns.in(userRoom(tid)).fetchSockets()).length) return reply({ error: "offline" });
          const whisper = { ...msg, to: data.username as string };
          ns.to(userRoom(tid)).to(userRoom(uid)).emit("msg", whisper);
        }
        reply({ ok: true });
      } catch (e) {
        log.error({ err: e }, "chat send failed");
        reply({ error: "failed" });
      }
    });


    // ---- Party actions: every one answers with { ok, party } or { error } ----
    type Ack = (r: unknown) => void;
    const ackOf = (a?: Ack): Ack => (typeof a === "function" ? a : () => {});
    const me = async () => ({ uid, name: (name ??= await nameOf(uid)) ?? "Player", level: await levelOf(uid) });

    socket.on("party:sync", async (_raw: unknown, ack?: Ack) => {
      const p = parties.partyOf(uid);
      ackOf(ack)({ uid, party: p ? view(p, uid) : null, nearby: await nearby(uid), level: await levelOf(uid), invites: invites.list(uid) });
    });
    socket.on("party:create", async (raw: unknown, ack?: Ack) => {
      const reply = ackOf(ack), body = optionsSchema.safeParse(raw);
      if (!body.success) return reply({ error: "bad_range" });
      const r = parties.create(await me(), body.data as PartyOptions);
      if (!r.ok) return reply(fail(r));
      push([uid], r.party); reply({ ok: true, party: view(r.party, uid) });
    });
    socket.on("party:join", async (raw: unknown, ack?: Ack) => {
      const reply = ackOf(ack), body = idSchema.safeParse(raw);
      if (!body.success) return reply({ error: "no_such" });
      const player = await me();
      const target = parties.get(body.data.id);
      const here = rooms.roomOf(uid), there = target && rooms.roomOf(target.host);
      if (target && (!here || !there || here.id !== there.id)) return reply({ error: "no_such" }); // you join from the same room as the host
      const r = parties.join(player, body.data.id, body.data.password);
      if (!r.ok) return reply(fail(r));
      push(r.party.members.map((m) => m.uid), r.party, `${player.name} joined the party`);
      reply({ ok: true, party: view(r.party, uid) });
    });
    socket.on("party:edit", (raw: unknown, ack?: Ack) => {
      const reply = ackOf(ack), body = optionsSchema.safeParse(raw);
      if (!body.success) return reply({ error: "bad_range" });
      const r = parties.edit(uid, body.data as PartyOptions);
      if (!r.ok) return reply(fail(r));
      push(r.party.members.map((m) => m.uid), r.party); reply({ ok: true, party: view(r.party, uid) });
    });
    socket.on("party:invite", async (raw: unknown, ack?: Ack) => {
      const reply = ackOf(ack), body = uidSchema.safeParse(raw);
      if (!body.success) return reply({ error: "no_target" });
      const to = body.data.uid;
      try {
        if (to === uid) return reply({ error: "no_target" });
        const mine = parties.partyOf(uid);
        if (mine && mine.host !== uid) return reply({ error: "not_host" });
        if (mine && mine.members.length >= PARTY_MAX) return reply({ error: "full" });
        const here = rooms.roomOf(uid), there = rooms.roomOf(to);
        if (!here || !there || here.id !== there.id) return reply({ error: "not_here" });
        if (parties.partyOf(to)) return reply({ error: "target_in_party" });
        if (!(await online(to))) return reply({ error: "offline" });
        if (invites.recent(to, uid, 10_000)) return reply({ error: "slow" });
        const info = await describe(uid, (name ??= await nameOf(uid)) ?? "Player");
        invites.add(to, info);
        sendInvites(to);
        ns.to(userRoom(to)).emit("party", { party: undefined, note: `${info.name} invited you to a party` });
        reply({ ok: true });
      } catch (e) { log.error({ err: e }, "party invite failed"); reply({ error: "failed" }); }
    });
    socket.on("party:accept", async (raw: unknown, ack?: Ack) => {
      const reply = ackOf(ack), body = z.object({ from: z.string().min(1).max(60) }).safeParse(raw);
      if (!body.success) return reply({ error: "no_such" });
      if (parties.partyOf(uid)) return reply({ error: "in_party" });
      const inv = invites.take(uid, body.data.from);
      if (!inv) { sendInvites(uid); return reply({ error: "invite_gone" }); }
      if (!(await online(inv.from))) { sendInvites(uid); return reply({ error: "offline" }); }
      const player = await me();
      let party = parties.partyOf(inv.from);
      if (party && party.host !== inv.from) { sendInvites(uid); return reply({ error: "invite_gone" }); }
      if (!party) {
        const host = { uid: inv.from, name: inv.name, level: await levelOf(inv.from) };
        const made = parties.create(host, { open: true, min: 1, max: 99, recruiting: false });
        if (!made.ok) return reply(fail(made));
        party = made.party;
      }
      const joined = parties.join(player, party.id, undefined, true);
      if (!joined.ok) { sendInvites(uid); return reply(fail(joined)); }
      invites.clear(uid);
      sendInvites(uid);
      push(joined.party.members.map((m) => m.uid), joined.party, `${player.name} joined the party`);
      reply({ ok: true, party: view(joined.party, uid) });
    });
    socket.on("party:decline", (raw: unknown, ack?: Ack) => {
      const body = z.object({ from: z.string().min(1).max(60) }).safeParse(raw);
      if (body.success) {
        const inv = invites.take(uid, body.data.from);
        sendInvites(uid);
        if (inv) { const p = parties.partyOf(inv.from); ns.to(userRoom(inv.from)).emit("party", { party: p ? view(p, inv.from) : undefined, note: `${name ?? "A player"} declined your invitation` }); }
      }
      ackOf(ack)({ ok: true });
    });
    socket.on("party:leave", (_raw: unknown, ack?: Ack) => {
      const r = parties.leave(uid);
      if (!r.ok) return ackOf(ack)(fail(r));
      push([uid], null);
      if (r.party) push(r.party.members.map((m) => m.uid), r.party, `${name ?? "A player"} left the party`);
      ackOf(ack)({ ok: true });
    });
    socket.on("party:kick", (raw: unknown, ack?: Ack) => {
      const reply = ackOf(ack), body = uidSchema.safeParse(raw);
      if (!body.success) return reply({ error: "no_target" });
      const r = parties.kick(uid, body.data.uid);
      if (!r.ok) return reply(fail(r));
      push([body.data.uid], null, "You were removed from the party");
      push(r.party.members.map((m) => m.uid), r.party); reply({ ok: true, party: view(r.party, uid) });
    });
    socket.on("party:disband", (_raw: unknown, ack?: Ack) => {
      const r = parties.disband(uid);
      if (!r.ok) return ackOf(ack)(fail(r));
      for (const m of r.party.members) push([m.uid], null, m.uid === uid ? undefined : "The host disbanded the party");
      ackOf(ack)({ ok: true });
    });
    // Someone who goes away for good leaves their party after a couple of minutes (a refresh or a dropped connection is fine).
    clearTimeout(leaveTimers.get(uid)); leaveTimers.delete(uid);
    socket.on("disconnect", () => {
      const t = setTimeout(async () => {
        leaveTimers.delete(uid);
        if ((await ns.in(userRoom(uid)).fetchSockets()).length) return;
        const r = parties.leave(uid);
        if (r.ok && r.party) push(r.party.members.map((m) => m.uid), r.party);
      }, 120_000);
      t.unref(); leaveTimers.set(uid, t);
    });

    // A fresh connection learns about the party it is already in.
    { const p = parties.partyOf(uid); if (p) push([uid], p); }

    /** Who is in my room, for the whisper picker. */
    socket.on("who", (_raw: unknown, ack?: (r: unknown) => void) => {
      if (typeof ack !== "function") return;
      const room = rooms.roomOf(uid);
      ack({ room: room ? [...room.members.values()].filter((m) => m.uid !== uid).map((m) => m.name) : null, online: ns.sockets.size });
    });
  });

  return ns;
}
