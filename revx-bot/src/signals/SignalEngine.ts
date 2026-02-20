import { BotConfig } from "../config";

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
