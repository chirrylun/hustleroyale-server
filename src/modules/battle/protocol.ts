import { z } from "zod";
import type { BattleEvent, DamageType, Role, Side, SkillKind, Stance } from "../../engine/index.js";
import { BOSS_IDS, RANGE_IDS } from "./arena.js";

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
  /** A minion that sits out until its owner summons it. */
  summon?: boolean;
  skills: {
    index: number;
    name: string;
    kind: SkillKind;
    damageType: DamageType;
    cooldownMs: number;
    staminaCost: number;
    range: number;
    /** Set on big attacks that show a danger zone first. */
    telegraphMs?: number;
    radius?: number;
    stunMs?: number;
    knockback?: number;
    pull?: number;
  }[];
}

export interface BattleSnapshot {
  timeMs: number;
  arena: { w: number; h: number };
  stances: Record<Side, Stance>;
  finished: boolean;
  winnerSide: Side | null;
  layout: string;
  obstacles: { id: string; x: number; y: number; r: number; kind: "pillar" | "stall" }[];
  /** Match clock: a normal fight lasts regularMs, then the ring closes in over shrinkMs. */
  clock: { regularMs: number; shrinkMs: number; minRadius: number; capMs: number };
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
    stunMs: number;
    manual: boolean;
    windup: { id: number; x: number; y: number; radius: number; remainingMs: number; totalMs: number } | null;
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

/** Which arena mode a fight belongs to, and where in it (a raid stage). Absent on tutorial fights and the old practice match. */
export interface ArenaInfo {
  mode: "challenge" | "boss" | "raid";
  range: (typeof RANGE_IDS)[number];
  title: string;
  subtitle?: string;
  boss?: (typeof BOSS_IDS)[number];
  stage?: number;
  stages?: number;
}

/** What the end of an arena fight adds to the result: the boss rush ranking, or how far the raid got. */
export interface ArenaEnd {
  mode: "challenge" | "boss" | "raid";
  range: (typeof RANGE_IDS)[number];
  boss?: (typeof BOSS_IDS)[number];
  /** Raid: the stage just fought, how many there are, how many are cleared, and whether this was the last one. */
  stage?: number;
  stages?: number;
  cleared?: number;
  /** True when the run goes on: a won raid stage that is not the last. */
  more?: boolean;
  /** Boss rush, on a win: this time, the player's best, whether it is a new best, and the rank on the board. */
  bossRush?: { timeMs: number; bestMs: number; newBest: boolean; rank: number };
}

export interface BattleStartPayload {
  matchId: string;
  difficulty: Difficulty;
  arena?: ArenaInfo;
  /** Which side the player is on (always 1 in solo). */
  yourSide: Side;
  controlledUnitId: string | null;
  tickMs: number;
  units: UnitMeta[];
  snapshot: BattleSnapshot;
  /** True while the fight is set up but frozen, waiting for the player to press Start (tutorial fights). */
  awaitingStart?: boolean;
}

export interface BattleEndPayload {
  matchId: string;
  result: "win" | "loss" | "draw";
  winnerSide: Side | null;
  durationMs: number;
  damageDealt: number;
  /** Null if the payout could not be recorded (the match itself still counts as played). */
  reward: RewardSummary | null;
  arena?: ArenaEnd;
}

export type StartAck = { ok: true; matchId: string } | { ok: false; error: StartError };
export type StartError = "invalid_request" | "match_in_progress" | "no_team" | "invalid_team" | "server_error";
/** Joining the player queue: waiting for someone close to your level, or matched straight away. */
export type QueueAck = { ok: true; matched: boolean } | { ok: false; error: StartError };
export type NextAck = { ok: true } | { ok: false; error: "no_raid" | "match_in_progress" | "server_error" };

export interface ClientToServerEvents {
  "solo:start": (request: unknown, ack: (response: StartAck) => void) => void;
  "tutorial:start": (request: unknown, ack: (response: StartAck) => void) => void;
  /** Floor Raid: the last floor is cleared and the player is ready for the next one. */
  "raid:next": (ack: (response: NextAck) => void) => void;
  /** The player has read the instructions and pressed Start: the frozen tutorial fight begins. */
  "tutorial:begin": (ack: (response: { ok: boolean }) => void) => void;
  /** Challenge against a real player: wait for someone within a few levels (or fight at once if one is waiting). */
  "pvp:queue": (ack: (response: QueueAck) => void) => void;
  "pvp:cancel": () => void;
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
  /** A frozen tutorial fight has started ticking. */
  "battle:begin": (payload: { matchId: string }) => void;
  /** Nobody close to your level turned up while you waited. */
  "pvp:none": () => void;
}

/** Everything coming from the browser is untrusted: validate it before it reaches the engine. */
const controlled = z.uuid().nullish();
export const startRequestSchema = z.union([
  /** Challenge: an AI team of the chosen level range. No steering, no difficulty to pick. */
  z.object({ mode: z.literal("challenge"), range: z.enum(RANGE_IDS) }),
  z.object({ mode: z.literal("boss"), range: z.enum(RANGE_IDS), boss: z.enum(BOSS_IDS), controlledFighterId: controlled }),
  z.object({ mode: z.literal("raid"), range: z.enum(RANGE_IDS), controlledFighterId: controlled }),
  /** The old practice match, kept so a browser that has not reloaded yet still works. */
  z.object({ difficulty: z.enum(DIFFICULTIES), controlledFighterId: controlled }),
]);

export const intentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cast"), skillIndex: z.number().int().min(0).max(3), targetId: z.string().max(64).optional() }),
  z.object({ type: z.literal("focus"), targetId: z.string().max(64) }),
  z.object({ type: z.literal("move"), x: z.number().finite().min(-1000).max(1000), y: z.number().finite().min(-1000).max(1000) }),
  z.object({ type: z.literal("auto") }),
]);

export const stanceSchema = z.enum(["offensive", "neutral", "defensive"]);
