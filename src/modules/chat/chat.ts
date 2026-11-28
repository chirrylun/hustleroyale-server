import type { SupabaseClient } from "@supabase/supabase-js";
import type { Namespace, Server, Socket } from "socket.io";
import { z } from "zod";
import { verifyAccessToken } from "../../plugins/auth.js";
import type { RoomManager } from "../rooms/manager.js";

export const MAX_CHAT = 160;
const sayBody = z.object({ scope: z.enum(["world", "room", "whisper"]), text: z.string().max(400), to: z.string().min(1).max(32).optional() });

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
  log: { error: (obj: unknown, msg?: string) => void };
}

/**
 * The `/chat` namespace. World goes to everyone connected, Room to everyone in the sender's shared room (the lobby or a floor room
 * from the `/floor` namespace), Whisper to one player by name. Nothing is stored: chat is live only.
 */
export function registerChatNamespace({ io, supabase, rooms, log }: ChatDeps): Namespace {
  const ns: Namespace = io.of("/chat");
  const userRoom = (uid: string) => `u:${uid}`;
  let seq = 0;

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

    /** Who is in my room, for the whisper picker. */
    socket.on("who", (_raw: unknown, ack?: (r: unknown) => void) => {
      if (typeof ack !== "function") return;
      const room = rooms.roomOf(uid);
      ack({ room: room ? [...room.members.values()].filter((m) => m.uid !== uid).map((m) => m.name) : null, online: ns.sockets.size });
    });
  });

  return ns;
}
