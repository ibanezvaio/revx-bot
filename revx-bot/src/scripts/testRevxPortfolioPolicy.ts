import { applyRevxPortfolioQuotePolicy } from "../strategy/portfolioPolicy";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const constrained = applyRevxPortfolioQuotePolicy(
    {
      workingCapUsd: 100,
      targetBtcNotionalUsd: 80,
      maxBtcNotionalUsd: 120,
      buyQuoteSizeUsd: 20,
      minQuoteSizeUsd: 5
    },
    {
      allowNewBuyRisk: true,
      effectiveWorkingCapUsd: 60,
      effectiveTargetBtcNotionalUsd: 45,
      effectiveMaxBtcNotionalUsd: 60,
      buySizeMultiplier: 0.4,
      reason: "REVX_LOCAL_CAP_CLAMP"
    }
  );
  assert(constrained.workingCapUsd === 60, `expected workingCapUsd=60, got ${constrained.workingCapUsd}`);
  assert(
    constrained.targetBtcNotionalUsd === 45,
    `expected targetBtcNotionalUsd=45, got ${constrained.targetBtcNotionalUsd}`
  );
  assert(constrained.maxBtcNotionalUsd === 60, `expected maxBtcNotionalUsd=60, got ${constrained.maxBtcNotionalUsd}`);
  assert(constrained.buyQuoteSizeUsd === 8, `expected buyQuoteSizeUsd=8, got ${constrained.buyQuoteSizeUsd}`);
  assert(constrained.blockedBuyReason === null, `expected no blocked reason, got ${String(constrained.blockedBuyReason)}`);

  const blocked = applyRevxPortfolioQuotePolicy(
    {
      workingCapUsd: 100,
      targetBtcNotionalUsd: 80,
      maxBtcNotionalUsd: 120,
      buyQuoteSizeUsd: 20,
      minQuoteSizeUsd: 5
    },
    {
      allowNewBuyRisk: false,
      effectiveWorkingCapUsd: 0,
      effectiveTargetBtcNotionalUsd: 0,
      effectiveMaxBtcNotionalUsd: 0,
      buySizeMultiplier: 0,
      reason: "REVX_DAILY_LOSS_LIMIT"
    }
  );
  assert(blocked.workingCapUsd === 0, `expected blocked workingCapUsd=0, got ${blocked.workingCapUsd}`);
  assert(blocked.buyQuoteSizeUsd === 0, `expected blocked buyQuoteSizeUsd=0, got ${blocked.buyQuoteSizeUsd}`);
  assert(
    blocked.blockedBuyReason === "REVX_DAILY_LOSS_LIMIT",
    `expected blocked reason, got ${String(blocked.blockedBuyReason)}`
  );

  // eslint-disable-next-line no-console
  console.log("Revx portfolio policy tests: PASS");
}

if (require.main === module) {
  run();
}
