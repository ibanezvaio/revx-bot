/**
 * TRADING TRUTH logger.
 * Use LOG_VERBOSITY=quiet to suppress noisy cycle diagnostics while keeping one canonical TRUTH line.
 * TRUTH is the compact, human-readable source of truth for REVX + POLY trading/money state.
 */
import { BotConfig } from "../config";
import { Logger } from "../logger";

type RevxTruthState = {
  mode: "LIVE" | "DRY";
  symbol: string;
  buyOpen: number;
  sellOpen: number;
  lastOrderAction: "PLACED" | "CANCELLED" | "FILL" | "NONE";
  lastVenueOrderId: string | null;
  usdTotal: number | null;
  btcTotal: number | null;
  deltaUsd: number | null;
  deltaBtc: number | null;
  lastFillTs: number | null;
  lastFillSide: "BUY" | "SELL" | null;
  lastFillInferredSide: "BUY" | "SELL" | null;
  lastFillPrice: number | null;
  lastFillSize: number | null;
  blockedReason: string | null;
  blockedBtcNotional: number | null;
  blockedMaxBtcNotional: number | null;
};

type PolymarketTruthState = {
  mode: "PAPER" | "LIVE";
  liveConfirmed: boolean;
  killSwitch: boolean;
  enabled: boolean;
  polyEngineRunning: boolean;
  fetchOk: boolean;
  lastAction: "OPEN" | "CLOSE" | "RESOLVE" | "HOLD";
  holdReason: string | null;
  openTrades: number;
  resolvedTrades: number;
  pnlTotalUsd: number;
  lastTradeId: string | null;
  lastSlug: string | null;
  lastTradeTs: number | null;
  finalCandidatesCount: number | null;
  discoveredCandidatesCount: number | null;
  windowsCount: number | null;
  selectedSlug: string | null;
  selectedMarketId: string | null;
  windowEndTs: number | null;
  remainingSec: number | null;
  oracleSource: string | null;
  oracleState: string | null;
  latestPolymarketTs: number | null;
  latestModelTs: number | null;
  lastFetchAttemptTs: number;
  lastFetchOkTs: number;
  lastFetchErr: string | null;
  lastHttpStatus: number;
  lastUpdateTs: number;
};

export type TradingTruthSnapshot = {
  ts: number;
  revx: {
    mode: "LIVE" | "DRY";
    symbol: string;
    buyOpen: number;
    sellOpen: number;
    lastOrderAction: "PLACED" | "CANCELLED" | "FILL" | "NONE";
    lastVenueOrderId: string | null;
    balances: {
      usd: number | null;
      btc: number | null;
    };
    deltas: {
      usd: number | null;
      btc: number | null;
    };
    lastFill: {
      ts: number | null;
      side: "BUY" | "SELL" | null;
      inferredSide: "BUY" | "SELL" | null;
      price: number | null;
      size: number | null;
    } | null;
    blocked: {
      reason: string | null;
      btcNotional: number | null;
      maxBtcNotional: number | null;
    } | null;
  };
  poly: {
    status: "STARTING" | "RUNNING" | "STALE";
    lastUpdateTs: number;
    lastUpdateAgeSec: number | null;
    mode: "PAPER" | "LIVE";
    lastAction: "OPEN" | "CLOSE" | "RESOLVE" | "HOLD";
    holdReason: string | null;
    openTrades: number;
    resolvedTrades: number;
    pnlTotalUsd: number;
    lastTrade: {
      id: string | null;
      slug: string | null;
      ts: number | null;
    } | null;
    selection: {
      finalCandidatesCount: number | null;
      discoveredCandidatesCount: number | null;
      windowsCount: number | null;
      selectedSlug: string | null;
      selectedMarketId: string | null;
      windowEndTs: number | null;
      remainingSec: number | null;
    };
    dataHealth: {
      oracleSource: string | null;
      oracleState: string | null;
      latestPolymarketTs: number | null;
      latestModelTs: number | null;
      lastFetchAttemptTs: number;
      lastFetchOkTs: number;
      lastFetchErr: string | null;
      lastHttpStatus: number;
    };
    enabled: boolean;
    liveConfirmed: boolean;
    killSwitch: boolean;
    polyEngineRunning: boolean;
    fetchOk: boolean;
  };
  flags: {
    REVX_MONEY: boolean;
    POLY_MONEY: boolean;
  };
};

export type RevxTruthUpdate = Partial<RevxTruthState> & {
  ts?: number;
  force?: boolean;
};

export type PolymarketTruthUpdate = Partial<PolymarketTruthState> & {
  ts?: number;
  force?: boolean;
};

class TradingTruthReporter {
  private revx: RevxTruthState;
  private poly: PolymarketTruthState;
  private lastFingerprint = "";
  private lastEmitTs = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger
  ) {
    this.revx = {
      mode: config.dryRun ? "DRY" : "LIVE",
      symbol: config.symbol,
      buyOpen: 0,
      sellOpen: 0,
      lastOrderAction: "NONE",
      lastVenueOrderId: null,
      usdTotal: null,
      btcTotal: null,
      deltaUsd: null,
      deltaBtc: null,
      lastFillTs: null,
      lastFillSide: null,
      lastFillInferredSide: null,
      lastFillPrice: null,
      lastFillSize: null,
      blockedReason: null,
      blockedBtcNotional: null,
      blockedMaxBtcNotional: null
    };
    this.poly = {
      mode: config.polymarket.mode === "paper" ? "PAPER" : "LIVE",
      liveConfirmed: config.polymarket.liveConfirmed,
      killSwitch: config.polymarket.killSwitch,
      enabled: config.polymarket.enabled,
      polyEngineRunning: false,
      fetchOk: false,
      lastAction: "HOLD",
      holdReason: null,
      openTrades: 0,
      resolvedTrades: 0,
      pnlTotalUsd: 0,
      lastTradeId: null,
      lastSlug: null,
      lastTradeTs: null,
      finalCandidatesCount: null,
      discoveredCandidatesCount: null,
      windowsCount: null,
      selectedSlug: null,
      selectedMarketId: null,
      windowEndTs: null,
      remainingSec: null,
      oracleSource: null,
      oracleState: null,
      latestPolymarketTs: null,
      latestModelTs: null,
      lastFetchAttemptTs: 0,
      lastFetchOkTs: 0,
      lastFetchErr: null,
      lastHttpStatus: 0,
      lastUpdateTs: 0
    };
  }

  updateRevx(update: RevxTruthUpdate): void {
    this.revx = {
      ...this.revx,
      ...cleanObject(update)
    };
    this.emit(update.ts ?? Date.now(), update.force ?? false);
  }

  updatePolymarket(update: PolymarketTruthUpdate): void {
    this.poly = {
      ...this.poly,
      ...cleanObject(update)
    };
    this.emit(update.ts ?? Date.now(), update.force ?? false);
  }

  getSnapshot(ts = Date.now()): TradingTruthSnapshot {
    return this.buildSnapshot(ts);
  }

  private emit(ts: number, force: boolean): void {
    const snapshot = this.buildSnapshot(ts);
    const fingerprint = JSON.stringify({
      revx: snapshot.revx,
      poly: snapshot.poly,
      flags: snapshot.flags
    });
    const changed = fingerprint !== this.lastFingerprint;
    const intervalMs = Math.max(1_000, Number(this.config.truthIntervalMs || 10_000));
    const dueByInterval = ts - this.lastEmitTs >= intervalMs;
    if (!force && !changed && !dueByInterval) {
      return;
    }
    this.lastFingerprint = fingerprint;
    this.lastEmitTs = ts;
    this.logger.info(`TRUTH ${this.buildLine(snapshot)}`);
  }

  private buildSnapshot(ts: number): TradingTruthSnapshot {
    const flags = {
      REVX_MONEY: this.revx.mode === "LIVE",
      POLY_MONEY:
        this.poly.enabled &&
        this.poly.mode !== "PAPER" &&
        !this.poly.killSwitch &&
        this.poly.liveConfirmed
    };
    const lastFillExists =
      this.revx.lastFillTs !== null ||
      this.revx.lastFillSide !== null ||
      this.revx.lastFillPrice !== null ||
      this.revx.lastFillSize !== null;
    const lastTradeExists =
      this.poly.lastTradeId !== null || this.poly.lastSlug !== null || this.poly.lastTradeTs !== null;

    const polyLastUpdateTs = toMaybeNumber(this.poly.lastUpdateTs) ?? 0;
    const polyLastUpdateAgeSec =
      polyLastUpdateTs > 0 ? Math.max(0, Math.floor((ts - polyLastUpdateTs) / 1000)) : null;
    const polyStatus: "STARTING" | "RUNNING" | "STALE" =
      polyLastUpdateTs <= 0 ? "STARTING" : polyLastUpdateAgeSec !== null && polyLastUpdateAgeSec > 30 ? "STALE" : "RUNNING";
    return {
      ts,
      revx: {
        mode: this.revx.mode,
        symbol: this.revx.symbol,
        buyOpen: toNonNegativeInt(this.revx.buyOpen),
        sellOpen: toNonNegativeInt(this.revx.sellOpen),
        lastOrderAction: this.revx.lastOrderAction,
        lastVenueOrderId: this.revx.lastVenueOrderId,
        balances: {
          usd: toMaybeNumber(this.revx.usdTotal),
          btc: toMaybeNumber(this.revx.btcTotal)
        },
        deltas: {
          usd: toMaybeNumber(this.revx.deltaUsd),
          btc: toMaybeNumber(this.revx.deltaBtc)
        },
        lastFill: lastFillExists
          ? {
              ts: toMaybeNumber(this.revx.lastFillTs),
              side: this.revx.lastFillSide,
              inferredSide: this.revx.lastFillInferredSide,
              price: toMaybeNumber(this.revx.lastFillPrice),
              size: toMaybeNumber(this.revx.lastFillSize)
            }
          : null,
        blocked:
          this.revx.blockedReason ||
          this.revx.blockedBtcNotional !== null ||
          this.revx.blockedMaxBtcNotional !== null
            ? {
                reason: this.revx.blockedReason,
                btcNotional: toMaybeNumber(this.revx.blockedBtcNotional),
                maxBtcNotional: toMaybeNumber(this.revx.blockedMaxBtcNotional)
              }
            : null
      },
      poly: {
        status: polyStatus,
        lastUpdateTs: polyLastUpdateTs,
        lastUpdateAgeSec: polyLastUpdateAgeSec,
        mode: this.poly.mode,
        lastAction: this.poly.lastAction,
        holdReason: this.poly.holdReason,
        openTrades: toNonNegativeInt(this.poly.openTrades),
        resolvedTrades: toNonNegativeInt(this.poly.resolvedTrades),
        pnlTotalUsd: toMaybeNumber(this.poly.pnlTotalUsd) ?? 0,
        lastTrade: lastTradeExists
          ? {
              id: this.poly.lastTradeId,
              slug: this.poly.lastSlug,
              ts: toMaybeNumber(this.poly.lastTradeTs)
            }
          : null,
        selection: {
          finalCandidatesCount: toMaybeNumber(this.poly.finalCandidatesCount),
          discoveredCandidatesCount: toMaybeNumber(this.poly.discoveredCandidatesCount),
          windowsCount: toMaybeNumber(this.poly.windowsCount),
          selectedSlug: this.poly.selectedSlug,
          selectedMarketId: this.poly.selectedMarketId,
          windowEndTs: toMaybeNumber(this.poly.windowEndTs),
          remainingSec: toMaybeNumber(this.poly.remainingSec)
        },
        dataHealth: {
          oracleSource: this.poly.oracleSource,
          oracleState: this.poly.oracleState,
          latestPolymarketTs: toMaybeNumber(this.poly.latestPolymarketTs),
          latestModelTs: toMaybeNumber(this.poly.latestModelTs),
          lastFetchAttemptTs: toMaybeNumber(this.poly.lastFetchAttemptTs) ?? 0,
          lastFetchOkTs: toMaybeNumber(this.poly.lastFetchOkTs) ?? 0,
          lastFetchErr: this.poly.lastFetchErr,
          lastHttpStatus: toMaybeNumber(this.poly.lastHttpStatus) ?? 0
        },
        enabled: this.poly.enabled,
        liveConfirmed: this.poly.liveConfirmed,
        killSwitch: this.poly.killSwitch,
        polyEngineRunning: this.poly.polyEngineRunning,
        fetchOk: this.poly.fetchOk
      },
      flags
    };
  }

  private buildLine(snapshot: TradingTruthSnapshot): string {
    const lastFill = snapshot.revx.lastFill;
    const lastFillText = lastFill
      ? `${safeText(lastFill.side)}@${moneyText(lastFill.price)}x${btcText(lastFill.size)}@${isoSeconds(
          Number(lastFill.ts || snapshot.ts)
        )}`
      : "-";
    const blocked = snapshot.revx.blocked;
    const blockedText =
      blocked && blocked.reason
        ? `${blocked.reason}(btcNotional=${moneyText(blocked.btcNotional)},max=${moneyText(blocked.maxBtcNotional)})`
        : "-";
    const selected = safeText(snapshot.poly.selection.selectedSlug || snapshot.poly.selection.selectedMarketId);
    const rem = safeText(snapshot.poly.selection.remainingSec);
    return [
      `ts=${isoSeconds(snapshot.ts)}`,
      `REVX(${snapshot.revx.mode} ${safeText(snapshot.revx.symbol)} buyOpen=${intText(
        snapshot.revx.buyOpen
      )},sellOpen=${intText(snapshot.revx.sellOpen)},lastOrderAction=${snapshot.revx.lastOrderAction},lastVenueOrderId=${safeText(
        snapshot.revx.lastVenueOrderId
      )},usd=${moneyText(snapshot.revx.balances.usd)},btc=${btcText(snapshot.revx.balances.btc)},deltaUsd=${moneyText(
        snapshot.revx.deltas.usd
      )},deltaBtc=${btcText(snapshot.revx.deltas.btc)},lastFill=${lastFillText},blocked=${blockedText})`,
      `POLY(status=${snapshot.poly.status} ageSec=${safeText(snapshot.poly.lastUpdateAgeSec)} ${snapshot.poly.mode} running=${String(snapshot.poly.polyEngineRunning)} fetchOk=${String(
        snapshot.poly.fetchOk
      )} candidates=${safeText(snapshot.poly.selection.discoveredCandidatesCount)} windows=${safeText(
        snapshot.poly.selection.windowsCount
      )} selected=${selected} rem=${rem} action=${snapshot.poly.lastAction} hold=${safeText(
        snapshot.poly.holdReason
      )},openTrades=${intText(snapshot.poly.openTrades)},resolvedTrades=${intText(
        snapshot.poly.resolvedTrades
      )},pnlTotalUsd=${moneyText(snapshot.poly.pnlTotalUsd)})`,
      `FLAGS(REVX_MONEY=${String(snapshot.flags.REVX_MONEY)} POLY_MONEY=${String(snapshot.flags.POLY_MONEY)})`
    ].join(" ");
  }
}

const REPORTERS_BY_CONFIG = new WeakMap<BotConfig, TradingTruthReporter>();

export function getTradingTruthReporter(config: BotConfig, logger: Logger): TradingTruthReporter {
  const existing = REPORTERS_BY_CONFIG.get(config);
  if (existing) return existing;
  const created = new TradingTruthReporter(config, logger);
  REPORTERS_BY_CONFIG.set(config, created);
  return created;
}

export function getTradingTruthSnapshot(config: BotConfig, logger: Logger): TradingTruthSnapshot {
  return getTradingTruthReporter(config, logger).getSnapshot();
}

export function isQuietVerbosity(config: Pick<BotConfig, "logVerbosity">): boolean {
  return config.logVerbosity === "quiet";
}

export function isDebugVerbosity(config: Pick<BotConfig, "logVerbosity">): boolean {
  return config.logVerbosity === "debug";
}

function cleanObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || key === "force" || key === "ts") continue;
    (out as Record<string, unknown>)[key] = raw;
  }
  return out;
}

function toNonNegativeInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function toMaybeNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoSeconds(ts: number): string {
  const value = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function intText(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return String(Math.max(0, Math.floor(n)));
}

function moneyText(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(2);
}

function btcText(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(8);
}

function safeText(value: unknown): string {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : "-";
}
