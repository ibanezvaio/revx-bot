import { BotConfig } from "../config";
import { QuoteVenue } from "./types";

type FairPriceOutput = {
  venues: QuoteVenue[];
  globalMid: number;
  fairMid: number;
  basisBps: number;
  dispersionBps: number;
  confidence: number;
  driftBps: number;
  reason: string;
};

type MidPoint = { ts: number; value: number };

const RELIABILITY_ALPHA = 0.2;

export class FairPriceModel {
  private readonly reliability = new Map<string, number>();
  private history: MidPoint[] = [];
  private emaShort: number | null = null;
  private emaLong: number | null = null;

  constructor(private readonly config: BotConfig) {}

  compute(symbol: string, revxMid: number, venues: QuoteVenue[], nowTs = Date.now()): FairPriceOutput {
    const normalized = venues
      .map((row) => normalizeVenue(row, symbol))
      .sort((a, b) => a.venue.localeCompare(b.venue));

    for (const venue of normalized) {
      const prev = this.reliability.get(venue.venue) ?? 0.8;
      const next = prev * (1 - RELIABILITY_ALPHA) + (venue.ok ? 1 : 0) * RELIABILITY_ALPHA;
      this.reliability.set(venue.venue, clamp(next, 0.05, 1));
    }

    const eligible = normalized.filter((venue) => {
      if (!venue.ok || !(Number(venue.mid) > 0)) return false;
      if (!(Number(venue.ts) > 0)) return false;
      return nowTs - venue.ts <= this.config.signalMaxQuoteAgeMs;
    });

    const weighted = eligible
      .map((venue) => {
        const spread = Number(venue.spread_bps);
        const spreadWeight = Number.isFinite(spread) && spread > 0 ? 1 / Math.max(0.5, spread) : 0.45;
        const latencyWeight = 1 / Math.max(1, Number(venue.latency_ms) || 1);
        const staleWeight = clamp(Math.exp(-(nowTs - venue.ts) / 1500), 0.1, 1);
        const reliabilityWeight = this.reliability.get(venue.venue) ?? 0.5;
        const quotePenalty = venue.quote.toUpperCase() === "USDT" ? 1 - this.config.signalUsdtDegrade : 1;
        const weight = clamp(
          spreadWeight * latencyWeight * staleWeight * reliabilityWeight * quotePenalty * 10_000,
          0.01,
          10
        );
        return { value: Number(venue.mid), weight, venue };
      })
      .filter((row) => row.value > 0 && row.weight > 0);

    let globalMid = 0;
    if (weighted.length >= 5) {
      const sorted = [...weighted].sort((a, b) => a.value - b.value);
      const trim = Math.max(1, Math.floor(sorted.length * 0.1));
      const trimmed = sorted.slice(trim, sorted.length - trim);
      const source = trimmed.length > 0 ? trimmed : sorted;
      const sumW = source.reduce((acc, row) => acc + row.weight, 0);
      globalMid = sumW > 0 ? source.reduce((acc, row) => acc + row.value * row.weight, 0) / sumW : 0;
    } else {
      globalMid = weightedMedian(weighted.map((row) => ({ value: row.value, weight: row.weight })));
    }
    if (!(globalMid > 0)) {
      globalMid = Number(revxMid) > 0 ? Number(revxMid) : 0;
    }

    if (globalMid > 0) {
      this.history.push({ ts: nowTs, value: globalMid });
      this.trimHistory(nowTs);
    }

    const shortAlpha = alphaFromMs(this.config.signalRefreshMs, 9_000);
    const longAlpha = alphaFromMs(this.config.signalRefreshMs, 45_000);
    this.emaShort = ema(this.emaShort, globalMid, shortAlpha);
    this.emaLong = ema(this.emaLong, globalMid, longAlpha);

    const driftBps =
      this.emaShort && this.emaLong && this.emaLong > 0
        ? ((this.emaShort - this.emaLong) / this.emaLong) * 10_000
        : 0;
    const microAdjBps = clamp(driftBps * 0.35, -this.config.fairDriftMaxBps, this.config.fairDriftMaxBps);
    const fairMid = globalMid > 0 ? globalMid * (1 + microAdjBps / 10_000) : globalMid;
    const basisBps = fairMid > 0 && revxMid > 0 ? ((revxMid - fairMid) / fairMid) * 10_000 : 0;
    const dispersionBps = computeDispersionBps(weighted.map((row) => row.value), globalMid);

    const okCount = weighted.length;
    const staleCount = normalized.filter((row) => nowTs - row.ts > this.config.signalMaxQuoteAgeMs).length;
    const latencyAvg =
      weighted.length > 0
        ? weighted.reduce((acc, row) => acc + Math.max(0, row.venue.latency_ms), 0) / weighted.length
        : 10_000;
    const confByVenues = clamp(okCount / Math.max(1, this.config.fairMinVenues), 0, 1);
    const confByDispersion = clamp(1 - dispersionBps / Math.max(0.0001, this.config.fairMaxDispersionBps), 0, 1);
    const confByLatency = clamp(1 - latencyAvg / 2500, 0, 1);
    const confByStale = clamp(1 - staleCount / Math.max(1, normalized.length), 0, 1);
    const confidence = clamp(
      0.35 * confByVenues + 0.30 * confByDispersion + 0.2 * confByLatency + 0.15 * confByStale,
      0,
      1
    );

    return {
      venues: normalized,
      globalMid,
      fairMid: fairMid > 0 ? fairMid : globalMid,
      basisBps,
      dispersionBps,
      confidence,
      driftBps,
      reason: okCount > 0 ? "OK" : "NO_EXTERNAL_VENUES"
    };
  }

  private trimHistory(nowTs: number): void {
    const keepMs = Math.max(120_000, this.config.volWindowSeconds * 1000);
    const cutoff = nowTs - keepMs;
    this.history = this.history.filter((row) => row.ts >= cutoff);
    if (this.history.length > 5_000) {
      this.history = this.history.slice(this.history.length - 5_000);
    }
  }
}

function normalizeVenue(row: QuoteVenue, symbol: string): QuoteVenue {
  return {
    venue: String(row.venue || "").toLowerCase(),
    symbol,
    quote: String(row.quote || "USD").toUpperCase(),
    ts: Number.isFinite(Number(row.ts)) ? Number(row.ts) : Date.now(),
    bid: asNumOrNull(row.bid),
    ask: asNumOrNull(row.ask),
    mid: asNumOrNull(row.mid),
    spread_bps: asNumOrNull(row.spread_bps),
    latency_ms: Math.max(0, Math.floor(Number(row.latency_ms) || 0)),
    ok: Boolean(row.ok),
    error: row.error ? String(row.error) : ""
  };
}

function computeDispersionBps(mids: number[], globalMid: number): number {
  if (!(globalMid > 0) || mids.length < 2) return 0;
  const sorted = [...mids].filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length < 2) return 0;
  if (sorted.length < 5) {
    return ((sorted[sorted.length - 1] - sorted[0]) / globalMid) * 10_000;
  }
  const p10 = percentile(sorted, 0.1);
  const p90 = percentile(sorted, 0.9);
  return ((p90 - p10) / globalMid) * 10_000;
}

function weightedMedian(rows: Array<{ value: number; weight: number }>): number {
  if (rows.length === 0) return 0;
  const sorted = [...rows].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((acc, row) => acc + row.weight, 0);
  if (!(total > 0)) return sorted[Math.floor(sorted.length / 2)].value;
  let acc = 0;
  for (const row of sorted) {
    acc += row.weight;
    if (acc >= total / 2) return row.value;
  }
  return sorted[sorted.length - 1].value;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = clamp(p, 0, 1) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  const frac = rank - low;
  return sorted[low] * (1 - frac) + sorted[high] * frac;
}

function alphaFromMs(sampleMs: number, periodMs: number): number {
  const n = Math.max(2, Math.round(periodMs / Math.max(1, sampleMs)));
  return clamp(2 / (n + 1), 0.01, 0.99);
}

function ema(prev: number | null, value: number, alpha: number): number | null {
  if (!(value > 0)) return prev;
  if (!(prev && prev > 0)) return value;
  return alpha * value + (1 - alpha) * prev;
}

function asNumOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

