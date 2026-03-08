import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { PaperLedger } from "../polymarket/paper/PaperLedger";
import { buildPolymarketTradesPayload } from "../web/DashboardServer";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const filePath = path.join(tmpdir(), `revx-polymarket-reporting-${Date.now()}.jsonl`);
  rmSync(filePath, { force: true });

  const ledger = new PaperLedger(filePath);
  const yesToken = "token-yes";
  const noToken = "token-no";

  const lowPriceWin = ledger.recordTrade({
    marketId: "m-low",
    marketSlug: "btc-updown-5m-low",
    windowStartTs: 1_000,
    windowEndTs: 2_000,
    side: "YES",
    entryPrice: 0.04,
    qty: 198.69,
    notionalUsd: 7.9476,
    feeBps: 5,
    slippageBps: 2,
    feesUsd: 0.1,
    entryCostUsd: 7.9476,
    priceToBeat: 100,
    yesTokenId: yesToken,
    noTokenId: noToken,
    yesDisplayLabel: "UP",
    noDisplayLabel: "DOWN",
    heldTokenId: yesToken,
    createdTs: 1_100
  });
  ledger.resolveTrade({
    tradeId: lowPriceWin.id,
    resolvedAt: 2_100,
    outcome: "UP",
    payoutUsd: 999,
    pnlUsd: 999,
    winningTokenId: yesToken,
    winningOutcomeText: "Up",
    resolutionSource: "OFFICIAL"
  });

  const yesLoss = ledger.recordTrade({
    marketId: "m-yes-loss",
    marketSlug: "btc-updown-5m-yes-loss",
    windowStartTs: 2_000,
    windowEndTs: 3_000,
    side: "YES",
    entryPrice: 0.4,
    qty: 10,
    notionalUsd: 4,
    feeBps: 5,
    slippageBps: 2,
    feesUsd: 0.02,
    entryCostUsd: 4,
    priceToBeat: 100,
    yesTokenId: yesToken,
    noTokenId: noToken,
    yesDisplayLabel: "UP",
    noDisplayLabel: "DOWN",
    heldTokenId: yesToken,
    createdTs: 2_100
  });
  ledger.resolveTrade({
    tradeId: yesLoss.id,
    resolvedAt: 3_100,
    outcome: "DOWN",
    payoutUsd: 111,
    pnlUsd: 111,
    winningTokenId: noToken,
    winningOutcomeText: "Down",
    resolutionSource: "OFFICIAL"
  });

  const noWin = ledger.recordTrade({
    marketId: "m-no-win",
    marketSlug: "btc-updown-5m-no-win",
    windowStartTs: 3_000,
    windowEndTs: 4_000,
    side: "NO",
    entryPrice: 0.55,
    qty: 5,
    notionalUsd: 2.75,
    feeBps: 5,
    slippageBps: 2,
    feesUsd: 0.01,
    entryCostUsd: 2.75,
    priceToBeat: 100,
    yesTokenId: yesToken,
    noTokenId: noToken,
    yesDisplayLabel: "UP",
    noDisplayLabel: "DOWN",
    heldTokenId: noToken,
    createdTs: 3_100
  });
  ledger.resolveTrade({
    tradeId: noWin.id,
    resolvedAt: 4_100,
    outcome: "DOWN",
    payoutUsd: 123,
    pnlUsd: 123,
    winningTokenId: noToken,
    winningOutcomeText: "Down",
    resolutionSource: "OFFICIAL"
  });

  const noLoss = ledger.recordTrade({
    marketId: "m-no-loss",
    marketSlug: "btc-updown-5m-no-loss",
    windowStartTs: 4_000,
    windowEndTs: 5_000,
    side: "NO",
    entryPrice: 0.55,
    qty: 5,
    notionalUsd: 2.75,
    feeBps: 5,
    slippageBps: 2,
    feesUsd: 0.01,
    entryCostUsd: 2.75,
    priceToBeat: 100,
    yesTokenId: yesToken,
    noTokenId: noToken,
    yesDisplayLabel: "UP",
    noDisplayLabel: "DOWN",
    heldTokenId: noToken,
    createdTs: 4_100
  });
  ledger.resolveTrade({
    tradeId: noLoss.id,
    resolvedAt: 5_100,
    outcome: "UP",
    payoutUsd: 456,
    pnlUsd: 456,
    winningTokenId: yesToken,
    winningOutcomeText: "Up",
    resolutionSource: "OFFICIAL"
  });

  const awaitingTrade = ledger.recordTrade({
    marketId: "m-awaiting",
    marketSlug: "btc-updown-5m-awaiting",
    windowStartTs: 5_000,
    windowEndTs: 6_000,
    side: "YES",
    entryPrice: 0.51,
    qty: 2,
    notionalUsd: 1.02,
    feeBps: 5,
    slippageBps: 2,
    feesUsd: 0.01,
    entryCostUsd: 1.02,
    priceToBeat: 100,
    yesTokenId: yesToken,
    noTokenId: noToken,
    yesDisplayLabel: "UP",
    noDisplayLabel: "DOWN",
    heldTokenId: yesToken,
    createdTs: 5_100
  });
  ledger.updateTradeStatus({
    tradeId: awaitingTrade.id,
    status: "AWAITING_RESOLUTION",
    statusUpdatedAt: 6_500,
    statusReason: "MARKET_CLOSED_AWAITING_OUTCOME",
    statusDetail: "Waiting for official winner",
    awaitingResolutionSinceTs: 6_000,
    lastResolutionAttemptTs: 6_500,
    resolutionAttempts: 1,
    resolutionContextState: "CLOSED_AWAITING_OUTCOME"
  });

  const errorTrade = ledger.recordTrade({
    marketId: "m-error",
    marketSlug: "btc-updown-5m-error",
    windowStartTs: 6_000,
    windowEndTs: 7_000,
    side: "NO",
    entryPrice: 0.49,
    qty: 2,
    notionalUsd: 0.98,
    feeBps: 5,
    slippageBps: 2,
    feesUsd: 0.01,
    entryCostUsd: 0.98,
    priceToBeat: 100,
    yesTokenId: yesToken,
    noTokenId: noToken,
    yesDisplayLabel: "UP",
    noDisplayLabel: "DOWN",
    heldTokenId: noToken,
    createdTs: 6_100
  });
  ledger.updateTradeStatus({
    tradeId: errorTrade.id,
    status: "RESOLUTION_ERROR",
    statusUpdatedAt: 7_500,
    statusReason: "RESOLUTION_FETCH_FAILED",
    statusDetail: "Temporary fetch failure",
    lastResolutionAttemptTs: 7_500,
    resolutionAttempts: 2,
    resolutionError: "Temporary fetch failure",
    resolutionErrorAt: 7_500,
    resolutionContextState: "FETCH_FAILED"
  });

  const cancelledTrade = ledger.recordTrade({
    marketId: "m-cancelled",
    marketSlug: "btc-updown-5m-cancelled",
    windowStartTs: 7_000,
    windowEndTs: 8_000,
    side: "YES",
    entryPrice: 0.52,
    qty: 2,
    notionalUsd: 1.04,
    feeBps: 5,
    slippageBps: 2,
    feesUsd: 0.01,
    entryCostUsd: 1.04,
    priceToBeat: 100,
    yesTokenId: yesToken,
    noTokenId: noToken,
    yesDisplayLabel: "UP",
    noDisplayLabel: "DOWN",
    heldTokenId: yesToken,
    createdTs: 7_100
  });
  ledger.cancelTrade({
    tradeId: cancelledTrade.id,
    resolvedAt: 8_100,
    cancelReason: "MARKET_CANCELLED",
    statusDetail: "Market voided",
    payoutUsd: cancelledTrade.notionalUsd,
    pnlUsd: 0,
    resolutionSource: "OFFICIAL"
  });

  const exitedLossTrade = ledger.recordTrade({
    marketId: "m-exited-loss",
    marketSlug: "btc-updown-5m-exited-loss",
    windowStartTs: 8_000,
    windowEndTs: 9_000,
    side: "YES",
    entryPrice: 0.6,
    qty: 5,
    notionalUsd: 3,
    feeBps: 5,
    slippageBps: 2,
    feesUsd: 0.01,
    entryCostUsd: 3,
    priceToBeat: 100,
    yesTokenId: yesToken,
    noTokenId: noToken,
    yesDisplayLabel: "UP",
    noDisplayLabel: "DOWN",
    heldTokenId: yesToken,
    createdTs: 8_100
  });
  ledger.closeTrade({
    tradeId: exitedLossTrade.id,
    resolvedAt: 8_700,
    closeReason: "STOP_LOSS",
    exitPrice: 0.3,
    exitProceedsUsd: 1.5,
    exitFeesUsd: 0.01,
    pnlUsd: -1.51
  });

  const payload = buildPolymarketTradesPayload(ledger, 10);
  assert(payload.wins === 2, `expected 2 wins, got ${payload.wins}`);
  assert(payload.losses === 2, `expected 2 losses, got ${payload.losses}`);
  assert(payload.awaitingResolutionTrades === 1, `expected 1 awaiting trade, got ${payload.awaitingResolutionTrades}`);
  assert(payload.resolutionErrorTrades === 1, `expected 1 resolution error trade, got ${payload.resolutionErrorTrades}`);
  assert(payload.cancelledTrades === 2, `expected 2 cancelled/exited trades, got ${payload.cancelledTrades}`);
  assert(payload.exitedEarlyTrades === 1, `expected 1 exited-early trade, got ${payload.exitedEarlyTrades}`);
  assert(
    Math.abs(payload.totalPnlUsd - ((198.69 - 7.9476 - 0.1) + (0 - 4 - 0.02) + (5 - 2.75 - 0.01) + (0 - 2.75 - 0.01))) < 1e-9,
    "payload total pnl should sum resolved binary trades only"
  );

  const rows = payload.rows;
  const findRow = (tradeId: string) => rows.find((row) => String(row.tradeId || row.id || "") === tradeId) as Record<string, unknown> | undefined;

  const lowPriceRow = findRow(lowPriceWin.id);
  assert(Boolean(lowPriceRow), "expected low-price row in payload");
  assert(String(lowPriceRow?.status || "") === "RESOLVED_WIN", "low-price row must be RESOLVED_WIN");
  assert(Math.abs(Number(lowPriceRow?.entryPricePerShare || 0) - 0.04) < 1e-9, "low-price entry/share mismatch");
  assert(Math.abs(Number(lowPriceRow?.exitPricePerShare || 0) - 1) < 1e-9, "low-price exit/share must be 1");
  assert(Math.abs(Number(lowPriceRow?.exitValueUsd || 0) - 198.69) < 1e-9, "low-price settlement value mismatch");
  assert(Number(lowPriceRow?.exitValueUsd || 0) <= Number(lowPriceRow?.qty || 0) + 1e-9, "binary payout must not exceed share count");
  assert(Math.abs(Number(lowPriceRow?.pnlUsd || 0) - (198.69 - 7.9476 - 0.1)) < 1e-9, "low-price pnl mismatch");
  assert(String(lowPriceRow?.result || "") === "WIN", "low-price row must be WIN");
  assert(String(lowPriceRow?.displaySide || "") === "UP", "bullish YES trade should display as UP");
  assert(String(lowPriceRow?.side || "") === "YES", "raw YES side must stay preserved");
  assert(String(lowPriceRow?.yesTokenId || "") === yesToken, "YES token id must stay preserved");
  assert(String(lowPriceRow?.noTokenId || "") === noToken, "NO token id must stay preserved");
  assert(Math.abs(Number(lowPriceRow?.cumulativePnlUsd || 0) - (198.69 - 7.9476 - 0.1)) < 1e-9, "low-price cumulative pnl mismatch");

  const yesLossRow = findRow(yesLoss.id);
  assert(Boolean(yesLossRow), "expected YES loss row in payload");
  assert(String(yesLossRow?.status || "") === "RESOLVED_LOSS", "YES loss row must be RESOLVED_LOSS");
  assert(Math.abs(Number(yesLossRow?.exitPricePerShare || 0)) < 1e-9, "YES loss exit/share must be 0");
  assert(Math.abs(Number(yesLossRow?.exitValueUsd || 0)) < 1e-9, "YES loss exit value must be 0");
  assert(Math.abs(Number(yesLossRow?.pnlUsd || 0) + 4.02) < 1e-9, "YES loss pnl mismatch");
  assert(String(yesLossRow?.result || "") === "LOSS", "YES loss row must be LOSS");

  const noWinRow = findRow(noWin.id);
  assert(Boolean(noWinRow), "expected NO win row in payload");
  assert(String(noWinRow?.status || "") === "RESOLVED_WIN", "NO win row must be RESOLVED_WIN");
  assert(Math.abs(Number(noWinRow?.exitPricePerShare || 0) - 1) < 1e-9, "NO win exit/share must be 1");
  assert(Math.abs(Number(noWinRow?.exitValueUsd || 0) - 5) < 1e-9, "NO win exit value mismatch");
  assert(Math.abs(Number(noWinRow?.pnlUsd || 0) - 2.24) < 1e-9, "NO win pnl mismatch");
  assert(String(noWinRow?.result || "") === "WIN", "NO win row must be WIN");
  assert(String(noWinRow?.displaySide || "") === "DOWN", "bearish NO trade should display as DOWN");
  assert(String(noWinRow?.side || "") === "NO", "raw NO side must stay preserved");

  const noLossRow = findRow(noLoss.id);
  assert(Boolean(noLossRow), "expected NO loss row in payload");
  assert(String(noLossRow?.status || "") === "RESOLVED_LOSS", "NO loss row must be RESOLVED_LOSS");
  assert(Math.abs(Number(noLossRow?.exitPricePerShare || 0)) < 1e-9, "NO loss exit/share must be 0");
  assert(Math.abs(Number(noLossRow?.exitValueUsd || 0)) < 1e-9, "NO loss exit value mismatch");
  assert(Math.abs(Number(noLossRow?.pnlUsd || 0) + 2.76) < 1e-9, "NO loss pnl mismatch");
  assert(String(noLossRow?.result || "") === "LOSS", "NO loss row must be LOSS");

  const awaitingRow = findRow(awaitingTrade.id);
  assert(Boolean(awaitingRow), "expected awaiting row in payload");
  assert(String(awaitingRow?.status || "") === "AWAITING_RESOLUTION", "awaiting row status mismatch");
  assert(String(awaitingRow?.statusReason || "") === "MARKET_CLOSED_AWAITING_OUTCOME", "awaiting reason mismatch");

  const errorRow = findRow(errorTrade.id);
  assert(Boolean(errorRow), "expected resolution error row in payload");
  assert(String(errorRow?.status || "") === "RESOLUTION_ERROR", "resolution error status mismatch");
  assert(String(errorRow?.resolutionError || "") === "Temporary fetch failure", "resolution error message mismatch");

  const cancelledRow = findRow(cancelledTrade.id);
  assert(Boolean(cancelledRow), "expected cancelled row in payload");
  assert(String(cancelledRow?.status || "") === "VOID", "void row status mismatch");
  assert(Math.abs(Number(cancelledRow?.pnlUsd || 0)) < 1e-9, "cancelled trade pnl should be 0");

  const exitedLossRow = findRow(exitedLossTrade.id);
  assert(Boolean(exitedLossRow), "expected exited-loss row in payload");
  assert(String(exitedLossRow?.status || "") === "EXITED_EARLY", "exited loss row status mismatch");
  assert(String(exitedLossRow?.result || "") === "LOSS", "negative exit should report LOSS");
  assert(Math.abs(Number(exitedLossRow?.pnlUsd || 0) + 1.51) < 1e-9, "exited loss pnl mismatch");

  rmSync(filePath, { force: true });
  // eslint-disable-next-line no-console
  console.log("Polymarket paper reporting tests: PASS");
}

run();
