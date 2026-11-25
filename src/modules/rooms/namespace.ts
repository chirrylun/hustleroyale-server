import type { SupabaseClient } from "@supabase/supabase-js";
import type { Namespace, Server, Socket } from "socket.io";
import { z } from "zod";
import { verifyAccessToken } from "../../plugins/auth.js";
import type { FloorRuns } from "../floor/run.js";
import type { Mob } from "./mobs.js";
import { RoomManager } from "./manager.js";
import { mobWire, type FighterInfo, type Member } from "./room.js";
import { lookKey } from "../../world/look.js";
import { TRAINING_FLOOR } from "../../world/floor.js";
import { GEAR_SELECT, gearBonus, type GearRows } from "../gear/bonus.js";

const joinSchema = z.object({ floor: z.number().int().min(TRAINING_FLOOR).max(40), code: z.string().min(4).max(8).optional(), seed: z.number().int().min(0).max(2_147_483_647).optional() });
const updateSchema = z.object({
  p: z.array(z.tuple([z.string().max(40), z.number(), z.number(), z.number(), z.number()])).max(3).optional(),
  a: z.array(z.tuple([z.number().int(), z.string().max(40), z.number()])).max(24).optional(),
});

interface FighterRow {
  id: string; level: number; hp: number; atk: number; def: number; magic: number; gender: string; hp_frac: number | null; gear?: GearRows;
  template: { name: string; role: string; archetype: string; sprite_key: string } | null;
}

export interface RoomDeps {
  io: Server;
  supabase: SupabaseClient;
  runs: FloorRuns;
  log: { error: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
}

/**
 * The `/floor` namespace: players join a room for a floor, send their fighters' positions and the damage they deal, and
 * receive the room's mobs, the other players' fighters and what the mobs do. Entering and kills are paid by
 * the same service-role functions as before, now fed by what the server saw in the room.
 */
export function registerRoomNamespace({ io, supabase, runs, log }: RoomDeps): RoomManager {
  const ns: Namespace = io.of("/floor");
  const roomName = (id: string) => `room:${id}`;
  const userName = (uid: string) => `u:${uid}`;

  const pay = async (uid: string, floor: number, mob: Mob) => {
    const claim = { kind: mob.kind, level: mob.level, boss: mob.boss, mini: mob.mini };
    if (runs.check(uid, floor, claim, Date.now(), false)) return; // not a run this player is on: no pay
    const { data, error } = floor === TRAINING_FLOOR
      ? await supabase.rpc("srv_report_training_kill", { p_user: uid, p_kind: claim.kind, p_level: claim.level })
      : await supabase.rpc("srv_report_floor_kill", { p_user: uid, p_floor: floor, p_kind: claim.kind, p_level: claim.level, p_boss: claim.boss, p_mini: !!claim.mini });
    if (error) { log.error({ err: error }, "room kill failed"); return; }
    const res = data as { throttled?: boolean } & Record<string, unknown>;
    if (!res.throttled) runs.paid(uid, claim);
    ns.to(userName(uid)).emit("k", { m: mob.id, kind: mob.kind, boss: mob.boss, mini: mob.mini, ...res });
  };

  const manager = new RoomManager((roomId) => ({
    toRoom: (event, payload) => ns.to(roomName(roomId)).emit(event, payload),
    toUser: (uid, event, payload) => ns.to(userName(uid)).emit(event, payload),
    kill: (uid, mob) => {
      const room = manager.roomOf(uid);
      if (room) void pay(uid, room.floor, mob);
    },
  }));
  manager.start();

  const loadMember = async (uid: string): Promise<Member | null> => {
    const [{ data: rows }, { data: prof }] = await Promise.all([
      supabase.from("fighters").select("id, level, hp, atk, def, magic, gender, hp_frac, template:fighter_templates(name, role, archetype, sprite_key), " + GEAR_SELECT).eq("owner_id", uid).gt("team_slot", 0).order("team_slot"),
      supabase.from("profiles").select("username").eq("id", uid).maybeSingle(),
    ]);
    const list = ((rows ?? []) as unknown as FighterRow[]).filter((r) => r.template);
    if (!list.length) return null;
    const info: FighterInfo[] = list.map((r) => { const gb = gearBonus(r.gear, r as never); return {
      id: r.id, name: r.template!.name, role: r.template!.role, level: r.level, max: r.hp + gb.hp, atk: r.atk + gb.atk, magic: r.magic + gb.magic, def: r.def + gb.def, frac: r.hp_frac ?? 1,
      sprite: lookKey(r.gender, r.gear),
    }; });
    return {
      uid, name: (prof?.username as string | undefined) ?? "Player", info, buckets: new Map(), dirty: false,
      fighters: new Map(info.map((f) => [f.id, { id: f.id, uid, x: 0, y: 0, max: f.max, def: f.def, level: f.level, role: f.role, frac: 1, dead: true }])), // not a target until it reports in
    };
  };

  ns.use(async (socket, next) => {
    const user = await verifyAccessToken(supabase, socket.handshake.auth?.token as string | undefined);
    if (!user) return next(new Error("unauthorized"));
    socket.data.uid = user.id;
    next();
  });

  ns.on("connection", (socket: Socket) => {
    const uid = socket.data.uid as string;
    socket.join(userName(uid));
    let msgs = 0;
    const flood = setInterval(() => { msgs = 0; }, 1000);
    flood.unref();

    const leave = () => {
      const room = manager.leave(uid);
      if (!room) return;
      socket.leave(roomName(room.id));
      ns.to(roomName(room.id)).emit("left", { uid, n: room.size });
    };

    socket.on("join", async (raw: unknown, ack?: (r: unknown) => void) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const body = joinSchema.safeParse(raw);
      if (!body.success) return reply({ error: "bad_request" });
      try {
        leave();
        if (body.data.floor === TRAINING_FLOOR) runs.enter(uid, TRAINING_FLOOR); // the training field: nothing to unlock
        else if (body.data.floor > 0) { // floor 0 is the lobby: nothing to unlock
          const { data: ok, error } = await supabase.rpc("srv_enter_floor", { p_user: uid, p_floor: body.data.floor });
          if (error) throw error;
          if (!ok) return reply({ error: "floor_locked" });
          runs.enter(uid, body.data.floor);
        }
        const member = await loadMember(uid);
        if (!member) return reply({ error: "no_party" });
        const placed = manager.place(uid, body.data.floor, body.data.code, body.data.seed);
        if ("error" in placed) return reply({ error: placed.error });
        const { room } = placed;
        manager.add(room, member);
        socket.join(roomName(room.id));
        const snap = room.snapshot();
        reply({ ok: true, room: room.id, code: room.code, size: room.cap, you: uid, n: room.size, ...snap });
        socket.to(roomName(room.id)).emit("joined", { player: snap.players.find((p) => p.uid === uid), n: room.size });
      } catch (e) {
        log.error({ err: e }, "room join failed");
        reply({ error: "join_failed" });
      }
    });

    // Fighter positions and the damage they dealt, a few times a second.
    socket.on("u", (raw: unknown) => {
      if (++msgs > 20) return;
      const body = updateSchema.safeParse(raw);
      const room = manager.roomOf(uid);
      if (!body.success || !room) return;
      const { p, a } = body.data;
      if (p?.length) room.report(uid, p.filter((q) => [q[1], q[2], q[3]].every(Number.isFinite)));
      if (a?.length) room.attack(uid, a.map(([m, f, d]) => ({ m, f, d })));
    });

    socket.on("leave", leave);
    socket.on("disconnect", () => { clearInterval(flood); leave(); });
  });

  return manager;
}

export { mobWire };
