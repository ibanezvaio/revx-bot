import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PaperOutcome, PaperResult, PaperSide, classifyPaperResult, derivePaperShareCount } from "./PaperMath";

export type PaperTradeStatus =
  | "OPEN"
  | "AWAITING_RESOLUTION"
  | "RESOLVED_WIN"
  | "RESOLVED_LOSS"
  | "VOID"
  | "EXITED_EARLY"
  | "RESOLUTION_ERROR";

export type PaperTradeResolutionSource = "OFFICIAL" | "DERIVED_FALLBACK" | "PAPER_EXIT";

export type PaperTradeResolutionContextState =
  | "TRADING_OPEN"
  | "CLOSED_AWAITING_OUTCOME"
  | "RESOLVED"
  | "CANCELLED"
  | "FETCH_FAILED";

export type PaperTrade = {
  id: string;
  marketId: string;
  marketSlug?: string;
  marketQuestion?: string;
  referenceSymbol?: string;
  windowStartTs: number;
  windowEndTs: number;
  expectedCloseTs?: number;
  side: PaperSide;
  entryPrice: number;
  qty: number;
  notionalUsd: number;
  feeBps: number;
  slippageBps: number;
  feesUsd: number;
  entryCostUsd: number;
  priceToBeat: number;
  referencePriceAtEntry?: number;
  yesTokenId?: string;
  noTokenId?: string;
  yesDisplayLabel?: string;
  noDisplayLabel?: string;
  heldTokenId?: string;
  createdTs: number;
  entryTs?: number;
  status?: PaperTradeStatus;
  statusUpdatedAt?: number;
  statusReason?: string;
  statusDetail?: string;
  awaitingResolutionSinceTs?: number;
  lastResolutionAttemptTs?: number;
  resolutionAttempts?: number;
  resolutionError?: string;
  resolutionErrorAt?: number;
  resolutionContextState?: PaperTradeResolutionContextState;
  resolvedAt?: number;
  outcome?: PaperOutcome;
  payoutUsd?: number;
  pnlUsd?: number;
  winningTokenId?: string;
  winningOutcomeText?: string;
  oracleAtEnd?: number;
  resolutionSource?: PaperTradeResolutionSource;
  closeReason?: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "TRAILING_RETRACE" | "MANUAL";
  exitPrice?: number;
  exitProceedsUsd?: number;
  exitFeesUsd?: number;
};

type TradeOpenEvent = {
  kind: "trade_open";
  ts: number;
  trade: PaperTrade;
};

type TradeStatusEvent = {
  kind: "trade_status";
  ts: number;
  tradeId: string;
  status: "OPEN" | "AWAITING_RESOLUTION" | "RESOLUTION_ERROR";
  statusUpdatedAt: number;
  statusReason?: string;
  statusDetail?: string;
  awaitingResolutionSinceTs?: number;
  lastResolutionAttemptTs?: number;
  resolutionAttempts?: number;
  resolutionError?: string;
  resolutionErrorAt?: number;
  resolutionContextState?: PaperTradeResolutionContextState;
};

type TradeResolvedEvent = {
  kind: "trade_resolved";
  ts: number;
  tradeId: string;
  marketId: string;
  windowEndTs: number;
  resolvedAt: number;
  status: "RESOLVED_WIN" | "RESOLVED_LOSS";
  winner: PaperOutcome;
  finalOraclePrice?: number;
  exitPrice?: number;
  exitProceedsUsd?: number;
  exitPayoutUsd: number;
  outcome: PaperOutcome;
  winningTokenId?: string;
  winningOutcomeText?: string;
  payoutUsd: number;
  pnlUsd: number;
  oracleAtEnd?: number;
  resolutionSource: "OFFICIAL" | "DERIVED_FALLBACK";
  statusReason?: string;
  statusDetail?: string;
};

type TradeCancelledEvent = {
  kind: "trade_cancelled";
  ts: number;
  tradeId: string;
  marketId: string;
  resolvedAt: number;
  status: "VOID" | "EXITED_EARLY";
  cancelReason: string;
  statusDetail?: string;
  exitPrice?: number;
  exitProceedsUsd?: number;
  exitFeesUsd?: number;
  payoutUsd?: number;
  pnlUsd: number;
  resolutionSource: "OFFICIAL" | "PAPER_EXIT";
  closeReason?: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "TRAILING_RETRACE" | "MANUAL";
};

type LegacyTradeClosedEvent = {
  kind: "trade_closed";
  ts: number;
  tradeId: string;
  marketId: string;
  resolvedAt: number;
  status?: "EXITED_EARLY";
  closeReason: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "TRAILING_RETRACE" | "MANUAL";
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

type PaperLedgerEvent =
  | TradeOpenEvent
  | TradeStatusEvent
  | TradeResolvedEvent
  | TradeCancelledEvent
  | LegacyTradeClosedEvent
  | StartupEvent;

export type PaperSummary = {
  totalTrades: number;
  resolvedTrades: number;
  openPositions: number;
  awaitingResolutionTrades: number;
  resolutionErrorTrades: number;
  voidTrades: number;
  exitedEarlyTrades: number;
  cancelledTrades: number;
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

const OPEN_STATUSES = new Set<PaperTradeStatus>(["OPEN"]);
const RESOLUTION_QUEUE_STATUSES = new Set<PaperTradeStatus>(["AWAITING_RESOLUTION", "RESOLUTION_ERROR"]);
const ACTIVE_STATUSES = new Set<PaperTradeStatus>(["OPEN", "AWAITING_RESOLUTION", "RESOLUTION_ERROR"]);
const RESOLVED_STATUSES = new Set<PaperTradeStatus>(["RESOLVED_WIN", "RESOLVED_LOSS"]);
const TERMINAL_STATUSES = new Set<PaperTradeStatus>(["RESOLVED_WIN", "RESOLVED_LOSS", "VOID", "EXITED_EARLY"]);

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
        const trade = { ...event.trade };
        normalizePaperTradeInPlace(trade);
        this.trades.set(event.trade.id, trade);
      } else if ("kind" in event && event.kind === "trade_status") {
        const trade = this.trades.get(event.tradeId);
        if (!trade) continue;
        applyStatusUpdate(trade, {
          status: event.status,
          statusUpdatedAt: event.statusUpdatedAt,
          statusReason: event.statusReason,
          statusDetail: event.statusDetail,
          awaitingResolutionSinceTs: event.awaitingResolutionSinceTs,
          lastResolutionAttemptTs: event.lastResolutionAttemptTs,
          resolutionAttempts: event.resolutionAttempts,
          resolutionError: event.resolutionError,
          resolutionErrorAt: event.resolutionErrorAt,
          resolutionContextState: event.resolutionContextState
        });
        normalizePaperTradeInPlace(trade);
      } else if ("kind" in event && event.kind === "trade_resolved") {
        const trade = this.trades.get(event.tradeId);
        if (!trade) continue;
        trade.resolvedAt = event.resolvedAt;
        trade.status = event.status;
        trade.statusUpdatedAt = event.resolvedAt;
        trade.statusReason = event.statusReason || "OFFICIAL_OUTCOME";
        trade.statusDetail = event.statusDetail;
        trade.outcome = event.outcome;
        trade.payoutUsd = event.payoutUsd;
        trade.pnlUsd = event.pnlUsd;
        trade.winningTokenId = event.winningTokenId;
        trade.winningOutcomeText = event.winningOutcomeText;
        trade.oracleAtEnd = event.oracleAtEnd;
        trade.resolutionSource = event.resolutionSource;
        trade.resolutionContextState = "RESOLVED";
        trade.resolutionError = undefined;
        trade.resolutionErrorAt = undefined;
        trade.exitPrice = event.exitPrice;
        trade.exitProceedsUsd = event.exitProceedsUsd;
        normalizePaperTradeInPlace(trade, {
          fallbackPayoutUsd: event.payoutUsd,
          fallbackPnlUsd: event.pnlUsd
        });
      } else if ("kind" in event && (event.kind === "trade_cancelled" || event.kind === "trade_closed")) {
        const trade = this.trades.get(event.tradeId);
        if (!trade) continue;
        trade.resolvedAt = event.resolvedAt;
        trade.status = event.kind === "trade_cancelled" ? event.status : event.status || "EXITED_EARLY";
        trade.statusUpdatedAt = event.resolvedAt;
        trade.statusReason = event.kind === "trade_cancelled" ? event.cancelReason : event.closeReason;
        trade.statusDetail = event.kind === "trade_cancelled" ? event.statusDetail : undefined;
        trade.pnlUsd = event.pnlUsd;
        trade.resolutionSource = event.kind === "trade_cancelled" ? event.resolutionSource : "PAPER_EXIT";
        trade.closeReason = event.kind === "trade_cancelled" ? event.closeReason : event.closeReason;
        trade.resolutionContextState = event.kind === "trade_cancelled" ? "CANCELLED" : undefined;
        trade.exitPrice = event.exitPrice;
        trade.exitProceedsUsd = event.exitProceedsUsd;
        trade.exitFeesUsd = event.exitFeesUsd;
        if (event.kind === "trade_cancelled") {
          trade.payoutUsd = event.payoutUsd;
        }
        normalizePaperTradeInPlace(trade);
      }
    }
    for (const trade of this.trades.values()) {
      normalizePaperTradeInPlace(trade);
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
    marketQuestion?: string;
    referenceSymbol?: string;
    windowStartTs: number;
    windowEndTs: number;
    expectedCloseTs?: number;
    side: PaperSide;
    entryPrice: number;
    qty: number;
    notionalUsd: number;
    feeBps: number;
    slippageBps: number;
    feesUsd: number;
    entryCostUsd: number;
    priceToBeat: number;
    referencePriceAtEntry?: number;
    yesTokenId?: string;
    noTokenId?: string;
    yesDisplayLabel?: string;
    noDisplayLabel?: string;
    heldTokenId?: string;
    createdTs?: number;
    entryTs?: number;
  }): PaperTrade {
    this.assertWritable();
    const createdTs = input.createdTs ?? Date.now();
    const trade: PaperTrade = {
      id: randomUUID(),
      marketId: input.marketId,
      marketSlug: input.marketSlug,
      marketQuestion: input.marketQuestion,
      referenceSymbol: input.referenceSymbol,
      windowStartTs: input.windowStartTs,
      windowEndTs: input.windowEndTs,
      expectedCloseTs: input.expectedCloseTs ?? input.windowEndTs,
      side: input.side,
      entryPrice: input.entryPrice,
      qty: input.qty,
      notionalUsd: input.notionalUsd,
      feeBps: input.feeBps,
      slippageBps: input.slippageBps,
      feesUsd: input.feesUsd,
      entryCostUsd: input.entryCostUsd,
      priceToBeat: input.priceToBeat,
      referencePriceAtEntry: input.referencePriceAtEntry,
      yesTokenId: input.yesTokenId,
      noTokenId: input.noTokenId,
      yesDisplayLabel: input.yesDisplayLabel,
      noDisplayLabel: input.noDisplayLabel,
      heldTokenId: input.heldTokenId,
      createdTs,
      entryTs: input.entryTs ?? createdTs,
      status: "OPEN",
      statusUpdatedAt: createdTs,
      statusReason: "ENTRY_FILLED",
      statusDetail: "Trade opened in paper mode"
    };
    normalizePaperTradeInPlace(trade);
    this.trades.set(trade.id, trade);
    this.appendEvent({
      kind: "trade_open",
      ts: Date.now(),
      trade
    });
    return { ...trade };
  }

  updateTradeStatus(input: {
    tradeId: string;
    status: "OPEN" | "AWAITING_RESOLUTION" | "RESOLUTION_ERROR";
    statusUpdatedAt: number;
    statusReason?: string;
    statusDetail?: string;
    awaitingResolutionSinceTs?: number | null;
    lastResolutionAttemptTs?: number | null;
    resolutionAttempts?: number;
    resolutionError?: string | null;
    resolutionErrorAt?: number | null;
    resolutionContextState?: PaperTradeResolutionContextState;
  }): PaperTrade | null {
    this.assertWritable();
    const trade = this.trades.get(input.tradeId);
    if (!trade) return null;
    if (TERMINAL_STATUSES.has(getPaperTradeStatus(trade))) {
      return { ...trade };
    }

    applyStatusUpdate(trade, {
      status: input.status,
      statusUpdatedAt: input.statusUpdatedAt,
      statusReason: input.statusReason,
      statusDetail: input.statusDetail,
      awaitingResolutionSinceTs:
        input.awaitingResolutionSinceTs === null ? undefined : input.awaitingResolutionSinceTs,
      lastResolutionAttemptTs:
        input.lastResolutionAttemptTs === null ? undefined : input.lastResolutionAttemptTs,
      resolutionAttempts: input.resolutionAttempts,
      resolutionError: input.resolutionError === null ? undefined : input.resolutionError,
      resolutionErrorAt: input.resolutionErrorAt === null ? undefined : input.resolutionErrorAt,
      resolutionContextState: input.resolutionContextState
    });
    normalizePaperTradeInPlace(trade);

    this.appendEvent({
      kind: "trade_status",
      ts: Date.now(),
      tradeId: trade.id,
      status: input.status,
      statusUpdatedAt: input.statusUpdatedAt,
      statusReason: input.statusReason,
      statusDetail: input.statusDetail,
      awaitingResolutionSinceTs:
        input.awaitingResolutionSinceTs === null ? undefined : input.awaitingResolutionSinceTs,
      lastResolutionAttemptTs:
        input.lastResolutionAttemptTs === null ? undefined : input.lastResolutionAttemptTs,
      resolutionAttempts: input.resolutionAttempts,
      resolutionError: input.resolutionError === null ? undefined : input.resolutionError,
      resolutionErrorAt: input.resolutionErrorAt === null ? undefined : input.resolutionErrorAt,
      resolutionContextState: input.resolutionContextState
    });

    return { ...trade };
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
    resolutionSource: "OFFICIAL" | "DERIVED_FALLBACK";
    statusReason?: string;
    statusDetail?: string;
  }): PaperTrade | null {
    this.assertWritable();
    const trade = this.trades.get(input.tradeId);
    if (!trade) return null;
    if (TERMINAL_STATUSES.has(getPaperTradeStatus(trade))) return { ...trade };

    const status = deriveResolvedStatus(trade, input.winningTokenId, input.outcome, input.payoutUsd);
    trade.resolvedAt = input.resolvedAt;
    trade.status = status;
    trade.statusUpdatedAt = input.resolvedAt;
    trade.statusReason = input.statusReason || "OFFICIAL_OUTCOME";
    trade.statusDetail = input.statusDetail;
    trade.outcome = input.outcome;
    trade.winningTokenId = input.winningTokenId;
    trade.winningOutcomeText = input.winningOutcomeText;
    trade.oracleAtEnd = input.oracleAtEnd;
    trade.resolutionSource = input.resolutionSource;
    trade.resolutionContextState = "RESOLVED";
    trade.closeReason = undefined;
    trade.resolutionError = undefined;
    trade.resolutionErrorAt = undefined;
    normalizePaperTradeInPlace(trade, {
      fallbackPayoutUsd: input.payoutUsd,
      fallbackPnlUsd: input.pnlUsd
    });

    this.appendEvent({
      kind: "trade_resolved",
      ts: Date.now(),
      tradeId: input.tradeId,
      marketId: trade.marketId,
      windowEndTs: trade.windowEndTs,
      resolvedAt: input.resolvedAt,
      status,
      winner: input.outcome,
      finalOraclePrice: input.oracleAtEnd,
      exitPrice: trade.exitPrice,
      exitProceedsUsd: trade.exitProceedsUsd,
      exitPayoutUsd: Number(trade.exitProceedsUsd || trade.payoutUsd || 0),
      outcome: input.outcome,
      winningTokenId: input.winningTokenId,
      winningOutcomeText: input.winningOutcomeText,
      payoutUsd: Number(trade.payoutUsd || 0),
      pnlUsd: Number(trade.pnlUsd || 0),
      oracleAtEnd: input.oracleAtEnd,
      resolutionSource: input.resolutionSource,
      statusReason: trade.statusReason,
      statusDetail: trade.statusDetail
    });

    return { ...trade };
  }

  cancelTrade(input: {
    tradeId: string;
    resolvedAt: number;
    cancelReason: string;
    status?: "VOID" | "EXITED_EARLY";
    statusDetail?: string;
    payoutUsd?: number;
    pnlUsd?: number;
    exitPrice?: number;
    exitProceedsUsd?: number;
    exitFeesUsd?: number;
    resolutionSource: "OFFICIAL" | "PAPER_EXIT";
    closeReason?: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "TRAILING_RETRACE" | "MANUAL";
  }): PaperTrade | null {
    this.assertWritable();
    const trade = this.trades.get(input.tradeId);
    if (!trade) return null;
    if (TERMINAL_STATUSES.has(getPaperTradeStatus(trade))) return { ...trade };

    const status =
      input.status ||
      (input.closeReason || input.resolutionSource === "PAPER_EXIT" ? "EXITED_EARLY" : "VOID");
    trade.resolvedAt = input.resolvedAt;
    trade.status = status;
    trade.statusUpdatedAt = input.resolvedAt;
    trade.statusReason = input.cancelReason;
    trade.statusDetail = input.statusDetail;
    trade.resolutionSource = input.resolutionSource;
    trade.resolutionContextState = "CANCELLED";
    trade.closeReason = input.closeReason;
    trade.exitPrice = input.exitPrice;
    trade.exitProceedsUsd = input.exitProceedsUsd;
    trade.exitFeesUsd = input.exitFeesUsd;
    trade.payoutUsd = input.payoutUsd;
    trade.pnlUsd = input.pnlUsd;
    trade.resolutionError = undefined;
    trade.resolutionErrorAt = undefined;
    normalizePaperTradeInPlace(trade);

    this.appendEvent({
      kind: "trade_cancelled",
      ts: Date.now(),
      tradeId: trade.id,
      marketId: trade.marketId,
      resolvedAt: input.resolvedAt,
      status,
      cancelReason: input.cancelReason,
      statusDetail: input.statusDetail,
      exitPrice: trade.exitPrice,
      exitProceedsUsd: trade.exitProceedsUsd,
      exitFeesUsd: trade.exitFeesUsd,
      payoutUsd: trade.payoutUsd,
      pnlUsd: Number(trade.pnlUsd || 0),
      resolutionSource: input.resolutionSource,
      closeReason: input.closeReason
    });

    return { ...trade };
  }

  closeTrade(input: {
    tradeId: string;
    resolvedAt: number;
    closeReason: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "TRAILING_RETRACE" | "MANUAL";
    exitPrice: number;
    exitProceedsUsd: number;
    exitFeesUsd: number;
    pnlUsd: number;
  }): PaperTrade | null {
    return this.cancelTrade({
      tradeId: input.tradeId,
      resolvedAt: input.resolvedAt,
      cancelReason: `PAPER_EXIT_${input.closeReason}`,
      status: "EXITED_EARLY",
      statusDetail: `Paper position exited early via ${input.closeReason}`,
      exitPrice: input.exitPrice,
      exitProceedsUsd: input.exitProceedsUsd,
      exitFeesUsd: input.exitFeesUsd,
      payoutUsd: input.exitProceedsUsd,
      pnlUsd: input.pnlUsd,
      resolutionSource: "PAPER_EXIT",
      closeReason: input.closeReason
    });
  }

  getTrade(tradeId: string): PaperTrade | null {
    const trade = this.trades.get(tradeId);
    return trade ? { ...trade } : null;
  }

  getOpenTrades(): PaperTrade[] {
    return this.getAllTrades()
      .filter((row) => OPEN_STATUSES.has(getPaperTradeStatus(row)))
      .sort((a, b) => a.createdTs - b.createdTs);
  }

  getResolutionQueueTrades(): PaperTrade[] {
    return this.getAllTrades()
      .filter((row) => RESOLUTION_QUEUE_STATUSES.has(getPaperTradeStatus(row)))
      .sort((a, b) => a.createdTs - b.createdTs);
  }

  getActiveTrades(): PaperTrade[] {
    return this.getAllTrades()
      .filter((row) => ACTIVE_STATUSES.has(getPaperTradeStatus(row)))
      .sort((a, b) => a.createdTs - b.createdTs);
  }

  getResolvedTrades(): PaperTrade[] {
    return this.getAllTrades()
      .filter((row) => RESOLVED_STATUSES.has(getPaperTradeStatus(row)))
      .sort((a, b) => (a.resolvedAt || 0) - (b.resolvedAt || 0));
  }

  getAllTrades(): PaperTrade[] {
    return Array.from(this.trades.values()).map((row) => ({ ...row }));
  }

  getRecentTrades(limit = 200): PaperTrade[] {
    return this.getAllTrades()
      .sort((a, b) => Math.max(b.statusUpdatedAt || 0, b.createdTs) - Math.max(a.statusUpdatedAt || 0, a.createdTs))
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
    const open = all.filter((row) => OPEN_STATUSES.has(getPaperTradeStatus(row)));
    const awaitingResolutionTrades = all.filter((row) => getPaperTradeStatus(row) === "AWAITING_RESOLUTION").length;
    const resolutionErrorTrades = all.filter((row) => getPaperTradeStatus(row) === "RESOLUTION_ERROR").length;
    const voidTrades = all.filter((row) => getPaperTradeStatus(row) === "VOID").length;
    const exitedEarlyTrades = all.filter((row) => getPaperTradeStatus(row) === "EXITED_EARLY").length;
    const cancelledTrades = voidTrades + exitedEarlyTrades;
    const officialResolved = all.filter((row) => RESOLVED_STATUSES.has(getPaperTradeStatus(row)));

    const totalPnlUsd = officialResolved.reduce((sum, row) => sum + Number(row.pnlUsd || 0), 0);
    const dayStart = new Date(nowTs).toISOString().slice(0, 10);
    const todayPnlUsd = officialResolved
      .filter((row) => row.resolvedAt && new Date(row.resolvedAt).toISOString().startsWith(dayStart))
      .reduce((sum, row) => sum + Number(row.pnlUsd || 0), 0);
    const pnl24hUsd = officialResolved
      .filter((row) => Number(row.resolvedAt || 0) >= nowTs - 24 * 60 * 60 * 1000)
      .reduce((sum, row) => sum + Number(row.pnlUsd || 0), 0);
    const wins = officialResolved.filter((row) => getPaperTradeResult(row) === "WIN").length;
    const losses = officialResolved.filter((row) => getPaperTradeResult(row) === "LOSS").length;
    const flats = officialResolved.filter((row) => getPaperTradeResult(row) === "FLAT").length;
    const decisiveTrades = wins + losses + flats;
    const winRate = decisiveTrades > 0 ? wins / decisiveTrades : 0;
    const lastResolved = officialResolved
      .slice()
      .sort((a, b) => Number(b.resolvedAt || 0) - Number(a.resolvedAt || 0))[0];

    return {
      totalTrades: all.length,
      resolvedTrades: officialResolved.length,
      openPositions: open.length,
      awaitingResolutionTrades,
      resolutionErrorTrades,
      voidTrades,
      exitedEarlyTrades,
      cancelledTrades,
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
    const realized = this.getAllTrades()
      .filter((row) => {
        const status = getPaperTradeStatus(row);
        return status === "RESOLVED_WIN" || status === "RESOLVED_LOSS";
      })
      .sort(
        (a, b) =>
          Number(a.statusUpdatedAt || a.resolvedAt || a.createdTs) -
          Number(b.statusUpdatedAt || b.resolvedAt || b.createdTs)
      );
    let equityUsd = 0;
    const points: EquityPoint[] = [];
    for (const row of realized) {
      equityUsd += Number(row.pnlUsd || 0);
      points.push({
        ts: Number(row.statusUpdatedAt || row.resolvedAt || row.createdTs),
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

export function getPaperTradeStatus(trade: PaperTrade): PaperTradeStatus {
  const normalized = normalizeStatusValue(trade.status);
  if (normalized) return normalized;
  if (!trade.resolvedAt) return "OPEN";
  if (trade.closeReason) return "EXITED_EARLY";
  const payoutUsd = Number(trade.exitProceedsUsd ?? trade.payoutUsd);
  if (Number.isFinite(payoutUsd)) {
    const settlementPrice = deriveBinarySettlementPricePerShare(trade);
    if (settlementPrice === 1) return "RESOLVED_WIN";
    if (settlementPrice === 0) return "RESOLVED_LOSS";
  }
  return Number(trade.pnlUsd || 0) >= 0 ? "RESOLVED_WIN" : "RESOLVED_LOSS";
}

export function getPaperTradeExitPricePerShare(trade: PaperTrade): number | null {
  const exitPrice = Number(trade.exitPrice);
  return Number.isFinite(exitPrice) ? exitPrice : null;
}

export function getPaperTradeExitValueUsd(trade: PaperTrade): number | null {
  const exitValue = Number(trade.exitProceedsUsd ?? trade.payoutUsd);
  return Number.isFinite(exitValue) ? exitValue : null;
}

export function getPaperTradePnlUsd(trade: PaperTrade): number {
  const pnlUsd = Number(trade.pnlUsd);
  return Number.isFinite(pnlUsd) ? pnlUsd : 0;
}

export function getPaperTradeResult(trade: PaperTrade): PaperResult | null {
  const status = getPaperTradeStatus(trade);
  if (!TERMINAL_STATUSES.has(status)) return null;
  return classifyPaperResult(getPaperTradePnlUsd(trade));
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
    if (kind === "trade_status") {
      const tradeId = String(obj.tradeId || "");
      const status = normalizeNonTerminalStatus(obj.status);
      if (!tradeId || !status) return null;
      return {
        kind: "trade_status",
        ts: Number(obj.ts || Date.now()),
        tradeId,
        status,
        statusUpdatedAt: Number(obj.statusUpdatedAt || obj.ts || Date.now()),
        statusReason: asOptionalString(obj.statusReason),
        statusDetail: asOptionalString(obj.statusDetail),
        awaitingResolutionSinceTs: asOptionalNumber(obj.awaitingResolutionSinceTs),
        lastResolutionAttemptTs: asOptionalNumber(obj.lastResolutionAttemptTs),
        resolutionAttempts: asOptionalNumber(obj.resolutionAttempts),
        resolutionError: asOptionalString(obj.resolutionError),
        resolutionErrorAt: asOptionalNumber(obj.resolutionErrorAt),
        resolutionContextState: normalizeResolutionContextState(obj.resolutionContextState)
      };
    }
    if (kind === "trade_resolved") {
      const tradeId = String(obj.tradeId || "");
      const status = normalizeResolvedStatus(obj.status);
      if (!tradeId || !status) return null;
      const outcome = String(obj.outcome || "").toUpperCase();
      if (outcome !== "UP" && outcome !== "DOWN") return null;
      const marketId = String(obj.marketId || "");
      const windowEndTs = Number(obj.windowEndTs || 0);
      const finalOraclePrice = Number(obj.finalOraclePrice);
      const exitPrice = Number(obj.exitPrice);
      const exitProceedsUsd = Number(obj.exitProceedsUsd);
      const exitPayoutUsd = Number(obj.exitPayoutUsd);
      return {
        kind: "trade_resolved",
        ts: Number(obj.ts || Date.now()),
        tradeId,
        marketId,
        windowEndTs: Number.isFinite(windowEndTs) ? windowEndTs : 0,
        resolvedAt: Number(obj.resolvedAt || Date.now()),
        status,
        winner:
          String(obj.winner || "").toUpperCase() === "UP" || String(obj.winner || "").toUpperCase() === "DOWN"
            ? (String(obj.winner || "").toUpperCase() as PaperOutcome)
            : (outcome as PaperOutcome),
        finalOraclePrice: Number.isFinite(finalOraclePrice) ? finalOraclePrice : undefined,
        exitPrice: Number.isFinite(exitPrice) ? exitPrice : undefined,
        exitProceedsUsd: Number.isFinite(exitProceedsUsd)
          ? exitProceedsUsd
          : Number.isFinite(exitPayoutUsd)
            ? exitPayoutUsd
            : Number(obj.payoutUsd || 0),
        exitPayoutUsd: Number.isFinite(exitPayoutUsd) ? exitPayoutUsd : Number(obj.payoutUsd || 0),
        outcome: outcome as PaperOutcome,
        winningTokenId: typeof obj.winningTokenId === "string" ? obj.winningTokenId : undefined,
        winningOutcomeText: typeof obj.winningOutcomeText === "string" ? obj.winningOutcomeText : undefined,
        payoutUsd: Number(obj.payoutUsd || 0),
        pnlUsd: Number(obj.pnlUsd || 0),
        oracleAtEnd: Number.isFinite(Number(obj.oracleAtEnd)) ? Number(obj.oracleAtEnd) : undefined,
        resolutionSource:
          normalizePaperResolutionSource(obj.resolutionSource, "OFFICIAL") === "DERIVED_FALLBACK"
            ? "DERIVED_FALLBACK"
            : "OFFICIAL",
        statusReason: asOptionalString(obj.statusReason),
        statusDetail: asOptionalString(obj.statusDetail)
      };
    }
    if (kind === "trade_cancelled") {
      const tradeId = String(obj.tradeId || "");
      if (!tradeId) return null;
      const normalizedStatus =
        normalizeVoidOrExitedStatus(obj.status, normalizeCloseReason(obj.closeReason)) ||
        (normalizeCloseReason(obj.closeReason) ? "EXITED_EARLY" : "VOID");
      return {
        kind: "trade_cancelled",
        ts: Number(obj.ts || Date.now()),
        tradeId,
        marketId: String(obj.marketId || ""),
        resolvedAt: Number(obj.resolvedAt || Date.now()),
        status: normalizedStatus,
        cancelReason: String(obj.cancelReason || "CANCELLED"),
        statusDetail: asOptionalString(obj.statusDetail),
        exitPrice: asOptionalNumber(obj.exitPrice),
        exitProceedsUsd: asOptionalNumber(obj.exitProceedsUsd),
        exitFeesUsd: asOptionalNumber(obj.exitFeesUsd),
        payoutUsd: asOptionalNumber(obj.payoutUsd),
        pnlUsd: Number(obj.pnlUsd || 0),
        resolutionSource: normalizePaperResolutionSource(obj.resolutionSource, "OFFICIAL") === "PAPER_EXIT" ? "PAPER_EXIT" : "OFFICIAL",
        closeReason: normalizeCloseReason(obj.closeReason) || undefined
      };
    }
    if (kind === "trade_closed") {
      const tradeId = String(obj.tradeId || "");
      const closeReason = normalizeCloseReason(obj.closeReason);
      if (!tradeId || !closeReason) return null;
      return {
        kind: "trade_closed",
        ts: Number(obj.ts || Date.now()),
        tradeId,
        marketId: String(obj.marketId || ""),
        resolvedAt: Number(obj.resolvedAt || Date.now()),
        status: "EXITED_EARLY",
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

function normalizePaperTradeInPlace(
  trade: PaperTrade,
  fallback: {
    fallbackPayoutUsd?: number;
    fallbackPnlUsd?: number;
  } = {}
): void {
  trade.createdTs = finiteOrFallback(trade.createdTs, Date.now());
  trade.entryTs = finiteOrFallback(trade.entryTs, trade.createdTs);
  trade.expectedCloseTs = finiteOrFallback(trade.expectedCloseTs, trade.windowEndTs);
  trade.statusUpdatedAt = finiteOrFallback(trade.statusUpdatedAt, trade.resolvedAt || trade.createdTs);
  trade.resolutionAttempts = Math.max(0, Math.floor(Number(trade.resolutionAttempts || 0)));
  trade.status = getPaperTradeStatus(trade);

  if (trade.status === "RESOLVED_WIN" || trade.status === "RESOLVED_LOSS") {
    const settlementPrice = deriveBinarySettlementPricePerShare(trade, fallback.fallbackPayoutUsd);
    const shareCount = derivePaperShareCount({
      qty: trade.qty,
      entryPrice: trade.entryPrice,
      entryCostUsd: trade.entryCostUsd,
      notionalUsd: trade.notionalUsd
    });
    const entryNotionalUsd = Math.max(0, Number(trade.entryCostUsd || trade.notionalUsd || 0));
    const entryFeesUsd = Math.max(0, Number(trade.feesUsd || 0));
    const settlementValueUsd =
      settlementPrice !== null
        ? shareCount * settlementPrice
        : Math.max(0, Number(trade.exitProceedsUsd ?? trade.payoutUsd ?? fallback.fallbackPayoutUsd ?? 0));
    const fallbackPnlUsd = Number(fallback.fallbackPnlUsd);

    trade.exitPrice = settlementPrice ?? undefined;
    trade.exitProceedsUsd = settlementValueUsd;
    trade.payoutUsd = settlementValueUsd;
    trade.pnlUsd = Number.isFinite(settlementValueUsd - entryNotionalUsd - entryFeesUsd)
      ? settlementValueUsd - entryNotionalUsd - entryFeesUsd
      : Number.isFinite(fallbackPnlUsd)
        ? fallbackPnlUsd
        : 0;
    trade.resolutionContextState = trade.resolutionContextState || "RESOLVED";
    trade.resolutionError = undefined;
    trade.resolutionErrorAt = undefined;
    return;
  }

  if (trade.status === "VOID" || trade.status === "EXITED_EARLY") {
    const entryNotionalUsd = Math.max(0, Number(trade.entryCostUsd || trade.notionalUsd || 0));
    const entryFeesUsd = Math.max(0, Number(trade.feesUsd || 0));
    const exitFeesUsd = Math.max(0, Number(trade.exitFeesUsd || 0));
    const exitValueUsd = Number(trade.exitProceedsUsd ?? trade.payoutUsd);
    if (!Number.isFinite(exitValueUsd) && trade.status === "VOID") {
      trade.exitProceedsUsd = entryNotionalUsd;
      trade.payoutUsd = entryNotionalUsd;
      trade.pnlUsd = 0;
    } else if (Number.isFinite(exitValueUsd) && !Number.isFinite(Number(trade.pnlUsd))) {
      trade.pnlUsd = exitValueUsd - entryNotionalUsd - entryFeesUsd - exitFeesUsd;
    } else if (!Number.isFinite(Number(trade.pnlUsd))) {
      trade.pnlUsd = 0;
    }
    trade.resolutionContextState = trade.resolutionContextState || "CANCELLED";
    trade.resolutionError = undefined;
    trade.resolutionErrorAt = undefined;
    return;
  }

  if (trade.status === "OPEN") {
    trade.awaitingResolutionSinceTs = undefined;
    trade.resolutionError = undefined;
    trade.resolutionErrorAt = undefined;
    trade.resolutionContextState = trade.resolutionContextState || "TRADING_OPEN";
  } else if (trade.status === "AWAITING_RESOLUTION") {
    trade.awaitingResolutionSinceTs = finiteOrFallback(
      trade.awaitingResolutionSinceTs,
      trade.expectedCloseTs || trade.windowEndTs
    );
    trade.resolutionContextState = trade.resolutionContextState || "CLOSED_AWAITING_OUTCOME";
  } else if (trade.status === "RESOLUTION_ERROR") {
    trade.resolutionContextState = trade.resolutionContextState || "FETCH_FAILED";
  }
}

function applyStatusUpdate(
  trade: PaperTrade,
  input: {
    status: "OPEN" | "AWAITING_RESOLUTION" | "RESOLUTION_ERROR";
    statusUpdatedAt: number;
    statusReason?: string;
    statusDetail?: string;
    awaitingResolutionSinceTs?: number;
    lastResolutionAttemptTs?: number;
    resolutionAttempts?: number;
    resolutionError?: string;
    resolutionErrorAt?: number;
    resolutionContextState?: PaperTradeResolutionContextState;
  }
): void {
  trade.status = input.status;
  trade.statusUpdatedAt = input.statusUpdatedAt;
  trade.statusReason = input.statusReason;
  trade.statusDetail = input.statusDetail;
  trade.awaitingResolutionSinceTs = input.awaitingResolutionSinceTs;
  trade.lastResolutionAttemptTs = input.lastResolutionAttemptTs;
  trade.resolutionAttempts = input.resolutionAttempts;
  trade.resolutionError = input.resolutionError;
  trade.resolutionErrorAt = input.resolutionErrorAt;
  trade.resolutionContextState = input.resolutionContextState;
}

function deriveResolvedStatus(
  trade: PaperTrade,
  winningTokenId: string | undefined,
  outcome: PaperOutcome,
  fallbackPayoutUsd: number
): "RESOLVED_WIN" | "RESOLVED_LOSS" {
  const heldTokenId = String(trade.heldTokenId || "").trim();
  const yesTokenId = String(trade.yesTokenId || "").trim();
  const noTokenId = String(trade.noTokenId || "").trim();
  const normalizedWinner = String(winningTokenId || "").trim();
  if (normalizedWinner && heldTokenId) {
    return normalizedWinner === heldTokenId ? "RESOLVED_WIN" : "RESOLVED_LOSS";
  }
  if (normalizedWinner && trade.side === "YES" && yesTokenId) {
    return normalizedWinner === yesTokenId ? "RESOLVED_WIN" : "RESOLVED_LOSS";
  }
  if (normalizedWinner && trade.side === "NO" && noTokenId) {
    return normalizedWinner === noTokenId ? "RESOLVED_WIN" : "RESOLVED_LOSS";
  }
  if ((trade.side === "YES" && outcome === "UP") || (trade.side === "NO" && outcome === "DOWN")) {
    return "RESOLVED_WIN";
  }
  if ((trade.side === "YES" && outcome === "DOWN") || (trade.side === "NO" && outcome === "UP")) {
    return "RESOLVED_LOSS";
  }
  return Number(fallbackPayoutUsd || 0) > Math.max(0, Number(trade.notionalUsd || trade.entryCostUsd || 0))
    ? "RESOLVED_WIN"
    : "RESOLVED_LOSS";
}

function deriveBinarySettlementPricePerShare(
  trade: Pick<
    PaperTrade,
    | "side"
    | "heldTokenId"
    | "yesTokenId"
    | "noTokenId"
    | "winningTokenId"
    | "qty"
    | "entryPrice"
    | "notionalUsd"
    | "entryCostUsd"
    | "exitPrice"
    | "payoutUsd"
    | "exitProceedsUsd"
  >,
  fallbackPayoutUsd?: number
): number | null {
  const yesTokenId = String(trade.yesTokenId || "").trim();
  const noTokenId = String(trade.noTokenId || "").trim();
  const winningTokenId = String(trade.winningTokenId || "").trim();
  const fallbackHeldTokenId = trade.side === "YES" ? yesTokenId : noTokenId;
  const heldTokenId = String(trade.heldTokenId || fallbackHeldTokenId).trim();

  if (yesTokenId && noTokenId && yesTokenId !== noTokenId && winningTokenId) {
    return heldTokenId === winningTokenId ? 1 : 0;
  }

  const exitPrice = Number(trade.exitPrice);
  if (Number.isFinite(exitPrice)) {
    return Math.min(1, Math.max(0, exitPrice));
  }

  const shareCount = derivePaperShareCount({
    qty: trade.qty,
    entryPrice: trade.entryPrice,
    entryCostUsd: trade.entryCostUsd,
    notionalUsd: trade.notionalUsd
  });
  const payoutUsd = Number(trade.exitProceedsUsd ?? trade.payoutUsd ?? fallbackPayoutUsd);
  if (!(shareCount > 0) || !Number.isFinite(payoutUsd)) {
    return null;
  }
  return Math.min(1, Math.max(0, payoutUsd / shareCount));
}

function normalizeStatusValue(value: unknown): PaperTradeStatus | null {
  const text = String(value || "").trim().toUpperCase();
  if (
    text === "OPEN" ||
    text === "AWAITING_RESOLUTION" ||
    text === "RESOLVED_WIN" ||
    text === "RESOLVED_LOSS" ||
    text === "VOID" ||
    text === "EXITED_EARLY" ||
    text === "RESOLUTION_ERROR"
  ) {
    return text;
  }
  if (text === "RESOLVED") return "RESOLVED_WIN";
  if (text === "CANCELLED") return "VOID";
  if (text === "CLOSED") return "EXITED_EARLY";
  return null;
}

function normalizeVoidOrExitedStatus(
  value: unknown,
  closeReason?: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "TRAILING_RETRACE" | "MANUAL" | null
): "VOID" | "EXITED_EARLY" | null {
  if (closeReason) return "EXITED_EARLY";
  const status = normalizeStatusValue(value);
  if (status === "VOID" || status === "EXITED_EARLY") return status;
  return null;
}

function normalizePaperResolutionSource(
  value: unknown,
  fallback: PaperTradeResolutionSource
): PaperTradeResolutionSource {
  const text = String(value || "").trim().toUpperCase();
  if (text === "OFFICIAL" || text === "DERIVED_FALLBACK" || text === "PAPER_EXIT") {
    return text as PaperTradeResolutionSource;
  }
  if (text === "MARKET_API" || text === "ORACLE_PROXY" || text === "INTERNAL_FAIR_MID") {
    return text === "MARKET_API" ? "OFFICIAL" : "DERIVED_FALLBACK";
  }
  if (text === "PAPER_EXIT") return "PAPER_EXIT";
  return fallback;
}

function normalizeResolvedStatus(value: unknown): "RESOLVED_WIN" | "RESOLVED_LOSS" | null {
  const status = normalizeStatusValue(value);
  if (status === "RESOLVED_WIN" || status === "RESOLVED_LOSS") return status;
  return null;
}

function normalizeNonTerminalStatus(value: unknown): "OPEN" | "AWAITING_RESOLUTION" | "RESOLUTION_ERROR" | null {
  const status = normalizeStatusValue(value);
  if (status === "OPEN" || status === "AWAITING_RESOLUTION" || status === "RESOLUTION_ERROR") return status;
  return null;
}

function normalizeResolutionContextState(value: unknown): PaperTradeResolutionContextState | undefined {
  const text = String(value || "").trim().toUpperCase();
  if (
    text === "TRADING_OPEN" ||
    text === "CLOSED_AWAITING_OUTCOME" ||
    text === "RESOLVED" ||
    text === "CANCELLED" ||
    text === "FETCH_FAILED"
  ) {
    return text as PaperTradeResolutionContextState;
  }
  return undefined;
}

function normalizeCloseReason(value: unknown): "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "TRAILING_RETRACE" | "MANUAL" | null {
  const text = String(value || "").trim().toUpperCase();
  if (
    text === "STOP_LOSS" ||
    text === "TAKE_PROFIT" ||
    text === "TIME_EXIT_PROFIT" ||
    text === "TRAILING_RETRACE" ||
    text === "MANUAL"
  ) {
    return text;
  }
  return null;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteOrFallback(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
