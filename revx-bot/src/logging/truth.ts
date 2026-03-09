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
  liveExecutionEnabled: boolean;
  killSwitch: boolean;
  enabled: boolean;
  polyEngineRunning: boolean;
  fetchOk: boolean;
  warningState: string | null;
  pollMode: string | null;
  staleState: string | null;
  lastAction: "OPEN" | "CLOSE" | "RESOLVE" | "HOLD";
  holdReason: string | null;
  blockedBy: string | null;
  currentWindowHoldReason: string | null;
  holdCategory: string | null;
  strategyAction: string | null;
  selectedTokenId: string | null;
  selectedBookable: boolean | null;
  selectedTradable: boolean | null;
  discoveredCurrent: boolean | null;
  discoveredNext: boolean | null;
  selectionSource: string | null;
  selectedFrom: string | null;
  selectionCommitTs: number | null;
  liveValidationReason: string | null;
  lastBookTs: number | null;
  lastQuoteTs: number | null;
  currentBucketSlug: string | null;
  nextBucketSlug: string | null;
  currentBucketStartSec: number | null;
  selectedWindowStartSec: number | null;
  selectedWindowEndSec: number | null;
  candidateRefreshed: boolean | null;
  lastPreorderValidationReason: string | null;
  openTrades: number;
  awaitingResolutionTrades: number;
  resolutionErrorTrades: number;
  resolutionQueueCount: number;
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
  windowStartTs: number | null;
  windowEndTs: number | null;
  remainingSec: number | null;
  chosenSide: "YES" | "NO" | null;
  chosenDirection: string | null;
  entriesInWindow: number | null;
  windowRealizedPnlUsd: number | null;
  resolutionSource: string | null;
  oracleSource: string | null;
  oracleState: string | null;
  latestPolymarketTs: number | null;
  latestModelTs: number | null;
  lastFetchAttemptTs: number;
  lastFetchOkTs: number;
  lastFetchErr: string | null;
  lastHttpStatus: number;
  lastUpdateTs: number;
  threshold: number | null;
  discoveredAtTs: number | null;
  marketExpiresAtTs: number | null;
  lastDiscoverySuccessTs: number | null;
  lastDecisionTs: number | null;
  lastSelectedMarketTs: number | null;
  currentBtcMid: number | null;
  statusLine: string | null;
  whyNotTrading: string | null;
  currentMarketStatus: string | null;
  currentMarketSlug: string | null;
  currentMarketRemainingSec: number | null;
  currentMarketExpiresAt: number | null;
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
    warningState: string | null;
    pollMode: string | null;
    staleState: string | null;
    lastAction: "OPEN" | "CLOSE" | "RESOLVE" | "HOLD";
    holdReason: string | null;
    blockedBy: string | null;
    currentWindowHoldReason: string | null;
    holdCategory: string | null;
    strategyAction: string | null;
    selectedTokenId: string | null;
    selectedBookable: boolean | null;
    selectedTradable: boolean | null;
    discoveredCurrent: boolean | null;
    discoveredNext: boolean | null;
    selectionSource: string | null;
    selectedFrom: string | null;
    selectionCommitTs: number | null;
    liveValidationReason: string | null;
    lastBookTs: number | null;
    lastQuoteTs: number | null;
    currentBucketSlug: string | null;
    nextBucketSlug: string | null;
    currentBucketStartSec: number | null;
    selectedWindowStartSec: number | null;
    selectedWindowEndSec: number | null;
    candidateRefreshed: boolean | null;
    lastPreorderValidationReason: string | null;
    openTrades: number;
    awaitingResolutionTrades: number;
    resolutionErrorTrades: number;
    resolutionQueueCount: number;
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
      windowStartTs: number | null;
      windowEndTs: number | null;
      remainingSec: number | null;
      chosenSide: "YES" | "NO" | null;
      chosenDirection: string | null;
      entriesInWindow: number | null;
      windowRealizedPnlUsd: number | null;
      resolutionSource: string | null;
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
    liveExecutionEnabled: boolean;
    killSwitch: boolean;
    polyEngineRunning: boolean;
    fetchOk: boolean;
    threshold: number | null;
    discoveredAtTs: number | null;
    marketExpiresAtTs: number | null;
    currentMarketStatus: string | null;
    currentMarketSlug: string | null;
    currentMarketRemainingSec: number | null;
    currentMarketExpiresAt: number | null;
    lastDiscoverySuccessTs: number | null;
    lastDecisionTs: number | null;
    lastSelectedMarketTs: number | null;
    currentBtcMid: number | null;
    statusLine: string | null;
    whyNotTrading: string | null;
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
      liveExecutionEnabled: config.polymarket.liveExecutionEnabled,
      killSwitch: config.polymarket.killSwitch,
      enabled: config.polymarket.enabled,
      polyEngineRunning: false,
      fetchOk: false,
      warningState: null,
      pollMode: null,
      staleState: null,
      lastAction: "HOLD",
      holdReason: null,
      blockedBy: null,
      currentWindowHoldReason: null,
      holdCategory: null,
      strategyAction: null,
      selectedTokenId: null,
      selectedBookable: null,
      selectedTradable: null,
      discoveredCurrent: null,
      discoveredNext: null,
      selectionSource: null,
      selectedFrom: null,
      selectionCommitTs: null,
      liveValidationReason: null,
      lastBookTs: null,
      lastQuoteTs: null,
      currentBucketSlug: null,
      nextBucketSlug: null,
      currentBucketStartSec: null,
      selectedWindowStartSec: null,
      selectedWindowEndSec: null,
      candidateRefreshed: null,
      lastPreorderValidationReason: null,
      openTrades: 0,
      awaitingResolutionTrades: 0,
      resolutionErrorTrades: 0,
      resolutionQueueCount: 0,
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
      windowStartTs: null,
      windowEndTs: null,
      remainingSec: null,
      chosenSide: null,
      chosenDirection: null,
      entriesInWindow: null,
      windowRealizedPnlUsd: null,
      resolutionSource: null,
      oracleSource: null,
      oracleState: null,
      latestPolymarketTs: null,
      latestModelTs: null,
      lastFetchAttemptTs: 0,
      lastFetchOkTs: 0,
      lastFetchErr: null,
      lastHttpStatus: 0,
      lastUpdateTs: 0,
      threshold: null,
      discoveredAtTs: null,
      marketExpiresAtTs: null,
      lastDiscoverySuccessTs: null,
      lastDecisionTs: null,
      lastSelectedMarketTs: null,
      currentBtcMid: null,
      statusLine: null,
      whyNotTrading: null,
      currentMarketStatus: null,
      currentMarketSlug: null,
      currentMarketRemainingSec: null,
      currentMarketExpiresAt: null
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
    const fingerprint = this.buildEmitFingerprint(snapshot);
    const changed = fingerprint !== this.lastFingerprint;
    if (!force && !changed) {
      return;
    }
    this.lastFingerprint = fingerprint;
    this.lastEmitTs = ts;
    this.logger.info(`TRUTH ${this.buildLine(snapshot)}`);
  }

  private buildEmitFingerprint(snapshot: TradingTruthSnapshot): string {
    return JSON.stringify({
      revx: {
        buyOpen: snapshot.revx.buyOpen,
        sellOpen: snapshot.revx.sellOpen,
        lastOrderAction: snapshot.revx.lastOrderAction,
        lastVenueOrderId: snapshot.revx.lastVenueOrderId,
        lastFillTs: snapshot.revx.lastFill?.ts ?? null,
        lastFillSide: snapshot.revx.lastFill?.side ?? null,
        blockedReason: snapshot.revx.blocked?.reason ?? null
      },
      poly: {
        status: snapshot.poly.status,
        warningState: snapshot.poly.warningState,
        pollMode: snapshot.poly.pollMode,
        staleState: snapshot.poly.staleState,
        running: snapshot.poly.polyEngineRunning,
        fetchOk: snapshot.poly.fetchOk,
        candidates: snapshot.poly.selection.discoveredCandidatesCount,
        windows: snapshot.poly.selection.windowsCount,
        selectedSlug: snapshot.poly.selection.selectedSlug,
        selectedMarketId: snapshot.poly.selection.selectedMarketId,
        remainingBucket: remainingSecBucket(snapshot.poly.selection.remainingSec),
        chosenSide: snapshot.poly.selection.chosenSide,
        chosenDirection: snapshot.poly.selection.chosenDirection,
        action: snapshot.poly.lastAction,
        holdReason: snapshot.poly.currentWindowHoldReason ?? snapshot.poly.holdReason,
        blockedBy: snapshot.poly.blockedBy,
        holdCategory: snapshot.poly.holdCategory,
        selectedTokenId: snapshot.poly.selectedTokenId,
        openTrades: snapshot.poly.openTrades
      },
      flags: snapshot.flags
    });
  }

  private buildSnapshot(ts: number): TradingTruthSnapshot {
    const flags = {
      REVX_MONEY: this.revx.mode === "LIVE",
      POLY_MONEY:
        this.poly.enabled &&
        this.poly.mode !== "PAPER" &&
        !this.poly.killSwitch &&
        this.poly.liveConfirmed &&
        this.poly.liveExecutionEnabled
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
    const polyHasActiveSelection =
      (this.poly.selectedSlug !== null || this.poly.selectedMarketId !== null) &&
      (toMaybeNumber(this.poly.remainingSec) !== null
        ? Number(this.poly.remainingSec) > 0
        : (toMaybeNumber(this.poly.windowEndTs) ?? 0) > ts);
    const polyHasRuntimeState =
      this.poly.polyEngineRunning ||
      this.poly.warningState !== null ||
      this.poly.finalCandidatesCount !== null ||
      this.poly.discoveredCandidatesCount !== null ||
      this.poly.windowsCount !== null ||
      this.poly.selectedSlug !== null ||
      this.poly.selectedMarketId !== null ||
      this.poly.remainingSec !== null ||
      this.poly.chosenDirection !== null ||
      this.poly.holdReason === "STARTUP_INCOMPLETE_NO_USABLE_WINDOW" ||
      this.poly.currentWindowHoldReason === "STARTUP_INCOMPLETE_NO_USABLE_WINDOW" ||
      this.poly.holdReason === "NO_ACTIVE_BTC5M_MARKET" ||
      this.poly.currentWindowHoldReason === "NO_ACTIVE_BTC5M_MARKET";
    const staleVisibility =
      this.poly.staleState ??
      (polyLastUpdateTs > 0 && polyLastUpdateAgeSec !== null && polyLastUpdateAgeSec > 30
        ? polyHasActiveSelection
          ? "DISCOVERY_STALE"
          : "DISCOVERY_STALE"
        : null);
    const polyStatus: "STARTING" | "RUNNING" | "STALE" =
      polyLastUpdateTs <= 0
        ? polyHasRuntimeState
          ? "RUNNING"
          : "STARTING"
        : polyLastUpdateAgeSec !== null && polyLastUpdateAgeSec > 30 && !polyHasActiveSelection
          ? "STALE"
          : "RUNNING";
    const effectiveWarningState =
      this.poly.warningState && staleVisibility
        ? this.poly.warningState.includes("DISCOVERY_STALE")
          ? this.poly.warningState
          : `${this.poly.warningState}+DISCOVERY_STALE`
        : this.poly.warningState ?? (staleVisibility ? "DISCOVERY_STALE" : null);
    const effectiveLastSelectedMarketTs =
      toMaybeNumber(this.poly.lastSelectedMarketTs) ??
      (polyHasActiveSelection ? toMaybeNumber(this.poly.lastUpdateTs) ?? ts : null);
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
        warningState: effectiveWarningState,
        pollMode: this.poly.pollMode,
        staleState: staleVisibility,
        lastAction: this.poly.lastAction,
        holdReason: this.poly.holdReason,
        blockedBy: this.poly.blockedBy,
        currentWindowHoldReason: this.poly.currentWindowHoldReason,
        holdCategory: this.poly.holdCategory,
        strategyAction: this.poly.strategyAction,
        selectedTokenId: this.poly.selectedTokenId,
        selectedBookable: this.poly.selectedBookable,
        selectedTradable: this.poly.selectedTradable,
        discoveredCurrent: this.poly.discoveredCurrent,
        discoveredNext: this.poly.discoveredNext,
        selectionSource: this.poly.selectionSource,
        selectedFrom: this.poly.selectedFrom,
        selectionCommitTs: toMaybeNumber(this.poly.selectionCommitTs),
        liveValidationReason: this.poly.liveValidationReason,
        lastBookTs: toMaybeNumber(this.poly.lastBookTs),
        lastQuoteTs: toMaybeNumber(this.poly.lastQuoteTs),
        currentBucketSlug: this.poly.currentBucketSlug,
        nextBucketSlug: this.poly.nextBucketSlug,
        currentBucketStartSec: toMaybeNumber(this.poly.currentBucketStartSec),
        selectedWindowStartSec: toMaybeNumber(this.poly.selectedWindowStartSec),
        selectedWindowEndSec: toMaybeNumber(this.poly.selectedWindowEndSec),
        candidateRefreshed: this.poly.candidateRefreshed,
        lastPreorderValidationReason: this.poly.lastPreorderValidationReason,
        openTrades: toNonNegativeInt(this.poly.openTrades),
        awaitingResolutionTrades: toNonNegativeInt(this.poly.awaitingResolutionTrades),
        resolutionErrorTrades: toNonNegativeInt(this.poly.resolutionErrorTrades),
        resolutionQueueCount: toNonNegativeInt(this.poly.resolutionQueueCount),
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
          windowStartTs: toMaybeNumber(this.poly.windowStartTs),
          windowEndTs: toMaybeNumber(this.poly.windowEndTs),
          remainingSec: toMaybeNumber(this.poly.remainingSec),
          chosenSide: this.poly.chosenSide,
          chosenDirection: this.poly.chosenDirection,
          entriesInWindow: toMaybeNumber(this.poly.entriesInWindow),
          windowRealizedPnlUsd: toMaybeNumber(this.poly.windowRealizedPnlUsd),
          resolutionSource: this.poly.resolutionSource
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
        liveExecutionEnabled: this.poly.liveExecutionEnabled,
        killSwitch: this.poly.killSwitch,
        polyEngineRunning: this.poly.polyEngineRunning,
        fetchOk: this.poly.fetchOk,
        threshold: toMaybeNumber(this.poly.threshold),
        discoveredAtTs: toMaybeNumber(this.poly.discoveredAtTs),
        marketExpiresAtTs: toMaybeNumber(this.poly.marketExpiresAtTs),
        currentMarketStatus: this.poly.currentMarketStatus ?? polyStatus,
        currentMarketSlug:
          this.poly.currentMarketSlug ??
          this.poly.selectedSlug ??
          this.poly.selectedMarketId,
        currentMarketRemainingSec:
          toMaybeNumber(this.poly.currentMarketRemainingSec) ??
          toMaybeNumber(this.poly.remainingSec),
        currentMarketExpiresAt:
          toMaybeNumber(this.poly.currentMarketExpiresAt) ??
          toMaybeNumber(this.poly.marketExpiresAtTs) ??
          toMaybeNumber(this.poly.windowEndTs),
        lastDiscoverySuccessTs: toMaybeNumber(this.poly.lastDiscoverySuccessTs),
        lastDecisionTs: toMaybeNumber(this.poly.lastDecisionTs),
        lastSelectedMarketTs: effectiveLastSelectedMarketTs,
        currentBtcMid: toMaybeNumber(this.poly.currentBtcMid),
        statusLine: this.poly.statusLine,
        whyNotTrading: this.poly.whyNotTrading ?? this.poly.currentWindowHoldReason ?? this.poly.holdReason
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
    const side = safeText(snapshot.poly.selection.chosenSide);
    const direction = safeText(snapshot.poly.selection.chosenDirection);
    const entriesInWindow = safeText(snapshot.poly.selection.entriesInWindow);
    const windowPnl = moneyText(snapshot.poly.selection.windowRealizedPnlUsd);
    const resolutionSource = safeText(snapshot.poly.selection.resolutionSource);
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
      )} warning=${safeText(snapshot.poly.warningState)} poll=${safeText(snapshot.poly.pollMode)} stale=${safeText(snapshot.poly.staleState)} holdCategory=${safeText(
        snapshot.poly.holdCategory
      )} tokenId=${safeText(snapshot.poly.selectedTokenId)} candidates=${safeText(snapshot.poly.selection.discoveredCandidatesCount)} windows=${safeText(
        snapshot.poly.selection.windowsCount
      )} selected=${selected} rem=${rem} side=${side} direction=${direction} entriesInWindow=${entriesInWindow} realizedPnlWindowUsd=${windowPnl} resolutionSource=${resolutionSource} action=${snapshot.poly.lastAction} hold=${safeText(
        snapshot.poly.currentWindowHoldReason ?? snapshot.poly.holdReason
      )} blockedBy=${safeText(
        snapshot.poly.blockedBy
      )},openTrades=${intText(snapshot.poly.openTrades)},awaitingResolution=${intText(
        snapshot.poly.awaitingResolutionTrades
      )},resolutionQueue=${intText(snapshot.poly.resolutionQueueCount)},resolvedTrades=${intText(
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
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function remainingSecBucket(value: unknown): number | null {
  const seconds = toMaybeNumber(value);
  if (seconds === null) return null;
  return Math.max(0, Math.floor(seconds / 15));
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
