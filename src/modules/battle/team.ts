import type { SupabaseClient } from "@supabase/supabase-js";
import type { DamageType, Role, SkillDef, SkillEffect, SkillKind, TargetRule, UnitInit } from "../../engine/index.js";
import type { UnitMeta } from "./protocol.js";

/** A skill row exactly as the `skills` table stores it. */
export interface SkillRow {
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

interface FighterRow {
  id: string;
  grade: string;
  level: number;
  hp: number;
  atk: number;
  def: number;
  spd: number;
  stamina: number;
  magic: number;
  team_slot: number;
  template: { name: string; role: Role; sprite_key: string } | { name: string; role: Role; sprite_key: string }[] | null;
  skills: { slot: number; skill: SkillRow | SkillRow[] | null }[] | null;
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
      "id, grade, level, hp, atk, def, spd, stamina, magic, team_slot, template:fighter_templates(name, role, sprite_key), skills:fighter_skills(slot, skill:skills(slug, name, kind, damage_type, power, cooldown_ms, stamina_cost, range_units, target_rule, effect))",
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
    const skillRows = [...(row.skills ?? [])]
      .sort((a, b) => a.slot - b.slot)
      .map((s) => one(s.skill))
      .filter((s): s is SkillRow => s !== null);

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
    });
    metas.push({
      id: row.id,
      side: 1,
      name: template.name,
      role: template.role,
      spriteKey: template.sprite_key,
      grade: row.grade,
      level: row.level,
      spd: row.spd,
      controlled,
      skills: toSkillMeta(skillRows),
    });
  }
  return { units, metas };
}
