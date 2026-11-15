import { plausibleMob, type KillClaim } from "./rules.js";

/** One player's current visit to a floor, kept in memory (a restart just means the client re-enters). */
export interface FloorRun {
  floor: number;
  bossDown: boolean;
  lastKillAt: number;
  touched: number;
}

const IDLE_MS = 2 * 60 * 60 * 1000;
const MIN_KILL_GAP_MS = 150; // area skills can drop several mobs at once; the database token bucket is the real rate limit

export class FloorRuns {
  private runs = new Map<string, FloorRun>();

  start(user: string, floor: number, now = Date.now()): FloorRun {
    const run: FloorRun = { floor, bossDown: false, lastKillAt: 0, touched: now };
    this.runs.set(user, run);
    return run;
  }

  /** Starts a run unless the player is already on this floor (the room and the REST entry both announce it). */
  enter(user: string, floor: number, now = Date.now()): FloorRun {
    const cur = this.runs.get(user);
    if (cur && cur.floor === floor) { cur.touched = now; return cur; }
    return this.start(user, floor, now);
  }

  get(user: string): FloorRun | undefined {
    return this.runs.get(user);
  }

  /** Checks a claimed kill against the run. Returns the reason it is refused, or null when it may be paid. */
  check(user: string, floor: number, m: KillClaim, now = Date.now(), gap = true): "no_run" | "wrong_floor" | "bad_mob" | "too_fast" | "boss_done" | null {
    const run = this.runs.get(user);
    if (!run) return "no_run";
    if (run.floor !== floor) return "wrong_floor";
    if (!plausibleMob(floor, m)) return "bad_mob";
    if (m.boss && run.bossDown) return "boss_done";
    if (gap && now - run.lastKillAt < MIN_KILL_GAP_MS) return "too_fast";
    run.lastKillAt = now;
    run.touched = now;
    return null;
  }

  /** Records a paid kill (only bosses matter: each can fall once per visit). Floors are cleared by their quests, not by kill counts. */
  paid(user: string, m: KillClaim) {
    const run = this.runs.get(user);
    if (run && m.boss) run.bossDown = true;
  }

  prune(now = Date.now()) {
    for (const [u, r] of this.runs) if (now - r.touched > IDLE_MS) this.runs.delete(u);
  }
}
