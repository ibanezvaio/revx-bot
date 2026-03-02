import { BotConfig } from "../config";
import { FairPriceModel } from "./FairPriceModel";
import { RegimeClassifier } from "./RegimeClassifier";
import { CrossVenueSnapshot, QuoteVenue, SignalBias, SignalRegime } from "./types";
import { CrossVenueFetcher } from "./CrossVenueFetcher";

type MidPoint = { ts: number; mid: number };

export type SignalState = {
  ts: number;
  ema: number;
  stdevBps: number;
  zScore: number;
  driftBps: number;
  volRegime: "calm" | "normal" | "hot";
  confidence: number;
};

const EMPTY_SIGNAL: SignalState = {
  ts: 0,
  ema: 0,
  stdevBps: 0,
  zScore: 0,
  driftBps: 0,
  volRegime: "normal",
  confidence: 0
};

export class SignalEngine {
  private readonly mids: MidPoint[] = [];
  private state: SignalState = { ...EMPTY_SIGNAL };

  constructor(private readonly config: BotConfig) {}

  update(mid: number, ts: number): SignalState {
    if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(ts) || ts <= 0) {
      this.state = { ...EMPTY_SIGNAL };
      return this.state;
    }

    this.mids.push({ ts, mid });
    const cutoff = ts - 120_000;
    while (this.mids.length > 0 && this.mids[0].ts < cutoff) {
      this.mids.shift();
    }

    const window60 = this.mids.filter((point) => point.ts >= ts - 60_000);
    const ema = computeEma(
      window60.map((point) => point.mid),
      Math.max(2, Math.round(60 / Math.max(this.config.refreshSeconds, 1)))
    );
    const stdevBps = computeReturnsStdevBps(window60);
    const driftBps = computeDriftBps(this.mids, 30_000);

    let zScore = 0;
    let confidence = 0;
    if (window60.length >= 6 && stdevBps > 0 && ema > 0) {
      const midDeviationBps = ((mid - ema) / ema) * 10_000;
      zScore = midDeviationBps / stdevBps;
      const sampleConfidence = clamp((window60.length - 5) / 20, 0, 1);
      const stdevConfidence = clamp(stdevBps / Math.max(this.config.calmVolBps, 1), 0, 1);
      confidence = clamp(Math.min(sampleConfidence, stdevConfidence), 0, 1);
    }

    const hotThreshold = this.config.calmVolBps * this.config.signalHotRegimeMultiplier;
    let volRegime: SignalState["volRegime"] = "normal";
    if (stdevBps < this.config.calmVolBps) volRegime = "calm";
    if (stdevBps > hotThreshold) volRegime = "hot";

    if (stdevBps <= 0 || window60.length < 6) {
      confidence = 0;
      zScore = 0;
    }

    this.state = {
      ts,
      ema,
      stdevBps,
      zScore,
      driftBps,
      volRegime,
      confidence
    };
    return this.state;
  }

  getState(): SignalState {
    return this.state;
  }
}

export type HybridSignalSnapshot = CrossVenueSnapshot & {
  stdevBps: number;
  volRegimeLegacy: "calm" | "normal" | "hot";
  source: "cross-venue";
};

export class HybridSignalEngine {
  private readonly fairPriceModel: FairPriceModel;
  private readonly classifier: RegimeClassifier;
  private readonly fetcher: CrossVenueFetcher;
  private lastSnapshot: HybridSignalSnapshot | null = null;
  private lastError: string | null = null;
  private mids: MidPoint[] = [];

  constructor(private readonly config: BotConfig) {
    this.fairPriceModel = new FairPriceModel(config);
    this.classifier = new RegimeClassifier(config);
    this.fetcher = new CrossVenueFetcher(config);
  }

  getLastSnapshot(): HybridSignalSnapshot | null {
    return this.lastSnapshot ? { ...this.lastSnapshot, venues: this.lastSnapshot.venues.map((row) => ({ ...row })) } : null;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  async refresh(symbol: string, revxMid: number, nowTs = Date.now()): Promise<HybridSignalSnapshot> {
    const venues = await this.fetcher.fetch(symbol, nowTs);
    return this.computeFromQuotes(symbol, revxMid, venues, nowTs);
  }

  computeFromQuotes(
    symbol: string,
    revxMid: number,
    venues: QuoteVenue[],
    nowTs = Date.now()
  ): HybridSignalSnapshot {
    try {
      const fair = this.fairPriceModel.compute(symbol, revxMid, venues, nowTs);
      if (fair.globalMid > 0) {
        this.mids.push({ ts: nowTs, mid: fair.globalMid });
      }
      this.trimMids(nowTs);

      const stdevBps = computeReturnsStdevBps(this.mids);
      const failedVenueRate =
        fair.venues.length > 0 ? fair.venues.filter((row) => !row.ok).length / fair.venues.length : 1;
      const regime = this.classifier.classify({
        confidence: fair.confidence,
        stdevBps,
        driftBps: fair.driftBps,
        dispersionBps: fair.dispersionBps,
        failedVenueRate
      });

      const snapshot: HybridSignalSnapshot = {
        ts: nowTs,
        symbol,
        venues: fair.venues,
        globalMid: fair.globalMid,
        fairMid: fair.fairMid,
        basisBps: fair.basisBps,
        dispersionBps: fair.dispersionBps,
        confidence: fair.confidence,
        regime: regime.regime,
        bias: regime.bias,
        biasConfidence: regime.biasConfidence,
        driftBps: fair.driftBps,
        reason: fair.reason === "OK" ? regime.reason : `${fair.reason}; ${regime.reason}`,
        stdevBps,
        volRegimeLegacy: mapLegacyVolRegime(regime.regime),
        source: "cross-venue"
      };

      this.lastSnapshot = snapshot;
      this.lastError = null;
      return snapshot;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      const fallback: HybridSignalSnapshot = {
        ts: nowTs,
        symbol,
        venues: venues.map((row) => ({ ...row })),
        globalMid: revxMid > 0 ? revxMid : 0,
        fairMid: revxMid > 0 ? revxMid : 0,
        basisBps: 0,
        dispersionBps: 0,
        confidence: 0,
        regime: "CRISIS",
        bias: "NEUTRAL",
        biasConfidence: 0,
        driftBps: 0,
        reason: `SIGNAL_ERROR: ${this.lastError}`,
        stdevBps: 0,
        volRegimeLegacy: "hot",
        source: "cross-venue"
      };
      this.lastSnapshot = fallback;
      return fallback;
    }
  }

  private trimMids(nowTs: number): void {
    const cutoff = nowTs - Math.max(120_000, this.config.volWindowSeconds * 1000);
    while (this.mids.length > 0 && this.mids[0].ts < cutoff) {
      this.mids.shift();
    }
    if (this.mids.length > 5_000) {
      this.mids = this.mids.slice(this.mids.length - 5_000);
    }
  }
}

function computeEma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const alpha = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i += 1) {
    ema = alpha * values[i] + (1 - alpha) * ema;
  }
  return ema;
}

function computeReturnsStdevBps(points: MidPoint[]): number {
  if (points.length < 2) return 0;
  const returnsBps: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1].mid;
    const curr = points[i].mid;
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0 || curr <= 0) continue;
    returnsBps.push(((curr - prev) / prev) * 10_000);
  }
  if (returnsBps.length < 2) return 0;
  const mean = returnsBps.reduce((sum, value) => sum + value, 0) / returnsBps.length;
  const variance =
    returnsBps.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, returnsBps.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function computeDriftBps(points: MidPoint[], windowMs: number): number {
  if (points.length < 2) return 0;
  const latest = points[points.length - 1];
  const cutoff = latest.ts - windowMs;
  let anchor = points[0];
  for (const point of points) {
    anchor = point;
    if (point.ts >= cutoff) break;
  }
  if (!anchor || anchor.mid <= 0 || latest.mid <= 0) return 0;
  return ((latest.mid - anchor.mid) / anchor.mid) * 10_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mapLegacyVolRegime(regime: SignalRegime): "calm" | "normal" | "hot" {
  if (regime === "CALM") return "calm";
  if (regime === "TREND") return "normal";
  return "hot";
}

export function mapSignalBiasToSkewBps(
  bias: SignalBias,
  biasConfidence: number,
  maxSkewBps: number
): number {
  const amplitude = clamp(biasConfidence, 0, 1) * Math.max(0, maxSkewBps);
  if (bias === "LONG") return -amplitude;
  if (bias === "SHORT") return amplitude;
  return 0;
}
