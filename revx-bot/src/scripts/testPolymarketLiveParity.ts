import { readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { LiveExecutionAdapter, PaperExecutionAdapter } from "../polymarket/ExecutionAdapters";
import { PolymarketEngine } from "../polymarket/PolymarketEngine";
import { Strategy } from "../polymarket/Strategy";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    prev[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function run(): Promise<void> {
  const base = loadConfig();
  const paperConfig = {
    ...base,
    polymarket: {
      ...base.polymarket,
      mode: "paper" as const
    }
  };
  const liveConfig = {
    ...base,
    polymarket: {
      ...base.polymarket,
      mode: "live" as const
    }
  };

  const paperStrategy = new Strategy(paperConfig);
  const liveStrategy = new Strategy(liveConfig);
  const input = {
    pUpModel: 0.12,
    orderBook: {
      marketId: "mkt",
      tokenId: "yes-token",
      yesBid: 0.84,
      yesAsk: 0.86,
      yesMid: 0.85,
      spread: 0.02,
      bids: [],
      asks: [],
      ts: Date.now()
    },
    sigmaPerSqrtSec: 0.0001,
    tauSec: 180
  };
  const paperDecision = paperStrategy.decide(input);
  const liveDecision = liveStrategy.decide(input);
  assert(paperDecision.action === liveDecision.action, "paper/live strategy action mismatch");
  assert(paperDecision.chosenSide === liveDecision.chosenSide, "paper/live chosen side mismatch");
  assert(liveDecision.action === "BUY_NO", "expected bearish BUY_NO decision from shared strategy");

  const calls: Array<Record<string, unknown>> = [];
  const adapter = new LiveExecutionAdapter({
    executeEntry: async (params: Record<string, unknown>) => {
      calls.push({ type: "entry", ...params });
      return { action: "BUY_YES", accepted: true, filledShares: 1 };
    },
    executeExit: async (params: Record<string, unknown>) => {
      calls.push({ type: "exit", ...params });
      return { action: "SELL_NO", accepted: true, filledShares: Number(params.shares || 0) };
    }
  } as any);

  await adapter.executeEntry({
    marketId: "live-market",
    tokenId: "yes-token",
    side: "YES",
    contractPrice: 0.44,
    notionalUsd: 1.25
  });
  await adapter.executeEntry({
    marketId: "live-market",
    tokenId: "no-token",
    side: "NO",
    contractPrice: 0.56,
    notionalUsd: 1.25
  });
  await adapter.executeExit({
    marketId: "live-market",
    tokenId: "no-token",
    side: "NO",
    shares: 3.5,
    contractPrice: 0.61
  });

  const yesEntry = calls.find((row) => row.type === "entry" && row.side === "YES");
  const noEntry = calls.find((row) => row.type === "entry" && row.side === "NO");
  const noExit = calls.find((row) => row.type === "exit" && row.side === "NO");
  assert(Boolean(yesEntry && yesEntry.tokenId === "yes-token"), "YES entry did not map to YES token");
  assert(Boolean(noEntry && noEntry.tokenId === "no-token"), "NO entry did not map to NO token");
  assert(Boolean(noExit && Number(noExit.shares) === 3.5), "exit did not use held token/size");

  const engineSource = readFileSync(path.resolve(process.cwd(), "src/polymarket/PolymarketEngine.ts"), "utf8");
  assert(!engineSource.includes("LIVE_NO_SIDE_DISABLED"), "legacy LIVE_NO_SIDE_DISABLED branch still present");

  const paperAdapter = new PaperExecutionAdapter();
  const paperOk = await paperAdapter.executeEntry({
    side: "NO",
    execute: () => true
  });
  assert(paperOk.accepted && paperOk.action === "BUY_NO", "paper adapter changed expected BUY_NO behaviour");

  const liveEnvBase: Record<string, string | undefined> = {
    DRY_RUN: "true",
    POLYMARKET_ENABLED: "true",
    POLYMARKET_MODE: "live",
    POLYMARKET_LIVE_CONFIRMED: "true",
    POLYMARKET_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111",
    POLYMARKET_FUNDER: "0x2222222222222222222222222222222222222222",
    POLYMARKET_API_KEY: "test_api_key",
    POLYMARKET_API_SECRET: "test_api_secret",
    POLYMARKET_PASSPHRASE: "test_passphrase",
    POLYMARKET_MAX_NOTIONAL_PER_WINDOW: undefined,
    POLYMARKET_MAX_DAILY_LOSS: undefined,
    POLYMARKET_CANCEL_ALL_ON_START: undefined
  };

  withEnv(
    {
      ...liveEnvBase,
      POLYMARKET_LIVE_EXECUTION_ENABLED: "false"
    },
    () => {
      const cfg = loadConfig();
      const engine = new PolymarketEngine(cfg, buildLogger(cfg));
      assert(!cfg.polymarket.liveExecutionEnabled, "expected live execution disabled in shadow mode");
      assert(!(engine as any).canMutateVenueState(), "live shadow mode must refuse venue mutations");
      assert(cfg.polymarket.sizing.maxNotionalPerWindow <= 0.25, "live default max notional clamp missing");
      assert(cfg.polymarket.sizing.maxDailyLoss <= 2, "live default max daily loss clamp missing");
      assert(cfg.polymarket.execution.cancelAllOnStart, "live cancel-all-on-start default clamp missing");
    }
  );

  withEnv(
    {
      ...liveEnvBase,
      POLYMARKET_LIVE_EXECUTION_ENABLED: "true"
    },
    () => {
      const cfg = loadConfig();
      const engine = new PolymarketEngine(cfg, buildLogger(cfg));
      assert(cfg.polymarket.liveExecutionEnabled, "expected live execution armed flag");
      assert((engine as any).canMutateVenueState(), "armed live mode should allow venue mutations");
    }
  );

  // eslint-disable-next-line no-console
  console.log("Polymarket live parity tests: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Polymarket live parity tests: FAIL", error);
  process.exit(1);
});
