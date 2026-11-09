import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import { Server, type Socket } from "socket.io";
import type { Env } from "../config/env.js";
import { verifyAccessToken, type AuthUser } from "./auth.js";

export interface GameSocketData {
  user: AuthUser;
}
export type GameSocket = Socket<Record<string, never>, Record<string, never>, Record<string, never>, GameSocketData>;
export type GameServer = Server<Record<string, never>, Record<string, never>, Record<string, never>, GameSocketData>;

/**
 * Attaches Socket.IO to the Fastify HTTP server. Every connection must present a valid
 * Supabase access token in `auth.token`; the verified user id is the only identity the
 * server trusts (never an id sent by the client).
 */
export function attachSocket(app: FastifyInstance, env: Env, supabase: SupabaseClient): GameServer {
  const io: GameServer = new Server(app.server, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    transports: ["websocket", "polling"],
  });

  io.use(async (socket, next) => {
    const user = await verifyAccessToken(supabase, socket.handshake.auth?.token as string | undefined);
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    next();
  });

  io.on("connection", (socket) => {
    app.log.info({ userId: socket.data.user.id }, "socket connected");
    // Queue, spectate and battle intent handlers are registered here (modules/battle).
  });

  app.addHook("onClose", async () => {
    await io.close();
  });

  return io;
}
