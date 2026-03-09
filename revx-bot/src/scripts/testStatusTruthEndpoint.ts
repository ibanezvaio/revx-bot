import { loadConfig } from "../config";
import { getTradingTruthReporter } from "../logging/truth";
import { buildLogger } from "../logger";
import { createStore } from "../store/factory";
import { DashboardServer } from "../web/DashboardServer";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) prev[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function run(): Promise<void> {
  await withEnv(
    {
      DRY_RUN: "true",
      STORE_BACKEND: "json",
      DASHBOARD_ENABLED: "true",
      DASHBOARD_PORT: "0",
      LOG_LEVEL: "error",
      LOG_MODULES: "",
      POLYMARKET_ENABLED: "true",
      POLYMARKET_MODE: "paper"
    },
    async () => {
      const config = loadConfig();
      const logger = buildLogger(config);
      const store = createStore(config, logger);
      store.init();

      const truth = getTradingTruthReporter(config, logger);
      const ts = Date.now();
      const activeSlug = `btc-updown-5m-${Math.floor(ts / 1000 / 300) * 300}`;
      truth.updateRevx({
        ts,
        force: true,
        symbol: config.symbol,
        mode: config.dryRun ? "DRY" : "LIVE",
        buyOpen: 1,
        sellOpen: 2,
        lastOrderAction: "PLACED",
        lastVenueOrderId: "venue-1"
      });
      truth.updatePolymarket({
        ts,
        force: true,
        mode: "PAPER",
        lastAction: "HOLD",
        holdReason: "NO_CANDIDATES",
        openTrades: 0,
        resolvedTrades: 3,
        pnlTotalUsd: 1.25,
        finalCandidatesCount: 0,
        selectedSlug: null,
        selectedMarketId: null,
        windowEndTs: null,
        oracleSource: "oracle_proxy",
        oracleState: "OK"
      });

      const dashboard = new DashboardServer(config, logger, store, "truth-test");
      try {
        const payload = (
          dashboard as unknown as {
            buildTruthStatus: () => Record<string, any>;
          }
        ).buildTruthStatus();
        assert(payload && typeof payload === "object", "truth payload must be an object");
        assert(payload.revx && typeof payload.revx === "object", "truth.revx missing");
        assert(payload.poly && typeof payload.poly === "object", "truth.poly missing");
        assert(payload.flags && typeof payload.flags === "object", "truth.flags missing");
        assert(payload.revx.balances && typeof payload.revx.balances === "object", "truth.revx.balances missing");
        assert(payload.revx.deltas && typeof payload.revx.deltas === "object", "truth.revx.deltas missing");
        assert(payload.poly.selection && typeof payload.poly.selection === "object", "truth.poly.selection missing");
        assert(payload.poly.dataHealth && typeof payload.poly.dataHealth === "object", "truth.poly.dataHealth missing");
        assert(
          typeof payload.flags.REVX_MONEY === "boolean" && typeof payload.flags.POLY_MONEY === "boolean",
          "truth.flags booleans missing"
        );

        truth.updatePolymarket({
          ts,
          force: true,
          mode: "LIVE",
          warningState: "NETWORK_ERROR",
          selectedSlug: activeSlug,
          selectedMarketId: "live-market-cached",
          windowStartTs: Math.floor(ts / 300000) * 300000,
          windowEndTs: Math.floor(ts / 300000) * 300000 + 300000,
          remainingSec: 120,
          chosenSide: "YES",
          chosenDirection: "UP",
          holdReason: "SIDE_NOT_BOOKABLE",
          currentWindowHoldReason: "SIDE_NOT_BOOKABLE",
          holdCategory: "DATA_HEALTH",
          strategyAction: "HOLD",
          selectedTokenId: "live-market-cached-yes",
          candidateRefreshed: true,
          lastPreorderValidationReason: "ok",
          pollMode: "FAST",
          lastUpdateTs: ts - 45_000
        });
        const cachedDecisioningPayload = (
          dashboard as unknown as {
            buildTruthStatus: () => Record<string, any>;
          }
        ).buildTruthStatus();
        assert(cachedDecisioningPayload.poly.status === "RUNNING", `active cached selection should stay RUNNING, got ${String(cachedDecisioningPayload.poly.status)}`);
        assert(
          String(cachedDecisioningPayload.poly.warningState || "").includes("DISCOVERY_STALE"),
          `active cached selection should expose DISCOVERY_STALE warning, got ${String(cachedDecisioningPayload.poly.warningState)}`
        );
        assert(
          String(cachedDecisioningPayload.poly.staleState || "") === "DECISIONING_WITH_CACHED_SELECTION",
          `active cached selection should expose staleState DECISIONING_WITH_CACHED_SELECTION, got ${String(cachedDecisioningPayload.poly.staleState)}`
        );
        assert(cachedDecisioningPayload.poly.selection.selectedSlug === activeSlug, `active cached selection should preserve selectedSlug, got ${String(cachedDecisioningPayload.poly.selection.selectedSlug)}`);
        assert(cachedDecisioningPayload.poly.selection.chosenSide === "YES", `active cached selection should preserve chosenSide, got ${String(cachedDecisioningPayload.poly.selection.chosenSide)}`);
        assert(cachedDecisioningPayload.poly.selectedSlug === activeSlug, `active cached selection should expose root selectedSlug, got ${String(cachedDecisioningPayload.poly.selectedSlug)}`);
        assert(cachedDecisioningPayload.poly.currentMarketSlug === activeSlug, `active cached selection should expose currentMarketSlug, got ${String(cachedDecisioningPayload.poly.currentMarketSlug)}`);
        assert(cachedDecisioningPayload.poly.chosenSide === "YES", `active cached selection should expose root chosenSide, got ${String(cachedDecisioningPayload.poly.chosenSide)}`);
        assert(cachedDecisioningPayload.poly.whyNotTrading === "SIDE_NOT_BOOKABLE", `active cached selection should expose whyNotTrading, got ${String(cachedDecisioningPayload.poly.whyNotTrading)}`);
        assert(cachedDecisioningPayload.poly.currentMarketStatus === "RUNNING", `active cached selection should expose currentMarketStatus RUNNING, got ${String(cachedDecisioningPayload.poly.currentMarketStatus)}`);
        assert(Number(cachedDecisioningPayload.poly.currentMarketRemainingSec || 0) > 0, `active cached selection should expose positive currentMarketRemainingSec, got ${String(cachedDecisioningPayload.poly.currentMarketRemainingSec)}`);
        assert(Number(cachedDecisioningPayload.poly.currentMarketExpiresAt || 0) > ts, `active cached selection should expose currentMarketExpiresAt, got ${String(cachedDecisioningPayload.poly.currentMarketExpiresAt)}`);
        assert(Number(cachedDecisioningPayload.poly.lastSelectedMarketTs || 0) > 0, `active cached selection should expose lastSelectedMarketTs, got ${String(cachedDecisioningPayload.poly.lastSelectedMarketTs)}`);
        assert(
          String(cachedDecisioningPayload.poly.statusLine || "").includes(activeSlug),
          `active cached selection should expose a compact statusLine, got ${String(cachedDecisioningPayload.poly.statusLine)}`
        );
        assert(
          String(cachedDecisioningPayload.poly.statusLine || "").includes("HOLD SIDE_NOT_BOOKABLE"),
          `active cached selection should expose HOLD reason in compact statusLine, got ${String(cachedDecisioningPayload.poly.statusLine)}`
        );
        const cachedSummaryPayload = (
          dashboard as unknown as {
            buildPolymarketSummaryPayload: (nowTs?: number) => Record<string, any>;
          }
        ).buildPolymarketSummaryPayload(ts);
        assert(cachedSummaryPayload.currentMarketSlug === activeSlug, `summary payload should expose currentMarketSlug, got ${String(cachedSummaryPayload.currentMarketSlug)}`);
        assert(Number(cachedSummaryPayload.currentMarketRemainingSec || 0) > 0, `summary payload should expose currentMarketRemainingSec, got ${String(cachedSummaryPayload.currentMarketRemainingSec)}`);
        assert(cachedSummaryPayload.whyNotTrading === "SIDE_NOT_BOOKABLE", `summary payload should expose whyNotTrading, got ${String(cachedSummaryPayload.whyNotTrading)}`);
        assert(cachedSummaryPayload.pollMode === "FAST", `summary payload should expose pollMode, got ${String(cachedSummaryPayload.pollMode)}`);
        assert(cachedSummaryPayload.holdCategory === "DATA_HEALTH", `summary payload should expose holdCategory, got ${String(cachedSummaryPayload.holdCategory)}`);
        assert(cachedSummaryPayload.selectedTokenId === "live-market-cached-yes", `summary payload should expose selectedTokenId, got ${String(cachedSummaryPayload.selectedTokenId)}`);
        assert(cachedSummaryPayload.candidateRefreshed === true, `summary payload should expose candidateRefreshed, got ${String(cachedSummaryPayload.candidateRefreshed)}`);

        truth.updatePolymarket({
          ts,
          force: true,
          warningState: null,
          selectedSlug: null,
          selectedMarketId: null,
          windowStartTs: null,
          windowEndTs: null,
          remainingSec: null,
          chosenSide: null,
          chosenDirection: null,
          holdReason: "NO_ACTIVE_BTC5M_MARKET",
          currentWindowHoldReason: null,
          lastUpdateTs: ts - 45_000
        });
        const discoveryStalePayload = (
          dashboard as unknown as {
            buildTruthStatus: () => Record<string, any>;
          }
        ).buildTruthStatus();
        assert(discoveryStalePayload.poly.status === "STALE", `no-selection stale truth should report STALE, got ${String(discoveryStalePayload.poly.status)}`);
        assert(
          String(discoveryStalePayload.poly.warningState || "") === "DISCOVERY_STALE",
          `no-selection stale truth should expose DISCOVERY_STALE, got ${String(discoveryStalePayload.poly.warningState)}`
        );
      } finally {
        store.close();
      }
    }
  );

  // eslint-disable-next-line no-console
  console.log("Status truth endpoint test: PASS");
}

void run();
