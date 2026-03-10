import { BotConfig } from "../../config";
import { Logger } from "../../logger";
import { Store } from "../../store/Store";
import { sleep } from "../../util/time";
import { deriveBtc5mTickContext, slugForTs } from "../btc5m";
import { PolymarketClient } from "../PolymarketClient";
import { PolymarketExecution } from "../Execution";
import { PolymarketRisk } from "../Risk";
import { Sizing } from "../Sizing";
import { Btc5mExecutionGate } from "./Btc5mExecutionGate";
import { Btc5mSelector } from "./Btc5mSelector";
import { Btc5mDecision, Btc5mSelectedMarket, Btc5mTick } from "./Btc5mTypes";

type RunnerDeps = {
  store?: Store;
};

type RuntimeState = {
  running: boolean;
  fetchOk: boolean;
  warningState: string | null;
  selectedSlug: string | null;
  selectedTokenId: string | null;
  currentBucketSlug: string | null;
  nextBucketSlug: string | null;
  currentBucketStartSec: number | null;
  remainingSec: number | null;
  chosenSide: "YES" | "NO" | null;
  chosenDirection: "UP" | "DOWN" | null;
  action: "BUY_YES" | "BUY_NO" | "HOLD";
  holdReason: string | null;
  blockedBy: string | null;
  tickNowSec: number | null;
  lastFetchAttemptTs: number;
  lastFetchOkTs: number;
  lastFetchErr: string | null;
  lastDecisionTs: number;
  lastUpdateTs: number;
};

export class Btc5mLiveRunner {
  private readonly client: PolymarketClient;
  private readonly execution: PolymarketExecution;
  private readonly risk: PolymarketRisk;
  private readonly sizing: Sizing;
  private readonly selector: Btc5mSelector;
  private readonly gate: Btc5mExecutionGate;
  private readonly store?: Store;

  private running = false;
  private stopRequested = false;
  private loopTask: Promise<void> | null = null;
  private firstTickResolve: (() => void) | null = null;
  private firstTickPromise: Promise<void> | null = null;
  private readonly recentTicks: Array<Record<string, unknown>> = [];
  private state: RuntimeState = {
    running: false,
    fetchOk: false,
    warningState: null,
    selectedSlug: null,
    selectedTokenId: null,
    currentBucketSlug: null,
    nextBucketSlug: null,
    currentBucketStartSec: null,
    remainingSec: null,
    chosenSide: null,
    chosenDirection: null,
    action: "HOLD",
    holdReason: "STARTING",
    blockedBy: "STARTING",
    tickNowSec: null,
    lastFetchAttemptTs: 0,
    lastFetchOkTs: 0,
    lastFetchErr: "STARTING",
    lastDecisionTs: 0,
    lastUpdateTs: 0
  };

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    deps: RunnerDeps = {}
  ) {
    this.store = deps.store;
    this.client = new PolymarketClient(config, logger);
    this.execution = new PolymarketExecution(config, logger, this.client);
    this.risk = new PolymarketRisk(config, logger);
    this.sizing = new Sizing(config);
    this.selector = new Btc5mSelector(config, logger, this.client);
    this.gate = new Btc5mExecutionGate(config);
  }

  async start(): Promise<void> {
    if (this.running) {
      return this.loopTask ?? Promise.resolve();
    }
    this.running = true;
    this.stopRequested = false;
    this.state.running = true;
    this.state.holdReason = "STARTING";
    this.state.blockedBy = "STARTING";
    this.state.lastFetchErr = "STARTING";
    this.firstTickPromise = new Promise<void>((resolve) => {
      this.firstTickResolve = resolve;
    });

    if (this.config.polymarket.execution.cancelAllOnStart && this.canMutateVenueState()) {
      await this.execution.cancelAll("POLY_V2_STARTUP");
    }

    this.loopTask = this.runLoop();

    try {
      await Promise.race([
        this.firstTickPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("No POLY_V2_TICK emitted within 5 seconds")), 5_000);
        })
      ]);
    } catch (error) {
      const reason = shortError(error);
      this.logger.error({ reason }, "POLY_V2_STARTUP_FAILED");
      this.stopRequested = true;
      try {
        await this.loopTask;
      } catch {
        // swallow loop failure on startup timeout path
      }
      this.running = false;
      this.state.running = false;
      throw error;
    }

    await this.loopTask;
  }

  async runSmoke(cycles = 2): Promise<void> {
    const totalCycles = Math.max(1, Math.floor(cycles));
    for (let idx = 0; idx < totalCycles; idx += 1) {
      await this.processCycle(false);
      if (idx + 1 < totalCycles) {
        await sleep(500);
      }
    }
    this.logger.warn(
      {
        cycles: totalCycles,
        selectedSlug: this.state.selectedSlug,
        selectedTokenId: this.state.selectedTokenId,
        action: this.state.action,
        blocker: this.state.blockedBy
      },
      "POLY_V2_SMOKE_SUMMARY"
    );
  }

  async stop(reason = "STOPPED"): Promise<void> {
    this.stopRequested = true;
    if (this.loopTask) {
      await this.loopTask.catch(() => undefined);
    }
    if (this.canMutateVenueState()) {
      await this.execution.cancelAll(`POLY_V2_${reason}`);
    }
    this.running = false;
    this.state.running = false;
    this.state.holdReason = reason;
    this.state.blockedBy = reason;
    this.state.lastUpdateTs = Date.now();
  }

  getLagSnapshot(limit = 50): any {
    return {
      stats: {
        samples: this.recentTicks.length,
        lastFastMidTsMs: null,
        lastOracleTsMs: null,
        lastBookTsMs: null,
        lastYesMid: null,
        metrics: {}
      },
      recent: this.recentTicks.slice(Math.max(0, this.recentTicks.length - Math.max(1, Math.floor(limit))))
    };
  }

  getDashboardSnapshot(): any {
    const nowTs = Date.now();
    const lastUpdateAgeSec =
      this.state.lastUpdateTs > 0 ? Math.max(0, Math.floor((nowTs - this.state.lastUpdateTs) / 1000)) : null;
    return {
      latestPolymarket: null,
      latestModel: null,
      latestLag: this.getLagSnapshot(1).stats,
      sniperWindow: {
        minRemainingSec: this.config.polymarket.live.minEntryRemainingSec,
        maxRemainingSec: this.config.polymarket.paper.entryMaxRemainingSec
      },
      tradingPaused: false,
      pauseReason: null,
      warningState: this.state.warningState,
      pollMode: "V2",
      staleState: null,
      statusLine: null,
      discoveredAtTs: null,
      marketExpiresAtTs: null,
      lastDiscoverySuccessTs: this.state.lastFetchOkTs || null,
      lastDecisionTs: this.state.lastDecisionTs || null,
      lastSelectedMarketTs: this.state.lastDecisionTs || null,
      threshold: this.config.polymarket.live.minEdgeThreshold,
      currentBtcMid: null,
      minVenueShares: this.getMinVenueShares(),
      desiredShares: null,
      finalShares: null,
      desiredNotional: null,
      finalNotional: null,
      sizeBumped: null,
      lastNormalizedError: this.state.blockedBy,
      pollTrace: [],
      rolloverTrace: [],
      currentMarketSlug: this.state.selectedSlug ?? this.state.currentBucketSlug,
      currentMarketRemainingSec: this.state.remainingSec,
      currentMarketExpiresAt:
        this.state.tickNowSec !== null && this.state.remainingSec !== null
          ? (this.state.tickNowSec + this.state.remainingSec) * 1000
          : null,
      whyNotTrading: this.state.action === "HOLD" ? this.state.holdReason : null,
      currentMarketStatus:
        !this.state.running
          ? "STARTING"
          : this.state.selectedSlug
            ? "RUNNING"
            : "NO_ACTIVE_BTC5M_MARKET",
      mode: this.config.polymarket.mode,
      polyMoney: false,
      lastAction: this.state.action === "HOLD" ? "HOLD" : "OPEN",
      holdReason: this.state.holdReason,
      blockedBy: this.state.blockedBy,
      currentWindowHoldReason: this.state.holdReason,
      holdCategory: this.state.holdReason ? "STRATEGY" : null,
      strategyAction: this.state.action,
      selectedTokenId: this.state.selectedTokenId,
      selectedBookable: Boolean(this.state.selectedTokenId),
      selectedTradable: Boolean(this.state.selectedTokenId),
      discoveredCurrent: this.state.selectedSlug === this.state.currentBucketSlug,
      discoveredNext: this.state.selectedSlug === this.state.nextBucketSlug,
      selectionSource:
        this.state.selectedSlug === this.state.currentBucketSlug
          ? "current_slug"
          : this.state.selectedSlug === this.state.nextBucketSlug
            ? "next_slug"
            : null,
      selectedFrom:
        this.state.selectedSlug === this.state.currentBucketSlug
          ? "current_slug"
          : this.state.selectedSlug === this.state.nextBucketSlug
            ? "next_slug"
            : null,
      selectionCommitTs: this.state.lastDecisionTs || null,
      liveValidationReason: this.state.action === "HOLD" ? this.state.holdReason : "OK",
      lastBookTs: null,
      lastQuoteTs: null,
      currentBucketSlug: this.state.currentBucketSlug,
      nextBucketSlug: this.state.nextBucketSlug,
      currentBucketStartSec: this.state.currentBucketStartSec,
      selectedWindowStartSec: this.state.currentBucketStartSec,
      selectedWindowEndSec:
        this.state.currentBucketStartSec !== null ? this.state.currentBucketStartSec + 300 : null,
      candidateRefreshed: null,
      lastPreorderValidationReason: null,
      openTradesCount: 0,
      awaitingResolutionCount: 0,
      resolutionErrorCount: 0,
      resolutionQueueCount: 0,
      selection: {
        finalCandidatesCount: this.state.selectedSlug ? 1 : 0,
        discoveredCandidatesCount: this.state.selectedSlug ? 1 : 0,
        windowsCount: this.state.selectedSlug ? 1 : 0,
        selectedSlug: this.state.selectedSlug,
        selectedMarketId: null,
        windowStartTs: this.state.currentBucketStartSec !== null ? this.state.currentBucketStartSec * 1000 : null,
        windowEndTs:
          this.state.currentBucketStartSec !== null ? (this.state.currentBucketStartSec + 300) * 1000 : null,
        remainingSec: this.state.remainingSec,
        chosenSide: this.state.chosenSide,
        chosenDirection: this.state.chosenDirection,
        entriesInWindow: 0,
        realizedPnlUsd: 0,
        resolutionSource: null,
        lifecycleStatus: this.state.selectedSlug ? "ACTIVE" : "EMPTY"
      },
      dataHealth: {
        oracleSource: null,
        oracleState: null,
        latestPolymarketTs: null,
        latestModelTs: null,
        lastFetchAttemptTs: this.state.lastFetchAttemptTs,
        lastFetchOkTs: this.state.lastFetchOkTs,
        lastFetchErr: this.state.lastFetchErr,
        lastHttpStatus: 0,
        lastBookTsMs: 0,
        lastYesBid: null,
        lastYesAsk: null,
        lastYesMid: null,
        lastModelTs: 0
      },
      state: {
        holdDetailReason: this.state.holdReason,
        dominantReject: this.state.blockedBy,
        rejectCountsByStage: {},
        sampleRejected: []
      },
      lastTrade: {
        id: null,
        slug: this.state.selectedSlug,
        ts: null
      },
      openTrade: null,
      polyEngineRunning: this.state.running,
      lastUpdateTs: this.state.lastUpdateTs,
      lastUpdateAgeSec,
      status: this.state.running ? "RUNNING" : "STARTING",
      running: this.state.running,
      fetchOk: this.state.fetchOk
    };
  }

  private async runLoop(): Promise<void> {
    const loopMs = 2_000;
    while (!this.stopRequested) {
      await this.processCycle(true);
      await sleep(loopMs);
    }
  }

  private async processCycle(allowExecution: boolean): Promise<void> {
    const tick = deriveBtc5mTickContext(Date.now());
    this.state.currentBucketSlug = tick.currentSlug;
    this.state.nextBucketSlug = tick.nextSlug;
    this.state.currentBucketStartSec = tick.currentBucketStartSec;
    this.state.remainingSec = tick.remainingSec;
    this.state.tickNowSec = tick.tickNowSec;
    this.state.lastFetchAttemptTs = tick.tickNowMs;
    this.state.lastUpdateTs = tick.tickNowMs;

    this.logger.warn(
      {
        tickNowSec: tick.tickNowSec,
        currentSlug: tick.currentSlug,
        nextSlug: tick.nextSlug,
        prevSlug: tick.prevSlug,
        remainingSec: tick.remainingSec
      },
      "POLY_V2_TICK"
    );
    if (this.firstTickResolve) {
      this.firstTickResolve();
      this.firstTickResolve = null;
    }

    const tickInvariant = this.validateTickInvariant(tick);
    if (!tickInvariant.ok) {
      this.state.fetchOk = false;
      this.state.lastFetchErr = tickInvariant.reason;
      this.state.action = "HOLD";
      this.state.holdReason = tickInvariant.reason;
      this.state.blockedBy = tickInvariant.reason;
      this.state.warningState = "INVARIANT";
      this.logInvariantBroken(tick, tickInvariant.reason, {});
      this.logDecision({
        edge: Number.NaN,
        threshold: this.config.polymarket.live.minEdgeThreshold,
        spread: Number.NaN,
        maxSpread: this.config.polymarket.live.maxSpread,
        remainingSec: tick.remainingSec,
        minEntryRemainingSec: this.config.polymarket.live.minEntryRemainingSec,
        oracleAgeMs: null,
        blocker: tickInvariant.reason,
        blockerSeverity: "hard",
        warning: null,
        action: "HOLD"
      });
      this.pushRecentTick({ tickNowSec: tick.tickNowSec, action: "HOLD", blocker: tickInvariant.reason });
      return;
    }

    const reference = this.getReferencePrice(tick.tickNowMs);
    const selectionResult = await this.selector.select({
      tick,
      referencePrice: reference.price
    });
    const selected = selectionResult.selected;
    const selectionReason = String(selectionResult.reason || "");
    const networkFailure =
      selectionReason.includes("NETWORK") || selectionReason.includes("timeout") || selectionReason.includes("Timeout");
    this.state.fetchOk = !networkFailure;
    if (this.state.fetchOk) {
      this.state.lastFetchOkTs = tick.tickNowMs;
      this.state.lastFetchErr = null;
    } else {
      this.state.lastFetchErr = selectionReason;
    }

    this.logger.warn(
      {
        selectedSlug: selected?.slug ?? null,
        selectedTokenId: selected?.selectedTokenId ?? null,
        side: selected?.chosenSide ?? null,
        orderbookOk: selected?.orderbookOk ?? false,
        reason: selectionResult.reason
      },
      "POLY_V2_SELECTION"
    );

    if (!selected) {
      const blocker = selectionResult.reason || "NO_DIRECT_MARKET";
      this.state.selectedSlug = null;
      this.state.selectedTokenId = null;
      this.state.chosenSide = null;
      this.state.chosenDirection = null;
      this.state.action = "HOLD";
      this.state.holdReason = blocker;
      this.state.blockedBy = blocker;
      this.state.warningState = blocker === "NO_DIRECT_MARKET" ? null : blocker;
      this.logger.warn(
        {
          tickNowSec: tick.tickNowSec,
          currentSlug: tick.currentSlug,
          nextSlug: tick.nextSlug,
          reason: blocker
        },
        "POLY_V2_NO_MARKET"
      );
      this.logDecision({
        edge: Number.NaN,
        threshold: this.config.polymarket.live.minEdgeThreshold,
        spread: Number.NaN,
        maxSpread: this.config.polymarket.live.maxSpread,
        remainingSec: tick.remainingSec,
        minEntryRemainingSec: this.config.polymarket.live.minEntryRemainingSec,
        oracleAgeMs: reference.ageMs,
        blocker,
        blockerSeverity: "hard",
        warning: null,
        action: "HOLD"
      });
      this.pushRecentTick({ tickNowSec: tick.tickNowSec, action: "HOLD", blocker });
      return;
    }

    const selectedInvariant = this.validateSelectionInvariant(tick, selected);
    if (!selectedInvariant.ok) {
      this.state.selectedSlug = selected.slug;
      this.state.selectedTokenId = selected.selectedTokenId;
      this.state.chosenSide = selected.chosenSide;
      this.state.chosenDirection = chosenDirectionForSide(selected.chosenSide);
      this.state.action = "HOLD";
      this.state.holdReason = selectedInvariant.reason;
      this.state.blockedBy = selectedInvariant.reason;
      this.state.warningState = "INVARIANT";
      this.logInvariantBroken(tick, selectedInvariant.reason, {
        selectedSlug: selected.slug,
        selectedTokenId: selected.selectedTokenId,
        side: selected.chosenSide
      });
      this.logDecision({
        edge: Number.NaN,
        threshold: this.config.polymarket.live.minEdgeThreshold,
        spread: selected.chosenSide === "YES" ? Number(selected.yesBook.spread) : Number(selected.noBook.spread),
        maxSpread: this.config.polymarket.live.maxSpread,
        remainingSec: tick.remainingSec,
        minEntryRemainingSec: this.config.polymarket.live.minEntryRemainingSec,
        oracleAgeMs: reference.ageMs,
        blocker: selectedInvariant.reason,
        blockerSeverity: "hard",
        warning: null,
        action: "HOLD"
      });
      this.pushRecentTick({ tickNowSec: tick.tickNowSec, action: "HOLD", blocker: selectedInvariant.reason });
      return;
    }

    const decision = this.gate.evaluate({
      tick,
      selected,
      referencePrice: reference.price,
      oracleAgeMs: reference.ageMs
    });
    const executionResult = await this.maybeExecuteDecision({
      tick,
      selected,
      decision,
      allowExecution
    });

    const finalAction = executionResult.action;
    const finalBlocker = executionResult.blocker;
    this.state.selectedSlug = selected.slug;
    this.state.selectedTokenId = selected.selectedTokenId;
    this.state.chosenSide = selected.chosenSide;
    this.state.chosenDirection = chosenDirectionForSide(selected.chosenSide);
    this.state.action = finalAction;
    this.state.holdReason = finalAction === "HOLD" ? finalBlocker || "HOLD" : null;
    this.state.blockedBy = finalAction === "HOLD" ? finalBlocker || "HOLD" : null;
    this.state.warningState = finalAction === "HOLD" ? finalBlocker : decision.warning;
    this.state.lastDecisionTs = tick.tickNowMs;

    this.logDecision({
      edge: decision.edge,
      threshold: decision.threshold,
      spread: decision.spread,
      maxSpread: decision.maxSpread,
      remainingSec: decision.remainingSec,
      minEntryRemainingSec: decision.minEntryRemainingSec,
      oracleAgeMs: decision.oracleAgeMs,
      blocker: finalBlocker,
      blockerSeverity: finalAction === "HOLD" ? "hard" : decision.blockerSeverity,
      warning: decision.warning,
      action: finalAction
    });
    this.pushRecentTick({
      tickNowSec: tick.tickNowSec,
      selectedSlug: selected.slug,
      selectedTokenId: selected.selectedTokenId,
      side: selected.chosenSide,
      action: finalAction,
      blocker: finalBlocker
    });
  }

  private async maybeExecuteDecision(input: {
    tick: Btc5mTick;
    selected: Btc5mSelectedMarket;
    decision: Btc5mDecision;
    allowExecution: boolean;
  }): Promise<{ action: "BUY_YES" | "BUY_NO" | "HOLD"; blocker: string | null }> {
    if (!input.allowExecution) {
      return {
        action: input.decision.action === "BUY_YES" || input.decision.action === "BUY_NO" ? input.decision.action : "HOLD",
        blocker: input.decision.blocker
      };
    }
    if (!this.canMutateVenueState()) {
      return { action: "HOLD", blocker: "LIVE_EXECUTION_DISABLED" };
    }
    if (input.decision.action === "HOLD") {
      return { action: "HOLD", blocker: input.decision.blocker || "HOLD" };
    }
    if (!input.decision.chosenSide || !input.decision.sideAsk || !input.selected.selectedTokenId) {
      return { action: "HOLD", blocker: "TOKEN_NOT_BOOKABLE" };
    }

    const tauSec = Math.max(0, input.tick.remainingSec);
    const oracleAgeMs = input.decision.oracleAgeMs;
    const oracleHardBlockMs = Math.max(
      this.config.polymarket.live.oracleWarnMs + 1,
      this.config.polymarket.live.oracleHardBlockMs
    );
    if (oracleAgeMs !== null && Number.isFinite(oracleAgeMs) && oracleAgeMs > oracleHardBlockMs) {
      return { action: "HOLD", blocker: "STALE_ORACLE" };
    }
    const exposure = this.execution.getTotalExposureUsd();
    const remainingExposureBudget = Math.max(0, this.config.polymarket.risk.maxExposure - exposure);
    const remainingWindowBudget = Math.max(0, this.config.polymarket.sizing.maxNotionalPerWindow);

    const computed = this.sizing.compute({
      edge: Math.max(0, input.decision.edge),
      pUpModel:
        input.decision.chosenSide === "YES"
          ? input.decision.pUpModel ?? 0.5
          : 1 - (input.decision.pUpModel ?? 0.5),
      yesAsk: input.decision.sideAsk,
      conviction: Math.min(0.8, Math.max(0.1, Math.abs(input.decision.edge) * 200)),
      remainingSec: tauSec,
      entryMaxRemainingSec: this.config.polymarket.paper.entryMaxRemainingSec,
      depthCapNotionalUsd: remainingWindowBudget,
      remainingWindowBudget,
      remainingExposureBudget,
      remainingDailyLossBudget: this.risk.getRemainingDailyLossBudget()
    });

    let notionalUsd = Math.max(0, computed.notionalUsd);
    const minVenueShares = this.getMinVenueShares();
    if (input.decision.sideAsk > 0 && notionalUsd > 0) {
      const shares = notionalUsd / input.decision.sideAsk;
      if (shares < minVenueShares) {
        notionalUsd = minVenueShares * input.decision.sideAsk;
      }
    }
    if (!(notionalUsd > 0)) {
      return { action: "HOLD", blocker: "SIZE_BELOW_MIN_NOTIONAL" };
    }

    const riskCheck = this.risk.checkNewOrder({
      tauSec,
      oracleAgeMs:
        oracleAgeMs !== null && Number.isFinite(oracleAgeMs)
          ? Math.min(oracleAgeMs, this.config.polymarket.risk.staleMs)
          : 0,
      projectedOrderNotionalUsd: notionalUsd,
      openOrders: this.execution.getOpenOrderCount(),
      totalExposureUsd: exposure,
      concurrentWindows: this.execution.getConcurrentWindows()
    });
    if (!riskCheck.ok) {
      return { action: "HOLD", blocker: riskCheck.reason || "RISK_BLOCKED" };
    }

    const result =
      input.decision.chosenSide === "YES"
        ? await this.execution.executeBuyYes({
            marketId: input.selected.marketId,
            tokenId: input.selected.selectedTokenId,
            yesAsk: input.decision.sideAsk,
            notionalUsd,
            tickSize: input.selected.tickSize,
            negRisk: input.selected.negRisk
          })
        : await this.execution.executeBuyNo({
            marketId: input.selected.marketId,
            tokenId: input.selected.selectedTokenId,
            noAsk: input.decision.sideAsk,
            notionalUsd,
            tickSize: input.selected.tickSize,
            negRisk: input.selected.negRisk
          });
    if (!result.accepted) {
      return { action: "HOLD", blocker: result.reason || "LIVE_REJECTED" };
    }
    return {
      action: input.decision.chosenSide === "YES" ? "BUY_YES" : "BUY_NO",
      blocker: null
    };
  }

  private validateTickInvariant(tick: Btc5mTick): { ok: true } | { ok: false; reason: string } {
    const expectedSlug = slugForTs(tick.currentBucketStartSec);
    if (tick.currentSlug !== expectedSlug) {
      return { ok: false, reason: "CURRENT_BUCKET_SLUG_MISMATCH" };
    }
    return { ok: true };
  }

  private validateSelectionInvariant(
    tick: Btc5mTick,
    selected: Btc5mSelectedMarket
  ): { ok: true } | { ok: false; reason: string } {
    if (selected.slug !== tick.currentSlug && selected.slug !== tick.nextSlug) {
      return { ok: false, reason: "SELECTED_SLUG_NOT_CURRENT_OR_NEXT" };
    }
    if (!selected.selectedTokenId || !selected.orderbookOk) {
      return { ok: false, reason: "SELECTED_TOKEN_NOT_EXECUTABLE" };
    }
    return { ok: true };
  }

  private logDecision(input: {
    edge: number;
    threshold: number;
    spread: number;
    maxSpread: number;
    remainingSec: number | null;
    minEntryRemainingSec: number;
    oracleAgeMs: number | null;
    blocker: string | null;
    blockerSeverity: "hard" | "warning-only" | null;
    warning: string | null;
    action: "BUY_YES" | "BUY_NO" | "HOLD";
  }): void {
    this.logger.warn(
      {
        edge: Number.isFinite(input.edge) ? input.edge : null,
        threshold: Number.isFinite(input.threshold) ? input.threshold : null,
        spread: Number.isFinite(input.spread) ? input.spread : null,
        maxSpread: Number.isFinite(input.maxSpread) ? input.maxSpread : null,
        remainingSec: input.remainingSec,
        minEntryRemainingSec: Number.isFinite(input.minEntryRemainingSec) ? input.minEntryRemainingSec : null,
        oracleAgeMs: input.oracleAgeMs,
        blocker: input.blocker,
        blockerSeverity: input.blockerSeverity,
        warning: input.warning,
        action: input.action
      },
      "POLY_V2_DECISION"
    );
  }

  private logInvariantBroken(tick: Btc5mTick, reason: string, extra: Record<string, unknown>): void {
    this.logger.error(
      {
        reason,
        tickNowSec: tick.tickNowSec,
        currentBucketStartSec: tick.currentBucketStartSec,
        currentSlug: tick.currentSlug,
        nextSlug: tick.nextSlug,
        prevSlug: tick.prevSlug,
        remainingSec: tick.remainingSec,
        ...extra
      },
      "POLY_V2_INVARIANT_BROKEN"
    );
  }

  private pushRecentTick(line: Record<string, unknown>): void {
    this.recentTicks.push({
      ts: Date.now(),
      ...line
    });
    if (this.recentTicks.length > 200) {
      this.recentTicks.splice(0, this.recentTicks.length - 200);
    }
  }

  private getReferencePrice(nowMs: number): { price: number | null; ageMs: number | null } {
    if (!this.store) {
      return { price: null, ageMs: null };
    }
    const quotes = this.store
      .getLatestVenueQuotes(this.config.symbol)
      .filter((row) => Number.isFinite(row.mid) && row.mid !== null && Number(row.mid) > 0);
    if (quotes.length === 0) {
      return { price: null, ageMs: null };
    }
    const latestTs = Math.max(...quotes.map((row) => Number(row.ts || 0)));
    const mids = quotes
      .filter((row) => Number(row.ts || 0) >= latestTs - 5_000)
      .map((row) => Number(row.mid))
      .filter((row) => Number.isFinite(row) && row > 0)
      .sort((a, b) => a - b);
    const mid = mids.length > 0 ? mids[Math.floor(mids.length / 2)] : null;
    return {
      price: mid,
      ageMs: latestTs > 0 ? Math.max(0, nowMs - latestTs) : null
    };
  }

  private getMinVenueShares(): number {
    const envValue = Number(process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES || 5);
    if (!Number.isFinite(envValue)) return 5;
    return Math.max(1, Math.floor(envValue));
  }

  private canMutateVenueState(): boolean {
    return (
      this.config.polymarket.mode === "live" &&
      this.config.polymarket.liveConfirmed &&
      this.config.polymarket.liveExecutionEnabled &&
      !this.config.polymarket.killSwitch
    );
  }
}

function chosenDirectionForSide(side: "YES" | "NO"): "UP" | "DOWN" {
  return side === "YES" ? "UP" : "DOWN";
}

function shortError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "unknown_error");
}
