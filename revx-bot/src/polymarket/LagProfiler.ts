import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type LagSample = {
  tsMs: number;
  windowSlug: string;
  tauSec: number | null;
  priceToBeat: number | null;
  fastMid: number | null;
  oraclePrice: number | null;
  oracleUpdatedAtMs: number | null;
  yesBid: number | null;
  yesAsk: number | null;
  yesMid: number | null;
  impliedProbMid: number | null;
  pModel: number | null;
  absProbGap: number | null;
  polyUpdateAgeMs: number | null;
  oracleAgeMs: number | null;
  absOracleFast: number | null;
  bookMoveLagMs: number | null;
};

type LagMetricStats = {
  count: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
};

export type LagProfilerStats = {
  samples: number;
  lastFastMidTsMs: number | null;
  lastOracleTsMs: number | null;
  lastBookTsMs: number | null;
  lastYesMid: number | null;
  metrics: {
    polyUpdateAgeMs: LagMetricStats;
    oracleAgeMs: LagMetricStats;
    absOracleFast: LagMetricStats;
    absProbGap: LagMetricStats;
    bookMoveLagMs: LagMetricStats;
  };
};

type PendingBookLagEvent = {
  direction: 1 | -1;
  startTsMs: number;
  yesMidStart: number;
};

type LagProfilerOptions = {
  maxSamples?: number;
  logPath?: string;
  fastEventBps?: number;
  bookConfirmBps?: number;
};

export class LagProfiler {
  private readonly maxSamples: number;
  private readonly logPath: string;
  private readonly fastEventBps: number;
  private readonly bookConfirmBps: number;
  private readonly samples: LagSample[] = [];

  private lastFastMidTsMs: number | null = null;
  private lastOracleTsMs: number | null = null;
  private lastBookTsMs: number | null = null;
  private lastYesMid: number | null = null;

  private prevFastMid: { price: number; tsMs: number } | null = null;
  private pendingBookLagEvent: PendingBookLagEvent | null = null;

  private lineBuffer: string[] = [];
  private flushScheduled = false;
  private flushing = false;
  private lastQueuedWriteTsMs = 0;

  constructor(options: LagProfilerOptions = {}) {
    this.maxSamples = Math.max(1, Math.floor(options.maxSamples ?? 2000));
    this.fastEventBps = Math.max(0.1, Number(options.fastEventBps ?? 8));
    this.bookConfirmBps = Math.max(0.1, Number(options.bookConfirmBps ?? 4));
    this.logPath = options.logPath
      ? path.resolve(options.logPath)
      : path.resolve(process.cwd(), "logs/polymarket-lag.jsonl");
    void this.ensureLogDir();
  }

  record(input: Partial<LagSample>): void {
    try {
      const tsMs = finiteOrNull(input.tsMs) ?? Date.now();
      const yesBid = finiteOrNull(input.yesBid);
      const yesAsk = finiteOrNull(input.yesAsk);
      const yesMidDerived = finiteOrNull(input.yesMid) ?? midFromBbo(yesBid, yesAsk);
      const impliedProbMid = finiteOrNull(input.impliedProbMid) ?? yesMidDerived;
      const fastMid = finiteOrNull(input.fastMid);
      const oraclePrice = finiteOrNull(input.oraclePrice);
      const oracleUpdatedAtMs = finiteOrNull(input.oracleUpdatedAtMs);
      const pModel = finiteOrNull(input.pModel);
      const absProbGap =
        finiteOrNull(input.absProbGap) ??
        (pModel !== null && impliedProbMid !== null ? Math.abs(pModel - impliedProbMid) : null);

      if (fastMid !== null) {
        this.lastFastMidTsMs = tsMs;
      }
      if (oracleUpdatedAtMs !== null) {
        this.lastOracleTsMs = oracleUpdatedAtMs;
      }
      if (yesMidDerived !== null) {
        const moved = this.lastYesMid === null || Math.abs(yesMidDerived - this.lastYesMid) > 1e-9;
        if (moved) {
          this.lastBookTsMs = tsMs;
        }
        this.lastYesMid = yesMidDerived;
      }

      const polyUpdateAgeMs =
        this.lastBookTsMs !== null ? Math.max(0, tsMs - this.lastBookTsMs) : null;
      const oracleAgeMs =
        oracleUpdatedAtMs !== null ? Math.max(0, tsMs - oracleUpdatedAtMs) : null;
      const absOracleFast =
        oraclePrice !== null && fastMid !== null ? Math.abs(oraclePrice - fastMid) : null;
      const bookMoveLagMs = this.detectBookMoveLagMs(tsMs, fastMid, yesMidDerived);

      const row: LagSample = {
        tsMs,
        windowSlug: String(input.windowSlug || "").trim(),
        tauSec: finiteOrNull(input.tauSec),
        priceToBeat: finiteOrNull(input.priceToBeat),
        fastMid,
        oraclePrice,
        oracleUpdatedAtMs,
        yesBid,
        yesAsk,
        yesMid: yesMidDerived,
        impliedProbMid,
        pModel,
        absProbGap,
        polyUpdateAgeMs,
        oracleAgeMs,
        absOracleFast,
        bookMoveLagMs
      };

      this.samples.push(row);
      if (this.samples.length > this.maxSamples) {
        this.samples.splice(0, this.samples.length - this.maxSamples);
      }

      this.queueWrite(row);
    } catch {
      // Never throw on hot path.
    }
  }

  getRecent(limit = 50): LagSample[] {
    const n = Math.max(1, Math.floor(limit));
    const start = Math.max(0, this.samples.length - n);
    return this.samples.slice(start).map((row) => ({ ...row }));
  }

  getStats(): LagProfilerStats {
    try {
      const poly = collectMetric(this.samples, (row) => row.polyUpdateAgeMs);
      const oracleAge = collectMetric(this.samples, (row) => row.oracleAgeMs);
      const absOracleFast = collectMetric(this.samples, (row) => row.absOracleFast);
      const absProbGap = collectMetric(this.samples, (row) => row.absProbGap);
      const bookMoveLag = collectMetric(this.samples, (row) => row.bookMoveLagMs);

      return {
        samples: this.samples.length,
        lastFastMidTsMs: this.lastFastMidTsMs,
        lastOracleTsMs: this.lastOracleTsMs,
        lastBookTsMs: this.lastBookTsMs,
        lastYesMid: this.lastYesMid,
        metrics: {
          polyUpdateAgeMs: summarize(poly),
          oracleAgeMs: summarize(oracleAge),
          absOracleFast: summarize(absOracleFast),
          absProbGap: summarize(absProbGap),
          bookMoveLagMs: summarize(bookMoveLag)
        }
      };
    } catch {
      return {
        samples: 0,
        lastFastMidTsMs: this.lastFastMidTsMs,
        lastOracleTsMs: this.lastOracleTsMs,
        lastBookTsMs: this.lastBookTsMs,
        lastYesMid: this.lastYesMid,
        metrics: {
          polyUpdateAgeMs: emptyMetric(),
          oracleAgeMs: emptyMetric(),
          absOracleFast: emptyMetric(),
          absProbGap: emptyMetric(),
          bookMoveLagMs: emptyMetric()
        }
      };
    }
  }

  private detectBookMoveLagMs(
    tsMs: number,
    fastMid: number | null,
    yesMid: number | null
  ): number | null {
    if (this.pendingBookLagEvent && tsMs - this.pendingBookLagEvent.startTsMs > 30_000) {
      this.pendingBookLagEvent = null;
    }

    if (
      this.pendingBookLagEvent &&
      yesMid !== null &&
      this.pendingBookLagEvent.yesMidStart > 0
    ) {
      const moveBps =
        ((yesMid - this.pendingBookLagEvent.yesMidStart) / this.pendingBookLagEvent.yesMidStart) *
        10_000;
      const dir = Math.sign(moveBps) as -1 | 0 | 1;
      if (
        dir === this.pendingBookLagEvent.direction &&
        Math.abs(moveBps) >= this.bookConfirmBps
      ) {
        const lagMs = Math.max(0, tsMs - this.pendingBookLagEvent.startTsMs);
        this.pendingBookLagEvent = null;
        return lagMs;
      }
    }

    if (fastMid === null || !(fastMid > 0)) {
      return null;
    }

    if (this.prevFastMid) {
      const dtMs = tsMs - this.prevFastMid.tsMs;
      if (dtMs > 0 && dtMs <= 2_000) {
        const moveBps = ((fastMid - this.prevFastMid.price) / this.prevFastMid.price) * 10_000;
        const dir = Math.sign(moveBps) as -1 | 0 | 1;
        if (
          dir !== 0 &&
          Math.abs(moveBps) >= this.fastEventBps &&
          this.pendingBookLagEvent === null &&
          yesMid !== null &&
          yesMid > 0
        ) {
          this.pendingBookLagEvent = {
            direction: dir,
            startTsMs: tsMs,
            yesMidStart: yesMid
          };
        }
      }
    }

    this.prevFastMid = { price: fastMid, tsMs };
    return null;
  }

  private queueWrite(row: LagSample): void {
    const now = Date.now();
    if (now - this.lastQueuedWriteTsMs < 1_000) {
      return;
    }
    this.lastQueuedWriteTsMs = now;
    this.lineBuffer.push(JSON.stringify(row));
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      void this.flushAsync();
    }, 20);
  }

  private async flushAsync(): Promise<void> {
    if (this.flushing || this.lineBuffer.length === 0) {
      return;
    }
    this.flushing = true;
    try {
      await this.ensureLogDir();
      while (this.lineBuffer.length > 0) {
        const chunk = this.lineBuffer.splice(0, 256);
        if (chunk.length === 0) break;
        await appendFile(this.logPath, `${chunk.join("\n")}\n`, "utf8");
      }
    } catch {
      // Drop write errors; keep engine hot path unaffected.
    } finally {
      this.flushing = false;
      if (this.lineBuffer.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  private async ensureLogDir(): Promise<void> {
    try {
      await mkdir(path.dirname(this.logPath), { recursive: true });
    } catch {
      // no-op
    }
  }
}

function midFromBbo(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null) return null;
  if (!(ask >= bid) || !(ask > 0)) return null;
  return (bid + ask) / 2;
}

function finiteOrNull(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function collectMetric<T>(rows: T[], pick: (row: T) => number | null): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const value = pick(row);
    if (value === null) continue;
    if (!Number.isFinite(value)) continue;
    out.push(value);
  }
  return out;
}

function summarize(values: number[]): LagMetricStats {
  if (values.length === 0) {
    return emptyMetric();
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    count: values.length,
    mean,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9)
  };
}

function percentile(sortedValues: number[], q: number): number | null {
  if (sortedValues.length === 0) return null;
  const clampedQ = Math.max(0, Math.min(1, q));
  const rank = (sortedValues.length - 1) * clampedQ;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sortedValues[low];
  const w = rank - low;
  return sortedValues[low] * (1 - w) + sortedValues[high] * w;
}

function emptyMetric(): LagMetricStats {
  return {
    count: 0,
    mean: null,
    p50: null,
    p90: null
  };
}
