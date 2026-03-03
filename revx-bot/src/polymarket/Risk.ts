import { BotConfig } from "../config";
import { Logger } from "../logger";
import { RiskCheck, RiskCheckInput, RiskSnapshot } from "./types";

export class PolymarketRisk {
  private killSwitch = false;
  private killReason = "";
  private dailyRealizedPnlUsd = 0;
  private dayKey = currentDayKey();

  constructor(private readonly config: BotConfig, private readonly logger: Logger) {}

  checkNewOrder(input: RiskCheckInput): RiskCheck {
    this.rotateDay();

    if (this.killSwitch) {
      return { ok: false, reason: `KILL_SWITCH:${this.killReason || "ACTIVE"}` };
    }

    if (input.oracleAgeMs > this.config.polymarket.risk.staleMs) {
      return { ok: false, reason: "STALE_ORACLE" };
    }

    if (input.tauSec <= this.config.polymarket.risk.noNewOrdersInLastSec) {
      return { ok: false, reason: "NO_NEW_ORDERS_FINAL_SECONDS" };
    }

    if (input.openOrders >= this.config.polymarket.risk.maxOpenOrders) {
      return { ok: false, reason: "MAX_OPEN_ORDERS" };
    }

    if (input.totalExposureUsd + input.projectedOrderNotionalUsd > this.config.polymarket.risk.maxExposure) {
      return { ok: false, reason: "MAX_EXPOSURE" };
    }

    if (input.concurrentWindows >= this.config.polymarket.sizing.maxConcurrentWindows) {
      return { ok: false, reason: "MAX_CONCURRENT_WINDOWS" };
    }

    if (this.dailyRealizedPnlUsd <= -Math.abs(this.config.polymarket.sizing.maxDailyLoss)) {
      return { ok: false, reason: "MAX_DAILY_LOSS" };
    }

    return { ok: true };
  }

  snapshot(params: { openOrders: number; totalExposureUsd: number; concurrentWindows: number }): RiskSnapshot {
    this.rotateDay();
    return {
      killSwitch: this.killSwitch,
      openOrders: params.openOrders,
      totalExposureUsd: params.totalExposureUsd,
      concurrentWindows: params.concurrentWindows,
      dailyRealizedPnlUsd: this.dailyRealizedPnlUsd
    };
  }

  recordRealizedPnl(deltaUsd: number): void {
    this.rotateDay();
    if (!Number.isFinite(deltaUsd)) return;
    this.dailyRealizedPnlUsd += deltaUsd;
  }

  triggerKillSwitch(reason: string): void {
    this.killSwitch = true;
    this.killReason = reason;
    this.logger.error({ reason }, "Polymarket kill-switch activated");
  }

  clearKillSwitch(): void {
    this.killSwitch = false;
    this.killReason = "";
  }

  isKillSwitchActive(): boolean {
    return this.killSwitch;
  }

  getRemainingDailyLossBudget(): number {
    const limit = Math.abs(this.config.polymarket.sizing.maxDailyLoss);
    return Math.max(0, limit + Math.min(0, this.dailyRealizedPnlUsd));
  }

  private rotateDay(): void {
    const next = currentDayKey();
    if (next === this.dayKey) return;
    this.dayKey = next;
    this.dailyRealizedPnlUsd = 0;
  }
}

function currentDayKey(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}
