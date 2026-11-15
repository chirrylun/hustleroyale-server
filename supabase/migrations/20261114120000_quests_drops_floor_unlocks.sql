-- Quest-gated adventure floors, monster drops, and a balanced XP curve.
--
--  * Floors no longer unlock by clearing the previous one. Floor N+1 opens when the player has turned in
--    BOTH quests posted for floor N (a kill quest and an item-fetch quest). Floor 1 is always open.
--  * Monsters drop items (rolled here, in the database, never by the client).
--  * Monster XP follows the level curve: at equal level, a team of three needs about 20 kills (rising
--    slowly with level) for a level. Quests pay a one-off 20% of a level at their floor.

-- ---------------------------------------------------------------------------------------------------
-- Player progress
alter table public.profiles
  add column if not exists floor_unlocked integer not null default 1 check (floor_unlocked between 1 and 40);

-- Anyone who already cleared floors keeps what they had earned: they could enter floor_cleared + 1.
update public.profiles set floor_unlocked = greatest(1, least(40, floor_cleared + 1));

-- ---------------------------------------------------------------------------------------------------
-- Items and drops
create table public.item_templates (
  slug text primary key,
  name text not null,
  blurb text not null default '',
  rarity public.rarity not null default 'common'
);

create table public.monster_drops (
  monster_kind text not null,
  boss_only boolean not null default false,
  item_slug text not null references public.item_templates (slug),
  chance numeric not null check (chance > 0 and chance <= 1),
  qty_min integer not null default 1 check (qty_min >= 1),
  qty_max integer not null default 1,
  primary key (monster_kind, boss_only, item_slug),
  check (qty_max >= qty_min)
);

create table public.player_items (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  item_slug text not null references public.item_templates (slug),
  qty integer not null check (qty >= 0),
  primary key (owner_id, item_slug)
);

insert into public.item_templates (slug, name, blurb, rarity) values
  ('slime_gel',    'Slime Gel',          'Sticky and faintly warm. Alchemists pay well for it.', 'common'),
  ('bat_wing',     'Bat Wing',           'Leathery and light. Torn clean off a cave bat.',       'common'),
  ('spore_cap',    'Spore Cap',          'A cap from a walking mushroom. Smells earthy.',        'common'),
  ('goblin_ear',   'Goblin Ear',         'Proof of a goblin kill, as the guild likes it.',       'uncommon'),
  ('golem_shard',  'Golem Shard',        'A chip of living stone, still humming.',               'uncommon'),
  ('wolf_fang',    'Wolf Fang',          'Long, curved, and cold to the touch.',                 'uncommon'),
  ('goblin_crown', 'Goblin Chief''s Crown', 'Bent tin and pride. The chief wore it everywhere.',  'legendary'),
  ('golem_heart',  'Colossus Heart',     'A glowing core the size of a fist.',                   'legendary'),
  ('marsh_cap',    'Marsh King''s Cap',  'A huge spotted cap that never dries out.',             'legendary'),
  ('frost_pelt',   'Frost Alpha Pelt',   'White fur that stays frozen in any weather.',          'legendary');

-- Normal monsters: a coin-flip for their own part. Bosses: a guaranteed haul plus their trophy.
insert into public.monster_drops (monster_kind, boss_only, item_slug, chance, qty_min, qty_max) values
  ('slime',    false, 'slime_gel',   0.5, 1, 1),
  ('bat',      false, 'bat_wing',    0.5, 1, 1),
  ('mushroom', false, 'spore_cap',   0.5, 1, 1),
  ('goblin',   false, 'goblin_ear',  0.5, 1, 1),
  ('golem',    false, 'golem_shard', 0.5, 1, 1),
  ('direwolf', false, 'wolf_fang',   0.5, 1, 1),
  ('goblin',   true,  'goblin_ear',  1.0, 3, 5),
  ('golem',    true,  'golem_shard', 1.0, 3, 5),
  ('mushroom', true,  'spore_cap',   1.0, 3, 5),
  ('direwolf', true,  'wolf_fang',   1.0, 3, 5),
  ('goblin',   true,  'goblin_crown', 1.0, 1, 1),
  ('golem',    true,  'golem_heart',   1.0, 1, 1),
  ('mushroom', true,  'marsh_cap',     1.0, 1, 1),
  ('direwolf', true,  'frost_pelt',    1.0, 1, 1);

-- ---------------------------------------------------------------------------------------------------
-- Quests
create table public.quests (
  slug text primary key,
  title text not null,
  blurb text not null,
  kind text not null check (kind in ('kill', 'fetch')),
  floor integer not null check (floor between 1 and 39),
  unlocks_floor integer not null check (unlocks_floor between 2 and 40),
  target_kind text,
  target_boss boolean not null default false,
  item_slug text references public.item_templates (slug),
  qty integer not null check (qty > 0),
  reward_coins integer not null check (reward_coins >= 0),
  reward_xp integer not null check (reward_xp >= 0),
  sort integer not null default 0,
  check (kind <> 'kill' or target_kind is not null),
  check (kind <> 'fetch' or item_slug is not null)
);

create table public.player_quests (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  quest_slug text not null references public.quests (slug),
  progress integer not null default 0 check (progress >= 0),
  status text not null default 'active' check (status in ('active', 'done')),
  accepted_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (owner_id, quest_slug)
);

-- Generated from the real floor layouts by tools/gen_quest_seed.py (web repo).
insert into public.quests (slug, title, blurb, kind, floor, unlocks_floor, target_kind, target_boss, item_slug, qty, reward_coins, reward_xp, sort) values
  ('kill-01', 'Cull the mushrooms', 'Defeat 2 mushrooms on Floor 1.', 'kill', 1, 2, 'mushroom', false, null, 2, 38, 11, 2),
  ('fetch-01', 'Gather Spore Caps', 'Bring back 2 Spore Caps from the monsters of Floor 1.', 'fetch', 1, 2, null, false, 'spore_cap', 2, 50, 11, 3),
  ('kill-02', 'Cull the mushrooms', 'Defeat 2 mushrooms on Floor 2.', 'kill', 2, 3, 'mushroom', false, null, 2, 46, 18, 4),
  ('fetch-02', 'Gather Slime Gel', 'Bring back 2 Slime Gel from the monsters of Floor 2.', 'fetch', 2, 3, null, false, 'slime_gel', 2, 60, 18, 5),
  ('kill-03', 'Cull the slimes', 'Defeat 3 slimes on Floor 3.', 'kill', 3, 4, 'slime', false, null, 3, 54, 26, 6),
  ('fetch-03', 'Gather Slime Gel', 'Bring back 4 Slime Gel from the monsters of Floor 3.', 'fetch', 3, 4, null, false, 'slime_gel', 4, 70, 26, 7),
  ('kill-04', 'Cull the bats', 'Defeat 3 bats on Floor 4.', 'kill', 4, 5, 'bat', false, null, 3, 62, 36, 8),
  ('fetch-04', 'Gather Slime Gel', 'Bring back 2 Slime Gel from the monsters of Floor 4.', 'fetch', 4, 5, null, false, 'slime_gel', 2, 80, 36, 9),
  ('kill-05', 'Cull the bats', 'Defeat 4 bats on Floor 5.', 'kill', 5, 6, 'bat', false, null, 4, 70, 48, 10),
  ('fetch-05', 'Gather Bat Wings', 'Bring back 4 Bat Wings from the monsters of Floor 5.', 'fetch', 5, 6, null, false, 'bat_wing', 4, 90, 48, 11),
  ('kill-06', 'Cull the slimes', 'Defeat 3 slimes on Floor 6.', 'kill', 6, 7, 'slime', false, null, 3, 78, 61, 12),
  ('fetch-06', 'Gather Bat Wings', 'Bring back 2 Bat Wings from the monsters of Floor 6.', 'fetch', 6, 7, null, false, 'bat_wing', 2, 100, 61, 13),
  ('kill-07', 'Cull the bats', 'Defeat 5 bats on Floor 7.', 'kill', 7, 8, 'bat', false, null, 5, 86, 76, 14),
  ('fetch-07', 'Gather Bat Wings', 'Bring back 6 Bat Wings from the monsters of Floor 7.', 'fetch', 7, 8, null, false, 'bat_wing', 6, 110, 76, 15),
  ('kill-08', 'Cull the bats', 'Defeat 4 bats on Floor 8.', 'kill', 8, 9, 'bat', false, null, 4, 94, 92, 16),
  ('fetch-08', 'Gather Spore Caps', 'Bring back 4 Spore Caps from the monsters of Floor 8.', 'fetch', 8, 9, null, false, 'spore_cap', 4, 120, 92, 17),
  ('kill-09', 'Cull the mushrooms', 'Defeat 4 mushrooms on Floor 9.', 'kill', 9, 10, 'mushroom', false, null, 4, 102, 110, 18),
  ('fetch-09', 'Gather Bat Wings', 'Bring back 3 Bat Wings from the monsters of Floor 9.', 'fetch', 9, 10, null, false, 'bat_wing', 3, 130, 110, 19),
  ('kill-10', 'Slay the Goblin Chief', 'The Goblin Chief holds the way to Floor 11. Defeat it on Floor 10.', 'kill', 10, 11, 'goblin', true, null, 1, 220, 195, 20),
  ('fetch-10', 'Gather Spore Caps', 'Bring back 3 Spore Caps from the monsters of Floor 10.', 'fetch', 10, 11, null, false, 'spore_cap', 3, 140, 130, 21),
  ('kill-11', 'Cull the goblins', 'Defeat 2 goblins on Floor 11.', 'kill', 11, 12, 'goblin', false, null, 2, 118, 151, 22),
  ('fetch-11', 'Gather Goblin Ears', 'Bring back 2 Goblin Ears from the monsters of Floor 11.', 'fetch', 11, 12, null, false, 'goblin_ear', 2, 150, 151, 23),
  ('kill-12', 'Cull the goblins', 'Defeat 2 goblins on Floor 12.', 'kill', 12, 13, 'goblin', false, null, 2, 126, 174, 24),
  ('fetch-12', 'Gather Slime Gel', 'Bring back 2 Slime Gel from the monsters of Floor 12.', 'fetch', 12, 13, null, false, 'slime_gel', 2, 160, 174, 25),
  ('kill-13', 'Cull the goblins', 'Defeat 3 goblins on Floor 13.', 'kill', 13, 14, 'goblin', false, null, 3, 134, 198, 26),
  ('fetch-13', 'Gather Goblin Ears', 'Bring back 4 Goblin Ears from the monsters of Floor 13.', 'fetch', 13, 14, null, false, 'goblin_ear', 4, 170, 198, 27),
  ('kill-14', 'Cull the goblins', 'Defeat 3 goblins on Floor 14.', 'kill', 14, 15, 'goblin', false, null, 3, 142, 224, 28),
  ('fetch-14', 'Gather Goblin Ears', 'Bring back 5 Goblin Ears from the monsters of Floor 14.', 'fetch', 14, 15, null, false, 'goblin_ear', 5, 180, 224, 29),
  ('kill-15', 'Cull the bats', 'Defeat 3 bats on Floor 15.', 'kill', 15, 16, 'bat', false, null, 3, 150, 252, 30),
  ('fetch-15', 'Gather Slime Gel', 'Bring back 3 Slime Gel from the monsters of Floor 15.', 'fetch', 15, 16, null, false, 'slime_gel', 3, 190, 252, 31),
  ('kill-16', 'Cull the goblins', 'Defeat 3 goblins on Floor 16.', 'kill', 16, 17, 'goblin', false, null, 3, 158, 281, 32),
  ('fetch-16', 'Gather Bat Wings', 'Bring back 2 Bat Wings from the monsters of Floor 16.', 'fetch', 16, 17, null, false, 'bat_wing', 2, 200, 281, 33),
  ('kill-17', 'Cull the slimes', 'Defeat 3 slimes on Floor 17.', 'kill', 17, 18, 'slime', false, null, 3, 166, 312, 34),
  ('fetch-17', 'Gather Bat Wings', 'Bring back 2 Bat Wings from the monsters of Floor 17.', 'fetch', 17, 18, null, false, 'bat_wing', 2, 210, 312, 35),
  ('kill-18', 'Cull the goblins', 'Defeat 3 goblins on Floor 18.', 'kill', 18, 19, 'goblin', false, null, 3, 174, 344, 36),
  ('fetch-18', 'Gather Slime Gel', 'Bring back 3 Slime Gel from the monsters of Floor 18.', 'fetch', 18, 19, null, false, 'slime_gel', 3, 220, 344, 37),
  ('kill-19', 'Cull the bats', 'Defeat 3 bats on Floor 19.', 'kill', 19, 20, 'bat', false, null, 3, 182, 378, 38),
  ('fetch-19', 'Gather Goblin Ears', 'Bring back 3 Goblin Ears from the monsters of Floor 19.', 'fetch', 19, 20, null, false, 'goblin_ear', 3, 230, 378, 39),
  ('kill-20', 'Slay the Stone Colossus', 'The Stone Colossus holds the way to Floor 21. Defeat it on Floor 20.', 'kill', 20, 21, 'golem', true, null, 1, 380, 621, 40),
  ('fetch-20', 'Gather Goblin Ears', 'Bring back 2 Goblin Ears from the monsters of Floor 20.', 'fetch', 20, 21, null, false, 'goblin_ear', 2, 240, 414, 41),
  ('kill-21', 'Cull the slimes', 'Defeat 2 slimes on Floor 21.', 'kill', 21, 22, 'slime', false, null, 2, 198, 451, 42),
  ('fetch-21', 'Gather Slime Gel', 'Bring back 2 Slime Gel from the monsters of Floor 21.', 'fetch', 21, 22, null, false, 'slime_gel', 2, 250, 451, 43),
  ('kill-22', 'Cull the mushrooms', 'Defeat 2 mushrooms on Floor 22.', 'kill', 22, 23, 'mushroom', false, null, 2, 206, 490, 44),
  ('fetch-22', 'Gather Slime Gel', 'Bring back 2 Slime Gel from the monsters of Floor 22.', 'fetch', 22, 23, null, false, 'slime_gel', 2, 260, 490, 45),
  ('kill-23', 'Cull the mushrooms', 'Defeat 3 mushrooms on Floor 23.', 'kill', 23, 24, 'mushroom', false, null, 3, 214, 530, 46),
  ('fetch-23', 'Gather Slime Gel', 'Bring back 2 Slime Gel from the monsters of Floor 23.', 'fetch', 23, 24, null, false, 'slime_gel', 2, 270, 530, 47),
  ('kill-24', 'Cull the goblins', 'Defeat 2 goblins on Floor 24.', 'kill', 24, 25, 'goblin', false, null, 2, 222, 572, 48),
  ('fetch-24', 'Gather Spore Caps', 'Bring back 2 Spore Caps from the monsters of Floor 24.', 'fetch', 24, 25, null, false, 'spore_cap', 2, 280, 572, 49),
  ('kill-25', 'Cull the mushrooms', 'Defeat 4 mushrooms on Floor 25.', 'kill', 25, 26, 'mushroom', false, null, 4, 230, 616, 50),
  ('fetch-25', 'Gather Spore Caps', 'Bring back 5 Spore Caps from the monsters of Floor 25.', 'fetch', 25, 26, null, false, 'spore_cap', 5, 290, 616, 51),
  ('kill-26', 'Cull the goblins', 'Defeat 3 goblins on Floor 26.', 'kill', 26, 27, 'goblin', false, null, 3, 238, 661, 52),
  ('fetch-26', 'Gather Spore Caps', 'Bring back 3 Spore Caps from the monsters of Floor 26.', 'fetch', 26, 27, null, false, 'spore_cap', 3, 300, 661, 53),
  ('kill-27', 'Cull the goblins', 'Defeat 3 goblins on Floor 27.', 'kill', 27, 28, 'goblin', false, null, 3, 246, 708, 54),
  ('fetch-27', 'Gather Slime Gel', 'Bring back 3 Slime Gel from the monsters of Floor 27.', 'fetch', 27, 28, null, false, 'slime_gel', 3, 310, 708, 55),
  ('kill-28', 'Cull the slimes', 'Defeat 4 slimes on Floor 28.', 'kill', 28, 29, 'slime', false, null, 4, 254, 756, 56),
  ('fetch-28', 'Gather Spore Caps', 'Bring back 3 Spore Caps from the monsters of Floor 28.', 'fetch', 28, 29, null, false, 'spore_cap', 3, 320, 756, 57),
  ('kill-29', 'Cull the goblins', 'Defeat 4 goblins on Floor 29.', 'kill', 29, 30, 'goblin', false, null, 4, 262, 806, 58),
  ('fetch-29', 'Gather Spore Caps', 'Bring back 2 Spore Caps from the monsters of Floor 29.', 'fetch', 29, 30, null, false, 'spore_cap', 2, 330, 806, 59),
  ('kill-30', 'Slay the Marsh King', 'The Marsh King holds the way to Floor 31. Defeat it on Floor 30.', 'kill', 30, 31, 'mushroom', true, null, 1, 540, 1287, 60),
  ('fetch-30', 'Gather Goblin Ears', 'Bring back 3 Goblin Ears from the monsters of Floor 30.', 'fetch', 30, 31, null, false, 'goblin_ear', 3, 340, 858, 61),
  ('kill-31', 'Cull the slimes', 'Defeat 2 slimes on Floor 31.', 'kill', 31, 32, 'slime', false, null, 2, 278, 911, 62),
  ('fetch-31', 'Gather Slime Gel', 'Bring back 3 Slime Gel from the monsters of Floor 31.', 'fetch', 31, 32, null, false, 'slime_gel', 3, 350, 911, 63),
  ('kill-32', 'Cull the direwolves', 'Defeat 2 direwolves on Floor 32.', 'kill', 32, 33, 'direwolf', false, null, 2, 286, 966, 64),
  ('fetch-32', 'Gather Wolf Fangs', 'Bring back 3 Wolf Fangs from the monsters of Floor 32.', 'fetch', 32, 33, null, false, 'wolf_fang', 3, 360, 966, 65),
  ('kill-33', 'Cull the golems', 'Defeat 2 golems on Floor 33.', 'kill', 33, 34, 'golem', false, null, 2, 294, 1022, 66),
  ('fetch-33', 'Gather Slime Gel', 'Bring back 2 Slime Gel from the monsters of Floor 33.', 'fetch', 33, 34, null, false, 'slime_gel', 2, 370, 1022, 67),
  ('kill-34', 'Cull the golems', 'Defeat 3 golems on Floor 34.', 'kill', 34, 35, 'golem', false, null, 3, 302, 1080, 68),
  ('fetch-34', 'Gather Slime Gel', 'Bring back 2 Slime Gel from the monsters of Floor 34.', 'fetch', 34, 35, null, false, 'slime_gel', 2, 380, 1080, 69),
  ('kill-35', 'Cull the golems', 'Defeat 4 golems on Floor 35.', 'kill', 35, 36, 'golem', false, null, 4, 310, 1140, 70),
  ('fetch-35', 'Gather Golem Shards', 'Bring back 4 Golem Shards from the monsters of Floor 35.', 'fetch', 35, 36, null, false, 'golem_shard', 4, 390, 1140, 71),
  ('kill-36', 'Cull the golems', 'Defeat 4 golems on Floor 36.', 'kill', 36, 37, 'golem', false, null, 4, 318, 1201, 72),
  ('fetch-36', 'Gather Slime Gel', 'Bring back 2 Slime Gel from the monsters of Floor 36.', 'fetch', 36, 37, null, false, 'slime_gel', 2, 400, 1201, 73),
  ('kill-37', 'Cull the golems', 'Defeat 5 golems on Floor 37.', 'kill', 37, 38, 'golem', false, null, 5, 326, 1264, 74),
  ('fetch-37', 'Gather Slime Gel', 'Bring back 2 Slime Gel from the monsters of Floor 37.', 'fetch', 37, 38, null, false, 'slime_gel', 2, 410, 1264, 75),
  ('kill-38', 'Cull the direwolves', 'Defeat 4 direwolves on Floor 38.', 'kill', 38, 39, 'direwolf', false, null, 4, 334, 1328, 76),
  ('fetch-38', 'Gather Golem Shards', 'Bring back 2 Golem Shards from the monsters of Floor 38.', 'fetch', 38, 39, null, false, 'golem_shard', 2, 420, 1328, 77),
  ('kill-39', 'Cull the golems', 'Defeat 3 golems on Floor 39.', 'kill', 39, 40, 'golem', false, null, 3, 342, 1394, 78),
  ('fetch-39', 'Gather Slime Gel', 'Bring back 3 Slime Gel from the monsters of Floor 39.', 'fetch', 39, 40, null, false, 'slime_gel', 3, 430, 1394, 79);

-- Existing players already hold the floors they unlocked: mark those gates as done (no payout) so the board
-- only ever shows the quests that still matter.
insert into public.player_quests (owner_id, quest_slug, progress, status, completed_at)
select p.id, q.slug, q.qty, 'done', now()
from public.profiles p
join public.quests q on q.unlocks_floor <= p.floor_unlocked;

-- ---------------------------------------------------------------------------------------------------
-- Row level security: players read the catalogue and their own rows; every write goes through the functions below.
alter table public.item_templates enable row level security;
alter table public.monster_drops enable row level security;
alter table public.quests enable row level security;
alter table public.player_items enable row level security;
alter table public.player_quests enable row level security;

create policy item_templates_read on public.item_templates for select to authenticated using (true);
create policy monster_drops_read on public.monster_drops for select to authenticated using (true);
create policy quests_read on public.quests for select to authenticated using (true);
create policy player_items_read_own on public.player_items for select to authenticated using (owner_id = (select auth.uid()));
create policy player_quests_read_own on public.player_quests for select to authenticated using (owner_id = (select auth.uid()));

revoke all on public.item_templates, public.monster_drops, public.quests, public.player_items, public.player_quests from anon;
revoke insert, update, delete, truncate on public.item_templates, public.monster_drops, public.quests, public.player_items, public.player_quests from authenticated;

-- ---------------------------------------------------------------------------------------------------
-- XP a monster pays. The pool is sized so that three fighters at the monster's level need about
-- (20 + 0.2 * level) kills per level: xp_required(L) / (kills * 0.5667), where 0.5667 is the share each
-- fighter of a three-man team receives from award_xp's party formula. Bosses pay six times a normal kill.
-- Fighters above the monster's level get less automatically through xp_multiplier, which is what keeps the
-- whole ladder self-balancing: out-levelling a floor makes it worth less.
create or replace function public.mob_base_xp(p_level integer, p_boss boolean default false)
returns integer
language sql
immutable
set search_path = ''
as $$
  select round(
    public.xp_required(greatest(p_level, 1))::numeric
    / ((20 + 0.2 * greatest(p_level, 1)) * (1 + 0.35 * 2) / 3)
    * case when p_boss then 6 else 1 end
  )::integer
$$;

-- A kill on an adventure floor: pays XP to the team, rolls drops, and advances kill quests.
create or replace function public.report_floor_kill(p_floor integer, p_kind text, p_level integer, p_boss boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record; r record; d record;
  v_lv integer; v_base integer; v_n integer; v_total integer := 0; v_qty integer;
  v_drops jsonb := '[]'::jsonb; v_quests jsonb;
begin
  select * into p from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'unauthorized'; end if;
  if p_floor < 1 or p_floor > 40 or p_floor > p.floor_unlocked then raise exception 'floor_locked'; end if;
  if not exists (select 1 from public.monster_drops where monster_kind = p_kind) then raise exception 'bad_monster'; end if;
  if p_boss and p_floor % 10 <> 0 then raise exception 'bad_monster'; end if;

  -- Mobs spawn at the floor's level, one above for some, and bosses two above.
  v_lv := greatest(1, least(p_level, p_floor + case when p_boss then 2 else 1 end));
  v_base := public.mob_base_xp(v_lv, p_boss);

  if p.tutorial_step = 8 and p_floor = 1 and p_kind = 'bat' and p.tutorial_bat_at is null then
    update public.profiles set tutorial_bat_at = now() where id = p.id;
  end if;

  select count(*) into v_n from public.fighters where owner_id = p.id and team_slot is not null;
  for r in select id from public.fighters where owner_id = p.id and team_slot is not null loop
    perform public.award_xp(r.id, v_base, v_lv, greatest(v_n, 1));
    v_total := v_total + 1;
  end loop;

  for d in
    select md.item_slug, md.chance, md.qty_min, md.qty_max, it.name as item_name
    from public.monster_drops md join public.item_templates it on it.slug = md.item_slug
    where md.monster_kind = p_kind and md.boss_only = p_boss
  loop
    if random() < d.chance then
      v_qty := d.qty_min + floor(random() * (d.qty_max - d.qty_min + 1))::integer;
      insert into public.player_items (owner_id, item_slug, qty) values (p.id, d.item_slug, v_qty)
        on conflict (owner_id, item_slug) do update set qty = public.player_items.qty + excluded.qty;
      v_drops := v_drops || jsonb_build_object('slug', d.item_slug, 'name', d.item_name, 'qty', v_qty);
    end if;
  end loop;

  update public.player_quests pq set progress = least(q.qty, pq.progress + 1)
  from public.quests q
  where pq.owner_id = p.id and pq.quest_slug = q.slug and pq.status = 'active'
    and q.kind = 'kill' and q.floor = p_floor and q.target_kind = p_kind and q.target_boss = p_boss;

  select coalesce(jsonb_agg(jsonb_build_object('slug', q.slug, 'progress', pq.progress, 'qty', q.qty)), '[]'::jsonb) into v_quests
  from public.player_quests pq join public.quests q on q.slug = pq.quest_slug
  where pq.owner_id = p.id and pq.status = 'active' and q.kind = 'kill' and q.floor = p_floor
    and q.target_kind = p_kind and q.target_boss = p_boss;

  return jsonb_build_object('xp', v_base, 'fighters', v_total, 'drops', v_drops, 'quests', v_quests);
end $$;

-- Clearing a floor is now only a record (floor_cleared); it no longer opens the next floor.
create or replace function public.clear_floor(p_floor integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare c integer;
begin
  update public.profiles set floor_cleared = greatest(floor_cleared, p_floor)
  where id = auth.uid() and p_floor between 1 and 40 and p_floor <= floor_unlocked
  returning floor_cleared into c;
  if c is null then raise exception 'floor_locked'; end if;
  return c;
end $$;

-- Take a quest from the job board. Only quests for floors the player can already enter are on offer.
create or replace function public.accept_quest(p_slug text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare p record; q record;
begin
  select * into p from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'unauthorized'; end if;
  if p.tutorial_step < 9 then raise exception 'finish_first_job'; end if;
  select * into q from public.quests where slug = p_slug;
  if not found then raise exception 'no_such_quest'; end if;
  if q.floor > p.floor_unlocked then raise exception 'floor_locked'; end if;
  if exists (select 1 from public.player_quests where owner_id = p.id and quest_slug = p_slug) then raise exception 'already_taken'; end if;
  insert into public.player_quests (owner_id, quest_slug) values (p.id, p_slug);
end $$;

-- Hand a finished quest in: pays coins and XP, takes fetch items, and opens the next floor once both of
-- a floor's quests are done.
create or replace function public.claim_quest(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record; q record; pq record; f record;
  v_have integer; v_bal bigint; v_left integer; v_unlocked integer := null;
begin
  select * into p from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'unauthorized'; end if;
  select * into q from public.quests where slug = p_slug;
  if not found then raise exception 'no_such_quest'; end if;
  select * into pq from public.player_quests where owner_id = p.id and quest_slug = p_slug for update;
  if not found or pq.status <> 'active' then raise exception 'quest_not_active'; end if;

  if q.kind = 'kill' then
    if pq.progress < q.qty then raise exception 'quest_not_done'; end if;
  else
    select qty into v_have from public.player_items where owner_id = p.id and item_slug = q.item_slug for update;
    if coalesce(v_have, 0) < q.qty then raise exception 'quest_not_done'; end if;
    update public.player_items set qty = qty - q.qty where owner_id = p.id and item_slug = q.item_slug;
  end if;

  update public.player_quests set status = 'done', progress = q.qty, completed_at = now()
  where owner_id = p.id and quest_slug = p_slug;

  update public.profiles set coins = coins + q.reward_coins where id = p.id returning coins into v_bal;
  insert into public.coin_ledger (user_id, amount, balance_after, reason) values (p.id, q.reward_coins, v_bal, 'quest');

  -- A flat reward per team fighter. The enemy level passed is the fighter's own, so the level multiplier is 1.
  for f in select id, level from public.fighters where owner_id = p.id and team_slot is not null loop
    perform public.award_xp(f.id, q.reward_xp, f.level, 1);
  end loop;

  select count(*) into v_left
  from public.quests g
  left join public.player_quests x on x.quest_slug = g.slug and x.owner_id = p.id
  where g.unlocks_floor = q.unlocks_floor and coalesce(x.status, '') <> 'done';
  if v_left = 0 and q.unlocks_floor > p.floor_unlocked then
    update public.profiles set floor_unlocked = q.unlocks_floor where id = p.id;
    v_unlocked := q.unlocks_floor;
  end if;

  return jsonb_build_object('coins', q.reward_coins, 'xp', q.reward_xp, 'unlocked', v_unlocked);
end $$;

-- Only signed-in players call these.
revoke execute on function public.report_floor_kill(integer, text, integer, boolean) from public, anon;
revoke execute on function public.clear_floor(integer) from public, anon;
revoke execute on function public.accept_quest(text) from public, anon;
revoke execute on function public.claim_quest(text) from public, anon;
revoke execute on function public.mob_base_xp(integer, boolean) from public, anon;
grant execute on function public.report_floor_kill(integer, text, integer, boolean) to authenticated;
grant execute on function public.clear_floor(integer) to authenticated;
grant execute on function public.accept_quest(text) to authenticated;
grant execute on function public.claim_quest(text) to authenticated;
grant execute on function public.mob_base_xp(integer, boolean) to authenticated;
