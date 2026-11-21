import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../../plugins/auth.js";
import { MAX_FLOOR } from "./rules.js";
import { FloorRuns } from "./run.js";

const enterBody = z.object({ floor: z.number().int().min(1).max(MAX_FLOOR) });
const killBody = z.object({
  floor: z.number().int().min(1).max(MAX_FLOOR),
  kind: z.string().min(1).max(24),
  level: z.number().int().min(1).max(MAX_FLOOR + 2),
  boss: z.boolean().default(false),
});
const hpBody = z.object({ ids: z.array(z.uuid()).min(1).max(3), fracs: z.array(z.number().transform((n) => Math.min(1, Math.max(0, n)))).min(1).max(3) }); // a hair over 1 from float drift is clamped, not refused

/**
 * Floor progression is decided here, not in the browser: the client says "I entered / killed X / my health is Y",
 * the server checks that against what a floor can hold and what the player has done, and only then asks the
 * database (service-role RPCs) to pay out. The browser can no longer call those RPCs itself.
 */
export function registerFloorRoutes(app: FastifyInstance, supabase: SupabaseClient, runs = new FloorRuns()) {
  const timer = setInterval(() => runs.prune(), 5 * 60 * 1000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  const auth = requireUser(supabase);

  app.post("/floor/enter", { preHandler: auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = enterBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const { data, error } = await supabase.rpc("srv_enter_floor", { p_user: req.user!.id, p_floor: body.data.floor });
    if (error) { req.log.error({ err: error }, "floor enter failed"); return reply.code(500).send({ error: "enter_failed" }); }
    if (!data) return reply.code(403).send({ error: "floor_locked" });
    runs.enter(req.user!.id, body.data.floor);
    return { ok: true };
  });

  // Bursty by nature (a fight can end several mobs), but the database also meters kills with a token bucket.
  app.post("/floor/kill", { preHandler: auth, config: { rateLimit: { max: 90, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = killBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const user = req.user!.id;
    const { floor, kind, level, boss } = body.data;
    const refused = runs.check(user, floor, { kind, level, boss });
    if (refused === "no_run") return reply.code(409).send({ error: "no_run" }); // server restarted: the client re-enters and retries
    if (refused) return reply.code(422).send({ error: refused });

    const { data, error } = await supabase.rpc("srv_report_floor_kill", { p_user: user, p_floor: floor, p_kind: kind, p_level: level, p_boss: boss });
    if (error) {
      req.log.warn({ err: error }, "floor kill refused");
      return reply.code(/floor_locked|bad_monster|unauthorized/.test(error.message) ? 422 : 500).send({ error: "kill_failed" });
    }
    const res = data as { throttled?: boolean } & Record<string, unknown>;
    if (!res.throttled) runs.paid(user, { kind, level, boss });
    return res;
  });

  app.post("/floor/hp", { preHandler: auth, config: { rateLimit: { max: 40, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = hpBody.safeParse(req.body);
    if (!body.success || body.data.ids.length !== body.data.fracs.length) return reply.code(400).send({ error: "bad_request" });
    const { error } = await supabase.rpc("srv_save_party_hp", { p_user: req.user!.id, p_ids: body.data.ids, p_fracs: body.data.fracs });
    if (error) { req.log.error({ err: error }, "hp save failed"); return reply.code(500).send({ error: "save_failed" }); }
    return { ok: true };
  });
}
