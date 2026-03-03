import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { PaperLedger } from "../polymarket/paper/PaperLedger";

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
    pnlUsd: 0.97949,
    oracleAtEnd: 50_010,
    resolutionSource: "oracle_proxy"
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
  assert(summary.resolvedTrades === 2, `expected resolvedTrades 2, got ${summary.resolvedTrades}`);
  assert(summary.openPositions === 0, `expected openPositions 0, got ${summary.openPositions}`);
  assert(summary.totalPnlUsd > 0.70, "expected positive net pnl in reloaded summary");
  assert(summary.wins === 1, `expected one win, got ${summary.wins}`);
  assert(summary.losses === 1, `expected one loss, got ${summary.losses}`);
  assert(reloaded.getEquitySeries().length === 2, "expected equity points after resolved and closed trades");

  rmSync(filePath, { force: true });
  // eslint-disable-next-line no-console
  console.log("Polymarket paper ledger tests: PASS");
}

run();
