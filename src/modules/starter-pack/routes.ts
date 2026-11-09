import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../../plugins/auth.js";
import { rollStarterPack, type FighterTemplate } from "./roll.js";

const MAX_ATTEMPTS = 3; // a capped template can sell out between our read and the write

export function registerStarterPackRoutes(app: FastifyInstance, supabase: SupabaseClient) {
  app.post(
    "/starter-pack/open",
    {
      preHandler: requireUser(supabase),
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const userId = req.user!.id;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const { data: templates, error: catalogError } = await supabase
          .from("fighter_templates")
          .select("id, role, rarity, base_hp, base_atk, base_def, base_spd, base_stamina, base_magic, supply_cap, minted");
        if (catalogError || !templates) {
          req.log.error({ err: catalogError }, "starter pack: catalog read failed");
          return reply.code(500).send({ error: "catalog_unavailable" });
        }

        let pack;
        try {
          pack = rollStarterPack(templates as FighterTemplate[]);
        } catch (err) {
          req.log.error({ err }, "starter pack: roll failed");
          return reply.code(500).send({ error: "catalog_incomplete" });
        }

        const { data, error } = await supabase.rpc("open_starter_pack", { p_user_id: userId, p_fighters: pack });
        if (!error) return { fighters: data };

        const message = error.message ?? "";
        if (message.includes("already_opened")) return reply.code(409).send({ error: "already_opened" });
        if (message.includes("profile_not_found")) return reply.code(404).send({ error: "profile_not_found" });
        if (message.includes("sold_out") && attempt < MAX_ATTEMPTS) continue; // re-roll against fresh supply

        req.log.error({ err: error }, "starter pack: open failed");
        return reply.code(500).send({ error: "open_failed" });
      }
    },
  );
}
