import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PaperOutcome, PaperSide } from "./PaperMath";

export type PaperTrade = {
  id: string;
  marketId: string;
  marketSlug?: string;
  windowStartTs: number;
  windowEndTs: number;
  side: PaperSide;
  entryPrice: number;
  qty: number;
  notionalUsd: number;
  feeBps: number;
  slippageBps: number;
  feesUsd: number;
  entryCostUsd: number;
  priceToBeat: number;
  yesTokenId?: string;
  noTokenId?: string;
  heldTokenId?: string;
  createdTs: number;
  resolvedAt?: number;
  outcome?: PaperOutcome;
  payoutUsd?: number;
  pnlUsd?: number;
  winningTokenId?: string;
  winningOutcomeText?: string;
  oracleAtEnd?: number;
  resolutionSource?: "market_api" | "oracle_proxy" | "internal_fair_mid" | "paper_exit";
  closeReason?: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "MANUAL";
  exitPrice?: number;
  exitProceedsUsd?: number;
  exitFeesUsd?: number;
};

type TradeOpenEvent = {
  kind: "trade_open";
  ts: number;
  trade: PaperTrade;
};

type TradeResolvedEvent = {
  kind: "trade_resolved";
  ts: number;
  tradeId: string;
  marketId: string;
  windowEndTs: number;
  resolvedAt: number;
  winner: PaperOutcome;
  finalOraclePrice?: number;
  exitPayoutUsd: number;
  outcome: PaperOutcome;
  winningTokenId?: string;
  winningOutcomeText?: string;
  payoutUsd: number;
  pnlUsd: number;
  oracleAtEnd?: number;
  resolutionSource: "market_api" | "oracle_proxy" | "internal_fair_mid";
};

type TradeClosedEvent = {
  kind: "trade_closed";
  ts: number;
  tradeId: string;
  marketId: string;
  resolvedAt: number;
  closeReason: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "MANUAL";
  exitPrice: number;
  exitProceedsUsd: number;
  exitFeesUsd: number;
  pnlUsd: number;
};

type StartupEvent = {
  type: "startup";
  ts: number;
  mode?: string;
};

type PaperLedgerEvent = TradeOpenEvent | TradeResolvedEvent | TradeClosedEvent | StartupEvent;

export type PaperSummary = {
  totalTrades: number;
  resolvedTrades: number;
  openPositions: number;
  totalPnlUsd: number;
  todayPnlUsd: number;
  pnl24hUsd: number;
  winRate: number;
  wins: number;
  losses: number;
  flats: number;
  lastResolved?: PaperTrade;
};

export type EquityPoint = {
  ts: number;
  equityUsd: number;
};

export class PaperLedger {
  private readonly trades = new Map<string, PaperTrade>();

  constructor(
    private readonly filePath: string,
    private readonly options: {
      readOnly?: boolean;
    } = {}
  ) {
    if (!this.options.readOnly) {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
    }
    this.reloadFromDisk();
  }

  static loadSnapshot(filePath: string): PaperLedger {
    return new PaperLedger(filePath, { readOnly: true });
  }

  reloadFromDisk(): void {
    this.trades.clear();
    if (!existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = parseEvent(trimmed);
      if (!event) continue;
      if ("kind" in event && event.kind === "trade_open") {
        this.trades.set(event.trade.id, { ...event.trade });
      } else if ("kind" in event && event.kind === "trade_resolved") {
        const trade = this.trades.get(event.tradeId);
        if (!trade) continue;
        trade.resolvedAt = event.resolvedAt;
        trade.outcome = event.outcome;
        trade.payoutUsd = event.payoutUsd;
        trade.pnlUsd = event.pnlUsd;
        trade.winningTokenId = event.winningTokenId;
        trade.winningOutcomeText = event.winningOutcomeText;
        trade.oracleAtEnd = event.oracleAtEnd;
        trade.resolutionSource = event.resolutionSource;
      } else if ("kind" in event && event.kind === "trade_closed") {
        const trade = this.trades.get(event.tradeId);
        if (!trade) continue;
        trade.resolvedAt = event.resolvedAt;
        trade.pnlUsd = event.pnlUsd;
        trade.resolutionSource = "paper_exit";
        trade.closeReason = event.closeReason;
        trade.exitPrice = event.exitPrice;
        trade.exitProceedsUsd = event.exitProceedsUsd;
        trade.exitFeesUsd = event.exitFeesUsd;
      }
    }
  }

  appendStartup(mode?: string): void {
    this.assertWritable();
    this.appendEvent({
      type: "startup",
      ts: Date.now(),
      mode
    });
  }

  recordTrade(input: {
    marketId: string;
    marketSlug?: string;
    windowStartTs: number;
    windowEndTs: number;
    side: PaperSide;
    entryPrice: number;
    qty: number;
    notionalUsd: number;
    feeBps: number;
    slippageBps: number;
    feesUsd: number;
    entryCostUsd: number;
    priceToBeat: number;
    yesTokenId?: string;
    noTokenId?: string;
    heldTokenId?: string;
    createdTs?: number;
  }): PaperTrade {
    this.assertWritable();
    const trade: PaperTrade = {
      id: randomUUID(),
      marketId: input.marketId,
      marketSlug: input.marketSlug,
      windowStartTs: input.windowStartTs,
      windowEndTs: input.windowEndTs,
      side: input.side,
      entryPrice: input.entryPrice,
      qty: input.qty,
      notionalUsd: input.notionalUsd,
      feeBps: input.feeBps,
      slippageBps: input.slippageBps,
      feesUsd: input.feesUsd,
      entryCostUsd: input.entryCostUsd,
      priceToBeat: input.priceToBeat,
      yesTokenId: input.yesTokenId,
      noTokenId: input.noTokenId,
      heldTokenId: input.heldTokenId,
      createdTs: input.createdTs ?? Date.now()
    };
    this.trades.set(trade.id, trade);
    this.appendEvent({
      kind: "trade_open",
      ts: Date.now(),
      trade
    });
    return trade;
  }

  resolveTrade(input: {
    tradeId: string;
    resolvedAt: number;
    outcome: PaperOutcome;
    payoutUsd: number;
    pnlUsd: number;
    winningTokenId?: string;
    winningOutcomeText?: string;
    oracleAtEnd?: number;
    resolutionSource: "market_api" | "oracle_proxy" | "internal_fair_mid";
  }): PaperTrade | null {
    this.assertWritable();
    const trade = this.trades.get(input.tradeId);
    if (!trade) return null;
    if (trade.resolvedAt) return trade;

    trade.resolvedAt = input.resolvedAt;
    trade.outcome = input.outcome;
    trade.payoutUsd = input.payoutUsd;
    trade.pnlUsd = input.pnlUsd;
    trade.winningTokenId = input.winningTokenId;
    trade.winningOutcomeText = input.winningOutcomeText;
    trade.oracleAtEnd = input.oracleAtEnd;
    trade.resolutionSource = input.resolutionSource;

    this.appendEvent({
      kind: "trade_resolved",
      ts: Date.now(),
      tradeId: input.tradeId,
      marketId: trade.marketId,
      windowEndTs: trade.windowEndTs,
      resolvedAt: input.resolvedAt,
      winner: input.outcome,
      finalOraclePrice: input.oracleAtEnd,
      exitPayoutUsd: input.payoutUsd,
      outcome: input.outcome,
      winningTokenId: input.winningTokenId,
      winningOutcomeText: input.winningOutcomeText,
      payoutUsd: input.payoutUsd,
      pnlUsd: input.pnlUsd,
      oracleAtEnd: input.oracleAtEnd,
      resolutionSource: input.resolutionSource
    });

    return trade;
  }

  closeTrade(input: {
    tradeId: string;
    resolvedAt: number;
    closeReason: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "MANUAL";
    exitPrice: number;
    exitProceedsUsd: number;
    exitFeesUsd: number;
    pnlUsd: number;
  }): PaperTrade | null {
    this.assertWritable();
    const trade = this.trades.get(input.tradeId);
    if (!trade) return null;
    if (trade.resolvedAt) return trade;

    trade.resolvedAt = input.resolvedAt;
    trade.pnlUsd = input.pnlUsd;
    trade.resolutionSource = "paper_exit";
    trade.closeReason = input.closeReason;
    trade.exitPrice = input.exitPrice;
    trade.exitProceedsUsd = input.exitProceedsUsd;
    trade.exitFeesUsd = input.exitFeesUsd;

    this.appendEvent({
      kind: "trade_closed",
      ts: Date.now(),
      tradeId: input.tradeId,
      marketId: trade.marketId,
      resolvedAt: input.resolvedAt,
      closeReason: input.closeReason,
      exitPrice: input.exitPrice,
      exitProceedsUsd: input.exitProceedsUsd,
      exitFeesUsd: input.exitFeesUsd,
      pnlUsd: input.pnlUsd
    });

    return trade;
  }

  getTrade(tradeId: string): PaperTrade | null {
    const trade = this.trades.get(tradeId);
    return trade ? { ...trade } : null;
  }

  getOpenTrades(): PaperTrade[] {
    return this.getAllTrades()
      .filter((row) => !row.resolvedAt)
      .sort((a, b) => a.createdTs - b.createdTs);
  }

  getResolvedTrades(): PaperTrade[] {
    return this.getAllTrades()
      .filter((row) => Boolean(row.resolvedAt))
      .sort((a, b) => (a.resolvedAt || 0) - (b.resolvedAt || 0));
  }

  getAllTrades(): PaperTrade[] {
    return Array.from(this.trades.values()).map((row) => ({ ...row }));
  }

  getRecentTrades(limit = 200): PaperTrade[] {
    return this.getAllTrades()
      .sort((a, b) => b.createdTs - a.createdTs)
      .slice(0, Math.max(1, Math.floor(limit)));
  }

  countTradesSince(sinceTs: number): number {
    return this.getAllTrades().filter((row) => row.createdTs >= sinceTs).length;
  }

  getOpenNotionalForMarket(marketId: string): number {
    return this.getOpenTrades()
      .filter((row) => row.marketId === marketId)
      .reduce((sum, row) => sum + Math.max(0, row.notionalUsd), 0);
  }

  hasTradeForWindow(marketId: string, windowStartTs: number, windowEndTs: number): boolean {
    for (const row of this.trades.values()) {
      if (
        row.marketId === marketId &&
        Number(row.windowStartTs) === Number(windowStartTs) &&
        Number(row.windowEndTs) === Number(windowEndTs)
      ) {
        return true;
      }
    }
    return false;
  }

  getTradesForWindow(marketId: string, windowStartTs: number, windowEndTs: number): PaperTrade[] {
    return this.getAllTrades().filter(
      (row) =>
        row.marketId === marketId &&
        Number(row.windowStartTs) === Number(windowStartTs) &&
        Number(row.windowEndTs) === Number(windowEndTs)
    );
  }

  getSummary(nowTs = Date.now()): PaperSummary {
    const all = this.getAllTrades();
    const resolved = all.filter((row) => Boolean(row.resolvedAt));
    const open = all.filter((row) => !row.resolvedAt);

    const totalPnlUsd = resolved.reduce((sum, row) => sum + Number(row.pnlUsd || 0), 0);
    const dayStart = new Date(nowTs).toISOString().slice(0, 10);
    const todayPnlUsd = resolved
      .filter((row) => row.resolvedAt && new Date(row.resolvedAt).toISOString().startsWith(dayStart))
      .reduce((sum, row) => sum + Number(row.pnlUsd || 0), 0);
    const pnl24hUsd = resolved
      .filter((row) => Number(row.resolvedAt || 0) >= nowTs - 24 * 60 * 60 * 1000)
      .reduce((sum, row) => sum + Number(row.pnlUsd || 0), 0);
    const wins = resolved.filter((row) => Number(row.pnlUsd || 0) > 0).length;
    const losses = resolved.filter((row) => Number(row.pnlUsd || 0) < 0).length;
    const flats = resolved.filter((row) => Number(row.pnlUsd || 0) === 0).length;
    const winRate = resolved.length > 0 ? wins / resolved.length : 0;
    const lastResolved = resolved
      .slice()
      .sort((a, b) => Number(b.resolvedAt || 0) - Number(a.resolvedAt || 0))[0];

    return {
      totalTrades: all.length,
      resolvedTrades: resolved.length,
      openPositions: open.length,
      totalPnlUsd,
      todayPnlUsd,
      pnl24hUsd,
      winRate,
      wins,
      losses,
      flats,
      lastResolved
    };
  }

  getEquitySeries(): EquityPoint[] {
    const resolved = this.getResolvedTrades();
    let equityUsd = 0;
    const points: EquityPoint[] = [];
    for (const row of resolved) {
      equityUsd += Number(row.pnlUsd || 0);
      points.push({
        ts: Number(row.resolvedAt || row.createdTs),
        equityUsd
      });
    }
    return points;
  }

  flush(): void {
    // appendFileSync writes immediately; kept for explicit shutdown semantics.
  }

  private appendEvent(event: PaperLedgerEvent): void {
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  private assertWritable(): void {
    if (this.options.readOnly) {
      throw new Error("PaperLedger is read-only");
    }
  }
}

function parseEvent(line: string): PaperLedgerEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const type = String(obj.type || "");
    if (type === "startup") {
      const mode = String(obj.mode || "").trim();
      return {
        type: "startup",
        ts: Number(obj.ts || Date.now()),
        mode: mode || undefined
      };
    }
    const kind = String(obj.kind || "");
    if (kind === "trade_open") {
      const trade = obj.trade && typeof obj.trade === "object" ? (obj.trade as PaperTrade) : null;
      if (!trade || !trade.id) return null;
      return {
        kind: "trade_open",
        ts: Number(obj.ts || Date.now()),
        trade
      };
    }
    if (kind === "trade_resolved") {
      const tradeId = String(obj.tradeId || "");
      if (!tradeId) return null;
      const outcome = String(obj.outcome || "").toUpperCase();
      if (outcome !== "UP" && outcome !== "DOWN") return null;
      const marketId = String(obj.marketId || "");
      const windowEndTs = Number(obj.windowEndTs || 0);
      const finalOraclePrice = Number(obj.finalOraclePrice);
      const exitPayoutUsd = Number(obj.exitPayoutUsd);
      return {
        kind: "trade_resolved",
        ts: Number(obj.ts || Date.now()),
        tradeId,
        marketId,
        windowEndTs: Number.isFinite(windowEndTs) ? windowEndTs : 0,
        resolvedAt: Number(obj.resolvedAt || Date.now()),
        winner:
          String(obj.winner || "").toUpperCase() === "UP" || String(obj.winner || "").toUpperCase() === "DOWN"
            ? (String(obj.winner || "").toUpperCase() as PaperOutcome)
            : (outcome as PaperOutcome),
        finalOraclePrice: Number.isFinite(finalOraclePrice) ? finalOraclePrice : undefined,
        exitPayoutUsd: Number.isFinite(exitPayoutUsd) ? exitPayoutUsd : Number(obj.payoutUsd || 0),
        outcome: outcome as PaperOutcome,
        winningTokenId: typeof obj.winningTokenId === "string" ? obj.winningTokenId : undefined,
        winningOutcomeText: typeof obj.winningOutcomeText === "string" ? obj.winningOutcomeText : undefined,
        payoutUsd: Number(obj.payoutUsd || 0),
        pnlUsd: Number(obj.pnlUsd || 0),
        oracleAtEnd: Number.isFinite(Number(obj.oracleAtEnd)) ? Number(obj.oracleAtEnd) : undefined,
        resolutionSource:
          String(obj.resolutionSource || "") === "market_api"
            ? "market_api"
            : String(obj.resolutionSource || "") === "internal_fair_mid"
              ? "internal_fair_mid"
              : "oracle_proxy"
      };
    }
    if (kind === "trade_closed") {
      const tradeId = String(obj.tradeId || "");
      if (!tradeId) return null;
      const marketId = String(obj.marketId || "");
      const closeReasonRaw = String(obj.closeReason || "").toUpperCase();
      const closeReason =
        closeReasonRaw === "STOP_LOSS" ||
        closeReasonRaw === "TAKE_PROFIT" ||
        closeReasonRaw === "TIME_EXIT_PROFIT" ||
        closeReasonRaw === "MANUAL"
          ? closeReasonRaw
          : null;
      if (!closeReason) return null;
      return {
        kind: "trade_closed",
        ts: Number(obj.ts || Date.now()),
        tradeId,
        marketId,
        resolvedAt: Number(obj.resolvedAt || Date.now()),
        closeReason,
        exitPrice: Number(obj.exitPrice || 0),
        exitProceedsUsd: Number(obj.exitProceedsUsd || 0),
        exitFeesUsd: Number(obj.exitFeesUsd || 0),
        pnlUsd: Number(obj.pnlUsd || 0)
      };
    }
    return null;
  } catch {
    return null;
  }
}
