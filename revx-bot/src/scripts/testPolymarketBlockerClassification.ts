import {
  classifyPolymarketBlocker,
  summarizePolymarketBlockers
} from "../polymarket/live/blockerClassification";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const structural = classifyPolymarketBlocker("NEXT_BUCKET_HANDOFF_WAIT");
  assert(structural.category === "STRUCTURAL", `expected structural category, got ${structural.category}`);
  assert(structural.stage === "SELECTION", `expected selection stage, got ${structural.stage}`);

  const safety = classifyPolymarketBlocker("SPREAD_TOO_WIDE");
  assert(safety.category === "SAFETY", `expected safety category, got ${safety.category}`);
  assert(safety.stage === "GATE", `expected gate stage, got ${safety.stage}`);

  const portfolio = classifyPolymarketBlocker("ATTRIBUTION_POLY_NEGATIVE_MARKOUT");
  assert(portfolio.category === "PORTFOLIO", `expected portfolio category, got ${portfolio.category}`);
  assert(portfolio.stage === "PORTFOLIO", `expected portfolio stage, got ${portfolio.stage}`);

  const summary = summarizePolymarketBlockers([
    { blocker: "NEXT_BUCKET_HANDOFF_WAIT", edge: 0.02 },
    { blocker: "SPREAD_TOO_WIDE", edge: 0 },
    { blocker: "NEXT_BUCKET_HANDOFF_WAIT", edge: 0.01 },
    { blocker: "ATTRIBUTION_POLY_NEGATIVE_MARKOUT", edge: 0.03 }
  ]);
  assert(summary.samples === 4, `expected 4 samples, got ${summary.samples}`);
  assert(summary.countsByCategory.STRUCTURAL === 2, `expected 2 structural blocks, got ${summary.countsByCategory.STRUCTURAL ?? 0}`);
  assert(summary.countsByCategory.SAFETY === 1, `expected 1 safety block, got ${summary.countsByCategory.SAFETY ?? 0}`);
  assert(summary.countsByCategory.PORTFOLIO === 1, `expected 1 portfolio block, got ${summary.countsByCategory.PORTFOLIO ?? 0}`);
  assert(summary.positiveEdgeBlockedCount === 3, `expected 3 positive-edge blocks, got ${summary.positiveEdgeBlockedCount}`);

  // eslint-disable-next-line no-console
  console.log("Polymarket blocker classification tests: PASS");
}

if (require.main === module) {
  run();
}
