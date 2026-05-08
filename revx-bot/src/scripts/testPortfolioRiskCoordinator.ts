import { PortfolioRiskCoordinator } from "../risk/PortfolioRiskCoordinator";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function makeLogger(): any {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => makeLogger()
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): any {
  const base = {
    dryRun: false,
    workingCapUsd: 100,
    targetBtcNotionalUsd: 80,
    maxInventoryUsd: 120,
    maxBtcNotionalUsd: 120,
    pnlDailyStopUsd: -5,
    polymarket: {
      enabled: true,
      mode: "live",
      sizing: {
        maxNotionalPerWindow: 10,
        maxConcurrentWindows: 2,
        maxDailyLoss: 2
      },
      risk: {
        maxExposure: 25
      }
    }
  };
  return deepMerge(base, overrides);
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (isObject(current) && isObject(value)) {
      out[key] = deepMerge(current, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function run(): void {
  const baseline = new PortfolioRiskCoordinator(makeConfig(), makeLogger()).getRuntimePlan(1);
  const revxBaseline = baseline.venues.find((venue) => venue.venue === "REVX");
  const polyBaseline = baseline.venues.find((venue) => venue.venue === "POLYMARKET");
  assert(Boolean(revxBaseline), "baseline: missing RevX venue");
  assert(Boolean(polyBaseline), "baseline: missing Polymarket venue");
  assert(revxBaseline?.dailyLossCapUsd === 5, `baseline: expected RevX daily loss cap 5, got ${revxBaseline?.dailyLossCapUsd}`);
  assert(revxBaseline?.startupAction === "START", `baseline: expected RevX admitted, got ${revxBaseline?.startupAction}`);
  assert(polyBaseline?.startupAction === "START", `baseline: expected Polymarket admitted, got ${polyBaseline?.startupAction}`);
  assert(polyBaseline?.allocatedStartupBudgetUsd === 10, `baseline: expected 10 USD poly budget, got ${polyBaseline?.allocatedStartupBudgetUsd}`);
  const baselinePolicy = new PortfolioRiskCoordinator(makeConfig(), makeLogger()).evaluateRuntimePolicy(
    {
      revx: { started: true, exposureUsd: 82, realizedPnlUsd: -1.5 },
      polymarket: { started: true, exposureUsd: 3, realizedPnlUsd: -0.5 }
    },
    4
  );
  assert(
    Math.abs(baselinePolicy.polymarketEntryPolicy.additionalBudgetUsd - 7) < 1e-9,
    `baseline policy: expected 7 USD additional budget, got ${baselinePolicy.polymarketEntryPolicy.additionalBudgetUsd}`
  );
  assert(baselinePolicy.polymarketEntryPolicy.allowNewEntries === true, "baseline policy: expected entries allowed");
  assert(
    Math.abs(baselinePolicy.revxQuotePolicy.effectiveWorkingCapUsd - 100) < 1e-9,
    `baseline policy: expected RevX working cap 100, got ${baselinePolicy.revxQuotePolicy.effectiveWorkingCapUsd}`
  );
  assert(
    baselinePolicy.revxQuotePolicy.reason === null,
    `baseline policy: unexpected RevX reason ${baselinePolicy.revxQuotePolicy.reason}`
  );

  const capitalReserved = new PortfolioRiskCoordinator(
    makeConfig({
      targetBtcNotionalUsd: 100,
      polymarket: {
        mode: "live",
        sizing: {
          maxNotionalPerWindow: 10
        }
      }
    }),
    makeLogger()
  ).getRuntimePlan(2);
  const polyReserved = capitalReserved.venues.find((venue) => venue.venue === "POLYMARKET");
  assert(polyReserved?.startupAction === "START", `reserved: expected Polymarket admitted, got ${polyReserved?.startupAction}`);
  assert(
    polyReserved?.startupReason === "LIVE_CAPITAL_ALLOCATED",
    `reserved: expected live-capital allocation reason, got ${polyReserved?.startupReason}`
  );
  const reservedPolicy = new PortfolioRiskCoordinator(
    makeConfig({
      targetBtcNotionalUsd: 100
    }),
    makeLogger()
  ).evaluateRuntimePolicy(
    {
      revx: { started: true, exposureUsd: 100, realizedPnlUsd: -1 },
      polymarket: { started: true, exposureUsd: 0, realizedPnlUsd: 0 }
    },
    5
  );
  assert(reservedPolicy.polymarketEntryPolicy.allowNewEntries === true, "reserved policy: expected entries allowed");
  assert(
    reservedPolicy.polymarketEntryPolicy.reason === null,
    `reserved policy: unexpected reason ${reservedPolicy.polymarketEntryPolicy.reason}`
  );
  assert(
    reservedPolicy.revxQuotePolicy.effectiveWorkingCapUsd === 100,
    `reserved policy: expected RevX full cap 100, got ${reservedPolicy.revxQuotePolicy.effectiveWorkingCapUsd}`
  );

  const paperAllowed = new PortfolioRiskCoordinator(
    makeConfig({
      targetBtcNotionalUsd: 100,
      polymarket: {
        mode: "paper",
        sizing: {
          maxNotionalPerWindow: 10
        }
      }
    }),
    makeLogger()
  ).getRuntimePlan(3);
  const polyPaper = paperAllowed.venues.find((venue) => venue.venue === "POLYMARKET");
  assert(polyPaper?.startupAction === "START", `paper: expected Polymarket admitted, got ${polyPaper?.startupAction}`);
  assert(polyPaper?.startupReason === "SIMULATION_MODE_ALLOWED", `paper: unexpected reason ${polyPaper?.startupReason}`);
  assert(polyPaper?.allocatedStartupBudgetUsd === 0, `paper: expected zero live-capital allocation, got ${polyPaper?.allocatedStartupBudgetUsd}`);

  const venueLossPolicy = new PortfolioRiskCoordinator(makeConfig(), makeLogger()).evaluateRuntimePolicy(
    {
      revx: { started: true, exposureUsd: 50, realizedPnlUsd: -5.5 },
      polymarket: { started: true, exposureUsd: 2, realizedPnlUsd: -2 }
    },
    6
  );
  assert(
    venueLossPolicy.polymarketEntryPolicy.reason === "POLYMARKET_DAILY_LOSS_LIMIT",
    `venue-loss: unexpected reason ${venueLossPolicy.polymarketEntryPolicy.reason}`
  );
  assert(venueLossPolicy.revxQuotePolicy.allowNewBuyRisk === false, "venue-loss: expected RevX buys blocked");
  assert(
    venueLossPolicy.revxQuotePolicy.reason === "REVX_DAILY_LOSS_LIMIT",
    `venue-loss: unexpected RevX reason ${venueLossPolicy.revxQuotePolicy.reason}`
  );

  // eslint-disable-next-line no-console
  console.log("PortfolioRiskCoordinator tests: PASS");
}

if (require.main === module) {
  run();
}
