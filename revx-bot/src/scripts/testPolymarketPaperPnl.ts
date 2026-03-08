import {
  applyTakerSlippage,
  classifyPaperResult,
  computePaperBinarySettlementPnl,
  computePaperPnl,
  getPaperBinarySettlementBounds,
  inferOutcomeFromOracle
} from "../polymarket/paper/PaperMath";
import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { PolymarketEngine } from "../polymarket/PolymarketEngine";

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
  assert(Math.abs(yesWin.pnlUsd - (10 - 4 - 0.002)) < 1e-9, "YES winning pnl should subtract fees");

  const yesLose = computePaperPnl({
    side: "YES",
    outcome: "DOWN",
    qty: 10,
    entryPrice: 0.4,
    feeBps: 5
  });
  assert(Math.abs(yesLose.payoutUsd) < 1e-9, "YES losing payout should be zero");
  assert(yesLose.pnlUsd < 0, "YES losing pnl should be negative");
  assert(Math.abs(yesLose.pnlUsd + 4.002) < 1e-9, "YES losing pnl should subtract fees");

  const noWin = computePaperPnl({
    side: "NO",
    outcome: "DOWN",
    qty: 5,
    entryPrice: 0.55,
    feeBps: 3
  });
  assert(Math.abs(noWin.payoutUsd - 5) < 1e-9, "NO payout mismatch");
  assert(noWin.pnlUsd > 0, "NO winning pnl should be positive");
  assert(Math.abs(noWin.pnlUsd - (5 - 2.75 - 0.000825)) < 1e-9, "NO winning pnl should subtract fees");

  const noLose = computePaperPnl({
    side: "NO",
    outcome: "UP",
    qty: 5,
    entryPrice: 0.55,
    feeBps: 3
  });
  assert(Math.abs(noLose.payoutUsd) < 1e-9, "NO losing payout should be zero");
  assert(noLose.pnlUsd < 0, "NO losing pnl should be negative");
  assert(Math.abs(noLose.pnlUsd + 2.750825) < 1e-9, "NO losing pnl should subtract fees");

  const yesToken = "yes-token";
  const noToken = "no-token";
  const binaryYesWin = computePaperBinarySettlementPnl({
    qty: 10,
    entryPrice: 0.4,
    notionalUsd: 4,
    entryCostUsd: 4,
    feesUsd: 0.01,
    heldSide: "YES",
    heldTokenId: yesToken,
    yesTokenId: yesToken,
    noTokenId: noToken,
    winningTokenId: yesToken
  });
  assert(Math.abs(binaryYesWin.exitPayoutUsd - 10) < 1e-9, "binary YES win payout mismatch");
  assert(Math.abs(binaryYesWin.pnlUsd - 5.99) < 1e-9, "binary YES win pnl formula mismatch");
  assert(classifyPaperResult(binaryYesWin.pnlUsd) === "WIN", "binary YES win result should be WIN");

  const binaryYesLoss = computePaperBinarySettlementPnl({
    qty: 10,
    entryPrice: 0.4,
    notionalUsd: 4,
    entryCostUsd: 4,
    feesUsd: 0.01,
    heldSide: "YES",
    heldTokenId: yesToken,
    yesTokenId: yesToken,
    noTokenId: noToken,
    winningTokenId: noToken
  });
  assert(Math.abs(binaryYesLoss.exitPayoutUsd) < 1e-9, "binary YES loss payout should be zero");
  assert(Math.abs(binaryYesLoss.pnlUsd + 4.01) < 1e-9, "binary YES loss pnl formula mismatch");
  assert(classifyPaperResult(binaryYesLoss.pnlUsd) === "LOSS", "binary YES loss result should be LOSS");

  const binaryNoWin = computePaperBinarySettlementPnl({
    qty: 5,
    entryPrice: 0.5,
    notionalUsd: 2.5,
    entryCostUsd: 2.5,
    feesUsd: 0.02,
    heldSide: "NO",
    heldTokenId: noToken,
    yesTokenId: yesToken,
    noTokenId: noToken,
    winningTokenId: noToken
  });
  assert(Math.abs(binaryNoWin.exitPayoutUsd - 5) < 1e-9, "binary NO win payout mismatch");
  assert(Math.abs(binaryNoWin.pnlUsd - 2.48) < 1e-9, "binary NO win pnl formula mismatch");
  assert(classifyPaperResult(binaryNoWin.pnlUsd) === "WIN", "binary NO win result should be WIN");

  const binaryNoLoss = computePaperBinarySettlementPnl({
    qty: 5,
    entryPrice: 0.5,
    notionalUsd: 2.5,
    entryCostUsd: 2.5,
    feesUsd: 0.02,
    heldSide: "NO",
    heldTokenId: noToken,
    yesTokenId: yesToken,
    noTokenId: noToken,
    winningTokenId: yesToken
  });
  assert(Math.abs(binaryNoLoss.exitPayoutUsd) < 1e-9, "binary NO loss payout should be zero");
  assert(Math.abs(binaryNoLoss.pnlUsd + 2.52) < 1e-9, "binary NO loss pnl formula mismatch");
  assert(classifyPaperResult(binaryNoLoss.pnlUsd) === "LOSS", "binary NO loss result should be LOSS");

  const ambiguousMapping = computePaperBinarySettlementPnl({
    qty: 3,
    entryPrice: 0.5,
    notionalUsd: 1.5,
    entryCostUsd: 1.5,
    feesUsd: 0.01,
    heldSide: "YES",
    heldTokenId: "same-token",
    yesTokenId: "same-token",
    noTokenId: "same-token",
    winningTokenId: "same-token"
  });
  assert(Math.abs(ambiguousMapping.exitPayoutUsd) < 1e-9, "ambiguous mapping must not pay out");
  assert(Math.abs(ambiguousMapping.pnlUsd + 1.51) < 1e-9, "ambiguous mapping should still subtract fees");
  assert(classifyPaperResult(ambiguousMapping.pnlUsd) === "LOSS", "ambiguous mapping should be treated as loss");

  const lowPriceQty = 198.69;
  const lowPriceEntry = 0.04;
  const lowPriceNotional = lowPriceQty * lowPriceEntry;
  const lowPriceSettlement = computePaperBinarySettlementPnl({
    qty: lowPriceQty,
    entryPrice: lowPriceEntry,
    notionalUsd: lowPriceNotional,
    entryCostUsd: lowPriceNotional,
    feesUsd: 0.1,
    heldSide: "YES",
    heldTokenId: yesToken,
    yesTokenId: yesToken,
    noTokenId: noToken,
    winningTokenId: yesToken
  });
  assert(Math.abs(lowPriceSettlement.exitPayoutUsd - 198.69) < 1e-9, "low-price settlement value mismatch");
  assert(Math.abs(lowPriceSettlement.pnlUsd - (198.69 - lowPriceNotional - 0.1)) < 1e-9, "low-price pnl mismatch");
  assert(Math.abs(lowPriceSettlement.exitPayoutUsd / lowPriceQty - 1) < 1e-12, "resolved binary exit must stay 1.0/share");

  const lowPriceLoss = computePaperBinarySettlementPnl({
    qty: lowPriceQty,
    entryPrice: lowPriceEntry,
    notionalUsd: lowPriceNotional,
    entryCostUsd: lowPriceNotional,
    feesUsd: 0.1,
    heldSide: "YES",
    heldTokenId: yesToken,
    yesTokenId: yesToken,
    noTokenId: noToken,
    winningTokenId: noToken
  });
  assert(Math.abs(lowPriceLoss.exitPayoutUsd) < 1e-9, "low-price losing settlement must pay zero");
  assert(Math.abs(lowPriceLoss.pnlUsd + lowPriceNotional + 0.1) < 1e-9, "low-price losing pnl mismatch");

  const lowPriceBounds = getPaperBinarySettlementBounds({
    qty: lowPriceQty,
    entryPrice: lowPriceEntry,
    entryCostUsd: lowPriceNotional
  });
  assert(Math.abs(lowPriceBounds.maxPayoutUsd - lowPriceQty) < 1e-9, "binary bounds should cap payout at share count");
  assert(250 > lowPriceBounds.maxPayoutUsd, "regression guard should flag payouts above binary max");

  const config = loadConfig();
  const engine = new PolymarketEngine(config, buildLogger(config));
  const engineAny = engine as any;
  const reversedMapping = {
    yesOutcomeMapped: "DOWN",
    noOutcomeMapped: "UP"
  };
  assert(
    engineAny.mapOutcomeToWinningTokenId("UP", { yesTokenId: yesToken, noTokenId: noToken }, reversedMapping) === noToken,
    "UP outcome should map to NO token when market outcome mapping is reversed"
  );
  assert(
    engineAny.mapOutcomeToWinningTokenId("DOWN", { yesTokenId: yesToken, noTokenId: noToken }, reversedMapping) === yesToken,
    "DOWN outcome should map to YES token when market outcome mapping is reversed"
  );

  assert(classifyPaperResult(0) === "FLAT", "zero pnl should classify as FLAT");

  assert(inferOutcomeFromOracle(45000, 44999) === "UP", "outcome UP mismatch");
  assert(inferOutcomeFromOracle(45000, 45001) === "DOWN", "outcome DOWN mismatch");

  // eslint-disable-next-line no-console
  console.log("Polymarket paper PnL tests: PASS");
}

run();
