import { existsSync } from "node:fs";
import { BotConfig } from "../config";
import { Logger } from "../logger";
import { BalanceSnapshot } from "../store/Store";
import { todayKey } from "../util/time";

type MidPoint = { ts: number; mid: number };

export class RiskManager {
  private readonly mids: MidPoint[] = [];
  private consecutiveErrors = 0;
  private pausedUntilMs = 0;
  private pauseReason = "";
  private baselineDay = "";
  private baselineEquityUsd: number | null = null;

  constructor(private readonly config: BotConfig, private readonly logger: Logger) {}

  checkKillSwitch(): boolean {
    return existsSync(this.config.killSwitchFile);
  }

  recordSuccess(): void {
    this.consecutiveErrors = 0;
  }

  recordError(error: unknown): { shouldStop: boolean; count: number } {
    this.consecutiveErrors += 1;
    this.logger.error(
      { error, consecutiveErrors: this.consecutiveErrors },
      "Strategy error recorded"
    );

    return {
      shouldStop: this.consecutiveErrors >= this.config.maxConsecutiveErrors,
      count: this.consecutiveErrors
    };
  }

  recordMid(mid: number, ts = Date.now()): { moveBps: number; tripped: boolean } {
    this.mids.push({ mid, ts });

    const cutoff = ts - this.config.pauseVolWindowSeconds * 1000;
    while (this.mids.length > 0 && this.mids[0].ts < cutoff) {
      this.mids.shift();
    }

    if (this.mids.length < 2 || this.mids[0].mid <= 0) {
      return { moveBps: 0, tripped: false };
    }

    const oldest = this.mids[0].mid;
    const newest = this.mids[this.mids.length - 1].mid;
    const moveBps = ((newest - oldest) / oldest) * 10_000;

    if (Math.abs(moveBps) >= this.config.pauseVolMoveBps) {
      this.pauseFor(5 * 60_000, `Volatility guard triggered (${moveBps.toFixed(2)} bps)`);
      return { moveBps, tripped: true };
    }

    return { moveBps, tripped: false };
  }

  isPaused(now = Date.now()): { paused: boolean; untilMs: number; reason: string } {
    return {
      paused: now < this.pausedUntilMs,
      untilMs: this.pausedUntilMs,
      reason: this.pauseReason
    };
  }

  pauseFor(durationMs: number, reason: string): void {
    this.pausedUntilMs = Date.now() + durationMs;
    this.pauseReason = reason;
    this.logger.warn({ pausedUntilMs: this.pausedUntilMs, reason }, "Quoting paused");
  }

  evaluateDailyLoss(
    mid: number,
    balances: BalanceSnapshot[],
    baseAsset: string,
    quoteAsset: string
  ): { pnlUsd: number; tripped: boolean } {
    const balMap = new Map<string, BalanceSnapshot>();
    for (const b of balances) {
      balMap.set(b.asset.toUpperCase(), b);
    }

    const base = balMap.get(baseAsset.toUpperCase())?.total ?? 0;
    const quote = balMap.get(quoteAsset.toUpperCase())?.total ?? 0;
    const equityUsd = quote + base * mid;

    const day = todayKey();
    if (this.baselineDay !== day || this.baselineEquityUsd === null) {
      this.baselineDay = day;
      this.baselineEquityUsd = equityUsd;
      return { pnlUsd: 0, tripped: false };
    }

    const pnlUsd = equityUsd - this.baselineEquityUsd;
    return {
      pnlUsd,
      tripped: pnlUsd <= this.config.pnlDailyStopUsd
    };
  }
}
