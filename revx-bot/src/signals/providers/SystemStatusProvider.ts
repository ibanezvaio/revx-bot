import { BotConfig } from "../../config";
import { Store } from "../../store/Store";
import { RawSignalInput, SignalsProvider, SignalsProviderResult } from "../types";

export class SystemStatusProvider implements SignalsProvider {
  readonly name = "system-status";

  constructor(
    private readonly config: BotConfig,
    private readonly store: Store
  ) {}

  async fetch(nowTs: number): Promise<SignalsProviderResult> {
    const started = Date.now();
    const items: RawSignalInput[] = [];
    const rolling = this.store.getRollingMetrics(nowTs);
    const botStatus = this.store.getBotStatus();
    const latestSignal = this.store.getRecentSignalSnapshots(this.config.symbol, 1)[0] ?? null;

    if (rolling.post_only_rejects_last_1h >= Math.max(6, this.config.targetFillsPerHour * 2)) {
      items.push({
        ts: nowTs,
        kind: "SYSTEM",
        title: `Post-only rejects elevated (${rolling.post_only_rejects_last_1h}/1h)`,
        source: "revx-bot",
        symbols: ["BTC"],
        categoryHint: "risk",
        directionHint: "DOWN",
        impactHint: 0.62,
        confidenceHint: 0.72,
        horizonMinutesHint: 120,
        tags: ["rejects", "execution"]
      });
    }

    if (rolling.cancels_last_1h >= this.config.maxCancelsPerHour) {
      items.push({
        ts: nowTs,
        kind: "SYSTEM",
        title: `Cancel churn high (${rolling.cancels_last_1h}/1h)`,
        source: "revx-bot",
        symbols: ["BTC"],
        categoryHint: "risk",
        directionHint: "DOWN",
        impactHint: 0.48,
        confidenceHint: 0.68,
        horizonMinutesHint: 90,
        tags: ["churn", "execution"]
      });
    }

    const fillDroughtCount = this.store.getFillsSince(nowTs - this.config.fillDroughtMinutes * 60 * 1000).length;
    if (fillDroughtCount === 0) {
      items.push({
        ts: nowTs,
        kind: "SYSTEM",
        title: `Fill drought (${this.config.fillDroughtMinutes}m no fills)`,
        source: "revx-bot",
        symbols: ["BTC"],
        categoryHint: "risk",
        directionHint: "NEUTRAL",
        impactHint: 0.35,
        confidenceHint: 0.6,
        horizonMinutesHint: 60,
        tags: ["drought", "liquidity"]
      });
    }

    if (
      latestSignal &&
      Number.isFinite(Number(latestSignal.dispersion_bps)) &&
      Number(latestSignal.dispersion_bps) > this.config.fairMaxDispersionBps
    ) {
      items.push({
        ts: nowTs,
        kind: "SYSTEM",
        title: `Cross-venue dispersion spike (${Number(latestSignal.dispersion_bps).toFixed(2)} bps)`,
        source: "cross-venue",
        symbols: ["BTC"],
        categoryHint: "risk",
        directionHint: "DOWN",
        impactHint: 0.7,
        confidenceHint: 0.78,
        horizonMinutesHint: 45,
        tags: ["dispersion", "toxicity"]
      });
    }

    if (botStatus && botStatus.allow_buy === false && botStatus.allow_sell === false) {
      items.push({
        ts: nowTs,
        kind: "SYSTEM",
        title: "Both quote sides blocked by strategy guards",
        source: "revx-bot",
        symbols: ["BTC"],
        categoryHint: "risk",
        directionHint: "NEUTRAL",
        impactHint: 0.5,
        confidenceHint: 0.7,
        horizonMinutesHint: 60,
        tags: ["guards", "blocked"]
      });
    }

    return {
      provider: this.name,
      ok: true,
      items,
      error: "",
      durationMs: Date.now() - started,
      fetchedAtTs: nowTs
    };
  }
}
