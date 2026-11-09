import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface AuthUser {
  id: string;
  email?: string;
}

/** Verifies a Supabase access token (JWT) with Supabase Auth. Returns null when invalid. */
export async function verifyAccessToken(supabase: SupabaseClient, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? undefined };
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/** Fastify preHandler: rejects the request unless it carries a valid Supabase bearer token. */
export function requireUser(supabase: SupabaseClient) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await verifyAccessToken(supabase, bearerToken(req.headers.authorization));
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    req.user = user;
  };
}
