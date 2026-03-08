import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config";
import { getTradingTruthReporter } from "../logging/truth";
import { buildLogger } from "../logger";
import { PolymarketEngine } from "../polymarket/PolymarketEngine";
import { DashboardServer } from "../web/DashboardServer";

process.env.DRY_RUN = "true";
process.env.POLYMARKET_ENABLED = "true";
process.env.POLYMARKET_MODE = "paper";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function buildHarness(ledgerPath: string): {
  engine: PolymarketEngine;
  engineAny: any;
  truth: ReturnType<typeof getTradingTruthReporter>;
  dashboard: DashboardServer;
} {
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
  const logger = buildLogger(config);
  const engine = new PolymarketEngine(config, logger);
  const truth = getTradingTruthReporter(config, logger);
  const runtimeProvider = {
    getDashboardSnapshot: () => engine.getDashboardSnapshot(),
    getLagSnapshot: () => ({
      stats: engine.getDashboardSnapshot().latestLag,
      recent: []
    })
  };
  const dashboard = new DashboardServer(
    config,
    logger,
    {} as any,
    "polymarket-paper-truth-status-test",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    runtimeProvider
  );
  return { engine, engineAny: engine as any, truth, dashboard };
}

function makeTick(input: {
  nowTs: number;
  selectedSlug: string;
  currentMarketId: string;
  windowEndTs: number;
  remainingSec: number;
  action: "HOLD" | "OPEN";
  holdReason?: string | null;
  holdDetailReason?: string | null;
  chosenDirection?: string | null;
  chosenEdge?: number | null;
  threshold?: number | null;
  openTrades?: number;
  resolvedTrades?: number;
  tradingPaused?: boolean;
  pauseReason?: string | null;
}): Record<string, unknown> {
  return {
    now: new Date(input.nowTs).toISOString(),
    marketsSeen: 1,
    discoveredCandidates: 1,
    fetchedCount: 1,
    afterWindowCount: 1,
    finalCandidatesCount: 1,
    acceptedSampleCount: 1,
    activeWindows: 1,
    currentMarketId: input.currentMarketId,
    selectedSlug: input.selectedSlug,
    windowEnd: input.windowEndTs,
    tauSec: input.remainingSec,
    action: input.action,
    holdReason: input.holdReason ?? null,
    holdDetailReason: input.holdDetailReason ?? null,
    dominantReject: input.holdDetailReason ?? null,
    openTrades: input.openTrades ?? 0,
    resolvedTrades: input.resolvedTrades ?? 0,
    chosenDirection: input.chosenDirection ?? null,
    chosenEdge: input.chosenEdge ?? null,
    threshold: input.threshold ?? null,
    oracleSource: "internal_fair_mid",
    oracleState: "OK",
    lastFetchAttemptTs: input.nowTs,
    lastFetchOkTs: input.nowTs,
    lastHttpStatus: 200,
    tradingPaused: input.tradingPaused ?? false,
    pauseReason: input.pauseReason ?? null,
    priceToBeat: 100,
    oracleEst: 101,
    sigma: 0.1,
    yesBid: 0.48,
    yesAsk: 0.49,
    yesMid: 0.485,
    pUpModel: 0.45,
    edge: input.chosenEdge ?? null
  };
}

function recordOpenTrade(engineAny: any, nowTs: number): void {
  engineAny.paperLedger.recordTrade({
    marketId: "paper-market-open",
    marketSlug: "btc-updown-5m-1772816700",
    marketQuestion: "Will Bitcoin go up or down in the next 5 minutes?",
    windowStartTs: nowTs - 20_000,
    windowEndTs: nowTs + 250_000,
    side: "NO",
    entryPrice: 0.42,
    qty: 5,
    notionalUsd: 2.1,
    feeBps: 0,
    slippageBps: 0,
    feesUsd: 0,
    entryCostUsd: 2.1,
    priceToBeat: 100,
    yesTokenId: "paper-yes",
    noTokenId: "paper-no",
    yesDisplayLabel: "UP",
    noDisplayLabel: "DOWN",
    heldTokenId: "paper-no",
    createdTs: nowTs
  });
}

function runRolloverAndTimestampScenario(): void {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-truth-rollover-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engine, engineAny, truth, dashboard } = buildHarness(ledgerPath);
  const originalDateNow = Date.now;
  try {
    const oldNowTs = Date.parse("2026-03-06T12:04:55.000Z");
    const freshNowTs = Date.parse("2026-03-06T12:05:02.000Z");

    engineAny.maybeEmitTickLog(
      makeTick({
        nowTs: oldNowTs,
        selectedSlug: "btc-updown-5m-1772817600",
        currentMarketId: "paper-market-old",
        windowEndTs: Date.parse("2026-03-06T12:05:00.000Z"),
        remainingSec: 5,
        action: "HOLD",
        holdReason: "TOO_LATE_FOR_ENTRY",
        holdDetailReason: "TOO_LATE_FOR_ENTRY"
      }) as any
    );

    engineAny.maybeEmitTickLog(
      makeTick({
        nowTs: freshNowTs,
        selectedSlug: "btc-updown-5m-1772817900",
        currentMarketId: "paper-market-new",
        windowEndTs: Date.parse("2026-03-06T12:10:00.000Z"),
        remainingSec: 298,
        action: "HOLD",
        chosenDirection: "DOWN",
        chosenEdge: 0.01,
        threshold: 0.05
      }) as any
    );

    Date.now = () => freshNowTs;
    const runtime = engine.getDashboardSnapshot();
    const snapshot = truth.getSnapshot(freshNowTs);
    const truthStatus = (dashboard as any).buildTruthStatus();

    assert(runtime.selection.selectedSlug === "btc-updown-5m-1772817900", "runtime selected slug should roll to fresh window");
    assert(runtime.selection.remainingSec === 298, `expected runtime remainingSec=298, got ${String(runtime.selection.remainingSec)}`);
    assert(runtime.holdReason !== "TOO_LATE_FOR_ENTRY", `fresh window must not inherit TOO_LATE_FOR_ENTRY, got ${String(runtime.holdReason)}`);
    assert(runtime.state.holdDetailReason !== "TOO_LATE_FOR_ENTRY", `fresh window must not inherit holdDetail TOO_LATE_FOR_ENTRY, got ${String(runtime.state.holdDetailReason)}`);
    assert(snapshot.poly.selection.selectedSlug === "btc-updown-5m-1772817900", "truth selected slug should roll to fresh window");
    assert(snapshot.poly.selection.remainingSec === 298, `expected truth remainingSec=298, got ${String(snapshot.poly.selection.remainingSec)}`);
    assert(snapshot.poly.holdReason !== "TOO_LATE_FOR_ENTRY", `truth fresh window must not inherit TOO_LATE_FOR_ENTRY, got ${String(snapshot.poly.holdReason)}`);
    assert(Number(runtime.lastUpdateTs) === freshNowTs, `expected runtime lastUpdateTs=${freshNowTs}, got ${String(runtime.lastUpdateTs)}`);
    assert(Number(truthStatus.poly.lastUpdateTs) === freshNowTs, `expected truth-status lastUpdateTs=${freshNowTs}, got ${String(truthStatus.poly.lastUpdateTs)}`);
  } finally {
    Date.now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

function runNetworkWarningScenario(): void {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-truth-network-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engine, engineAny, dashboard } = buildHarness(ledgerPath);
  try {
    const nowTs = Date.parse("2026-03-06T12:15:00.000Z");
    engineAny.setTradingPaused(true, "NETWORK_ERROR", nowTs);
    const runtimeWarning = engine.getDashboardSnapshot();
    const truthStatusWarning = (dashboard as any).buildTruthStatus();
    assert(runtimeWarning.tradingPaused === false, "paper NETWORK_ERROR should render as non-blocking warning");
    assert(runtimeWarning.pauseReason === null, "paper NETWORK_ERROR should clear blocking pauseReason in runtime");
    assert(runtimeWarning.warningState === "NETWORK_ERROR", `expected runtime warningState NETWORK_ERROR, got ${String(runtimeWarning.warningState)}`);
    assert(truthStatusWarning.poly.warningState === "NETWORK_ERROR", `expected truth-status warningState NETWORK_ERROR, got ${String(truthStatusWarning.poly.warningState)}`);

    engineAny.setTradingPaused(true, "ORACLE_UNAVAILABLE", nowTs + 1_000);
    const runtimePaused = engine.getDashboardSnapshot();
    assert(runtimePaused.tradingPaused === true, "ORACLE_UNAVAILABLE should remain a blocking pause");
    assert(runtimePaused.pauseReason === "ORACLE_UNAVAILABLE", `expected ORACLE_UNAVAILABLE pauseReason, got ${String(runtimePaused.pauseReason)}`);
    assert(runtimePaused.warningState === null, `expected no warningState for blocking pause, got ${String(runtimePaused.warningState)}`);
  } finally {
    rmSync(ledgerPath, { force: true });
  }
}

function runOpenActionScenario(): void {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-truth-open-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engine, engineAny, truth, dashboard } = buildHarness(ledgerPath);
  const originalDateNow = Date.now;
  try {
    const holdTs = Date.parse("2026-03-06T12:20:00.000Z");
    const openTs = Date.parse("2026-03-06T12:20:04.000Z");

    engineAny.maybeEmitTickLog(
      makeTick({
        nowTs: holdTs,
        selectedSlug: "btc-updown-5m-1772818200",
        currentMarketId: "paper-market-open",
        windowEndTs: Date.parse("2026-03-06T12:25:00.000Z"),
        remainingSec: 296,
        action: "HOLD",
        holdReason: "REENTRY_COOLDOWN",
        holdDetailReason: "REENTRY_COOLDOWN"
      }) as any
    );

    recordOpenTrade(engineAny, openTs);
    engineAny.emitPolymarketTruth({
      ts: openTs,
      force: true,
      action: "OPEN",
      tradeId: "paper-open-trade",
      slug: "btc-updown-5m-1772818200"
    });
    engineAny.maybeEmitTickLog(
      makeTick({
        nowTs: openTs,
        selectedSlug: "btc-updown-5m-1772818200",
        currentMarketId: "paper-market-open",
        windowEndTs: Date.parse("2026-03-06T12:25:00.000Z"),
        remainingSec: 292,
        action: "OPEN",
        holdReason: "REENTRY_COOLDOWN",
        holdDetailReason: "REENTRY_COOLDOWN",
        chosenDirection: "DOWN",
        openTrades: 1
      }) as any
    );

    Date.now = () => openTs;
    const runtime = engine.getDashboardSnapshot();
    const snapshot = truth.getSnapshot(openTs);
    const truthStatus = (dashboard as any).buildTruthStatus();

    assert(runtime.lastAction === "OPEN", `expected runtime lastAction OPEN, got ${String(runtime.lastAction)}`);
    assert(runtime.holdReason === null, `expected runtime holdReason cleared on OPEN, got ${String(runtime.holdReason)}`);
    assert(runtime.selection.chosenDirection === "DOWN", `expected runtime chosenDirection DOWN, got ${String(runtime.selection.chosenDirection)}`);
    assert(snapshot.poly.lastAction === "OPEN", `expected truth lastAction OPEN, got ${String(snapshot.poly.lastAction)}`);
    assert(snapshot.poly.holdReason === null, `expected truth holdReason cleared on OPEN, got ${String(snapshot.poly.holdReason)}`);
    assert(Number(snapshot.poly.openTrades || 0) === 1, `expected truth openTrades=1, got ${String(snapshot.poly.openTrades)}`);
    assert(truthStatus.poly.lastAction === "OPEN", `expected truth-status lastAction OPEN, got ${String(truthStatus.poly.lastAction)}`);
    assert(truthStatus.poly.holdReason === null, `expected truth-status holdReason cleared on OPEN, got ${String(truthStatus.poly.holdReason)}`);
    assert(String(truthStatus.poly.selection.chosenDirection || "") === "DOWN", `expected truth-status chosenDirection DOWN, got ${String(truthStatus.poly.selection.chosenDirection)}`);
  } finally {
    Date.now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

function runExpiryFreshnessScenario(): void {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-truth-expiry-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engine, engineAny, dashboard } = buildHarness(ledgerPath);
  const originalDateNow = Date.now;
  try {
    const openTs = Date.parse("2026-03-06T12:00:02.000Z");
    const windowStartTs = Date.parse("2026-03-06T12:00:00.000Z");
    const windowEndTs = Date.parse("2026-03-06T12:05:00.000Z");
    engineAny.paperLedger.recordTrade({
      marketId: "paper-market-expiry",
      marketSlug: "btc-updown-5m-1772817600",
      marketQuestion: "Will Bitcoin go up or down in the next 5 minutes?",
      windowStartTs,
      windowEndTs,
      side: "NO",
      entryPrice: 0.42,
      qty: 5,
      notionalUsd: 2.1,
      feeBps: 0,
      slippageBps: 0,
      feesUsd: 0,
      entryCostUsd: 2.1,
      priceToBeat: 100,
      yesTokenId: "paper-expiry-yes",
      noTokenId: "paper-expiry-no",
      yesDisplayLabel: "UP",
      noDisplayLabel: "DOWN",
      heldTokenId: "paper-expiry-no",
      createdTs: openTs
    });

    engineAny.maybeEmitTickLog(
      makeTick({
        nowTs: openTs,
        selectedSlug: "btc-updown-5m-1772817600",
        currentMarketId: "paper-market-expiry",
        windowEndTs,
        remainingSec: 298,
        action: "OPEN",
        chosenDirection: "DOWN",
        openTrades: 1
      }) as any
    );

    Date.now = () => openTs;
    const runtimeOpen = engine.getDashboardSnapshot();
    assert(runtimeOpen.selection.selectedSlug === "btc-updown-5m-1772817600", "open window should stay selected while active");
    assert(runtimeOpen.selection.remainingSec === 298, `expected fresh remainingSec=298, got ${String(runtimeOpen.selection.remainingSec)}`);

    const expiredNowTs = windowEndTs + 61_000;
    Date.now = () => expiredNowTs;
    const runtimeExpired = engine.getDashboardSnapshot();
    const truthStatusExpired = (dashboard as any).buildTruthStatus();

    assert(runtimeExpired.selection.selectedSlug === null, "expired window must stop being selected");
    assert(runtimeExpired.selection.remainingSec === null, `expired runtime remainingSec should clear, got ${String(runtimeExpired.selection.remainingSec)}`);
    assert(runtimeExpired.selection.lifecycleStatus === "AWAITING_RESOLUTION", `expected runtime lifecycle AWAITING_RESOLUTION, got ${String(runtimeExpired.selection.lifecycleStatus)}`);
    assert(runtimeExpired.holdReason !== "AWAITING_RESOLUTION", `expired runtime holdReason should stay current-window scoped, got ${String(runtimeExpired.holdReason)}`);
    assert(Number(runtimeExpired.awaitingResolutionCount || 0) === 1, `expected runtime awaitingResolutionCount=1, got ${String(runtimeExpired.awaitingResolutionCount)}`);
    assert(Number(runtimeExpired.resolutionQueueCount || 0) === 1, `expected runtime resolutionQueueCount=1, got ${String(runtimeExpired.resolutionQueueCount)}`);
    assert(truthStatusExpired.poly.selection.selectedSlug === null, "truth-status expired window must clear selected slug");
    assert(truthStatusExpired.poly.selection.remainingSec === null, `truth-status expired remainingSec should clear, got ${String(truthStatusExpired.poly.selection.remainingSec)}`);
    assert(truthStatusExpired.poly.lifecycleStatus === "AWAITING_RESOLUTION", `expected truth-status lifecycle AWAITING_RESOLUTION, got ${String(truthStatusExpired.poly.lifecycleStatus)}`);
    assert(truthStatusExpired.poly.holdReason !== "AWAITING_RESOLUTION", `truth-status holdReason should not be globally pinned to AWAITING_RESOLUTION, got ${String(truthStatusExpired.poly.holdReason)}`);
    assert(Number(truthStatusExpired.poly.awaitingResolutionCount || 0) === 1, `expected truth-status awaitingResolutionCount=1, got ${String(truthStatusExpired.poly.awaitingResolutionCount)}`);
    assert(Number(truthStatusExpired.poly.resolutionQueueCount || 0) === 1, `expected truth-status resolutionQueueCount=1, got ${String(truthStatusExpired.poly.resolutionQueueCount)}`);
  } finally {
    Date.now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

function runCooldownExpiryFreshnessScenario(): void {
  const ledgerPath = path.join(tmpdir(), `revx-poly-paper-truth-cooldown-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const { engine, engineAny, truth, dashboard } = buildHarness(ledgerPath);
  const originalDateNow = Date.now;
  try {
    const openTs = Date.parse("2026-03-06T12:01:00.000Z");
    const closeTs = Date.parse("2026-03-06T12:01:30.000Z");
    const cooledOffTs = Date.parse("2026-03-06T12:01:50.000Z");

    const trade = engineAny.paperLedger.recordTrade({
      marketId: "paper-market-cooldown",
      marketSlug: "btc-updown-5m-1772817600",
      marketQuestion: "Will Bitcoin go up or down in the next 5 minutes?",
      windowStartTs: Date.parse("2026-03-06T12:00:00.000Z"),
      windowEndTs: Date.parse("2026-03-06T12:05:00.000Z"),
      side: "NO",
      entryPrice: 0.42,
      qty: 5,
      notionalUsd: 2.1,
      feeBps: 0,
      slippageBps: 0,
      feesUsd: 0,
      entryCostUsd: 2.1,
      priceToBeat: 100,
      yesTokenId: "paper-cooldown-yes",
      noTokenId: "paper-cooldown-no",
      yesDisplayLabel: "UP",
      noDisplayLabel: "DOWN",
      heldTokenId: "paper-cooldown-no",
      createdTs: openTs
    });
    engineAny.paperLedger.closeTrade({
      tradeId: trade.id,
      resolvedAt: closeTs,
      closeReason: "TAKE_PROFIT",
      exitPrice: 0.75,
      exitProceedsUsd: 3.75,
      exitFeesUsd: 0,
      pnlUsd: 1.65
    });
    engineAny.updateTruthWindowContextFromTrade(
      {
        marketId: "paper-market-cooldown",
        marketSlug: "btc-updown-5m-1772817600",
        marketQuestion: "Will Bitcoin go up or down in the next 5 minutes?",
        windowStartTs: Date.parse("2026-03-06T12:00:00.000Z"),
        windowEndTs: Date.parse("2026-03-06T12:05:00.000Z"),
        side: "NO",
        yesDisplayLabel: "UP",
        noDisplayLabel: "DOWN"
      },
      "PAPER_EXIT"
    );
    engineAny.truthHoldReason = "REENTRY_COOLDOWN";
    engineAny.truthLastAction = "CLOSE";
    engineAny.truthLastActionTs = closeTs;
    engineAny.polyState.lastUpdateTs = cooledOffTs;

    Date.now = () => cooledOffTs;
    engineAny.emitPolymarketTruth({ ts: cooledOffTs, force: true });
    const runtime = engine.getDashboardSnapshot();
    const snapshot = truth.getSnapshot(cooledOffTs);
    const truthStatus = (dashboard as any).buildTruthStatus();

    assert(runtime.lastAction === "HOLD", `expected runtime lastAction HOLD after cooldown expiry, got ${String(runtime.lastAction)}`);
    assert(runtime.holdReason !== "REENTRY_COOLDOWN", `runtime holdReason must clear after cooldown expiry, got ${String(runtime.holdReason)}`);
    assert(Number(runtime.lastActionTs) === cooledOffTs, `expected runtime lastActionTs to refresh to ${cooledOffTs}, got ${String(runtime.lastActionTs)}`);
    assert(Number(runtime.selection.remainingSec || 0) === 190, `expected runtime remainingSec=190, got ${String(runtime.selection.remainingSec)}`);
    assert(snapshot.poly.selection.remainingSec === 190, `expected truth remainingSec=190, got ${String(snapshot.poly.selection.remainingSec)}`);
    assert(truthStatus.poly.holdReason !== "REENTRY_COOLDOWN", `truth-status must not stay pinned to REENTRY_COOLDOWN, got ${String(truthStatus.poly.holdReason)}`);
    assert(Number(truthStatus.poly.lastUpdateTs || 0) === cooledOffTs, `expected truth-status lastUpdateTs=${cooledOffTs}, got ${String(truthStatus.poly.lastUpdateTs)}`);
  } finally {
    Date.now = originalDateNow;
    rmSync(ledgerPath, { force: true });
  }
}

function run(): void {
  runRolloverAndTimestampScenario();
  runNetworkWarningScenario();
  runOpenActionScenario();
  runExpiryFreshnessScenario();
  runCooldownExpiryFreshnessScenario();
  // eslint-disable-next-line no-console
  console.log("Polymarket paper truth/status tests: PASS");
}

run();
