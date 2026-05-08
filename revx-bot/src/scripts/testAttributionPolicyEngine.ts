import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { AttributionPolicyEngine } from "../runtime/AttributionPolicyEngine";
import { buildDecisionAttributionRecord } from "../runtime/DecisionAttribution";
import { DecisionAttributionRecord, Store, TickerSnapshot } from "../store/Store";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const previousMinSamples = process.env.ATTRIBUTION_POLICY_MIN_SAMPLES;
  const previousLookback = process.env.ATTRIBUTION_POLICY_LOOKBACK_MINUTES;
  const previousHorizon = process.env.ATTRIBUTION_POLICY_HORIZON_SEC;
  const previousStartupGrace = process.env.ATTRIBUTION_POLICY_STARTUP_GRACE_MINUTES;
  process.env.ATTRIBUTION_POLICY_MIN_SAMPLES = "2";
  process.env.ATTRIBUTION_POLICY_LOOKBACK_MINUTES = "120";
  process.env.ATTRIBUTION_POLICY_HORIZON_SEC = "300";
  process.env.ATTRIBUTION_POLICY_STARTUP_GRACE_MINUTES = "0";

  try {
    const config = loadConfig();
    const logger = buildLogger(config);
    const symbol = config.symbol;
    const nowTs = Date.now();
    const records: DecisionAttributionRecord[] = [
      buildRecord(symbol, "POLYMARKET", "BUY_YES", nowTs - 20 * 60_000, 100),
      buildRecord(symbol, "POLYMARKET", "BUY_YES", nowTs - 10 * 60_000, 100),
      buildRecord(symbol, "REVX", "QUOTE_BUY", nowTs - 19 * 60_000, 100),
      buildRecord(symbol, "REVX", "QUOTE_BUY", nowTs - 9 * 60_000, 100)
    ];
    const tickerSnapshots: TickerSnapshot[] = [
      makeTicker(symbol, nowTs - 20 * 60_000 + 300_000, 99),
      makeTicker(symbol, nowTs - 10 * 60_000 + 300_000, 98.5),
      makeTicker(symbol, nowTs - 19 * 60_000 + 300_000, 100.4),
      makeTicker(symbol, nowTs - 9 * 60_000 + 300_000, 100.2)
    ];
    const store = {
      getRecentDecisionAttributions: () => records,
      getRecentTickerSnapshots: () => tickerSnapshots
    } as Pick<Store, "getRecentDecisionAttributions" | "getRecentTickerSnapshots"> as Store;
    const engine = new AttributionPolicyEngine(config, logger, store);
    const feedback = engine.evaluate(nowTs);

    assert(
      feedback.polymarket.sampleCount === 2,
      `expected polymarket sampleCount=2, got ${feedback.polymarket.sampleCount}`
    );
    assert(
      feedback.polymarket.allowNewRisk === true,
      `expected polymarket throttled but allowed, got ${String(feedback.polymarket.allowNewRisk)}`
    );
    assert(
      feedback.polymarket.reason === "ATTRIBUTION_POLY_SOFT_THROTTLE",
      `unexpected polymarket reason ${String(feedback.polymarket.reason)}`
    );
    assert(
      feedback.polymarket.multiplier > 0 && feedback.polymarket.multiplier < 1,
      `expected polymarket hard throttle multiplier in (0,1), got ${String(feedback.polymarket.multiplier)}`
    );
    assert(
      feedback.revx.allowNewRisk === true && feedback.revx.multiplier === 1,
      `expected revx neutral-positive feedback, got allow=${String(feedback.revx.allowNewRisk)} multiplier=${feedback.revx.multiplier}`
    );

    const mergedPoly = engine.mergePolymarketPolicy(
      { allowNewEntries: true, additionalBudgetUsd: 10, reason: null },
      feedback.polymarket
    );
    assert(mergedPoly.allowNewEntries === true, "expected merged polymarket policy to keep entries enabled");
    assert(
      mergedPoly.additionalBudgetUsd > 0 && mergedPoly.additionalBudgetUsd < 10,
      `expected merged polymarket budget to be throttled but positive, got ${String(mergedPoly.additionalBudgetUsd)}`
    );
    const mergedRevx = engine.mergeRevxPolicy(
      {
        allowNewBuyRisk: true,
        effectiveWorkingCapUsd: 100,
        effectiveTargetBtcNotionalUsd: 80,
        effectiveMaxBtcNotionalUsd: 100,
        buySizeMultiplier: 1,
        reason: null
      },
      feedback.revx
    );
    assert(mergedRevx.buySizeMultiplier === 1, `expected merged revx multiplier=1, got ${mergedRevx.buySizeMultiplier}`);

    // eslint-disable-next-line no-console
    console.log("AttributionPolicyEngine tests: PASS");
  } finally {
    restoreEnv("ATTRIBUTION_POLICY_MIN_SAMPLES", previousMinSamples);
    restoreEnv("ATTRIBUTION_POLICY_LOOKBACK_MINUTES", previousLookback);
    restoreEnv("ATTRIBUTION_POLICY_HORIZON_SEC", previousHorizon);
    restoreEnv("ATTRIBUTION_POLICY_STARTUP_GRACE_MINUTES", previousStartupGrace);
  }
}

function buildRecord(
  symbol: string,
  venue: "REVX" | "POLYMARKET",
  action: string,
  ts: number,
  referencePrice: number
): DecisionAttributionRecord {
  return buildDecisionAttributionRecord({
    decisionId: `${venue}:${action}:${ts}`,
    ts,
    venue,
    strategy: venue === "REVX" ? "MAKER_STRATEGY" : "BTC5M_LIVE_RUNNER",
    symbol,
    action,
    blocker: null,
    edge: 0.5,
    referencePrice: {
      price: referencePrice,
      ageMs: 0,
      ts,
      source: "TEST"
    },
    directionalInputs: {
      aggregate: null,
      intelPosture: null,
      venueBias: {
        bias: action === "BUY_NO" ? "SHORT" : "LONG",
        confidence: 0.7,
        ts,
        source: "TEST"
      }
    },
    decision:
      venue === "REVX"
        ? {
            buy_levels: action === "QUOTE_BUY" ? 2 : 0,
            sell_levels: action === "QUOTE_SELL" ? 2 : 0,
            signal_bias: "LONG"
          }
        : {
            chosen_side: action === "BUY_NO" ? "NO" : "YES"
          }
  });
}

function makeTicker(symbol: string, ts: number, mid: number): TickerSnapshot {
  return {
    symbol,
    bid: mid - 0.5,
    ask: mid + 0.5,
    mid,
    last: mid,
    ts
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (typeof value === "string") {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

if (require.main === module) {
  run();
}
