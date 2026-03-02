import { BotConfig } from "../config";
import { Logger } from "../logger";
import { clamp, emaUpdate } from "./math";
import { FairPriceModel } from "./FairPriceModel";
import { fetchBinanceTicker } from "./venues/binance";
import { fetchCoinbaseTicker } from "./venues/coinbase";
import { fetchKrakenTicker } from "./venues/kraken";
import {
  CrossVenueComputation,
  ExternalVenueSnapshot,
  SignalSnapshot,
  VenueId
} from "./types";

type VenueRuntime = {
  lastSnapshot: ExternalVenueSnapshot | null;
  failureCount: number;
  nextAllowedTs: number;
  inFlight: Promise<ExternalVenueSnapshot> | null;
};

type RollingPoint = {
  ts: number;
  globalMid: number;
  ema: number;
};

const VENUES: VenueId[] = ["coinbase", "binance", "kraken"];
const MAX_ROLLING_POINTS = 2_000;

export class CrossVenueSignalEngine {
  private readonly runtimes: Record<VenueId, VenueRuntime> = {
    coinbase: emptyRuntime(),
    binance: emptyRuntime(),
    kraken: emptyRuntime()
  };
  private rolling: RollingPoint[] = [];
  private emaValue: number | null = null;
  private lastSignal: SignalSnapshot | null = null;
  private lastNoHealthyWarnMs = 0;
  private readonly fairPriceModel: FairPriceModel;

  constructor(private readonly config: BotConfig, private readonly logger: Logger) {
    this.fairPriceModel = new FairPriceModel(config);
  }

  getLastSignal(): SignalSnapshot | null {
    return this.lastSignal;
  }

  async compute(symbol: string, revxMid: number, nowTs = Date.now()): Promise<CrossVenueComputation> {
    const rawSnapshots = await Promise.all(VENUES.map((venue) => this.refreshVenue(venue, symbol, nowTs)));
    const fair = this.fairPriceModel.compute(symbol, revxMid, rawSnapshots, nowTs);
    const venueHealth = this.fairPriceModel.toVenueHealth(fair.venues);
    const healthyVenues = venueHealth.filter((row) => row.ok && !row.stale && row.mid && row.mid > 0);
    const globalMid = fair.globalMid > 0 ? fair.globalMid : Number.isFinite(revxMid) && revxMid > 0 ? revxMid : 0;

    const alpha = computeAlpha(this.config.venueRefreshMs, 60_000);
    this.emaValue = emaUpdate(this.emaValue, globalMid, alpha);
    this.rolling.push({ ts: nowTs, globalMid, ema: this.emaValue });
    this.trimRolling(nowTs);
    const driftBps = fair.driftBps;
    const stdevBps = fair.stdevBps;
    const zScore = stdevBps > 0 ? driftBps / stdevBps : 0;
    const basisBps = fair.basisBps;
    const dispersionBps = fair.dispersionBps;
    const confidence = fair.confidence;
    const volRegime = fair.volRegime;

    const driftComponentBps = clamp(driftBps, -this.config.fairDriftMaxBps, this.config.fairDriftMaxBps);
    const basisCorrectionBps = clamp(-basisBps, -this.config.fairBasisMaxBps, this.config.fairBasisMaxBps);
    const fairAnchorMid = fair.fairMid > 0 ? fair.fairMid : globalMid;
    const fairMid =
      fairAnchorMid > 0
        ? fairAnchorMid * (1 + (driftComponentBps + basisCorrectionBps) / 10_000)
        : fairAnchorMid;

    const signal: SignalSnapshot = {
      symbol,
      ts: nowTs,
      revx_mid: revxMid,
      global_mid: globalMid,
      fair_mid: fairMid,
      basis_bps: basisBps,
      drift_bps: driftBps,
      stdev_bps: stdevBps,
      z_score: zScore,
      confidence,
      dispersion_bps: dispersionBps,
      vol_regime: volRegime,
      drift_component_bps: driftComponentBps,
      basis_correction_bps: basisCorrectionBps,
      healthy_venues: healthyVenues.length,
      total_venues: venueHealth.length,
      reason: fair.reason
    };
    this.lastSignal = signal;

    if (confidence === 0 && healthyVenues.length === 0 && nowTs - this.lastNoHealthyWarnMs >= 30_000) {
      this.lastNoHealthyWarnMs = nowTs;
      this.logger.warn(
        { symbol, reason: fair.reason ?? "no healthy cross-venue snapshots", revxMid },
        "Cross-venue signal low confidence"
      );
    }

    return {
      signal,
      venues: venueHealth,
      rawSnapshots
    };
  }

  private async refreshVenue(
    venue: VenueId,
    symbol: string,
    nowTs: number
  ): Promise<ExternalVenueSnapshot> {
    const runtime = this.runtimes[venue];
    if (runtime.inFlight) {
      return runtime.inFlight;
    }
    if (runtime.lastSnapshot && nowTs < runtime.nextAllowedTs) {
      return runtime.lastSnapshot;
    }

    const fetchPromise = this.fetchVenueSnapshot(venue, symbol)
      .then((snapshot) => {
        if (snapshot.ok && snapshot.mid !== null && snapshot.mid > 0) {
          runtime.failureCount = 0;
          runtime.nextAllowedTs = nowTs + this.config.venueRefreshMs;
        } else {
          runtime.failureCount += 1;
          const backoffMs = Math.min(
            this.config.venueMaxBackoffMs,
            Math.round(this.config.venueRefreshMs * 2 ** Math.min(runtime.failureCount, 6))
          );
          runtime.nextAllowedTs = nowTs + backoffMs;
        }
        runtime.lastSnapshot = snapshot;
        runtime.inFlight = null;
        return snapshot;
      })
      .catch((error) => {
        runtime.failureCount += 1;
        const backoffMs = Math.min(
          this.config.venueMaxBackoffMs,
          Math.round(this.config.venueRefreshMs * 2 ** Math.min(runtime.failureCount, 6))
        );
        runtime.nextAllowedTs = nowTs + backoffMs;
        const failed: ExternalVenueSnapshot = {
          symbol,
          venue,
          quote: "USD",
          ts: nowTs,
          bid: null,
          ask: null,
          mid: null,
          spread_bps: null,
          latency_ms: 0,
          ok: false,
          error: (error as Error).message
        };
        runtime.lastSnapshot = failed;
        runtime.inFlight = null;
        return failed;
      });
    runtime.inFlight = fetchPromise;
    return fetchPromise;
  }

  private async fetchVenueSnapshot(
    venue: VenueId,
    symbol: string
  ): Promise<ExternalVenueSnapshot> {
    if (venue === "coinbase") {
      return fetchCoinbaseTicker(symbol, this.config.venueTimeoutMs);
    }
    if (venue === "binance") {
      return fetchBinanceTicker(symbol, this.config.venueTimeoutMs);
    }
    return fetchKrakenTicker(symbol, this.config.venueTimeoutMs);
  }

  private trimRolling(nowTs: number): void {
    const keepWindowMs = Math.max(
      this.config.volWindowSeconds * 1000,
      this.config.trendWindowSeconds * 1000,
      120_000
    );
    const cutoff = nowTs - keepWindowMs;
    this.rolling = this.rolling.filter((point) => point.ts >= cutoff);
    if (this.rolling.length > MAX_ROLLING_POINTS) {
      this.rolling = this.rolling.slice(this.rolling.length - MAX_ROLLING_POINTS);
    }
  }
}

function emptyRuntime(): VenueRuntime {
  return {
    lastSnapshot: null,
    failureCount: 0,
    nextAllowedTs: 0,
    inFlight: null
  };
}

function computeAlpha(sampleMs: number, periodMs: number): number {
  const periods = Math.max(2, Math.round(periodMs / Math.max(sampleMs, 1)));
  return clamp(2 / (periods + 1), 0.01, 0.99);
}
