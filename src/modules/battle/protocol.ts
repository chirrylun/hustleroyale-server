import { z } from "zod";
import type { BattleEvent, DamageType, Role, Side, SkillKind, Stance } from "../../engine/index.js";

export const DIFFICULTIES = ["rookie", "hustler", "boss"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** What the browser needs to draw a fighter. The engine itself only knows ids, stats and skills. */
export interface UnitMeta {
  id: string;
  side: Side;
  name: string;
  role: Role;
  spriteKey: string;
  grade: string | null;
  level: number;
  /** Base speed, so the browser can estimate cooldowns between server syncs. */
  spd: number;
  /** True for the one fighter this player is steering. */
  controlled: boolean;
  skills: { index: number; name: string; kind: SkillKind; damageType: DamageType; cooldownMs: number; staminaCost: number; range: number }[];
}

export interface BattleSnapshot {
  timeMs: number;
  arena: { w: number; h: number };
  stances: Record<Side, Stance>;
  finished: boolean;
  winnerSide: Side | null;
  units: {
    id: string;
    side: Side;
    name: string;
    role: Role;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    energy: number;
    maxEnergy: number;
    shield: number;
    alive: boolean;
    cooldowns: number[];
  }[];
}

export interface RewardSummary {
  coinsEarned: number;
  /** Points this match was worth before today's diminishing-returns multiplier. */
  base: number;
  multiplier: number;
  dailyCap: number;
  earnedToday: number;
  paidMatchesToday: number;
  /** True when the daily cap trimmed this payout. */
  capped: boolean;
  balance: number;
}

export interface BattleStartPayload {
  matchId: string;
  difficulty: Difficulty;
  /** Which side the player is on (always 1 in solo). */
  yourSide: Side;
  controlledUnitId: string | null;
  tickMs: number;
  units: UnitMeta[];
  snapshot: BattleSnapshot;
}

export interface BattleEndPayload {
  matchId: string;
  result: "win" | "loss" | "draw";
  winnerSide: Side | null;
  durationMs: number;
  damageDealt: number;
  /** Null if the payout could not be recorded (the match itself still counts as played). */
  reward: RewardSummary | null;
}

export type StartAck = { ok: true; matchId: string } | { ok: false; error: StartError };
export type StartError = "invalid_request" | "match_in_progress" | "no_team" | "invalid_team" | "server_error";

export interface ClientToServerEvents {
  "solo:start": (request: unknown, ack: (response: StartAck) => void) => void;
  "battle:intent": (intent: unknown) => void;
  "battle:stance": (stance: unknown) => void;
  /** Ask for the live match again (the player left the arena screen and came back, or refreshed). */
  "battle:rejoin": () => void;
}

export interface ServerToClientEvents {
  "battle:start": (payload: BattleStartPayload) => void;
  "battle:events": (payload: { matchId: string; events: BattleEvent[] }) => void;
  "battle:sync": (payload: { matchId: string; snapshot: BattleSnapshot }) => void;
  "battle:end": (payload: BattleEndPayload) => void;
}

/** Everything coming from the browser is untrusted: validate it before it reaches the engine. */
export const startRequestSchema = z.object({
  difficulty: z.enum(DIFFICULTIES),
  controlledFighterId: z.uuid().nullish(),
});

export const intentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cast"), skillIndex: z.number().int().min(0).max(3), targetId: z.string().max(64).optional() }),
  z.object({ type: z.literal("focus"), targetId: z.string().max(64) }),
]);

export const stanceSchema = z.enum(["offensive", "neutral", "defensive"]);
