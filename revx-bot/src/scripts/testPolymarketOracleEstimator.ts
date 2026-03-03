import { BotConfig, loadConfig } from "../config";
import { OracleEstimator } from "../polymarket/OracleEstimator";
import { SpotFeed, SpotVenueTick } from "../polymarket/types";

process.env.DRY_RUN = "true";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function approx(actual: number, expected: number, tolerance: number, message: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message} (actual=${actual}, expected=${expected}, tolerance=${tolerance})`);
  }
}

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const base = loadConfig();
  return {
    ...base,
    polymarket: {
      ...base.polymarket,
      loopMs: 1000,
      risk: {
        ...base.polymarket.risk,
        staleMs: 2000
      },
      oracle: {
        ...base.polymarket.oracle,
        madThreshold: 3,
        trimFraction: 0.15,
        emaHalfLifeSec: 10
      }
    },
    ...overrides
  };
}

class FakeSpotFeed implements SpotFeed {
  constructor(private readonly rows: SpotVenueTick[]) {}

  async fetch(): Promise<SpotVenueTick[]> {
    return this.rows;
  }
}

async function run(): Promise<void> {
  const now = Date.now();
  const feed = new FakeSpotFeed([
    {
      venue: "coinbase",
      ts: now,
      bid: 99.95,
      ask: 100.05,
      mid: 100,
      last: null,
      spreadBps: 10,
      ok: true
    },
    {
      venue: "kraken",
      ts: now,
      bid: 100.0,
      ask: 100.1,
      mid: 100.05,
      last: null,
      spreadBps: 10,
      ok: true
    },
    {
      venue: "binance",
      ts: now,
      bid: 129.95,
      ask: 130.05,
      mid: 130,
      last: null,
      spreadBps: 10,
      ok: true
    },
    {
      venue: "stale",
      ts: now - 10_000,
      bid: 100.0,
      ask: 100.1,
      mid: 100.05,
      last: null,
      spreadBps: 10,
      ok: true
    }
  ]);

  const estimator = new OracleEstimator(makeConfig(), feed);
  const result = await estimator.estimate("BTC-USD", now);

  assert(result.staleRejected === 1, `expected staleRejected=1, got ${result.staleRejected}`);
  assert(result.outlierRejected >= 1, `expected at least one outlier rejected, got ${result.outlierRejected}`);
  approx(result.oracleRaw, 100.02, 0.25, "oracleRaw should stay near inlier mids");
  approx(result.oracleEst, result.oracleRaw, 0.5, "ema-smoothed value should remain close to raw estimate");

  // eslint-disable-next-line no-console
  console.log("Polymarket OracleEstimator tests: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Polymarket OracleEstimator tests: FAIL", error);
  process.exit(1);
});
