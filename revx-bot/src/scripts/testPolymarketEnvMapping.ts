import { loadConfig } from "../config";
import { deriveBtc5mTickContext } from "../polymarket/btc5m";
import { evaluateMinSharesConfigFeasibility, resolvePriorityBlockedReason } from "../polymarket/PolymarketEngine";
import { Btc5mExecutionGate } from "../polymarket/live/Btc5mExecutionGate";
import { Btc5mLiveRunner } from "../polymarket/live/Btc5mLiveRunner";

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
    POLYMARKET_AUTO_DERIVE_API_KEY: "false",
    POLYMARKET_LIVE_MIN_DISLOCATION: "0.03",
    POLYMARKET_LIVE_EXTREME_PRICE_MAX: "0.95",
    POLYMARKET_LIVE_EXTREME_PRICE_MIN: "0.05",
    POLYMARKET_MIN_SHARES_REQUIRED: "5"
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
      POLYMARKET_MIN_SHARES_REQUIRED: "5",
      POLYMARKET_MAX_NOTIONAL_PER_WINDOW: "1"
    },
    () => {
      const config = loadConfig();
      assert(
        config.polymarket.sizing.minSharesRequired === 5,
        `expected minSharesRequired=5, got ${String(config.polymarket.sizing.minSharesRequired)}`
      );
      const infeasible = evaluateMinSharesConfigFeasibility({
        maxNotionalPerWindow: 1,
        chosenSidePriceUsed: 0.49,
        minSharesRequiredConfig: config.polymarket.sizing.minSharesRequired
      });
      assert(infeasible.configFeasible === false, "expected configFeasible false for 1 USD @ 0.49 with minShares=5");
      const prioritized = resolvePriorityBlockedReason({
        currentReason: "EDGE_BELOW_THRESHOLD",
        fairPriceSource: "MODEL",
        extremePriceFilterHit: false,
        dislocationAbs: 0.05,
        minDislocationConfig: 0.03,
        sizingRejectReason: "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED",
        configFeasible: infeasible.configFeasible
      });
      assert(
        prioritized === "CONFIG_INFEASIBLE_MIN_SHARES",
        `expected CONFIG_INFEASIBLE_MIN_SHARES, got ${String(prioritized)}`
      );
    }
  );

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_MIN_SHARES_REQUIRED: "1",
      POLYMARKET_MAX_NOTIONAL_PER_WINDOW: "1"
    },
    () => {
      const config = loadConfig();
      assert(
        config.polymarket.sizing.minSharesRequired === 1,
        `expected minSharesRequired=1, got ${String(config.polymarket.sizing.minSharesRequired)}`
      );
      const feasible = evaluateMinSharesConfigFeasibility({
        maxNotionalPerWindow: 1,
        chosenSidePriceUsed: 0.49,
        minSharesRequiredConfig: config.polymarket.sizing.minSharesRequired
      });
      assert(feasible.configFeasible === true, "expected configFeasible true for 1 USD @ 0.49 with minShares=1");
      const prioritized = resolvePriorityBlockedReason({
        currentReason: "EDGE_BELOW_THRESHOLD",
        fairPriceSource: "MODEL",
        extremePriceFilterHit: false,
        dislocationAbs: 0.05,
        minDislocationConfig: 0.03,
        sizingRejectReason: null,
        configFeasible: feasible.configFeasible
      });
      assert(prioritized === "EDGE_BELOW_THRESHOLD", `expected EDGE_BELOW_THRESHOLD, got ${String(prioritized)}`);
    }
  );

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_LIVE_ENABLE_NO_SIDE: "true",
      POLYMARKET_LIVE_MIN_EDGE_THRESHOLD: "0.01",
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
      POLYMARKET_LIVE_MIN_EDGE_THRESHOLD: "0.01",
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
      POLYMARKET_LIVE_ENABLE_NO_SIDE: "false",
      POLYMARKET_LIVE_MIN_EDGE_THRESHOLD: "0.01",
      POLYMARKET_LIVE_MAX_SPREAD: "0.60",
      POLYMARKET_LIVE_EXTREME_PRICE_MAX: "0.95",
      POLYMARKET_LIVE_EXTREME_PRICE_MIN: "0.05"
    },
    () => {
      const config = loadConfig();
      const gate = new Btc5mExecutionGate(config);
      const decision = gate.evaluate(makeGateInput(0.02, 0.97, 0.97, 0.70));
      assert(
        decision.blocker === "EXTREME_PRICE_FILTER",
        `expected EXTREME_PRICE_FILTER, got ${String(decision.blocker)}`
      );
      assert(decision.action === "HOLD", `expected HOLD for extreme price filter, got ${String(decision.action)}`);
      assert(decision.extremePriceFilterHit === true, "expected extremePriceFilterHit true");
    }
  );

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_LIVE_ENABLE_NO_SIDE: "false",
      POLYMARKET_LIVE_MIN_EDGE_THRESHOLD: "0.005",
      POLYMARKET_LIVE_MAX_SPREAD: "0.60",
      POLYMARKET_LIVE_MIN_DISLOCATION: "0.03",
      POLYMARKET_LIVE_EXTREME_PRICE_MAX: "0.95",
      POLYMARKET_LIVE_EXTREME_PRICE_MIN: "0.05"
    },
    () => {
      const config = loadConfig();
      const gate = new Btc5mExecutionGate(config);
      const decision = gate.evaluate(makeGateInput(0.02, 0.54, 0.90, 0.55));
      assert(
        decision.blocker === "INSUFFICIENT_DISLOCATION",
        `expected INSUFFICIENT_DISLOCATION, got ${String(decision.blocker)}`
      );
      assert(decision.action === "HOLD", `expected HOLD for dislocation guard, got ${String(decision.action)}`);
      assert(
        Math.abs(Number(decision.minDislocationConfig) - 0.03) < 1e-9,
        `expected minDislocationConfig=0.03, got ${String(decision.minDislocationConfig)}`
      );
    }
  );

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_LIVE_ENABLE_NO_SIDE: "false",
      POLYMARKET_LIVE_MIN_EDGE_THRESHOLD: "0.01",
      POLYMARKET_LIVE_MAX_SPREAD: "0.60",
      POLYMARKET_LIVE_MIN_DISLOCATION: "0.03",
      POLYMARKET_LIVE_EXTREME_PRICE_MAX: "0.95",
      POLYMARKET_LIVE_EXTREME_PRICE_MIN: "0.05"
    },
    () => {
      const config = loadConfig();
      const gate = new Btc5mExecutionGate(config);
      const decision = gate.evaluate(makeGateInput(0.02, 0.45, 0.90, 0.65));
      assert(
        decision.blocker !== "EXTREME_PRICE_FILTER" && decision.blocker !== "INSUFFICIENT_DISLOCATION",
        `expected decision not blocked by new filters, got ${String(decision.blocker)}`
      );
      assert(decision.action === "BUY_YES", `expected BUY_YES for valid dislocation case, got ${String(decision.action)}`);
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
      const decision = gate.evaluate(makeGateInput(0.10, 0.53, 0.60, 0.58)); // best YES edge ~0.05
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
      const decision = gate.evaluate(makeGateInput(0.10, 0.53, 0.60, 0.58)); // best YES edge ~0.05
      assert(
        decision.blocker !== "EDGE_BELOW_THRESHOLD",
        `expected lower min edge to allow entry, got ${String(decision.blocker)}`
      );
    }
  );

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_LIVE_MIN_EDGE_THRESHOLD: "0.0123",
      POLYMARKET_LIVE_MIN_EDGE: "0.0456"
    },
    () => {
      const config = loadConfig();
      assert(
        Math.abs(config.polymarket.live.minEdgeThreshold - 0.0123) < 1e-9,
        `expected canonical POLYMARKET_LIVE_MIN_EDGE_THRESHOLD to override aliases, got ${config.polymarket.live.minEdgeThreshold}`
      );
    }
  );

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_LIVE_MIN_EDGE_THRESHOLD: "0.0123"
    },
    () => {
      const config = loadConfig();
      const runner = new Btc5mLiveRunner(
        config,
        {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined
        } as any,
        {}
      );
      const runnerAny = runner as any;
      runnerAny.state.pUpModel = 0.5315;
      runnerAny.state.bestEdge = 0.018;
      runnerAny.state.yesEdge = 0.018;
      runnerAny.state.noEdge = -0.027;
      const snapshot = runner.getDashboardSnapshot();
      assert(
        Math.abs(Number(snapshot.minEdgeThresholdConfig) - 0.0123) < 1e-9,
        `expected stable threshold telemetry from config, got ${String(snapshot.minEdgeThresholdConfig)}`
      );
      assert(
        Math.abs(Number(snapshot.pUpModel) - 0.5315) < 1e-9,
        `expected dynamic pUpModel telemetry, got ${String(snapshot.pUpModel)}`
      );
      assert(
        Math.abs(Number(snapshot.bestEdge) - 0.018) < 1e-9,
        `expected dynamic bestEdge telemetry, got ${String(snapshot.bestEdge)}`
      );
      assert(
        Math.abs(Number(snapshot.yesEdge) - 0.018) < 1e-9,
        `expected dynamic yesEdge telemetry, got ${String(snapshot.yesEdge)}`
      );
      assert(
        Math.abs(Number(snapshot.noEdge) + 0.027) < 1e-9,
        `expected dynamic noEdge telemetry, got ${String(snapshot.noEdge)}`
      );
    }
  );

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_LIVE_ENABLE_NO_SIDE: "true",
      POLYMARKET_LIVE_MIN_EDGE_THRESHOLD: "0.01",
      POLYMARKET_LIVE_MAX_SPREAD: "0.60"
    },
    () => {
      const config = loadConfig();
      const gateLogs: Array<{ msg: string; payload: Record<string, unknown> }> = [];
      const gate = new Btc5mExecutionGate(config, {
        info: (payload: Record<string, unknown>, msg: string) => {
          gateLogs.push({ msg, payload });
        }
      } as any);
      gate.evaluate(makeGateInput(0.10, 0.53, 0.53, 0.55));
      const edgeMathLog = gateLogs.find((row) => row.msg === "POLY_V2_EDGE_MATH");
      assert(Boolean(edgeMathLog), "expected POLY_V2_EDGE_MATH log payload");
      const payload = edgeMathLog?.payload || {};
      const requiredKeys = [
        "selectedSlug",
        "sideConsidered",
        "pUpModel",
        "yesAsk",
        "noAsk",
        "yesSpread",
        "noSpread",
        "maxSpreadConfig",
        "minEdgeThresholdConfig",
        "takerFeeBps",
        "takerSlipBps",
        "safetyBps",
        "edgeSafetyBps",
        "computedYesEdgeRaw",
        "computedNoEdgeRaw",
        "computedYesEdgeNet",
        "computedNoEdgeNet",
        "chosenEdgeBeforeClamp",
        "chosenEdgeAfterClamp",
        "fairYes",
        "fairNo",
        "fairPriceSource",
        "fairPriceModelOrigin",
        "yesDislocationAbs",
        "noDislocationAbs",
        "minDislocationConfig",
        "yesExtremePriceHit",
        "noExtremePriceHit",
        "extremePriceMinConfig",
        "extremePriceMaxConfig",
        "clampReason",
        "chosenBlocker",
        "gateDecision"
      ];
      for (const key of requiredKeys) {
        assert(Object.prototype.hasOwnProperty.call(payload, key), `expected POLY_V2_EDGE_MATH key '${key}'`);
      }
    }
  );

  // eslint-disable-next-line no-console
  console.log("Polymarket env mapping tests: PASS");
}

run();
