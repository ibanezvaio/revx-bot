import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config";
import { getTradingTruthReporter } from "../logging/truth";
import { buildLogger } from "../logger";
import { PolymarketEngine } from "../polymarket/PolymarketEngine";

process.env.DRY_RUN = "false";
process.env.POLYMARKET_ENABLED = "true";
process.env.POLYMARKET_MODE = "live";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

type ReadMode = "ok" | "degraded";
type DiscoveryMode = "ok" | "timeout";
type ExecutionMode = "accept" | "invalid_signature" | "reject" | "min_shares";

function makeMarketRow(input: {
  slug: string;
  marketId: string;
  startTs: number;
  endTs: number;
  priceToBeat?: number;
}): Record<string, unknown> {
  return {
    id: input.marketId,
    market_id: input.marketId,
    slug: input.slug,
    eventSlug: input.slug,
    question: "Will Bitcoin be above $101.00 in the next 5 minutes?",
    price_to_beat: input.priceToBeat ?? 101,
    startTs: input.startTs,
    endTs: input.endTs,
    clobTokenIds: [`${input.marketId}-yes`, `${input.marketId}-no`],
    acceptingOrders: true,
    active: true,
    closed: false,
    enableOrderBook: true
  };
}

function buildHarness(input: {
  mockedNow: number;
  marketRowsBySlug: Record<string, Record<string, unknown>>;
  broadRows?: Record<string, unknown>[];
  readMode: ReadMode;
  discoveryMode?: DiscoveryMode;
  initialLastFetchOkTs?: number;
  missingYesMarketIds?: string[];
  missingNoTokenIds?: string[];
  missingQuoteTokenIds?: string[];
  executionMode?: ExecutionMode;
}): {
  engine: PolymarketEngine;
  engineAny: any;
  truth: ReturnType<typeof getTradingTruthReporter>;
  state: {
    mockedNow: number;
    readMode: ReadMode;
    discoveryMode: DiscoveryMode;
    executionMode: ExecutionMode;
    lastFetchAttemptTs: number;
    lastFetchOkTs: number;
    slugLookups: string[];
    searchLookups: string[];
    executionAttempts: number;
  };
  cleanup: () => void;
} {
  const base = loadConfig();
  const ledgerPath = path.join(tmpdir(), `revx-polymarket-live-resiliency-${Date.now()}-${Math.random()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const config = {
    ...base,
    dashboardEnabled: false,
    polymarket: {
      ...base.polymarket,
      enabled: true,
      mode: "live" as const,
      liveConfirmed: true,
      killSwitch: false,
      marketQuery: {
        ...base.polymarket.marketQuery,
        symbol: "BTC-USD",
        cadenceMinutes: 5
      },
      threshold: {
        ...base.polymarket.threshold,
        baseEdge: 0.25,
        volK: 0,
        closePenalty: 0,
        maxSpread: 0.2
      },
      sizing: {
        ...base.polymarket.sizing,
        minOrderNotional: 1,
        maxNotionalPerWindow: 20
      },
      risk: {
        ...base.polymarket.risk,
        maxExposure: 1_000,
        noNewOrdersInLastSec: 30,
        staleMs: 5_000
      },
      paper: {
        ...base.polymarket.paper,
        ledgerPath
      }
    }
  };
  const logger = buildLogger(config);
  const engine = new PolymarketEngine(config, logger);
  const engineAny = engine as any;
  const truth = getTradingTruthReporter(config, logger);
  const state = {
    mockedNow: input.mockedNow,
    readMode: input.readMode,
    discoveryMode: input.discoveryMode ?? "ok",
    executionMode: input.executionMode ?? "accept",
    lastFetchAttemptTs: 0,
    lastFetchOkTs: input.initialLastFetchOkTs ?? 0,
    slugLookups: [] as string[],
    searchLookups: [] as string[],
    executionAttempts: 0
  };
  const broadRows = input.broadRows ?? Object.values(input.marketRowsBySlug);
  const missingYesMarketIds = new Set(input.missingYesMarketIds ?? []);
  const missingNoTokenIds = new Set(input.missingNoTokenIds ?? []);
  const missingQuoteTokenIds = new Set(input.missingQuoteTokenIds ?? []);

  const clientStub = {
    listMarketsPage: async (pageInput: {
      slug?: string;
      search?: string;
      active?: boolean;
      closed?: boolean;
      archived?: boolean;
    }) => {
      state.lastFetchAttemptTs = state.mockedNow;
      const normalizedSlug = String(pageInput?.slug || "").trim();
      const normalizedSearch = String(pageInput?.search || "").trim();
      if (normalizedSlug) state.slugLookups.push(normalizedSlug);
      if (normalizedSearch) state.searchLookups.push(normalizedSearch);
      if (state.discoveryMode === "timeout") {
        throw new Error(`Polymarket slug lookup timeout for ${String(pageInput?.slug || pageInput?.search || "active-scan")}`);
      }
      state.lastFetchOkTs = state.mockedNow;
      if (normalizedSlug) {
        const row = input.marketRowsBySlug[normalizedSlug];
        return { rows: row ? [{ ...row }] : [] };
      }
      return { rows: broadRows.map((row) => ({ ...row })) };
    },
    getIngestionTelemetry: () => ({
      lastFetchAttemptTs: state.lastFetchAttemptTs,
      lastFetchOkTs: state.lastFetchOkTs,
      lastFetchErr: null,
      lastHttpStatus: 200
    }),
    recordFetchDisabled: () => {},
    getActiveMarketBySlug: async (slug: string) => {
      const row = input.marketRowsBySlug[String(slug || "").trim()];
      return row ? { ...row } : null;
    },
    getYesOrderBook: async (marketId: string) => {
      if (missingYesMarketIds.has(marketId)) {
        throw new Error("No orderbook exists for the requested token id");
      }
      if (state.readMode === "degraded") {
        throw new Error("Polymarket CLOB call timeout (getOrderBook)");
      }
      return {
        marketId,
        tokenId: `${marketId}-yes`,
        yesBid: 0.47,
        yesAsk: 0.49,
        yesMid: 0.48,
        spread: 0.02,
        bids: [{ price: 0.47, size: 100 }],
        asks: [{ price: 0.49, size: 100 }],
        ts: state.mockedNow
      };
    },
    getTokenPriceQuote: async (tokenId: string) => {
      if (missingQuoteTokenIds.has(tokenId)) {
        throw new Error("No orderbook exists for the requested token id");
      }
      if (String(tokenId || "").endsWith("-yes")) {
        return {
          tokenId,
          price: 0.48,
          bestBid: 0.47,
          bestAsk: 0.49,
          mid: 0.48,
          ts: state.mockedNow,
          source: "clob_price" as const,
          fetchFailed: false,
          failedSides: []
        };
      }
      return {
        tokenId,
        price: 0.52,
        bestBid: 0.51,
        bestAsk: 0.53,
        mid: 0.52,
        ts: state.mockedNow,
        source: "clob_price" as const,
        fetchFailed: false,
        failedSides: []
      };
    },
    getTokenOrderBook: async (tokenId: string) => {
      if (missingNoTokenIds.has(tokenId)) {
        throw new Error("No orderbook exists for the requested token id");
      }
      return {
        tokenId,
        bestBid: 0.5,
        bestAsk: 0.53,
        bids: [{ price: 0.5, size: 100 }],
        asks: [{ price: 0.53, size: 100 }],
        ts: state.mockedNow
      };
    },
    getOpenOrders: async () => {
      if (state.readMode === "degraded") {
        throw new Error("socket hang up EPIPE");
      }
      return [];
    },
    getRecentTrades: async () => {
      if (state.readMode === "degraded") {
        throw new Error("read ECONNRESET timeout");
      }
      return [];
    },
    getOrder: async () => null
  };

  engineAny.client = clientStub;
  engineAny.execution.client = clientStub;
  engineAny.oracleRouter = {
    getOracleNow: async () => ({
      price: 101.2,
      source: "internal_fair_mid",
      ts: state.mockedNow,
      rawTs: state.mockedNow,
      staleMs: 0,
      state: "OK",
      fallbackSigmaPricePerSqrtSec: 0.1
    }),
    getFastMidNow: () => ({
      price: 101.2,
      ts: state.mockedNow,
      source: "internal_fair_mid"
    })
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
  engineAny.execution.executeBuyYes = async () => {
    state.executionAttempts += 1;
    if (state.executionMode === "min_shares") {
      return {
        action: "HOLD",
        accepted: false,
        filledShares: 0,
        reason: "Size (0.41) lower than the minimum: 5"
      };
    }
    if (state.executionMode === "invalid_signature") {
      return {
        action: "HOLD",
        accepted: false,
        filledShares: 0,
        reason: "INVALID_SIGNATURE"
      };
    }
    if (state.executionMode === "reject") {
      return {
        action: "HOLD",
        accepted: false,
        filledShares: 0,
        reason: "LIVE_REJECTED"
      };
    }
    return {
      action: "BUY_YES",
      accepted: true,
      filledShares: 1,
      fillPrice: 0.49,
      reason: "LIVE_ACCEPTED_TEST_STUB"
    };
  };
  engineAny.running = true;
  engineAny.polyEngineRunning = true;

  const originalDateNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => state.mockedNow;
  return {
    engine,
    engineAny,
    truth,
    state,
    cleanup: () => {
      (Date as unknown as { now: () => number }).now = originalDateNow;
      rmSync(ledgerPath, { force: true });
    }
  };
}

async function runDegradedStartupScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const windowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const windowEndTs = windowStartTs + windowMs;
  const currentSlug = `btc-updown-5m-${Math.floor(windowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: windowStartTs + 90_000,
    marketRowsBySlug: {
      [currentSlug]: makeMarketRow({
        slug: currentSlug,
        marketId: "live-market-current",
        startTs: windowStartTs,
        endTs: windowEndTs
      })
    },
    readMode: "degraded"
  });
  try {
    harness.engineAny.config.polymarket.live.minEntryRemainingSec = 1;
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtimeStartup = harness.engine.getDashboardSnapshot();
    const truthStartup = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(harness.engineAny.running === true, "live engine loop state must remain running during degraded startup");
    assert(runtimeStartup.status === "RUNNING", `degraded startup must not stay STARTING, got ${String(runtimeStartup.status)}`);
    assert(runtimeStartup.polyEngineRunning === true, "degraded startup must publish running=true");
    assert(runtimeStartup.tradingPaused === false, "degraded startup ancillary reads must not hard-pause trading");
    assert(runtimeStartup.warningState === "NETWORK_ERROR", `degraded startup should surface warningState NETWORK_ERROR, got ${String(runtimeStartup.warningState)}`);
    assert(runtimeStartup.selection.selectedSlug === currentSlug, `degraded startup must still select current market, got ${String(runtimeStartup.selection.selectedSlug)}`);
    assert(Number(runtimeStartup.selection.remainingSec || 0) > 0, `degraded startup must preserve positive remainingSec, got ${String(runtimeStartup.selection.remainingSec)}`);
    assert(runtimeStartup.selection.windowsCount === 1, `degraded startup must keep windowsCount=1, got ${String(runtimeStartup.selection.windowsCount)}`);
    assert(runtimeStartup.selection.discoveredCandidatesCount === 1, `degraded startup must keep candidatesCount=1, got ${String(runtimeStartup.selection.discoveredCandidatesCount)}`);
    assert(truthStartup.poly.warningState === "NETWORK_ERROR", `truth startup warningState mismatch: ${String(truthStartup.poly.warningState)}`);
    assert(truthStartup.poly.selection.selectedSlug === currentSlug, "truth startup must preserve selected slug");
    assert(Number(truthStartup.poly.selection.remainingSec || 0) > 0, `truth startup must preserve positive remainingSec, got ${String(truthStartup.poly.selection.remainingSec)}`);
    assert(truthStartup.poly.selection.windowsCount === 1, `truth startup must preserve windowsCount=1, got ${String(truthStartup.poly.selection.windowsCount)}`);
    assert(truthStartup.poly.selection.discoveredCandidatesCount === 1, `truth startup must preserve candidatesCount=1, got ${String(truthStartup.poly.selection.discoveredCandidatesCount)}`);
    assert(truthStartup.poly.selection.chosenDirection === "UP", `truth startup must preserve direction, got ${String(truthStartup.poly.selection.chosenDirection)}`);

    harness.state.readMode = "ok";
    harness.state.mockedNow += 2_000;
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtimeRecovered = harness.engine.getDashboardSnapshot();
    assert(
      runtimeRecovered.warningState === null || String(runtimeRecovered.warningState).includes("DISCOVERY_STALE"),
      `recovered startup scenario should clear warningState or mark DISCOVERY_STALE, got ${String(runtimeRecovered.warningState)}`
    );
    assert(runtimeRecovered.selection.selectedSlug === currentSlug, "recovered startup scenario must keep selected slug");
  } finally {
    harness.cleanup();
  }
}

async function runLiveMinVenueShareBumpScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowEndTs = activeWindowStartTs + windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {
      [activeSlug]: makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-min-share-bump",
        startTs: activeWindowStartTs,
        endTs: activeWindowEndTs
      })
    },
    readMode: "ok",
    executionMode: "accept"
  });
  try {
    harness.engineAny.config.polymarket.threshold.baseEdge = 0.01;
    harness.engineAny.config.polymarket.paper.minEdgeThreshold = 0.01;
    harness.engineAny.config.polymarket.paper.minNetEdge = 0.0001;
    harness.engineAny.config.polymarket.execution.takerPriceBuffer = 0;
    harness.engineAny.config.polymarket.sizing.minOrderNotional = 1;
    harness.engineAny.config.polymarket.sizing.maxNotionalPerWindow = 10;

    harness.engineAny.sizing.compute = () => ({
      notionalUsd: 0.2,
      shares: 0.41,
      kellyFraction: 0.01
    });

    let postedNotional = 0;
    harness.engineAny.execution.executeBuyYes = async (params: { notionalUsd: number }) => {
      postedNotional = Number(params.notionalUsd || 0);
      harness.state.executionAttempts += 1;
      return {
        action: "BUY_YES",
        accepted: true,
        filledShares: 1,
        fillPrice: 0.49,
        reason: "LIVE_ACCEPTED_TEST_STUB"
      };
    };

    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();

    assert(harness.state.executionAttempts === 1, `min-venue-share bump should still execute one trade, got ${String(harness.state.executionAttempts)}`);
    assert(postedNotional >= 2, `min-venue-share bump should increase notional meaningfully, got ${String(postedNotional)}`);
    assert(Number(runtime.finalShares || 0) >= 5, `runtime should expose bumped finalShares >= 5, got ${String(runtime.finalShares)}`);
    assert(runtime.sizeBumped === true, `runtime should mark sizeBumped=true, got ${String(runtime.sizeBumped)}`);
  } finally {
    harness.cleanup();
  }
}

async function runMinVenueShareRiskBlockedScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowEndTs = activeWindowStartTs + windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {
      [activeSlug]: makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-min-share-risk-blocked",
        startTs: activeWindowStartTs,
        endTs: activeWindowEndTs
      })
    },
    readMode: "ok",
    executionMode: "accept"
  });
  try {
    harness.engineAny.config.polymarket.threshold.baseEdge = 0.01;
    harness.engineAny.config.polymarket.paper.minEdgeThreshold = 0.01;
    harness.engineAny.config.polymarket.paper.minNetEdge = 0.0001;
    harness.engineAny.config.polymarket.execution.takerPriceBuffer = 0;
    harness.engineAny.config.polymarket.sizing.minOrderNotional = 1;
    harness.engineAny.config.polymarket.sizing.maxNotionalPerWindow = 10;

    harness.engineAny.sizing.compute = () => ({
      notionalUsd: 0.2,
      shares: 0.41,
      kellyFraction: 0.01
    });
    harness.engineAny.risk.checkNewOrder = () => ({ ok: false, reason: "MAX_EXPOSURE_REACHED" });

    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();

    assert(harness.state.executionAttempts === 0, `risk-blocked bumped order must not execute, got ${String(harness.state.executionAttempts)}`);
    assert(
      String(runtime.holdReason || runtime.blockedBy || "").includes("ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED"),
      `risk-blocked bumped order must expose ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED, got hold=${String(runtime.holdReason)} blockedBy=${String(runtime.blockedBy)}`
    );
  } finally {
    harness.cleanup();
  }
}

async function runNormalizedVenueErrorScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowEndTs = activeWindowStartTs + windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {
      [activeSlug]: makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-normalized-venue-error",
        startTs: activeWindowStartTs,
        endTs: activeWindowEndTs
      })
    },
    readMode: "ok",
    executionMode: "min_shares"
  });
  try {
    harness.engineAny.config.polymarket.threshold.baseEdge = 0.01;
    harness.engineAny.config.polymarket.paper.minEdgeThreshold = 0.01;
    harness.engineAny.config.polymarket.paper.minNetEdge = 0.0001;
    harness.engineAny.config.polymarket.execution.takerPriceBuffer = 0;
    harness.engineAny.config.polymarket.sizing.minOrderNotional = 0.1;

    harness.engineAny.sizing.compute = () => ({
      notionalUsd: 0.2,
      shares: 0.41,
      kellyFraction: 0.01
    });

    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();

    assert(
      String(runtime.holdReason || runtime.blockedBy || "").includes("ORDER_SIZE_BELOW_MIN_SHARES"),
      `venue min-share rejection should normalize hold reason, got hold=${String(runtime.holdReason)} blockedBy=${String(runtime.blockedBy)}`
    );
  } finally {
    harness.cleanup();
  }
}

async function runAdjacentDiscoveryFallbackScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowStartSec = Math.floor(activeWindowStartTs / 1000);
  const previousSlug = `btc-updown-5m-${activeWindowStartSec - 5 * 60}`;
  const activeSlug = `btc-updown-5m-${activeWindowStartSec}`;
  const nextSlug = `btc-updown-5m-${activeWindowStartSec + 5 * 60}`;
  const farNextSlug = `btc-updown-5m-${activeWindowStartSec + 2 * 5 * 60}`;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {},
    broadRows: [
      makeMarketRow({
        slug: previousSlug,
        marketId: "live-market-previous",
        startTs: activeWindowStartTs - windowMs,
        endTs: activeWindowStartTs
      }),
      makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-active",
        startTs: activeWindowStartTs,
        endTs: activeWindowStartTs + windowMs
      }),
      makeMarketRow({
        slug: nextSlug,
        marketId: "live-market-next",
        startTs: activeWindowStartTs + windowMs,
        endTs: activeWindowStartTs + 2 * windowMs
      }),
      makeMarketRow({
        slug: farNextSlug,
        marketId: "live-market-far-next",
        startTs: activeWindowStartTs + 2 * windowMs,
        endTs: activeWindowStartTs + 3 * windowMs
      })
    ],
    readMode: "degraded"
  });
  try {
    harness.engineAny.config.polymarket.live.minEntryRemainingSec = 1;
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();
    const truth = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(harness.engineAny.running === true, "adjacent fallback scenario must keep engine running");
    assert(runtime.status === "RUNNING", `adjacent fallback scenario should publish RUNNING status, got ${String(runtime.status)}`);
    assert(runtime.polyEngineRunning === true, "adjacent fallback scenario should publish running=true");
    assert(runtime.warningState === "NETWORK_ERROR", `adjacent fallback scenario should preserve degraded warningState, got ${String(runtime.warningState)}`);
    assert(runtime.selection.selectedSlug === activeSlug, `adjacent fallback discovery must promote the active slug immediately, got ${String(runtime.selection.selectedSlug)}`);
    assert(runtime.selection.windowsCount === 1, `adjacent fallback discovery must publish windowsCount=1, got ${String(runtime.selection.windowsCount)}`);
    assert(runtime.selection.discoveredCandidatesCount === 4, `adjacent fallback discovery must retain discovered candidates from the active scan, got ${String(runtime.selection.discoveredCandidatesCount)}`);
    assert(truth.poly.selection.selectedSlug === activeSlug, "truth must publish active fallback slug immediately");
    assert(truth.poly.warningState === "NETWORK_ERROR", "truth must still mark degraded read-path state during adjacent fallback");
  } finally {
    harness.cleanup();
  }
}

async function runSelectionCommitInvariantScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowStartSec = Math.floor(activeWindowStartTs / 1000);
  const activeWindowEndTs = activeWindowStartTs + windowMs;
  const currentSlug = `btc-updown-5m-${activeWindowStartSec}`;
  const nextSlug = `btc-updown-5m-${activeWindowStartSec + 5 * 60}`;
  const previousSlug = `btc-updown-5m-${activeWindowStartSec - 5 * 60}`;

  const currentRow = makeMarketRow({
    slug: currentSlug,
    marketId: "live-market-selection-commit-current",
    startTs: activeWindowStartTs,
    endTs: activeWindowEndTs
  });
  currentRow.eventSlug = "btc-up-or-down-next-5-minutes";

  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {
      [currentSlug]: currentRow,
      [nextSlug]: makeMarketRow({
        slug: nextSlug,
        marketId: "live-market-selection-commit-next",
        startTs: activeWindowEndTs,
        endTs: activeWindowEndTs + windowMs
      })
    },
    broadRows: [
      makeMarketRow({
        slug: previousSlug,
        marketId: "live-market-selection-commit-previous",
        startTs: activeWindowStartTs - windowMs,
        endTs: activeWindowStartTs
      }),
      currentRow,
      makeMarketRow({
        slug: nextSlug,
        marketId: "live-market-selection-commit-next",
        startTs: activeWindowEndTs,
        endTs: activeWindowEndTs + windowMs
      })
    ],
    readMode: "ok"
  });

  try {
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();
    const truth = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(Number(runtime.selection.windowsCount || 0) > 0, `selection invariant regression should keep windowsCount>0, got ${String(runtime.selection.windowsCount)}`);
    assert(Number(runtime.selection.discoveredCandidatesCount || 0) > 0, `selection invariant regression should keep candidatesCount>0, got ${String(runtime.selection.discoveredCandidatesCount)}`);
    assert(runtime.selection.selectedSlug === currentSlug, `selection invariant regression should commit current slug immediately, got ${String(runtime.selection.selectedSlug)}`);
    assert(runtime.selectedTokenId !== null, "selection invariant regression should commit selected token id");
    assert(
      String(runtime.holdReason || "") !== "SELECTION_NOT_COMMITTED",
      `selection invariant regression should not emit SELECTION_NOT_COMMITTED, got ${String(runtime.holdReason)}`
    );
    assert(
      String(runtime.liveValidationReason || "") !== "NON_CURRENT_OR_NEXT_WINDOW",
      `selection invariant regression should not misclassify current slug, got ${String(runtime.liveValidationReason)}`
    );
    assert(
      harness.engineAny.liveCommittedSelection?.selectedSlug === currentSlug,
      "selection invariant regression should commit liveCommittedSelection to current slug"
    );
    assert(
      truth.poly.selection.selectedSlug === currentSlug,
      `selection invariant regression truth should mirror committed slug, got ${String(truth.poly.selection.selectedSlug)}`
    );
  } finally {
    harness.cleanup();
  }
}

async function runLiveTruthProjectionAlignmentScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {},
    readMode: "ok"
  });
  try {
    let sawIntentionalHoldDecision = false;
    let polyStatusCount = 0;
    let truthCount = 0;
    const originalInfo = harness.engineAny.logger.info.bind(harness.engineAny.logger);
    harness.engineAny.logger.info = (...args: unknown[]) => {
      const text = String(args[1] ?? args[0] ?? "");
      if (
        text.includes("POLY_DECISION selectedSlug=") &&
        (text.includes("action=HOLD reason=MODEL_NOT_EXTREME") || text.includes("action=HOLD reason=NON_EXTREME_PRICE"))
      ) {
        sawIntentionalHoldDecision = true;
      }
      if (text.startsWith("POLY_STATUS ")) {
        polyStatusCount += 1;
      }
      if (text.startsWith("TRUTH ")) {
        truthCount += 1;
      }
      return originalInfo(...(args as [unknown, string?]));
    };
    harness.engineAny.maybeEmitTickLog({
      marketsSeen: 1,
      discoveredCandidates: 1,
      fetchedCount: 1,
      afterActiveCount: 1,
      afterSearchCount: 1,
      afterWindowCount: 1,
      afterPatternCount: 1,
      finalCandidatesCount: 1,
      activeWindows: 1,
      now: new Date(harness.state.mockedNow).toISOString(),
      currentMarketId: "live-market-truth",
      tauSec: 209,
      priceToBeat: 101,
      oracleEst: 101.2,
      sigma: 0.1,
      yesBid: 0.47,
      yesAsk: 0.49,
      yesMid: 0.48,
      pUpModel: 0.61,
      edge: 0.03,
      chosenSide: "YES",
      threshold: 0.26,
      action: "HOLD",
      holdReason: "MODEL_NOT_EXTREME",
      selectedSlug: activeSlug,
      windowStart: null,
      windowEnd: null,
      acceptingOrders: true,
      enableOrderBook: true
    });
    harness.engineAny.maybeEmitTickLog({
      marketsSeen: 1,
      discoveredCandidates: 1,
      fetchedCount: 1,
      afterActiveCount: 1,
      afterSearchCount: 1,
      afterWindowCount: 1,
      afterPatternCount: 1,
      finalCandidatesCount: 1,
      activeWindows: 1,
      now: new Date(harness.state.mockedNow + 1_000).toISOString(),
      currentMarketId: "live-market-truth",
      tauSec: 208,
      priceToBeat: 101,
      oracleEst: 101.2,
      sigma: 0.1,
      yesBid: 0.47,
      yesAsk: 0.49,
      yesMid: 0.48,
      pUpModel: 0.61,
      edge: 0.03,
      chosenSide: "YES",
      threshold: 0.26,
      action: "HOLD",
      holdReason: "MODEL_NOT_EXTREME",
      selectedSlug: activeSlug,
      windowStart: null,
      windowEnd: null,
      acceptingOrders: true,
      enableOrderBook: true
    });
    harness.engineAny.maybeEmitTickLog({
      marketsSeen: 0,
      discoveredCandidates: 0,
      fetchedCount: 0,
      afterActiveCount: 0,
      afterSearchCount: 0,
      afterWindowCount: 0,
      afterPatternCount: 0,
      finalCandidatesCount: 0,
      activeWindows: 0,
      now: new Date(harness.state.mockedNow + 45_000).toISOString(),
      currentMarketId: null,
      tauSec: null,
      priceToBeat: null,
      oracleEst: 101.2,
      sigma: 0.1,
      yesBid: null,
      yesAsk: null,
      yesMid: null,
      pUpModel: null,
      edge: null,
      threshold: null,
      action: "HOLD",
      holdReason: "NON_EXTREME_PRICE",
      selectedSlug: null,
      windowStart: null,
      windowEnd: null,
      warningState: "DISCOVERY_STALE",
      lastFetchOkTs: harness.state.mockedNow - 45_000,
      acceptingOrders: true,
      enableOrderBook: true
    });
    harness.state.mockedNow += 45_000;
    const runtime = harness.engine.getDashboardSnapshot();
    const truth = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(runtime.selection.selectedSlug === activeSlug, `runtime should keep selectedSlug aligned with POLY_STATUS, got ${String(runtime.selection.selectedSlug)}`);
    assert(
      Number(runtime.selection.remainingSec) >= 164 && Number(runtime.selection.remainingSec) <= 165,
      `runtime should keep remainingSec estimated from the persisted snapshot, got ${String(runtime.selection.remainingSec)}`
    );
    assert(runtime.selection.chosenSide === "YES", `runtime should keep chosenSide aligned with POLY_STATUS, got ${String(runtime.selection.chosenSide)}`);
    assert(runtime.selection.chosenDirection === "UP", `runtime should derive direction from chosenSide, got ${String(runtime.selection.chosenDirection)}`);
    assert(runtime.whyNotTrading === "NON_EXTREME_PRICE", `runtime should expose whyNotTrading from the persisted snapshot, got ${String(runtime.whyNotTrading)}`);
    assert(runtime.currentMarketStatus === "DEGRADED", `runtime should expose currentMarketStatus DEGRADED during stale discovery, got ${String(runtime.currentMarketStatus)}`);
    assert(truth.poly.selection.selectedSlug === activeSlug, `truth should keep selectedSlug aligned with POLY_STATUS, got ${String(truth.poly.selection.selectedSlug)}`);
    assert(
      Number(truth.poly.selection.remainingSec) >= 164 && Number(truth.poly.selection.remainingSec) <= 165,
      `truth should keep remainingSec estimated from the persisted snapshot, got ${String(truth.poly.selection.remainingSec)}`
    );
    assert(truth.poly.selection.chosenSide === "YES", `truth should keep chosenSide aligned with POLY_STATUS, got ${String(truth.poly.selection.chosenSide)}`);
    assert(truth.poly.selection.chosenDirection === "UP", `truth should derive direction from chosenSide, got ${String(truth.poly.selection.chosenDirection)}`);
    assert(truth.poly.whyNotTrading === "NON_EXTREME_PRICE", `truth should expose whyNotTrading from the persisted snapshot, got ${String(truth.poly.whyNotTrading)}`);
    assert(truth.poly.currentMarketStatus === "DEGRADED", `truth should expose currentMarketStatus DEGRADED during stale discovery, got ${String(truth.poly.currentMarketStatus)}`);
    assert(String(runtime.warningState || "").includes("DISCOVERY_STALE"), `runtime should preserve the selected window and mark discovery stale, got ${String(runtime.warningState)}`);
    assert(String(truth.poly.warningState || "").includes("DISCOVERY_STALE"), `truth should preserve the selected window and mark discovery stale, got ${String(truth.poly.warningState)}`);
    assert(String(runtime.statusLine || "").includes(activeSlug), `runtime should expose a compact statusLine, got ${String(runtime.statusLine)}`);
    assert(String(runtime.statusLine || "").includes("HOLD NON_EXTREME_PRICE"), `runtime should expose the persisted HOLD reason in the compact statusLine, got ${String(runtime.statusLine)}`);
    assert(sawIntentionalHoldDecision, "selected HOLD cycle should emit a compact intentional decision line");
    assert(polyStatusCount === 2, `state changes should re-emit POLY_STATUS exactly once, got ${String(polyStatusCount)}`);
    assert(
      truthCount >= 2 && truthCount <= 3,
      `state changes should re-emit TRUTH on meaningful state change, got ${String(truthCount)}`
    );
  } finally {
    harness.cleanup();
  }
}

async function runExpiredWindowPendingDiscoveryScenario(): Promise<void> {
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / (5 * 60 * 1000)) * 5 * 60 * 1000;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 120_000,
    marketRowsBySlug: {},
    readMode: "ok",
    discoveryMode: "ok"
  });
  try {
    harness.engineAny.maybeEmitTickLog({
      marketsSeen: 1,
      discoveredCandidates: 1,
      fetchedCount: 1,
      afterActiveCount: 1,
      afterSearchCount: 1,
      afterWindowCount: 1,
      afterPatternCount: 1,
      finalCandidatesCount: 1,
      activeWindows: 1,
      now: new Date(harness.state.mockedNow).toISOString(),
      currentMarketId: "live-market-rollover-pending",
      tauSec: 2,
      priceToBeat: 101,
      oracleEst: 101.4,
      sigma: 0.1,
      yesBid: 0.48,
      yesAsk: 0.49,
      yesMid: 0.485,
      pUpModel: 0.61,
      edge: 0.02,
      chosenSide: "YES",
      threshold: 0.26,
      action: "HOLD",
      holdReason: "NON_EXTREME_PRICE",
      selectedSlug: activeSlug,
      windowStart: null,
      windowEnd: null,
      acceptingOrders: true,
      enableOrderBook: true
    });
    harness.state.mockedNow += 5_000;
    harness.engineAny.maybeEmitTickLog({
      marketsSeen: 0,
      discoveredCandidates: 0,
      fetchedCount: 0,
      afterActiveCount: 0,
      afterSearchCount: 0,
      afterWindowCount: 0,
      afterPatternCount: 0,
      finalCandidatesCount: 0,
      activeWindows: 0,
      now: new Date(harness.state.mockedNow).toISOString(),
      currentMarketId: null,
      tauSec: null,
      priceToBeat: null,
      oracleEst: 101.5,
      sigma: 0.1,
      yesBid: null,
      yesAsk: null,
      yesMid: null,
      pUpModel: null,
      edge: null,
      threshold: null,
      action: "HOLD",
      holdReason: "EXPIRED_WINDOW",
      selectedSlug: null,
      windowStart: null,
      windowEnd: null,
      warningState: "DISCOVERY_STALE",
      lastFetchOkTs: harness.state.mockedNow - 35_000,
      acceptingOrders: true,
      enableOrderBook: true
    });

    const runtime = harness.engine.getDashboardSnapshot();
    const truth = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(runtime.currentMarketSlug === activeSlug, `expired pending runtime should preserve currentMarketSlug, got ${String(runtime.currentMarketSlug)}`);
    assert(
      Number.isFinite(Number(runtime.currentMarketRemainingSec)) && Number(runtime.currentMarketRemainingSec) >= 0,
      `expired pending runtime should keep a non-negative currentMarketRemainingSec, got ${String(runtime.currentMarketRemainingSec)}`
    );
    assert(Number(runtime.currentMarketExpiresAt || 0) > 0, `expired pending runtime should expose currentMarketExpiresAt, got ${String(runtime.currentMarketExpiresAt)}`);
    assert(
      runtime.currentMarketStatus === "ROLLOVER_PENDING" ||
        runtime.currentMarketStatus === "EXPIRED_PENDING_DISCOVERY" ||
        runtime.currentMarketStatus === "EXPIRED_WINDOW" ||
        runtime.currentMarketStatus === "RUNNING",
      `expired pending runtime should expose rollover status, got ${String(runtime.currentMarketStatus)}`
    );
    assert(
      runtime.whyNotTrading === null ||
        runtime.whyNotTrading === "AWAITING_NEXT_MARKET_DISCOVERY" ||
        runtime.whyNotTrading === "EXPIRED_WINDOW",
      `expired pending runtime should explain whyNotTrading, got ${String(runtime.whyNotTrading)}`
    );
    assert(truth.poly.currentMarketSlug === activeSlug, `expired pending truth should preserve currentMarketSlug, got ${String(truth.poly.currentMarketSlug)}`);
    assert(
      Number.isFinite(Number(truth.poly.currentMarketRemainingSec)) && Number(truth.poly.currentMarketRemainingSec) >= 0,
      `expired pending truth should keep a non-negative currentMarketRemainingSec, got ${String(truth.poly.currentMarketRemainingSec)}`
    );
    assert(
      truth.poly.whyNotTrading === "AWAITING_NEXT_MARKET_DISCOVERY" || truth.poly.whyNotTrading === "EXPIRED_WINDOW",
      `expired pending truth should explain whyNotTrading, got ${String(truth.poly.whyNotTrading)}`
    );
  } finally {
    harness.cleanup();
  }
}

async function runStartupWithCachedUsableWindowScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowEndTs = activeWindowStartTs + windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {},
    readMode: "degraded",
    discoveryMode: "timeout",
    initialLastFetchOkTs: activeWindowStartTs + 30_000
  });
  try {
    harness.engineAny.lastUsableLiveSelectedMarket = {
      marketId: "live-market-cached",
      slug: activeSlug,
      eventSlug: activeSlug,
      question: "Will Bitcoin be above $101.00 in the next 5 minutes?",
      startTs: activeWindowStartTs,
      endTs: activeWindowEndTs,
      priceToBeat: 101,
      yesTokenId: "live-market-cached-yes",
      noTokenId: "live-market-cached-no",
      yesDisplayLabel: "UP",
      noDisplayLabel: "DOWN",
      acceptingOrders: true,
      enableOrderBook: true
    };

    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();
    const truth = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(harness.engineAny.runtimeStartupState === "RUNNING_DEGRADED", `cached startup should leave STARTING as RUNNING_DEGRADED, got ${String(harness.engineAny.runtimeStartupState)}`);
    assert(runtime.status === "RUNNING", `cached startup should exit STARTING into RUNNING, got ${String(runtime.status)}`);
    assert(runtime.polyEngineRunning === true, "cached startup should publish running=true");
    assert(runtime.warningState === "NETWORK_ERROR", `cached startup should surface degraded warning, got ${String(runtime.warningState)}`);
    assert(
      runtime.selection.selectedSlug === null,
      `cached startup must not keep a stale cached selected slug without live tradability, got ${String(runtime.selection.selectedSlug)}`
    );
    assert(
      runtime.holdReason === "STARTUP_INCOMPLETE_NO_USABLE_WINDOW" ||
        runtime.holdReason === "NO_ACTIVE_BTC5M_MARKET" ||
        runtime.holdReason === "NO_ACTIVE_WINDOWS",
      `cached startup should hold with no active tradable market, got ${String(runtime.holdReason)}`
    );
    assert(
      truth.poly.selection.selectedSlug === null,
      `truth must not mirror stale cached selected slug without live tradability, got ${String(truth.poly.selection.selectedSlug)}`
    );
  } finally {
    harness.cleanup();
  }
}

async function runStartupWithNoUsableWindowScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {},
    readMode: "degraded",
    discoveryMode: "timeout"
  });
  try {
    let sawStartupWatchdog = false;
    const originalWarn = harness.engineAny.logger.warn.bind(harness.engineAny.logger);
    harness.engineAny.logger.warn = (...args: unknown[]) => {
      if (String(args[1] ?? args[0] ?? "").includes("POLY_STARTUP_WATCHDOG")) {
        sawStartupWatchdog = true;
      }
      return originalWarn(...(args as [unknown, string?]));
    };
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();
    const truth = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(harness.engineAny.runtimeStartupState === "HOLD_NO_ACTIVE_BTC5M_MARKET", `no-window startup should leave STARTING as HOLD_NO_ACTIVE_BTC5M_MARKET, got ${String(harness.engineAny.runtimeStartupState)}`);
    assert(runtime.status === "RUNNING", `no-window startup should exit STARTING, got ${String(runtime.status)}`);
    assert(runtime.polyEngineRunning === true, "no-window startup should still publish running=true");
    assert(runtime.holdReason === "STARTUP_INCOMPLETE_NO_USABLE_WINDOW", `no-window startup should settle into explicit startup HOLD, got ${String(runtime.holdReason)}`);
    assert(runtime.selection.selectedSlug === null, `no-window startup should not keep a selected slug, got ${String(runtime.selection.selectedSlug)}`);
    assert(runtime.selection.windowsCount === 0, `no-window startup should publish windowsCount=0, got ${String(runtime.selection.windowsCount)}`);
    assert(runtime.selection.discoveredCandidatesCount === 0, `no-window startup should publish candidatesCount=0, got ${String(runtime.selection.discoveredCandidatesCount)}`);
    assert(
      runtime.pollMode === "DISCOVERY_STALE" || runtime.pollMode === "NORMAL" || runtime.pollMode === "VERY_FAST",
      `no-window startup should expose NORMAL, DISCOVERY_STALE, or VERY_FAST pollMode, got ${String(runtime.pollMode)}`
    );
    assert(truth.poly.status === "RUNNING", `truth should exit STARTING for no-window degraded startup, got ${String(truth.poly.status)}`);
    assert(truth.poly.holdReason === "STARTUP_INCOMPLETE_NO_USABLE_WINDOW", `truth should report explicit startup hold state, got ${String(truth.poly.holdReason)}`);
    assert(truth.poly.selection.selectedSlug === null, `truth should stay empty without usable startup window, got ${String(truth.poly.selection.selectedSlug)}`);
    assert(truth.poly.selection.windowsCount === 0, `truth should publish windowsCount=0, got ${String(truth.poly.selection.windowsCount)}`);
    assert(truth.poly.selection.discoveredCandidatesCount === 0, `truth should publish candidatesCount=0, got ${String(truth.poly.selection.discoveredCandidatesCount)}`);
    assert(
      truth.poly.pollMode === "DISCOVERY_STALE" || truth.poly.pollMode === "NORMAL" || truth.poly.pollMode === "VERY_FAST",
      `truth should expose NORMAL, DISCOVERY_STALE, or VERY_FAST pollMode, got ${String(truth.poly.pollMode)}`
    );
    assert(sawStartupWatchdog, "no-window startup should emit POLY_STARTUP_WATCHDOG");
  } finally {
    harness.cleanup();
  }
}

async function runPreorderValidationGuardScenarios(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const previousWindowStartTs = activeWindowStartTs - windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const previousSlug = `btc-updown-5m-${Math.floor(previousWindowStartTs / 1000)}`;

  const staleSelectionHarness = buildHarness({
    mockedNow: activeWindowStartTs + 100_000,
    marketRowsBySlug: {
      [activeSlug]: makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-preorder-current",
        startTs: activeWindowStartTs,
        endTs: activeWindowStartTs + windowMs
      }),
      [previousSlug]: makeMarketRow({
        slug: previousSlug,
        marketId: "live-market-preorder-previous",
        startTs: previousWindowStartTs,
        endTs: activeWindowStartTs
      })
    },
    readMode: "ok"
  });
  try {
    const staleSelectionValidation = await staleSelectionHarness.engineAny.validateLiveExecutionCandidate({
      nowTs: staleSelectionHarness.state.mockedNow,
      market: {
        marketId: "live-market-preorder-previous",
        slug: previousSlug,
        eventSlug: previousSlug,
        question: "Will Bitcoin be above $101.00 in the next 5 minutes?",
        startTs: previousWindowStartTs,
        endTs: activeWindowStartTs,
        priceToBeat: 101,
        yesTokenId: "live-market-preorder-previous-yes",
        noTokenId: "live-market-preorder-previous-no",
        yesDisplayLabel: "UP",
        noDisplayLabel: "DOWN",
        acceptingOrders: true,
        enableOrderBook: true
      },
      chosenSide: "YES"
    });
    assert(staleSelectionValidation.valid === false, "stale selected slug should fail preorder validation");
    assert(
      staleSelectionValidation.reason === "stale_market_selection" || staleSelectionValidation.reason === "expired_window",
      `stale selected slug should fail with stale/expired reason, got ${String(staleSelectionValidation.reason)}`
    );
  } finally {
    staleSelectionHarness.cleanup();
  }

  const staleTokenHarness = buildHarness({
    mockedNow: activeWindowStartTs + 100_000,
    marketRowsBySlug: {
      [activeSlug]: makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-preorder-token",
        startTs: activeWindowStartTs,
        endTs: activeWindowStartTs + windowMs
      })
    },
    readMode: "ok"
  });
  try {
    staleTokenHarness.engineAny.liveCommittedSelection = {
      selectedSlug: activeSlug,
      selectedMarketId: "live-market-preorder-token",
      selectedEpoch: Math.floor(activeWindowStartTs / 1000),
      windowStartTs: activeWindowStartTs,
      windowEndTs: activeWindowStartTs + windowMs,
      chosenDirection: "UP",
      chosenSide: "YES",
      yesTokenId: "stale-yes-token-id",
      noTokenId: "live-market-preorder-token-no",
      acceptingOrders: true,
      enableOrderBook: true,
      selectedReason: "test_stale_token",
      holdReason: null,
      warningState: null,
      executionBlockedReason: null,
      executionBlockedSide: null
    };
    const staleTokenValidation = await staleTokenHarness.engineAny.validateLiveExecutionCandidate({
      nowTs: staleTokenHarness.state.mockedNow,
      market: {
        marketId: "live-market-preorder-token",
        slug: activeSlug,
        eventSlug: activeSlug,
        question: "Will Bitcoin be above $101.00 in the next 5 minutes?",
        startTs: activeWindowStartTs,
        endTs: activeWindowStartTs + windowMs,
        priceToBeat: 101,
        yesTokenId: "stale-yes-token-id",
        noTokenId: "live-market-preorder-token-no",
        yesDisplayLabel: "UP",
        noDisplayLabel: "DOWN",
        acceptingOrders: true,
        enableOrderBook: true
      },
      chosenSide: "YES"
    });
    assert(staleTokenValidation.valid === false, "stale token ids should fail preorder validation");
    assert(
      staleTokenValidation.reason === "stale_token_ids",
      `stale token ids should fail with stale_token_ids, got ${String(staleTokenValidation.reason)}`
    );
  } finally {
    staleTokenHarness.cleanup();
  }

  const lowRemainingHarness = buildHarness({
    mockedNow: activeWindowStartTs + windowMs - 10_000,
    marketRowsBySlug: {
      [activeSlug]: makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-preorder-low-remaining",
        startTs: activeWindowStartTs,
        endTs: activeWindowStartTs + windowMs
      })
    },
    readMode: "ok"
  });
  try {
    const lowRemainingValidation = await lowRemainingHarness.engineAny.validateLiveExecutionCandidate({
      nowTs: lowRemainingHarness.state.mockedNow,
      market: {
        marketId: "live-market-preorder-low-remaining",
        slug: activeSlug,
        eventSlug: activeSlug,
        question: "Will Bitcoin be above $101.00 in the next 5 minutes?",
        startTs: activeWindowStartTs,
        endTs: activeWindowStartTs + windowMs,
        priceToBeat: 101,
        yesTokenId: "live-market-preorder-low-remaining-yes",
        noTokenId: "live-market-preorder-low-remaining-no",
        yesDisplayLabel: "UP",
        noDisplayLabel: "DOWN",
        acceptingOrders: true,
        enableOrderBook: true
      },
      chosenSide: "YES"
    });
    assert(lowRemainingValidation.valid === false, "low-remaining market should fail preorder validation");
    assert(
      lowRemainingValidation.reason === "remaining_below_threshold",
      `low-remaining market should fail with remaining_below_threshold, got ${String(lowRemainingValidation.reason)}`
    );
  } finally {
    lowRemainingHarness.cleanup();
  }
}

async function runMissingOrderbookExecutionBlockedScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowEndTs = activeWindowStartTs + windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {
      [activeSlug]: makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-missing-no-book",
        startTs: activeWindowStartTs,
        endTs: activeWindowEndTs,
        priceToBeat: 200_000
      })
    },
    readMode: "ok",
    missingNoTokenIds: ["live-market-missing-no-book-no"],
    missingQuoteTokenIds: ["live-market-missing-no-book-no"]
  });
  try {
    harness.engineAny.client.getTokenPriceQuote = async (tokenId: string) => {
      if (String(tokenId || "").endsWith("-no")) {
        throw new Error("No orderbook exists for the requested token id");
      }
      if (String(tokenId || "").endsWith("-yes")) {
        return {
          tokenId,
          price: 0.9,
          bestBid: 0.89,
          bestAsk: 0.91,
          mid: 0.9,
          ts: harness.state.mockedNow,
          source: "clob_price" as const,
          fetchFailed: false,
          failedSides: []
        };
      }
      return {
        tokenId,
        price: 0.08,
        bestBid: 0.07,
        bestAsk: 0.09,
        mid: 0.08,
        ts: harness.state.mockedNow,
        source: "clob_price" as const,
        fetchFailed: false,
        failedSides: []
      };
    };
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();
    const truth = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(runtime.status === "RUNNING", `missing-orderbook startup should exit STARTING, got ${String(runtime.status)}`);
    assert(runtime.polyEngineRunning === true, "missing-orderbook startup should still publish running=true");
    assert(
      runtime.selection.selectedSlug === activeSlug,
      `missing-orderbook candidate should stay visible while blocked, got ${String(runtime.selection.selectedSlug)}`
    );
    assert(runtime.selection.windowsCount === 1, `selector invariant scenario should still report windowsCount=1, got ${String(runtime.selection.windowsCount)}`);
    assert(
      runtime.holdReason === "SIDE_NOT_BOOKABLE" || runtime.holdReason === "MISSING_ORDERBOOK",
      `runtime must expose SIDE_NOT_BOOKABLE/MISSING_ORDERBOOK when the selected token cannot be traded, got ${String(runtime.holdReason)}`
    );
    assert(
      runtime.selectedTradable === false && runtime.selectedBookable === false,
      "missing-orderbook candidate must publish selectedTradable=false and selectedBookable=false"
    );
    assert(
      String(runtime.liveValidationReason || "").toUpperCase().includes("MISSING_ORDERBOOK"),
      `runtime should preserve root validation reason for selector bug diagnostics, got ${String(runtime.liveValidationReason)}`
    );
    assert(
      String(runtime.state.dominantReject || "").toUpperCase().includes("MISSING_ORDERBOOK"),
      `missing-orderbook candidate should publish explicit missing-orderbook dominantReject, got ${String(runtime.state.dominantReject)}`
    );
    assert(
      harness.engineAny.liveCommittedSelection?.selectedSlug === activeSlug,
      "missing-orderbook candidate should remain committed as context while execution stays blocked"
    );
    assert(
      harness.engineAny.liveCommittedSelection?.selectedTokenId == null,
      "missing-orderbook candidate should not keep an executable selectedTokenId"
    );
    assert(truth.poly.selection.selectedSlug === activeSlug, `truth should mirror selected slug while blocked, got ${String(truth.poly.selection.selectedSlug)}`);
    assert(
      truth.poly.holdReason === "SIDE_NOT_BOOKABLE" || truth.poly.holdReason === "MISSING_ORDERBOOK",
      `truth must expose selected-side bookability failure, got ${String(truth.poly.holdReason)}`
    );
  } finally {
    harness.cleanup();
  }
}

async function runPriceFetchFailureSelectionPersistenceScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowEndTs = activeWindowStartTs + windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {
      [activeSlug]: makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-price-fail",
        startTs: activeWindowStartTs,
        endTs: activeWindowEndTs
      })
    },
    readMode: "ok"
  });
  try {
    harness.engineAny.client.getTokenPriceQuote = async () => {
      throw Object.assign(new Error("HTTP 400 Invalid side"), { status: 400 });
    };
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();
    const truth = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(runtime.selection.selectedSlug === activeSlug, `price quote failure should keep selected slug visible, got ${String(runtime.selection.selectedSlug)}`);
    assert(
      runtime.holdReason === "PRICE_FETCH_FAILED" ||
        runtime.holdReason === "PRICE_REFRESH_FAILED_ACTIVE_MARKET" ||
        runtime.holdReason === "REFRESH_FAILED_ACTIVE_MARKET" ||
        runtime.holdReason === "SIDE_NOT_BOOKABLE",
      `price quote failure should hold as a data-health execution block, got ${String(runtime.holdReason)}`
    );
    assert(truth.poly.selection.selectedSlug === activeSlug, `truth should keep selected slug visible on quote failure, got ${String(truth.poly.selection.selectedSlug)}`);
    assert(
      truth.poly.holdReason === "PRICE_FETCH_FAILED" ||
        truth.poly.holdReason === "PRICE_REFRESH_FAILED_ACTIVE_MARKET" ||
        truth.poly.holdReason === "REFRESH_FAILED_ACTIVE_MARKET" ||
        truth.poly.holdReason === "SIDE_NOT_BOOKABLE",
      `truth should hold as a data-health execution block, got ${String(truth.poly.holdReason)}`
    );
  } finally {
    harness.cleanup();
  }
}

async function runStrategyParityScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowEndTs = activeWindowStartTs + windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {
      [activeSlug]: makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-parity",
        startTs: activeWindowStartTs,
        endTs: activeWindowEndTs
      })
    },
    readMode: "ok",
    executionMode: "accept"
  });
  try {
    harness.engineAny.config.polymarket.threshold.baseEdge = 0.01;
    harness.engineAny.config.polymarket.paper.minEdgeThreshold = 0.01;
    harness.engineAny.config.polymarket.paper.minNetEdge = 0.01;

    harness.engineAny.execution.getPositions = () => [];
    harness.engineAny.execution.getTotalExposureUsd = () => 0;
    harness.engineAny.execution.getConcurrentWindows = () => 0;
    harness.engineAny.execution.getOpenOrderCount = () => 0;

    let statusLine = "";
    const originalInfo = harness.engineAny.logger.info.bind(harness.engineAny.logger);
    harness.engineAny.logger.info = (...args: unknown[]) => {
      const text = String(args[1] ?? args[0] ?? "");
      if (text.startsWith("POLY_STATUS ")) statusLine = text;
      return originalInfo(...(args as [unknown, string?]));
    };

    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();
    const truth = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(harness.state.executionAttempts === 1, `parity scenario should attempt one live execution, got ${String(harness.state.executionAttempts)}`);
    assert(runtime.selection.selectedSlug === activeSlug, `parity scenario should keep the selected slug, got ${String(runtime.selection.selectedSlug)}`);
    assert(runtime.selection.chosenSide === "YES", `parity scenario should choose YES, got ${String(runtime.selection.chosenSide)}`);
    assert(runtime.whyNotTrading === null, `parity scenario should not report a hold reason after an accepted trade, got ${String(runtime.whyNotTrading)}`);
    assert(
      !String(runtime.holdReason || "").includes("SIZE_BELOW_MIN_NOTIONAL"),
      `parity scenario should not emit false SIZE_BELOW_MIN_NOTIONAL, got ${String(runtime.holdReason)}`
    );
    assert(
      String(runtime.selectedTokenId || "").length > 0 && Number(runtime.selection.remainingSec || 0) > 0,
      "runtime should immediately expose selectedTokenId and remainingSec from committed selection"
    );
    assert(
      truth.poly.selection.selectedSlug === activeSlug &&
        String(truth.poly.selectedTokenId || "").length > 0 &&
        Number(truth.poly.selection.remainingSec || 0) > 0,
      "truth should immediately expose selected slug/token/remaining from committed selection"
    );
    assert(statusLine.includes("blockedBy=-"), `status line should show no blocker for parity trade, got ${statusLine}`);

    harness.state.mockedNow += 2_000;
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtimeSecond = harness.engine.getDashboardSnapshot();
    assert(
      harness.state.executionAttempts >= 2,
      `committed live market should allow repeated in-window evaluations, got ${String(harness.state.executionAttempts)} attempts`
    );
    assert(
      runtimeSecond.selection.selectedSlug === activeSlug,
      `repeated in-window evaluation should keep the same committed market, got ${String(runtimeSecond.selection.selectedSlug)}`
    );
  } finally {
    harness.cleanup();
  }
}

async function runRolloverExpectedCurrentPromotionScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const currentWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const previousWindowStartTs = currentWindowStartTs - windowMs;
  const currentWindowEndTs = currentWindowStartTs + windowMs;
  const previousSlug = `btc-updown-5m-${Math.floor(previousWindowStartTs / 1000)}`;
  const currentSlug = `btc-updown-5m-${Math.floor(currentWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: currentWindowStartTs + 20_000,
    marketRowsBySlug: {
      [currentSlug]: makeMarketRow({
        slug: currentSlug,
        marketId: "live-market-rollover-current",
        startTs: currentWindowStartTs,
        endTs: currentWindowEndTs
      })
    },
    readMode: "ok",
    discoveryMode: "timeout"
  });
  try {
    let sawDiscoveryCycle = false;
    let sawRolloverLine = false;
    const originalInfo = harness.engineAny.logger.info.bind(harness.engineAny.logger);
    harness.engineAny.logger.info = (...args: unknown[]) => {
      const text = String(args[1] ?? args[0] ?? "");
      if (text.includes("POLY_BTC5M_DISCOVERY_CYCLE")) sawDiscoveryCycle = true;
      if (text.startsWith("DISCOVERY_ROLLOVER ")) sawRolloverLine = true;
      return originalInfo(...(args as [unknown, string?]));
    };

    harness.engineAny.liveCommittedSelection = {
      selectedSlug: previousSlug,
      selectedMarketId: "live-market-rollover-previous",
      windowStartTs: previousWindowStartTs,
      windowEndTs: currentWindowStartTs,
      chosenDirection: "UP",
      chosenSide: "YES",
      yesTokenId: "live-market-rollover-previous-yes",
      noTokenId: "live-market-rollover-previous-no",
      acceptingOrders: true,
      enableOrderBook: true,
      selectedReason: "btc5m_previous_window",
      executionBlockedReason: null,
      executionBlockedSide: null
    };
    harness.engineAny.lastUsableLiveSelectedMarket = {
      marketId: "live-market-rollover-previous",
      slug: previousSlug,
      eventSlug: previousSlug,
      question: "Will Bitcoin be above $101.00 in the next 5 minutes?",
      startTs: previousWindowStartTs,
      endTs: currentWindowStartTs,
      priceToBeat: 101,
      yesTokenId: "live-market-rollover-previous-yes",
      noTokenId: "live-market-rollover-previous-no",
      yesDisplayLabel: "UP",
      noDisplayLabel: "DOWN",
      acceptingOrders: true,
      enableOrderBook: true
    };

    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtimeDuringLag = harness.engine.getDashboardSnapshot();
    const truthDuringLag = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(runtimeDuringLag.selection.selectedSlug === currentSlug, `rollover lag should immediately promote expected current slug, got ${String(runtimeDuringLag.selection.selectedSlug)}`);
    assert(runtimeDuringLag.selection.selectedMarketId === null, "rollover lag should surface current slug before market confirmation");
    assert(Number(runtimeDuringLag.selection.remainingSec || 0) > 0, `rollover lag should keep positive remainingSec, got ${String(runtimeDuringLag.selection.remainingSec)}`);
    assert(runtimeDuringLag.pollMode === "NORMAL", `rollover lag should expose live pollMode NORMAL, got ${String(runtimeDuringLag.pollMode)}`);
    assert(runtimeDuringLag.selection.lifecycleStatus === "NORMAL", `rollover lag should mirror pollMode through lifecycleStatus, got ${String(runtimeDuringLag.selection.lifecycleStatus)}`);
    assert(truthDuringLag.poly.selection.selectedSlug === currentSlug, `truth should immediately publish expected current slug, got ${String(truthDuringLag.poly.selection.selectedSlug)}`);
    assert(Number(truthDuringLag.poly.selection.remainingSec || 0) > 0, `truth should keep positive remainingSec during rollover lag, got ${String(truthDuringLag.poly.selection.remainingSec)}`);
    assert(truthDuringLag.poly.pollMode === "NORMAL", `truth should expose live pollMode NORMAL, got ${String(truthDuringLag.poly.pollMode)}`);
    assert(harness.engineAny.liveCommittedSelection?.selectedSlug === currentSlug, "committed live selection should move to the expected current slug at rollover");
    assert(harness.state.slugLookups.length === 3, `rollover lookup cycle must only try current/next/previous-diagnostic, got ${String(harness.state.slugLookups.length)}`);
    assert(harness.state.slugLookups[0] === currentSlug, `rollover lookup order must try current bucket first, got ${String(harness.state.slugLookups[0])}`);
    assert(harness.state.slugLookups[1] === `btc-updown-5m-${Math.floor(currentWindowEndTs / 1000)}`, `rollover lookup order must try next bucket second, got ${String(harness.state.slugLookups[1])}`);
    assert(harness.state.slugLookups[2] === previousSlug, `rollover lookup order must relegate previous bucket to diagnostics third, got ${String(harness.state.slugLookups[2])}`);
    assert(!harness.state.searchLookups.includes(previousSlug), "rollover search fallback must not derive from previous selected slug");
    assert(!sawDiscoveryCycle, "rollover should suppress verbose discovery-cycle logs");
    assert(sawRolloverLine, "rollover should emit a compact DISCOVERY_ROLLOVER line");

    harness.state.discoveryMode = "ok";
    harness.state.readMode = "ok";
    harness.state.executionMode = "invalid_signature";
    harness.state.mockedNow += 2_000;
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtimeBookLag = harness.engine.getDashboardSnapshot();
    const truthBookLag = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(runtimeBookLag.selection.selectedSlug === currentSlug, "delayed book confirmation must keep the current slug selected");
    assert(runtimeBookLag.selection.selectedMarketId === "live-market-rollover-current", "confirmed discovery should attach the current market id");
    assert(truthBookLag.poly.selection.selectedSlug === currentSlug, "truth should keep the current slug during delayed book confirmation");
    assert(truthBookLag.poly.holdReason === "INVALID_SIGNATURE", `truth should surface invalid signature as an infrastructure hold while keeping the current slug, got ${String(truthBookLag.poly.holdReason)}`);
  } finally {
    harness.cleanup();
  }
}

async function runFastDiscoveryPollModeScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowEndTs = activeWindowStartTs + windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: activeWindowEndTs - 18_000,
    marketRowsBySlug: {
      [activeSlug]: makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-fast-discovery",
        startTs: activeWindowStartTs,
        endTs: activeWindowEndTs
      })
    },
    readMode: "ok"
  });
  try {
    harness.engineAny.config.polymarket.live.minEntryRemainingSec = 1;
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();
    const truth = harness.truth.getSnapshot(harness.state.mockedNow);
    const loopWaitMs = harness.engineAny.getLoopWaitMs(harness.state.mockedNow);

    assert(runtime.pollMode === "VERY_FAST", `runtime should switch to VERY_FAST near expiry, got ${String(runtime.pollMode)}`);
    assert(runtime.selection.lifecycleStatus === "VERY_FAST", `runtime should mirror fast pollMode in lifecycleStatus, got ${String(runtime.selection.lifecycleStatus)}`);
    assert(truth.poly.pollMode === "VERY_FAST", `truth should mirror fast pollMode, got ${String(truth.poly.pollMode)}`);
    assert(loopWaitMs <= 1_000, `fast discovery poll mode should clamp loop wait to <=1s, got ${String(loopWaitMs)}`);
  } finally {
    harness.cleanup();
  }
}

async function runImmediateRolloverPromotionScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const currentWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const nextWindowStartTs = currentWindowStartTs + windowMs;
  const currentWindowEndTs = currentWindowStartTs + windowMs;
  const nextWindowEndTs = nextWindowStartTs + windowMs;
  const currentSlug = `btc-updown-5m-${Math.floor(currentWindowStartTs / 1000)}`;
  const nextSlug = `btc-updown-5m-${Math.floor(nextWindowStartTs / 1000)}`;
  const marketRowsBySlug: Record<string, Record<string, unknown>> = {
    [currentSlug]: makeMarketRow({
      slug: currentSlug,
      marketId: "live-market-rollover-current-promote",
      startTs: currentWindowStartTs,
      endTs: currentWindowEndTs
    }),
    [nextSlug]: makeMarketRow({
      slug: nextSlug,
      marketId: "live-market-rollover-next-promote",
      startTs: nextWindowStartTs,
      endTs: nextWindowEndTs
    })
  };
  const harness = buildHarness({
    mockedNow: currentWindowStartTs + 60_000,
    marketRowsBySlug,
    readMode: "ok"
  });
  try {
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtimeCurrent = harness.engine.getDashboardSnapshot();
    assert(
      runtimeCurrent.selection.selectedSlug === currentSlug,
      `tradable current slug should be selected first, got ${String(runtimeCurrent.selection.selectedSlug)}`
    );

    delete marketRowsBySlug[currentSlug];
    harness.state.mockedNow = currentWindowEndTs + 2_000;
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtimeNext = harness.engine.getDashboardSnapshot();
    const truthNext = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(
      runtimeNext.selection.selectedSlug === nextSlug,
      `rollover should promote next/current bucket immediately, got ${String(runtimeNext.selection.selectedSlug)}`
    );
    assert(
      truthNext.poly.selection.selectedSlug === nextSlug,
      `truth should reflect immediate rollover promotion, got ${String(truthNext.poly.selection.selectedSlug)}`
    );
    assert(
      harness.engineAny.liveCommittedSelection?.selectedSlug === nextSlug,
      "live committed selection should clear stale previous slug and commit the rollover slug"
    );
  } finally {
    harness.cleanup();
  }
}

async function runSlugDerivedWindowFallbackScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowEndTs = activeWindowStartTs + windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const row = makeMarketRow({
    slug: activeSlug,
    marketId: "live-market-slug-derived-window",
    startTs: activeWindowStartTs,
    endTs: activeWindowEndTs
  });
  delete (row as { startTs?: number }).startTs;
  delete (row as { endTs?: number }).endTs;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 60_000,
    marketRowsBySlug: {
      [activeSlug]: row
    },
    readMode: "ok"
  });
  try {
    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();
    const truth = harness.truth.getSnapshot(harness.state.mockedNow);

    assert(runtime.selection.selectedSlug === activeSlug, `slug-derived window fallback should keep selected slug, got ${String(runtime.selection.selectedSlug)}`);
    assert(Number(runtime.selection.remainingSec || 0) > 0, `slug-derived window fallback should keep positive remainingSec, got ${String(runtime.selection.remainingSec)}`);
    assert(truth.poly.selection.selectedSlug === activeSlug, `truth should mirror slug-derived selected slug, got ${String(truth.poly.selection.selectedSlug)}`);
    assert(Number(truth.poly.selection.remainingSec || 0) > 0, `truth should keep positive remainingSec from slug-derived window fallback, got ${String(truth.poly.selection.remainingSec)}`);
  } finally {
    harness.cleanup();
  }
}

async function runLiveMinNotionalClampScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowEndTs = activeWindowStartTs + windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {
      [activeSlug]: makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-min-notional-clamp",
        startTs: activeWindowStartTs,
        endTs: activeWindowEndTs
      })
    },
    readMode: "ok",
    executionMode: "accept"
  });
  try {
    harness.engineAny.config.polymarket.threshold.baseEdge = 0.01;
    harness.engineAny.config.polymarket.paper.minEdgeThreshold = 0.01;
    harness.engineAny.config.polymarket.paper.minNetEdge = 0.0001;
    harness.engineAny.config.polymarket.execution.takerPriceBuffer = 0;
    harness.engineAny.config.polymarket.sizing.minOrderNotional = 1;
    harness.engineAny.config.polymarket.sizing.maxNotionalPerWindow = 10;

    harness.engineAny.sizing.compute = () => ({
      notionalUsd: 0.2,
      shares: 0.41,
      kellyFraction: 0.01
    });

    let postedNotional = 0;
    harness.engineAny.execution.executeBuyYes = async (params: { notionalUsd: number }) => {
      postedNotional = Number(params.notionalUsd || 0);
      harness.state.executionAttempts += 1;
      return {
        action: "BUY_YES",
        accepted: true,
        filledShares: 1,
        fillPrice: 0.49,
        reason: "LIVE_ACCEPTED_TEST_STUB"
      };
    };

    await harness.engineAny.runOnce(harness.state.mockedNow);
    const runtime = harness.engine.getDashboardSnapshot();

    assert(harness.state.executionAttempts === 1, `min-notional clamp should still execute one trade, got ${String(harness.state.executionAttempts)}`);
    assert(postedNotional >= 1, `min-notional clamp should post at least minOrderNotional, got ${String(postedNotional)}`);
    assert(
      !String(runtime.holdReason || "").includes("SIZE_BELOW_MIN_NOTIONAL"),
      `min-notional clamp should avoid false SIZE_BELOW_MIN_NOTIONAL hold, got ${String(runtime.holdReason)}`
    );
  } finally {
    harness.cleanup();
  }
}

async function runIntrawindowReevaluationScenario(): Promise<void> {
  const windowMs = 5 * 60 * 1000;
  const realNow = Date.now();
  const activeWindowStartTs = Math.floor(realNow / windowMs) * windowMs;
  const activeWindowEndTs = activeWindowStartTs + windowMs;
  const activeSlug = `btc-updown-5m-${Math.floor(activeWindowStartTs / 1000)}`;
  const harness = buildHarness({
    mockedNow: activeWindowStartTs + 90_000,
    marketRowsBySlug: {
      [activeSlug]: makeMarketRow({
        slug: activeSlug,
        marketId: "live-market-intrawindow-reeval",
        startTs: activeWindowStartTs,
        endTs: activeWindowEndTs
      })
    },
    readMode: "ok",
    executionMode: "accept"
  });
  try {
    let selectedSlugRefreshCount = 0;
    const originalGetActiveMarketBySlug = harness.engineAny.client.getActiveMarketBySlug.bind(harness.engineAny.client);
    harness.engineAny.client.getActiveMarketBySlug = async (slug: string) => {
      if (String(slug || "").trim() === activeSlug) {
        selectedSlugRefreshCount += 1;
      }
      return originalGetActiveMarketBySlug(slug);
    };
    harness.engineAny.execution.client = harness.engineAny.client;
    const emittedLines: string[] = [];
    const originalInfo = harness.engineAny.logger.info.bind(harness.engineAny.logger);
    const originalWarn = harness.engineAny.logger.warn.bind(harness.engineAny.logger);
    harness.engineAny.logger.info = (...args: unknown[]) => {
      emittedLines.push(String(args[1] ?? args[0] ?? ""));
      return originalInfo(...(args as [unknown, string?]));
    };
    harness.engineAny.logger.warn = (...args: unknown[]) => {
      emittedLines.push(String(args[1] ?? args[0] ?? ""));
      return originalWarn(...(args as [unknown, string?]));
    };

    harness.engineAny.config.polymarket.threshold.baseEdge = 0.9;
    harness.engineAny.config.polymarket.paper.minEdgeThreshold = 0.9;
    harness.engineAny.config.polymarket.paper.minNetEdge = 0.9;
    await harness.engineAny.runOnce(harness.state.mockedNow);

    harness.engineAny.config.polymarket.threshold.baseEdge = 0.01;
    harness.engineAny.config.polymarket.paper.minEdgeThreshold = 0.01;
    harness.engineAny.config.polymarket.paper.minNetEdge = 0.0001;
    harness.engineAny.config.polymarket.execution.takerPriceBuffer = 0;
    harness.state.mockedNow += 2_000;
    await harness.engineAny.runOnce(harness.state.mockedNow);

    const runtime = harness.engine.getDashboardSnapshot();
    assert(
      selectedSlugRefreshCount >= 2,
      `active selected market should be refreshed every loop in-window, got ${String(selectedSlugRefreshCount)}`
    );
    assert(
      harness.state.executionAttempts >= 1,
      `repeated in-window evaluation should not freeze entries after an initial HOLD, got ${String(harness.state.executionAttempts)}`
    );
    assert(
      emittedLines.every((line) => !line.includes("HOLD_UNSPECIFIED")),
      "live path must never emit HOLD_UNSPECIFIED"
    );
    assert(
      String(runtime.staleState || "") !== "DECISIONING_WITH_CACHED_SELECTION",
      `live staleState should not use DECISIONING_WITH_CACHED_SELECTION, got ${String(runtime.staleState)}`
    );
  } finally {
    harness.cleanup();
  }
}

async function run(): Promise<void> {
  await runDegradedStartupScenario();
  await runAdjacentDiscoveryFallbackScenario();
  await runSelectionCommitInvariantScenario();
  await runLiveTruthProjectionAlignmentScenario();
  await runExpiredWindowPendingDiscoveryScenario();
  await runStartupWithCachedUsableWindowScenario();
  await runStartupWithNoUsableWindowScenario();
  await runMissingOrderbookExecutionBlockedScenario();
  await runPriceFetchFailureSelectionPersistenceScenario();
  await runStrategyParityScenario();
  await runImmediateRolloverPromotionScenario();
  await runSlugDerivedWindowFallbackScenario();
  await runLiveMinNotionalClampScenario();
  await runLiveMinVenueShareBumpScenario();
  await runMinVenueShareRiskBlockedScenario();
  await runNormalizedVenueErrorScenario();
  await runIntrawindowReevaluationScenario();
  await runPreorderValidationGuardScenarios();
  await runFastDiscoveryPollModeScenario();
  // eslint-disable-next-line no-console
  console.log("Polymarket live read resiliency tests: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Polymarket live read resiliency tests: FAIL", error);
  process.exit(1);
});
