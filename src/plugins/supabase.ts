import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../config/env.js";

/** Service-role client. Bypasses RLS, so it must only ever be used on the server. */
export function createAdminClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
