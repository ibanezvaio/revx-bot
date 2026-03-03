import { BotConfig, loadConfig } from "../config";
import { Sizing } from "../polymarket/Sizing";

process.env.DRY_RUN = "true";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const base = loadConfig();
  return {
    ...base,
    polymarket: {
      ...base.polymarket,
      sizing: {
        ...base.polymarket.sizing,
        fractionalKelly: 0.5,
        maxNotionalPerWindow: 10,
        minOrderNotional: 1
      }
    },
    ...overrides
  };
}

function run(): void {
  const sizing = new Sizing(makeConfig());

  const capped = sizing.compute({
    edge: 0.2,
    pUpModel: 0.8,
    yesAsk: 0.5,
    conviction: 0.45,
    remainingSec: 30,
    entryMaxRemainingSec: 90,
    remainingWindowBudget: 3,
    remainingExposureBudget: 50,
    remainingDailyLossBudget: 50
  });
  assert(capped.notionalUsd <= 3.000001, `expected window cap <= 3, got ${capped.notionalUsd}`);
  assert(capped.shares > 0, "expected positive share size");

  const noBudget = sizing.compute({
    edge: 0.2,
    pUpModel: 0.8,
    yesAsk: 0.5,
    conviction: 0.4,
    remainingSec: 30,
    entryMaxRemainingSec: 90,
    remainingWindowBudget: 10,
    remainingExposureBudget: 0.5,
    remainingDailyLossBudget: 10
  });
  assert(noBudget.notionalUsd === 0, `expected no trade due to min order cap, got ${noBudget.notionalUsd}`);

  const lowEdge = sizing.compute({
    edge: 0.001,
    pUpModel: 0.501,
    yesAsk: 0.5,
    conviction: 0.1,
    remainingSec: 30,
    entryMaxRemainingSec: 90,
    remainingWindowBudget: 10,
    remainingExposureBudget: 10,
    remainingDailyLossBudget: 10
  });
  assert(lowEdge.notionalUsd === 0, `expected 0 notional for weak edge, got ${lowEdge.notionalUsd}`);

  // eslint-disable-next-line no-console
  console.log("Polymarket Sizing tests: PASS");
}

run();
