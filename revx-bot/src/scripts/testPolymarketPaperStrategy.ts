import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { PolymarketEngine } from "../polymarket/PolymarketEngine";
import { computePaperClosePnl } from "../polymarket/paper/PaperMath";
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
    question: `Will BTC be up or down in the next 5 minutes from ${input.priceToBeat}?`,
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

function buildEngine(ledgerPath: string): {
  engineAny: any;
  state: {
    mockedNow: number;
    bucketStart: number;
    marketRow: Record<string, unknown>;
    nextMarketRow: Record<string, unknown>;
    oraclePrice: number;
    yesBid: number;
    yesAsk: number;
    noBid: number;
    noAsk: number;
  };
} {
  const base = loadConfig();
  const fiveMinMs = 5 * 60 * 1000;
  const bucketStart = Math.floor(Date.now() / fiveMinMs) * fiveMinMs;
  const slug = slugForTs(Math.floor(bucketStart / 1000));
  const nextBucketStart = bucketStart + fiveMinMs;
  const nextSlug = slugForTs(Math.floor(nextBucketStart / 1000));
  const marketRow = makeRawMarket({
    marketId: "paper-strategy-market",
    slug,
    priceToBeat: 100,
    startTs: bucketStart,
    endTs: bucketStart + fiveMinMs,
    yesTokenId: "paper-strategy-yes",
    noTokenId: "paper-strategy-no"
  });
  const nextMarketRow = makeRawMarket({
    marketId: "paper-strategy-market-next",
    slug: nextSlug,
    priceToBeat: 101,
    startTs: nextBucketStart,
    endTs: nextBucketStart + fiveMinMs,
    yesTokenId: "paper-strategy-next-yes",
    noTokenId: "paper-strategy-next-no"
  });

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
        feeBps: 0,
        slippageBps: 0,
        minEdgeThreshold: 0,
        minNetEdge: 0,
        probExtreme: 0.5,
        extremeLowPrice: 0.5,
        extremeHighPrice: 0.5001,
        entryMinRemainingSec: 45,
        entryMaxRemainingSec: 285,
        reentryCooldownSec: 15,
        resolveGraceMs: 10_000,
        forceTrade: false
      }
    }
  };

  const logger = buildLogger(config);
  const engine = new PolymarketEngine(config, logger);
  const engineAny = engine as any;
  const state = {
    mockedNow: bucketStart + 20_000,
    bucketStart,
    marketRow,
    nextMarketRow,
    oraclePrice: 101.2,
    yesBid: 0.48,
    yesAsk: 0.49,
    noBid: 0.5,
    noAsk: 0.52
  };
  let lastFetchAttemptTs = 0;
  let lastFetchOkTs = 0;

  engineAny.client = {
    getActiveMarketBySlug: async (slugValue: string) => {
      if (slugValue === slug) {
        return state.mockedNow < bucketStart + fiveMinMs ? marketRow : null;
      }
      if (slugValue === nextSlug) {
        return state.mockedNow >= nextBucketStart && state.mockedNow < nextBucketStart + fiveMinMs ? nextMarketRow : null;
      }
      return null;
    },
    listMarketsPage: async () => {
      lastFetchAttemptTs = Date.now();
      lastFetchOkTs = lastFetchAttemptTs;
      return { rows: [] };
    },
    getIngestionTelemetry: () => ({
      lastFetchAttemptTs,
      lastFetchOkTs,
      lastFetchErr: null,
      lastHttpStatus: 200
    }),
    recordFetchDisabled: () => {},
    getYesOrderBook: async (marketId: string) => ({
      marketId,
      tokenId: "paper-strategy-yes",
      yesBid: state.yesBid,
      yesAsk: state.yesAsk,
      yesMid: (state.yesBid + state.yesAsk) / 2,
      spread: Math.max(0, state.yesAsk - state.yesBid),
      bids: [{ price: state.yesBid, size: 100 }],
      asks: [{ price: state.yesAsk, size: 100 }],
      ts: Date.now()
    }),
    getTokenOrderBook: async (tokenId: string) => ({
      tokenId,
      bestBid: state.noBid,
      bestAsk: state.noAsk,
      bids: [{ price: state.noBid, size: 100 }],
      asks: [{ price: state.noAsk, size: 100 }],
      ts: Date.now()
    }),
    getMarketContext: async () => null
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
      price: state.oraclePrice,
      source: "internal_fair_mid",
      ts: state.mockedNow,
      rawTs: state.mockedNow,
      staleMs: 0,
      state: "OK",
      fallbackSigmaPricePerSqrtSec: 0.1
    }),
    getFastMidNow: () => ({
      price: state.oraclePrice,
      ts: state.mockedNow,
      source: "internal_fair_mid"
    })
  };

  return { engineAny, state };
}

function seedAwaitingResolutionTrade(engineAny: any, state: {
  bucketStart: number;
  marketRow: Record<string, unknown>;
}): void {
  const fiveMinMs = 5 * 60 * 1000;
  const trade = engineAny.paperLedger.recordTrade({
    marketId: String(state.marketRow.market_id || state.marketRow.id || "paper-strategy-market"),
    marketSlug: String(state.marketRow.slug || ""),
    marketQuestion: String(state.marketRow.question || "Will BTC be up or down in the next 5 minutes?"),
    windowStartTs: state.bucketStart,
    windowEndTs: state.bucketStart + fiveMinMs,
    expectedCloseTs: state.bucketStart + fiveMinMs,
    side: "YES",
    entryPrice: 0.4,
    qty: 10,
    notionalUsd: 4,
    feeBps: 0,
    slippageBps: 0,
    feesUsd: 0,
    entryCostUsd: 4,
    priceToBeat: 100,
    yesTokenId: "paper-strategy-yes",
    noTokenId: "paper-strategy-no",
    yesDisplayLabel: "UP",
    noDisplayLabel: "DOWN",
    heldTokenId: "paper-strategy-yes",
    createdTs: state.bucketStart + 5_000
  });
  engineAny.paperLedger.updateTradeStatus({
    tradeId: trade.id,
    status: "AWAITING_RESOLUTION",
    statusUpdatedAt: state.bucketStart + fiveMinMs + 1_000,
    statusReason: "EXPIRED_WINDOW",
    statusDetail: "Old window expired; awaiting resolution",
    awaitingResolutionSinceTs: state.bucketStart + fiveMinMs,
    lastResolutionAttemptTs: state.bucketStart + fiveMinMs + 1_000,
    resolutionAttempts: 1,
    resolutionContextState: "CLOSED_AWAITING_OUTCOME"
  });
}

async function runReentryScenario(): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-strategy-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engineAny, state } = buildEngine(ledgerPath);
  const originalDateNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => state.mockedNow;
  try {
    await engineAny.runOnce(state.mockedNow);
    let openTrades = engineAny.paperLedger.getOpenTrades();
    assert(openTrades.length === 1, "expected first paper entry to open");
    assert(String(engineAny.truthChosenDirection || "") === "UP", "bullish entry should track UP direction");

    state.mockedNow += 1_000;
    await engineAny.runOnce(state.mockedNow);
    assert(String(engineAny.truthHoldReason || "") === "OPEN_POSITION_IN_WINDOW", "expected open-position gate");

    const firstTrade = openTrades[0];
    const closeTs = state.bucketStart + 100_000;
    const closePnl = computePaperClosePnl({
      qty: firstTrade.qty,
      entryCostUsd: firstTrade.entryCostUsd,
      entryFeesUsd: firstTrade.feesUsd,
      exitPrice: 0.75,
      feeBps: firstTrade.feeBps
    });
    engineAny.closePaperTrade(firstTrade.id, "TAKE_PROFIT", 0.75, closePnl, closeTs);

    state.mockedNow = closeTs + 5_000;
    await engineAny.runOnce(state.mockedNow);
    assert(engineAny.paperLedger.getOpenTrades().length === 0, "cooldown should block immediate re-entry");
    assert(String(engineAny.truthHoldReason || "") === "REENTRY_COOLDOWN", "expected cooldown gate after early exit");

    state.mockedNow = closeTs + 20_000;
    await engineAny.runOnce(state.mockedNow);
    openTrades = engineAny.paperLedger.getOpenTrades();
    assert(openTrades.length === 1, "same window should allow re-entry after cooldown");
    const runtimeAfterReentry = engineAny.getDashboardSnapshot();
    assert(runtimeAfterReentry.lastAction === "OPEN", `expected OPEN action after re-entry, got ${String(runtimeAfterReentry.lastAction)}`);
    assert(runtimeAfterReentry.holdReason === null, `expected no holdReason on OPEN, got ${String(runtimeAfterReentry.holdReason)}`);
    assert(engineAny.polyState.holdDetailReason === null, `expected cleared holdDetailReason on OPEN, got ${String(engineAny.polyState.holdDetailReason)}`);
    const sameWindowTrades = engineAny.paperLedger.getTradesForWindow(
      firstTrade.marketId,
      firstTrade.windowStartTs,
      firstTrade.windowEndTs
    );
    assert(sameWindowTrades.length === 2, "window should contain both the exited trade and the re-entry");
    assert(engineAny.truthEntriesInWindow === 2, `expected entriesInWindow=2, got ${String(engineAny.truthEntriesInWindow)}`);
  } finally {
    (Date as unknown as { now: () => number }).now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

async function runBearishChooserScenario(): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-strategy-bearish-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engineAny, state } = buildEngine(ledgerPath);
  const originalDateNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => state.mockedNow;
  try {
    state.oraclePrice = 98.8;
    state.yesBid = 0.61;
    state.yesAsk = 0.62;
    state.noBid = 0.37;
    state.noAsk = 0.39;

    await engineAny.runOnce(state.mockedNow);
    const openTrades = engineAny.paperLedger.getOpenTrades();
    assert(openTrades.length === 1, "expected bearish paper entry to open");
    assert(String(openTrades[0].side || "") === "NO", `expected bearish trade to hold NO, got ${String(openTrades[0].side)}`);
    assert(String(engineAny.truthChosenDirection || "") === "DOWN", `expected bearish chosen direction DOWN, got ${String(engineAny.truthChosenDirection)}`);
    const runtime = engineAny.getDashboardSnapshot();
    assert(runtime.lastAction === "OPEN", `expected bearish runtime lastAction OPEN, got ${String(runtime.lastAction)}`);
    assert(String(runtime.selection.chosenDirection || "") === "DOWN", `expected bearish runtime chosenDirection DOWN, got ${String(runtime.selection.chosenDirection)}`);
  } finally {
    (Date as unknown as { now: () => number }).now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

async function runReentryBelowMinScenario(): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-strategy-late-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engineAny, state } = buildEngine(ledgerPath);
  const originalDateNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => state.mockedNow;
  try {
    await engineAny.runOnce(state.mockedNow);
    const firstTrade = engineAny.paperLedger.getOpenTrades()[0];
    assert(Boolean(firstTrade), "expected initial trade before late re-entry test");

    const closeTs = state.bucketStart + 245_000;
    const closePnl = computePaperClosePnl({
      qty: firstTrade.qty,
      entryCostUsd: firstTrade.entryCostUsd,
      entryFeesUsd: firstTrade.feesUsd,
      exitPrice: 0.7,
      feeBps: firstTrade.feeBps
    });
    engineAny.closePaperTrade(firstTrade.id, "TAKE_PROFIT", 0.7, closePnl, closeTs);

    state.mockedNow = closeTs + 20_000;
    await engineAny.runOnce(state.mockedNow);
    assert(engineAny.paperLedger.getOpenTrades().length === 0, "re-entry must stay blocked below minRemainingSec");
    assert(String(engineAny.truthHoldReason || "") === "TOO_LATE_FOR_ENTRY", `expected TOO_LATE_FOR_ENTRY, got ${String(engineAny.truthHoldReason)}`);
  } finally {
    (Date as unknown as { now: () => number }).now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

async function runPostExitCountdownAndCooldownExpiryScenario(): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-strategy-post-exit-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engineAny, state } = buildEngine(ledgerPath);
  const originalDateNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => state.mockedNow;
  try {
    await engineAny.runOnce(state.mockedNow);
    const firstTrade = engineAny.paperLedger.getOpenTrades()[0];
    assert(Boolean(firstTrade), "expected initial trade before post-exit progression test");

    const closeTs = state.bucketStart + 100_000;
    const closePnl = computePaperClosePnl({
      qty: firstTrade.qty,
      entryCostUsd: firstTrade.entryCostUsd,
      entryFeesUsd: firstTrade.feesUsd,
      exitPrice: 0.75,
      feeBps: firstTrade.feeBps
    });
    engineAny.closePaperTrade(firstTrade.id, "TAKE_PROFIT", 0.75, closePnl, closeTs);

    state.oraclePrice = 100;
    state.yesBid = 0.5;
    state.yesAsk = 0.5;
    state.noBid = 0.5;
    state.noAsk = 0.5;

    state.mockedNow = closeTs + 5_000;
    await engineAny.runOnce(state.mockedNow);
    let runtime = engineAny.getDashboardSnapshot();
    assert(runtime.lastAction === "HOLD", `expected HOLD during active cooldown, got ${String(runtime.lastAction)}`);
    assert(runtime.holdReason === "REENTRY_COOLDOWN", `expected REENTRY_COOLDOWN during active cooldown, got ${String(runtime.holdReason)}`);
    const remainingDuringCooldown = Number(runtime.selection.remainingSec || 0);

    state.mockedNow = closeTs + 20_000;
    await engineAny.runOnce(state.mockedNow);
    runtime = engineAny.getDashboardSnapshot();
    assert(runtime.holdReason !== "REENTRY_COOLDOWN", `cooldown should auto-clear after expiry, got ${String(runtime.holdReason)}`);
    assert(runtime.lastAction === "HOLD", `expected HOLD after cooldown expiry without re-entry, got ${String(runtime.lastAction)}`);
    assert(
      Number(runtime.selection.remainingSec || 0) < remainingDuringCooldown,
      `remainingSec should continue ticking after exit, got ${String(runtime.selection.remainingSec)} vs ${String(remainingDuringCooldown)}`
    );
    assert(engineAny.paperLedger.getOpenTrades().length === 0, "no re-entry should occur when edge is not attractive after cooldown");
  } finally {
    (Date as unknown as { now: () => number }).now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

async function runPostExitRolloverScenario(): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-strategy-rollover-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engineAny, state } = buildEngine(ledgerPath);
  const originalDateNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => state.mockedNow;
  try {
    await engineAny.runOnce(state.mockedNow);
    const firstTrade = engineAny.paperLedger.getOpenTrades()[0];
    assert(Boolean(firstTrade), "expected initial trade before rollover test");

    const closeTs = state.bucketStart + 100_000;
    const closePnl = computePaperClosePnl({
      qty: firstTrade.qty,
      entryCostUsd: firstTrade.entryCostUsd,
      entryFeesUsd: firstTrade.feesUsd,
      exitPrice: 0.75,
      feeBps: firstTrade.feeBps
    });
    engineAny.closePaperTrade(firstTrade.id, "TAKE_PROFIT", 0.75, closePnl, closeTs);

    state.oraclePrice = 100;
    state.yesBid = 0.5;
    state.yesAsk = 0.5;
    state.noBid = 0.5;
    state.noAsk = 0.5;

    state.mockedNow = state.bucketStart + 299_000;
    await engineAny.runOnce(state.mockedNow);
    let runtime = engineAny.getDashboardSnapshot();
    assert(
      Number(runtime.selection.remainingSec || 0) <= 1,
      `expected countdown to reach final seconds before rollover, got ${String(runtime.selection.remainingSec)}`
    );

    state.mockedNow = state.bucketStart + 302_000;
    state.oraclePrice = 101.4;
    state.yesBid = 0.48;
    state.yesAsk = 0.49;
    state.noBid = 0.5;
    state.noAsk = 0.52;
    await engineAny.runOnce(state.mockedNow);
    runtime = engineAny.getDashboardSnapshot();
    assert(
      String(runtime.selection.selectedSlug || "") === String(state.nextMarketRow.slug || ""),
      `expected selected slug to roll to next window, got ${String(runtime.selection.selectedSlug)}`
    );
    assert(runtime.holdReason !== "REENTRY_COOLDOWN", `rollover must not preserve stale cooldown gate, got ${String(runtime.holdReason)}`);
  } finally {
    (Date as unknown as { now: () => number }).now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

async function runAwaitingResolutionDoesNotBlockNextSlugEntryScenario(): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-awaiting-next-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engineAny, state } = buildEngine(ledgerPath);
  const originalDateNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => state.mockedNow;
  try {
    state.mockedNow = state.bucketStart + 5 * 60 * 1000 + 20_000;
    seedAwaitingResolutionTrade(engineAny, state);
    await engineAny.runOnce(state.mockedNow);
    const runtime = engineAny.getDashboardSnapshot();
    const openTrades = engineAny.paperLedger.getOpenTrades();
    assert(
      String(runtime.selection.selectedSlug || "") === String(state.nextMarketRow.slug || ""),
      `awaiting prior slug must not block next slug discovery, got ${String(runtime.selection.selectedSlug)}`
    );
    assert(openTrades.length === 1, "awaiting prior slug must not block new entry in next slug");
    assert(
      String(openTrades[0].marketSlug || "") === String(state.nextMarketRow.slug || ""),
      `new entry should belong to next slug, got ${String(openTrades[0].marketSlug)}`
    );
  } finally {
    (Date as unknown as { now: () => number }).now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

async function runResolutionFetchFailureDoesNotSuppressCurrentScanScenario(): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-resolution-fetch-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engineAny, state } = buildEngine(ledgerPath);
  const originalDateNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => state.mockedNow;
  try {
    state.mockedNow = state.bucketStart + 5 * 60 * 1000 + 20_000;
    seedAwaitingResolutionTrade(engineAny, state);
    engineAny.client.getMarketContext = async () => {
      throw new Error("resolution network failure");
    };
    await engineAny.runOnce(state.mockedNow);
    const runtime = engineAny.getDashboardSnapshot();
    assert(
      String(runtime.selection.selectedSlug || "") === String(state.nextMarketRow.slug || ""),
      `resolution fetch failure must not suppress current-window scan, got ${String(runtime.selection.selectedSlug)}`
    );
    assert(engineAny.paperLedger.getOpenTrades().length === 1, "resolution fetch failure must not block next-window paper entry");
  } finally {
    (Date as unknown as { now: () => number }).now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

async function runAwaitingResolutionDoesNotMaskCurrentEdgeRejectScenario(): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-awaiting-edge-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engineAny, state } = buildEngine(ledgerPath);
  const originalDateNow = Date.now;
  (Date as unknown as { now: () => number }).now = () => state.mockedNow;
  try {
    state.mockedNow = state.bucketStart + 5 * 60 * 1000 + 20_000;
    seedAwaitingResolutionTrade(engineAny, state);
    state.oraclePrice = 101;
    state.yesBid = 0.59;
    state.yesAsk = 0.6;
    state.noBid = 0.39;
    state.noAsk = 0.6;
    await engineAny.runOnce(state.mockedNow);
    const runtime = engineAny.getDashboardSnapshot();
    assert(
      String(runtime.selection.selectedSlug || "") === String(state.nextMarketRow.slug || ""),
      `current window should still be selected during edge reject, got ${String(runtime.selection.selectedSlug)}`
    );
    assert(String(runtime.holdReason || "") === "EDGE_BELOW_THRESHOLD", `expected EDGE_BELOW_THRESHOLD, got ${String(runtime.holdReason)}`);
    assert(Number(runtime.openTradesCount || 0) === 0, `expected openTradesCount=0, got ${String(runtime.openTradesCount)}`);
    assert(engineAny.paperLedger.getOpenTrades().length === 0, "edge reject should prevent new entry even with prior resolution queue");
  } finally {
    (Date as unknown as { now: () => number }).now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

async function runTrailingExitScenario(): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-trailing-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engineAny, state } = buildEngine(ledgerPath);
  const trade = engineAny.paperLedger.recordTrade({
    marketId: "trail-market",
    marketSlug: "btc-updown-5m-trail",
    marketQuestion: "Will BTC be up or down in 5 minutes?",
    windowStartTs: state.bucketStart,
    windowEndTs: state.bucketStart + 300_000,
    side: "YES",
    entryPrice: 0.5,
    qty: 2,
    notionalUsd: 1,
    feeBps: 0,
    slippageBps: 0,
    feesUsd: 0,
    entryCostUsd: 1,
    priceToBeat: 100,
    yesTokenId: "trail-yes",
    noTokenId: "trail-no",
    yesDisplayLabel: "UP",
    noDisplayLabel: "DOWN",
    heldTokenId: "trail-yes",
    createdTs: state.bucketStart + 10_000
  });

  await engineAny.managePaperOpenPositions({
    nowTs: state.bucketStart + 100_000,
    remainingSec: 150,
    market: { marketId: "trail-market", noTokenId: "trail-no" },
    implied: {
      yesBid: 0.8,
      yesAsk: 0.81,
      yesMid: 0.805,
      spread: 0.01
    },
    edgeYes: 0.2,
    edgeNo: -0.2,
    costPenaltyProb: 0
  });
  const afterFirstMove = engineAny.paperLedger.getTrade(trade.id);
  assert(Boolean(afterFirstMove), "expected trailing trade after first move");
  assert(getPaperTradeStatus(afterFirstMove) === "OPEN", "first favorable move should not exit immediately");

  await engineAny.managePaperOpenPositions({
    nowTs: state.bucketStart + 120_000,
    remainingSec: 150,
    market: { marketId: "trail-market", noTokenId: "trail-no" },
    implied: {
      yesBid: 0.58,
      yesAsk: 0.59,
      yesMid: 0.585,
      spread: 0.01
    },
    edgeYes: 0.2,
    edgeNo: -0.2,
    costPenaltyProb: 0
  });

  const closed = engineAny.paperLedger.getTrade(trade.id);
  assert(Boolean(closed), "expected trailing trade after retrace");
  assert(getPaperTradeStatus(closed) === "EXITED_EARLY", "retracement should trigger an early exit");
  assert(String(closed?.closeReason || "") === "TRAILING_RETRACE", "expected trailing retrace close reason");
  rmSync(ledgerPath, { force: true });
}

function runTakeProfitLadderScenario(): void {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-ladder-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engineAny } = buildEngine(ledgerPath);
  assert(Math.abs(Number(engineAny.getPaperTakeProfitUsd(260)) - 3.0) < 1e-9, "TP ladder 240-300 mismatch");
  assert(Math.abs(Number(engineAny.getPaperTakeProfitUsd(200)) - 2.25) < 1e-9, "TP ladder 180-239 mismatch");
  assert(Math.abs(Number(engineAny.getPaperTakeProfitUsd(150)) - 1.5) < 1e-9, "TP ladder 120-179 mismatch");
  assert(Math.abs(Number(engineAny.getPaperTakeProfitUsd(90)) - 0.75) < 1e-9, "TP ladder 60-119 mismatch");
  assert(Math.abs(Number(engineAny.getPaperTakeProfitUsd(50)) - 0.35) < 1e-9, "TP ladder 45-59 mismatch");
  rmSync(ledgerPath, { force: true });
}

async function run(): Promise<void> {
  await runReentryScenario();
  await runBearishChooserScenario();
  await runReentryBelowMinScenario();
  await runPostExitCountdownAndCooldownExpiryScenario();
  await runPostExitRolloverScenario();
  await runAwaitingResolutionDoesNotBlockNextSlugEntryScenario();
  await runResolutionFetchFailureDoesNotSuppressCurrentScanScenario();
  await runAwaitingResolutionDoesNotMaskCurrentEdgeRejectScenario();
  await runTrailingExitScenario();
  runTakeProfitLadderScenario();
  // eslint-disable-next-line no-console
  console.log("Polymarket paper strategy tests: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Polymarket paper strategy tests: FAIL", error);
  process.exit(1);
});
