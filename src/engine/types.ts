export type Side = 1 | 2;
export type Role = "tank" | "healer" | "dps";
export type Stance = "offensive" | "neutral" | "defensive";
export const STANCES: Stance[] = ["offensive", "neutral", "defensive"];
export type SkillKind = "damage" | "heal" | "shield" | "buff" | "debuff";
export type DamageType = "physical" | "magical" | "none";
export type TargetRule =
  | "enemy_nearest"
  | "enemy_lowest_hp"
  | "ally_lowest_hp"
  | "self"
  | "all_enemies"
  | "all_allies";
export type ModStat = "atk" | "def" | "spd" | "magic";

export interface Vec {
  x: number;
  y: number;
}

export interface SkillEffect {
  stat?: ModStat;
  pct?: number;
  duration_ms?: number;
}

export interface SkillDef {
  slug: string;
  kind: SkillKind;
  damageType: DamageType;
  power: number;
  cooldownMs: number;
  staminaCost: number;
  /** Max distance to the target in arena units. 0 = no limit (self / whole team). Maps to skills.range_units. */
  range: number;
  targetRule: TargetRule;
  effect: SkillEffect;
}

export interface Stats {
  hp: number;
  atk: number;
  def: number;
  spd: number;
  stamina: number;
  magic: number;
}

/** Input for one fighter. skills[0] is always the basic attack (no cost). */
export interface UnitInit {
  id: string;
  side: Side;
  name: string;
  role: Role;
  stats: Stats;
  skills: SkillDef[];
  /** A player drives this unit's special skills. The engine only auto-uses its basic attack. */
  controlled?: boolean;
}

export interface Modifier {
  stat: ModStat;
  pct: number;
  untilMs: number;
}

export interface Unit extends UnitInit {
  x: number;
  y: number;
  /** Can't move until this time (short wind-up after a cast, so kiting isn't free). */
  lockUntil: number;
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  shield: number;
  shieldUntil: number;
  cooldowns: number[];
  mods: Modifier[];
  alive: boolean;
  /** Player-chosen focus target (controlled units only). */
  focusId: string | null;
  /** AI-chosen target the unit is moving toward and attacking. */
  targetId: string | null;
}

export type Intent =
  | { type: "cast"; skillIndex: number; targetId?: string }
  | { type: "focus"; targetId: string };

export interface PendingCast {
  skillIndex: number;
  targetId?: string;
  expiresAt: number;
}

export interface Rng {
  next(): number;
}

export interface BattleState {
  timeMs: number;
  tick: number;
  arena: { w: number; h: number };
  units: Unit[];
  rng: Rng;
  pending: Map<string, PendingCast>;
  stances: Record<Side, Stance>;
  /** Sides whose stance the AI commander manages (AI sides, and sides whose player controls a fighter). */
  autoSides: Set<Side>;
  nextCommanderMs: number;
  queued: BattleEvent[];
  maxDurationMs: number;
  finished: boolean;
  winnerSide: Side | null;
}

export type BattleEvent =
  | { t: number; type: "move"; units: { id: string; x: number; y: number }[] }
  | { t: number; type: "stance"; side: Side; stance: Stance }
  | { t: number; type: "cast"; actorId: string; skill: string; skillIndex: number; targetIds: string[] }
  | { t: number; type: "damage"; sourceId: string; targetId: string; amount: number; absorbed: number; hp: number }
  | { t: number; type: "heal"; sourceId: string; targetId: string; amount: number; hp: number }
  | { t: number; type: "shield"; sourceId: string; targetId: string; amount: number }
  | { t: number; type: "mod"; sourceId: string; targetId: string; stat: ModStat; pct: number; durationMs: number }
  | { t: number; type: "death"; unitId: string }
  | { t: number; type: "end"; winnerSide: Side | null };
