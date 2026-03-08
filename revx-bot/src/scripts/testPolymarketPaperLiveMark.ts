import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config";
import { PolymarketEngine } from "../polymarket/PolymarketEngine";

process.env.DRY_RUN = "true";
process.env.POLYMARKET_ENABLED = "true";
process.env.POLYMARKET_MODE = "paper";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function buildStubLogger(): any {
  const logger: Record<string, any> = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined
  };
  logger.child = () => logger;
  return logger;
}

function buildHarness(name: string): { engine: PolymarketEngine; engineAny: any; ledgerPath: string } {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-live-mark-${name}-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const base = loadConfig();
  const config = {
    ...base,
    dashboardEnabled: false,
    polymarket: {
      ...base.polymarket,
      enabled: true,
      mode: "paper" as const,
      paper: {
        ...base.polymarket.paper,
        ledgerPath
      }
    }
  };
  const engine = new PolymarketEngine(config, buildStubLogger());
  return { engine, engineAny: engine as any, ledgerPath };
}

function recordOpenTrade(
  engineAny: any,
  input: {
    marketId: string;
    marketSlug: string;
    side: "YES" | "NO";
    entryPrice: number;
    qty: number;
    entryCostUsd: number;
    feesUsd: number;
    yesTokenId: string;
    noTokenId: string;
    heldTokenId: string;
    yesDisplayLabel?: string;
    noDisplayLabel?: string;
    referencePriceAtEntry?: number;
    nowTs: number;
  }
): void {
  engineAny.paperLedger.recordTrade({
    marketId: input.marketId,
    marketSlug: input.marketSlug,
    marketQuestion: "Will Bitcoin go up or down in the next 5 minutes?",
    windowStartTs: input.nowTs - 60_000,
    windowEndTs: input.nowTs + 240_000,
    side: input.side,
    entryPrice: input.entryPrice,
    qty: input.qty,
    notionalUsd: input.entryCostUsd,
    feeBps: 0,
    slippageBps: 0,
    feesUsd: input.feesUsd,
    entryCostUsd: input.entryCostUsd,
    priceToBeat: 100,
    referencePriceAtEntry: input.referencePriceAtEntry,
    yesTokenId: input.yesTokenId,
    noTokenId: input.noTokenId,
    yesDisplayLabel: input.yesDisplayLabel ?? "UP",
    noDisplayLabel: input.noDisplayLabel ?? "DOWN",
    heldTokenId: input.heldTokenId,
    createdTs: input.nowTs
  });
}

function runUpTradeScenario(): void {
  const { engine, engineAny, ledgerPath } = buildHarness("up");
  const originalDateNow = Date.now;
  try {
    const nowTs = Date.parse("2026-03-06T20:30:00.000Z");
    Date.now = () => nowTs;
    recordOpenTrade(engineAny, {
      marketId: "market-up",
      marketSlug: "btc-updown-5m-up",
      side: "YES",
      entryPrice: 0.4,
      qty: 10,
      entryCostUsd: 4,
      feesUsd: 0.1,
      yesTokenId: "token-up-yes",
      noTokenId: "token-up-no",
      heldTokenId: "token-up-yes",
      referencePriceAtEntry: 68_050,
      nowTs
    });
    engineAny.lastOracleSnapshot = {
      price: 68_100,
      rawTs: nowTs,
      source: "paper-test",
      state: "OK"
    };
    engineAny.cacheTokenBookSnapshot("token-up-yes", {
      bestBid: 0.59,
      bestAsk: 0.61,
      bookTs: nowTs - 500
    });

    const snapshot = engine.getDashboardSnapshot();
    const openTrade = snapshot.openTrade;
    assert(openTrade !== null, "expected openTrade snapshot for UP trade");
    assert(Math.abs(Number(openTrade?.livePrice || 0) - 0.6) < 1e-9, `expected UP livePrice=0.6, got ${String(openTrade?.livePrice)}`);
    assert(Math.abs(Number(openTrade?.bestBid || 0) - 0.59) < 1e-9, `expected UP bestBid=0.59, got ${String(openTrade?.bestBid)}`);
    assert(Math.abs(Number(openTrade?.bestAsk || 0) - 0.61) < 1e-9, `expected UP bestAsk=0.61, got ${String(openTrade?.bestAsk)}`);
    assert(String(openTrade?.markSource || "") === "MID", `expected UP markSource MID, got ${String(openTrade?.markSource)}`);
    assert(Math.abs(Number(openTrade?.contractEntryPrice || 0) - 0.4) < 1e-9, `expected contractEntryPrice=0.4, got ${String(openTrade?.contractEntryPrice)}`);
    assert(Math.abs(Number(openTrade?.contractLivePrice || 0) - 0.6) < 1e-9, `expected contractLivePrice=0.6, got ${String(openTrade?.contractLivePrice)}`);
    assert(Math.abs(Number(openTrade?.impliedProbPct || 0) - 60) < 1e-9, `expected impliedProbPct=60, got ${String(openTrade?.impliedProbPct)}`);
    assert(Math.abs(Number(openTrade?.btcStartPrice || 0) - 68050) < 1e-9, `expected btcStartPrice=68050, got ${String(openTrade?.btcStartPrice)}`);
    assert(Math.abs(Number(openTrade?.btcReferencePrice || 0) - 68100) < 1e-9, `expected btcReferencePrice=68100, got ${String(openTrade?.btcReferencePrice)}`);
    assert(Math.abs(Number(openTrade?.unrealizedPnlUsd || 0) - 1.9) < 1e-9, `expected UP unrealizedPnlUsd=1.9, got ${String(openTrade?.unrealizedPnlUsd)}`);
  } finally {
    Date.now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

function runFallbackScenario(): void {
  const { engine, engineAny, ledgerPath } = buildHarness("fallback");
  const originalDateNow = Date.now;
  try {
    const nowTs = Date.parse("2026-03-06T20:31:00.000Z");
    Date.now = () => nowTs;
    recordOpenTrade(engineAny, {
      marketId: "market-fallback",
      marketSlug: "btc-updown-5m-fallback",
      side: "YES",
      entryPrice: 0.5,
      qty: 8,
      entryCostUsd: 4,
      feesUsd: 0.05,
      yesTokenId: "token-fallback-yes",
      noTokenId: "token-fallback-no",
      heldTokenId: "token-fallback-yes",
      nowTs
    });
    engineAny.cacheTokenBookSnapshot("token-fallback-yes", {
      bestBid: 0.5,
      bestAsk: 0.54,
      bookTs: nowTs - 1_000
    });
    engineAny.cacheTokenBookSnapshot("token-fallback-yes", {
      bestBid: 0.58,
      bestAsk: null,
      bookTs: nowTs
    });

    const snapshot = engine.getDashboardSnapshot();
    const openTrade = snapshot.openTrade;
    assert(openTrade !== null, "expected openTrade snapshot for fallback scenario");
    assert(Math.abs(Number(openTrade?.bestBid || 0) - 0.58) < 1e-9, `expected merged bestBid=0.58, got ${String(openTrade?.bestBid)}`);
    assert(Math.abs(Number(openTrade?.bestAsk || 0) - 0.54) < 1e-9, `expected fallback bestAsk=0.54, got ${String(openTrade?.bestAsk)}`);
    assert(Math.abs(Number(openTrade?.livePrice || 0) - 0.56) < 1e-9, `expected fallback livePrice=0.56, got ${String(openTrade?.livePrice)}`);
    assert(
      String(openTrade?.markSource || "") === "CACHED_LAST_GOOD_MID",
      `expected fallback markSource CACHED_LAST_GOOD_MID, got ${String(openTrade?.markSource)}`
    );
  } finally {
    Date.now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

function runCachedStaleMarkScenario(): void {
  const { engine, engineAny, ledgerPath } = buildHarness("cached-stale");
  const originalDateNow = Date.now;
  try {
    const nowTs = Date.parse("2026-03-06T20:31:30.000Z");
    Date.now = () => nowTs;
    recordOpenTrade(engineAny, {
      marketId: "market-cached-stale",
      marketSlug: "btc-updown-5m-cached-stale",
      side: "YES",
      entryPrice: 0.45,
      qty: 10,
      entryCostUsd: 4.5,
      feesUsd: 0.1,
      yesTokenId: "token-cached-stale-yes",
      noTokenId: "token-cached-stale-no",
      heldTokenId: "token-cached-stale-yes",
      nowTs
    });
    engineAny.cacheTokenBookSnapshot("token-cached-stale-yes", {
      bestBid: 0.62,
      bestAsk: 0.64,
      bookTs: nowTs - 20_000
    });

    const snapshot = engine.getDashboardSnapshot();
    const openTrade = snapshot.openTrade;
    assert(openTrade !== null, "expected openTrade snapshot for cached stale scenario");
    assert(Math.abs(Number(openTrade?.livePrice || 0) - 0.63) < 1e-9, `expected cached livePrice=0.63, got ${String(openTrade?.livePrice)}`);
    assert(Boolean(openTrade?.markStale), "expected cached mark to be marked stale");
    assert(Boolean(openTrade?.isStale), "expected cached mark isStale to be true");
    assert(
      String(openTrade?.markSource || "") === "CACHED_LAST_GOOD_MID",
      `expected cached stale source CACHED_LAST_GOOD_MID, got ${String(openTrade?.markSource)}`
    );
    assert(Math.abs(Number(openTrade?.unrealizedPnlUsd || 0) - 1.7) < 1e-9, `expected cached unrealizedPnlUsd=1.7, got ${String(openTrade?.unrealizedPnlUsd)}`);
  } finally {
    Date.now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

function runUnavailableMarkScenario(): void {
  const { engine, engineAny, ledgerPath } = buildHarness("unavailable");
  const originalDateNow = Date.now;
  try {
    const nowTs = Date.parse("2026-03-06T20:31:45.000Z");
    Date.now = () => nowTs;
    recordOpenTrade(engineAny, {
      marketId: "market-unavailable",
      marketSlug: "btc-updown-5m-unavailable",
      side: "YES",
      entryPrice: 0.41,
      qty: 12,
      entryCostUsd: 4.92,
      feesUsd: 0.08,
      yesTokenId: "token-unavailable-yes",
      noTokenId: "token-unavailable-no",
      heldTokenId: "token-unavailable-yes",
      nowTs
    });
    engineAny.lastOracleSnapshot = {
      price: 67_950,
      rawTs: nowTs,
      source: "paper-test",
      state: "OK"
    };

    const snapshot = engine.getDashboardSnapshot();
    const openTrade = snapshot.openTrade;
    assert(openTrade !== null, "expected openTrade snapshot for unavailable mark scenario");
    assert(openTrade?.livePrice == null, `expected unavailable livePrice to be null, got ${String(openTrade?.livePrice)}`);
    assert(openTrade?.unrealizedPnlUsd == null, `expected unavailable unrealizedPnlUsd to be null, got ${String(openTrade?.unrealizedPnlUsd)}`);
    assert(String(openTrade?.markSource || "") === "UNAVAILABLE", `expected unavailable markSource, got ${String(openTrade?.markSource)}`);
    assert(Math.abs(Number(openTrade?.btcReferencePrice || 0) - 67950) < 1e-9, `expected unavailable btcReferencePrice fallback, got ${String(openTrade?.btcReferencePrice)}`);
    assert(Boolean(openTrade?.markStale), "expected unavailable mark to be stale");
  } finally {
    Date.now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

function runDownTradeScenario(): void {
  const { engine, engineAny, ledgerPath } = buildHarness("down");
  const originalDateNow = Date.now;
  try {
    const nowTs = Date.parse("2026-03-06T20:32:00.000Z");
    Date.now = () => nowTs;
    recordOpenTrade(engineAny, {
      marketId: "market-down",
      marketSlug: "btc-updown-5m-down",
      side: "NO",
      entryPrice: 0.32,
      qty: 10,
      entryCostUsd: 3.2,
      feesUsd: 0.05,
      yesTokenId: "token-down-yes",
      noTokenId: "token-down-no",
      heldTokenId: "token-down-no",
      nowTs
    });
    engineAny.cacheYesBookSnapshot("market-down", {
      yesBid: 0.64,
      yesAsk: 0.66,
      yesMid: 0.65,
      spread: 0.02,
      topBidSize: 12,
      topAskSize: 11,
      bookTs: nowTs - 250
    });

    const snapshot = engine.getDashboardSnapshot();
    const openTrade = snapshot.openTrade;
    assert(openTrade !== null, "expected openTrade snapshot for DOWN trade");
    assert(String(openTrade?.direction || "") === "DOWN", `expected DOWN direction, got ${String(openTrade?.direction)}`);
    assert(Math.abs(Number(openTrade?.bestBid || 0) - 0.34) < 1e-9, `expected derived NO bestBid=0.34, got ${String(openTrade?.bestBid)}`);
    assert(Math.abs(Number(openTrade?.bestAsk || 0) - 0.36) < 1e-9, `expected derived NO bestAsk=0.36, got ${String(openTrade?.bestAsk)}`);
    assert(Math.abs(Number(openTrade?.livePrice || 0) - 0.35) < 1e-9, `expected DOWN livePrice=0.35, got ${String(openTrade?.livePrice)}`);
    assert(String(openTrade?.markSource || "") === "DERIVED_NO_MID", `expected derived mark source, got ${String(openTrade?.markSource)}`);
    assert(Math.abs(Number(openTrade?.unrealizedPnlUsd || 0) - 0.25) < 1e-9, `expected DOWN unrealizedPnlUsd=0.25, got ${String(openTrade?.unrealizedPnlUsd)}`);
  } finally {
    Date.now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

function run(): void {
  runUpTradeScenario();
  runFallbackScenario();
  runCachedStaleMarkScenario();
  runDownTradeScenario();
  runUnavailableMarkScenario();
  // eslint-disable-next-line no-console
  console.log("Polymarket paper live mark tests: PASS");
}

run();
