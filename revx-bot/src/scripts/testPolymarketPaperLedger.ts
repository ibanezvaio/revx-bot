import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { PaperLedger, getPaperTradeStatus } from "../polymarket/paper/PaperLedger";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const filePath = path.join(tmpdir(), `revx-polymarket-ledger-${Date.now()}.jsonl`);
  rmSync(filePath, { force: true });

  const ledger = new PaperLedger(filePath);
  const trade = ledger.recordTrade({
    marketId: "m1",
    windowStartTs: 1_000,
    windowEndTs: 2_000,
    side: "YES",
    entryPrice: 0.51,
    qty: 2,
    notionalUsd: 1.02,
    feeBps: 5,
    slippageBps: 2,
    feesUsd: 0.00051,
    entryCostUsd: 1.02,
    priceToBeat: 50_000,
    createdTs: 1_500
  });
  ledger.resolveTrade({
    tradeId: trade.id,
    resolvedAt: 2_100,
    outcome: "UP",
    payoutUsd: 2,
    pnlUsd: 999,
    winningTokenId: "yes-token",
    oracleAtEnd: 50_010,
    resolutionSource: "OFFICIAL"
  });
  const openThenClose = ledger.recordTrade({
    marketId: "m2",
    windowStartTs: 2_000,
    windowEndTs: 3_000,
    side: "NO",
    entryPrice: 0.48,
    qty: 3,
    notionalUsd: 1.44,
    feeBps: 5,
    slippageBps: 2,
    feesUsd: 0.00072,
    entryCostUsd: 1.44,
    priceToBeat: 49_800,
    createdTs: 2_200
  });
  ledger.closeTrade({
    tradeId: openThenClose.id,
    resolvedAt: 2_700,
    closeReason: "STOP_LOSS",
    exitPrice: 0.40,
    exitProceedsUsd: 1.2,
    exitFeesUsd: 0.0006,
    pnlUsd: -0.2406
  });

  assert(existsSync(filePath), "expected ledger file to exist");
  const raw = readFileSync(filePath, "utf8").trim().split(/\r?\n/);
  assert(raw.length >= 4, `expected at least 4 events, got ${raw.length}`);

  const reloaded = new PaperLedger(filePath, { readOnly: true });
  const summary = reloaded.getSummary(2_200);
  assert(summary.totalTrades === 2, `expected totalTrades 2, got ${summary.totalTrades}`);
  assert(summary.resolvedTrades === 1, `expected resolvedTrades 1, got ${summary.resolvedTrades}`);
  assert(summary.cancelledTrades === 1, `expected cancelledTrades 1, got ${summary.cancelledTrades}`);
  assert(summary.openPositions === 0, `expected openPositions 0, got ${summary.openPositions}`);
  assert(Math.abs(Number(reloaded.getTrade(trade.id)?.exitPrice || 0) - 1) < 1e-9, "binary resolved exit price must be 1/share");
  assert(Math.abs(Number(reloaded.getTrade(trade.id)?.exitProceedsUsd || 0) - 2) < 1e-9, "binary resolved payout must stay aggregate settlement only");
  assert(
    Math.abs(Number(reloaded.getTrade(trade.id)?.pnlUsd || 0) - (2 - 1.02 - 0.00051)) < 1e-9,
    "resolved binary pnl must subtract entry fees"
  );
  assert(
    getPaperTradeStatus(reloaded.getTrade(openThenClose.id)!) === "EXITED_EARLY",
    "paper exit should now be EXITED_EARLY"
  );
  assert(
    Math.abs(summary.totalPnlUsd - (2 - 1.02 - 0.00051)) < 1e-9,
    "summary total pnl should come from resolved trades only"
  );
  assert(summary.wins === 1, `expected one win, got ${summary.wins}`);
  assert(summary.losses === 0, `expected zero resolved losses, got ${summary.losses}`);
  assert(reloaded.getEquitySeries().length === 1, "equity series should use resolved trades only");

  rmSync(filePath, { force: true });
  // eslint-disable-next-line no-console
  console.log("Polymarket paper ledger tests: PASS");
}

run();
