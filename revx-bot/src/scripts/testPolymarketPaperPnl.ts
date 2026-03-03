import { applyTakerSlippage, computePaperPnl, inferOutcomeFromOracle } from "../polymarket/paper/PaperMath";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const slipped = applyTakerSlippage(0.5, 10);
  assert(slipped > 0.5, "expected positive slippage");

  const yesWin = computePaperPnl({
    side: "YES",
    outcome: "UP",
    qty: 10,
    entryPrice: 0.4,
    feeBps: 5
  });
  assert(Math.abs(yesWin.payoutUsd - 10) < 1e-9, "YES payout mismatch");
  assert(yesWin.pnlUsd > 0, "YES winning pnl should be positive");

  const yesLose = computePaperPnl({
    side: "YES",
    outcome: "DOWN",
    qty: 10,
    entryPrice: 0.4,
    feeBps: 5
  });
  assert(Math.abs(yesLose.payoutUsd) < 1e-9, "YES losing payout should be zero");
  assert(yesLose.pnlUsd < 0, "YES losing pnl should be negative");

  const noWin = computePaperPnl({
    side: "NO",
    outcome: "DOWN",
    qty: 5,
    entryPrice: 0.55,
    feeBps: 3
  });
  assert(Math.abs(noWin.payoutUsd - 5) < 1e-9, "NO payout mismatch");
  assert(noWin.pnlUsd > 0, "NO winning pnl should be positive");

  assert(inferOutcomeFromOracle(45000, 44999) === "UP", "outcome UP mismatch");
  assert(inferOutcomeFromOracle(45000, 45001) === "DOWN", "outcome DOWN mismatch");

  // eslint-disable-next-line no-console
  console.log("Polymarket paper PnL tests: PASS");
}

run();
