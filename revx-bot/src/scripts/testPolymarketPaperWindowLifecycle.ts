import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { PaperLedger } from "../polymarket/paper/PaperLedger";
import { computePaperPnl, inferOutcomeFromOracle } from "../polymarket/paper/PaperMath";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const filePath = path.join(tmpdir(), `revx-polymarket-lifecycle-${Date.now()}.jsonl`);
  rmSync(filePath, { force: true });

  const nowTs = Date.now();
  const windowStartTs = nowTs - 120_000;
  const windowEndTs = nowTs - 10_000;
  const priceToBeat = 85_000;

  const ledger = new PaperLedger(filePath);
  const trade = ledger.recordTrade({
    marketId: "m-window-1",
    marketSlug: "btc-updown-5m-test",
    windowStartTs,
    windowEndTs,
    side: "YES",
    entryPrice: 0.53,
    qty: 2,
    notionalUsd: 1.06,
    feeBps: 5,
    slippageBps: 2,
    feesUsd: 0.00053,
    entryCostUsd: 1.06,
    priceToBeat,
    createdTs: windowStartTs + 30_000
  });

  const finalOraclePrice = 85_010;
  const winner = inferOutcomeFromOracle(finalOraclePrice, priceToBeat);
  const pnl = computePaperPnl({
    side: trade.side,
    outcome: winner,
    qty: trade.qty,
    entryPrice: trade.entryPrice,
    feeBps: trade.feeBps
  });
  ledger.resolveTrade({
    tradeId: trade.id,
    resolvedAt: nowTs,
    outcome: winner,
    payoutUsd: pnl.payoutUsd,
    pnlUsd: pnl.pnlUsd,
    oracleAtEnd: finalOraclePrice,
    resolutionSource: "oracle_proxy"
  });

  const events = readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const open = events.find((row) => row.kind === "trade_open");
  const resolved = events.find((row) => row.kind === "trade_resolved");
  assert(Boolean(open), "expected trade_open event");
  assert(Boolean(resolved), "expected trade_resolved event");
  assert(resolved?.winner === "UP", `expected winner=UP, got ${String(resolved?.winner)}`);
  assert(Number(resolved?.finalOraclePrice || 0) === finalOraclePrice, "finalOraclePrice missing in resolved event");
  assert(Number(resolved?.exitPayoutUsd || 0) > 0, "exitPayoutUsd missing in resolved event");

  const summary = ledger.getSummary(nowTs);
  assert(summary.openPositions === 0, `expected no open positions, got ${summary.openPositions}`);
  assert(summary.resolvedTrades === 1, `expected 1 resolved trade, got ${summary.resolvedTrades}`);
  assert(summary.totalPnlUsd > 0, "expected positive pnl for winning trade");

  rmSync(filePath, { force: true });
  // eslint-disable-next-line no-console
  console.log("Polymarket paper lifecycle test: PASS");
}

run();
