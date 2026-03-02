import { BotConfig, loadConfig } from "../config";
import { FairPriceModel } from "../signal/FairPriceModel";
import { ExternalVenueSnapshot } from "../signal/types";

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
    fairStaleMs: 2500,
    fairMinVenues: 3,
    fairMaxDispersionBps: 10,
    fairMaxBasisBps: 12,
    toxicDriftBps: 12,
    ...overrides
  };
}

function makeSnapshot(
  venue: ExternalVenueSnapshot["venue"],
  mid: number,
  ts: number,
  ok = true
): ExternalVenueSnapshot {
  return {
    symbol: "BTC-USD",
    venue,
    quote: "USD",
    ts,
    bid: mid - 0.05,
    ask: mid + 0.05,
    mid,
    spread_bps: ((0.1 / mid) * 10000),
    latency_ms: 20,
    ok
  };
}

function testOutlierRejectionByMedian(): void {
  const now = Date.now();
  const model = new FairPriceModel(makeConfig());
  const snapshots: ExternalVenueSnapshot[] = [
    makeSnapshot("coinbase", 100.0, now),
    makeSnapshot("binance", 100.05, now),
    makeSnapshot("kraken", 130.0, now)
  ];
  const result = model.compute("BTC-USD", 100.0, snapshots, now);
  assert(result.fairMid < 105, `fairMid should reject single outlier in small-N median mode: ${result.fairMid}`);
  approx(result.fairMid, 100.05, 0.2, "fairMid should stay near non-outlier venues");
}

function testStalenessWeighting(): void {
  const now = Date.now();
  const model = new FairPriceModel(makeConfig());
  const snapshots: ExternalVenueSnapshot[] = [
    makeSnapshot("coinbase", 100.0, now),
    makeSnapshot("binance", 101.0, now - 10_000),
    makeSnapshot("kraken", 100.02, now)
  ];
  const result = model.compute("BTC-USD", 100.0, snapshots, now);
  const coinbase = result.venues.find((row) => row.venue === "coinbase");
  const binance = result.venues.find((row) => row.venue === "binance");
  assert(Boolean(coinbase), "coinbase venue state missing");
  assert(Boolean(binance), "binance venue state missing");
  assert(Boolean(binance && binance.stale), "stale venue should be flagged stale");
  assert(
    Boolean(binance && coinbase && binance.effectiveWeight < coinbase.effectiveWeight),
    "stale venue should have lower effective weight"
  );
}

function testDispersionAndBasis(): void {
  const now = Date.now();
  const model = new FairPriceModel(makeConfig());
  const snapshots: ExternalVenueSnapshot[] = [
    makeSnapshot("coinbase", 100.0, now),
    makeSnapshot("binance", 100.1, now),
    makeSnapshot("kraken", 99.9, now)
  ];
  const result = model.compute("BTC-USD", 101.0, snapshots, now);
  assert(result.dispersionBps > 0, "dispersion should be positive for separated mids");
  approx(result.dispersionBps, 20, 1.5, "dispersion bps should match max-min small-N formula");
  assert(result.basisBps > 0, "basis should be positive when revxMid > fairMid");
}

function testConfidenceBoundsAndFallback(): void {
  const now = Date.now();
  const model = new FairPriceModel(makeConfig());
  const snapshots: ExternalVenueSnapshot[] = [
    makeSnapshot("coinbase", 100.0, now),
    makeSnapshot("binance", 100.05, now),
    makeSnapshot("kraken", 100.1, now)
  ];
  const result = model.compute("BTC-USD", 100.0, snapshots, now);
  assert(result.confidence >= 0 && result.confidence <= 1, "confidence must be bounded [0,1]");

  const empty = new FairPriceModel(makeConfig());
  const fallback = empty.compute("BTC-USD", 100.0, [], now);
  approx(fallback.fairMid, 100.0, 0.000001, "fallback fairMid should use RevX mid");
  assert(fallback.confidence === 0, "fallback confidence should be 0 when no external venues");
  assert(fallback.reason === "NO_EXTERNAL_VENUES", "fallback reason should be NO_EXTERNAL_VENUES");
}

function run(): void {
  testOutlierRejectionByMedian();
  testStalenessWeighting();
  testDispersionAndBasis();
  testConfidenceBoundsAndFallback();
  // eslint-disable-next-line no-console
  console.log("FairPriceModel tests: PASS");
}

run();
