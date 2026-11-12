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
  /** Ground attack: the danger zone shows for this long before it lands. Walk out in time and it misses. */
  telegraph_ms?: number;
  /** Radius of that danger zone, in arena units. */
  radius?: number;
  /** Stops the target moving and acting, and interrupts a wind-up. */
  stun_ms?: number;
  /** Shoves the target this far away from the attacker. */
  knockback?: number;
  /** Yanks the target toward the attacker. */
  pull?: number;
  /** Several stat changes at once (a curse that lowers defence and attack). */
  mods?: { stat: ModStat; pct: number }[];
  /** Extra damage against a wounded target: below this share of max health, hits deal pct% more. */
  bonus_low_hp?: { below: number; pct: number };
  /** Share (0-1) of the damage dealt that heals the caster. */
  lifesteal?: number;
  /** Damage over time: the skill's damage type, `power` per tick. */
  dot?: { power: number; duration_ms: number; interval_ms?: number };
  /** Healing over time on the target. */
  hot?: { power: number; duration_ms: number; interval_ms?: number };
  /** Strips harmful effects (debuffs, damage over time, stun) from the target. */
  cleanse?: boolean;
  /** Enemies hit are forced to attack the caster for this long. */
  taunt_ms?: number;
  /** The caster ignores this many incoming hits for up to evade_ms. */
  evade_hits?: number;
  evade_ms?: number;
  /** Target can only use its basic attack for this long. */
  silence_ms?: number;
  /** Calls a minion to the caster's side for duration_ms. */
  summon?: { duration_ms: number; hp_pct: number; atk_pct: number };
}

/** A rarity trait that is always on. Stronger on rarer fighters. */
export type PassiveType = "regen" | "thorns" | "lifesteal" | "crit" | "energy" | "resist";
export interface Passive {
  type: PassiveType;
  /** Fraction (0-1) of the relevant thing: crit chance, damage reflected, share healed, and so on. */
  value: number;
}

export interface OverTime {
  sourceId: string;
  kind: "dot" | "hot";
  damageType: DamageType;
  power: number;
  intervalMs: number;
  nextMs: number;
  untilMs: number;
  slug: string;
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
  passive?: Passive;
  /** A minion that starts out of the fight and joins when its owner summons it. */
  summonOf?: string;
}

export interface Modifier {
  stat: ModStat;
  pct: number;
  untilMs: number;
}

/** A telegraphed attack that is charging up. Its circle is the danger zone everyone can see. */
export interface Windup {
  id: number;
  skillIndex: number;
  x: number;
  y: number;
  radius: number;
  startedAt: number;
  resolveAt: number;
}

export interface Obstacle {
  id: string;
  x: number;
  y: number;
  r: number;
  kind: "pillar" | "stall";
}

export interface Unit extends UnitInit {
  x: number;
  y: number;
  /** Can't act or move until this time (stun). */
  stunUntil: number;
  /** Can't be stunned again until this time, so nobody gets chain-stunned to death. */
  stunImmuneUntil: number;
  windup: Windup | null;
  /** A player has taken over this unit's movement (controlled units only). */
  manual: boolean;
  manualDest: Vec | null;
  /** The AI has decided to sidestep this danger zone once it reacts. */
  dodge: { zoneId: number; reactAt: number } | null;
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
  overTime: OverTime[];
  evadeHits: number;
  evadeUntil: number;
  tauntId: string | null;
  tauntUntil: number;
  silenceUntil: number;
  /** A summoned minion leaves the fight at this time (0 = not a minion, or not yet summoned). */
  expiresAt: number;
}

export type Intent =
  | { type: "cast"; skillIndex: number; targetId?: string }
  | { type: "focus"; targetId: string }
  | { type: "move"; x: number; y: number }
  /** Hand movement back to the AI. */
  | { type: "auto" };

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
  /** Battle-clock time of the last hit between fighters; AI commits to the fight when it goes quiet. */
  lastHitMs: number;
  /** Last time once-a-second effects (regen, minion expiry) ran. */
  lastRegenMs: number;
  queued: BattleEvent[];
  obstacles: Obstacle[];
  layout: string;
  clock: { regularMs: number; shrinkMs: number; minRadius: number };
  warned: boolean;
  sudden: boolean;
  nextRingTickMs: number;
  zoneSeq: number;
  /** Chance (0-1) that an AI-driven fighter sidesteps a danger zone, per side. */
  dodgeChance: Record<Side, number>;
  maxDurationMs: number;
  finished: boolean;
  winnerSide: Side | null;
}

export type BattleEvent =
  | { t: number; type: "move"; units: { id: string; x: number; y: number }[] }
  | { t: number; type: "stance"; side: Side; stance: Stance }
  | { t: number; type: "cast"; actorId: string; skill: string; skillIndex: number; targetIds: string[] }
  | { t: number; type: "damage"; sourceId: string; targetId: string; amount: number; absorbed: number; hp: number; mult?: number; ring?: boolean; dot?: boolean; crit?: boolean }
  | { t: number; type: "heal"; sourceId: string; targetId: string; amount: number; hp: number; quiet?: boolean }
  | { t: number; type: "shield"; sourceId: string; targetId: string; amount: number }
  | { t: number; type: "mod"; sourceId: string; targetId: string; stat: ModStat; pct: number; durationMs: number }
  | { t: number; type: "telegraph"; id: number; actorId: string; skill: string; skillIndex: number; x: number; y: number; radius: number; durationMs: number }
  | { t: number; type: "burst"; id: number; actorId: string; x: number; y: number; radius: number }
  | { t: number; type: "stun"; sourceId: string; targetId: string; durationMs: number }
  | { t: number; type: "interrupt"; unitId: string; id: number }
  | { t: number; type: "displace"; unitId: string; x: number; y: number; fromX: number; fromY: number }
  | { t: number; type: "phase"; phase: "warning" | "sudden_death" }
  | { t: number; type: "evade"; sourceId: string; targetId: string }
  | { t: number; type: "cleanse"; targetId: string }
  | { t: number; type: "summon"; ownerId: string; unitId: string; x: number; y: number }
  | { t: number; type: "death"; unitId: string }
  | { t: number; type: "end"; winnerSide: Side | null };
