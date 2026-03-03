import { BotConfig } from "../config";
import { trimmedWeightedMean, weightedMedian } from "../signal/math";
import { OracleEstimate, SpotFeed, SpotVenueTick } from "./types";

export class OracleEstimator {
  private emaValue: number | null = null;
  private lastEstimateTs = 0;

  constructor(private readonly config: BotConfig, private readonly spotFeed: SpotFeed) {}

  async estimate(symbol: string, nowTs = Date.now()): Promise<OracleEstimate> {
    const rows = await this.spotFeed.fetch(symbol, nowTs);
    const usable = rows
      .map((row) => normalizeRow(row))
      .filter((row) => row.mid > 0);

    const fresh = usable.filter((row) => nowTs - row.ts <= this.config.polymarket.risk.staleMs);
    const staleRejected = usable.length - fresh.length;

    const inliers = rejectOutliersByMad(fresh, this.config.polymarket.oracle.madThreshold);
    const outlierRejected = fresh.length - inliers.length;

    const weightedRows = inliers.map((row) => ({ value: row.mid, weight: computeWeight(row, nowTs) }));

    const robustMedian = weightedMedian(weightedRows);
    const trimmedMean = trimmedWeightedMean(weightedRows, this.config.polymarket.oracle.trimFraction);

    let raw = robustMedian ?? trimmedMean ?? 0;
    if (robustMedian !== null && trimmedMean !== null) {
      raw = robustMedian * 0.7 + trimmedMean * 0.3;
    }

    if (!(raw > 0)) {
      raw = this.emaValue ?? 0;
    }

    const alpha = computeEmaAlpha(
      this.config.polymarket.loopMs,
      this.config.polymarket.oracle.emaHalfLifeSec * 1000
    );
    this.emaValue = this.emaValue === null ? raw : alpha * raw + (1 - alpha) * this.emaValue;
    this.lastEstimateTs = nowTs;

    return {
      ts: nowTs,
      oracleEst: this.emaValue,
      oracleRaw: raw,
      venueCount: inliers.length,
      staleRejected,
      outlierRejected,
      emaApplied: this.emaValue !== raw
    };
  }

  getLastEstimateAgeMs(nowTs = Date.now()): number {
    if (this.lastEstimateTs <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, nowTs - this.lastEstimateTs);
  }
}

type NormalizedRow = {
  venue: string;
  ts: number;
  mid: number;
  spreadBps: number;
};

function normalizeRow(row: SpotVenueTick): NormalizedRow {
  const bid = Number.isFinite(row.bid) ? (row.bid as number) : 0;
  const ask = Number.isFinite(row.ask) ? (row.ask as number) : 0;
  const rawMid = Number.isFinite(row.mid) ? (row.mid as number) : 0;
  const inferredMid = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : 0;
  const last = Number.isFinite(row.last) ? (row.last as number) : 0;
  const mid = rawMid > 0 ? rawMid : inferredMid > 0 ? inferredMid : last;
  const spreadBps =
    row.spreadBps !== null && Number.isFinite(row.spreadBps)
      ? (row.spreadBps as number)
      : bid > 0 && ask > 0 && ask > bid && mid > 0
        ? ((ask - bid) / mid) * 10_000
        : 25;

  return {
    venue: row.venue,
    ts: Number.isFinite(row.ts) ? row.ts : Date.now(),
    mid,
    spreadBps: Math.max(0.1, spreadBps)
  };
}

function rejectOutliersByMad(rows: NormalizedRow[], threshold: number): NormalizedRow[] {
  if (rows.length < 3) return rows;
  const mids = rows.map((row) => row.mid).sort((a, b) => a - b);
  const median = mids[Math.floor(mids.length / 2)];
  const deviations = mids.map((mid) => Math.abs(mid - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)];
  if (!(mad > 0)) return rows;

  const scale = 1.4826 * mad;
  return rows.filter((row) => Math.abs(row.mid - median) / scale <= threshold);
}

function computeWeight(row: NormalizedRow, nowTs: number): number {
  const ageMs = Math.max(0, nowTs - row.ts);
  const freshness = Math.max(0.05, Math.exp(-ageMs / 2000));
  const spreadWeight = 1 / Math.max(0.1, row.spreadBps);
  return Math.max(0.01, spreadWeight * freshness);
}

function computeEmaAlpha(loopMs: number, halfLifeMs: number): number {
  const dt = Math.max(1, loopMs);
  const hl = Math.max(dt, halfLifeMs);
  return 1 - Math.exp((-Math.log(2) * dt) / hl);
}
