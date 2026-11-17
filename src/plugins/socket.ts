import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import { Server, type Socket } from "socket.io";
import { webOrigins, type Env } from "../config/env.js";
import { BattleManager, registerBattleHandlers } from "../modules/battle/handlers.js";
import type { ClientToServerEvents, ServerToClientEvents } from "../modules/battle/protocol.js";
import { SupabaseBattleStore } from "../modules/battle/store.js";
import type { FloorRuns } from "../modules/floor/run.js";
import { registerRoomNamespace } from "../modules/rooms/namespace.js";
import { verifyAccessToken, type AuthUser } from "./auth.js";

export interface GameSocketData {
  user: AuthUser;
}
export type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, GameSocketData>;
export type GameServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, GameSocketData>;

/**
 * Attaches Socket.IO to the Fastify HTTP server. Every connection must present a valid
 * Supabase access token in `auth.token`; the verified user id is the only identity the
 * server trusts (never an id sent by the client).
 */
export function attachSocket(app: FastifyInstance, env: Env, supabase: SupabaseClient, runs: FloorRuns): GameServer {
  const io: GameServer = new Server(app.server, {
    cors: { origin: webOrigins(env), credentials: true },
    transports: ["websocket", "polling"],
  });

  const battle = new BattleManager({ io, supabase, store: new SupabaseBattleStore(supabase), log: app.log });

  io.use(async (socket, next) => {
    const user = await verifyAccessToken(supabase, socket.handshake.auth?.token as string | undefined);
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    next();
  });

  io.on("connection", (socket) => {
    app.log.info({ userId: socket.data.user.id }, "socket connected");
    registerBattleHandlers(io, socket, battle);
  });

  const rooms = registerRoomNamespace({ io: io as never, supabase, runs, log: app.log });

  app.addHook("onClose", async () => {
    rooms.stop();
    battle.shutdown();
    await io.close();
  });

  return io;
}
