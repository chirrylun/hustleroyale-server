import { snapshot, step, submitIntent, submitStance, type BattleEvent, type BattleState, type Side } from "../../engine/index.js";
import {
  intentSchema,
  stanceSchema,
  type BattleEndPayload,
  type BattleStartPayload,
  type BattleSnapshot,
  type Difficulty,
  type RewardSummary,
  type UnitMeta,
} from "./protocol.js";
import { baseReward } from "./rewards.js";
import type { BattleStore } from "./store.js";

/** The engine advances in fixed steps. Ten a second keeps movement smooth without flooding the socket. */
export const TICK_MS = 100;
/** Full state twice a second: cheap, and keeps energy and cooldown bars honest between events. */
const SYNC_EVERY_MS = 500;

export interface BattleEmitter {
  start(payload: BattleStartPayload): void;
  events(payload: { matchId: string; events: BattleEvent[] }): void;
  sync(payload: { matchId: string; snapshot: BattleSnapshot }): void;
  end(payload: BattleEndPayload): void;
}

export interface SessionOptions {
  matchId: string;
  userId: string;
  difficulty: Difficulty;
  state: BattleState;
  metas: UnitMeta[];
  controlledUnitId: string | null;
  enemyTotalHp: number;
  store: BattleStore;
  emitter: BattleEmitter;
  onDone: () => void;
  log?: { error: (obj: unknown, msg?: string) => void };
}

/**
 * One live offline match. The server owns the clock and the rules: the browser can only ask for
 * a skill or a focus target, and the engine decides whether that is legal. Results and points are
 * settled in the database exactly once, when the engine says the battle is over.
 */
export class SoloSession {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly events: BattleEvent[] = [];
  private readonly sideOf = new Map<string, Side>();
  private damageDealt = 0;
  private damageTaken = 0;
  private lastSyncMs = 0;
  private closed = false;

  constructor(private readonly o: SessionOptions) {
    for (const u of o.state.units) this.sideOf.set(u.id, u.side);
  }

  get matchId(): string {
    return this.o.matchId;
  }

  startPayload(): BattleStartPayload {
    return {
      matchId: this.o.matchId,
      difficulty: this.o.difficulty,
      yourSide: 1,
      controlledUnitId: this.o.controlledUnitId,
      tickMs: TICK_MS,
      units: this.o.metas,
      snapshot: snapshot(this.o.state) as BattleSnapshot,
    };
  }

  start(): void {
    this.o.emitter.start(this.startPayload());
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  /** A skill request for the player's one controlled fighter. Invalid input is silently ignored. */
  intent(raw: unknown): void {
    const parsed = intentSchema.safeParse(raw);
    if (!parsed.success || !this.o.controlledUnitId || this.closed) return;
    submitIntent(this.o.state, this.o.controlledUnitId, parsed.data);
  }

  /** Team stance, only honoured when the player isn't steering a fighter (the engine enforces that). */
  stance(raw: unknown): void {
    const parsed = stanceSchema.safeParse(raw);
    if (!parsed.success || this.closed) return;
    submitStance(this.o.state, 1, parsed.data);
  }

  /** Stops the battle without a result or payout (the player left). */
  async abandon(): Promise<void> {
    if (this.closed) return;
    this.close();
    try {
      await this.o.store.abandon(this.o.matchId);
    } catch (err) {
      this.o.log?.error({ err, matchId: this.o.matchId }, "battle: abandon failed");
    }
    this.o.onDone();
  }

  /** Stops the timer without touching the database (server shutdown). */
  halt(): void {
    this.close();
  }

  private close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.closed) return;
    const { state } = this.o;
    const events = step(state, TICK_MS);
    this.record(events);
    if (events.length > 0) this.o.emitter.events({ matchId: this.o.matchId, events });

    if (state.finished) {
      void this.finish();
      return;
    }
    if (state.timeMs - this.lastSyncMs >= SYNC_EVERY_MS) {
      this.lastSyncMs = state.timeMs;
      this.o.emitter.sync({ matchId: this.o.matchId, snapshot: snapshot(state) as BattleSnapshot });
    }
  }

  private record(events: BattleEvent[]): void {
    for (const e of events) {
      this.events.push(e);
      if (e.type !== "damage") continue;
      const dealt = Math.max(0, e.amount - e.absorbed);
      const src = this.sideOf.get(e.sourceId);
      if (src === 1) this.damageDealt += dealt;
      else if (src === 2) this.damageTaken += dealt;
    }
  }

  private async finish(): Promise<void> {
    this.close();
    const { matchId, userId, state } = this.o;
    const durationMs = state.timeMs;
    const winnerSide = state.winnerSide;

    let reward: RewardSummary | null = null;
    try {
      reward = await this.o.store.settleMatch({
        matchId,
        userId,
        winnerSide,
        damageDealt: this.damageDealt,
        damageTaken: this.damageTaken,
        baseReward: baseReward({
          difficulty: this.o.difficulty,
          winnerSide,
          durationMs,
          damageDealt: this.damageDealt,
          enemyTotalHp: this.o.enemyTotalHp,
        }),
      });
    } catch (err) {
      this.o.log?.error({ err, matchId }, "battle: settle failed");
    }

    try {
      await this.o.store.saveLog(matchId, this.events);
    } catch (err) {
      this.o.log?.error({ err, matchId }, "battle: saving the log failed");
    }

    this.o.emitter.end({
      matchId,
      result: winnerSide === 1 ? "win" : winnerSide === 2 ? "loss" : "draw",
      winnerSide,
      durationMs,
      damageDealt: Math.round(this.damageDealt),
      reward,
    });
    this.o.onDone();
  }
}
