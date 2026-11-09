# Hustle Royale server

Authoritative game server: combat simulation, matchmaking, progression and marketplace.
The browser never decides an outcome; it only sends intents and renders events.

## Run locally

```bash
pnpm install
cp .env.example .env     # then fill in SUPABASE_SERVICE_ROLE_KEY (Supabase -> Settings -> API)
pnpm dev                 # http://localhost:4000/health
pnpm test:run
```

`SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security. Keep it in `.env` only (it is git-ignored), never in the web repo.

## Layout

```
src/
  index.ts, app.ts        bootstrap (Fastify, helmet, cors, rate limit)
  config/env.ts           validated environment
  plugins/                supabase (service role), auth (JWT verification), socket (Socket.IO + auth)
  engine/                 pure combat simulation: no network, no database, fully unit-tested
  modules/                starter-pack (POST /starter-pack/open); next: fighters, progression, training, marketplace, economy, battle
```

## Combat engine

`engine/` is a deterministic, real-time simulation. Call `step(state, dtMs)` on a fixed tick (about 100 ms) and broadcast the returned events.

- Every skill has a cooldown; speed shortens it: `cooldown = base * 50 / (50 + spd)`.
- Fighters use stamina-based energy for special skills. AI picks skills and targets (healers keep a heal reserve, tanks draw aggro).
- A participating player controls one fighter: `submitIntent(state, unitId, { type: "cast" | "focus", ... })`. The engine validates ownership, cooldown and energy. A controlled fighter auto-uses only its basic attack.
- Same seed, same battle, so a stored seed plus intents can replay or audit a match.
- Balance knobs live in `engine/stats.ts`.

### Movement and stances

Fighters live on a 30x20 arena (`ARENA_W/H`); side 1 spawns left, side 2 right, tanks in front and healers at the back, with a little seeded jitter.
`engine/movement.ts` plans a destination for every unit each tick, and all units plan from the same snapshot, so neither side moves first.

- **Roles:** tanks engage (and body-block for a weak ally on defence), melee DPS close on their target, ranged DPS kite (back off when an enemy gets too close), healers stay inside heal range of the most hurt ally and away from enemies. Wounded fighters fall back to their healer.
- **Targeting:** scored by distance, missing health, role (DPS hunt healers, tanks draw aggro) and stance, with stickiness so units don't flip targets.
- **Stances** (`offensive` / `neutral` / `defensive`) change decisions, not stats: how far units chase, how early healers heal, whether energy is spent freely or banked, whether a team holds its line until the enemy commits.
- **Who sets the stance:** `submitStance(state, side, stance)` works only for a player who is spectating. If the player controls a fighter, or the side is AI, the commander (`runCommander`) picks the stance every 2 s from how the fight is going.
- **Events:** `move` (changed positions per tick, arena units), `stance`, plus the existing combat events. `snapshot()` includes positions, arena size and stances for late-joining spectators.
- Skill `range` maps to `skills.range_units` (0 = unlimited, for self and team skills). A queued player cast walks the unit into range, and the intent lasts 3 s.

## Database

Schema, RLS and the starter catalog live in the Supabase project and are applied as migrations. Players have read-only access to their own data; every write goes through this server.
To generate types: `pnpm gen:types` (needs the Supabase CLI).
