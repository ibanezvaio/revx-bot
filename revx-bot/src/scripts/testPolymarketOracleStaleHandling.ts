import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { PolymarketEngine } from "../polymarket/PolymarketEngine";
import { BtcWindowMarket } from "../polymarket/types";

process.env.DRY_RUN = "true";
process.env.POLYMARKET_ENABLED = "true";
process.env.POLYMARKET_MODE = "paper";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(): Promise<void> {
  const base = loadConfig();
  const ledgerPath = path.join(tmpdir(), `revx-polymarket-stale-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });

  const config = {
    ...base,
    polymarket: {
      ...base.polymarket,
      enabled: true,
      mode: "paper" as const,
      loopMs: 250,
      threshold: {
        ...base.polymarket.threshold,
        baseEdge: 0.01,
        volK: 0,
        closePenalty: 0,
        maxSpread: 0.2
      },
      sizing: {
        ...base.polymarket.sizing,
        maxNotionalPerWindow: 5,
        minOrderNotional: 0.1
      },
      risk: {
        ...base.polymarket.risk,
        staleMs: 5_000,
        noNewOrdersInLastSec: 0,
        maxExposure: 1_000
      },
      paper: {
        ...base.polymarket.paper,
        ledgerPath,
        forceTrade: false,
        minEdgeThreshold: 0.01,
        minNetEdge: 0,
        probExtreme: 0.5,
        extremeHighPrice: 0.5001,
        extremeLowPrice: 0.5,
        entryMinElapsedSec: 0,
        entryMaxElapsedSec: 240,
        entryMaxRemainingSec: 90,
        entryMinRemainingSec: 0,
        resolveGraceMs: 2_000
      }
    }
  };
  const logger = buildLogger(config);
  const engine = new PolymarketEngine(config, logger);
  const engineAny = engine as any;

  const t0 = Date.now();
  const market: BtcWindowMarket = {
    marketId: "test-market-1",
    slug: "btc-updown-5m-test",
    eventSlug: "btc-updown-5m-test",
    question: "BTC Up/Down 5m test",
    priceToBeat: 100,
    startTs: t0 - 30_000,
    endTs: t0 + 40_000,
    yesTokenId: "token-yes",
    noTokenId: "token-no",
    acceptingOrders: true,
    enableOrderBook: true,
    closed: false
  };

  const diagnostics = {
    ts: new Date(t0).toISOString(),
    counters: {
      fetchedTotal: 1,
      pagesScanned: 1,
      recentEventsCount: 1,
      prefixMatchesCount: 1,
      tradableTotal: 1,
      btcTotal: 1,
      cadenceTotal: 1,
      directionTotal: 1,
      btc5mCandidates: 1,
      activeWindows: 1
    },
    candidates: [],
    rejectedNotTradable: [],
    activeMarkets: [market],
    selectedSlug: market.eventSlug || null,
    selectedWindowStart: market.startTs || null,
    selectedWindowEnd: market.endTs || null,
    selectedAcceptingOrders: true,
    selectedEnableOrderBook: true,
    selectedMarket: market
  };

  engineAny.scanner = {
    scanActiveBtc5m: async () => [market],
    getLastDiagnostics: () => diagnostics
  };
  engineAny.client = {
    getYesOrderBook: async () => ({
      marketId: market.marketId,
      tokenId: market.yesTokenId,
      yesBid: 0.47,
      yesAsk: 0.49,
      yesMid: 0.48,
      spread: 0.02,
      bids: [{ price: 0.47, size: 100 }],
      asks: [{ price: 0.49, size: 100 }],
      ts: Date.now()
    }),
    getTokenOrderBook: async () => ({
      tokenId: market.noTokenId,
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

  let killSwitchTriggers = 0;
  engineAny.risk = {
    isKillSwitchActive: () => false,
    triggerKillSwitch: () => {
      killSwitchTriggers += 1;
    },
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

  const t1 = t0 + 1_000;
  const t2 = t0 + 45_000;
  const t3 = t0 + 46_000;
  const snapshots = [
    {
      price: 100.5,
      source: "internal_fair_mid",
      ts: t0 - 10_000,
      rawTs: t0 - 10_000,
      staleMs: 10_000,
      state: "ORACLE_STALE",
      fallbackSigmaPricePerSqrtSec: 0.1
    },
    {
      price: 101.2,
      source: "internal_fair_mid",
      ts: t1,
      rawTs: t1,
      staleMs: 0,
      state: "OK",
      fallbackSigmaPricePerSqrtSec: 0.1
    },
    {
      price: 101.2,
      source: "internal_fair_mid",
      ts: t1,
      rawTs: t1,
      staleMs: t2 - t1,
      state: "ORACLE_STALE",
      fallbackSigmaPricePerSqrtSec: 0.1
    },
    {
      price: 99.2,
      source: "internal_fair_mid",
      ts: t3,
      rawTs: t3,
      staleMs: 0,
      state: "OK",
      fallbackSigmaPricePerSqrtSec: 0.1
    }
  ];
  let snapshotIdx = 0;
  engineAny.oracleRouter = {
    getOracleNow: async () => {
      const row = snapshots[Math.min(snapshotIdx, snapshots.length - 1)];
      snapshotIdx += 1;
      return row;
    },
    getFastMidNow: () => ({
      price: 100.8,
      ts: Date.now(),
      source: "internal_fair_mid"
    })
  };

  await engineAny.runOnce(t0);
  assert(killSwitchTriggers === 0, "paper mode must not trigger kill-switch on stale oracle");
  assert(engineAny.paperLedger.getOpenTrades().length === 0, "stale oracle should block new entries");

  await engineAny.runOnce(t1);
  assert(engineAny.paperLedger.getOpenTrades().length === 1, "fresh oracle should allow trade entry");

  await engineAny.runOnce(t2);
  assert(engineAny.paperLedger.getOpenTrades().length === 1, "open trade should remain pending while oracle is stale");
  assert(engineAny.paperLedger.getResolvedTrades().length === 0, "trade must not resolve without valid oracle snapshot");

  await engineAny.runOnce(t3);
  assert(engineAny.paperLedger.getOpenTrades().length === 0, "trade should resolve once oracle resumes");
  assert(engineAny.paperLedger.getResolvedTrades().length === 1, "expected resolved trade after oracle resumes");
  assert(killSwitchTriggers === 0, "paper mode should remain without kill-switch during stall/resume");

  rmSync(ledgerPath, { force: true });
  // eslint-disable-next-line no-console
  console.log("Polymarket stale oracle handling test: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Polymarket stale oracle handling test: FAIL", error);
  process.exit(1);
});
