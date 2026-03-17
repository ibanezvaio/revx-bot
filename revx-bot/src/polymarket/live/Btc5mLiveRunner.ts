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
import { BTC5M_SELECTOR_REASONS, Btc5mSelector } from "./Btc5mSelector";
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
  entriesInWindow: number;
  exitsInWindow: number;
  realizedPnlUsd: number;
  scalpMode: boolean;
  scalpCycleId: number | null;
  entryReason: string | null;
  exitReason: string | null;
  reentryAllowed: boolean;
  reentryBlockedReason: string | null;
  timeInPositionSec: number | null;
  pUpModel: number | null;
  bestEdge: number | null;
  yesEdge: number | null;
  noEdge: number | null;
  candidatesBeforeFilter: number;
  candidatesAfterFilter: number;
  droppedExtreme: number;
  droppedWideSpread: number;
  droppedInvalid: number;
  selectionVersion: number;
  selectionCommitEpoch: number | null;
  dispatchValidationBucket: string | null;
  dispatchValidationRemainingSec: number | null;
  dispatchEligibilityReason: string | null;
  reselectionTriggered: boolean;
  handoffWaitTriggered: boolean;
};

type RunnerExecutionState = "IDLE" | "ENTRY_PENDING" | "POSITION_OPEN" | "EXIT_PENDING" | "COOLDOWN";

type ExecutionStaleReason = "ROLLOVER" | "SUPERSEDED" | "DEADLINE_EXCEEDED" | "STALE_AFTER_POST" | "MANUAL_STOP";

type RunnerExecutionBlocker =
  | "EXECUTION_IN_FLIGHT"
  | "EXECUTION_COOLDOWN"
  | "ENTRY_ATTEMPT_COOLDOWN"
  | "PROFIT_TAKE_IN_FLIGHT"
  | "MAX_ENTRIES_PER_WINDOW"
  | "MAX_OPEN_ENTRY_ORDERS_PER_WINDOW"
  | "REENTRY_WAIT_CLEAR"
  | "REENTRY_COOLDOWN"
  | "POST_ROLLOVER_GRACE"
  | "STALE_ATTEMPT_ABORTED"
  | "LIVE_PLACED_NO_FILL"
  | "LIVE_EXECUTION_DISABLED";

type ExecutionAttempt = {
  attemptId: string;
  executionSlug: string;
  selectedSlug: string;
  currentSlugAtCreate: string;
  intendedOrderMode: "MARKETABLE_ENTRY" | "RESTING_ENTRY";
  side: "YES" | "NO";
  tokenId: string;
  retryCount: number;
  createdTs: number;
  deadlineTs: number;
  postingStarted: boolean;
  postReturned: boolean;
  awaitingSettlement: boolean;
  tick: Btc5mTick;
  selected: Btc5mSelectedMarket;
  decision: Btc5mDecision;
};

type ProfitTakeAttempt = {
  attemptId: string;
  executionSlug: string;
  marketId: string;
  tokenId: string;
  side: "YES" | "NO";
  shares: number;
  bidPrice: number;
  avgPrice: number;
  exitReason: "TP1" | "TP2" | "TRAIL" | "MAX_HOLD" | "EDGE";
  scalpCycleId: number | null;
  timeInPositionSec: number | null;
  createdTs: number;
};

type WindowEntryState = {
  entries: number;
  exits: number;
  realizedPnlUsd: number;
  cooldownUntilTs: number;
  clearedSinceLastEntry: boolean;
  lastEntryReason: string | null;
  lastExitReason: string | null;
  lastEntryTs: number | null;
  scalpCycleSeq: number;
  activeScalpCycleId: number | null;
};

type PositionScalpState = {
  key: string;
  slug: string;
  marketId: string;
  tokenId: string;
  side: "YES" | "NO";
  entryTs: number;
  bestUnrealizedPnlUsd: number;
  trailArmed: boolean;
  scalpCycleId: number;
};

type ReferenceOracle = {
  price: number | null;
  ageMs: number | null;
  ts: number | null;
  source: string;
};

type DispatchSelectionValidation = {
  tick: Btc5mTick;
  selected: Btc5mSelectedMarket | null;
  dispatchEligibilityReason: string;
  reselectionTriggered: boolean;
  handoffWaitTriggered: boolean;
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
  private executionState: RunnerExecutionState = "IDLE";
  private activeProfitTakeAttempt: ProfitTakeAttempt | null = null;
  private activeProfitTakeTask: Promise<void> | null = null;
  private executionAttemptSeq = 0;
  private executionCooldownUntilTs = 0;
  private entryAttemptCooldownUntilTs = 0;
  private invalidatedAttemptIds = new Set<string>();
  private finalizedAttemptIds = new Set<string>();
  private previousCurrentSlug: string | null = null;
  private lastRolloverTs = 0;
  private lastProfitPollTs = 0;
  private readonly windowEntryStateBySlug = new Map<string, WindowEntryState>();
  private readonly positionScalpStateByKey = new Map<string, PositionScalpState>();
  private selectionVersion = 0;
  private selectionCommitEpochSec: number | null = null;
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
    lastUpdateTs: 0,
    entriesInWindow: 0,
    exitsInWindow: 0,
    realizedPnlUsd: 0,
    scalpMode: false,
    scalpCycleId: null,
    entryReason: null,
    exitReason: null,
    reentryAllowed: true,
    reentryBlockedReason: null,
    timeInPositionSec: null,
    pUpModel: null,
    bestEdge: null,
    yesEdge: null,
    noEdge: null,
    candidatesBeforeFilter: 0,
    candidatesAfterFilter: 0,
    droppedExtreme: 0,
    droppedWideSpread: 0,
    droppedInvalid: 0,
    selectionVersion: 0,
    selectionCommitEpoch: null,
    dispatchValidationBucket: null,
    dispatchValidationRemainingSec: null,
    dispatchEligibilityReason: null,
    reselectionTriggered: false,
    handoffWaitTriggered: false
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
    this.gate = new Btc5mExecutionGate(config, logger);
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
    this.state.entriesInWindow = 0;
    this.state.exitsInWindow = 0;
    this.state.realizedPnlUsd = 0;
    this.state.scalpMode = this.isScalpModeEnabled();
    this.state.scalpCycleId = null;
    this.state.entryReason = null;
    this.state.exitReason = null;
    this.state.reentryAllowed = true;
    this.state.reentryBlockedReason = null;
    this.state.timeInPositionSec = null;
    this.state.pUpModel = null;
    this.state.bestEdge = null;
    this.state.yesEdge = null;
    this.state.noEdge = null;
    this.state.candidatesBeforeFilter = 0;
    this.state.candidatesAfterFilter = 0;
    this.state.droppedExtreme = 0;
    this.state.droppedWideSpread = 0;
    this.state.droppedInvalid = 0;
    this.selectionVersion = 0;
    this.selectionCommitEpochSec = null;
    this.state.selectionVersion = 0;
    this.state.selectionCommitEpoch = null;
    this.state.dispatchValidationBucket = null;
    this.state.dispatchValidationRemainingSec = null;
    this.state.dispatchEligibilityReason = null;
    this.state.reselectionTriggered = false;
    this.state.handoffWaitTriggered = false;
    this.logger.warn(
      {
        minEdgeThresholdConfig: this.config.polymarket.live.minEdgeThreshold,
        maxSpreadConfig: this.config.polymarket.live.maxSpread,
        minEntryRemainingSec: this.config.polymarket.live.minEntryRemainingSec,
        enableNoSide: this.config.polymarket.live.enableNoSide
      },
      "POLY_V2_LIVE_GATE_CONFIG"
    );
    this.transitionExecutionState("IDLE", "RUNNER_START");
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
    this.invalidateExecutionAttempt("MANUAL_STOP", { currentSlug: this.state.currentBucketSlug ?? null });
    this.activeProfitTakeAttempt = null;
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
    this.transitionExecutionState("IDLE", "RUNNER_STOPPED");
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
        maxRemainingSec: this.getLiveEntryMaxRemainingSec()
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
      minEdgeThresholdConfig: this.config.polymarket.live.minEdgeThreshold,
      scalpMode: this.state.scalpMode,
      pUpModel: this.state.pUpModel,
      bestEdge: this.state.bestEdge,
      yesEdge: this.state.yesEdge,
      noEdge: this.state.noEdge,
      candidatesBeforeFilter: this.state.candidatesBeforeFilter,
      candidatesAfterFilter: this.state.candidatesAfterFilter,
      droppedExtreme: this.state.droppedExtreme,
      droppedWideSpread: this.state.droppedWideSpread,
      droppedInvalid: this.state.droppedInvalid,
      selectionVersion: this.state.selectionVersion,
      selectionCommitEpoch: this.state.selectionCommitEpoch,
      dispatchValidationBucket: this.state.dispatchValidationBucket,
      dispatchValidationRemainingSec: this.state.dispatchValidationRemainingSec,
      dispatchEligibilityReason: this.state.dispatchEligibilityReason,
      reselectionTriggered: this.state.reselectionTriggered,
      handoffWaitTriggered: this.state.handoffWaitTriggered,
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
      entriesInWindow: this.state.entriesInWindow,
      exitsInWindow: this.state.exitsInWindow,
      realizedPnlWindowUsd: this.state.realizedPnlUsd,
      entryReason: this.state.entryReason,
      exitReason: this.state.exitReason,
      reentryAllowed: this.state.reentryAllowed,
      reentryBlockedReason: this.state.reentryBlockedReason,
      timeInPositionSec: this.state.timeInPositionSec,
      scalpCycleId: this.state.scalpCycleId,
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
        finalCandidatesCount: this.state.candidatesAfterFilter,
        discoveredCandidatesCount: this.state.candidatesBeforeFilter,
        windowsCount: this.state.candidatesAfterFilter,
        selectedSlug: this.state.selectedSlug,
        selectedMarketId: null,
        selectionVersion: this.state.selectionVersion,
        selectionCommitEpoch: this.state.selectionCommitEpoch,
        dispatchValidationBucket: this.state.dispatchValidationBucket,
        dispatchValidationRemainingSec: this.state.dispatchValidationRemainingSec,
        dispatchEligibilityReason: this.state.dispatchEligibilityReason,
        reselectionTriggered: this.state.reselectionTriggered,
        handoffWaitTriggered: this.state.handoffWaitTriggered,
        windowStartTs: this.state.currentBucketStartSec !== null ? this.state.currentBucketStartSec * 1000 : null,
        windowEndTs:
          this.state.currentBucketStartSec !== null ? (this.state.currentBucketStartSec + 300) * 1000 : null,
        remainingSec: this.state.remainingSec,
        chosenSide: this.state.chosenSide,
        chosenDirection: this.state.chosenDirection,
        entriesInWindow: this.state.entriesInWindow,
        exitsInWindow: this.state.exitsInWindow,
        realizedPnlUsd: this.state.realizedPnlUsd,
        realizedPnlWindowUsd: this.state.realizedPnlUsd,
        scalpMode: this.state.scalpMode,
        scalpCycleId: this.state.scalpCycleId,
        entryReason: this.state.entryReason,
        exitReason: this.state.exitReason,
        reentryAllowed: this.state.reentryAllowed,
        reentryBlockedReason: this.state.reentryBlockedReason,
        timeInPositionSec: this.state.timeInPositionSec,
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
    while (!this.stopRequested) {
      await this.processCycle(true);
      await sleep(this.getDecisionLoopMs());
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
    this.state.dispatchValidationBucket = tick.currentSlug;
    this.state.dispatchValidationRemainingSec = tick.remainingSec;
    this.state.dispatchEligibilityReason = null;
    this.state.reselectionTriggered = false;
    this.state.handoffWaitTriggered = false;
    this.state.scalpMode = this.isScalpModeEnabled();
    this.state.reentryAllowed = true;
    this.state.reentryBlockedReason = null;
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
      this.invalidateSelectionCommit("ROLLOVER");
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
      this.state.pUpModel = null;
      this.state.bestEdge = null;
      this.state.yesEdge = null;
      this.state.noEdge = null;
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
      this.refreshExecutionState(null);
      return;
    }

    if (this.state.warningState === "DISCOVERY_STALE") {
      this.invalidateSelectionCommit("DISCOVERY_STALE");
    }
    const reference = this.getReferencePrice(tick.tickNowMs);
    this.logger.warn(
      {
        source: reference.source,
        ts: reference.ts,
        ageMs: reference.ageMs,
        staleThresholdMs: this.config.polymarket.live.oracleHardBlockMs,
        warnThresholdMs: this.config.polymarket.live.oracleWarnMs
      },
      "POLY_V2_ORACLE_STATUS"
    );
    const selectionResult = await this.selector.select({
      tick
    });
    const selected = selectionResult.selected;
    const selectionReason = String(selectionResult.reason || BTC5M_SELECTOR_REASONS.NO_CANDIDATE_MARKETS);
    this.state.candidatesBeforeFilter = Math.max(0, Math.floor(Number(selectionResult.candidatesBeforeFilter || 0)));
    this.state.candidatesAfterFilter = Math.max(0, Math.floor(Number(selectionResult.candidatesAfterFilter || 0)));
    this.state.droppedExtreme = Math.max(0, Math.floor(Number(selectionResult.droppedExtreme || 0)));
    this.state.droppedWideSpread = Math.max(0, Math.floor(Number(selectionResult.droppedWideSpread || 0)));
    this.state.droppedInvalid = Math.max(0, Math.floor(Number(selectionResult.droppedInvalid || 0)));
    const networkFailure = selectionReason === BTC5M_SELECTOR_REASONS.NETWORK_ERROR;
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
        marketId: selected?.marketId ?? null,
        yesTokenId: selected?.yesTokenId ?? null,
        noTokenId: selected?.noTokenId ?? null,
        reason: selectionReason,
        remainingSec: selected?.remainingSec ?? tick.remainingSec,
        attemptedSlugs: selectionResult.attemptedSlugs ?? [],
        candidatesBeforeFilter: this.state.candidatesBeforeFilter,
        candidatesAfterFilter: this.state.candidatesAfterFilter,
        droppedExtreme: this.state.droppedExtreme,
        droppedWideSpread: this.state.droppedWideSpread,
        droppedInvalid: this.state.droppedInvalid,
        selectionVersion: this.selectionVersion
      },
      "POLY_V2_SELECTOR_RESULT"
    );

    if (!selected) {
      const blocker = selectionReason;
      this.invalidateSelectionCommit(blocker);
      this.state.selectedSlug = null;
      this.state.selectedTokenId = null;
      this.state.chosenSide = null;
      this.state.chosenDirection = null;
      this.state.entriesInWindow = 0;
      this.state.exitsInWindow = 0;
      this.state.realizedPnlUsd = 0;
      this.state.scalpCycleId = null;
      this.state.entryReason = null;
      this.state.exitReason = null;
      this.state.timeInPositionSec = null;
      this.state.reentryAllowed = false;
      this.state.reentryBlockedReason = blocker;
      this.applyHoldReason({
        reason: blocker,
        tick,
        selectedSlug: null
      });
      this.state.warningState = blocker === BTC5M_SELECTOR_REASONS.NO_CANDIDATE_MARKETS ? null : blocker;
      this.state.pUpModel = null;
      this.state.bestEdge = null;
      this.state.yesEdge = null;
      this.state.noEdge = null;
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
      this.refreshExecutionState(null);
      return;
    }

    const selectedInvariant = this.validateSelectionInvariant(tick, selected);
    if (!selectedInvariant.ok) {
      this.invalidateSelectionCommit(selectedInvariant.reason);
      this.state.selectedSlug = selected.slug;
      this.state.selectedTokenId = null;
      this.state.chosenSide = null;
      this.state.chosenDirection = null;
      this.state.entriesInWindow = 0;
      this.state.exitsInWindow = 0;
      this.state.realizedPnlUsd = 0;
      this.state.scalpCycleId = null;
      this.state.entryReason = null;
      this.state.exitReason = null;
      this.state.timeInPositionSec = null;
      this.state.reentryAllowed = false;
      this.state.reentryBlockedReason = selectedInvariant.reason;
      this.state.action = "HOLD";
      this.state.holdReason = selectedInvariant.reason;
      this.state.blockedBy = selectedInvariant.reason;
      this.state.warningState = "INVARIANT";
      this.state.pUpModel = null;
      this.state.bestEdge = null;
      this.state.yesEdge = null;
      this.state.noEdge = null;
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
      this.refreshExecutionState(null);
      return;
    }
    const dispatchValidationStartVersion = this.selectionVersion;
    let dispatchValidation = await this.validateSelectionForDispatch({
      selected,
      tick,
      expectedSelectionVersion: dispatchValidationStartVersion
    });
    if (
      this.selectionVersion !== dispatchValidationStartVersion &&
      dispatchValidation.dispatchEligibilityReason === "ELIGIBLE_CURRENT"
    ) {
      dispatchValidation = {
        ...dispatchValidation,
        dispatchEligibilityReason: "SELECTION_VERSION_MISMATCH",
        handoffWaitTriggered: true
      };
    }
    this.state.dispatchValidationBucket = dispatchValidation.tick.currentSlug;
    this.state.dispatchValidationRemainingSec = dispatchValidation.tick.remainingSec;
    this.state.dispatchEligibilityReason = dispatchValidation.dispatchEligibilityReason;
    this.state.reselectionTriggered = dispatchValidation.reselectionTriggered;
    this.state.handoffWaitTriggered = dispatchValidation.handoffWaitTriggered;

    if (dispatchValidation.dispatchEligibilityReason !== "ELIGIBLE_CURRENT" || !dispatchValidation.selected) {
      const holdTick = dispatchValidation.tick;
      const holdSelected = dispatchValidation.selected;
      const normalizedDispatchHoldReason = this.normalizeDispatchHoldReason(dispatchValidation.dispatchEligibilityReason);
      this.state.selectedSlug = holdSelected?.slug ?? null;
      this.state.selectedTokenId = null;
      this.state.chosenSide = null;
      this.state.chosenDirection = null;
      const holdWindowState = holdSelected ? this.getWindowEntryState(holdSelected.slug) : null;
      this.state.entriesInWindow = holdWindowState?.entries ?? 0;
      this.state.exitsInWindow = holdWindowState?.exits ?? 0;
      this.state.realizedPnlUsd = holdWindowState?.realizedPnlUsd ?? 0;
      this.state.scalpCycleId = holdWindowState?.activeScalpCycleId ?? null;
      this.state.entryReason = holdWindowState?.lastEntryReason ?? null;
      this.state.exitReason = holdWindowState?.lastExitReason ?? null;
      this.state.timeInPositionSec = holdSelected ? this.getTimeInPositionSec(holdSelected.marketId, holdTick.tickNowMs) : null;
      this.state.reentryAllowed = false;
      this.state.reentryBlockedReason = normalizedDispatchHoldReason;
      this.state.pUpModel = null;
      this.state.bestEdge = null;
      this.state.yesEdge = null;
      this.state.noEdge = null;
      this.logger.warn(
        {
          action: "HOLD",
          chosenSide: null,
          tokenId: null,
          blocker: normalizedDispatchHoldReason,
          edge: null,
          remainingSec: holdTick.remainingSec,
          selectionVersion: this.selectionVersion,
          dispatchValidationBucket: this.state.dispatchValidationBucket,
          dispatchValidationRemainingSec: this.state.dispatchValidationRemainingSec,
          dispatchEligibilityReason: this.state.dispatchEligibilityReason,
          reselectionTriggered: this.state.reselectionTriggered,
          handoffWaitTriggered: this.state.handoffWaitTriggered
        },
        "POLY_V2_ACTION_DISPATCH"
      );
      this.applyHoldReason({
        reason: normalizedDispatchHoldReason,
        tick: holdTick,
        selectedSlug: holdSelected?.slug ?? null
      });
      this.state.warningState = normalizedDispatchHoldReason;
      this.state.lastDecisionTs = holdTick.tickNowMs;
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
        yesSpread: holdSelected ? Number(holdSelected.yesBook.spread) : Number.NaN,
        noSpread: holdSelected ? Number(holdSelected.noBook.spread) : Number.NaN,
        maxSpread: this.config.polymarket.live.maxSpread,
        remainingSec: holdTick.remainingSec,
        minEntryRemainingSec: this.config.polymarket.live.minEntryRemainingSec,
        oracleAgeMs: reference.ageMs,
        blocker: normalizedDispatchHoldReason,
        blockerSeverity: "hard",
        warning: null,
        chosenSide: null,
        action: "HOLD"
      });
      this.pushRecentTick({
        tickNowSec: holdTick.tickNowSec,
        selectedSlug: holdSelected?.slug ?? null,
        action: "HOLD",
        blocker: normalizedDispatchHoldReason
      });
      this.refreshExecutionState(holdSelected ?? null);
      return;
    }

    const tickForCycle = dispatchValidation.tick;
    const selectedForCycle = dispatchValidation.selected;

    this.syncWindowEntryState(selectedForCycle.slug, selectedForCycle.marketId, tickForCycle.tickNowMs);
    if (this.activeExecutionAttempt && this.activeExecutionAttempt.executionSlug !== selectedForCycle.slug) {
      this.invalidateExecutionAttempt("SUPERSEDED", {
        currentSlug: tickForCycle.currentSlug,
        selectedSlug: selectedForCycle.slug
      });
    }

    const intelligence = this.resolveDirectionalIntelligence({
      nowMs: tickForCycle.tickNowMs,
      referencePrice: reference.price,
      priceToBeat: selectedForCycle.priceToBeat,
      fallbackMid: selectedForCycle.yesBook.mid
    });
    if (intelligence.fallbackUsed) {
      this.logger.warn(
        {
          source: intelligence.source,
          pUpModel: intelligence.pUpModel,
          referencePrice: reference.price,
          priceToBeat: selectedForCycle.priceToBeat
        },
        "POLY_V2_INTEL_FALLBACK"
      );
    }

    const decision = this.gate.evaluate({
      tick: tickForCycle,
      selected: selectedForCycle,
      intelligence,
      oracleAgeMs: reference.ageMs
    });
    this.logger.warn(
      {
        minEdgeThresholdConfig: this.config.polymarket.live.minEdgeThreshold,
        maxSpreadConfig: this.config.polymarket.live.maxSpread,
        yesSpread: Number.isFinite(decision.yesSpread) ? decision.yesSpread : null,
        noSpread: Number.isFinite(decision.noSpread) ? decision.noSpread : null,
        yesAsk: selectedForCycle.yesBook.bestAsk,
        noAsk: selectedForCycle.noBook.bestAsk,
        pUpModel: Number.isFinite(Number(decision.pUpModel)) ? Number(decision.pUpModel) : null,
        yesEdge: Number.isFinite(decision.yesEdge) ? decision.yesEdge : null,
        noEdge: Number.isFinite(decision.noEdge) ? decision.noEdge : null,
        chosenBlocker: decision.blocker
      },
      "POLY_V2_GATE_INPUTS"
    );
    const profitTakeDispatch = await this.maybeDispatchProfitTake({
      tick: tickForCycle,
      selected: selectedForCycle,
      allowExecution
    });
    const executionDispatch = profitTakeDispatch
      ? { action: "HOLD" as const, blocker: profitTakeDispatch }
      : await this.dispatchExecutionAttempt({
          tick: tickForCycle,
          selected: selectedForCycle,
          decision,
          allowExecution
        });

    const finalAction = executionDispatch.action;
    const finalBlocker = executionDispatch.blocker;
    const chosenSide = decision.chosenSide;
    const dispatchTokenId =
      chosenSide === "YES" ? selectedForCycle.yesTokenId : chosenSide === "NO" ? selectedForCycle.noTokenId : null;
    this.logger.warn(
      {
        action: finalAction,
        chosenSide,
        tokenId: dispatchTokenId,
        blocker: finalBlocker,
        edge: Number.isFinite(decision.edge) ? decision.edge : null,
        remainingSec: decision.remainingSec,
        selectionVersion: this.selectionVersion,
        dispatchValidationBucket: this.state.dispatchValidationBucket,
        dispatchValidationRemainingSec: this.state.dispatchValidationRemainingSec,
        dispatchEligibilityReason: this.state.dispatchEligibilityReason,
        reselectionTriggered: this.state.reselectionTriggered,
        handoffWaitTriggered: this.state.handoffWaitTriggered
      },
      "POLY_V2_ACTION_DISPATCH"
    );
    this.logDecisionBreakdown({
      intelligence,
      decision,
      selected: selectedForCycle,
      tick: tickForCycle,
      finalChosenSide: chosenSide,
      finalAction
    });
    const selectedTokenId =
      chosenSide === "YES" ? selectedForCycle.yesTokenId : chosenSide === "NO" ? selectedForCycle.noTokenId : null;
    const windowState = this.getWindowEntryState(selectedForCycle.slug);
    this.commitSelectionVersion(selectedForCycle.slug, tickForCycle.currentBucketStartSec);
    this.state.selectedSlug = selectedForCycle.slug;
    this.state.selectedTokenId = selectedTokenId;
    this.state.chosenSide = chosenSide;
    this.state.chosenDirection = chosenSide ? chosenDirectionForSide(chosenSide) : null;
    this.state.entriesInWindow = windowState.entries;
    this.state.exitsInWindow = windowState.exits;
    this.state.realizedPnlUsd = windowState.realizedPnlUsd;
    this.state.scalpCycleId = windowState.activeScalpCycleId;
    this.state.entryReason = windowState.lastEntryReason;
    this.state.exitReason = windowState.lastExitReason;
    this.state.timeInPositionSec = this.getTimeInPositionSec(selectedForCycle.marketId, tickForCycle.tickNowMs);
    this.state.pUpModel = Number.isFinite(Number(decision.pUpModel)) ? Number(decision.pUpModel) : null;
    this.state.bestEdge = Number.isFinite(decision.edge) ? decision.edge : null;
    this.state.yesEdge = Number.isFinite(decision.yesEdge) ? decision.yesEdge : null;
    this.state.noEdge = Number.isFinite(decision.noEdge) ? decision.noEdge : null;
    if (finalAction === "HOLD") {
      this.applyHoldReason({
        reason: finalBlocker || "HOLD",
        tick: tickForCycle,
        selectedSlug: selectedForCycle.slug
      });
    } else {
      this.state.action = finalAction;
      this.state.holdReason = null;
      this.state.blockedBy = null;
    }
    this.state.warningState = finalAction === "HOLD" ? finalBlocker : decision.warning;
    this.state.lastDecisionTs = tickForCycle.tickNowMs;

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
      tickNowSec: tickForCycle.tickNowSec,
      selectedSlug: selectedForCycle.slug,
      selectedTokenId,
      side: chosenSide,
      action: finalAction,
      blocker: finalBlocker
    });
    this.refreshExecutionState(selectedForCycle);
  }

  private async dispatchExecutionAttempt(input: {
    tick: Btc5mTick;
    selected: Btc5mSelectedMarket;
    decision: Btc5mDecision;
    allowExecution: boolean;
  }): Promise<{ action: "BUY_YES" | "BUY_NO" | "HOLD"; blocker: string | RunnerExecutionBlocker | null }> {
    this.setReentryStatus(true, null);
    if (input.decision.action === "HOLD") {
      return { action: "HOLD", blocker: input.decision.blocker || "HOLD" };
    }
    if (!input.allowExecution) {
      return { action: input.decision.action, blocker: null };
    }
    if (!this.canMutateVenueState()) {
      return { action: "HOLD", blocker: "LIVE_EXECUTION_DISABLED" };
    }
    if (!this.isSelectedBookExecutable(input.selected)) {
      return { action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" };
    }
    if (input.tick.remainingSec <= 0) {
      return { action: "HOLD", blocker: "PREORDER_STALE_MARKET_SELECTION" };
    }
    if (Date.now() < this.executionCooldownUntilTs) {
      return { action: "HOLD", blocker: "EXECUTION_COOLDOWN" };
    }
    if (Date.now() < this.entryAttemptCooldownUntilTs) {
      return { action: "HOLD", blocker: "ENTRY_ATTEMPT_COOLDOWN" };
    }
    if (this.activeProfitTakeAttempt) {
      return { action: "HOLD", blocker: "PROFIT_TAKE_IN_FLIGHT" };
    }

    const tokenId =
      input.decision.chosenSide === "YES"
        ? input.selected.yesTokenId
        : input.decision.chosenSide === "NO"
          ? input.selected.noTokenId
          : null;
    const intendedOrderMode = this.getEntryOrderMode();
    if (!input.decision.chosenSide || !tokenId) {
      return { action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" };
    }
    if (
      input.decision.oracleAgeMs !== null &&
      Number.isFinite(input.decision.oracleAgeMs) &&
      input.decision.oracleAgeMs > input.decision.oracleHardBlockMs
    ) {
      return { action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" };
    }
    const sideBookAvailable = await this.verifySideBookAvailableForExecution({
      slug: input.selected.slug,
      side: input.decision.chosenSide,
      tokenId
    });
    if (!sideBookAvailable) {
      return { action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" };
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
      return { action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" };
    }
    const windowState = this.getWindowEntryState(input.selected.slug);
    const maxEntriesPerWindow = this.getMaxEntriesPerWindow();
    const maxOpenEntryOrdersPerWindow = this.getMaxOpenEntryOrdersPerWindow();
    if (windowState.entries >= maxEntriesPerWindow) {
      this.setReentryStatus(false, "MAX_ENTRIES_PER_WINDOW");
      this.logger.warn(
        {
          selectedSlug: input.selected.slug,
          currentSlug: input.tick.currentSlug,
          entriesInWindow: windowState.entries,
          maxEntriesPerWindow,
          hasActiveAttempt: Boolean(this.activeExecutionAttempt),
          reason: "MAX_ENTRIES_PER_WINDOW",
          scalpMode: this.isScalpModeEnabled()
        },
        "POLY_V2_REENTRY_EVAL"
      );
      return { action: "HOLD", blocker: "MAX_ENTRIES_PER_WINDOW" };
    }

    const hasPositionForMarket = this.hasOpenPositionForMarket(input.selected.marketId);
    if (hasPositionForMarket) {
      this.setReentryStatus(false, "REENTRY_WAIT_CLEAR");
      this.logger.warn(
        {
          selectedSlug: input.selected.slug,
          currentSlug: input.tick.currentSlug,
          entriesInWindow: windowState.entries,
          maxEntriesPerWindow,
          hasActiveAttempt: Boolean(this.activeExecutionAttempt),
          reason: "REENTRY_WAIT_CLEAR"
        },
        "POLY_V2_REENTRY_EVAL"
      );
      return { action: "HOLD", blocker: "REENTRY_WAIT_CLEAR" };
    }
    if (windowState.entries > 0 && !hasPositionForMarket) {
      if (!windowState.clearedSinceLastEntry) {
        this.setReentryStatus(false, "REENTRY_WAIT_CLEAR");
        this.logger.warn(
          {
            selectedSlug: input.selected.slug,
            currentSlug: input.tick.currentSlug,
            entriesInWindow: windowState.entries,
            maxEntriesPerWindow,
            hasActiveAttempt: Boolean(this.activeExecutionAttempt),
            reason: "REENTRY_WAIT_CLEAR"
          },
          "POLY_V2_REENTRY_EVAL"
        );
        return { action: "HOLD", blocker: "REENTRY_WAIT_CLEAR" };
      }
      if (Date.now() < windowState.cooldownUntilTs) {
        this.setReentryStatus(false, "REENTRY_COOLDOWN");
        this.logger.warn(
          {
            selectedSlug: input.selected.slug,
            currentSlug: input.tick.currentSlug,
            entriesInWindow: windowState.entries,
            maxEntriesPerWindow,
            cooldownUntilTs: windowState.cooldownUntilTs,
            hasActiveAttempt: Boolean(this.activeExecutionAttempt),
            reason: "REENTRY_COOLDOWN"
          },
          "POLY_V2_REENTRY_EVAL"
        );
        return { action: "HOLD", blocker: "REENTRY_COOLDOWN" };
      }
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
      if (active.postingStarted) {
        const activeAgeMs = Date.now() - active.createdTs;
        const staleByAge = activeAgeMs >= this.getUnfilledEntryMaxAgeMs();
        const staleByRollover = active.executionSlug !== input.tick.currentSlug;
        const staleBySuperseded = active.executionSlug !== input.selected.slug;
        const staleBySettlement = active.awaitingSettlement;
        const shouldClear =
          staleByAge || staleByRollover || staleBySuperseded || staleBySettlement || active.postReturned;
        if (shouldClear) {
          const staleReason: ExecutionStaleReason = staleByRollover
            ? "ROLLOVER"
            : staleBySuperseded
              ? "SUPERSEDED"
              : "STALE_AFTER_POST";
          void this.cleanupExecutionAttempt(active, {
            reason: staleReason,
            blocker: "STALE_ATTEMPT_ABORTED",
            cooldownMs: staleReason === "STALE_AFTER_POST" ? this.getStaleAfterPostCooldownMs() : this.getExecutionCooldownMs(),
            cancelUnfilled: true,
            reentryEligible: this.getReentryAfterUnfilledEnabled(),
            finalState: "STALE_ABORTED"
          });
          return { action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" };
        } else {
          return { action: "HOLD", blocker: "EXECUTION_IN_FLIGHT" };
        }
      }
      const sameAttemptTarget =
        active.executionSlug === input.selected.slug && active.side === input.decision.chosenSide && active.tokenId === tokenId;
      if (sameAttemptTarget) {
        return { action: "HOLD", blocker: "EXECUTION_IN_FLIGHT" };
      }
      this.invalidateExecutionAttempt("SUPERSEDED", {
        currentSlug: input.tick.currentSlug,
        selectedSlug: input.selected.slug
      });
      return { action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" };
    }
    const openEntryOrdersForMarket = this.execution.countOpenEntryOrdersForMarket(input.selected.marketId);
    if (openEntryOrdersForMarket >= maxOpenEntryOrdersPerWindow) {
      this.setReentryStatus(false, "MAX_OPEN_ENTRY_ORDERS_PER_WINDOW");
      return { action: "HOLD", blocker: "MAX_OPEN_ENTRY_ORDERS_PER_WINDOW" };
    }
    this.setReentryStatus(true, null);

    const attempt: ExecutionAttempt = {
      attemptId: `att-${++this.executionAttemptSeq}`,
      executionSlug: input.selected.slug,
      selectedSlug: input.selected.slug,
      currentSlugAtCreate: input.tick.currentSlug,
      intendedOrderMode,
      side: input.decision.chosenSide,
      tokenId,
      retryCount: 0,
      createdTs: Date.now(),
      deadlineTs: Date.now() + this.getExecutionDeadlineMs(),
      postingStarted: false,
      postReturned: false,
      awaitingSettlement: false,
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
        intendedOrderMode,
        entriesInWindow: windowState.entries,
        maxEntriesPerWindow,
        scalpMode: this.isScalpModeEnabled(),
        reason: "CREATED"
      },
      "POLY_V2_EXECUTION_ATTEMPT_CREATED"
    );
    this.logExecutionAttemptLifecycle(attempt, "created");
    this.entryAttemptCooldownUntilTs = Date.now() + this.getEntryAttemptCooldownMs();
    this.transitionExecutionState("ENTRY_PENDING", "ENTRY_ATTEMPT_CREATED", {
      attemptId: attempt.attemptId,
      slug: attempt.executionSlug,
      tokenId: attempt.tokenId
    });
    this.startExecutionAttempt(attempt);
    return { action: input.decision.action, blocker: null };
  }

  private startExecutionAttempt(attempt: ExecutionAttempt): void {
    let task: Promise<void> | null = null;
    task = (async () => {
      let finalState = "CLOSED";
      let finalBlocker: string | null = null;
      let finalizedByCleanup = false;
      try {
        if (!this.isExecutionAttemptActive(attempt)) {
          await this.cleanupExecutionAttempt(attempt, {
            reason: "SUPERSEDED",
            blocker: "STALE_ATTEMPT_ABORTED",
            cooldownMs: this.getExecutionCooldownMs(),
            cancelUnfilled: false,
            reentryEligible: this.getReentryAfterUnfilledEnabled(),
            finalState: "STALE_ABORTED"
          });
          finalState = "STALE_ABORTED";
          finalBlocker = "STALE_ATTEMPT_ABORTED";
          finalizedByCleanup = true;
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
          this.logExecutionAttemptLifecycle(attempt, "deadline_exceeded", {
            postingStarted: attempt.postingStarted,
            postReturned: attempt.postReturned
          });
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
          await this.cleanupExecutionAttempt(attempt, {
            reason: "DEADLINE_EXCEEDED",
            blocker: "STALE_ATTEMPT_ABORTED",
            cooldownMs: this.getExecutionCooldownMs(),
            cancelUnfilled: attempt.postingStarted || attempt.postReturned,
            reentryEligible: this.getReentryAfterUnfilledEnabled(),
            finalState: "DEADLINE_EXCEEDED"
          });
          finalState = "DEADLINE_EXCEEDED";
          finalBlocker = "STALE_ATTEMPT_ABORTED";
          finalizedByCleanup = true;
          return;
        }

        if (!this.isExecutionAttemptActive(attempt)) {
          await this.cleanupExecutionAttempt(attempt, {
            reason: "SUPERSEDED",
            blocker: "STALE_ATTEMPT_ABORTED",
            cooldownMs: this.getExecutionCooldownMs(),
            cancelUnfilled: attempt.postingStarted || attempt.postReturned,
            reentryEligible: this.getReentryAfterUnfilledEnabled(),
            finalState: "STALE_ABORTED"
          });
          finalState = "STALE_ABORTED";
          finalBlocker = "STALE_ATTEMPT_ABORTED";
          finalizedByCleanup = true;
          return;
        }

        if (raceResult.action === "HOLD" && raceResult.blocker) {
          if (raceResult.blocker === "LIVE_PLACED_NO_FILL") {
            await this.cleanupExecutionAttempt(attempt, {
              reason: "STALE_AFTER_POST",
              blocker: "LIVE_PLACED_NO_FILL",
              cooldownMs: this.getExecutionCooldownMs(),
              cancelUnfilled: true,
              reentryEligible: this.getReentryAfterUnfilledEnabled(),
              finalState: "NO_FILL"
            });
            finalState = "NO_FILL";
            finalBlocker = "LIVE_PLACED_NO_FILL";
            finalizedByCleanup = true;
            return;
          }
          if (raceResult.blocker === "STALE_ATTEMPT_ABORTED") {
            await this.cleanupExecutionAttempt(attempt, {
              reason: "STALE_AFTER_POST",
              blocker: "STALE_ATTEMPT_ABORTED",
              cooldownMs: this.getStaleAfterPostCooldownMs(),
              cancelUnfilled: attempt.postingStarted || attempt.postReturned,
              reentryEligible: this.getReentryAfterUnfilledEnabled(),
              finalState: "STALE_ABORTED"
            });
            finalState = "STALE_ABORTED";
            finalBlocker = "STALE_ATTEMPT_ABORTED";
            finalizedByCleanup = true;
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
          finalBlocker = raceResult.blocker;
          finalState = "ABORTED";
        }
        if (raceResult.action === "BUY_YES" || raceResult.action === "BUY_NO") {
          this.recordWindowEntry({
            slug: attempt.executionSlug,
            marketId: attempt.selected.marketId,
            tokenId: attempt.tokenId,
            side: attempt.side,
            reason: "SCALP_ENTRY_SIGNAL",
            nowMs: Date.now()
          });
          finalState = "ENTRY_ACCEPTED";
          finalBlocker = null;
        }
        this.logExecutionAttemptLifecycle(attempt, "reconcile_result", {
          action: raceResult.action,
          blocker: raceResult.blocker
        });
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
        await this.cleanupExecutionAttempt(attempt, {
          reason: "STALE_AFTER_POST",
          blocker: "STALE_ATTEMPT_ABORTED",
          cooldownMs: this.getExecutionCooldownMs(),
          cancelUnfilled: attempt.postingStarted || attempt.postReturned,
          reentryEligible: this.getReentryAfterUnfilledEnabled(),
          finalState: "ABORTED"
        });
        finalState = "ABORTED";
        finalBlocker = "STALE_ATTEMPT_ABORTED";
        finalizedByCleanup = true;
      } finally {
        this.logExecutionAttemptLifecycle(attempt, "closed", {
          postingStarted: attempt.postingStarted,
          postReturned: attempt.postReturned,
          awaitingSettlement: attempt.awaitingSettlement
        });
        if (!finalizedByCleanup && !this.finalizedAttemptIds.has(attempt.attemptId)) {
          this.finalizedAttemptIds.add(attempt.attemptId);
          this.logger.warn(
            {
              attemptId: attempt.attemptId,
              finalState,
              blocker: finalBlocker,
              filledShares: null,
              orderId: null
            },
            "POLY_V2_ATTEMPT_FINALIZED"
          );
        }
        if (this.activeExecutionAttempt?.attemptId === attempt.attemptId) {
          this.activeExecutionAttempt = null;
        }
        if (this.activeExecutionTask === task) {
          this.activeExecutionTask = null;
        }
        this.refreshExecutionState(attempt.selected);
      }
    })();
    this.activeExecutionTask = task;
  }

  private invalidateExecutionAttempt(
    reason: ExecutionStaleReason,
    context: { currentSlug: string | null; selectedSlug?: string | null }
  ): void {
    const attempt = this.activeExecutionAttempt;
    if (!attempt) return;
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
    void this.cleanupExecutionAttempt(attempt, {
      reason,
      blocker: "STALE_ATTEMPT_ABORTED",
      cooldownMs: reason === "STALE_AFTER_POST" ? this.getStaleAfterPostCooldownMs() : this.getExecutionCooldownMs(),
      cancelUnfilled: attempt.postingStarted || attempt.postReturned,
      reentryEligible: this.getReentryAfterUnfilledEnabled() && reason !== "MANUAL_STOP",
      finalState: "STALE_ABORTED"
    });
  }

  private async cancelUnfilledOrdersForAttempt(
    attempt: ExecutionAttempt,
    reason: string
  ): Promise<{ requestedCount: number; cancelledCount: number }> {
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
      "POLY_V2_UNFILLED_ORDER_CANCEL_REQUEST"
    );
    try {
      const result = await this.execution.cancelUnfilledEntryOrders({
        marketId: attempt.selected.marketId,
        tokenId: attempt.tokenId,
        maxAgeMs: 0,
        reason
      });
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
          requestedCount: result.requestedCount,
          cancelledCount: result.cancelledCount
        },
        "POLY_V2_UNFILLED_ORDER_CANCELLED"
      );
      return {
        requestedCount: Number(result.requestedCount || 0),
        cancelledCount: Number(result.cancelledCount || 0)
      };
    } catch (error) {
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
          error: shortError(error)
        },
        "POLY_V2_UNFILLED_ORDER_CANCELLED"
      );
      return { requestedCount: 0, cancelledCount: 0 };
    }
  }

  private logReentryEligible(attempt: ExecutionAttempt, reason: string): void {
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
      "POLY_V2_REENTRY_ELIGIBLE"
    );
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

  private transitionExecutionState(
    to: RunnerExecutionState,
    reason: string,
    ctx: { attemptId?: string | null; slug?: string | null; tokenId?: string | null } = {}
  ): void {
    const from = this.executionState;
    if (from === to) return;
    this.executionState = to;
    this.logger.warn(
      {
        from,
        to,
        reason,
        attemptId: ctx.attemptId ?? null,
        slug: ctx.slug ?? null,
        tokenId: ctx.tokenId ?? null
      },
      "POLY_V2_STATE_TRANSITION"
    );
  }

  private refreshExecutionState(selected: Btc5mSelectedMarket | null): void {
    const now = Date.now();
    if (this.activeProfitTakeAttempt) {
      this.transitionExecutionState("EXIT_PENDING", "PROFIT_TAKE_ACTIVE", {
        attemptId: this.activeProfitTakeAttempt.attemptId,
        slug: this.activeProfitTakeAttempt.executionSlug,
        tokenId: this.activeProfitTakeAttempt.tokenId
      });
      return;
    }
    if (this.activeExecutionAttempt && this.isExecutionAttemptActive(this.activeExecutionAttempt)) {
      this.transitionExecutionState("ENTRY_PENDING", "ENTRY_ATTEMPT_ACTIVE", {
        attemptId: this.activeExecutionAttempt.attemptId,
        slug: this.activeExecutionAttempt.executionSlug,
        tokenId: this.activeExecutionAttempt.tokenId
      });
      return;
    }
    if (now < this.executionCooldownUntilTs || now < this.entryAttemptCooldownUntilTs) {
      this.transitionExecutionState("COOLDOWN", "EXECUTION_COOLDOWN_ACTIVE");
      return;
    }
    if (selected && this.hasOpenPositionForMarket(selected.marketId)) {
      this.transitionExecutionState("POSITION_OPEN", "OPEN_POSITION_PRESENT", {
        slug: selected.slug
      });
      return;
    }
    this.transitionExecutionState("IDLE", "NO_ACTIVE_ATTEMPTS");
  }

  private staleReasonFromToken(reason: string): ExecutionStaleReason {
    const normalized = String(reason || "").trim().toUpperCase();
    if (normalized.includes("ROLLOVER")) return "ROLLOVER";
    if (normalized.includes("SUPERSEDED")) return "SUPERSEDED";
    if (normalized.includes("DEADLINE")) return "DEADLINE_EXCEEDED";
    if (normalized.includes("MANUAL_STOP")) return "MANUAL_STOP";
    return "STALE_AFTER_POST";
  }

  private async cleanupExecutionAttempt(
    attempt: ExecutionAttempt,
    input: {
      reason: ExecutionStaleReason;
      blocker: RunnerExecutionBlocker;
      cooldownMs: number;
      cancelUnfilled: boolean;
      reentryEligible: boolean;
      finalState: "STALE_ABORTED" | "DEADLINE_EXCEEDED" | "NO_FILL" | "ABORTED";
      filledShares?: number;
      orderId?: string | null;
    }
  ): Promise<void> {
    if (this.finalizedAttemptIds.has(attempt.attemptId)) {
      return;
    }
    this.finalizedAttemptIds.add(attempt.attemptId);
    this.invalidatedAttemptIds.add(attempt.attemptId);
    this.applyExecutionCooldown(input.reason, input.cooldownMs, attempt);
    if (this.activeExecutionAttempt?.attemptId === attempt.attemptId) {
      this.activeExecutionAttempt = null;
    }
    this.transitionExecutionState("COOLDOWN", `ATTEMPT_${input.reason}`, {
      attemptId: attempt.attemptId,
      slug: attempt.executionSlug,
      tokenId: attempt.tokenId
    });
    let cancelRequested = false;
    let cancelledCount = 0;
    if (input.cancelUnfilled) {
      cancelRequested = true;
      const cancelResult = await this.cancelUnfilledOrdersForAttempt(attempt, input.reason);
      cancelledCount = cancelResult.cancelledCount;
    }
    const cooldownUntilTs = Math.max(this.executionCooldownUntilTs, this.entryAttemptCooldownUntilTs);
    this.logger.warn(
      {
        attemptId: attempt.attemptId,
        reason: input.reason,
        cancelRequested,
        cancelledCount,
        cooldownUntilTs
      },
      "POLY_V2_ATTEMPT_CLEANUP"
    );
    if (input.reentryEligible) {
      this.logReentryEligible(attempt, input.reason);
    }
    this.logger.warn(
      {
        attemptId: attempt.attemptId,
        finalState: input.finalState,
        blocker: input.blocker,
        filledShares: Number.isFinite(input.filledShares) ? input.filledShares : null,
        orderId: input.orderId ?? null
      },
      "POLY_V2_ATTEMPT_FINALIZED"
    );
  }

  private isExecutionAttemptActive(attempt: ExecutionAttempt): boolean {
    if (!attempt.postingStarted && Date.now() > attempt.deadlineTs) return false;
    if (this.invalidatedAttemptIds.has(attempt.attemptId)) return false;
    if (this.activeExecutionAttempt?.attemptId !== attempt.attemptId) return false;
    if (!attempt.postingStarted && !this.isExecutionSlugEligible(attempt.executionSlug, deriveBtc5mTickContext(Date.now()))) return false;
    return true;
  }

  private logExecutionAttemptLifecycle(
    attempt: ExecutionAttempt,
    state:
      | "created"
      | "posting_started"
      | "post_returned"
      | "deadline_exceeded"
      | "awaiting_settlement"
      | "reconcile_result"
      | "closed",
    extra: Record<string, unknown> = {}
  ): void {
    this.logger.warn(
      {
        attemptId: attempt.attemptId,
        executionSlug: attempt.executionSlug,
        currentSlug: this.state.currentBucketSlug,
        selectedSlug: attempt.selectedSlug,
        side: attempt.side,
        tokenId: attempt.tokenId,
        intendedOrderMode: attempt.intendedOrderMode,
        retryCount: attempt.retryCount,
        state,
        ...extra
      },
      "POLY_V2_EXECUTION_ATTEMPT_LIFECYCLE"
    );
  }

  private abortStaleAttempt(attempt: ExecutionAttempt, reason: string): { action: "HOLD"; blocker: string } {
    const staleReason = this.staleReasonFromToken(reason);
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
    void this.cleanupExecutionAttempt(attempt, {
      reason: staleReason,
      blocker: "STALE_ATTEMPT_ABORTED",
      cooldownMs: staleReason === "STALE_AFTER_POST" ? this.getStaleAfterPostCooldownMs() : this.getExecutionCooldownMs(),
      cancelUnfilled: attempt.postingStarted || attempt.postReturned,
      reentryEligible: this.getReentryAfterUnfilledEnabled(),
      finalState: "STALE_ABORTED"
    });
    return { action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" };
  }

  private isExecutionSlugEligible(slug: string, tick: Btc5mTick): boolean {
    return slug === tick.currentSlug;
  }

  private async verifySideBookAvailableForExecution(input: {
    slug: string;
    side: "YES" | "NO";
    tokenId: string;
  }): Promise<boolean> {
    if (this.selector.isSideBookUnavailable(input.slug, input.tokenId)) {
      this.logger.warn(
        {
          slug: input.slug,
          side: input.side,
          tokenId: input.tokenId,
          reason: "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN"
        },
        "POLY_V2_SIDE_BOOK_UNAVAILABLE_ALREADY_MARKED"
      );
      return false;
    }
    try {
      const quote = await this.client.getTokenPriceQuote(input.tokenId, { slug: input.slug });
      const quoteAvailable = quote.bestAsk !== null || quote.bestBid !== null;
      if (!quoteAvailable) {
        this.logger.warn(
          {
            slug: input.slug,
            side: input.side,
            tokenId: input.tokenId,
            reason: "EMPTY_LIVE_QUOTE"
          },
          "POLY_V2_SIDE_BOOK_UNAVAILABLE"
        );
      }
      return quoteAvailable;
    } catch (error) {
      const reason = shortError(error);
      if (reason.toLowerCase().includes("no orderbook exists for the requested token id")) {
        this.selector.markSideBookUnavailable(input.slug, input.tokenId, reason);
      }
      return false;
    }
  }

  private getExecutionDeadlineMs(): number {
    const envValue = Number(process.env.POLY_V2_EXECUTION_DEADLINE_MS || 60_000);
    if (!Number.isFinite(envValue)) return 60_000;
    return Math.max(5_000, Math.min(180_000, Math.floor(envValue)));
  }

  private getDecisionLoopMs(): number {
    const envValue = Number(process.env.POLY_V2_DECISION_LOOP_MS || 750);
    if (!Number.isFinite(envValue)) return 750;
    return Math.max(250, Math.min(5_000, Math.floor(envValue)));
  }

  private getLiveEntryMaxRemainingSec(): number {
    const envValue = Number(process.env.POLY_V2_MAX_ENTRY_REMAINING_SEC || 300);
    if (!Number.isFinite(envValue)) return 300;
    return Math.max(this.config.polymarket.live.minEntryRemainingSec + 1, Math.min(600, Math.floor(envValue)));
  }

  private getProfitTakePollMs(): number {
    const envValue = Number(process.env.POLY_V2_PROFIT_TAKE_POLL_MS || 750);
    if (!Number.isFinite(envValue)) return 750;
    return Math.max(250, Math.min(10_000, Math.floor(envValue)));
  }

  private getMaxEntriesPerWindow(): number {
    const cfg = Number(this.config.polymarket.live.maxEntriesPerWindow);
    if (Number.isFinite(cfg) && cfg > 0) {
      return Math.max(1, Math.min(20, Math.floor(cfg)));
    }
    const envValue = Number(process.env.POLYMARKET_MAX_ENTRIES_PER_WINDOW || process.env.POLY_V2_MAX_ENTRIES_PER_WINDOW || 1);
    if (!Number.isFinite(envValue)) return 1;
    return Math.max(1, Math.min(20, Math.floor(envValue)));
  }

  private getEntryAttemptCooldownMs(): number {
    const envValue = Number(process.env.POLY_V2_ENTRY_COOLDOWN_MS || 1_200);
    if (!Number.isFinite(envValue)) return 1_200;
    return Math.max(250, Math.min(60_000, Math.floor(envValue)));
  }

  private getReentryCooldownMs(): number {
    const cfgSec = Number(this.config.polymarket.live.reentryCooldownSec);
    if (Number.isFinite(cfgSec) && cfgSec > 0) {
      return Math.max(250, Math.min(120_000, Math.floor(cfgSec * 1000)));
    }
    const envSec = Number(process.env.POLYMARKET_REENTRY_COOLDOWN_SEC || Number.NaN);
    if (Number.isFinite(envSec) && envSec > 0) {
      return Math.max(250, Math.min(120_000, Math.floor(envSec * 1000)));
    }
    const envMs = Number(process.env.POLY_V2_REENTRY_COOLDOWN_MS || 8_000);
    if (!Number.isFinite(envMs)) return 8_000;
    return Math.max(250, Math.min(120_000, Math.floor(envMs)));
  }

  private getProfitTakeMinEdge(): number {
    const envValue = Number(process.env.POLY_V2_PROFIT_TAKE_MIN_EDGE || 0.01);
    if (!Number.isFinite(envValue)) return 0.01;
    return Math.max(0.0001, Math.min(0.25, envValue));
  }

  private isScalpModeEnabled(): boolean {
    if (typeof this.config.polymarket.live.scalpMode === "boolean") {
      return this.config.polymarket.live.scalpMode;
    }
    const normalized = String(process.env.POLYMARKET_SCALP_MODE || "false").trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }

  private getScalpTp1Usd(): number {
    const cfg = Number(this.config.polymarket.live.scalpTp1Usd);
    if (Number.isFinite(cfg) && cfg > 0) return Math.max(0.01, Math.min(100, cfg));
    const envValue = Number(process.env.POLYMARKET_SCALP_TP1_USD || 0.12);
    if (!Number.isFinite(envValue)) return 0.12;
    return Math.max(0.01, Math.min(100, envValue));
  }

  private getScalpTp2Usd(): number {
    const cfg = Number(this.config.polymarket.live.scalpTp2Usd);
    if (Number.isFinite(cfg) && cfg > 0) return Math.max(0.01, Math.min(100, cfg));
    const envValue = Number(process.env.POLYMARKET_SCALP_TP2_USD || 0.25);
    if (!Number.isFinite(envValue)) return 0.25;
    return Math.max(0.01, Math.min(100, envValue));
  }

  private getScalpMaxHoldSec(): number {
    const cfg = Number(this.config.polymarket.live.scalpMaxHoldSec);
    if (Number.isFinite(cfg) && cfg > 0) return Math.max(5, Math.min(600, Math.floor(cfg)));
    const envValue = Number(process.env.POLYMARKET_SCALP_MAX_HOLD_SEC || 60);
    if (!Number.isFinite(envValue)) return 60;
    return Math.max(5, Math.min(600, Math.floor(envValue)));
  }

  private getScalpTrailRetraceFrac(): number {
    const cfg = Number(this.config.polymarket.live.scalpTrailRetraceFrac);
    if (Number.isFinite(cfg) && cfg > 0) return Math.max(0.05, Math.min(0.95, cfg));
    const envValue = Number(process.env.POLYMARKET_SCALP_TRAIL_RETRACE_FRAC || 0.35);
    if (!Number.isFinite(envValue)) return 0.35;
    return Math.max(0.05, Math.min(0.95, envValue));
  }

  private getUnfilledEntryMaxAgeMs(): number {
    const envValue = Number(process.env.POLY_UNFILLED_ENTRY_MAX_AGE_MS || 8_000);
    if (!Number.isFinite(envValue)) return 8_000;
    return Math.max(500, Math.min(120_000, Math.floor(envValue)));
  }

  private getMaxOpenEntryOrdersPerWindow(): number {
    const envValue = Number(process.env.POLY_MAX_OPEN_ENTRY_ORDERS_PER_WINDOW || 1);
    if (!Number.isFinite(envValue)) return 1;
    return Math.max(1, Math.min(10, Math.floor(envValue)));
  }

  private getEntryOrderMode(): "MARKETABLE_ENTRY" | "RESTING_ENTRY" {
    const normalized = String(process.env.POLY_ENTRY_ORDER_MODE || "MARKETABLE").trim().toUpperCase();
    return normalized === "RESTING" ? "RESTING_ENTRY" : "MARKETABLE_ENTRY";
  }

  private getReentryAfterUnfilledEnabled(): boolean {
    const normalized = String(process.env.POLY_REENTRY_AFTER_UNFILLED || "true").trim().toLowerCase();
    return normalized !== "0" && normalized !== "false" && normalized !== "no";
  }

  private getExecutionCooldownMs(): number {
    const envValue = Number(process.env.POLY_V2_EXECUTION_COOLDOWN_MS || 1_500);
    if (!Number.isFinite(envValue)) return 1_500;
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

  private getNextBucketHandoffWaitSec(): number {
    const envValue = Number(process.env.POLY_V2_NEXT_BUCKET_HANDOFF_WAIT_SEC || 12);
    if (!Number.isFinite(envValue)) return 12;
    return Math.max(0, Math.min(120, Math.floor(envValue)));
  }

  private getWindowEntryState(slug: string): WindowEntryState {
    const existing = this.windowEntryStateBySlug.get(slug);
    if (existing) return existing;
    const initial: WindowEntryState = {
      entries: 0,
      exits: 0,
      realizedPnlUsd: 0,
      cooldownUntilTs: 0,
      clearedSinceLastEntry: true,
      lastEntryReason: null,
      lastExitReason: null,
      lastEntryTs: null,
      scalpCycleSeq: 0,
      activeScalpCycleId: null
    };
    this.windowEntryStateBySlug.set(slug, initial);
    return initial;
  }

  private syncWindowEntryState(slug: string, marketId: string, nowMs: number): void {
    const state = this.getWindowEntryState(slug);
    const hasPosition = this.hasOpenPositionForMarket(marketId);
    const hasOpenOrder = this.hasOpenOrderForMarket(marketId);
    if (state.entries <= 0) {
      state.clearedSinceLastEntry = true;
      return;
    }
    if (!hasPosition && !hasOpenOrder && !state.clearedSinceLastEntry) {
      state.clearedSinceLastEntry = true;
      state.cooldownUntilTs = Math.max(state.cooldownUntilTs, nowMs + this.getReentryCooldownMs());
      this.clearPositionScalpStateForMarket(marketId);
      this.logger.warn(
        {
          selectedSlug: slug,
          marketId,
          entriesInWindow: state.entries,
          exitsInWindow: state.exits,
          cooldownUntilTs: state.cooldownUntilTs,
          reason: "CLEARED_STATE"
        },
        "POLY_V2_REENTRY_EVAL"
      );
    }
  }

  private recordWindowEntry(input: {
    slug: string;
    marketId: string;
    tokenId: string;
    side: "YES" | "NO";
    reason: string;
    nowMs: number;
  }): void {
    const { slug, marketId, tokenId, side, reason, nowMs } = input;
    const state = this.getWindowEntryState(slug);
    state.entries += 1;
    state.clearedSinceLastEntry = false;
    state.lastEntryReason = reason;
    state.lastEntryTs = nowMs;
    state.scalpCycleSeq += 1;
    state.activeScalpCycleId = state.scalpCycleSeq;
    this.positionScalpStateByKey.set(this.getPositionScalpKey(marketId, tokenId, side), {
      key: this.getPositionScalpKey(marketId, tokenId, side),
      slug,
      marketId,
      tokenId,
      side,
      entryTs: nowMs,
      bestUnrealizedPnlUsd: 0,
      trailArmed: false,
      scalpCycleId: state.scalpCycleSeq
    });
  }

  private recordWindowExit(input: {
    slug: string;
    marketId: string;
    tokenId: string;
    side: "YES" | "NO";
    realizedPnlUsd: number;
    reason: string;
    nowMs: number;
  }): void {
    const { slug, marketId, tokenId, side, realizedPnlUsd, reason, nowMs } = input;
    const state = this.getWindowEntryState(slug);
    state.realizedPnlUsd += realizedPnlUsd;
    state.exits += 1;
    state.cooldownUntilTs = Math.max(state.cooldownUntilTs, nowMs + this.getReentryCooldownMs());
    state.clearedSinceLastEntry = true;
    state.lastExitReason = reason;
    state.activeScalpCycleId = null;
    this.positionScalpStateByKey.delete(this.getPositionScalpKey(marketId, tokenId, side));
  }

  private getPositionScalpKey(marketId: string, tokenId: string, side: "YES" | "NO"): string {
    return `${marketId}:${tokenId}:${side}`;
  }

  private getTimeInPositionSec(marketId: string, nowMs: number): number | null {
    const openStates = Array.from(this.positionScalpStateByKey.values()).filter((row) => row.marketId === marketId);
    if (openStates.length === 0) return null;
    const entryTs = Math.min(...openStates.map((row) => row.entryTs));
    if (!(entryTs > 0)) return null;
    return Math.max(0, Math.floor((nowMs - entryTs) / 1000));
  }

  private clearPositionScalpStateForMarket(marketId: string): void {
    for (const [key, state] of this.positionScalpStateByKey.entries()) {
      if (state.marketId === marketId) {
        this.positionScalpStateByKey.delete(key);
      }
    }
  }

  private setReentryStatus(allowed: boolean, reason: string | null): void {
    this.state.reentryAllowed = allowed;
    this.state.reentryBlockedReason = allowed ? null : reason;
  }

  private hasOpenPositionForMarket(marketId: string): boolean {
    return this.execution.getPositions().some((row) => row.marketId === marketId && row.shares > 0);
  }

  private hasOpenOrderForMarket(marketId: string): boolean {
    return this.execution.getOpenOrders().some((row) => row.marketId === marketId && row.status === "NEW");
  }

  private async maybeDispatchProfitTake(input: {
    tick: Btc5mTick;
    selected: Btc5mSelectedMarket;
    allowExecution: boolean;
  }): Promise<string | null> {
    if (!input.allowExecution || !this.canMutateVenueState()) return null;
    if (input.selected.slug !== input.tick.currentSlug) return null;
    if (this.activeProfitTakeAttempt) return "PROFIT_TAKE_IN_FLIGHT";
    if (this.activeExecutionAttempt && this.isExecutionAttemptActive(this.activeExecutionAttempt)) {
      const active = this.activeExecutionAttempt;
      const activeAgeMs = Date.now() - active.createdTs;
      const staleByAge = activeAgeMs >= this.getUnfilledEntryMaxAgeMs();
      const staleByRollover = active.executionSlug !== input.tick.currentSlug;
      const staleBySettlement = active.awaitingSettlement || active.postReturned;
      if (active.postingStarted && (staleByAge || staleByRollover || staleBySettlement)) {
        const staleReason: ExecutionStaleReason = staleByRollover ? "ROLLOVER" : "STALE_AFTER_POST";
        void this.cleanupExecutionAttempt(active, {
          reason: staleReason,
          blocker: "STALE_ATTEMPT_ABORTED",
          cooldownMs: staleReason === "STALE_AFTER_POST" ? this.getStaleAfterPostCooldownMs() : this.getExecutionCooldownMs(),
          cancelUnfilled: true,
          reentryEligible: this.getReentryAfterUnfilledEnabled(),
          finalState: "STALE_ABORTED"
        });
      } else {
        return "EXECUTION_IN_FLIGHT";
      }
    }
    if (input.tick.tickNowMs - this.lastProfitPollTs < this.getProfitTakePollMs()) {
      return null;
    }
    this.lastProfitPollTs = input.tick.tickNowMs;

    const positions = this.execution
      .getPositions()
      .filter((row) => row.marketId === input.selected.marketId && row.shares > 0);
    if (positions.length === 0) {
      this.logger.warn(
        {
          selectedSlug: input.selected.slug,
          currentSlug: input.tick.currentSlug,
          remainingSec: input.tick.remainingSec,
          openPositionCount: 0,
          reason: "NO_OPEN_POSITION"
        },
        "POLY_V2_PROFIT_TAKE_EVAL"
      );
      return null;
    }

    const minEdge = this.getProfitTakeMinEdge();
    const tp1Usd = this.getScalpTp1Usd();
    const tp2Usd = Math.max(tp1Usd, this.getScalpTp2Usd());
    const maxHoldSec = this.getScalpMaxHoldSec();
    const trailRetraceFrac = this.getScalpTrailRetraceFrac();
    let best:
      | {
          side: "YES" | "NO";
          tokenId: string;
          shares: number;
          bidPrice: number;
          avgPrice: number;
          edge: number;
          unrealizedPnlUsd: number;
          timeInPositionSec: number;
          exitReason: "TP1" | "TP2" | "TRAIL" | "MAX_HOLD" | "EDGE";
          scalpCycleId: number | null;
          priority: number;
        }
      | null = null;
    for (const position of positions) {
      if (this.selector.isSideBookUnavailable(input.selected.slug, position.tokenId)) {
        this.logger.warn(
          {
            slug: input.selected.slug,
            tokenId: position.tokenId,
            side: position.side,
            reason: "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN"
          },
          "POLY_V2_SIDE_BOOK_UNAVAILABLE_ALREADY_MARKED"
        );
        continue;
      }
      const book = position.side === "YES" ? input.selected.yesBook : input.selected.noBook;
      const bid = Number(book.bestBid);
      if (!Number.isFinite(bid) || bid <= 0) continue;
      const edge = bid - position.avgPrice;
      const unrealizedPnlUsd = edge * position.shares;
      const key = this.getPositionScalpKey(position.marketId, position.tokenId, position.side);
      const existingScalpState = this.positionScalpStateByKey.get(key);
      const entryTs = existingScalpState?.entryTs ?? position.updatedTs ?? input.tick.tickNowMs;
      const timeInPositionSec = Math.max(0, Math.floor((input.tick.tickNowMs - entryTs) / 1000));
      const bestUnrealizedPnlUsd = Math.max(existingScalpState?.bestUnrealizedPnlUsd ?? 0, unrealizedPnlUsd);
      const trailArmed = (existingScalpState?.trailArmed ?? false) || bestUnrealizedPnlUsd >= tp1Usd;
      const scalpCycleId = existingScalpState?.scalpCycleId ?? null;
      this.positionScalpStateByKey.set(key, {
        key,
        slug: input.selected.slug,
        marketId: position.marketId,
        tokenId: position.tokenId,
        side: position.side,
        entryTs,
        bestUnrealizedPnlUsd,
        trailArmed,
        scalpCycleId: scalpCycleId ?? 0
      });

      let exitReason: "TP1" | "TP2" | "TRAIL" | "MAX_HOLD" | "EDGE" | null = null;
      let priority = 0;
      if (unrealizedPnlUsd >= tp2Usd) {
        exitReason = "TP2";
        priority = 5;
      } else if (unrealizedPnlUsd >= tp1Usd) {
        exitReason = "TP1";
        priority = 4;
      } else if (
        trailArmed &&
        bestUnrealizedPnlUsd >= tp1Usd &&
        unrealizedPnlUsd <= bestUnrealizedPnlUsd * (1 - trailRetraceFrac)
      ) {
        exitReason = "TRAIL";
        priority = 3;
      } else if (edge >= minEdge) {
        exitReason = "EDGE";
        priority = 2;
      } else if (timeInPositionSec >= maxHoldSec) {
        exitReason = "MAX_HOLD";
        priority = 1;
      }

      if (
        exitReason &&
        (!best ||
          priority > best.priority ||
          (priority === best.priority && unrealizedPnlUsd > best.unrealizedPnlUsd))
      ) {
        best = {
          side: position.side,
          tokenId: position.tokenId,
          shares: position.shares,
          bidPrice: bid,
          avgPrice: position.avgPrice,
          edge,
          unrealizedPnlUsd,
          timeInPositionSec,
          exitReason,
          scalpCycleId,
          priority
        };
      }
    }
    if (!best) {
      this.logger.warn(
        {
          selectedSlug: input.selected.slug,
          currentSlug: input.tick.currentSlug,
          remainingSec: input.tick.remainingSec,
          openPositionCount: positions.length,
          minEdge,
          tp1Usd,
          tp2Usd,
          maxHoldSec,
          trailRetraceFrac
        },
        "POLY_V2_PROFIT_TAKE_EVAL"
      );
      return null;
    }

    const attempt: ProfitTakeAttempt = {
      attemptId: `pt-${++this.executionAttemptSeq}`,
      executionSlug: input.selected.slug,
      marketId: input.selected.marketId,
      tokenId: best.tokenId,
      side: best.side,
      shares: best.shares,
      bidPrice: best.bidPrice,
      avgPrice: best.avgPrice,
      exitReason: best.exitReason,
      scalpCycleId: best.scalpCycleId,
      timeInPositionSec: best.timeInPositionSec,
      createdTs: Date.now()
    };
    this.activeProfitTakeAttempt = attempt;
    this.transitionExecutionState("EXIT_PENDING", "PROFIT_TAKE_ATTEMPT_CREATED", {
      attemptId: attempt.attemptId,
      slug: attempt.executionSlug,
      tokenId: attempt.tokenId
    });
    this.logger.warn(
      {
        attemptId: attempt.attemptId,
        executionSlug: attempt.executionSlug,
        currentSlug: input.tick.currentSlug,
        selectedSlug: input.selected.slug,
        side: attempt.side,
        tokenId: attempt.tokenId,
        shares: attempt.shares,
        bidPrice: attempt.bidPrice,
        avgPrice: attempt.avgPrice,
        edge: best.edge,
        unrealizedPnlUsd: best.unrealizedPnlUsd,
        tp1Usd,
        tp2Usd,
        maxHoldSec,
        trailRetraceFrac,
        exitReason: best.exitReason,
        scalpCycleId: best.scalpCycleId,
        timeInPositionSec: best.timeInPositionSec
      },
      "POLY_V2_PROFIT_TAKE_EVAL"
    );
    this.startProfitTakeAttempt(attempt, input.selected);
    return "PROFIT_TAKE_IN_FLIGHT";
  }

  private startProfitTakeAttempt(attempt: ProfitTakeAttempt, selected: Btc5mSelectedMarket): void {
    let task: Promise<void> | null = null;
    task = (async () => {
      try {
        const result = await this.execution.executeExit({
          marketId: attempt.marketId,
          tokenId: attempt.tokenId,
          side: attempt.side,
          shares: attempt.shares,
          bidPrice: attempt.bidPrice,
          tickSize: selected.tickSize,
          negRisk: selected.negRisk
        });
        const fillPrice = Number(result.fillPrice ?? attempt.bidPrice);
        const filledShares = Number(result.filledShares || 0);
        const realizedPnlUsd =
          result.accepted && filledShares > 0 && Number.isFinite(fillPrice)
            ? (fillPrice - attempt.avgPrice) * filledShares
            : 0;
        if (result.accepted && filledShares > 0) {
          this.recordWindowExit({
            slug: attempt.executionSlug,
            marketId: attempt.marketId,
            tokenId: attempt.tokenId,
            side: attempt.side,
            realizedPnlUsd,
            reason: attempt.exitReason,
            nowMs: Date.now()
          });
        }
        this.logger.warn(
          {
            attemptId: attempt.attemptId,
            executionSlug: attempt.executionSlug,
            currentSlug: this.state.currentBucketSlug,
            selectedSlug: this.state.selectedSlug,
            side: attempt.side,
            tokenId: attempt.tokenId,
            exitReason: attempt.exitReason,
            scalpCycleId: attempt.scalpCycleId,
            timeInPositionSec: attempt.timeInPositionSec,
            accepted: result.accepted,
            blocker: result.reason || null,
            filledShares,
            fillPrice: Number.isFinite(fillPrice) ? fillPrice : null,
            realizedPnlUsd
          },
          "POLY_V2_PROFIT_TAKE_RESULT"
        );
      } catch (error) {
        this.logger.warn(
          {
            attemptId: attempt.attemptId,
            executionSlug: attempt.executionSlug,
            currentSlug: this.state.currentBucketSlug,
            selectedSlug: this.state.selectedSlug,
            side: attempt.side,
            tokenId: attempt.tokenId,
            exitReason: attempt.exitReason,
            scalpCycleId: attempt.scalpCycleId,
            timeInPositionSec: attempt.timeInPositionSec,
            reason: shortError(error)
          },
          "POLY_V2_PROFIT_TAKE_RESULT"
        );
      } finally {
        if (this.activeProfitTakeAttempt?.attemptId === attempt.attemptId) {
          this.activeProfitTakeAttempt = null;
        }
        if (this.activeProfitTakeTask === task) {
          this.activeProfitTakeTask = null;
        }
        this.refreshExecutionState(selected);
      }
    })();
    this.activeProfitTakeTask = task;
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
      if (input.attempt.postingStarted) return true;
      return this.isExecutionAttemptActive(input.attempt);
    };

    const tauSec = Math.max(0, input.tick.remainingSec);
    const oracleAgeMs = input.decision.oracleAgeMs;
    const oracleHardBlockMs = Math.max(
      this.config.polymarket.live.oracleWarnMs + 1,
      this.config.polymarket.live.oracleHardBlockMs
    );
    if (oracleAgeMs !== null && Number.isFinite(oracleAgeMs) && oracleAgeMs > oracleHardBlockMs) {
      return { action: "HOLD", blocker: "STALE_ORACLE_HARD_BLOCK" };
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
      entryMaxRemainingSec: this.getLiveEntryMaxRemainingSec(),
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
            yesBid: input.selected.yesBook.bestBid,
            notionalUsd,
            tickSize: input.selected.tickSize,
            negRisk: input.selected.negRisk,
            orderMode: input.attempt?.intendedOrderMode === "RESTING_ENTRY" ? "RESTING" : "MARKETABLE",
            executionGuard,
            executionLifecycle: (event, payload) => {
              if (!input.attempt) return;
              if (event === "posting_started") {
                input.attempt.postingStarted = true;
                this.logExecutionAttemptLifecycle(input.attempt, "posting_started", payload || {});
                return;
              }
              if (event === "post_returned") {
                input.attempt.postReturned = true;
                this.logExecutionAttemptLifecycle(input.attempt, "post_returned", payload || {});
                return;
              }
              if (event === "reconcile_result") {
                this.logExecutionAttemptLifecycle(input.attempt, "reconcile_result", payload || {});
              }
            }
          })
        : await this.execution.executeBuyNo({
            marketId: input.selected.marketId,
            tokenId: executionTokenId,
            noAsk: input.decision.sideAsk,
            noBid: input.selected.noBook.bestBid,
            notionalUsd,
            tickSize: input.selected.tickSize,
            negRisk: input.selected.negRisk,
            orderMode: input.attempt?.intendedOrderMode === "RESTING_ENTRY" ? "RESTING" : "MARKETABLE",
            executionGuard,
            executionLifecycle: (event, payload) => {
              if (!input.attempt) return;
              if (event === "posting_started") {
                input.attempt.postingStarted = true;
                this.logExecutionAttemptLifecycle(input.attempt, "posting_started", payload || {});
                return;
              }
              if (event === "post_returned") {
                input.attempt.postReturned = true;
                this.logExecutionAttemptLifecycle(input.attempt, "post_returned", payload || {});
                return;
              }
              if (event === "reconcile_result") {
                this.logExecutionAttemptLifecycle(input.attempt, "reconcile_result", payload || {});
              }
            }
          });
    if (!executionGuard()) {
      if (input.attempt) {
        return this.abortStaleAttempt(input.attempt, "STALE_AFTER_POST");
      }
      return { action: "HOLD", blocker: "STALE_ATTEMPT_ABORTED" };
    }
    if (!result.accepted) {
      if (isSideBookUnavailableReason(result.reason)) {
        this.selector.markSideBookUnavailable(
          input.selected.slug,
          executionTokenId,
          result.reason || "SIDE_BOOK_UNAVAILABLE"
        );
      }
      return { action: "HOLD", blocker: result.reason || "LIVE_REJECTED" };
    }
    if (!(result.filledShares > 0)) {
      return { action: "HOLD", blocker: "LIVE_PLACED_NO_FILL" };
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

  private async validateSelectionForDispatch(input: {
    selected: Btc5mSelectedMarket;
    tick: Btc5mTick;
    expectedSelectionVersion: number;
  }): Promise<DispatchSelectionValidation> {
    const dispatchTick = deriveBtc5mTickContext(Date.now());
    let selected: Btc5mSelectedMarket | null = input.selected;
    let reselectionTriggered = false;
    let dispatchEligibilityReason = this.computeDispatchEligibilityReason(selected, dispatchTick);
    if (this.selectionVersion !== input.expectedSelectionVersion) {
      dispatchEligibilityReason = "SELECTION_VERSION_MISMATCH";
    }
    const shouldReselect =
      this.state.warningState === "DISCOVERY_STALE" ||
      dispatchEligibilityReason === "PREORDER_STALE_MARKET_SELECTION" ||
      dispatchEligibilityReason === "EXPIRED_WINDOW" ||
      dispatchEligibilityReason === "SELECTED_TOKEN_NOT_EXECUTABLE" ||
      dispatchEligibilityReason === "SELECTION_VERSION_MISMATCH";

    if (shouldReselect) {
      reselectionTriggered = true;
      const reselection = await this.selector.select({ tick: dispatchTick });
      selected = reselection.selected;
      dispatchEligibilityReason = selected
        ? this.computeDispatchEligibilityReason(selected, dispatchTick)
        : String(reselection.reason || BTC5M_SELECTOR_REASONS.NO_CANDIDATE_MARKETS);
      this.logger.warn(
        {
          previousSelectedSlug: input.selected.slug,
          reselectedSlug: selected?.slug ?? null,
          dispatchValidationBucket: dispatchTick.currentSlug,
          dispatchValidationRemainingSec: dispatchTick.remainingSec,
          dispatchEligibilityReason,
          reselectionTriggered: true
        },
        "POLY_V2_DISPATCH_RESELECTION"
      );
    }

    if (this.selectionVersion !== input.expectedSelectionVersion && dispatchEligibilityReason === "ELIGIBLE_CURRENT") {
      dispatchEligibilityReason = "SELECTION_VERSION_MISMATCH";
    }
    dispatchEligibilityReason = this.normalizeDispatchHoldReason(dispatchEligibilityReason);

    const handoffWaitTriggered = dispatchEligibilityReason === "NEXT_BUCKET_HANDOFF_WAIT";
    return {
      tick: dispatchTick,
      selected,
      dispatchEligibilityReason,
      reselectionTriggered,
      handoffWaitTriggered
    };
  }

  private computeDispatchEligibilityReason(selected: Btc5mSelectedMarket | null, tick: Btc5mTick): string {
    if (!selected) return BTC5M_SELECTOR_REASONS.NO_CANDIDATE_MARKETS;
    if (!this.isSelectedBookExecutable(selected)) return "SELECTED_TOKEN_NOT_EXECUTABLE";
    if (selected.slug === tick.currentSlug) {
      if (tick.remainingSec <= 0 || selected.remainingSec <= 0) return "EXPIRED_WINDOW";
      return "ELIGIBLE_CURRENT";
    }
    if (selected.slug === tick.nextSlug) {
      if (tick.remainingSec <= this.getNextBucketHandoffWaitSec()) return "NEXT_BUCKET_HANDOFF_WAIT";
      return "PREORDER_STALE_MARKET_SELECTION";
    }
    return "PREORDER_STALE_MARKET_SELECTION";
  }

  private normalizeDispatchHoldReason(reason: string): string {
    if (
      reason === "PREORDER_STALE_MARKET_SELECTION" ||
      reason === "EXPIRED_WINDOW" ||
      reason === "SELECTION_VERSION_MISMATCH" ||
      reason === "SELECTED_TOKEN_NOT_EXECUTABLE"
    ) {
      return "NEXT_BUCKET_HANDOFF_WAIT";
    }
    return reason;
  }

  private isSelectedBookExecutable(selected: Btc5mSelectedMarket): boolean {
    if (
      !selected.orderbookOk ||
      !selected.yesTokenId ||
      !selected.noTokenId ||
      !selected.yesBook.bookable ||
      !selected.noBook.bookable
    ) {
      return false;
    }
    const yesAsk = Number(selected.yesBook.bestAsk);
    const noAsk = Number(selected.noBook.bestAsk);
    if (!Number.isFinite(yesAsk) || yesAsk <= 0) return false;
    if (!Number.isFinite(noAsk) || noAsk <= 0) return false;
    return true;
  }

  private invalidateSelectionCommit(reason: string): void {
    this.selectionCommitEpochSec = null;
    this.selectionVersion += 1;
    this.state.selectionVersion = this.selectionVersion;
    this.state.selectionCommitEpoch = null;
    this.logger.warn(
      {
        reason,
        selectionVersion: this.selectionVersion
      },
      "POLY_V2_SELECTION_INVALIDATED"
    );
  }

  private commitSelectionVersion(selectedSlug: string, commitEpochSec: number): void {
    if (this.selectionCommitEpochSec !== commitEpochSec || this.state.selectedSlug !== selectedSlug) {
      this.selectionVersion += 1;
    }
    this.selectionCommitEpochSec = commitEpochSec;
    this.state.selectionVersion = this.selectionVersion;
    this.state.selectionCommitEpoch = commitEpochSec;
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

  private logDecisionBreakdown(input: {
    intelligence: Btc5mIntelligence;
    decision: Btc5mDecision;
    selected: Btc5mSelectedMarket;
    tick: Btc5mTick;
    finalChosenSide: "YES" | "NO" | null;
    finalAction: "BUY_YES" | "BUY_NO" | "HOLD";
  }): void {
    this.logger.warn(
      {
        rawSignalScore: finiteOrNull(input.intelligence.rawSignalScore),
        intelScore: finiteOrNull(input.intelligence.intelScore),
        crossVenueBiasScore: finiteOrNull(input.intelligence.crossVenueBiasScore),
        baseProbability: finiteOrNull(input.intelligence.baseProbability),
        pUpModel: finiteOrNull(input.decision.pUpModel),
        yesPrice: finiteOrNull(input.selected.yesBook.bestAsk),
        noPrice: finiteOrNull(input.selected.noBook.bestAsk),
        yesEdge: finiteOrNull(input.decision.yesEdge),
        noEdge: finiteOrNull(input.decision.noEdge),
        finalChosenSide: input.finalChosenSide,
        finalAction: input.finalAction,
        intelligenceSource: input.decision.intelligenceSource,
        intelligencePosture: input.decision.intelligencePosture,
        intelligenceScore: finiteOrNull(input.decision.intelligenceScore),
        oracleAgeMs: input.decision.oracleAgeMs,
        selectedSlug: input.selected.slug,
        currentSlug: input.tick.currentSlug,
        remainingSec: input.tick.remainingSec
      },
      "POLY_V2_DECISION_BREAKDOWN"
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

  private getReferencePrice(nowMs: number): ReferenceOracle {
    if (!this.store) {
      return { price: null, ageMs: null, ts: null, source: "NONE" };
    }
    const quotes = this.store
      .getLatestVenueQuotes(this.config.symbol)
      .filter((row) => Number.isFinite(row.mid) && row.mid !== null && Number(row.mid) > 0);
    if (quotes.length > 0) {
      const latestTs = Math.max(...quotes.map((row) => Number(row.ts || 0)));
      const mids = quotes
        .filter((row) => Number(row.ts || 0) >= latestTs - 5_000)
        .map((row) => Number(row.mid))
        .filter((row) => Number.isFinite(row) && row > 0)
        .sort((a, b) => a - b);
      const mid = mids.length > 0 ? mids[Math.floor(mids.length / 2)] : null;
      const sourceVenues = quotes
        .filter((row) => Number(row.ts || 0) >= latestTs - 5_000)
        .map((row) => String(row.venue || "").trim())
        .filter((row) => row.length > 0)
        .sort()
        .join(",");
      return {
        price: mid,
        ageMs: latestTs > 0 ? Math.max(0, nowMs - latestTs) : null,
        ts: latestTs > 0 ? latestTs : null,
        source: sourceVenues ? `EXTERNAL_VENUES:${sourceVenues}` : "EXTERNAL_VENUES"
      };
    }

    const latestTicker = this.store.getRecentTickerSnapshots(this.config.symbol, 1)[0] ?? null;
    const tickerMid = latestTicker && Number.isFinite(latestTicker.mid) && latestTicker.mid > 0 ? latestTicker.mid : null;
    const tickerTs = latestTicker && Number.isFinite(latestTicker.ts) && latestTicker.ts > 0 ? latestTicker.ts : null;
    if (tickerMid !== null && tickerTs !== null) {
      return {
        price: tickerMid,
        ageMs: Math.max(0, nowMs - tickerTs),
        ts: tickerTs,
        source: "TICKER_SNAPSHOT"
      };
    }

    return {
      price: null,
      ageMs: null,
      ts: null,
      source: "NONE"
    };
  }

  private resolveDirectionalIntelligence(input: {
    nowMs: number;
    referencePrice: number | null;
    priceToBeat: number | null;
    fallbackMid: number | null;
  }): Btc5mIntelligence {
    const components: Array<{ name: string; weight: number; score: number; posture: string }> = [];
    const baseProbability = inferProbabilityFallback({
      referencePrice: input.referencePrice,
      priceToBeat: input.priceToBeat,
      fallbackMid: input.fallbackMid
    });
    let rawSignalScore: number | null = null;
    let intelScore: number | null = null;
    let crossVenueBiasScore: number | null = null;

    if (this.signalsEngine && this.config.signalsEnabled) {
      const aggregate = this.signalsEngine.getLatestAggregate();
      const direction = directionToScore(aggregate.direction);
      const confidence = clampRange(Number(aggregate.confidence || 0), 0, 1);
      const impact = clampRange(Number(aggregate.impact || 0), 0, 1);
      if (aggregate.ts > 0 || aggregate.latestTs > 0 || confidence > 0 || impact > 0) {
        const strength = clampRange(Math.max(0.1, impact) * confidence, 0, 1);
        rawSignalScore = direction * strength;
        components.push({
          name: "SIGNALS_ENGINE",
          weight: 0.45,
          score: rawSignalScore,
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
        intelScore = direction * strength;
        components.push({
          name: "INTEL_ENGINE",
          weight: 0.35,
          score: intelScore,
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
      crossVenueBiasScore = direction * confidence;
      components.push({
        name: "CROSS_VENUE_BIAS",
        weight: 0.20,
        score: crossVenueBiasScore,
        posture: signalBias
      });
    }

    if (components.length === 0) {
      return {
        source: "HEURISTIC_FALLBACK",
        posture: null,
        score: null,
        pUpModel: baseProbability,
        fallbackUsed: true,
        rawSignalScore,
        intelScore,
        crossVenueBiasScore,
        baseProbability
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
      fallbackUsed: false,
      rawSignalScore,
      intelScore,
      crossVenueBiasScore,
      baseProbability
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

  private applyHoldReason(input: { reason: string; tick: Btc5mTick; selectedSlug: string | null }): void {
    const normalizedReason = String(input.reason || "HOLD");
    this.state.action = "HOLD";
    this.state.holdReason = normalizedReason;
    this.state.blockedBy = normalizedReason;
    this.logger.warn(
      {
        reason: normalizedReason,
        selectedSlug: input.selectedSlug,
        currentSlug: input.tick.currentSlug,
        tickNowSec: input.tick.tickNowSec
      },
      "POLY_V2_HOLD_REASON"
    );
  }
}

function chosenDirectionForSide(side: "YES" | "NO"): "UP" | "DOWN" {
  return side === "YES" ? "UP" : "DOWN";
}

function finiteOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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

function isSideBookUnavailableReason(reason: string | null | undefined): boolean {
  const normalized = String(reason || "").toUpperCase();
  return (
    normalized.includes("SIDE_BOOK_UNAVAILABLE") ||
    normalized.includes("SIDE_NOT_BOOKABLE") ||
    normalized.includes("MISSING_ORDERBOOK_FOR_SELECTED_TOKEN") ||
    normalized.includes("NO ORDERBOOK EXISTS")
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
