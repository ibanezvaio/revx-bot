import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { PolymarketEngine } from "../polymarket/PolymarketEngine";
import { getPaperTradeStatus } from "../polymarket/paper/PaperLedger";
import { slugForTs } from "../polymarket/btc5m";

process.env.DRY_RUN = "true";
process.env.POLYMARKET_ENABLED = "true";
process.env.POLYMARKET_MODE = "paper";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function makeRawMarket(input: {
  marketId: string;
  slug: string;
  priceToBeat: number;
  startTs: number;
  endTs: number;
  yesTokenId: string;
  noTokenId: string;
}): Record<string, unknown> {
  return {
    id: input.marketId,
    market_id: input.marketId,
    slug: input.slug,
    eventSlug: input.slug,
    question: `Will BTC be above $${input.priceToBeat} in 5 minutes?`,
    price_to_beat: input.priceToBeat,
    startTs: input.startTs,
    endTs: input.endTs,
    clobTokenIds: [input.yesTokenId, input.noTokenId],
    outcomes: ["Up", "Down"],
    acceptingOrders: true,
    active: true,
    closed: false,
    enableOrderBook: true
  };
}

async function run(): Promise<void> {
  const base = loadConfig();
  const ledgerPath = path.join(tmpdir(), `revx-polymarket-expiry-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });

  const config = {
    ...base,
    polymarket: {
      ...base.polymarket,
      enabled: true,
      mode: "paper" as const,
      marketQuery: {
        ...base.polymarket.marketQuery,
        symbol: "BTC-USD",
        cadenceMinutes: 5
      },
      threshold: {
        ...base.polymarket.threshold,
        baseEdge: 0,
        volK: 0,
        closePenalty: 0,
        maxSpread: 0.2
      },
      sizing: {
        ...base.polymarket.sizing,
        maxNotionalPerWindow: 20,
        minOrderNotional: 0.5
      },
      risk: {
        ...base.polymarket.risk,
        noNewOrdersInLastSec: 45,
        maxExposure: 1_000
      },
      paper: {
        ...base.polymarket.paper,
        ledgerPath,
        minEdgeThreshold: 0,
        minNetEdge: 0,
        probExtreme: 0.5,
        extremeLowPrice: 0.5,
        extremeHighPrice: 0.5001,
        entryMinRemainingSec: 45,
        entryMaxRemainingSec: 285,
        resolveGraceMs: 10_000,
        forceTrade: false
      }
    }
  };

  const logger = buildLogger(config);
  const engine = new PolymarketEngine(config, logger);
  const engineAny = engine as any;
  const fiveMinMs = 5 * 60 * 1000;
  const bucketStart = Math.floor(Date.now() / fiveMinMs) * fiveMinMs;
  const currentSlug = slugForTs(Math.floor(bucketStart / 1000));
  const nextSlug = slugForTs(Math.floor((bucketStart + fiveMinMs) / 1000));
  const priceToBeat = 100;

  const currentRow = makeRawMarket({
    marketId: "current-market",
    slug: currentSlug,
    priceToBeat,
    startTs: bucketStart,
    endTs: bucketStart + fiveMinMs,
    yesTokenId: "current-yes",
    noTokenId: "current-no"
  });
  const nextRow = makeRawMarket({
    marketId: "next-market",
    slug: nextSlug,
    priceToBeat,
    startTs: bucketStart + fiveMinMs,
    endTs: bucketStart + fiveMinMs * 2,
    yesTokenId: "next-yes",
    noTokenId: "next-no"
  });

  let mockedNow = bucketStart + 20_000;
  let lastFetchAttemptTs = 0;
  let lastFetchOkTs = 0;
  engineAny.client = {
    getActiveMarketBySlug: async (slug: string) => {
      if (slug === currentSlug) {
        return mockedNow < bucketStart + fiveMinMs ? currentRow : null;
      }
      if (slug === nextSlug) {
        return mockedNow >= bucketStart + fiveMinMs + 20_000 ? nextRow : null;
      }
      return null;
    },
    listMarketsPage: async () => {
      const now = Date.now();
      lastFetchAttemptTs = now;
      lastFetchOkTs = now;
      return { rows: [] };
    },
    getIngestionTelemetry: () => ({
      lastFetchAttemptTs,
      lastFetchOkTs,
      lastFetchErr: null,
      lastHttpStatus: 200
    }),
    recordFetchDisabled: () => {},
    getMarketContext: async (marketId: string) => {
      if (marketId !== "current-market") return null;
      if (mockedNow < bucketStart + fiveMinMs) {
        return {
          marketId: currentRow.id,
          slug: currentSlug,
          active: true,
          closed: false,
          acceptingOrders: true,
          enableOrderBook: true,
          archived: false,
          cancelled: false,
          resolution: {
            yesTokenId: "current-yes",
            noTokenId: "current-no",
            winningTokenId: null,
            winningSide: null,
            winningOutcome: null,
            winningOutcomeText: null,
            yesOutcomeMapped: "UP",
            noOutcomeMapped: "DOWN",
            resolved: false
          }
        };
      }
      if (mockedNow < bucketStart + fiveMinMs + 20_000) {
        return {
          marketId: currentRow.id,
          slug: currentSlug,
          active: false,
          closed: true,
          acceptingOrders: false,
          enableOrderBook: true,
          archived: false,
          cancelled: false,
          resolution: {
            yesTokenId: "current-yes",
            noTokenId: "current-no",
            winningTokenId: null,
            winningSide: null,
            winningOutcome: null,
            winningOutcomeText: null,
            yesOutcomeMapped: "UP",
            noOutcomeMapped: "DOWN",
            resolved: true
          }
        };
      }
      return {
        marketId: currentRow.id,
        slug: currentSlug,
        active: false,
        closed: true,
        acceptingOrders: false,
        enableOrderBook: true,
        archived: false,
        cancelled: false,
        resolution: {
          yesTokenId: "current-yes",
          noTokenId: "current-no",
          winningTokenId: "current-yes",
          winningSide: "YES",
          winningOutcome: "UP",
          winningOutcomeText: "UP",
          yesOutcomeMapped: "UP",
          noOutcomeMapped: "DOWN",
          resolved: true
        }
      };
    },
    getYesOrderBook: async (marketId: string) => ({
      marketId,
      tokenId: marketId === "next-market" ? "next-yes" : "current-yes",
      yesBid: 0.48,
      yesAsk: 0.49,
      yesMid: 0.485,
      spread: 0.01,
      bids: [{ price: 0.48, size: 100 }],
      asks: [{ price: 0.49, size: 100 }],
      ts: Date.now()
    }),
    getTokenOrderBook: async (tokenId: string) => ({
      tokenId,
      bestBid: 0.5,
      bestAsk: 0.53,
      bids: [{ price: 0.5, size: 100 }],
      asks: [{ price: 0.53, size: 100 }],
      ts: Date.now()
    })
  };
  engineAny.execution = {
    refreshLiveState: async () => {},
    getOpenOrderCount: () => 0,
    getTotalExposureUsd: () => 0,
    getConcurrentWindows: () => 0,
    getPositions: () => [],
    cancelAll: async () => {}
  };
  engineAny.risk = {
    isKillSwitchActive: () => false,
    triggerKillSwitch: () => {},
    checkNewOrder: () => ({ ok: true }),
    snapshot: () => ({
      killSwitch: false,
      openOrders: 0,
      totalExposureUsd: 0,
      concurrentWindows: 0,
      dailyRealizedPnlUsd: 0
    }),
    getRemainingDailyLossBudget: () => 1_000
  };
  engineAny.oracleRouter = {
    getOracleNow: async () => ({
      price: 101.2,
      source: "internal_fair_mid",
      ts: mockedNow,
      rawTs: mockedNow,
      staleMs: 0,
      state: "OK",
      fallbackSigmaPricePerSqrtSec: 0.1
    }),
    getFastMidNow: () => ({
      price: 101.2,
      ts: mockedNow,
      source: "internal_fair_mid"
    })
  };

  const originalDateNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => mockedNow;
  try {
    const lateLedgerPath = path.join(tmpdir(), `revx-polymarket-late-cutoff-${Date.now()}.jsonl`);
    rmSync(lateLedgerPath, { force: true });
    const lateConfig = {
      ...config,
      polymarket: {
        ...config.polymarket,
        paper: {
          ...config.polymarket.paper,
          ledgerPath: lateLedgerPath
        }
      }
    };
    const lateEngine = new PolymarketEngine(lateConfig, logger);
    const lateEngineAny = lateEngine as any;
    lateEngineAny.client = engineAny.client;
    lateEngineAny.execution = engineAny.execution;
    lateEngineAny.risk = engineAny.risk;
    lateEngineAny.oracleRouter = engineAny.oracleRouter;
    mockedNow = bucketStart + fiveMinMs - 40_000;
    await lateEngineAny.runOnce(mockedNow);
    assert(lateEngineAny.paperLedger.getOpenTrades().length === 0, "paper engine must not open in the final 40 seconds");
    assert(
      String(lateEngineAny.truthHoldReason || "") === "TOO_LATE_FOR_ENTRY",
      `expected TOO_LATE_FOR_ENTRY, got ${String(lateEngineAny.truthHoldReason)}`
    );
    rmSync(lateLedgerPath, { force: true });

    mockedNow = bucketStart + 20_000;
    await engineAny.runOnce(mockedNow);
    assert(engineAny.polyState.selectedSlug === currentSlug, "current market should be selected before expiry");
    assert(engineAny.paperLedger.getOpenTrades().length === 1, "current market should open one paper trade");
    const firstTrade = engineAny.paperLedger.getOpenTrades()[0];
    assert(firstTrade.notionalUsd >= config.polymarket.sizing.minOrderNotional, "paper entry must clear min notional");
    assert(firstTrade.marketId === "current-market", "entry must persist exact current interval market id");
    assert(firstTrade.yesTokenId === "current-yes" && firstTrade.noTokenId === "current-no", "entry must persist exact YES/NO token ids");

    await engineAny.runOnce(mockedNow + 1_000);
    assert(engineAny.paperLedger.getOpenTrades().length === 1, "duplicate-window protection must block a second entry in the same interval");

    mockedNow = bucketStart + fiveMinMs + 5_000;
    await engineAny.runOnce(mockedNow);
    const awaitingTrade = engineAny.paperLedger.getResolutionQueueTrades()[0];
    assert(engineAny.polyState.selectedSlug === null, "expired market must not remain selected");
    assert(engineAny.truthSelection.selectedSlug === null, "truth selection should clear expired slug");
    assert(engineAny.truthHoldReason !== "AWAITING_RESOLUTION", `current-window holdReason should not be pinned to AWAITING_RESOLUTION, got ${String(engineAny.truthHoldReason)}`);
    assert(getPaperTradeStatus(awaitingTrade) === "AWAITING_RESOLUTION", "expired open trade must transition to AWAITING_RESOLUTION");
    const runtimeAwaiting = engineAny.getDashboardSnapshot();
    assert(runtimeAwaiting.selection.lifecycleStatus === "AWAITING_RESOLUTION", `expected lifecycle AWAITING_RESOLUTION, got ${String(runtimeAwaiting.selection.lifecycleStatus)}`);
    assert(Number(runtimeAwaiting.awaitingResolutionCount || 0) === 1, `expected awaitingResolutionCount=1, got ${String(runtimeAwaiting.awaitingResolutionCount)}`);
    assert(Number(runtimeAwaiting.openTradesCount || 0) === 0, `expected openTradesCount=0 after expiry, got ${String(runtimeAwaiting.openTradesCount)}`);

    mockedNow = bucketStart + fiveMinMs + 20_000;
    await engineAny.runOnce(mockedNow);
    assert(engineAny.polyState.selectedSlug === nextSlug, "selector should roll over to the next active BTC5m market");
    assert(engineAny.truthSelection.selectedSlug === nextSlug, "truth selection should move to the next active BTC5m market");
    assert(engineAny.paperLedger.getResolvedTrades().length === 1, "expired prior trade should resolve from exact market outcome");
    const resolvedTrade = engineAny.paperLedger.getResolvedTrades()[0];
    assert(String(resolvedTrade.resolutionSource || "") === "OFFICIAL", "official resolution should be tagged OFFICIAL");
    const openTrades = engineAny.paperLedger.getOpenTrades();
    assert(openTrades.length === 1, "only the next active market should remain open after rollover");
    assert(openTrades[0].marketSlug === nextSlug, "new paper trade should belong to the next BTC5m market");
    assert(openTrades[0].notionalUsd >= config.polymarket.sizing.minOrderNotional, "rolled paper trade must clear min notional");
  } finally {
    (Date as unknown as { now: () => number }).now = originalDateNow;
  }

  rmSync(ledgerPath, { force: true });
  // eslint-disable-next-line no-console
  console.log("Polymarket paper expiry/sizing tests: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Polymarket paper expiry/sizing tests: FAIL", error);
  process.exit(1);
});
