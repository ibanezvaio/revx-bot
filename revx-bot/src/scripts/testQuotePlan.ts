import {
  applyInventoryBandPolicy,
  applyMakerQuoteGuard,
  buildQuotePlan,
  computeMakerMinEdgeBps,
  ensureSeedBuyOrder,
  resolveInventoryAction,
  validateRuntimeOverrideValues
} from "../strategy/MakerStrategy";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const common = {
    inputs: {
      ts: Date.now(),
      symbol: "BTC-USD",
      mid: 100,
      bid: 99.9,
      ask: 100.1,
      marketSpreadBps: 20,
      volMoveBps: 1.2,
      trendMoveBps: 0,
      usdFree: 500,
      usdTotal: 500,
      btcFree: 0.8,
      btcTotal: 0.8,
      btcNotionalUsd: 80,
      inventoryRatio: 0,
      config: {
        levels: 2,
        enableTopOfBook: true,
        minInsideSpreadBps: 2,
        minVolMoveBpsToQuote: 5,
        volProtectMode: "block",
        cashReserveUsd: 50,
        workingCapUsd: 500,
        targetBtcNotionalUsd: 80,
        lowBtcGateUsd: 60,
        maxActionsPerLoop: 5
      }
    },
    buyLevels: 2,
    sellLevels: 2,
    tobMode: "BOTH" as const,
    blockedReasons: []
  };

  const blocked = buildQuotePlan({
    ...common,
    inputs: { ...common.inputs, config: { ...common.inputs.config, volProtectMode: "block" } }
  });
  assert(blocked.quoteEnabled === true, "block mode should not hard-disable quoting when levels exist");
  assert(
    blocked.blockedReasons.some((row) => row.includes("LOW_VOL_KEEP_QUOTING")),
    "block mode should emit LOW_VOL_KEEP_QUOTING reason"
  );

  const widened = buildQuotePlan({
    ...common,
    inputs: { ...common.inputs, config: { ...common.inputs.config, volProtectMode: "widen" } }
  });
  assert(widened.quoteEnabled === true, "widen mode should keep quoting enabled when levels exist");
  assert(
    widened.blockedReasons.some((row) => row.includes("LOW_VOL_KEEP_QUOTING")),
    "widen mode should keep quoting in low-vol"
  );
  assert(widened.hardHalt === false, "widen mode should not hard-halt quoting");

  const hardHalted = buildQuotePlan({
    ...common,
    hardHaltReasons: ["EXECUTION_CRITICAL_FAULT"]
  });
  assert(hardHalted.hardHalt === true, "hard halt reasons must set hardHalt=true");
  assert(hardHalted.quoteEnabled === false, "hard halt reasons must disable quoting");
  assert(
    hardHalted.hardHaltReasons.includes("EXECUTION_CRITICAL_FAULT"),
    "hard halt reason should be preserved"
  );

  const overrideActive = buildQuotePlan({
    ...common,
    blockedReasons: ["Runtime overrides active: levelsBuy,baseHalfSpreadBps"]
  });
  const plannedOrders =
    overrideActive.buyLevels +
    overrideActive.sellLevels +
    (overrideActive.tob === "BOTH" ? 2 : overrideActive.tob === "OFF" ? 0 : 1);
  assert(overrideActive.quoteEnabled, "active runtime overrides should not disable quote plan");
  assert(
    overrideActive.buyLevels > 0 && overrideActive.sellLevels > 0,
    "active runtime overrides should keep non-empty buy/sell quote levels"
  );
  assert(plannedOrders > 0, "active runtime overrides should still produce planned orders");
  assert(overrideActive.tob !== "OFF", "active runtime overrides should keep TOB enabled");

  const seedPlan = buildQuotePlan({
    ...common,
    inputs: {
      ...common.inputs,
      btcTotal: 0,
      btcFree: 0,
      btcNotionalUsd: 0,
      config: {
        ...common.inputs.config,
        seedEnabled: true,
        minBtcNotionalUsd: 10,
        seedTargetBtcNotionalUsd: 75,
        lowBtcGateUsd: 60
      }
    },
    buyLevels: 0,
    sellLevels: 2,
    tobMode: "OFF"
  });
  assert(
    seedPlan.seedMode === "ACCUMULATE_BTC",
    "low BTC notional should force ACCUMULATE_BTC seed mode"
  );
  assert(seedPlan.buyLevels >= 1, "seed mode should force buy levels >= 1");
  assert(seedPlan.sellLevels === 0, "seed mode should allow sells to be 0 while inventory is low");
  assert(seedPlan.quoteEnabled === true, "seed mode should keep quoting enabled");
  assert(
    seedPlan.blockedReasons.some((row) => row.includes("SEED_OVERRIDE_BUY_FORCED")),
    "seed mode should emit SEED_OVERRIDE_BUY_FORCED reason"
  );

  const seededOrderResult = ensureSeedBuyOrder({
    orders: [],
    symbol: "BTC-USD",
    execution: {
      makeTag: (_symbol: string, side: "BUY" | "SELL", level: number | string) =>
        "test-" + side + "-" + String(level)
    } as any,
    bestBid: 100,
    bestAsk: 100.01,
    tickSize: 0.01,
    quoteSizeUsd: 10
  });
  assert(seededOrderResult.applied === true, "seed order helper should inject a BUY seed order");
  assert(seededOrderResult.orders.length > 0, "seed order helper should produce desiredCount>0");
  assert(
    seededOrderResult.orders.some(
      (row) =>
        row.side === "BUY" &&
        (String(row.level).toUpperCase() === "SEED_BUY" ||
          String(row.tag || "").toUpperCase().includes("SEED_BUY"))
    ),
    "seed order helper should include BUY SEED_BUY order"
  );

  const lowSpreadMakerGuard = applyMakerQuoteGuard({
    orders: [
      { tag: "revx-BUY-SEED_BUY", side: "BUY", level: "SEED_BUY", price: 99.99 },
      { tag: "revx-BUY-REENTRY_BUY", side: "BUY", level: "REENTRY_BUY", price: 99.995 },
      { side: "SELL", level: "L0-TOB", price: 100.01 },
      { side: "BUY", level: 1, price: 99.985 },
      { side: "SELL", level: 1, price: 100.015 }
    ],
    fairMid: 100,
    minMakerEdgeBps: computeMakerMinEdgeBps(0.2, 2),
    currentSpreadBps: 2
  });
  assert(
    lowSpreadMakerGuard.kept.some((row) => String(row.tag || "").toUpperCase().includes("SEED_BUY")),
    "maker guard should bypass seed BUY orders"
  );
  assert(
    lowSpreadMakerGuard.kept.some((row) => String(row.tag || "").toUpperCase().includes("REENTRY_BUY")),
    "maker guard should bypass REENTRY_BUY orders"
  );
  assert(
    lowSpreadMakerGuard.kept.length > 0,
    "maker guard should keep desiredCount>0 in 2bps spread with maker fee 0 when seeding"
  );

  const floorPolicy = applyInventoryBandPolicy({
    buyLevels: 0,
    sellLevels: 2,
    btcNotionalUsd: 5,
    floorUsd: 10,
    targetUsd: 75,
    capUsd: 200,
    hysteresisUsd: 5,
    inventoryAction: "ACCUMULATE",
    maxSellUsdPerHour: 30,
    sellNotionalFilled1hUsd: 0,
    sellQuoteSizeUsd: 10,
    spendableUsd: 100,
    minNotionalUsd: 10,
    phase: "COOLDOWN",
    strategyAllowBuy: true,
    strategyAllowSell: true,
    hardHalt: false
  });
  assert(floorPolicy.buyLevels >= 1, "floor policy should force at least one BUY level");
  assert(floorPolicy.sellLevels === 0, "floor policy should disable SELL levels");

  const capPolicy = applyInventoryBandPolicy({
    buyLevels: 2,
    sellLevels: 0,
    btcNotionalUsd: 260,
    floorUsd: 10,
    targetUsd: 75,
    capUsd: 200,
    hysteresisUsd: 5,
    inventoryAction: "DISTRIBUTE",
    maxSellUsdPerHour: 30,
    sellNotionalFilled1hUsd: 0,
    sellQuoteSizeUsd: 10,
    spendableUsd: 100,
    minNotionalUsd: 10,
    phase: "STABILIZING",
    strategyAllowBuy: true,
    strategyAllowSell: true,
    hardHalt: false
  });
  assert(capPolicy.buyLevels === 0, "cap policy should disable BUY levels above cap");
  assert(capPolicy.sellLevels >= 1, "cap policy should enable SELL levels above cap");

  const reentryPolicy = applyInventoryBandPolicy({
    buyLevels: 0,
    sellLevels: 2,
    btcNotionalUsd: 35,
    floorUsd: 10,
    targetUsd: 75,
    capUsd: 200,
    hysteresisUsd: 5,
    inventoryAction: "ACCUMULATE",
    maxSellUsdPerHour: 30,
    sellNotionalFilled1hUsd: 0,
    sellQuoteSizeUsd: 10,
    spendableUsd: 100,
    minNotionalUsd: 10,
    phase: "RECOVERY",
    strategyAllowBuy: true,
    strategyAllowSell: true,
    hardHalt: false
  });
  assert(reentryPolicy.reentryActive === true, "re-entry policy should activate below target in RECOVERY");
  assert(reentryPolicy.buyLevels >= 1, "re-entry policy should force BUY levels");
  assert(reentryPolicy.sellLevels <= 1, "re-entry policy should reduce sell pressure");

  const cooldownSellCapPolicy = applyInventoryBandPolicy({
    buyLevels: 1,
    sellLevels: 3,
    btcNotionalUsd: 100,
    floorUsd: 20,
    targetUsd: 80,
    capUsd: 160,
    hysteresisUsd: 5,
    inventoryAction: "DISTRIBUTE",
    maxSellUsdPerHour: 30,
    sellNotionalFilled1hUsd: 30,
    sellQuoteSizeUsd: 10,
    spendableUsd: 100,
    minNotionalUsd: 10,
    phase: "COOLDOWN",
    strategyAllowBuy: true,
    strategyAllowSell: true,
    hardHalt: false
  });
  assert(cooldownSellCapPolicy.sellLevels === 0, "cooldown sell cap should reduce SELL levels to 0 at cap");

  assert(
    resolveInventoryAction({ btcNotionalUsd: 60, targetUsd: 80, hysteresisUsd: 5 }) === "ACCUMULATE",
    "inventory action should be ACCUMULATE below target-hysteresis"
  );
  assert(
    resolveInventoryAction({ btcNotionalUsd: 82, targetUsd: 80, hysteresisUsd: 5 }) === "HOLD",
    "inventory action should be HOLD inside hysteresis band"
  );
  assert(
    resolveInventoryAction({ btcNotionalUsd: 90, targetUsd: 80, hysteresisUsd: 5 }) === "DISTRIBUTE",
    "inventory action should be DISTRIBUTE above target+hysteresis"
  );

  const invalidOverrideIssues = validateRuntimeOverrideValues({
    levelsBuy: -1,
    levelsSell: 2,
    levelQuoteSizeUsd: 0,
    tobQuoteSizeUsd: 5,
    baseHalfSpreadBps: 0,
    queueRefreshSeconds: 0
  });
  assert(
    invalidOverrideIssues.some((row) => row.startsWith("levelsBuy=")),
    "invalid override validator should flag negative levels"
  );
  assert(
    invalidOverrideIssues.some((row) => row.startsWith("levelQuoteSizeUsd=")),
    "invalid override validator should flag non-positive quote size"
  );
  assert(
    invalidOverrideIssues.some((row) => row.startsWith("baseHalfSpreadBps=")),
    "invalid override validator should flag non-positive spread"
  );
  assert(
    invalidOverrideIssues.some((row) => row.startsWith("queueRefreshSeconds=")),
    "invalid override validator should flag non-positive queue refresh"
  );

  // eslint-disable-next-line no-console
  console.log("QuotePlan hard-halt/vol-protect/runtime-override test: PASS");
}

run();
