/** Stat bonuses from the gear a fighter is wearing (fighter_gear -> equipment_templates), added on top of the fighter's own stats. */
export interface GearBonus { atk: number; def: number; magic: number; hp: number; spd: number }
type Piece = { atk: number; def: number; magic: number; hp: number; spd: number };
export type GearRows = { item: Piece | Piece[] | null }[] | null | undefined;

/** The select fragment to add to a fighters query. */
export const GEAR_SELECT = "gear:fighter_gear(item:equipment_templates(atk, def, magic, hp, spd))";

export function gearBonus(rows: GearRows): GearBonus {
  const total: GearBonus = { atk: 0, def: 0, magic: 0, hp: 0, spd: 0 };
  for (const r of rows ?? []) {
    const it = Array.isArray(r.item) ? r.item[0] : r.item;
    if (!it) continue;
    total.atk += it.atk; total.def += it.def; total.magic += it.magic; total.hp += it.hp; total.spd += it.spd;
  }
  return total;
}
