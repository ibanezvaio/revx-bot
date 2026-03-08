import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { PolymarketEngine } from "../polymarket/PolymarketEngine";
import { getPaperTradeStatus } from "../polymarket/paper/PaperLedger";

process.env.DRY_RUN = "true";
process.env.POLYMARKET_ENABLED = "true";
process.env.POLYMARKET_MODE = "paper";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

type StubMarketContext = {
  marketId: string;
  slug: string;
  active: boolean | null;
  closed: boolean;
  acceptingOrders: boolean | null;
  enableOrderBook: boolean | null;
  archived: boolean | null;
  cancelled: boolean;
  resolution: {
    yesTokenId: string | null;
    noTokenId: string | null;
    winningTokenId: string | null;
    winningSide: "YES" | "NO" | null;
    winningOutcome: "UP" | "DOWN" | null;
    winningOutcomeText: string | null;
    yesOutcomeMapped: "UP" | "DOWN" | null;
    noOutcomeMapped: "UP" | "DOWN" | null;
    resolved: boolean;
  };
};

function makeContext(input: {
  marketId: string;
  slug: string;
  yesTokenId: string;
  noTokenId: string;
  winningTokenId?: string | null;
  winningSide?: "YES" | "NO" | null;
  winningOutcome?: "UP" | "DOWN" | null;
  winningOutcomeText?: string | null;
  closed: boolean;
  active?: boolean | null;
  acceptingOrders?: boolean | null;
  cancelled?: boolean;
}): StubMarketContext {
  return {
    marketId: input.marketId,
    slug: input.slug,
    active: input.active ?? false,
    closed: input.closed,
    acceptingOrders: input.acceptingOrders ?? false,
    enableOrderBook: true,
    archived: false,
    cancelled: Boolean(input.cancelled),
    resolution: {
      yesTokenId: input.yesTokenId,
      noTokenId: input.noTokenId,
      winningTokenId: input.winningTokenId ?? null,
      winningSide: input.winningSide ?? null,
      winningOutcome: input.winningOutcome ?? null,
      winningOutcomeText: input.winningOutcomeText ?? null,
      yesOutcomeMapped: "UP",
      noOutcomeMapped: "DOWN",
      resolved: input.closed
    }
  };
}

function buildEngine(
  ledgerPath: string,
  responseQueue: Array<StubMarketContext | Error | null>,
  options: { resolveGraceMs?: number; fallbackPrice?: number } = {}
): any {
  const base = loadConfig();
  const config = {
    ...base,
    polymarket: {
      ...base.polymarket,
      enabled: true,
      mode: "paper" as const,
      paper: {
        ...base.polymarket.paper,
        ledgerPath,
        resolveGraceMs: options.resolveGraceMs ?? 0
      }
    }
  };
  const logger = buildLogger(config);
  const engine = new PolymarketEngine(config, logger);
  const engineAny = engine as any;
  const fallbackPrice = options.fallbackPrice ?? 101;
  engineAny.client = {
    getMarketContext: async () => {
      const next = responseQueue.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next ?? null;
    }
  };
  engineAny.oracleRouter = {
    getFastMidNow: () => ({
      price: fallbackPrice,
      ts: Date.now(),
      source: "internal_fair_mid"
    }),
    getOracleNow: async () => ({
      price: fallbackPrice,
      source: "internal_fair_mid",
      ts: Date.now(),
      rawTs: Date.now(),
      staleMs: 0,
      state: "OK",
      fallbackSigmaPricePerSqrtSec: 0.1
    })
  };
  return engineAny;
}

function seedTrade(engineAny: any, input: {
  marketId: string;
  slug: string;
  side: "YES" | "NO";
  yesTokenId: string;
  noTokenId: string;
  nowTs: number;
  expiredAgoMs?: number;
  createdAgoMs?: number;
}): string {
  const expiredAgoMs = input.expiredAgoMs ?? 60_000;
  const createdAgoMs = input.createdAgoMs ?? Math.max(expiredAgoMs + 30_000, 90_000);
  const expectedCloseTs = input.nowTs - expiredAgoMs;
  const windowEndTs = expectedCloseTs;
  const windowStartTs = expectedCloseTs - 60_000;
  const trade = engineAny.paperLedger.recordTrade({
    marketId: input.marketId,
    marketSlug: input.slug,
    windowStartTs,
    windowEndTs,
    expectedCloseTs,
    side: input.side,
    entryPrice: input.side === "YES" ? 0.4 : 0.6,
    qty: 10,
    notionalUsd: input.side === "YES" ? 4 : 6,
    feeBps: 0,
    slippageBps: 0,
    feesUsd: 0,
    entryCostUsd: input.side === "YES" ? 4 : 6,
    priceToBeat: 100,
    yesTokenId: input.yesTokenId,
    noTokenId: input.noTokenId,
    heldTokenId: input.side === "YES" ? input.yesTokenId : input.noTokenId,
    createdTs: input.nowTs - createdAgoMs
  });
  return trade.id;
}

async function runAwaitingScenario(nowTs: number): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-awaiting-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const marketId = "awaiting-market";
  const yesTokenId = "awaiting-yes";
  const noTokenId = "awaiting-no";
  const engineAny = buildEngine(ledgerPath, [
    makeContext({
      marketId,
      slug: "btc-updown-5m-awaiting",
      yesTokenId,
      noTokenId,
      closed: true,
      active: false,
      acceptingOrders: false
    })
  ], { resolveGraceMs: 30_000, fallbackPrice: 101 });
  const tradeId = seedTrade(engineAny, {
    marketId,
    slug: "btc-updown-5m-awaiting",
    side: "YES",
    yesTokenId,
    noTokenId,
    nowTs,
    expiredAgoMs: 5_000,
    createdAgoMs: 35_000
  });
  await engineAny.resolvePaperTrades(nowTs);
  const trade = engineAny.paperLedger.getTrade(tradeId);
  assert(Boolean(trade), "awaiting scenario trade missing");
  assert(getPaperTradeStatus(trade) === "AWAITING_RESOLUTION", "trade should wait for official result");
  assert(engineAny.paperLedger.getResolvedTrades().length === 0, "awaiting trade must not resolve");
  rmSync(ledgerPath, { force: true });
}

async function runOfficialUpScenario(nowTs: number): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-up-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const marketId = "up-market";
  const yesTokenId = "up-yes";
  const noTokenId = "up-no";
  const engineAny = buildEngine(ledgerPath, [
    makeContext({
      marketId,
      slug: "btc-updown-5m-up",
      yesTokenId,
      noTokenId,
      closed: true,
      winningTokenId: yesTokenId,
      winningSide: "YES",
      winningOutcome: "UP",
      winningOutcomeText: "UP"
    })
  ], { fallbackPrice: 101 });
  const tradeId = seedTrade(engineAny, {
    marketId,
    slug: "btc-updown-5m-up",
    side: "YES",
    yesTokenId,
    noTokenId,
    nowTs
  });
  await engineAny.resolvePaperTrades(nowTs);
  const trade = engineAny.paperLedger.getTrade(tradeId);
  assert(Boolean(trade), "official UP trade missing");
  assert(getPaperTradeStatus(trade) === "RESOLVED_WIN", "YES trade should win on official UP");
  assert(Math.abs(Number(trade?.exitPrice || 0) - 1) < 1e-9, "resolved UP exit price must be 1/share");
  assert(String(trade?.resolutionSource || "") === "OFFICIAL", "official UP trade should be tagged OFFICIAL");
  rmSync(ledgerPath, { force: true });
}

async function runOfficialDownScenario(nowTs: number): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-down-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const marketId = "down-market";
  const yesTokenId = "down-yes";
  const noTokenId = "down-no";
  const engineAny = buildEngine(ledgerPath, [
    makeContext({
      marketId,
      slug: "btc-updown-5m-down",
      yesTokenId,
      noTokenId,
      closed: true,
      winningTokenId: noTokenId,
      winningSide: "NO",
      winningOutcome: "DOWN",
      winningOutcomeText: "DOWN"
    })
  ], { fallbackPrice: 99 });
  const tradeId = seedTrade(engineAny, {
    marketId,
    slug: "btc-updown-5m-down",
    side: "NO",
    yesTokenId,
    noTokenId,
    nowTs
  });
  await engineAny.resolvePaperTrades(nowTs);
  const trade = engineAny.paperLedger.getTrade(tradeId);
  assert(Boolean(trade), "official DOWN trade missing");
  assert(getPaperTradeStatus(trade) === "RESOLVED_WIN", "NO trade should win on official DOWN");
  assert(Math.abs(Number(trade?.exitPrice || 0) - 1) < 1e-9, "resolved DOWN exit price must be 1/share");
  assert(String(trade?.resolutionSource || "") === "OFFICIAL", "official DOWN trade should be tagged OFFICIAL");
  rmSync(ledgerPath, { force: true });
}

async function runCancelledScenario(nowTs: number): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-cancel-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const marketId = "cancel-market";
  const yesTokenId = "cancel-yes";
  const noTokenId = "cancel-no";
  const engineAny = buildEngine(ledgerPath, [
    makeContext({
      marketId,
      slug: "btc-updown-5m-cancelled",
      yesTokenId,
      noTokenId,
      closed: true,
      cancelled: true
    })
  ], { fallbackPrice: 100 });
  const tradeId = seedTrade(engineAny, {
    marketId,
    slug: "btc-updown-5m-cancelled",
    side: "YES",
    yesTokenId,
    noTokenId,
    nowTs
  });
  await engineAny.resolvePaperTrades(nowTs);
  const trade = engineAny.paperLedger.getTrade(tradeId);
  assert(Boolean(trade), "cancelled trade missing");
  assert(getPaperTradeStatus(trade) === "VOID", "cancelled market should mark trade VOID");
  assert(Math.abs(Number(trade?.pnlUsd || 0)) < 1e-9, "cancelled market should keep pnl at 0");
  rmSync(ledgerPath, { force: true });
}

async function runFallbackScenario(nowTs: number): Promise<void> {
  const ledgerPath = path.join(tmpdir(), `revx-poly-fallback-${Date.now()}.jsonl`);
  rmSync(ledgerPath, { force: true });
  const marketId = "fallback-market";
  const yesTokenId = "fallback-yes";
  const noTokenId = "fallback-no";
  const engineAny = buildEngine(ledgerPath, [
    new Error("temporary gamma failure")
  ], { fallbackPrice: 99.2 });
  const tradeId = seedTrade(engineAny, {
    marketId,
    slug: "btc-updown-5m-fallback",
    side: "YES",
    yesTokenId,
    noTokenId,
    nowTs
  });

  await engineAny.resolvePaperTrades(nowTs);
  const trade = engineAny.paperLedger.getTrade(tradeId);
  assert(Boolean(trade), "fallback trade missing");
  assert(getPaperTradeStatus(trade) === "RESOLVED_LOSS", "fallback resolution should settle the trade");
  assert(String(trade?.resolutionSource || "") === "DERIVED_FALLBACK", "fallback trade should be tagged DERIVED_FALLBACK");
  assert(Number(trade?.oracleAtEnd || 0) === 99.2, "fallback resolution should persist derived reference price");

  const lines = readFileSync(ledgerPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert(
    lines.some((line) => line.kind === "trade_resolved" && line.status === "RESOLVED_LOSS" && line.resolutionSource === "DERIVED_FALLBACK"),
    "ledger should persist derived fallback resolution"
  );
  rmSync(ledgerPath, { force: true });
}

async function run(): Promise<void> {
  const nowTs = Date.now();
  await runAwaitingScenario(nowTs);
  await runOfficialUpScenario(nowTs + 10_000);
  await runOfficialDownScenario(nowTs + 20_000);
  await runCancelledScenario(nowTs + 30_000);
  await runFallbackScenario(nowTs + 40_000);
  // eslint-disable-next-line no-console
  console.log("Polymarket paper lifecycle test: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Polymarket paper lifecycle test: FAIL", error);
  process.exit(1);
});
