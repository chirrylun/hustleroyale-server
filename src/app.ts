import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { Env } from "./config/env.js";
import { requireUser } from "./plugins/auth.js";
import { attachSocket } from "./plugins/socket.js";
import { registerStarterPackRoutes } from "./modules/starter-pack/routes.js";
import { createAdminClient } from "./plugins/supabase.js";

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const supabase = createAdminClient(env);

  await app.register(helmet);
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.get("/health", async () => ({ ok: true }));

  // Smoke-test endpoint for the auth wiring; real routes live in src/modules/*.
  app.get("/me", { preHandler: requireUser(supabase) }, async (req) => ({ userId: req.user!.id }));

  registerStarterPackRoutes(app, supabase);

  await app.ready();
  attachSocket(app, env, supabase);
  return app;
}
