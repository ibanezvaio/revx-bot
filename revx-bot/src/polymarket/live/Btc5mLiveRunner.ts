import { BotConfig } from "../../config";
import { IntelEngine } from "../../intel/IntelEngine";
import { Logger } from "../../logger";
import { SignalsEngine } from "../../signals/SignalsEngine";
import { Store } from "../../store/Store";
import { sleep } from "../../util/time";
import { deriveBtc5mTickContext, slugForTs } from "../btc5m";
import { PolymarketClient } from "../PolymarketClient";
import { PolymarketExecution } from "../Execution";
import { PolymarketRisk } from "../Risk";
import { Sizing } from "../Sizing";
import { Btc5mExecutionGate } from "./Btc5mExecutionGate";
import { Btc5mSelector } from "./Btc5mSelector";
import { Btc5mDecision, Btc5mIntelligence, Btc5mSelectedMarket, Btc5mTick } from "./Btc5mTypes";

type RunnerDeps = {
  store?: Store;
  intelEngine?: IntelEngine;
  signalsEngine?: SignalsEngine;
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

type ExecutionAttempt = {
  attemptId: string;
  executionSlug: string;
  selectedSlug: string;
  currentSlugAtCreate: string;
  side: "YES" | "NO";
  tokenId: string;
  retryCount: number;
  createdTs: number;
  deadlineTs: number;
  tick: Btc5mTick;
  selected: Btc5mSelectedMarket;
  decision: Btc5mDecision;
};

export class Btc5mLiveRunner {
  private readonly client: PolymarketClient;
  private readonly execution: PolymarketExecution;
  private readonly risk: PolymarketRisk;
  private readonly sizing: Sizing;
  private readonly selector: Btc5mSelector;
  private readonly gate: Btc5mExecutionGate;
  private readonly store?: Store;
  private readonly intelEngine?: IntelEngine;
  private readonly signalsEngine?: SignalsEngine;

  private running = false;
  private stopRequested = false;
  private loopTask: Promise<void> | null = null;
  private firstTickResolve: (() => void) | null = null;
  private firstTickPromise: Promise<void> | null = null;
  private readonly recentTicks: Array<Record<string, unknown>> = [];
  private activeExecutionAttempt: ExecutionAttempt | null = null;
  private activeExecutionTask: Promise<void> | null = null;
  private executionAttemptSeq = 0;
  private executionCooldownUntilTs = 0;
  private invalidatedAttemptIds = new Set<string>();
  private previousCurrentSlug: string | null = null;
  private lastRolloverTs = 0;
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
    this.intelEngine = deps.intelEngine;
    this.signalsEngine = deps.signalsEngine;
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
    this.invalidateExecutionAttempt("STOP_REQUESTED", { currentSlug: this.state.currentBucketSlug ?? null });
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
    if (this.previousCurrentSlug && this.previousCurrentSlug !== tick.currentSlug) {
      this.logger.warn(
        {
          previousCurrentSlug: this.previousCurrentSlug,
          currentSlug: tick.currentSlug,
          nextSlug: tick.nextSlug
        },
        "POLY_V2_MARKET_ROLLOVER"
      );
      this.lastRolloverTs = tick.tickNowMs;
      this.invalidateExecutionAttempt("ROLLOVER", {
        currentSlug: tick.currentSlug,
        selectedSlug: this.activeExecutionAttempt?.selectedSlug ?? null
      });
    }
    this.previousCurrentSlug = tick.currentSlug;

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
        yesEdge: Number.NaN,
        noEdge: Number.NaN,
        pUpModel: null,
        intelligenceSource: "NONE",
        intelligencePosture: null,
        intelligenceScore: null,
        threshold: this.config.polymarket.live.minEdgeThreshold,
        spread: Number.NaN,
        yesSpread: Number.NaN,
        noSpread: Number.NaN,
        maxSpread: this.config.polymarket.live.maxSpread,
        remainingSec: tick.remainingSec,
        minEntryRemainingSec: this.config.polymarket.live.minEntryRemainingSec,
        oracleAgeMs: null,
        blocker: tickInvariant.reason,
        blockerSeverity: "hard",
        warning: null,
        chosenSide: null,
        action: "HOLD"
      });
      this.pushRecentTick({ tickNowSec: tick.tickNowSec, action: "HOLD", blocker: tickInvariant.reason });
      return;
    }

    const reference = this.getReferencePrice(tick.tickNowMs);
    const selectionResult = await this.selector.select({
      tick
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
        yesTokenId: selected?.yesTokenId ?? null,
        noTokenId: selected?.noTokenId ?? null,
        selectedTokenId: selected?.selectedTokenId ?? null,
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
        yesEdge: Number.NaN,
        noEdge: Number.NaN,
        pUpModel: null,
        intelligenceSource: "NONE",
        intelligencePosture: null,
        intelligenceScore: null,
        threshold: this.config.polymarket.live.minEdgeThreshold,
        spread: Number.NaN,
        yesSpread: Number.NaN,
        noSpread: Number.NaN,
        maxSpread: this.config.polymarket.live.maxSpread,
        remainingSec: tick.remainingSec,
        minEntryRemainingSec: this.config.polymarket.live.minEntryRemainingSec,
        oracleAgeMs: reference.ageMs,
        blocker,
        blockerSeverity: "hard",
        warning: null,
        chosenSide: null,
        action: "HOLD"
      });
      this.pushRecentTick({ tickNowSec: tick.tickNowSec, action: "HOLD", blocker });
      return;
    }

    const selectedInvariant = this.validateSelectionInvariant(tick, selected);
    if (!selectedInvariant.ok) {
      this.state.selectedSlug = selected.slug;
      this.state.selectedTokenId = null;
      this.state.chosenSide = null;
      this.state.chosenDirection = null;
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
        yesEdge: Number.NaN,
        noEdge: Number.NaN,
        pUpModel: null,
        intelligenceSource: "NONE",
        intelligencePosture: null,
        intelligenceScore: null,
        threshold: this.config.polymarket.live.minEdgeThreshold,
        spread: Number.NaN,
        yesSpread: Number(selected.yesBook.spread),
        noSpread: Number(selected.noBook.spread),
        maxSpread: this.config.polymarket.live.maxSpread,
        remainingSec: tick.remainingSec,
        minEntryRemainingSec: this.config.polymarket.live.minEntryRemainingSec,
        oracleAgeMs: reference.ageMs,
        blocker: selectedInvariant.reason,
        blockerSeverity: "hard",
        warning: null,
        chosenSide: null,
        action: "HOLD"
      });
      this.pushRecentTick({ tickNowSec: tick.tickNowSec, action: "HOLD", blocker: selectedInvariant.reason });
      return;
    }

    const intelligence = this.resolveDirectionalIntelligence({
      nowMs: tick.tickNowMs,
      referencePrice: reference.price,
      priceToBeat: selected.priceToBeat,
      fallbackMid: selected.yesBook.mid
    });
    if (intelligence.fallbackUsed) {
      this.logger.warn(
        {
          source: intelligence.source,
          pUpModel: intelligence.pUpModel,
          referencePrice: reference.price,
          priceToBeat: selected.priceToBeat
        },
        "POLY_V2_INTEL_FALLBACK"
      );
    }

    const decision = this.gate.evaluate({
      tick,
      selected,
      intelligence,
      oracleAgeMs: reference.ageMs
    });
    const executionDispatch = this.dispatchExecutionAttempt({
      tick,
      selected,
      decision,
      allowExecution
    });

    const finalAction = executionDispatch.action;
    const finalBlocker = executionDispatch.blocker;
    const chosenSide = decision.chosenSide;
    const selectedTokenId =
      chosenSide === "YES" ? selected.yesTokenId : chosenSide === "NO" ? selected.noTokenId : null;
    this.state.selectedSlug = selected.slug;
    this.state.selectedTokenId = selectedTokenId;
    this.state.chosenSide = chosenSide;
    this.state.chosenDirection = chosenSide ? chosenDirectionForSide(chosenSide) : null;
    this.state.action = finalAction;
    this.state.holdReason = finalAction === "HOLD" ? finalBlocker || "HOLD" : null;
    this.state.blockedBy = finalAction === "HOLD" ? finalBlocker || "HOLD" : null;
    this.state.warningState = finalAction === "HOLD" ? finalBlocker : decision.warning;
    this.state.lastDecisionTs = tick.tickNowMs;

    this.logDecision({
      edge: decision.edge,
      yesEdge: decision.yesEdge,
      noEdge: decision.noEdge,
      pUpModel: decision.pUpModel,
      intelligenceSource: decision.intelligenceSource,
      intelligencePosture: decision.intelligencePosture,
      intelligenceScore: decision.intelligenceScore,
      threshold: decision.threshold,
      spread: decision.spread,
      yesSpread: decision.yesSpread,
      noSpread: decision.noSpread,
      maxSpread: decision.maxSpread,
      remainingSec: decision.remainingSec,
      minEntryRemainingSec: decision.minEntryRemainingSec,
      oracleAgeMs: decision.oracleAgeMs,
      blocker: finalBlocker,
      blockerSeverity: finalAction === "HOLD" ? "hard" : decision.blockerSeverity,
      warning: decision.warning,
      chosenSide: decision.chosenSide,
      action: finalAction
    });
    this.pushRecentTick({
      tickNowSec: tick.tickNowSec,
      selectedSlug: selected.slug,
      selectedTokenId,
      side: chosenSide,
      action: finalAction,
      blocker: finalBlocker
    });
  }

  private dispatchExecutionAttempt(input: {
    tick: Btc5mTick;
    selected: Btc5mSelectedMarket;
    decision: Btc5mDecision;
    allowExecution: boolean;
  }): { action: "BUY_YES" | "BUY_NO" | "HOLD"; blocker: string | null } {
    if (input.decision.action === "HOLD") {
      return { action: "HOLD", blocker: input.decision.blocker || "HOLD" };
    }
    if (!input.allowExecution) {
      return { action: input.decision.action, blocker: null };
    }
    if (!this.canMutateVenueState()) {
      return { action: "HOLD", blocker: "LIVE_EXECUTION_DISABLED" };
    }
    if (Date.now() < this.executionCooldownUntilTs) {
      return { action: "HOLD", blocker: "EXECUTION_COOLDOWN" };
    }

    const tokenId =
      input.decision.chosenSide === "YES"
        ? input.selected.yesTokenId
        : input.decision.chosenSide === "NO"
          ? input.selected.noTokenId
          : null;
    if (!input.decision.chosenSide || !tokenId) {
      return { action: "HOLD", blocker: "TOKEN_NOT_BOOKABLE" };
    }
    if (input.selected.slug !== input.tick.currentSlug) {
      this.logger.warn(
        {
          executionSlug: input.selected.slug,
          currentSlug: input.tick.currentSlug,
          selectedSlug: input.selected.slug,
          side: input.decision.chosenSide,
          tokenId,
          retryCount: 0,
          reason: "INVARIANT_EXECUTION_SLUG_NOT_CURRENT"
        },
        "POLY_V2_SKIP_NEXT_MARKET_EXECUTION"
      );
      return { action: "HOLD", blocker: "NEXT_MARKET_PRELOAD_ONLY" };
    }

    const postRolloverGraceMs = this.getPostRolloverGraceMs();
    const elapsedSinceRolloverMs = this.lastRolloverTs > 0 ? input.tick.tickNowMs - this.lastRolloverTs : Number.POSITIVE_INFINITY;
    if (elapsedSinceRolloverMs < postRolloverGraceMs) {
      this.logger.warn(
        {
          executionSlug: input.selected.slug,
          currentSlug: input.tick.currentSlug,
          selectedSlug: input.selected.slug,
          side: input.decision.chosenSide,
          tokenId,
          retryCount: 0,
          elapsedMs: elapsedSinceRolloverMs,
          graceMs: postRolloverGraceMs
        },
        "POLY_V2_POST_ROLLOVER_GRACE"
      );
      return { action: "HOLD", blocker: "POST_ROLLOVER_GRACE" };
    }

    const active = this.activeExecutionAttempt;
    if (active && this.isExecutionAttemptActive(active)) {
      const sameAttemptTarget =
        active.executionSlug === input.selected.slug && active.side === input.decision.chosenSide && active.tokenId === tokenId;
      if (sameAttemptTarget) {
        return { action: "HOLD", blocker: "EXECUTION_IN_FLIGHT" };
      }
      this.invalidateExecutionAttempt("SUPERSEDED", {
        currentSlug: input.tick.currentSlug,
        selectedSlug: input.selected.slug
      });
    }

    const attempt: ExecutionAttempt = {
      attemptId: `att-${++this.executionAttemptSeq}`,
      executionSlug: input.selected.slug,
      selectedSlug: input.selected.slug,
      currentSlugAtCreate: input.tick.currentSlug,
      side: input.decision.chosenSide,
      tokenId,
      retryCount: 0,
      createdTs: Date.now(),
      deadlineTs: Date.now() + this.getExecutionDeadlineMs(),
      tick: input.tick,
      selected: input.selected,
      decision: input.decision
    };
    this.activeExecutionAttempt = attempt;
    this.logger.warn(
      {
        attemptId: attempt.attemptId,
        executionSlug: attempt.executionSlug,
        currentSlug: input.tick.currentSlug,
        selectedSlug: input.selected.slug,
        side: attempt.side,
        tokenId: attempt.tokenId,
        retryCount: attempt.retryCount,
        reason: "CREATED"
      },
      "POLY_V2_EXECUTION_ATTEMPT_CREATED"
    );
    this.startExecutionAttempt(attempt);
    return { action: input.decision.action, blocker: null };
  }

  private startExecutionAttempt(attempt: ExecutionAttempt): void {
    let task: Promise<void> | null = null;
    task = (async () => {
      try {
        if (!this.isExecutionAttemptActive(attempt)) {
          this.logExecutionAttemptStale(attempt, "STALE_BEFORE_START");
          return;
        }

        const timeoutMs = Math.max(1, attempt.deadlineTs - Date.now());
        let timeoutHandle: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<"TIMEOUT">((resolve) => {
          timeoutHandle = setTimeout(() => resolve("TIMEOUT"), timeoutMs);
        });
        const executionPromise = this.maybeExecuteDecision({
          tick: attempt.tick,
          selected: attempt.selected,
          decision: attempt.decision,
          allowExecution: true,
          attempt
        });

        const raceResult = await Promise.race([executionPromise, timeoutPromise]);
        if (timeoutHandle) clearTimeout(timeoutHandle);

        if (raceResult === "TIMEOUT") {
          this.applyExecutionCooldown("EXECUTION_DEADLINE_EXCEEDED", this.getExecutionCooldownMs(), attempt);
          this.logger.warn(
            {
              attemptId: attempt.attemptId,
              executionSlug: attempt.executionSlug,
              currentSlug: this.state.currentBucketSlug,
              selectedSlug: attempt.selectedSlug,
              side: attempt.side,
              tokenId: attempt.tokenId,
              retryCount: attempt.retryCount,
              reason: "EXECUTION_DEADLINE_EXCEEDED"
            },
            "POLY_V2_EXECUTION_TIMEOUT"
          );
          this.resetExecutionAttemptState("EXECUTION_DEADLINE_EXCEEDED", attempt);
          return;
        }

        if (!this.isExecutionAttemptActive(attempt)) {
          this.logExecutionAttemptStale(attempt, "STALE_AFTER_EXECUTION");
          return;
        }

        if (raceResult.action === "HOLD" && raceResult.blocker) {
          if (raceResult.blocker === "STALE_AFTER_POST") {
            this.applyExecutionCooldown("STALE_AFTER_POST", this.getStaleAfterPostCooldownMs(), attempt);
            this.resetExecutionAttemptState("STALE_AFTER_POST", attempt);
            return;
          }
          if (raceResult.blocker === "STALE_ATTEMPT_ABORTED") {
            this.resetExecutionAttemptState("STALE_ATTEMPT_ABORTED", attempt);
            return;
          }
          if (isTransientExecutionError(raceResult.blocker)) {
            this.applyExecutionCooldown(raceResult.blocker, this.getExecutionCooldownMs(), attempt);
          }
          this.logger.warn(
            {
              attemptId: attempt.attemptId,
              executionSlug: attempt.executionSlug,
              currentSlug: this.state.currentBucketSlug,
              selectedSlug: attempt.selectedSlug,
              side: attempt.side,
              tokenId: attempt.tokenId,
              retryCount: attempt.retryCount,
              reason: raceResult.blocker
            },
            "POLY_V2_EXECUTION_ATTEMPT_ABORTED"
          );
        }
      } catch (error) {
        this.applyExecutionCooldown("EXECUTION_EXCEPTION", this.getExecutionCooldownMs(), attempt);
        this.logger.warn(
          {
            attemptId: attempt.attemptId,
            executionSlug: attempt.executionSlug,
            currentSlug: this.state.currentBucketSlug,
            selectedSlug: attempt.selectedSlug,
            side: attempt.side,
            tokenId: attempt.tokenId,
            retryCount: attempt.retryCount,
            reason: shortError(error)
          },
          "POLY_V2_EXECUTION_ATTEMPT_ABORTED"
        );
        this.resetExecutionAttemptState("EXECUTION_EXCEPTION", attempt);
      } finally {
        if (this.activeExecutionAttempt?.attemptId === attempt.attemptId) {
          this.activeExecutionAttempt = null;
        }
        if (this.activeExecutionTask === task) {
          this.activeExecutionTask = null;
        }
      }
    })();
    this.activeExecutionTask = task;
  }

  private invalidateExecutionAttempt(
    reason: string,
    context: { currentSlug: string | null; selectedSlug?: string | null }
  ): void {
    const attempt = this.activeExecutionAttempt;
    if (!attempt) return;
    this.invalidatedAttemptIds.add(attempt.attemptId);
    this.logger.warn(
      {
        attemptId: attempt.attemptId,
        executionSlug: attempt.executionSlug,
        currentSlug: context.currentSlug,
        selectedSlug: context.selectedSlug ?? attempt.selectedSlug,
        side: attempt.side,
        tokenId: attempt.tokenId,
        retryCount: attempt.retryCount,
        reason
      },
      "POLY_V2_EXECUTION_ATTEMPT_ABORTED"
    );
    this.activeExecutionAttempt = null;
  }

  private resetExecutionAttemptState(reason: string, attempt: ExecutionAttempt): void {
    this.invalidatedAttemptIds.add(attempt.attemptId);
    this.logger.warn(
      {
        attemptId: attempt.attemptId,
        executionSlug: attempt.executionSlug,
        currentSlug: this.state.currentBucketSlug,
        selectedSlug: attempt.selectedSlug,
        side: attempt.side,
        tokenId: attempt.tokenId,
        retryCount: attempt.retryCount,
        reason
      },
      "POLY_V2_EXECUTION_ATTEMPT_RESET"
    );
    if (this.activeExecutionAttempt?.attemptId === attempt.attemptId) {
      this.activeExecutionAttempt = null;
    }
  }

  private applyExecutionCooldown(reason: string, cooldownMs: number, attempt: ExecutionAttempt): void {
    const untilTs = Date.now() + cooldownMs;
    if (untilTs > this.executionCooldownUntilTs) {
      this.executionCooldownUntilTs = untilTs;
    }
    this.logger.warn(
      {
        attemptId: attempt.attemptId,
        executionSlug: attempt.executionSlug,
        currentSlug: this.state.currentBucketSlug,
        selectedSlug: attempt.selectedSlug,
        side: attempt.side,
        tokenId: attempt.tokenId,
        retryCount: attempt.retryCount,
        reason,
        cooldownMs,
        cooldownUntilTs: this.executionCooldownUntilTs
      },
      "POLY_V2_RETRY_COOLDOWN"
    );
  }

  private isExecutionAttemptActive(attempt: ExecutionAttempt): boolean {
    if (Date.now() > attempt.deadlineTs) return false;
    if (this.invalidatedAttemptIds.has(attempt.attemptId)) return false;
    if (this.activeExecutionAttempt?.attemptId !== attempt.attemptId) return false;
    if (!this.isExecutionSlugEligible(attempt.executionSlug, deriveBtc5mTickContext(Date.now()))) return false;
    return true;
  }

  private logExecutionAttemptStale(attempt: ExecutionAttempt, reason: string): void {
    this.logger.warn(
      {
        attemptId: attempt.attemptId,
        executionSlug: attempt.executionSlug,
        currentSlug: this.state.currentBucketSlug,
        selectedSlug: attempt.selectedSlug,
        side: attempt.side,
        tokenId: attempt.tokenId,
        retryCount: attempt.retryCount,
        reason
      },
      "POLY_V2_EXECUTION_ATTEMPT_STALE"
    );
  }

  private abortStaleAttempt(attempt: ExecutionAttempt, reason: string): { action: "HOLD"; blocker: string } {
    this.logger.warn(
      {
        attemptId: attempt.attemptId,
        executionSlug: attempt.executionSlug,
        currentSlug: this.state.currentBucketSlug,
        selectedSlug: attempt.selectedSlug,
        side: attempt.side,
        tokenId: attempt.tokenId,
        retryCount: attempt.retryCount,
        reason
      },
      "POLY_V2_ABORT_STALE_ATTEMPT"
    );
    this.logExecutionAttemptStale(attempt, reason);
    if (reason === "STALE_AFTER_POST") {
      return { action: "HOLD", blocker: "STALE_AFTER_POST" };
    }
    return { action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" };
  }

  private isExecutionSlugEligible(slug: string, tick: Btc5mTick): boolean {
    return slug === tick.currentSlug;
  }

  private getExecutionDeadlineMs(): number {
    const envValue = Number(process.env.POLY_V2_EXECUTION_DEADLINE_MS || 25_000);
    if (!Number.isFinite(envValue)) return 25_000;
    return Math.max(1_000, Math.min(30_000, Math.floor(envValue)));
  }

  private getExecutionCooldownMs(): number {
    const envValue = Number(process.env.POLY_V2_EXECUTION_COOLDOWN_MS || 5_000);
    if (!Number.isFinite(envValue)) return 5_000;
    return Math.max(1_000, Math.min(120_000, Math.floor(envValue)));
  }

  private getStaleAfterPostCooldownMs(): number {
    const envValue = Number(process.env.POLY_V2_STALE_AFTER_POST_COOLDOWN_MS || 4_000);
    if (!Number.isFinite(envValue)) return 4_000;
    return Math.max(1_000, Math.min(30_000, Math.floor(envValue)));
  }

  private getPostRolloverGraceMs(): number {
    const envValue = Number(process.env.POLY_V2_POST_ROLLOVER_GRACE_MS || 6_000);
    if (!Number.isFinite(envValue)) return 6_000;
    return Math.max(0, Math.min(30_000, Math.floor(envValue)));
  }

  private async maybeExecuteDecision(input: {
    tick: Btc5mTick;
    selected: Btc5mSelectedMarket;
    decision: Btc5mDecision;
    allowExecution: boolean;
    attempt?: ExecutionAttempt;
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
    const executionTokenId =
      input.decision.chosenSide === "YES"
        ? input.selected.yesTokenId
        : input.decision.chosenSide === "NO"
          ? input.selected.noTokenId
          : null;
    if (!input.decision.chosenSide || !input.decision.sideAsk || !executionTokenId) {
      return { action: "HOLD", blocker: "TOKEN_NOT_BOOKABLE" };
    }
    if (input.attempt && !this.isExecutionAttemptActive(input.attempt)) {
      return this.abortStaleAttempt(input.attempt, "STALE_BEFORE_PRECHECK");
    }
    const executionGuard = (): boolean => {
      if (!input.attempt) return true;
      return this.isExecutionAttemptActive(input.attempt);
    };

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
    if (!executionGuard()) {
      if (input.attempt) {
        return this.abortStaleAttempt(input.attempt, "STALE_BEFORE_POST");
      }
      return { action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" };
    }

    const result =
      input.decision.chosenSide === "YES"
        ? await this.execution.executeBuyYes({
            marketId: input.selected.marketId,
            tokenId: executionTokenId,
            yesAsk: input.decision.sideAsk,
            notionalUsd,
            tickSize: input.selected.tickSize,
            negRisk: input.selected.negRisk,
            executionGuard
          })
        : await this.execution.executeBuyNo({
            marketId: input.selected.marketId,
            tokenId: executionTokenId,
            noAsk: input.decision.sideAsk,
            notionalUsd,
            tickSize: input.selected.tickSize,
            negRisk: input.selected.negRisk,
            executionGuard
          });
    if (!executionGuard()) {
      if (input.attempt) {
        return this.abortStaleAttempt(input.attempt, "STALE_AFTER_POST");
      }
      return { action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" };
    }
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
    if (
      !selected.orderbookOk ||
      !selected.yesTokenId ||
      !selected.noTokenId ||
      !selected.yesBook.bookable ||
      !selected.noBook.bookable
    ) {
      return { ok: false, reason: "SELECTED_TOKEN_NOT_EXECUTABLE" };
    }
    return { ok: true };
  }

  private logDecision(input: {
    edge: number;
    yesEdge: number;
    noEdge: number;
    pUpModel: number | null;
    intelligenceSource: string;
    intelligencePosture: string | null;
    intelligenceScore: number | null;
    threshold: number;
    spread: number;
    yesSpread: number;
    noSpread: number;
    maxSpread: number;
    remainingSec: number | null;
    minEntryRemainingSec: number;
    oracleAgeMs: number | null;
    blocker: string | null;
    blockerSeverity: "hard" | "warning-only" | null;
    warning: string | null;
    chosenSide: "YES" | "NO" | null;
    action: "BUY_YES" | "BUY_NO" | "HOLD";
  }): void {
    this.logger.warn(
      {
        edge: Number.isFinite(input.edge) ? input.edge : null,
        yesEdge: Number.isFinite(input.yesEdge) ? input.yesEdge : null,
        noEdge: Number.isFinite(input.noEdge) ? input.noEdge : null,
        pUpModel: Number.isFinite(Number(input.pUpModel)) ? Number(input.pUpModel) : null,
        intelligenceSource: input.intelligenceSource,
        intelligencePosture: input.intelligencePosture,
        intelligenceScore: Number.isFinite(Number(input.intelligenceScore)) ? Number(input.intelligenceScore) : null,
        threshold: Number.isFinite(input.threshold) ? input.threshold : null,
        spread: Number.isFinite(input.spread) ? input.spread : null,
        yesSpread: Number.isFinite(input.yesSpread) ? input.yesSpread : null,
        noSpread: Number.isFinite(input.noSpread) ? input.noSpread : null,
        maxSpread: Number.isFinite(input.maxSpread) ? input.maxSpread : null,
        remainingSec: input.remainingSec,
        minEntryRemainingSec: Number.isFinite(input.minEntryRemainingSec) ? input.minEntryRemainingSec : null,
        oracleAgeMs: input.oracleAgeMs,
        blocker: input.blocker,
        blockerSeverity: input.blockerSeverity,
        warning: input.warning,
        chosenSide: input.chosenSide,
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

  private resolveDirectionalIntelligence(input: {
    nowMs: number;
    referencePrice: number | null;
    priceToBeat: number | null;
    fallbackMid: number | null;
  }): Btc5mIntelligence {
    const components: Array<{ name: string; weight: number; score: number; posture: string }> = [];

    if (this.signalsEngine && this.config.signalsEnabled) {
      const aggregate = this.signalsEngine.getLatestAggregate();
      const direction = directionToScore(aggregate.direction);
      const confidence = clampRange(Number(aggregate.confidence || 0), 0, 1);
      const impact = clampRange(Number(aggregate.impact || 0), 0, 1);
      if (aggregate.ts > 0 || aggregate.latestTs > 0 || confidence > 0 || impact > 0) {
        const strength = clampRange(Math.max(0.1, impact) * confidence, 0, 1);
        components.push({
          name: "SIGNALS_ENGINE",
          weight: 0.45,
          score: direction * strength,
          posture: String(aggregate.state || "NORMAL")
        });
      }
    }

    if (this.intelEngine && this.config.enableIntel) {
      const posture = this.intelEngine.getPosture(input.nowMs);
      const direction = directionToScore(posture.direction);
      const confidence = clampRange(Number(posture.confidence || 0), 0, 1);
      const impact = clampRange(Number(posture.impact || 0), 0, 1);
      if (posture.ts > 0 || confidence > 0 || impact > 0) {
        const strength = clampRange(Math.max(0.1, impact) * confidence, 0, 1);
        components.push({
          name: "INTEL_ENGINE",
          weight: 0.35,
          score: direction * strength,
          posture: String(posture.state || "NORMAL")
        });
      }
    }

    const status = this.store?.getBotStatus();
    const signalBias = status?.quoting?.bias;
    const signalBiasConfidence = status?.quoting?.biasConfidence;
    if (signalBias === "LONG" || signalBias === "SHORT" || signalBias === "NEUTRAL") {
      const direction = signalBias === "LONG" ? 1 : signalBias === "SHORT" ? -1 : 0;
      const confidence = clampRange(Number(signalBiasConfidence || 0), 0, 1);
      components.push({
        name: "CROSS_VENUE_BIAS",
        weight: 0.20,
        score: direction * confidence,
        posture: signalBias
      });
    }

    if (components.length === 0) {
      const pUpFallback = inferProbabilityFallback({
        referencePrice: input.referencePrice,
        priceToBeat: input.priceToBeat,
        fallbackMid: input.fallbackMid
      });
      return {
        source: "HEURISTIC_FALLBACK",
        posture: null,
        score: null,
        pUpModel: pUpFallback,
        fallbackUsed: true
      };
    }

    let weighted = 0;
    let weights = 0;
    for (const component of components) {
      weighted += component.score * component.weight;
      weights += component.weight;
    }
    const intelligenceScore = weights > 0 ? clampRange(weighted / weights, -1, 1) : 0;
    const pUpModel = clampRange(0.5 + intelligenceScore * 0.45, 0.0005, 0.9995);
    return {
      source: components.map((row) => row.name).join("+"),
      posture: components.map((row) => row.posture).join("|"),
      score: intelligenceScore,
      pUpModel,
      fallbackUsed: false
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

function isTransientExecutionError(reason: string): boolean {
  const normalized = String(reason || "").toUpperCase();
  return (
    normalized.includes("TIMEOUT") ||
    normalized.includes("NETWORK") ||
    normalized.includes("EPIPE") ||
    normalized.includes("ECONNRESET") ||
    normalized.includes("ECONNREFUSED") ||
    normalized.includes("SOCKET") ||
    normalized.includes("ABORT")
  );
}

function inferProbabilityFallback(input: {
  referencePrice: number | null;
  priceToBeat: number | null;
  fallbackMid: number | null;
}): number {
  if (
    input.referencePrice !== null &&
    input.referencePrice > 0 &&
    input.priceToBeat !== null &&
    input.priceToBeat > 0
  ) {
    const moveRatio = (input.referencePrice - input.priceToBeat) / input.priceToBeat;
    const sigmaRatio = 0.0015;
    const z = clampRange(moveRatio / sigmaRatio, -8, 8);
    return clampRange(normalCdf(z), 0.0005, 0.9995);
  }
  if (input.fallbackMid !== null && input.fallbackMid > 0) {
    return clampRange(input.fallbackMid, 0.0005, 0.9995);
  }
  return 0.5;
}

function directionToScore(direction: string | null | undefined): number {
  const normalized = String(direction || "").trim().toUpperCase();
  if (normalized === "UP") return 1;
  if (normalized === "DOWN") return -1;
  return 0;
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.sqrt(2)));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return sign * y;
}
