import { BotConfig } from "../config";
import { clamp, computeReturnsStdevBps, weightedMedian } from "./math";
import { ExternalVenueSnapshot, VenueHealth, VenueId, VolRegime } from "./types";

export type FairPriceVenueState = {
  symbol: string;
  venue: VenueId;
  quote: string;
  ts: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadBps: number | null;
  latencyMs: number;
  error?: string;
  ageMs: number;
  stale: boolean;
  ok: boolean;
  venueWeight: number;
  staleWeight: number;
  effectiveWeight: number;
};

export type FairPriceSnapshot = {
  fairMid: number;
  globalMid: number;
  dispersionBps: number;
  basisBps: number;
  driftBps: number;
  confidence: number;
  volRegime: VolRegime;
  staleVenueCount: number;
  healthyVenueCount: number;
  totalVenueCount: number;
  stdevBps: number;
  reason?: string;
  venues: FairPriceVenueState[];
};

type FairMidPoint = {
  ts: number;
  fairMid: number;
};

export class FairPriceModel {
  private history: FairMidPoint[] = [];

  constructor(private readonly config: BotConfig) {}

  compute(
    symbol: string,
    revxMid: number,
    snapshots: ExternalVenueSnapshot[],
    nowTs: number
  ): FairPriceSnapshot {
    const venues = this.buildVenueStates(symbol, snapshots, nowTs);
    const healthy = venues.filter((venue) => venue.ok && !venue.stale && venue.mid !== null && venue.mid > 0);
    const robustMid = this.computeRobustMid(healthy);
    const fallbackMid = Number.isFinite(revxMid) && revxMid > 0 ? revxMid : 0;
    const globalMid = robustMid > 0 ? robustMid : fallbackMid;
    const fairMid = globalMid;

    if (fairMid > 0) {
      this.history.push({ ts: nowTs, fairMid });
    }
    this.trimHistory(nowTs);

    const driftBps = this.computeDriftBps(nowTs);
    const stdevBps = computeReturnsStdevBps(
      this.history.map((row) => ({ ts: row.ts, value: row.fairMid })),
      this.config.volWindowSeconds * 1000
    );
    const dispersionBps = this.computeDispersionBps(fairMid, healthy);
    const basisBps = fairMid > 0 && revxMid > 0 ? ((revxMid - fairMid) / fairMid) * 10_000 : 0;
    const confidence = this.computeConfidence(healthy, dispersionBps, driftBps);
    const volRegime = this.classifyRegime(stdevBps, dispersionBps, driftBps);
    const reason =
      healthy.length > 0
        ? healthy.length < this.config.fairMinVenues
          ? "INSUFFICIENT_VENUES"
          : undefined
        : "NO_EXTERNAL_VENUES";

    return {
      fairMid,
      globalMid,
      dispersionBps,
      basisBps,
      driftBps,
      confidence: healthy.length > 0 ? confidence : 0,
      volRegime,
      staleVenueCount: venues.filter((venue) => venue.stale).length,
      healthyVenueCount: healthy.length,
      totalVenueCount: venues.length,
      stdevBps,
      reason,
      venues
    };
  }

  toVenueHealth(states: FairPriceVenueState[]): VenueHealth[] {
    return states.map((row) => ({
      venue: row.venue,
      weight: row.effectiveWeight,
      ok: row.ok,
      stale: row.stale,
      age_ms: row.ageMs,
      mid: row.mid,
      spread_bps: row.spreadBps,
      latency_ms: row.latencyMs,
      error: row.error
    }));
  }

  private buildVenueStates(
    symbol: string,
    snapshots: ExternalVenueSnapshot[],
    nowTs: number
  ): FairPriceVenueState[] {
    const states = snapshots.map((snapshot) => {
      const ageMs = Math.max(0, nowTs - Number(snapshot.ts || nowTs));
      const staleWeight = clamp(Math.exp(-ageMs / 1500), 0.1, 1.0);
      const venueWeight = Number(this.config.venueWeights[snapshot.venue] ?? 1);
      const effectiveWeight = clamp(venueWeight * staleWeight, 0.1, 5);
      const mid = Number.isFinite(Number(snapshot.mid)) ? Number(snapshot.mid) : null;
      const bid = Number.isFinite(Number(snapshot.bid)) ? Number(snapshot.bid) : null;
      const ask = Number.isFinite(Number(snapshot.ask)) ? Number(snapshot.ask) : null;
      const spreadBps =
        bid !== null && ask !== null && bid > 0 && ask > 0 && ask > bid
          ? ((ask - bid) / ((ask + bid) / 2)) * 10_000
          : null;
      const stale = ageMs > this.config.fairStaleMs;
      const ok = Boolean(snapshot.ok) && mid !== null && mid > 0;
      return {
        symbol,
        venue: snapshot.venue,
        quote: snapshot.quote,
        ts: Number.isFinite(Number(snapshot.ts)) ? Number(snapshot.ts) : nowTs,
        bid,
        ask,
        mid,
        spreadBps,
        latencyMs: Number.isFinite(Number(snapshot.latency_ms)) ? Number(snapshot.latency_ms) : 0,
        error: snapshot.error,
        ageMs,
        stale,
        ok,
        venueWeight,
        staleWeight,
        effectiveWeight
      };
    });
    return states.sort((a, b) => a.venue.localeCompare(b.venue));
  }

  private computeRobustMid(venues: FairPriceVenueState[]): number {
    const rows = venues
      .filter((venue) => venue.mid !== null && venue.mid > 0 && venue.effectiveWeight > 0)
      .map((venue) => ({
        mid: venue.mid as number,
        weight: venue.effectiveWeight
      }))
      .sort((a, b) => a.mid - b.mid);
    if (rows.length === 0) return 0;
    if (rows.length >= 5) {
      const trim = Math.max(1, Math.floor(rows.length * 0.1));
      const trimmed = rows.slice(trim, rows.length - trim);
      if (trimmed.length > 0) {
        const weightSum = trimmed.reduce((sum, row) => sum + row.weight, 0);
        if (weightSum > 0) {
          return trimmed.reduce((sum, row) => sum + row.mid * row.weight, 0) / weightSum;
        }
      }
    }
    const median = weightedMedian(rows.map((row) => ({ value: row.mid, weight: row.weight })));
    if (median !== null && Number.isFinite(median) && median > 0) {
      return median;
    }
    return rows[Math.floor(rows.length / 2)].mid;
  }

  private computeDispersionBps(fairMid: number, venues: FairPriceVenueState[]): number {
    if (!(fairMid > 0)) return 0;
    const mids = venues
      .map((venue) => venue.mid)
      .filter((mid): mid is number => Number.isFinite(mid) && (mid as number) > 0)
      .sort((a, b) => a - b);
    if (mids.length <= 1) return 0;
    if (mids.length < 5) {
      return ((mids[mids.length - 1] - mids[0]) / fairMid) * 10_000;
    }
    const p10 = percentileSorted(mids, 0.1);
    const p90 = percentileSorted(mids, 0.9);
    return ((p90 - p10) / fairMid) * 10_000;
  }

  private computeDriftBps(nowTs: number): number {
    if (this.history.length < 2) return 0;
    const latest = this.history[this.history.length - 1];
    const cutoff = nowTs - Math.max(1_000, this.config.trendWindowSeconds * 1000);
    let anchor = this.history[0];
    for (const point of this.history) {
      anchor = point;
      if (point.ts >= cutoff) break;
    }
    if (!(latest.fairMid > 0) || !(anchor.fairMid > 0)) return 0;
    return ((latest.fairMid - anchor.fairMid) / anchor.fairMid) * 10_000;
  }

  private computeConfidence(
    healthy: FairPriceVenueState[],
    dispersionBps: number,
    driftBps: number
  ): number {
    if (healthy.length === 0) return 0;
    const venueScore = clamp(healthy.length / Math.max(1, this.config.fairMinVenues), 0, 1);
    const dispersionScore = clamp(1 - dispersionBps / Math.max(0.0001, this.config.fairMaxDispersionBps), 0, 1);
    const avgAgeWeight =
      healthy.reduce((sum, venue) => sum + venue.staleWeight, 0) / Math.max(1, healthy.length);
    const driftScore = clamp(1 - Math.abs(driftBps) / Math.max(0.0001, this.config.toxicDriftBps), 0, 1);
    return clamp(
      0.35 * venueScore + 0.30 * dispersionScore + 0.20 * avgAgeWeight + 0.15 * driftScore,
      0,
      1
    );
  }

  private classifyRegime(
    stdevBps: number,
    dispersionBps: number,
    driftBps: number
  ): VolRegime {
    if (
      stdevBps >= this.config.hotVolBps ||
      dispersionBps > this.config.fairMaxDispersionBps ||
      Math.abs(driftBps) > this.config.toxicDriftBps
    ) {
      return "hot";
    }
    if (
      stdevBps <= this.config.calmVolBps &&
      dispersionBps <= this.config.fairMaxDispersionBps * 0.6 &&
      Math.abs(driftBps) <= this.config.toxicDriftBps * 0.6
    ) {
      return "calm";
    }
    return "normal";
  }

  private trimHistory(nowTs: number): void {
    const keepWindowMs = Math.max(
      this.config.volWindowSeconds * 1000,
      this.config.trendWindowSeconds * 1000,
      120_000
    );
    const cutoff = nowTs - keepWindowMs;
    this.history = this.history.filter((point) => point.ts >= cutoff);
    if (this.history.length > 4_000) {
      this.history = this.history.slice(this.history.length - 4_000);
    }
  }
}

function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = clamp(p, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
