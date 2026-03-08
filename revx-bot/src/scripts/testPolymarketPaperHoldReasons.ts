import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { PolymarketEngine } from "../polymarket/PolymarketEngine";

process.env.DRY_RUN = "true";
process.env.POLYMARKET_ENABLED = "true";
process.env.POLYMARKET_MODE = "paper";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const base = loadConfig();
  const config = {
    ...base,
    polymarket: {
      ...base.polymarket,
      mode: "paper" as const,
      enabled: true
    }
  };
  const engine = new PolymarketEngine(config, buildLogger(config));
  const engineAny = engine as any;
  const nowTs = Date.now();
  const nowIso = new Date(nowTs).toISOString();

  const baseLine = {
    action: "HOLD",
    holdReason: null,
    holdDetailReason: null,
    dominantReject: null,
    tradingPaused: false,
    pauseReason: null,
    activeWindows: 1,
    openTrades: 0,
    now: nowIso,
    currentMarketId: "m1",
    selectedSlug: "btc-updown-5m-test",
    tauSec: 120,
    threshold: 0.05,
    chosenEdge: 0.08,
    fetchedCount: 1,
    afterWindowCount: 1,
    finalCandidatesCount: 1,
    lastFetchOkTs: nowTs - 1_000,
    oracleState: "OK",
    windowStart: nowTs - 60_000,
    windowEnd: nowTs + 120_000,
    acceptingOrders: true,
    enableOrderBook: true,
    marketsSeen: 1,
    priceToBeat: 100,
    oracleEst: 100,
    sigma: 0.1,
    yesBid: 0.49,
    yesAsk: 0.5,
    pUpModel: 0.6,
    edge: 0.1
  };

  const oracleStale = engineAny.deriveCanonicalHoldReason({
    ...baseLine,
    oracleState: "ORACLE_STALE"
  });
  assert(oracleStale === "ORACLE_STALE", `expected ORACLE_STALE, got ${String(oracleStale)}`);

  const fetchStale = engineAny.deriveCanonicalHoldReason({
    ...baseLine,
    lastFetchOkTs: nowTs - Math.max(120_000, config.polymarket.risk.staleKillAfterMs + 5_000)
  });
  assert(fetchStale === "FETCH_STALE", `expected FETCH_STALE, got ${String(fetchStale)}`);

  const thresholdHold = engineAny.deriveCanonicalHoldReason({
    ...baseLine,
    holdDetailReason: "NET_EDGE_BELOW_MIN_NET_EDGE"
  });
  assert(thresholdHold === "EDGE_BELOW_THRESHOLD", `expected EDGE_BELOW_THRESHOLD, got ${String(thresholdHold)}`);

  const timingHold = engineAny.deriveCanonicalHoldReason({
    ...baseLine,
    holdDetailReason: "TOO_LATE_FOR_ENTRY",
    oracleState: "ORACLE_STALE"
  });
  assert(
    timingHold === "TOO_LATE_FOR_ENTRY",
    `expected TOO_LATE_FOR_ENTRY, got ${String(timingHold)}`
  );

  const openPositionHold = engineAny.deriveCanonicalHoldReason({
    ...baseLine,
    holdDetailReason: "OPEN_POSITION_IN_WINDOW",
    oracleState: "ORACLE_STALE"
  });
  assert(
    openPositionHold === "OPEN_POSITION_IN_WINDOW",
    `expected OPEN_POSITION_IN_WINDOW, got ${String(openPositionHold)}`
  );

  const cooldownHold = engineAny.deriveCanonicalHoldReason({
    ...baseLine,
    holdDetailReason: "REENTRY_COOLDOWN"
  });
  assert(cooldownHold === "REENTRY_COOLDOWN", `expected REENTRY_COOLDOWN, got ${String(cooldownHold)}`);

  const expiredHold = engineAny.deriveCanonicalHoldReason({
    ...baseLine,
    holdReason: "EXPIRED_WINDOW",
    holdDetailReason: "EXPIRED_WINDOW",
    tauSec: -3,
    afterWindowCount: 0
  });
  assert(expiredHold === "EXPIRED_WINDOW", `expected EXPIRED_WINDOW, got ${String(expiredHold)}`);

  const awaitingHold = engineAny.deriveCanonicalHoldReason({
    ...baseLine,
    holdReason: "AWAITING_RESOLUTION",
    holdDetailReason: "MARKET_CLOSED_AWAITING_OUTCOME",
    activeWindows: 0,
    openTrades: 1,
    afterWindowCount: 0
  });
  assert(awaitingHold === "AWAITING_RESOLUTION", `expected AWAITING_RESOLUTION, got ${String(awaitingHold)}`);

  const noActiveMarketHold = engineAny.deriveCanonicalHoldReason({
    ...baseLine,
    holdReason: "NO_ACTIVE_BTC5M_MARKET",
    holdDetailReason: "BTC5M_NOT_FOUND",
    activeWindows: 0,
    afterWindowCount: 0,
    finalCandidatesCount: 0
  });
  assert(
    noActiveMarketHold === "NO_ACTIVE_BTC5M_MARKET",
    `expected NO_ACTIVE_BTC5M_MARKET, got ${String(noActiveMarketHold)}`
  );

  // eslint-disable-next-line no-console
  console.log("Polymarket paper hold-reason tests: PASS");
}

run();
