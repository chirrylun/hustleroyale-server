import type { SupabaseClient } from "@supabase/supabase-js";
import { minionInit, type DamageType, type Passive, type Role, type SkillDef, type SkillEffect, type SkillKind, type TargetRule, type UnitInit } from "../../engine/index.js";
import type { UnitMeta } from "./protocol.js";

/** A skill row exactly as the `skills` table stores it. */
export interface SkillRow {
  id?: string;
  slug: string;
  name: string;
  kind: SkillKind;
  damage_type: DamageType;
  power: number | string;
  cooldown_ms: number;
  stamina_cost: number;
  range_units: number;
  target_rule: TargetRule;
  effect: SkillEffect | null;
}

/** Skill level adds +8% effect per level; tree boosts add damage/healing and trim cooldowns. The basic attack only levels. */
export const SKILL_LEVEL_BONUS = 0.08;
export interface Boost { power_pct?: number; cooldown_pct?: number }
export function tuneSkill(row: SkillRow, index: number, level: number, boosts: Boost[]): SkillRow {
  if (index === 0) return row;
  const power = boosts.reduce((s, b) => s + (b.power_pct ?? 0), 0);
  const cd = Math.min(0.5, boosts.reduce((s, b) => s + (b.cooldown_pct ?? 0), 0));
  return {
    ...row,
    power: Number((Number(row.power) * (1 + SKILL_LEVEL_BONUS * (Math.min(5, Math.max(1, level)) - 1)) * (1 + power)).toFixed(3)),
    cooldown_ms: Math.round(row.cooldown_ms * (1 - cd)),
  };
}

export function toSkillDef(row: SkillRow): SkillDef {
  return {
    slug: row.slug,
    kind: row.kind,
    damageType: row.damage_type,
    power: Number(row.power),
    cooldownMs: row.cooldown_ms,
    staminaCost: row.stamina_cost,
    range: row.range_units,
    targetRule: row.target_rule,
    effect: row.effect ?? {},
  };
}

export function toSkillMeta(rows: SkillRow[]): UnitMeta["skills"] {
  return rows.map((s, index) => ({
    index,
    name: s.name,
    kind: s.kind,
    damageType: s.damage_type,
    cooldownMs: s.cooldown_ms,
    staminaCost: s.stamina_cost,
    range: s.range_units,
    ...(s.effect?.telegraph_ms ? { telegraphMs: s.effect.telegraph_ms, radius: s.effect.radius ?? 2.5 } : {}),
    ...(s.effect?.stun_ms ? { stunMs: s.effect.stun_ms } : {}),
    ...(s.effect?.knockback ? { knockback: s.effect.knockback } : {}),
    ...(s.effect?.pull ? { pull: s.effect.pull } : {}),
  }));
}

export class TeamError extends Error {
  constructor(public code: "no_team" | "invalid_team") {
    super(code);
  }
}

export interface LoadedTeam {
  units: UnitInit[];
  metas: UnitMeta[];
}

interface TemplateRow {
  name: string;
  role: Role;
  archetype?: string;
  sprite_key: string;
  passive?: unknown;
}

const PASSIVES = new Set(["regen", "thorns", "lifesteal", "crit", "energy", "resist"]);
/** A passive straight from the database, checked so a bad row can't put nonsense in a fight. */
export function toPassive(raw: unknown): Passive | undefined {
  const p = raw as { type?: string; value?: number } | null;
  if (!p || typeof p.type !== "string" || !PASSIVES.has(p.type) || typeof p.value !== "number" || !(p.value > 0 && p.value <= 1)) return undefined;
  return { type: p.type as Passive["type"], value: p.value };
}

/** The meta for a summoned minion: the browser needs to know it exists before it is called. */
export function minionMetas(units: UnitInit[]): UnitMeta[] {
  return units.filter((u) => u.skills.some((s) => s.effect.summon)).map((u) => {
    const m = minionInit(u);
    return { id: m.id, side: m.side, name: m.name, role: m.role, spriteKey: "skeleton", grade: null, level: 1, spd: m.stats.spd, controlled: false, summon: true, skills: [{ index: 0, name: "Strike", kind: "damage", damageType: "physical", cooldownMs: 1000, staminaCost: 0, range: 2 }] };
  });
}

interface FighterRow {
  id: string;
  grade: string;
  level: number;
  gender?: string;
  hp: number;
  atk: number;
  def: number;
  spd: number;
  stamina: number;
  magic: number;
  team_slot: number;
  template: TemplateRow | TemplateRow[] | null;
  skills: { slot: number; skill: SkillRow | SkillRow[] | null }[] | null;
  learned?: { skill_id: string; level: number }[] | null;
  nodes?: { node: { boost: Boost | null } | { boost: Boost | null }[] | null }[] | null;
}

/** PostgREST returns a single related row as an object, but be tolerant of an array of one. */
export const one = <T>(value: T | T[] | null | undefined): T | null => (Array.isArray(value) ? (value[0] ?? null) : (value ?? null));

/**
 * Reads the player's fighting team (team slots 1-3) straight from the database. The browser never
 * sends stats or skills, so a modified client can't fight with anything it doesn't own.
 */
export async function loadTeam(supabase: SupabaseClient, userId: string, controlledFighterId: string | null): Promise<LoadedTeam> {
  const { data, error } = await supabase
    .from("fighters")
    .select(
      "id, grade, level, gender, hp, atk, def, spd, stamina, magic, team_slot, template:fighter_templates(name, role, archetype, sprite_key, passive), skills:fighter_skills(slot, skill:skills(id, slug, name, kind, damage_type, power, cooldown_ms, stamina_cost, range_units, target_rule, effect)), learned:fighter_learned(skill_id, level), nodes:fighter_nodes(node:skill_nodes(boost))",
    )
    .eq("owner_id", userId)
    .not("team_slot", "is", null)
    .order("team_slot", { ascending: true });

  if (error) throw error;
  const rows = (data ?? []) as unknown as FighterRow[];
  if (rows.length === 0) throw new TeamError("no_team");
  if (rows.length > 3) throw new TeamError("invalid_team");
  if (controlledFighterId && !rows.some((r) => r.id === controlledFighterId)) throw new TeamError("invalid_team");

  const units: UnitInit[] = [];
  const metas: UnitMeta[] = [];

  for (const row of rows) {
    const template = one(row.template);
    const boosts = (row.nodes ?? []).map((n) => one(n.node)?.boost).filter((b): b is Boost => !!b);
    const skillRows = [...(row.skills ?? [])]
      .sort((a, b) => a.slot - b.slot)
      .map((s) => one(s.skill))
      .filter((s): s is SkillRow => s !== null)
      .map((sk, i) => tuneSkill(sk, i, row.learned?.find((l) => l.skill_id === sk.id)?.level ?? 1, boosts));

    // The engine treats skills[0] as the free basic attack. Refuse anything that breaks that.
    const basic = skillRows[0];
    if (!template || !basic || basic.stamina_cost !== 0 || basic.kind !== "damage") throw new TeamError("invalid_team");

    const controlled = row.id === controlledFighterId;
    units.push({
      id: row.id,
      side: 1,
      name: template.name,
      role: template.role,
      stats: { hp: row.hp, atk: row.atk, def: row.def, spd: row.spd, stamina: row.stamina, magic: row.magic },
      skills: skillRows.map(toSkillDef),
      controlled,
      passive: toPassive(template.passive),
    });
    metas.push({
      id: row.id,
      side: 1,
      name: template.name,
      role: template.role,
      spriteKey: template.archetype === "novice" ? `novice_${row.gender}` : template.sprite_key,
      grade: row.grade,
      level: row.level,
      spd: row.spd,
      controlled,
      skills: toSkillMeta(skillRows),
    });
  }
  return { units, metas: [...metas, ...minionMetas(units)] };
}
