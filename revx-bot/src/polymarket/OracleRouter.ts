import { BotConfig } from "../config";
import { Logger } from "../logger";
import { MetricRecord, Store } from "../store/Store";
import { OracleEstimator } from "./OracleEstimator";

export type OracleSource = "internal_fair_mid" | "oracle_proxy" | "none";
export type OracleState = "INIT" | "OK" | "ORACLE_STALE" | "ORACLE_UNAVAILABLE";

export type OracleSnapshot = {
  price: number;
  source: OracleSource;
  ts: number;
  rawTs: number;
  staleMs: number;
  state: OracleState;
  fallbackSigmaPricePerSqrtSec: number;
};

type Candidate = {
  price: number;
  ts: number;
  source: Exclude<OracleSource, "none">;
};

export class OracleRouter {
  private readonly rolling: Array<{ ts: number; price: number }> = [];
  private lastMonotonicTs = 0;
  private lastGood: Candidate | null = null;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly options: {
      symbol: string;
      estimator: OracleEstimator;
      store?: Store;
      rollingSamples?: number;
    }
  ) {}

  async getOracleNow(nowTs = Date.now()): Promise<OracleSnapshot> {
    const primary = this.readPrimaryFromStore(nowTs);
    let secondary: Candidate | null = null;

    if (!primary || this.isStale(primary.ts, nowTs)) {
      try {
        const estimate = await this.options.estimator.estimate(this.options.symbol, nowTs);
        if (estimate.oracleEst > 0 && estimate.ts > 0) {
          secondary = {
            price: estimate.oracleEst,
            ts: estimate.ts,
            source: "oracle_proxy"
          };
        }
      } catch (error) {
        this.logger.warn(
          {
            error: error instanceof Error ? error.message : String(error)
          },
          "OracleRouter secondary oracle fetch failed"
        );
      }
    }

    const chosen = this.chooseCandidate(primary, secondary, nowTs);
    if (!chosen) {
      return {
        price: 0,
        source: "none",
        ts: this.nextMonotonicTs(nowTs),
        rawTs: 0,
        staleMs: Number.POSITIVE_INFINITY,
        state: "ORACLE_UNAVAILABLE",
        fallbackSigmaPricePerSqrtSec: this.computeRollingSigmaPricePerSqrtSec(0, nowTs)
      };
    }

    this.lastGood = chosen;
    this.pushRolling(chosen.price, chosen.ts);

    const staleMs = Math.max(0, nowTs - chosen.ts);
    const state: OracleState = staleMs > this.config.polymarket.risk.staleMs ? "ORACLE_STALE" : "OK";
    return {
      price: chosen.price,
      source: chosen.source,
      ts: this.nextMonotonicTs(chosen.ts),
      rawTs: chosen.ts,
      staleMs,
      state,
      fallbackSigmaPricePerSqrtSec: this.computeRollingSigmaPricePerSqrtSec(chosen.price, nowTs)
    };
  }

  getFastMidNow(nowTs = Date.now()): { price: number; ts: number; source: "internal_fair_mid" } | null {
    const primary = this.readPrimaryFromStore(nowTs);
    if (!primary) return null;
    if (!(primary.price > 0) || !(primary.ts > 0)) return null;
    return {
      price: primary.price,
      ts: primary.ts,
      source: "internal_fair_mid"
    };
  }

  private readPrimaryFromStore(nowTs: number): Candidate | null {
    if (!this.options.store) return null;

    const fair = this.latestValidMetric(this.options.store.getMetrics("signalFairMid", nowTs - 15 * 60 * 1000, 40));
    if (fair) {
      return {
        price: fair.value,
        ts: fair.ts,
        source: "internal_fair_mid"
      };
    }
    const global = this.latestValidMetric(this.options.store.getMetrics("signalGlobalMid", nowTs - 15 * 60 * 1000, 40));
    if (global) {
      return {
        price: global.value,
        ts: global.ts,
        source: "internal_fair_mid"
      };
    }
    return null;
  }

  private latestValidMetric(metrics: MetricRecord[]): MetricRecord | null {
    for (const metric of metrics) {
      if (Number.isFinite(metric.value) && metric.value > 0 && Number.isFinite(metric.ts) && metric.ts > 0) {
        return metric;
      }
    }
    return null;
  }

  private chooseCandidate(primary: Candidate | null, secondary: Candidate | null, nowTs: number): Candidate | null {
    if (primary && !this.isStale(primary.ts, nowTs)) {
      return primary;
    }
    if (secondary && !this.isStale(secondary.ts, nowTs)) {
      return secondary;
    }
    if (primary) return primary;
    if (secondary) return secondary;
    if (this.lastGood) return this.lastGood;
    return null;
  }

  private isStale(ts: number, nowTs: number): boolean {
    return nowTs - ts > this.config.polymarket.risk.staleMs;
  }

  private nextMonotonicTs(candidateTs: number): number {
    const ts = Math.max(1, Math.floor(candidateTs));
    if (ts <= this.lastMonotonicTs) {
      this.lastMonotonicTs += 1;
    } else {
      this.lastMonotonicTs = ts;
    }
    return this.lastMonotonicTs;
  }

  private pushRolling(price: number, ts: number): void {
    if (!(price > 0) || !(ts > 0)) return;
    const last = this.rolling[this.rolling.length - 1];
    if (last && last.ts === ts) {
      this.rolling[this.rolling.length - 1] = { ts, price };
    } else {
      this.rolling.push({ ts, price });
    }
    const keepSamples = Math.max(30, Math.floor(this.options.rollingSamples ?? 60));
    if (this.rolling.length > keepSamples) {
      this.rolling.splice(0, this.rolling.length - keepSamples);
    }
    const cutoff = Date.now() - this.config.polymarket.vol.lookbackSec * 1000;
    while (this.rolling.length > 0 && this.rolling[0].ts < cutoff) {
      this.rolling.shift();
    }
  }

  private computeRollingSigmaPricePerSqrtSec(anchorPrice: number, nowTs: number): number {
    const minSigmaPrice = Math.max(
      anchorPrice,
      this.lastGood?.price ?? 0
    ) * (this.config.polymarket.vol.minSigmaBps / 10_000);
    if (this.rolling.length < 3) {
      return Math.max(1e-9, minSigmaPrice);
    }

    const returnsPerSqrtSec: number[] = [];
    for (let i = 1; i < this.rolling.length; i += 1) {
      const prev = this.rolling[i - 1];
      const curr = this.rolling[i];
      if (!(prev.price > 0) || !(curr.price > 0)) continue;
      const dtSec = Math.max(0.001, (curr.ts - prev.ts) / 1000);
      const logReturn = Math.log(curr.price / prev.price);
      returnsPerSqrtSec.push(logReturn / Math.sqrt(dtSec));
    }
    if (returnsPerSqrtSec.length < 2) {
      return Math.max(1e-9, minSigmaPrice);
    }

    const mean = returnsPerSqrtSec.reduce((sum, value) => sum + value, 0) / returnsPerSqrtSec.length;
    const variance =
      returnsPerSqrtSec.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      Math.max(1, returnsPerSqrtSec.length - 1);
    const sigmaPerSqrtSec = Math.sqrt(Math.max(0, variance));
    const price = anchorPrice > 0 ? anchorPrice : this.lastGood?.price ?? 0;
    if (!(price > 0)) {
      return Math.max(1e-9, minSigmaPrice);
    }
    const sigmaPricePerSqrtSec = price * sigmaPerSqrtSec;
    if (!Number.isFinite(sigmaPricePerSqrtSec) || sigmaPricePerSqrtSec <= 0) {
      return Math.max(1e-9, minSigmaPrice);
    }
    return Math.max(minSigmaPrice, sigmaPricePerSqrtSec);
  }
}
