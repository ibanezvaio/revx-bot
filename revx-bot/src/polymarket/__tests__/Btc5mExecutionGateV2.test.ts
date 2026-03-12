import { Btc5mExecutionGate } from "../live/Btc5mExecutionGate";
import { evaluateMinSharesConfigFeasibility, resolvePriorityBlockedReason } from "../PolymarketEngine";
import { Btc5mIntelligence, Btc5mSelectedMarket, Btc5mTick } from "../live/Btc5mTypes";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function makeGate(overrides: {
  minEdgeThreshold?: number;
  maxSpread?: number;
} = {}): Btc5mExecutionGate {
  const config = {
    polymarket: {
      mode: "live",
      live: {
        enableNoSide: true,
        minEdgeThreshold: overrides.minEdgeThreshold ?? 0.0005,
        maxSpread: overrides.maxSpread ?? 0.6,
        minEntryRemainingSec: 15,
        oracleWarnMs: 1_500,
        oracleHardBlockMs: 30_000
      }
    },
    takerFeeBps: 0,
    takerSlipBps: 0,
    edgeSafetyBps: 0
  } as any;
  const logger = { info: () => undefined };
  return new Btc5mExecutionGate(config, logger);
}

function makeTick(remainingSec = 120): Btc5mTick {
  return {
    tickNowMs: 1_773_147_060_000,
    tickNowSec: 1_773_147_060,
    currentBucketStartSec: 1_773_147_000,
    prevBucketStartSec: 1_773_146_700,
    nextBucketStartSec: 1_773_147_300,
    currentSlug: "btc-updown-5m-1773147000",
    prevSlug: "btc-updown-5m-1773146700",
    nextSlug: "btc-updown-5m-1773147300",
    remainingSec
  };
}

function makeSelected(overrides: Partial<Btc5mSelectedMarket> = {}): Btc5mSelectedMarket {
  return {
    marketId: "m-1",
    slug: "btc-updown-5m-1773147000",
    question: "BTC up/down 5m",
    priceToBeat: 0,
    startTs: 1_773_147_000_000,
    endTs: 1_773_147_300_000,
    remainingSec: 120,
    tickSize: "0.01",
    negRisk: false,
    chosenSide: null,
    selectedTokenId: null,
    yesTokenId: "yes-token",
    noTokenId: "no-token",
    yesBook: {
      side: "YES",
      tokenId: "yes-token",
      bestBid: 0.48,
      bestAsk: 0.49,
      mid: 0.485,
      spread: 0.01,
      quoteTs: Date.now(),
      bookable: true,
      reason: null
    },
    noBook: {
      side: "NO",
      tokenId: "no-token",
      bestBid: 0.49,
      bestAsk: 0.5,
      mid: 0.495,
      spread: 0.01,
      quoteTs: Date.now(),
      bookable: true,
      reason: null
    },
    selectionSource: "current_slug",
    orderbookOk: true,
    ...overrides
  };
}

function makeIntelligence(overrides: Partial<Btc5mIntelligence> = {}): Btc5mIntelligence {
  return {
    source: "MODEL",
    posture: "NEUTRAL",
    score: 0,
    pUpModel: 0.6,
    fallbackUsed: false,
    ...overrides
  };
}

export async function runBtc5mExecutionGateV2Tests(): Promise<void> {
  const previousDislocation = process.env.POLYMARKET_LIVE_MIN_DISLOCATION;
  const previousExtremeMin = process.env.POLYMARKET_LIVE_EXTREME_PRICE_MIN;
  const previousExtremeMax = process.env.POLYMARKET_LIVE_EXTREME_PRICE_MAX;
  process.env.POLYMARKET_LIVE_MIN_DISLOCATION = "0.03";
  process.env.POLYMARKET_LIVE_EXTREME_PRICE_MIN = "0.05";
  process.env.POLYMARKET_LIVE_EXTREME_PRICE_MAX = "0.95";

  try {
    // outcome hint fallback when model fair is unavailable
    {
      const gate = makeGate();
      const selected = makeSelected() as Btc5mSelectedMarket & { outcomePricesHint?: number[] };
      selected.outcomePricesHint = [0.62, 0.38];
      const decision = gate.evaluate({
        tick: makeTick(),
        selected,
        intelligence: makeIntelligence({ pUpModel: Number.NaN, source: "INTEL_FALLBACK" }),
        oracleAgeMs: 200
      });
      const fairPriceSource = (decision.edgeMath as { fairPriceSource?: string } | undefined)?.fairPriceSource ?? null;
      assert(fairPriceSource === "OUTCOME_HINT", `expected OUTCOME_HINT, got ${String(fairPriceSource)}`);
      assert(Math.abs(Number(decision.fairYes) - 0.62) < 1e-6, `expected fairYes=0.62, got ${String(decision.fairYes)}`);
    }

    // no fair source must block, and fairYes must not fallback to yesAsk
    {
      const gate = makeGate();
      const decision = gate.evaluate({
        tick: makeTick(),
        selected: makeSelected({ yesBook: { ...makeSelected().yesBook, bestAsk: 0.49 } }),
        intelligence: makeIntelligence({ pUpModel: Number.NaN, source: "UNAVAILABLE" }),
        oracleAgeMs: 250
      });
      assert(decision.blocker === "FAIR_PRICE_UNAVAILABLE", `expected FAIR_PRICE_UNAVAILABLE, got ${String(decision.blocker)}`);
      const fairPriceSource = (decision.edgeMath as { fairPriceSource?: string } | undefined)?.fairPriceSource ?? null;
      assert(fairPriceSource === "NONE", `expected fairPriceSource=NONE, got ${String(fairPriceSource)}`);
      assert(decision.fairYes === null, `expected fairYes null, got ${String(decision.fairYes)}`);
    }

    // EXTREME_PRICE_FILTER must outrank edge blocker
    {
      const gate = makeGate({ minEdgeThreshold: 0.0005 });
      const decision = gate.evaluate({
        tick: makeTick(),
        selected: makeSelected({
          yesBook: { ...makeSelected().yesBook, bestBid: 0.96, bestAsk: 0.97, spread: 0.01 },
          noBook: { ...makeSelected().noBook, bestBid: 0.02, bestAsk: 0.03, spread: 0.01 }
        }),
        intelligence: makeIntelligence({ pUpModel: 0.98 }),
        oracleAgeMs: 200
      });
      assert(decision.blocker === "EXTREME_PRICE_FILTER", `expected EXTREME_PRICE_FILTER, got ${String(decision.blocker)}`);
    }

    // INSUFFICIENT_DISLOCATION must outrank edge blocker
    {
      const gate = makeGate({ minEdgeThreshold: 0.05 });
      const decision = gate.evaluate({
        tick: makeTick(),
        selected: makeSelected({
          yesBook: { ...makeSelected().yesBook, bestBid: 0.535, bestAsk: 0.54, spread: 0.005 },
          noBook: { ...makeSelected().noBook, bestBid: 0.48, bestAsk: 0.49, spread: 0.01 }
        }),
        intelligence: makeIntelligence({ pUpModel: 0.55 }),
        oracleAgeMs: 200
      });
      assert(decision.blocker === "INSUFFICIENT_DISLOCATION", `expected INSUFFICIENT_DISLOCATION, got ${String(decision.blocker)}`);
    }

    // blocker priority should pick extreme/dislocation over edge
    {
      const prioritizedExtreme = resolvePriorityBlockedReason({
        currentReason: "EDGE_BELOW_THRESHOLD",
        fairPriceSource: "MODEL",
        extremePriceFilterHit: true,
        dislocationAbs: 0.01,
        minDislocationConfig: 0.03,
        sizingRejectReason: null,
        configFeasible: true
      });
      assert(prioritizedExtreme === "EXTREME_PRICE_FILTER", `expected EXTREME_PRICE_FILTER, got ${String(prioritizedExtreme)}`);
      const prioritizedDislocation = resolvePriorityBlockedReason({
        currentReason: "EDGE_BELOW_THRESHOLD",
        fairPriceSource: "MODEL",
        extremePriceFilterHit: false,
        dislocationAbs: 0.01,
        minDislocationConfig: 0.03,
        sizingRejectReason: null,
        configFeasible: true
      });
      assert(
        prioritizedDislocation === "INSUFFICIENT_DISLOCATION",
        `expected INSUFFICIENT_DISLOCATION, got ${String(prioritizedDislocation)}`
      );
    }

    // config infeasible min-shares blocker and minShares=1 feasibility
    {
      const infeasible = evaluateMinSharesConfigFeasibility({
        maxNotionalPerWindow: 1,
        chosenSidePriceUsed: 0.49,
        minSharesRequiredConfig: 5
      });
      assert(infeasible.configFeasible === false, "expected configFeasible=false for minShares=5");
      const prioritized = resolvePriorityBlockedReason({
        currentReason: "EDGE_BELOW_THRESHOLD",
        fairPriceSource: "MODEL",
        extremePriceFilterHit: false,
        dislocationAbs: 0.05,
        minDislocationConfig: 0.03,
        sizingRejectReason: "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED",
        configFeasible: infeasible.configFeasible
      });
      assert(
        prioritized === "CONFIG_INFEASIBLE_MIN_SHARES",
        `expected CONFIG_INFEASIBLE_MIN_SHARES, got ${String(prioritized)}`
      );
      const feasible = evaluateMinSharesConfigFeasibility({
        maxNotionalPerWindow: 1,
        chosenSidePriceUsed: 0.49,
        minSharesRequiredConfig: 1
      });
      assert(feasible.configFeasible === true, "expected configFeasible=true for minShares=1");
    }

    // eslint-disable-next-line no-console
    console.log("Btc5mExecutionGateV2 tests: PASS");
  } finally {
    if (previousDislocation === undefined) delete process.env.POLYMARKET_LIVE_MIN_DISLOCATION;
    else process.env.POLYMARKET_LIVE_MIN_DISLOCATION = previousDislocation;
    if (previousExtremeMin === undefined) delete process.env.POLYMARKET_LIVE_EXTREME_PRICE_MIN;
    else process.env.POLYMARKET_LIVE_EXTREME_PRICE_MIN = previousExtremeMin;
    if (previousExtremeMax === undefined) delete process.env.POLYMARKET_LIVE_EXTREME_PRICE_MAX;
    else process.env.POLYMARKET_LIVE_EXTREME_PRICE_MAX = previousExtremeMax;
  }
}

if (require.main === module) {
  void runBtc5mExecutionGateV2Tests();
}
