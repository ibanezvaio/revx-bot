import { loadConfig } from "../config";
import { deriveBtc5mTickContext } from "../polymarket/btc5m";
import { Btc5mExecutionGate } from "../polymarket/live/Btc5mExecutionGate";

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

function run(): void {
  const baseEnv: Record<string, string | undefined> = {
    DRY_RUN: "true",
    POLYMARKET_ENABLED: "true",
    POLYMARKET_MODE: "live",
    POLYMARKET_LIVE_CONFIRMED: "true",
    POLYMARKET_LIVE_EXECUTION_ENABLED: "false",
    POLYMARKET_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111",
    POLYMARKET_FUNDER: "0x2222222222222222222222222222222222222222",
    POLYMARKET_API_KEY: "test_api_key",
    POLYMARKET_PASSPHRASE: "test_passphrase",
    POLYMARKET_AUTO_DERIVE_API_KEY: "false"
  };

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_API_SECRET: undefined,
      POLYMARKET_SECRET: "legacy_secret"
    },
    () => {
      const config = loadConfig();
      assert(config.polymarket.auth.apiSecret === "legacy_secret", "expected legacy POLYMARKET_SECRET fallback");
      assert(config.polymarket.liveExecutionEnabled === false, "expected live execution arming default false");
    }
  );

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_API_SECRET: "preferred_secret",
      POLYMARKET_SECRET: "legacy_secret"
    },
    () => {
      const config = loadConfig();
      assert(config.polymarket.auth.apiSecret === "preferred_secret", "expected POLYMARKET_API_SECRET to take priority");
    }
  );

  const makeGateInput = (spread: number, yesAsk: number, noAsk: number, pUpModel: number) => {
    const tick = { ...deriveBtc5mTickContext(Date.now()), remainingSec: 240 };
    return {
      tick,
      selected: {
        marketId: "gate-test-market",
        slug: tick.currentSlug,
        question: "gate test",
        priceToBeat: 100_000,
        startTs: tick.currentBucketStartSec * 1000,
        endTs: (tick.currentBucketStartSec + 300) * 1000,
        remainingSec: 240,
        chosenSide: null,
        selectedTokenId: null,
        yesTokenId: "yes-token",
        noTokenId: "no-token",
        yesBook: {
          side: "YES",
          tokenId: "yes-token",
          bestBid: yesAsk - spread,
          bestAsk: yesAsk,
          mid: yesAsk - spread / 2,
          spread,
          quoteTs: Date.now(),
          bookable: true,
          reason: null
        },
        noBook: {
          side: "NO",
          tokenId: "no-token",
          bestBid: noAsk - spread,
          bestAsk: noAsk,
          mid: noAsk - spread / 2,
          spread,
          quoteTs: Date.now(),
          bookable: true,
          reason: null
        },
        selectionSource: "current_slug",
        orderbookOk: true
      },
      intelligence: {
        source: "TEST",
        posture: "TEST",
        score: 0.5,
        pUpModel,
        fallbackUsed: false
      },
      oracleAgeMs: 0
    } as any;
  };

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_LIVE_ENABLE_NO_SIDE: "true",
      POLYMARKET_LIVE_MIN_EDGE_THRESHOLD: "0.0005",
      POLYMARKET_LIVE_MAX_SPREAD: undefined,
      POLY_LIVE_MAX_SPREAD: "0.20"
    },
    () => {
      const config = loadConfig();
      assert(
        Math.abs(config.polymarket.live.maxSpread - 0.2) < 1e-9,
        `expected POLY_LIVE_MAX_SPREAD alias to map to live max spread, got ${config.polymarket.live.maxSpread}`
      );
      const gate = new Btc5mExecutionGate(config);
      const decision = gate.evaluate(makeGateInput(0.35, 0.30, 0.30, 0.80));
      assert(decision.blocker === "SPREAD_TOO_WIDE", `expected SPREAD_TOO_WIDE, got ${String(decision.blocker)}`);
    }
  );

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_LIVE_ENABLE_NO_SIDE: "true",
      POLYMARKET_LIVE_MIN_EDGE_THRESHOLD: "0.0005",
      POLYMARKET_LIVE_MAX_SPREAD: "0.60",
      POLY_LIVE_MAX_SPREAD: undefined
    },
    () => {
      const config = loadConfig();
      const gate = new Btc5mExecutionGate(config);
      const decision = gate.evaluate(makeGateInput(0.35, 0.30, 0.30, 0.80));
      assert(
        decision.blocker !== "SPREAD_TOO_WIDE",
        `expected widened max spread to bypass spread block, got ${String(decision.blocker)}`
      );
    }
  );

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_LIVE_ENABLE_NO_SIDE: "true",
      POLYMARKET_LIVE_MAX_SPREAD: "0.60",
      POLY_V2_MIN_EDGE_THRESHOLD: "0.06",
      POLYMARKET_LIVE_MIN_EDGE_THRESHOLD: undefined
    },
    () => {
      const config = loadConfig();
      assert(
        Math.abs(config.polymarket.live.minEdgeThreshold - 0.06) < 1e-9,
        `expected POLY_V2_MIN_EDGE_THRESHOLD alias to map to live min edge, got ${config.polymarket.live.minEdgeThreshold}`
      );
      const gate = new Btc5mExecutionGate(config);
      const decision = gate.evaluate(makeGateInput(0.10, 0.53, 0.53, 0.55)); // best edge ~0.02
      assert(
        decision.blocker === "EDGE_BELOW_THRESHOLD",
        `expected EDGE_BELOW_THRESHOLD with high min edge, got ${String(decision.blocker)}`
      );
    }
  );

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_LIVE_ENABLE_NO_SIDE: "true",
      POLYMARKET_LIVE_MAX_SPREAD: "0.60",
      POLYMARKET_LIVE_MIN_EDGE_THRESHOLD: "0.01",
      POLY_V2_MIN_EDGE_THRESHOLD: undefined
    },
    () => {
      const config = loadConfig();
      const gate = new Btc5mExecutionGate(config);
      const decision = gate.evaluate(makeGateInput(0.10, 0.53, 0.53, 0.55)); // best edge ~0.02
      assert(
        decision.blocker !== "EDGE_BELOW_THRESHOLD",
        `expected lower min edge to allow entry, got ${String(decision.blocker)}`
      );
    }
  );

  // eslint-disable-next-line no-console
  console.log("Polymarket env mapping tests: PASS");
}

run();
