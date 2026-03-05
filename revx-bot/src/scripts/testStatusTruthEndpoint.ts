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
      } finally {
        store.close();
      }
    }
  );

  // eslint-disable-next-line no-console
  console.log("Status truth endpoint test: PASS");
}

void run();
