import { randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBattle, createRng } from "../../engine/index.js";
import type { GameServer, GameSocket } from "../../plugins/socket.js";
import { loadOpponentPool, buildOpponent, statPower, type PoolTemplate } from "./opponent.js";
import { startRequestSchema, type StartAck, type UnitMeta } from "./protocol.js";
import { SoloSession, type BattleEmitter } from "./session.js";
import { MatchInProgressError, type BattleStore } from "./store.js";
import { loadTeam, TeamError } from "./team.js";

/** A page refresh or a dropped connection shouldn't cost the player their match. */
const RECONNECT_GRACE_MS = 15_000;
const POOL_TTL_MS = 60_000;

export interface BattleDeps {
  io: GameServer;
  supabase: SupabaseClient;
  store: BattleStore;
  log: { error: (obj: unknown, msg?: string) => void };
}

const room = (userId: string) => `user:${userId}`;

/** What gets stored with the match: enough to replay or audit it, without anything secret. */
function describeSide(units: { id: string; name: string; role: string; stats: unknown; skills: { slug: string }[] }[], metas: UnitMeta[]) {
  return units.map((u) => ({
    id: u.id,
    name: u.name,
    role: u.role,
    stats: u.stats,
    skills: u.skills.map((s) => s.slug),
    spriteKey: metas.find((m) => m.id === u.id)?.spriteKey,
    grade: metas.find((m) => m.id === u.id)?.grade ?? null,
  }));
}

export class BattleManager {
  private readonly sessions = new Map<string, SoloSession>();
  private readonly starting = new Set<string>();
  private pool: { at: number; data: PoolTemplate[] } | null = null;

  constructor(private readonly deps: BattleDeps) {}

  get(userId: string): SoloSession | undefined {
    return this.sessions.get(userId);
  }

  shutdown(): void {
    for (const s of this.sessions.values()) s.halt();
    this.sessions.clear();
  }

  private async opponentPool(): Promise<PoolTemplate[]> {
    if (this.pool && Date.now() - this.pool.at < POOL_TTL_MS) return this.pool.data;
    const data = await loadOpponentPool(this.deps.supabase);
    this.pool = { at: Date.now(), data };
    return data;
  }

  async startSolo(userId: string, raw: unknown): Promise<StartAck> {
    const parsed = startRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid_request" };
    if (this.sessions.has(userId) || this.starting.has(userId)) return { ok: false, error: "match_in_progress" };

    this.starting.add(userId);
    try {
      const { difficulty, controlledFighterId = null } = parsed.data;
      const team = await loadTeam(this.deps.supabase, userId, controlledFighterId);
      const pool = await this.opponentPool();

      const seed = randomInt(0, 2 ** 32);
      const playerPower = team.units.reduce((sum, u) => sum + statPower(u.stats), 0);
      const foe = buildOpponent(pool, team.units.map((u) => u.role), playerPower, difficulty, createRng(seed ^ 0x9e3779b9));

      const matchId = await this.deps.store.startMatch({
        userId,
        seed,
        controlledFighterId,
        team: { difficulty, units: describeSide(team.units, team.metas) },
        foe: { difficulty, units: describeSide(foe.units, foe.metas) },
      });

      // Side 2 is always run by the AI commander; side 1 is too unless the player steers a fighter.
      const state = createBattle([...team.units, ...foe.units], seed, { autoStance: [2] });
      const { io, log } = this.deps;
      const target = room(userId);
      const emitter: BattleEmitter = {
        start: (p) => void io.to(target).emit("battle:start", p),
        events: (p) => void io.to(target).emit("battle:events", p),
        sync: (p) => void io.to(target).emit("battle:sync", p),
        end: (p) => void io.to(target).emit("battle:end", p),
      };

      const session = new SoloSession({
        matchId,
        userId,
        difficulty,
        state,
        metas: [...team.metas, ...foe.metas],
        controlledUnitId: controlledFighterId,
        enemyTotalHp: foe.totalHp,
        store: this.deps.store,
        emitter,
        log,
        onDone: () => {
          if (this.sessions.get(userId) === session) this.sessions.delete(userId);
        },
      });
      this.sessions.set(userId, session);
      session.start();
      return { ok: true, matchId };
    } catch (err) {
      if (err instanceof MatchInProgressError) return { ok: false, error: "match_in_progress" };
      if (err instanceof TeamError) return { ok: false, error: err.code };
      this.deps.log.error({ err, userId }, "battle: could not start a solo match");
      return { ok: false, error: "server_error" };
    } finally {
      this.starting.delete(userId);
    }
  }
}

/** Wires one connected player to the battle system. Identity always comes from the verified token. */
export function registerBattleHandlers(io: GameServer, socket: GameSocket, manager: BattleManager): void {
  const userId = socket.data.user.id;
  void socket.join(room(userId));

  socket.on("solo:start", async (request, ack) => {
    if (typeof ack !== "function") return;
    ack(await manager.startSolo(userId, request));
  });
  socket.on("battle:intent", (intent) => manager.get(userId)?.intent(intent));
  socket.on("battle:stance", (stance) => manager.get(userId)?.stance(stance));
  // Back on the arena screen (refresh, flaky network, or came back from another page): rejoin a live match.
  socket.on("battle:rejoin", () => {
    const live = manager.get(userId);
    if (live) socket.emit("battle:start", live.startPayload());
  });

  socket.on("disconnect", () => {
    const timer = setTimeout(async () => {
      const still = await io.in(room(userId)).fetchSockets();
      if (still.length === 0) await manager.get(userId)?.abandon();
    }, RECONNECT_GRACE_MS);
    timer.unref?.();
  });
}
