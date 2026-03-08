import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config";
import { getTradingTruthReporter } from "../logging/truth";
import { buildLogger } from "../logger";
import { PaperLedger } from "../polymarket/paper/PaperLedger";
import { archiveAndResetPaperHistory } from "../polymarket/paper/resetPaperHistory";
import { DashboardServer } from "../web/DashboardServer";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "revx-paper-reset-"));
  const ledgerPath = path.join(rootDir, "data", "polymarket-paper-ledger.jsonl");
  const tradesPath = path.join(rootDir, "logs", "polymarket-paper-trades.jsonl");
  const decisionsPath = path.join(rootDir, "logs", "polymarket-decisions.jsonl");
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  mkdirSync(path.dirname(tradesPath), { recursive: true });
  mkdirSync(path.dirname(decisionsPath), { recursive: true });

  writeFileSync(ledgerPath, "ledger-old\n", "utf8");
  writeFileSync(tradesPath, "trades-old\n", "utf8");
  writeFileSync(decisionsPath, "decisions-old\n", "utf8");

  const fixedNow = new Date("2026-03-06T10:11:12Z");
  const result = archiveAndResetPaperHistory({ rootDir, now: fixedNow });

  assert(
    result.backupDir.endsWith(path.join("backups", "paper-reset-20260306T101112Z")),
    `unexpected backup dir: ${result.backupDir}`
  );
  assert(result.backupFiles.length === 3, `expected 3 backup files, got ${result.backupFiles.length}`);
  assert(
    result.backupFiles.every((filePath) => filePath.includes(".20260306T101112Z.")),
    `expected timestamped backup filenames, got ${result.backupFiles.join(", ")}`
  );
  assert(readFileSync(result.backupFiles[0], "utf8").trim().length > 0, "expected archived ledger content");
  assert(readFileSync(result.backupFiles[1], "utf8").trim().length > 0, "expected archived trades content");
  assert(readFileSync(result.backupFiles[2], "utf8").trim().length > 0, "expected archived decisions content");
  assert(readFileSync(ledgerPath, "utf8").length === 0, "expected reset ledger to be empty");
  assert(readFileSync(tradesPath, "utf8").length === 0, "expected reset trades log to be empty");
  assert(readFileSync(decisionsPath, "utf8").length === 0, "expected reset decisions log to be empty");
  const freshLedger = new PaperLedger(ledgerPath);
  const summary = freshLedger.getSummary(fixedNow.getTime());
  assert(summary.totalTrades === 0, `expected clean ledger after reset, got ${summary.totalTrades}`);
  assert(summary.resolvedTrades === 0, `expected resolvedTrades=0 after reset, got ${summary.resolvedTrades}`);
  assert(Math.abs(summary.totalPnlUsd) < 1e-9, `expected totalPnlUsd=0 after reset, got ${summary.totalPnlUsd}`);

  const previousCwd = process.cwd();
  process.chdir(rootDir);
  try {
    process.env.DRY_RUN = "true";
    process.env.POLYMARKET_ENABLED = "true";
    process.env.POLYMARKET_MODE = "paper";
    const base = loadConfig();
    const config = {
      ...base,
      dashboardEnabled: false,
      polymarket: {
        ...base.polymarket,
        enabled: true,
        mode: "paper" as const,
        paper: {
          ...base.polymarket.paper,
          ledgerPath: "data/polymarket-paper-ledger.jsonl"
        }
      }
    };
    const logger = buildLogger(config);
    const truth = getTradingTruthReporter(config, logger);
    truth.updatePolymarket({
      ts: fixedNow.getTime(),
      force: true,
      mode: "PAPER",
      enabled: true,
      liveConfirmed: false,
      killSwitch: false,
      polyEngineRunning: false,
      fetchOk: false,
      lastAction: "HOLD",
      openTrades: 7,
      resolvedTrades: 11,
      pnlTotalUsd: 999
    });

    const dashboard = new DashboardServer(config, logger, {} as any, "paper-reset-test");
    const truthStatusAfterReset = (dashboard as any).buildTruthStatus();
    assert(
      Math.abs(Number(truthStatusAfterReset.poly.pnlTotalUsd || 0)) < 1e-9,
      `expected truth-status pnlTotalUsd=0 after reset, got ${truthStatusAfterReset.poly.pnlTotalUsd}`
    );
    assert(
      Number(truthStatusAfterReset.poly.resolvedTrades || 0) === 0,
      `expected truth-status resolvedTrades=0 after reset, got ${truthStatusAfterReset.poly.resolvedTrades}`
    );
    assert(truthStatusAfterReset.poly.lastTrade === null, "expected truth-status lastTrade cleared after reset");

    const newTrade = freshLedger.recordTrade({
      marketId: "m-new",
      marketSlug: "btc-updown-5m-new",
      windowStartTs: 10_000,
      windowEndTs: 20_000,
      side: "YES",
      entryPrice: 0.5,
      qty: 2,
      notionalUsd: 1,
      feeBps: 0,
      slippageBps: 0,
      feesUsd: 0,
      entryCostUsd: 1,
      priceToBeat: 100,
      yesTokenId: "new-yes",
      noTokenId: "new-no",
      heldTokenId: "new-yes",
      createdTs: 11_000
    });
    freshLedger.resolveTrade({
      tradeId: newTrade.id,
      resolvedAt: 21_000,
      outcome: "UP",
      payoutUsd: 2,
      pnlUsd: 1,
      winningTokenId: "new-yes",
      resolutionSource: "OFFICIAL"
    });
    const truthStatusAfterNewTrade = (dashboard as any).buildTruthStatus();
    assert(
      Math.abs(Number(truthStatusAfterNewTrade.poly.pnlTotalUsd || 0) - 1) < 1e-9,
      `expected truth-status pnlTotalUsd=1 from fresh ledger only, got ${truthStatusAfterNewTrade.poly.pnlTotalUsd}`
    );
    assert(
      Number(truthStatusAfterNewTrade.poly.resolvedTrades || 0) === 1,
      `expected truth-status resolvedTrades=1 after new trade, got ${truthStatusAfterNewTrade.poly.resolvedTrades}`
    );
  } finally {
    process.chdir(previousCwd);
  }
  // eslint-disable-next-line no-console
  console.log("Polymarket paper reset tests: PASS");
}

run();
