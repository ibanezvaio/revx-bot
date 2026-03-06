import {
  applyTakerSlippage,
  computePaperBinarySettlementPnl,
  computePaperPnl,
  inferOutcomeFromOracle
} from "../polymarket/paper/PaperMath";

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

  const noLose = computePaperPnl({
    side: "NO",
    outcome: "UP",
    qty: 5,
    entryPrice: 0.55,
    feeBps: 3
  });
  assert(Math.abs(noLose.payoutUsd) < 1e-9, "NO losing payout should be zero");
  assert(noLose.pnlUsd < 0, "NO losing pnl should be negative");

  const yesToken = "yes-token";
  const noToken = "no-token";
  const binaryYesWin = computePaperBinarySettlementPnl({
    qty: 10,
    entryCostUsd: 4,
    feesUsd: 0.01,
    heldTokenId: yesToken,
    winningTokenId: yesToken
  });
  assert(Math.abs(binaryYesWin.exitPayoutUsd - 10) < 1e-9, "binary YES win payout mismatch");
  assert(binaryYesWin.pnlUsd > 0, "binary YES win pnl should be positive");

  const binaryYesLoss = computePaperBinarySettlementPnl({
    qty: 10,
    entryCostUsd: 4,
    feesUsd: 0.01,
    heldTokenId: yesToken,
    winningTokenId: noToken
  });
  assert(Math.abs(binaryYesLoss.exitPayoutUsd) < 1e-9, "binary YES loss payout should be zero");
  assert(binaryYesLoss.pnlUsd < 0, "binary YES loss pnl should be negative");

  const binaryNoWin = computePaperBinarySettlementPnl({
    qty: 5,
    entryCostUsd: 2.5,
    feesUsd: 0.02,
    heldTokenId: noToken,
    winningTokenId: noToken
  });
  assert(Math.abs(binaryNoWin.exitPayoutUsd - 5) < 1e-9, "binary NO win payout mismatch");
  assert(binaryNoWin.pnlUsd > 0, "binary NO win pnl should be positive");

  const binaryNoLoss = computePaperBinarySettlementPnl({
    qty: 5,
    entryCostUsd: 2.5,
    feesUsd: 0.02,
    heldTokenId: noToken,
    winningTokenId: yesToken
  });
  assert(Math.abs(binaryNoLoss.exitPayoutUsd) < 1e-9, "binary NO loss payout should be zero");
  assert(binaryNoLoss.pnlUsd < 0, "binary NO loss pnl should be negative");

  assert(inferOutcomeFromOracle(45000, 44999) === "UP", "outcome UP mismatch");
  assert(inferOutcomeFromOracle(45000, 45001) === "DOWN", "outcome DOWN mismatch");

  // eslint-disable-next-line no-console
  console.log("Polymarket paper PnL tests: PASS");
}

run();
