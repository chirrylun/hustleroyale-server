import { randomInt, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBattle, createRng } from "../../engine/index.js";
import type { GameServer, GameSocket } from "../../plugins/socket.js";
import { BOSSES, RANGES, RAID_HEAL_FRAC, RAID_REVIVE_FRAC, RAID_STAGES, buildBoss, raidFoe, raidFloorName, type RangeDef } from "./arena.js";
import { ArenaStore } from "./arenaStore.js";
import { loadOpponentPool, buildOpponent, buildRangeOpponent, statPower, type PoolTemplate } from "./opponent.js";
import { startRequestSchema, type ArenaEnd, type NextAck, type StartAck, type UnitMeta } from "./protocol.js";
import { ALLY_DODGE, DIFFICULTY_CONFIG } from "./rewards.js";
import { SoloSession, type BattleEmitter } from "./session.js";
import { MatchInProgressError, type BattleStore } from "./store.js";
import { loadTeam, TeamError, type LoadedTeam } from "./team.js";
import { buildSlimes, TutorialStore, TUTORIAL_STAGES, type TutorialStage } from "./tutorial.js";

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

/** A Floor Raid in progress: the team as it was when the raid began, and the health it carries from floor to floor. */
interface RaidRun {
  range: RangeDef;
  team: LoadedTeam;
  controlledId: string | null;
  seed: number;
  /** The floor the team fights next. */
  stage: number;
  /** Health each fighter starts the next floor with, as a share of its maximum. */
  frac: Record<string, number>;
  idle: ReturnType<typeof setTimeout> | null;
}
/** A raid whose player has not pressed Next Floor for this long is dropped. */
const RAID_IDLE_MS = 15 * 60_000;

export class BattleManager {
  private readonly sessions = new Map<string, SoloSession>();
  private readonly raids = new Map<string, RaidRun>();
  private readonly arenaStore = new ArenaStore();
  private readonly starting = new Set<string>();
  private pool: { at: number; data: PoolTemplate[] } | null = null;

  constructor(private readonly deps: BattleDeps) {}

  get(userId: string): SoloSession | undefined {
    return this.sessions.get(userId);
  }

  shutdown(): void {
    for (const s of this.sessions.values()) s.halt();
    this.sessions.clear();
    for (const r of this.raids.values()) if (r.idle) clearTimeout(r.idle);
    this.raids.clear();
  }

  /** Forgets a player's raid (they left, or it ended). */
  dropRaid(userId: string): void {
    const r = this.raids.get(userId);
    if (r?.idle) clearTimeout(r.idle);
    this.raids.delete(userId);
  }

  private async opponentPool(): Promise<PoolTemplate[]> {
    if (this.pool && Date.now() - this.pool.at < POOL_TTL_MS) return this.pool.data;
    const data = await loadOpponentPool(this.deps.supabase);
    this.pool = { at: Date.now(), data };
    return data;
  }

  /** The scripted first fights against level 1 slimes (no rewards, nothing saved). */
  async startTutorial(userId: string, raw: unknown): Promise<StartAck> {
    const stage = (raw as { stage?: unknown } | null)?.stage;
    if (stage !== 1 && stage !== 2) return { ok: false, error: "invalid_request" };
    if (this.starting.has(userId)) return { ok: false, error: "match_in_progress" };
    // A tutorial fight still waiting for Start (the player went back and came again) is simply replaced.
    const waiting = this.sessions.get(userId);
    if (waiting?.awaitingStart) await waiting.abandon();
    if (this.sessions.has(userId)) return { ok: false, error: "match_in_progress" };

    this.starting.add(userId);
    try {
      const all = await loadTeam(this.deps.supabase, userId, null);
      // Stage 1 follows the best attacker, so the first win is quick and feels good.
      const lead = all.units.find((u) => u.role === "dps") ?? all.units.find((u) => u.role === "tank") ?? all.units[0]!;
      const solo = stage === 1;
      const team = solo ? await loadTeam(this.deps.supabase, userId, lead.id) : all;
      const mine = solo ? { units: team.units.filter((u) => u.id === lead.id), metas: team.metas.filter((m) => m.id === lead.id) } : team;
      const foe = buildSlimes(TUTORIAL_STAGES[stage as TutorialStage].foes);
      const controlledId = solo ? lead.id : null;

      const seed = randomInt(0, 2 ** 32);
      const store = new TutorialStore();
      const matchId = await store.startMatch();
      const state = createBattle([...mine.units, ...foe.units], seed, { autoStance: [2], dodge: { 1: ALLY_DODGE, 2: 0 } });
      const emitter = this.emitterFor(userId);
      const session = new SoloSession({
        matchId, userId, difficulty: "rookie", state, metas: [...mine.metas, ...foe.metas], controlledUnitId: controlledId,
        enemyTotalHp: foe.totalHp, store, emitter, log: this.deps.log,
        onDone: () => { if (this.sessions.get(userId) === session) this.sessions.delete(userId); },
      });
      this.sessions.set(userId, session);
      // Frozen until the player has read the instructions and presses Start (see `beginTutorial`).
      session.start({ awaitStart: true });
      return { ok: true, matchId };
    } catch (err) {
      if (err instanceof TeamError) return { ok: false, error: err.code };
      this.deps.log.error({ err, userId }, "battle: could not start the tutorial fight");
      return { ok: false, error: "server_error" };
    } finally {
      this.starting.delete(userId);
    }
  }

  /** The player pressed Start on a tutorial fight: let it run. */
  beginTutorial(userId: string): { ok: boolean } {
    return { ok: this.sessions.get(userId)?.begin() ?? false };
  }

  private emitterFor(userId: string): BattleEmitter {
    const { io } = this.deps;
    const target = room(userId);
    return {
      start: (p) => void io.to(target).emit("battle:start", p),
      events: (p) => void io.to(target).emit("battle:events", p),
      sync: (p) => void io.to(target).emit("battle:sync", p),
      end: (p) => void io.to(target).emit("battle:end", p),
      begin: (p) => void io.to(target).emit("battle:begin", p),
    };
  }

  async startSolo(userId: string, raw: unknown): Promise<StartAck> {
    const parsed = startRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid_request" };
    if (this.starting.has(userId)) return { ok: false, error: "match_in_progress" };
    // A frozen tutorial fight nobody pressed Start on shouldn't block a real match.
    const waiting = this.sessions.get(userId);
    if (waiting?.awaitingStart) await waiting.abandon();
    if (this.sessions.has(userId)) return { ok: false, error: "match_in_progress" };

    this.dropRaid(userId);
    this.starting.add(userId);
    try {
      const req = parsed.data;
      if ("mode" in req && req.mode === "boss") return await this.startBoss(userId, req.range, req.boss, req.controlledFighterId ?? null);
      if ("mode" in req && req.mode === "raid") return await this.startRaid(userId, req.range, req.controlledFighterId ?? null);
      // Challenge (an AI team of the chosen levels, nobody to steer, one fixed difficulty) or the old practice match.
      const range = "mode" in req ? RANGES[req.range] : null;
      const difficulty = "difficulty" in req ? req.difficulty : "hustler";
      const controlledFighterId = "difficulty" in req ? (req.controlledFighterId ?? null) : null;
      const team = await loadTeam(this.deps.supabase, userId, controlledFighterId);
      const pool = await this.opponentPool();

      const seed = randomInt(0, 2 ** 32);
      const playerPower = team.units.reduce((sum, u) => sum + statPower(u.stats), 0);
      const foe = range
        ? buildRangeOpponent(pool, team.units.map((u) => u.role), range, createRng(seed ^ 0x9e3779b9))
        : buildOpponent(pool, team.units.map((u) => u.role), playerPower, difficulty, createRng(seed ^ 0x9e3779b9));

      const matchId = await this.deps.store.startMatch({
        userId,
        seed,
        controlledFighterId,
        team: { difficulty, units: describeSide(team.units, team.metas) },
        foe: { difficulty, units: describeSide(foe.units, foe.metas) },
      });

      // Side 2 is always run by the AI commander; side 1 is too unless the player steers a fighter.
      const state = createBattle([...team.units, ...foe.units], seed, { autoStance: [2], dodge: { 1: ALLY_DODGE, 2: range ? range.dodge : DIFFICULTY_CONFIG[difficulty].dodge } });
      const { log } = this.deps;
      const emitter = this.emitterFor(userId);

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
        ...(range ? { arena: { mode: "challenge" as const, range: range.id, title: "Challenge", subtitle: `Level ${range.min} to ${range.max}` } } : {}),
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
  /** Boss Rush: the player's team against one floor boss of the chosen range. No rewards; a win goes on the board. */
  private async startBoss(userId: string, rangeId: RangeDef["id"], boss: keyof typeof BOSSES, controlledFighterId: string | null): Promise<StartAck> {
    const range = RANGES[rangeId];
    if (!range.bosses.includes(boss)) return { ok: false, error: "invalid_request" };
    const team = await loadTeam(this.deps.supabase, userId, controlledFighterId);
    const foe = buildBoss(boss);
    const seed = randomInt(0, 2 ** 32);
    const state = createBattle([...team.units, ...foe.units], seed, { autoStance: [2], dodge: { 1: ALLY_DODGE, 2: 0.6 } });
    const matchId = await this.arenaStore.startMatch();
    const def = BOSSES[boss];
    const crew = team.metas.filter((m) => m.side === 1 && !m.summon).map((m) => ({ name: m.name, role: m.role, level: m.level, spriteKey: m.spriteKey }));
    const session = new SoloSession({
      matchId, userId, difficulty: "hustler", state, metas: [...team.metas, ...foe.metas], controlledUnitId: controlledFighterId,
      enemyTotalHp: foe.totalHp, store: this.arenaStore, emitter: this.emitterFor(userId), log: this.deps.log,
      arena: { mode: "boss", range: rangeId, boss, title: def.name, subtitle: `Level ${def.level} · Floor ${def.floor} boss` },
      onEnd: async ({ winnerSide, durationMs }): Promise<ArenaEnd> => {
        const end: ArenaEnd = { mode: "boss", range: rangeId, boss };
        if (winnerSide !== 1) return end;
        const { data, error } = await this.deps.supabase.rpc("srv_record_boss_rush", { p_user: userId, p_boss: boss, p_range: rangeId, p_time_ms: Math.max(1, Math.round(durationMs)), p_team: crew });
        if (error) throw error;
        const r = data as { new_best: boolean; best_ms: number; rank: number };
        return { ...end, bossRush: { timeMs: Math.round(durationMs), bestMs: r.best_ms, newBest: r.new_best, rank: r.rank } };
      },
      onDone: () => { if (this.sessions.get(userId) === session) this.sessions.delete(userId); },
    });
    this.sessions.set(userId, session);
    session.start();
    return { ok: true, matchId };
  }

  /** Floor Raid: floors 1 to 10 of the range's theme in one go. Health carries over (with a little healing between floors). */
  private async startRaid(userId: string, rangeId: RangeDef["id"], controlledFighterId: string | null): Promise<StartAck> {
    this.dropRaid(userId);
    const team = await loadTeam(this.deps.supabase, userId, controlledFighterId);
    const run: RaidRun = { range: RANGES[rangeId], team, controlledId: controlledFighterId, seed: randomInt(0, 2 ** 32), stage: 1, frac: {}, idle: null };
    this.raids.set(userId, run);
    return this.runRaidStage(userId, run);
  }

  private runRaidStage(userId: string, run: RaidRun): StartAck {
    const { range, team } = run;
    const stage = run.stage;
    const foe = raidFoe(range, stage, createRng(run.seed ^ (stage * 0x9e3779b1)));
    const mine = team.units.map((u) => ({ ...u, hpFrac: run.frac[u.id] }));
    const state = createBattle([...mine, ...foe.units], (run.seed + stage * 7919) >>> 0, { autoStance: [2], dodge: { 1: ALLY_DODGE, 2: range.dodge } });
    const boss = stage >= RAID_STAGES ? range.bosses[1] : null;
    const matchId = randomUUID();
    const session = new SoloSession({
      matchId, userId, difficulty: "hustler", state, metas: [...team.metas, ...foe.metas], controlledUnitId: run.controlledId,
      enemyTotalHp: foe.totalHp, store: this.arenaStore, emitter: this.emitterFor(userId), log: this.deps.log,
      arena: { mode: "raid", range: range.id, stage, stages: RAID_STAGES, title: raidFloorName(range, stage), subtitle: boss ? `${BOSSES[boss].name}, floor boss` : `Mobs around level ${foe.metas[0]?.level ?? range.min}`, ...(boss ? { boss } : {}) },
      onEnd: async ({ winnerSide, state: end }): Promise<ArenaEnd> => {
        const won = winnerSide === 1;
        const last = stage >= RAID_STAGES;
        const out: ArenaEnd = { mode: "raid", range: range.id, stage, stages: RAID_STAGES, cleared: won ? stage : stage - 1, more: won && !last, ...(boss ? { boss } : {}) };
        if (won && !last) {
          for (const u of end.units) if (u.side === 1 && !u.summonOf) run.frac[u.id] = u.alive ? Math.min(1, (u.hp + RAID_HEAL_FRAC * u.maxHp) / u.maxHp) : RAID_REVIVE_FRAC;
          run.stage = stage + 1;
          run.idle = setTimeout(() => this.dropRaid(userId), RAID_IDLE_MS);
          run.idle.unref?.();
        } else this.dropRaid(userId);
        return out;
      },
      onDone: () => { if (this.sessions.get(userId) === session) this.sessions.delete(userId); },
    });
    this.sessions.set(userId, session);
    session.start();
    return { ok: true, matchId };
  }

  /** The player is ready for the next floor of their raid. */
  async nextRaidStage(userId: string): Promise<NextAck> {
    const run = this.raids.get(userId);
    if (!run) return { ok: false, error: "no_raid" };
    if (this.sessions.has(userId) || this.starting.has(userId)) return { ok: false, error: "match_in_progress" };
    if (run.idle) clearTimeout(run.idle);
    run.idle = null;
    try {
      const res = this.runRaidStage(userId, run);
      return res.ok ? { ok: true } : { ok: false, error: "server_error" };
    } catch (err) {
      this.deps.log.error({ err, userId }, "battle: could not start the next raid floor");
      return { ok: false, error: "server_error" };
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
  socket.on("tutorial:start", async (request, ack) => {
    if (typeof ack !== "function") return;
    ack(await manager.startTutorial(userId, request));
  });
  socket.on("raid:next", async (ack) => {
    const res = await manager.nextRaidStage(userId);
    if (typeof ack === "function") ack(res);
  });
  socket.on("tutorial:begin", (ack) => {
    const res = manager.beginTutorial(userId);
    if (typeof ack === "function") ack(res);
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
      if (still.length === 0) {
        await manager.get(userId)?.abandon();
        manager.dropRaid(userId);
      }
    }, RECONNECT_GRACE_MS);
    timer.unref?.();
  });
}
