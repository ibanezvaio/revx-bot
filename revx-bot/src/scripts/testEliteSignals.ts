import { BotConfig, loadConfig } from "../config";
import { FairPriceModel } from "../signals/FairPriceModel";
import { RegimeClassifier } from "../signals/RegimeClassifier";
import { QuoteVenue } from "../signals/types";

process.env.DRY_RUN = "true";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
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
    signalRefreshMs: 1500,
    signalMaxQuoteAgeMs: 4500,
    signalMinConf: 0.55,
    signalUsdtDegrade: 0.03,
    fairMinVenues: 3,
    fairMaxDispersionBps: 10,
    fairMaxBasisBps: 12,
    toxicDriftBps: 12,
    ...overrides
  };
}

function venue(venueName: string, mid: number, ts: number, quote = "USD", ok = true): QuoteVenue {
  return {
    venue: venueName,
    symbol: "BTC-USD",
    quote,
    ts,
    bid: mid > 0 ? mid - 0.05 : null,
    ask: mid > 0 ? mid + 0.05 : null,
    mid: mid > 0 ? mid : null,
    spread_bps: mid > 0 ? (0.1 / mid) * 10_000 : null,
    latency_ms: 20,
    ok,
    error: ok ? "" : "bad venue"
  };
}

function testFairModelRobustMidAndStaleIgnore(): void {
  const cfg = makeConfig();
  const model = new FairPriceModel(cfg);
  const now = Date.now();
  const rows = [
    venue("coinbase", 100, now),
    venue("kraken", 100.1, now),
    venue("binance", 99.9, now),
    venue("outlier", 130, now - 12_000)
  ];
  const out = model.compute("BTC-USD", 100, rows, now);
  assert(out.globalMid > 99 && out.globalMid < 101, "globalMid should ignore stale outlier");
  assert(out.confidence >= 0 && out.confidence <= 1, "confidence must be bounded");
  approx(out.basisBps, (100 - out.fairMid) / out.fairMid * 10000, 0.001, "basis formula mismatch");
}

function testRegimeClassifierStates(): void {
  const cfg = makeConfig();
  const classifier = new RegimeClassifier(cfg);
  const calm = classifier.classify({
    confidence: 0.7,
    stdevBps: 2,
    driftBps: 1,
    dispersionBps: 1,
    failedVenueRate: 0
  });
  assert(calm.regime === "CALM", "low vol should classify CALM");

  const trend = classifier.classify({
    confidence: 0.85,
    stdevBps: 5,
    driftBps: 15,
    dispersionBps: 4,
    failedVenueRate: 0.1
  });
  assert(trend.regime === "TREND", "high drift + confidence should classify TREND");
  assert(trend.bias === "LONG", "positive drift should map to LONG bias");

  const crisis = classifier.classify({
    confidence: 0.3,
    stdevBps: cfg.hotVolBps + 10,
    driftBps: 2,
    dispersionBps: cfg.fairMaxDispersionBps * 2.2,
    failedVenueRate: 0.7
  });
  assert(crisis.regime === "CRISIS", "high failure/dispersion should classify CRISIS");
}

function run(): void {
  testFairModelRobustMidAndStaleIgnore();
  testRegimeClassifierStates();
  // eslint-disable-next-line no-console
  console.log("Elite signal tests: PASS");
}

run();

