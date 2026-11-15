import { baseMobCount, isBossFloor, plausibleMob, type KillClaim } from "./rules.js";

/** One player's current visit to a floor, kept in memory (a restart just means the client re-enters). */
export interface FloorRun {
  floor: number;
  kills: number;
  bossDown: boolean;
  cleared: boolean;
  lastKillAt: number;
  touched: number;
}

const IDLE_MS = 2 * 60 * 60 * 1000;
const MIN_KILL_GAP_MS = 150; // area skills can drop several mobs at once; the database token bucket is the real rate limit

export class FloorRuns {
  private runs = new Map<string, FloorRun>();

  start(user: string, floor: number, now = Date.now()): FloorRun {
    const run: FloorRun = { floor, kills: 0, bossDown: false, cleared: false, lastKillAt: 0, touched: now };
    this.runs.set(user, run);
    return run;
  }

  get(user: string): FloorRun | undefined {
    return this.runs.get(user);
  }

  /** Checks a claimed kill against the run. Returns the reason it is refused, or null when it may be paid. */
  check(user: string, floor: number, m: KillClaim, now = Date.now()): "no_run" | "wrong_floor" | "bad_mob" | "too_fast" | "boss_done" | null {
    const run = this.runs.get(user);
    if (!run) return "no_run";
    if (run.floor !== floor) return "wrong_floor";
    if (!plausibleMob(floor, m)) return "bad_mob";
    if (m.boss && run.bossDown) return "boss_done";
    if (now - run.lastKillAt < MIN_KILL_GAP_MS) return "too_fast";
    run.lastKillAt = now;
    run.touched = now;
    return null;
  }

  /** Records a paid kill. Returns true the moment the floor becomes cleared. */
  paid(user: string, m: KillClaim): boolean {
    const run = this.runs.get(user);
    if (!run) return false;
    if (m.boss) run.bossDown = true;
    else run.kills++;
    if (run.cleared) return false;
    if (run.kills >= baseMobCount(run.floor) && (!isBossFloor(run.floor) || run.bossDown)) {
      run.cleared = true;
      return true;
    }
    return false;
  }

  prune(now = Date.now()) {
    for (const [u, r] of this.runs) if (now - r.touched > IDLE_MS) this.runs.delete(u);
  }
}
