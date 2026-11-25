/** Stat bonuses from the gear a fighter is wearing (fighter_gear -> gear_items), added on top of the fighter's own stats. */
export interface GearBonus { atk: number; def: number; magic: number; hp: number; spd: number }
type Piece = { atk: number; def: number; magic: number; hp: number; spd: number; base_slug: string; rank: number };
export type GearRows = { slot: string; item: Piece | Piece[] | null }[] | null | undefined;

/** The select fragment to add to a fighters query. */
export const GEAR_SELECT = "gear:fighter_gear(slot, item:gear_items(base_slug, rank, atk, def, magic, hp, spd))";

/** Gear never adds more than this share of what the fighter has without it (2/3 means gear is at most 40% of the total). Mirrors TUNE.gearCap on the web. */
export const GEAR_CAP = 2 / 3;
type Own = { hp: number; atk: number; def: number; magic: number; spd: number };

export function gearBonus(rows: GearRows, own?: Own): GearBonus {
  const total: GearBonus = { atk: 0, def: 0, magic: 0, hp: 0, spd: 0 };
  for (const r of rows ?? []) {
    const it = Array.isArray(r.item) ? r.item[0] : r.item;
    if (!it) continue;
    total.atk += it.atk; total.def += it.def; total.magic += it.magic; total.hp += it.hp; total.spd += it.spd;
  }
  if (own) for (const k of ["hp", "atk", "def", "magic", "spd"] as const) total[k] = Math.min(total[k], Math.floor(own[k] * GEAR_CAP));
  return total;
}
