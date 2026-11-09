import type { SupabaseClient } from "@supabase/supabase-js";
import type { BattleEvent, Side } from "../../engine/index.js";
import type { RewardSummary } from "./protocol.js";
import { DAILY_CAP, TIERS } from "./rewards.js";

export class MatchInProgressError extends Error {
  constructor() {
    super("match_in_progress");
  }
}

export interface StartMatchArgs {
  userId: string;
  seed: number;
  controlledFighterId: string | null;
  team: unknown;
  foe: unknown;
}

export interface SettleArgs {
  matchId: string;
  userId: string;
  winnerSide: Side | null;
  damageDealt: number;
  damageTaken: number;
  baseReward: number;
}

/** Everything a battle needs from the database, so the battle loop itself can be tested without one. */
export interface BattleStore {
  startMatch(args: StartMatchArgs): Promise<string>;
  settleMatch(args: SettleArgs): Promise<RewardSummary>;
  saveLog(matchId: string, events: BattleEvent[]): Promise<void>;
  abandon(matchId: string): Promise<void>;
}

export class SupabaseBattleStore implements BattleStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async startMatch(a: StartMatchArgs): Promise<string> {
    const { data, error } = await this.supabase.rpc("start_solo_match", {
      p_user_id: a.userId,
      p_seed: a.seed,
      p_controlled: a.controlledFighterId,
      p_team: a.team,
      p_foe: a.foe,
    });
    if (error) {
      if ((error.message ?? "").includes("match_in_progress")) throw new MatchInProgressError();
      throw error;
    }
    return data as string;
  }

  async settleMatch(a: SettleArgs): Promise<RewardSummary> {
    const { data, error } = await this.supabase.rpc("settle_solo_match", {
      p_match_id: a.matchId,
      p_user_id: a.userId,
      p_winner_side: a.winnerSide,
      p_damage_dealt: Math.round(a.damageDealt),
      p_damage_taken: Math.round(a.damageTaken),
      p_base_reward: a.baseReward,
      p_daily_cap: DAILY_CAP,
      p_tiers: TIERS,
    });
    if (error) throw error;
    const r = data as {
      coins_earned: number;
      base: number;
      multiplier: number;
      daily_cap: number;
      earned_today: number;
      paid_matches_today: number;
      capped: boolean;
      balance: number;
    };
    return {
      coinsEarned: Number(r.coins_earned),
      base: Number(r.base),
      multiplier: Number(r.multiplier),
      dailyCap: Number(r.daily_cap),
      earnedToday: Number(r.earned_today),
      paidMatchesToday: Number(r.paid_matches_today),
      capped: r.capped,
      balance: Number(r.balance),
    };
  }

  async saveLog(matchId: string, events: BattleEvent[]): Promise<void> {
    // Movement ticks are 10 a second and only matter for live viewing; keep the replay compact.
    const compact = events.filter((e) => e.type !== "move");
    const { error } = await this.supabase.from("match_logs").insert({ match_id: matchId, events: compact });
    if (error) throw error;
  }

  async abandon(matchId: string): Promise<void> {
    const { error } = await this.supabase
      .from("matches")
      .update({ status: "abandoned", ended_at: new Date().toISOString() })
      .eq("id", matchId)
      .eq("status", "running");
    if (error) throw error;
  }
}
