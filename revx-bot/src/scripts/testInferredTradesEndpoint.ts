import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotConfig, loadConfig } from "../config";
import { buildLogger } from "../logger";
import { MarketData } from "../md/MarketData";
import { PerformanceEngine } from "../performance/PerformanceEngine";
import { RevXClient } from "../revx/RevXClient";
import { createStore } from "../store/factory";
import { DashboardServer } from "../web/DashboardServer";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function makeConfig(runtimeDir: string): BotConfig {
  process.env.DRY_RUN = "true";
  process.env.DASHBOARD_ENABLED = "true";
  process.env.DASHBOARD_PORT = "0";
  process.env.STORE_BACKEND = "json";
  process.env.PERFORMANCE_ENABLED = "true";
  process.env.REVX_RUNTIME_DIR = runtimeDir;
  process.env.DB_PATH = join(runtimeDir, "revx-test.sqlite");
  const base = loadConfig();
  return {
    ...base,
    dryRun: true,
    dashboardEnabled: true,
    dashboardPort: 0,
    storeBackend: "json",
    runtimeBaseDir: runtimeDir,
    dbPath: join(runtimeDir, "revx-test.sqlite"),
    performanceEnabled: true
  };
}

async function invokeGet(server: DashboardServer, path: string): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
}> {
  const sink: {
    statusCode: number;
    body: string;
  } = {
    statusCode: 0,
    body: ""
  };
  const responseMock: {
    statusCode: number;
    setHeader: (name: string, value: string) => void;
    end: (body?: Buffer | string) => void;
  } = {
    statusCode: 0,
    setHeader: (_name: string, _value: string): void => undefined,
    end: (body?: Buffer | string): void => {
      if (typeof body === "string") {
        sink.body = body;
        return;
      }
      if (Buffer.isBuffer(body)) {
        sink.body = body.toString("utf8");
      }
    }
  };

  await (server as unknown as {
    handle: (req: unknown, res: unknown) => Promise<void>;
  }).handle(
    {
      method: "GET",
      url: path,
      headers: { host: "localhost" }
    },
    responseMock
  );
  sink.statusCode = responseMock.statusCode;
  const body = sink.body && sink.body.trim().length > 0
    ? (JSON.parse(sink.body) as Record<string, unknown>)
    : {};
  return { statusCode: sink.statusCode, body };
}

async function run(): Promise<void> {
  const runtimeDir = mkdtempSync(join(tmpdir(), "revx-inferred-trades-"));
  const config = makeConfig(runtimeDir);
  const logger = buildLogger(config);
  const store = createStore(config, logger);
  store.init();
  const client = new RevXClient(config, logger);
  const marketData = new MarketData(client, logger);
  const performance = new PerformanceEngine(config, logger, store, marketData);
  const server = new DashboardServer(config, logger, store, "test-inferred-trades", undefined, undefined, undefined, undefined, undefined, performance);
  try {
    const nowTs = Date.now();
    performance.recordFill({
      ts: nowTs,
      symbol: config.symbol,
      side: "BUY",
      price: 100_000,
      baseQty: 0.001,
      feeUsd: 0,
      venueOrderId: "inferred-balance-delta",
      clientOrderId: "inferred:test",
      revxMidAtFill: 100_000,
      posture: "INFERRED",
      source: "inferred",
      sourceJson: JSON.stringify({
        source: "inferred",
        symbol: config.symbol,
        side: "BUY",
        sizeBTC: 0.001,
        deltaUSD: -100,
        deltaBTC: 0.001,
        venueOrderId: "inferred-balance-delta",
        clientOrderId: "inferred:test"
      })
    });

    const includeResp = await invokeGet(
      server,
      `/api/analysis/fills?window=24h&limit=20&symbol=${encodeURIComponent(config.symbol)}&includeInferred=true`
    );
    assert(includeResp.statusCode === 200, `expected include response 200, got ${includeResp.statusCode}`);
    const includeRows = Array.isArray(includeResp.body.rows)
      ? (includeResp.body.rows as Array<Record<string, unknown>>)
      : [];
    assert(includeRows.length >= 1, "expected inferred fill to be returned when includeInferred=true");
    assert(
      String(includeRows[0].source || "").toLowerCase() === "inferred",
      `expected first fill source=inferred, got ${String(includeRows[0].source || "-")}`
    );

    const excludeResp = await invokeGet(
      server,
      `/api/analysis/fills?window=24h&limit=20&symbol=${encodeURIComponent(config.symbol)}&includeInferred=false`
    );
    assert(excludeResp.statusCode === 200, `expected exclude response 200, got ${excludeResp.statusCode}`);
    const excludeRows = Array.isArray(excludeResp.body.rows)
      ? (excludeResp.body.rows as Array<Record<string, unknown>>)
      : [];
    assert(excludeRows.length === 0, `expected no rows when includeInferred=false, got ${excludeRows.length}`);

    // eslint-disable-next-line no-console
    console.log("Inferred trades endpoint test: PASS");
  } finally {
    store.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

void run();
