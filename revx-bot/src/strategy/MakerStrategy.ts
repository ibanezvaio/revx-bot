import { BotConfig } from "../config";
import { randomUUID } from "node:crypto";
import { Execution } from "../exec/Execution";
import { Logger } from "../logger";
import { MarketData } from "../md/MarketData";
import { NewsEngine } from "../news/NewsEngine";
import { NewsSnapshot } from "../news/types";
import { IntelAdjustment, IntelEngine, IntelPosture } from "../intel/IntelEngine";
import { Reconciler } from "../recon/Reconciler";
import { RevXClient, RevXHttpError } from "../revx/RevXClient";
import { BalanceState } from "../recon/BalanceState";
import { orderSubmitState } from "../recon/OrderSubmitState";
import { orderReconcileState } from "../recon/OrderReconcileState";
import { RiskManager } from "../risk/RiskManager";
import { CrossVenueSignalEngine } from "../signal/CrossVenueSignalEngine";
import { CrossVenueComputation } from "../signal/types";
import {
  HybridSignalEngine,
  HybridSignalSnapshot,
  mapSignalBiasToSkewBps,
  SignalEngine
} from "../signals/SignalEngine";
import { SignalsEngine } from "../signals/SignalsEngine";
import { SignalSnapshot as AggregateSignalsSnapshot } from "../signals/types";
import { signalDebugState } from "../signals/SignalDebugState";
import { BotStatus, OrderRecord, Side, Store } from "../store/Store";
import {
  AdverseSelectionSummary,
  AdverseSelectionTracker
} from "./adverseSelection";
import {
  AdverseMarkoutPoint,
  AdverseSelectionDecision,
  AdverseSelectionGuard
} from "./AdverseSelectionGuard";
import { adverseDebugState } from "./AdverseDebugState";
import { BalanceClampEvent, BalanceManager } from "./BalanceManager";
import { NewsGuard, NewsGuardDecision } from "./NewsGuard";
import { QuoteInputs, QuotePlan, quoteDebugState } from "./QuoteDebugState";
import { NormalizedBalances, normalizeBalancesForSymbol } from "./balances/normalizeBalances";
import { computeSeedState } from "./inventorySeeding";
import { MarketPhase, MarketShockController, MarketShockDecision } from "./MarketShockController";
import { seedDebugState } from "./SeedDebugState";
import { strategyHealthState } from "./StrategyHealthState";
import { SignalsGuard, SignalsGuardDecision } from "./SignalsGuard";
import { sleep } from "../util/time";

type DesiredQuote = {
  tag: string;
  side: Side;
  level: number | string;
  price: number;
  quoteSizeUsd: number;
};

type MidPoint = { ts: number; mid: number };

type TrendEffect = {
  applied: boolean;
  direction: "UP" | "DOWN" | "NONE";
  mode: "spread" | "reduce_level";
};

type AdaptiveControllerResult = {
  afterHalfSpreadBps: number;
  deltaBps: number;
  adjustments: string[];
};

type SideEdgeAdjustments = {
  bidBps: number;
  askBps: number;
};

type CompetitivePosture = "NORMAL" | "CAUTION" | "RISK_OFF" | "HALT";
type SoftRiskState = "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE" | "HALT";
type RiskHysteresisKey = "news" | "signals" | "posture";
type RiskHysteresisState = {
  currentState: SoftRiskState;
  pendingState: SoftRiskState | null;
  pendingSinceTs: number;
};

type QuotePlanParams = {
  inputs: QuoteInputs;
  buyLevels: number;
  sellLevels: number;
  tobMode: "OFF" | "BOTH" | "BUY-ONLY" | "SELL-ONLY";
  blockedReasons: string[];
  hardHaltReasons?: string[];
};

type ReconcileOutcome = {
  actionsUsed: number;
  placed: number;
  cancelled: number;
  kept: number;
  cancelReasonCounts: Record<string, number>;
  lastCancelReason: string | null;
  refreshSkipped: boolean;
  refreshSkipReason: string;
};

type OpenVenueSideCounts = {
  buy: number;
  sell: number;
};

type WhyNotQuotingInfo = {
  reason: string;
  details: string;
};

type PlannerOutputSummary = {
  desiredCount: number;
  buyLevels: number;
  sellLevels: number;
  tob: "OFF" | "BUY" | "SELL" | "BOTH";
  usedLevelsBuy?: number;
  usedLevelsSell?: number;
  usedTob?: "OFF" | "BUY" | "SELL" | "BOTH";
  perSideBlockReasons?: {
    buy: string[];
    sell: string[];
  };
  actionBudget: number;
  actionsUsed: number;
  openBuyVenue: number;
  openSellVenue: number;
};

type BalanceSnapshotRuntime = {
  freeUsd: number;
  freeBtc: number;
  reservedUsd: number;
  reservedBtc: number;
  spendableUsd: number;
  spendableBtc: number;
};

type InventoryAction = "ACCUMULATE" | "DISTRIBUTE" | "HOLD";

type PhaseSnapshot = {
  phase: MarketPhase;
  sinceTs: number;
  reasons: string[];
  shockVolPeakBps: number;
};

type AdverseSelectionRuntimeSummary = {
  asAvgBps: number;
  asBadRate: number;
  asLastBps: number | null;
  asSamples: number;
  asToxic: boolean;
  asWidenBps: number;
  asCooldownRemainingSeconds: number;
  inCooldown: boolean;
};

type RuntimeHardHalt = {
  active: boolean;
  reason: string;
  sinceTs: number;
};

type ErrorPolicySnapshot = {
  recoverableCount5m: number;
  lastRecoverableError: string;
  transientBackoffMs: number;
  hardHalt: boolean;
  hardHaltReason: string;
};

const QUOTE_BLOCKED_LOG_THROTTLE_MS = 15_000;
const MIN_RESTING_SECONDS_BEFORE_CANCEL = 10;
const RISK_WORSEN_PERSIST_MS = 120_000;
const RISK_RELAX_PERSIST_MS = 300_000;

export class MakerStrategy {
  private running = false;
  private readonly mids: MidPoint[] = [];
  private cooldownUntilMs = 0;
  private cooldownReason = "";
  private refreshCursor = 0;
  private lastMetricsLogMs = 0;
  private lastTightSpreadCancelMs = 0;
  private lastQuoteBlockedLogMs = 0;
  private lastQuoteRefreshTs = 0;
  private lastCancelAllTs = 0;
  private lastCancelAllReason = "";
  private baselineInvariantMissingSinceTs = 0;
  private baselineAckMissingLoggedAtTs = 0;
  private seedStartTs = 0;
  private seedReposts = 0;
  private seedTakerFired = false;
  private lastSeedOrderTs = 0;
  private seedTakerClientOrderId: string | null = null;
  private seedTakerVenueOrderId: string | null = null;
  private readonly balanceManager = new BalanceManager();
  private readonly shockController: MarketShockController;
  private readonly spreads: Array<{ ts: number; spreadBps: number }> = [];
  private readonly depthNotionals: Array<{ ts: number; notionalUsd: number }> = [];
  private lastReentryBuyTs = 0;
  private takerReentryWindowStartTs = 0;
  private takerReentrySpentUsdInWindow = 0;
  private lastBalanceSnapshotRuntime: BalanceSnapshotRuntime = {
    freeUsd: 0,
    freeBtc: 0,
    reservedUsd: 0,
    reservedBtc: 0,
    spendableUsd: 0,
    spendableBtc: 0
  };
  private readonly asTracker: AdverseSelectionTracker;
  private readonly hybridSignalEngine: HybridSignalEngine;
  private readonly adverseGuard: AdverseSelectionGuard;
  private readonly newsGuard: NewsGuard;
  private readonly signalsGuard: SignalsGuard;
  private readonly newsEngine: NewsEngine | null;
  private readonly signalsEngine: SignalsEngine | null;
  private readonly intelEngine: IntelEngine | null;
  private lastHybridSignal: HybridSignalSnapshot | null = null;
  private lastNewsSnapshot: NewsSnapshot | null = null;
  private lastSignalsSnapshot: AggregateSignalsSnapshot | null = null;
  private lastNewsDecision: NewsGuardDecision = {
    ts: 0,
    state: "NORMAL",
    impact: 0,
    direction: "NEUTRAL",
    confidence: 0,
    spreadMult: 1,
    sizeMult: 1,
    allowBuy: null,
    allowSell: null,
    pauseMakers: false,
    allowTakerFlattenOnly: false,
    reasons: [],
    cooldownRemainingSeconds: 0,
    lastHeadlineTs: 0
  };
  private lastAdverseDecision: AdverseSelectionDecision = {
    ts: 0,
    toxicityScore: 0,
    state: "NORMAL",
    recommendedSpreadMult: 1,
    recommendedSkewBps: 0,
    allowBuy: null,
    allowSell: null,
    takerHedgeAllowed: false,
    reasons: ["NOT_READY"],
    markoutAvgBps: 0,
    markoutCount: 0,
    adverseSpreadMult: 1
  };
  private lastSignalsDecision: SignalsGuardDecision = {
    ts: 0,
    state: "NORMAL",
    impact: 0,
    direction: "NEUTRAL",
    confidence: 0,
    spreadMultExtra: 1,
    sizeMultExtra: 1,
    gateBuy: null,
    gateSell: null,
    pauseMakers: false,
    allowTakerFlattenOnly: false,
    reasons: [],
    cooldownRemainingSeconds: 0
  };
  private lastIntelPosture: IntelPosture = {
    ts: 0,
    state: "NORMAL",
    impact: 0,
    direction: "NEUTRAL",
    confidence: 0,
    widenBps: 0,
    sizeCut: 0,
    skewBps: 0,
    haltUntilTs: 0,
    reasons: []
  };
  private lastIntelAdjustment: IntelAdjustment = {
    spreadMult: 1,
    sizeMult: 1,
    tobModeOverride: "UNCHANGED",
    hardBlock: false,
    cooldownSeconds: 0,
    reasonCodes: []
  };
  private lastIntelAdjustmentLogKey = "";
  private lastIntelAdjustmentLogTs = 0;
  private hedgeWindowStartTs = 0;
  private hedgeSpentUsdInWindow = 0;
  private readonly riskHysteresis: Record<RiskHysteresisKey, RiskHysteresisState> = {
    news: { currentState: "NORMAL", pendingState: null, pendingSinceTs: 0 },
    signals: { currentState: "NORMAL", pendingState: null, pendingSinceTs: 0 },
    posture: { currentState: "NORMAL", pendingState: null, pendingSinceTs: 0 }
  };
  private asLastSummary: AdverseSelectionRuntimeSummary = {
    asAvgBps: 0,
    asBadRate: 0,
    asLastBps: null,
    asSamples: 0,
    asToxic: false,
    asWidenBps: 0,
    asCooldownRemainingSeconds: 0,
    inCooldown: false
  };
  private runtimeHardHalt: RuntimeHardHalt = {
    active: false,
    reason: "",
    sinceTs: 0
  };
  private recoverableErrorsTs: number[] = [];
  private transientServerErrorsTs: number[] = [];
  private lastRecoverableError = "";
  private privateCallBackoffUntilTs = 0;
  private privateCallBackoffMs = 0;
  private lastShockDecision: MarketShockDecision = {
    phase: "STABILIZING",
    state: "STABILIZING",
    sinceTs: 0,
    reasons: ["STABILIZING_ACTIVE"],
    shockVolPeakBps: 0,
    actions: {
      spreadMult: 1.05,
      sizeMult: 0.85,
      reduceLevelsBy: 0,
      sellSkewBps: 0,
      buySkewBps: 1,
      tobStepBackTicks: 1,
      forceSeedReentry: false
    }
  };

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly client: RevXClient,
    private readonly store: Store,
    private readonly marketData: MarketData,
    private readonly execution: Execution,
    private readonly reconciler: Reconciler,
    private readonly risk: RiskManager,
    private readonly signalEngine: SignalEngine,
    private readonly crossVenueSignalEngine: CrossVenueSignalEngine,
    newsEngine?: NewsEngine,
    signalsEngine?: SignalsEngine,
    intelEngine?: IntelEngine
  ) {
    this.newsEngine = newsEngine ?? null;
    this.signalsEngine = signalsEngine ?? null;
    this.intelEngine = intelEngine ?? null;
    this.hybridSignalEngine = new HybridSignalEngine(this.config);
    this.adverseGuard = new AdverseSelectionGuard(this.config);
    this.newsGuard = new NewsGuard(this.config);
    this.signalsGuard = new SignalsGuard(this.config);
    this.shockController = new MarketShockController({
      shockEnterBps: this.config.shockEnterBps,
      shockSpreadBps: this.config.shockSpreadBps,
      shockDispersionBps: this.config.shockDispersionBps,
      baselineSpreadBps: Math.max(0.1, this.config.minInsideSpreadBps),
      shockMinSeconds: this.config.shockMinSeconds,
      reentryNoNewLowSeconds: this.config.reentryNoNewLowSeconds,
      recoveryDispersionBps: this.config.recoveryDispersionBps,
      recoveryPersistSeconds: this.config.recoveryPersistSeconds
    });
    this.asTracker = new AdverseSelectionTracker({
      enabled: this.config.enableAdverseSelectionLoop,
      horizonSeconds: this.config.asHorizonSeconds,
      sampleFills: this.config.asSampleFills,
      badAvgBps: this.config.asBadAvgBps,
      badRate: this.config.asBadRate,
      badFillBps: this.config.asBadFillBps,
      widenStepBps: this.config.asWidenStepBps,
      maxWidenBps: this.config.asMaxWidenBps,
      cooldownSeconds: this.config.asCooldownSeconds,
      decayBpsPerMin: this.config.asDecayBpsPerMin
    });
    this.balanceManager.setRefreshIntervalMs(this.config.balanceRefreshSeconds * 1000);
  }

  stop(): void {
    this.running = false;
  }

  async start(): Promise<void> {
    this.running = true;
    strategyHealthState.reset();
    quoteDebugState.setBootError("Quote planner has not completed its first cycle yet.");
    await this.reconciler.awaitFirstBalanceAttempt();
    const stallThresholdMs = Math.max(1_000, this.config.reconcileSeconds * 5_000);
    let stallLogged = false;
    const evaluateStall = (): void => {
      if (!this.running) return;
      const snapshot = strategyHealthState.getSnapshot();
      if (snapshot.lastCycleCompletedTs <= 0) {
        strategyHealthState.setStalled(false);
        stallLogged = false;
        return;
      }
      const stalled = Date.now() - snapshot.lastCycleCompletedTs > stallThresholdMs;
      strategyHealthState.setStalled(stalled);
      if (stalled && !stallLogged) {
        stallLogged = true;
        this.logger.error(
          {
            lastCycleCompletedTs: snapshot.lastCycleCompletedTs,
            stallThresholdMs
          },
          "Strategy stalled — no completed cycle"
        );
      } else if (!stalled) {
        stallLogged = false;
      }
    };
    const watchdogMs = Math.max(1_000, Math.min(5_000, Math.floor(this.config.reconcileSeconds * 1_000)));
    const watchdog = setInterval(() => {
      evaluateStall();
    }, watchdogMs);
    const runOneCycle = async (): Promise<void> => {
      try {
        await this.runSingleCycle();
        strategyHealthState.markCycleCompleted(Date.now());
        quoteDebugState.setBootError(null);
        evaluateStall();
        this.risk.recordSuccess();
      } catch (error) {
        const classification = classifyStrategyRuntimeError(error);
        if (classification.category === "FATAL") {
          const reason = classification.message || "Execution-critical failure";
          this.activateRuntimeHardHalt(reason);
          this.logger.error(
            {
              classification,
              error
            },
            "Execution-critical failure; strategy hard-halted (manual intervention required)"
          );
          this.risk.recordSuccess();
          return;
        }
        if (classification.category === "RECOVERABLE") {
          this.recordRecoverableError(classification.message);
          this.logger.warn(
            {
              classification,
              error: error instanceof Error ? error.message : String(error)
            },
            "Recoverable strategy error; keeping strategy alive"
          );
          if (classification.isInsufficientBalance) {
            this.balanceManager.requestRefresh("insufficient_balance");
            await this.reconciler.refreshBalancesNow("insufficient_balance");
          }
          if (classification.isStaleSnapshot) {
            await this.reconcileOnceWithTimeout(5_000);
          }
          this.risk.recordSuccess();
          return;
        }
        if (classification.category === "TRANSIENT") {
          this.registerTransientError(classification);
          const retryAfterMs =
            classification.retryAfterMs && classification.retryAfterMs > 0
              ? classification.retryAfterMs
              : this.nextTransientBackoffMs();
          this.privateCallBackoffUntilTs = Date.now() + retryAfterMs;
          this.privateCallBackoffMs = retryAfterMs;
          this.logger.warn(
            {
              classification,
              retryAfterMs,
              privateCallBackoffUntilTs: this.privateCallBackoffUntilTs
            },
            "Transient strategy error; applying backoff and continuing"
          );
          if (this.shouldEscalateServerFailures()) {
            this.activateRuntimeHardHalt(
              `SUSTAINED_5XX_FAILURES (${this.transientServerErrorsTs.length} in ${this.config.fatal5xxWindowMinutes}m)`
            );
          }
          this.risk.recordSuccess();
          return;
        }
        this.recordRecoverableError(classification.message || "UNKNOWN_ERROR");
        this.logger.warn(
          { classification, error: error instanceof Error ? error.message : String(error) },
          "Unclassified strategy error treated as recoverable"
        );
        this.risk.recordSuccess();
      }
    };

    try {
      await runOneCycle();
      while (this.running) {
        await sleep(this.config.refreshSeconds * 1000);
        if (!this.running) break;
        await runOneCycle();
      }
    } finally {
      clearInterval(watchdog);
    }
  }

  async runSingleCycle(): Promise<void> {
    let cycleErrored = false;
    this.logger.info({ symbol: this.config.symbol }, "Cycle start");
    try {
    const effectiveConfig = this.store.getEffectiveConfig(this.config.symbol);
    if (this.balanceManager.shouldRefresh(Date.now())) {
      const refreshReason = this.balanceManager.consumeRefreshReason();
      await this.reconciler.refreshBalancesNow(
        refreshReason === "insufficient_balance" ? "insufficient_balance" : "manual"
      );
    }
    const runtimeOverridesRecord = this.store.getRuntimeOverrides(this.config.symbol);
    const runtimeOverrideValidationIssues = validateRuntimeOverrideValues(effectiveConfig);
    const runtimeOverrideSource = String(effectiveConfig.overrideSource ?? "").toLowerCase();
    const runtimePauseActive =
      effectiveConfig.overridesActive &&
      effectiveConfig.enabled === false &&
      runtimeOverrideSource.includes("dashboard:pause");
    const runtimeKillActive =
      effectiveConfig.overridesActive &&
      effectiveConfig.enabled === false &&
      runtimeOverrideSource.includes("dashboard:kill");
    const runtimeOverrideEnabledIgnored =
      effectiveConfig.overridesActive && effectiveConfig.enabled === false;
    const runtimeOverrideAllowBuyIgnored =
      effectiveConfig.overridesActive && effectiveConfig.allowBuy === false;
    const runtimeOverrideAllowSellIgnored =
      effectiveConfig.overridesActive && effectiveConfig.allowSell === false;
    const strategyAllowBuy = true;
    const strategyAllowSell = true;
    const latestTickerSnapshot = this.store.getRecentTickerSnapshots(this.config.symbol, 1)[0] ?? null;
    const defaultLowBtcGate =
      effectiveConfig.targetBtcNotionalUsd -
      (Math.max(effectiveConfig.targetBtcNotionalUsd, effectiveConfig.maxBtcNotionalUsd) -
        effectiveConfig.targetBtcNotionalUsd) /
        2;
    let normalizedBalancesCurrent: NormalizedBalances = normalizeBalancesForSymbol(
      this.config.symbol,
      this.store.getLatestBalances(),
      Number(latestTickerSnapshot?.mid ?? 0)
    );
    const makeQuoteInputs = (
      overrides: Partial<QuoteInputs> & { config?: Partial<QuoteInputs["config"]> } = {}
    ): QuoteInputs => ({
      ts: Number.isFinite(Number(overrides.ts)) ? Number(overrides.ts) : Date.now(),
      symbol: String(overrides.symbol ?? this.config.symbol),
      mid: Number.isFinite(Number(overrides.mid))
        ? Number(overrides.mid)
        : Number(latestTickerSnapshot?.mid ?? 0),
      bid: Number.isFinite(Number(overrides.bid))
        ? Number(overrides.bid)
        : Number(latestTickerSnapshot?.bid ?? 0),
      ask: Number.isFinite(Number(overrides.ask))
        ? Number(overrides.ask)
        : Number(latestTickerSnapshot?.ask ?? 0),
      marketSpreadBps: Number.isFinite(Number(overrides.marketSpreadBps))
        ? Number(overrides.marketSpreadBps)
        : calcSpreadBps(
            Number(latestTickerSnapshot?.bid ?? 0),
            Number(latestTickerSnapshot?.ask ?? 0),
            Number(latestTickerSnapshot?.mid ?? 0)
          ),
      volMoveBps: Number.isFinite(Number(overrides.volMoveBps)) ? Number(overrides.volMoveBps) : 0,
      trendMoveBps: Number.isFinite(Number(overrides.trendMoveBps))
        ? Number(overrides.trendMoveBps)
        : 0,
      usdFree: Number.isFinite(Number(overrides.usdFree))
        ? Number(overrides.usdFree)
        : normalizedBalancesCurrent.usdFree,
      usdTotal: Number.isFinite(Number(overrides.usdTotal))
        ? Number(overrides.usdTotal)
        : normalizedBalancesCurrent.usdTotal,
      btcFree: Number.isFinite(Number(overrides.btcFree))
        ? Number(overrides.btcFree)
        : normalizedBalancesCurrent.btcFree,
      btcTotal: Number.isFinite(Number(overrides.btcTotal))
        ? Number(overrides.btcTotal)
        : normalizedBalancesCurrent.btcTotal,
      btcNotionalUsd: Number.isFinite(Number(overrides.btcNotionalUsd))
        ? Number(overrides.btcNotionalUsd)
        : normalizedBalancesCurrent.btcNotionalUsd,
      inventoryRatio: Number.isFinite(Number(overrides.inventoryRatio))
        ? Number(overrides.inventoryRatio)
        : 0,
      signals:
        overrides.signals &&
        (overrides.signals.state === "NORMAL" ||
          overrides.signals.state === "CAUTION" ||
          overrides.signals.state === "RISK_OFF" ||
          overrides.signals.state === "RISK_ON" ||
          overrides.signals.state === "PAUSE")
          ? overrides.signals
          : {
              state: this.lastSignalsDecision.state,
              impact: this.lastSignalsDecision.impact,
              direction: this.lastSignalsDecision.direction,
              confidence: this.lastSignalsDecision.confidence,
              reasons: this.lastSignalsDecision.reasons,
              latestTs: this.lastSignalsSnapshot?.aggregate?.latestTs ?? 0
            },
      config: {
        levels:
          overrides.config && Number.isFinite(Number(overrides.config.levels))
            ? Math.max(0, Math.floor(Number(overrides.config.levels)))
            : this.config.levels,
        enableTopOfBook:
          overrides.config && typeof overrides.config.enableTopOfBook === "boolean"
            ? overrides.config.enableTopOfBook
            : effectiveConfig.tobEnabled,
        minInsideSpreadBps:
          overrides.config && Number.isFinite(Number(overrides.config.minInsideSpreadBps))
            ? Number(overrides.config.minInsideSpreadBps)
            : effectiveConfig.minMarketSpreadBps,
        minVolMoveBpsToQuote:
          overrides.config && Number.isFinite(Number(overrides.config.minVolMoveBpsToQuote))
            ? Number(overrides.config.minVolMoveBpsToQuote)
            : this.config.minVolMoveBpsToQuote,
        volProtectMode:
          overrides.config && typeof overrides.config.volProtectMode === "string"
            ? overrides.config.volProtectMode
            : this.config.volProtectMode,
        cashReserveUsd:
          overrides.config && Number.isFinite(Number(overrides.config.cashReserveUsd))
            ? Number(overrides.config.cashReserveUsd)
            : effectiveConfig.cashReserveUsd,
        workingCapUsd:
          overrides.config && Number.isFinite(Number(overrides.config.workingCapUsd))
            ? Number(overrides.config.workingCapUsd)
            : effectiveConfig.workingCapUsd,
        targetBtcNotionalUsd:
          overrides.config && Number.isFinite(Number(overrides.config.targetBtcNotionalUsd))
            ? Number(overrides.config.targetBtcNotionalUsd)
            : effectiveConfig.targetBtcNotionalUsd,
        lowBtcGateUsd:
          overrides.config && Number.isFinite(Number(overrides.config.lowBtcGateUsd))
            ? Number(overrides.config.lowBtcGateUsd)
            : defaultLowBtcGate,
        maxActionsPerLoop:
          overrides.config && Number.isFinite(Number(overrides.config.maxActionsPerLoop))
            ? Math.max(0, Math.floor(Number(overrides.config.maxActionsPerLoop)))
            : effectiveConfig.maxActionsPerLoop,
        maxBtcNotionalUsd:
          overrides.config && Number.isFinite(Number(overrides.config.maxBtcNotionalUsd))
            ? Number(overrides.config.maxBtcNotionalUsd)
            : effectiveConfig.maxBtcNotionalUsd,
        minBtcNotionalUsd:
          overrides.config && Number.isFinite(Number(overrides.config.minBtcNotionalUsd))
            ? Math.max(0, Number(overrides.config.minBtcNotionalUsd))
            : Math.max(0.01, this.config.quotingMinNotionalUsd),
        seedTargetBtcNotionalUsd:
          overrides.config && Number.isFinite(Number(overrides.config.seedTargetBtcNotionalUsd))
            ? Math.max(0, Number(overrides.config.seedTargetBtcNotionalUsd))
            : Math.max(0.01, this.config.seedTargetBtcNotionalUsd),
        seedForceTob:
          overrides.config && typeof overrides.config.seedForceTob === "boolean"
            ? overrides.config.seedForceTob
            : this.config.seedForceTob,
        seedEnabled:
          overrides.config && typeof overrides.config.seedEnabled === "boolean"
            ? overrides.config.seedEnabled
            : this.config.seedEnabled,
        allowBuy:
          overrides.config && typeof overrides.config.allowBuy === "boolean"
            ? overrides.config.allowBuy
            : strategyAllowBuy,
        allowSell:
          overrides.config && typeof overrides.config.allowSell === "boolean"
            ? overrides.config.allowSell
            : strategyAllowSell,
        minLevelsFloorEnabled:
          overrides.config && typeof overrides.config.minLevelsFloorEnabled === "boolean"
            ? overrides.config.minLevelsFloorEnabled
            : this.config.quotingMinLevelsFloorEnabled,
        minLevelsFloorBuy:
          overrides.config && Number.isFinite(Number(overrides.config.minLevelsFloorBuy))
            ? Math.max(0, Math.floor(Number(overrides.config.minLevelsFloorBuy)))
            : this.config.quotingMinLevelsFloorBuy,
        minLevelsFloorSell:
          overrides.config && Number.isFinite(Number(overrides.config.minLevelsFloorSell))
            ? Math.max(0, Math.floor(Number(overrides.config.minLevelsFloorSell)))
            : this.config.quotingMinLevelsFloorSell,
        pauseImpactThreshold:
          overrides.config && Number.isFinite(Number(overrides.config.pauseImpactThreshold))
            ? Number(overrides.config.pauseImpactThreshold)
            : this.config.intelPauseImpactThreshold,
        pauseConfidenceThreshold:
          overrides.config && Number.isFinite(Number(overrides.config.pauseConfidenceThreshold))
            ? Number(overrides.config.pauseConfidenceThreshold)
            : this.config.intelPauseConfidenceThreshold,
        pausePersistenceSeconds:
          overrides.config && Number.isFinite(Number(overrides.config.pausePersistenceSeconds))
            ? Math.max(0, Math.floor(Number(overrides.config.pausePersistenceSeconds)))
            : this.config.intelPausePersistenceSeconds
      }
    });
    const mapLegacyQuoteInputs = (inputs: QuoteInputs) => ({
      volMoveBps: inputs.volMoveBps,
      marketSpreadBps: inputs.marketSpreadBps,
      usd_free: inputs.usdFree,
      btcNotional: inputs.btcNotionalUsd,
      trendMoveBps: inputs.trendMoveBps,
      thresholds: {
        minVolMoveBpsToQuote: inputs.config.minVolMoveBpsToQuote,
        minMarketSpreadBps: inputs.config.minInsideSpreadBps,
        trendPauseBps: this.config.trendPauseBps,
        volProtectMode: this.config.volProtectMode,
        volWidenMultMin: this.config.volWidenMultMin,
        volWidenMultMax: this.config.volWidenMultMax
      }
    });
    const mapStatusQuoting = (
      plan: QuotePlan,
      ts: number,
      reconcile: ReconcileOutcome = {
        actionsUsed: 0,
        placed: 0,
        cancelled: 0,
        kept: 0,
        cancelReasonCounts: {},
        lastCancelReason: null,
        refreshSkipped: false,
        refreshSkipReason: ""
      },
      levels: {
        target?: { buy: number; sell: number; tob: "OFF" | "BUY" | "SELL" | "BOTH" };
        effective?: { buy: number; sell: number; tob: "OFF" | "BUY" | "SELL" | "BOTH" };
        minLevelsFloorApplied?: boolean;
      } = {},
      policy: {
        tobPolicy?: "JOIN" | "JOIN+1" | "JOIN+2" | "OFF";
        appliedSpreadMult?: number;
        appliedSizeMult?: number;
        makerMinEdgeBps?: number;
        takerMinEdgeBps?: number;
        takerFeeBps?: number;
        slippageBufferBps?: number;
        lastSeedOrderTs?: number;
        lowVolMode?: "KEEP_QUOTING";
        volMoveBps?: number;
        minVolMoveBps?: number;
        whyNotQuoting?: string;
        whyNotQuotingDetails?: string;
        lastPlannerOutputSummary?: PlannerOutputSummary;
        forceBaselineApplied?: boolean;
        overrideApplied?: boolean;
        overrideReasons?: string[];
        lastClampEvents?: BalanceClampEvent[];
        clampCounters?: Record<string, number>;
        marketPhase?: "SHOCK" | "COOLDOWN" | "STABILIZING" | "RECOVERY";
        phaseReasons?: string[];
        phaseSinceTs?: number;
        shockVolPeakBps?: number;
        inventoryAction?: InventoryAction;
        bands?: {
          floor: number;
          target: number;
          cap: number;
          hysteresis: number;
        };
        phaseAwareCaps?: {
          maxSellUsdPerHour: number;
          seedBuyUsd: number;
        };
        shockState?: "NORMAL" | "SHOCK" | "COOLDOWN" | "REENTRY";
        shockReasons?: string[];
        shockSinceTs?: number;
        reentryProgress?: {
          btcNotionalUsd: number;
          targetUsd: number;
          seedOrdersPlaced: number;
          lastSeedTs: number;
        };
        errorPolicy?: ErrorPolicySnapshot;
      } = {}
    ) => ({
      pausePolicy: {
        minLevelsFloorEnabled: this.config.quotingMinLevelsFloorEnabled,
        minLevelsFloor: {
          buy: Math.max(0, Math.floor(this.config.quotingMinLevelsFloorBuy)),
          sell: Math.max(0, Math.floor(this.config.quotingMinLevelsFloorSell))
        },
        pauseThresholds: {
          impact: this.config.intelPauseImpactThreshold,
          confidence: this.config.intelPauseConfidenceThreshold
        },
        persistenceSeconds: this.config.intelPausePersistenceSeconds
      },
      quoteEnabled: plan.quoteEnabled,
      hardHalt: plan.hardHalt,
      hardHaltReasons: plan.hardHaltReasons,
      quoteBlockedReasons: plan.blockedReasons,
      buyLevelsPlanned: plan.buyLevels,
      sellLevelsPlanned: plan.sellLevels,
      tobPlanned: plan.tob,
      effectiveTargetLevels: {
        buy: Math.max(
          0,
          Math.floor(
            Number(levels.effective?.buy ?? levels.target?.buy ?? plan.buyLevels) || 0
          )
        ),
        sell: Math.max(
          0,
          Math.floor(
            Number(levels.effective?.sell ?? levels.target?.sell ?? plan.sellLevels) || 0
          )
        ),
        tob:
          levels.effective?.tob ??
          levels.target?.tob ??
          plan.tob
      },
      targetLevels: {
        buy: Math.max(0, Math.floor(Number(levels.target?.buy ?? plan.buyLevels) || 0)),
        sell: Math.max(0, Math.floor(Number(levels.target?.sell ?? plan.sellLevels) || 0)),
        tob: levels.target?.tob ?? plan.tob
      },
      minLevelsFloorApplied: levels.minLevelsFloorApplied === true,
      tobPolicy:
        policy.tobPolicy === "JOIN" ||
        policy.tobPolicy === "JOIN+1" ||
        policy.tobPolicy === "JOIN+2" ||
        policy.tobPolicy === "OFF"
          ? policy.tobPolicy
          : plan.hardHalt
            ? "OFF"
            : "JOIN",
      appliedSpreadMult: Number.isFinite(Number(policy.appliedSpreadMult))
        ? Number(policy.appliedSpreadMult)
        : 1,
      appliedSizeMult: Number.isFinite(Number(policy.appliedSizeMult))
        ? Number(policy.appliedSizeMult)
        : 1,
      makerMinEdgeBps: Number.isFinite(Number(policy.makerMinEdgeBps))
        ? Math.max(0, Number(policy.makerMinEdgeBps))
        : Math.max(0, this.config.minMakerEdgeBps),
      takerMinEdgeBps: Number.isFinite(Number(policy.takerMinEdgeBps))
        ? Math.max(0, Number(policy.takerMinEdgeBps))
        : Math.max(0, this.config.minTakerEdgeBps),
      takerFeeBps: Number.isFinite(Number(policy.takerFeeBps))
        ? Math.max(0, Number(policy.takerFeeBps))
        : Math.max(0, this.config.takerFeeBps),
      slippageBufferBps: Number.isFinite(Number(policy.slippageBufferBps))
        ? Math.max(0, Number(policy.slippageBufferBps))
        : Math.max(0, this.config.takerSlipBps),
      seeding: {
        active: plan.seedMode === "SEED_BUY" || plan.seedMode === "ACCUMULATE_BTC",
        mode: (
          plan.seedMode === "SEED_BUY" || plan.seedMode === "ACCUMULATE_BTC"
            ? "ACCUMULATE_BTC"
            : plan.seedMode === "REBALANCE"
              ? "REBALANCE"
              : "TWO_SIDED"
        ) as "ACCUMULATE_BTC" | "TWO_SIDED" | "REBALANCE",
        btcNotionalUsd: Number.isFinite(Number(plan.seedProgress?.btcNotionalUsd))
          ? Number(plan.seedProgress?.btcNotionalUsd)
          : 0,
        targetUsd: Number.isFinite(Number(plan.seedProgress?.targetUsd))
          ? Number(plan.seedProgress?.targetUsd)
          : 0,
        lastSeedOrderTs: Number.isFinite(Number(policy.lastSeedOrderTs))
          ? Math.max(0, Number(policy.lastSeedOrderTs))
          : 0,
        reason: typeof plan.seedReason === "string" ? plan.seedReason : ""
      },
      lowVolMode:
        policy.lowVolMode === "KEEP_QUOTING"
          ? policy.lowVolMode
          : this.config.quotingLowVolMode,
      volMoveBps: Number.isFinite(Number(policy.volMoveBps))
        ? Number(policy.volMoveBps)
        : undefined,
      minVolMoveBps: Number.isFinite(Number(policy.minVolMoveBps))
        ? Number(policy.minVolMoveBps)
        : undefined,
      whyNotQuoting:
        typeof policy.whyNotQuoting === "string" && policy.whyNotQuoting.trim().length > 0
          ? policy.whyNotQuoting.trim()
          : undefined,
      whyNotQuotingDetails:
        typeof policy.whyNotQuotingDetails === "string" && policy.whyNotQuotingDetails.trim().length > 0
          ? policy.whyNotQuotingDetails.trim()
          : undefined,
      lastPlannerOutputSummary:
        policy.lastPlannerOutputSummary && typeof policy.lastPlannerOutputSummary === "object"
          ? {
              ...policy.lastPlannerOutputSummary
            }
          : undefined,
      forceBaselineApplied: policy.forceBaselineApplied === true,
      overrideApplied: policy.overrideApplied === true,
      overrideReasons: Array.isArray(policy.overrideReasons)
        ? policy.overrideReasons.map((reason) => String(reason))
        : [],
      lastClampEvents: Array.isArray(policy.lastClampEvents)
        ? policy.lastClampEvents
            .map((event) => ({
              ts: Math.max(0, Math.floor(Number(event.ts) || 0)),
              side: (event.side === "SELL" ? "SELL" : "BUY") as Side,
              tag: String(event.tag || "-"),
              reason: String(event.reason || ""),
              beforeQuoteUsd: Number.isFinite(Number(event.beforeQuoteUsd))
                ? Number(event.beforeQuoteUsd)
                : 0,
              afterQuoteUsd: Number.isFinite(Number(event.afterQuoteUsd))
                ? Number(event.afterQuoteUsd)
                : 0,
              beforeBaseQtyBtc: Number.isFinite(Number(event.beforeBaseQtyBtc))
                ? Number(event.beforeBaseQtyBtc)
                : 0,
              afterBaseQtyBtc: Number.isFinite(Number(event.afterBaseQtyBtc))
                ? Number(event.afterBaseQtyBtc)
                : 0,
              details: String(event.details || "")
            }))
            .slice(-20)
        : [],
      clampCounters:
        policy.clampCounters && typeof policy.clampCounters === "object"
          ? { ...policy.clampCounters }
          : {},
      marketPhase:
        policy.marketPhase === "SHOCK" ||
        policy.marketPhase === "COOLDOWN" ||
        policy.marketPhase === "STABILIZING" ||
        policy.marketPhase === "RECOVERY"
          ? policy.marketPhase
          : undefined,
      phaseReasons: Array.isArray(policy.phaseReasons)
        ? policy.phaseReasons.map((reason) => String(reason))
        : [],
      phaseSinceTs: Number.isFinite(Number(policy.phaseSinceTs))
        ? Math.max(0, Number(policy.phaseSinceTs))
        : undefined,
      shockVolPeakBps: Number.isFinite(Number(policy.shockVolPeakBps))
        ? Math.max(0, Number(policy.shockVolPeakBps))
        : undefined,
      inventoryAction:
        policy.inventoryAction === "ACCUMULATE" ||
        policy.inventoryAction === "DISTRIBUTE" ||
        policy.inventoryAction === "HOLD"
          ? policy.inventoryAction
          : undefined,
      bands:
        policy.bands && typeof policy.bands === "object"
          ? {
              floor: Number.isFinite(Number(policy.bands.floor))
                ? Number(policy.bands.floor)
                : 0,
              target: Number.isFinite(Number(policy.bands.target))
                ? Number(policy.bands.target)
                : 0,
              cap: Number.isFinite(Number(policy.bands.cap))
                ? Number(policy.bands.cap)
                : 0,
              hysteresis: Number.isFinite(Number(policy.bands.hysteresis))
                ? Number(policy.bands.hysteresis)
                : 0
            }
          : undefined,
      phaseAwareCaps:
        policy.phaseAwareCaps && typeof policy.phaseAwareCaps === "object"
          ? {
              maxSellUsdPerHour: Number.isFinite(Number(policy.phaseAwareCaps.maxSellUsdPerHour))
                ? Number(policy.phaseAwareCaps.maxSellUsdPerHour)
                : 0,
              seedBuyUsd: Number.isFinite(Number(policy.phaseAwareCaps.seedBuyUsd))
                ? Number(policy.phaseAwareCaps.seedBuyUsd)
                : 0
            }
          : undefined,
      shockState:
        policy.shockState === "SHOCK" ||
        policy.shockState === "COOLDOWN" ||
        policy.shockState === "REENTRY" ||
        policy.shockState === "NORMAL"
          ? policy.shockState
          : policy.marketPhase === "SHOCK"
            ? "SHOCK"
            : policy.marketPhase === "COOLDOWN"
              ? "COOLDOWN"
              : policy.marketPhase === "RECOVERY"
                ? "REENTRY"
                : "NORMAL",
      shockReasons: Array.isArray(policy.shockReasons)
        ? policy.shockReasons.map((reason) => String(reason))
        : Array.isArray(policy.phaseReasons)
          ? policy.phaseReasons.map((reason) => String(reason))
          : [],
      shockSinceTs: Number.isFinite(Number(policy.shockSinceTs))
        ? Math.max(0, Number(policy.shockSinceTs))
        : Number.isFinite(Number(policy.phaseSinceTs))
          ? Math.max(0, Number(policy.phaseSinceTs))
          : undefined,
      reentryProgress:
        policy.reentryProgress && typeof policy.reentryProgress === "object"
          ? {
              btcNotionalUsd: Number.isFinite(Number(policy.reentryProgress.btcNotionalUsd))
                ? Number(policy.reentryProgress.btcNotionalUsd)
                : 0,
              targetUsd: Number.isFinite(Number(policy.reentryProgress.targetUsd))
                ? Number(policy.reentryProgress.targetUsd)
                : 0,
              seedOrdersPlaced: Number.isFinite(Number(policy.reentryProgress.seedOrdersPlaced))
                ? Math.max(0, Math.floor(Number(policy.reentryProgress.seedOrdersPlaced)))
                : 0,
              lastSeedTs: Number.isFinite(Number(policy.reentryProgress.lastSeedTs))
                ? Math.max(0, Math.floor(Number(policy.reentryProgress.lastSeedTs)))
                : 0
            }
          : undefined,
      errorPolicy:
        policy.errorPolicy && typeof policy.errorPolicy === "object"
          ? {
              recoverableCount5m: Math.max(0, Math.floor(Number(policy.errorPolicy.recoverableCount5m) || 0)),
              lastRecoverableError: String(policy.errorPolicy.lastRecoverableError || ""),
              transientBackoffMs: Math.max(0, Math.floor(Number(policy.errorPolicy.transientBackoffMs) || 0)),
              hardHalt: Boolean(policy.errorPolicy.hardHalt),
              hardHaltReason: String(policy.errorPolicy.hardHaltReason || "")
            }
          : undefined,
      cancelReasonCounts: reconcile.cancelReasonCounts,
      lastCancelReason: reconcile.lastCancelReason,
      cycleActions: {
        placed: reconcile.placed,
        cancelled: reconcile.cancelled,
        kept: reconcile.kept,
        refreshSkipped: reconcile.refreshSkipped,
        refreshSkipReason: reconcile.refreshSkipReason
      },
      newsState: plan.newsState,
      newsImpact: plan.newsImpact,
      newsDirection: plan.newsDirection,
      newsConfidence: plan.newsConfidence,
      newsReasons: plan.newsReasons,
      signalsState: plan.signalsState,
      signalsImpact: plan.signalsImpact,
      signalsDirection: plan.signalsDirection,
      signalsConfidence: plan.signalsConfidence,
      signalsReasons: plan.signalsReasons,
      adverseState: plan.adverseState,
      toxicityScore: plan.toxicityScore,
      adverseReasons: plan.adverseReasons,
      regime: plan.regime,
      bias: plan.bias,
      biasConfidence: plan.biasConfidence,
      signalConfidence: plan.signalConfidence,
      globalMid: plan.globalMid,
      fairMid: plan.fairMid,
      basisBps: plan.basisBps,
      dispersionBps: plan.dispersionBps,
      lastDecisionTs: ts
    });
    const mapAdverseSelectionStatus = () => ({
      adverse_selection_avg_bps: this.asLastSummary.asAvgBps,
      adverse_selection_bad_rate: this.asLastSummary.asBadRate,
      adverse_selection_last_bps: this.asLastSummary.asLastBps,
      adverse_selection_samples: this.asLastSummary.asSamples,
      adverse_selection_toxic: this.asLastSummary.asToxic,
      adverse_selection_widen_bps: this.asLastSummary.asWidenBps,
      adverse_selection_cooldown_seconds: this.asLastSummary.asCooldownRemainingSeconds,
      adverse_state: this.lastAdverseDecision.state,
      adverse_toxicity_score: this.lastAdverseDecision.toxicityScore,
      adverse_spread_mult: this.lastAdverseDecision.adverseSpreadMult,
      news_state: this.lastNewsDecision.state,
      news_impact: this.lastNewsDecision.impact,
      news_direction: this.lastNewsDecision.direction,
      news_confidence: this.lastNewsDecision.confidence,
      news_last_ts: this.lastNewsDecision.lastHeadlineTs,
      signals_state: this.lastSignalsDecision.state,
      signals_impact: this.lastSignalsDecision.impact,
      signals_direction: this.lastSignalsDecision.direction,
      signals_confidence: this.lastSignalsDecision.confidence,
      signals_last_ts: this.lastSignalsSnapshot?.aggregate?.latestTs ?? 0,
      signal_regime: this.lastHybridSignal?.regime ?? "CALM",
      signal_bias: this.lastHybridSignal?.bias ?? "NEUTRAL",
      signal_bias_confidence: this.lastHybridSignal?.biasConfidence ?? 0
    });
    const publishQuoteDebug = (
      plan: QuotePlan,
      inputs: QuoteInputs,
      normalizedBalancesUsed: NormalizedBalances = normalizedBalancesCurrent
    ): void => {
      quoteDebugState.update(plan, inputs, inputs.ts, normalizedBalancesUsed);
      seedDebugState.update({
        seedMode: plan.seedMode ?? "TWO_SIDED",
        seedStartTs: this.seedStartTs,
        seedReposts: this.seedReposts,
        seedTakerFired: this.seedTakerFired,
        lastSeedOrderIds: {
          clientOrderId: this.seedTakerClientOrderId,
          venueOrderId: this.seedTakerVenueOrderId
        },
        btcNotionalUsd:
          plan.seedProgress && Number.isFinite(Number(plan.seedProgress.btcNotionalUsd))
            ? Number(plan.seedProgress.btcNotionalUsd)
            : inputs.btcNotionalUsd,
        lowGateUsd:
          plan.seedProgress && Number.isFinite(Number(plan.seedProgress.lowGateUsd))
            ? Number(plan.seedProgress.lowGateUsd)
            : Number(inputs.config.lowBtcGateUsd) || 0,
        targetUsd:
          plan.seedProgress && Number.isFinite(Number(plan.seedProgress.targetUsd))
            ? Number(plan.seedProgress.targetUsd)
            : Number(inputs.config.targetBtcNotionalUsd) || 0,
        blockedReasons: plan.blockedReasons,
        lastUpdatedTs: inputs.ts
      });
      this.logQuoteBlockedIfNeeded(plan, inputs);
    };
    this.lastNewsSnapshot = this.newsEngine?.getSnapshot() ?? null;
    this.lastNewsDecision = this.newsGuard.evaluate({
      ts: Date.now(),
      snapshot: this.lastNewsSnapshot,
      regime: this.lastHybridSignal?.regime ?? "CALM",
      adverseState: this.lastAdverseDecision.state,
      inventoryRatio: 0
    });
    this.lastSignalsSnapshot = this.signalsEngine?.getSnapshot() ?? null;
    this.lastSignalsDecision = this.signalsGuard.evaluate({
      ts: Date.now(),
      aggregate: this.lastSignalsSnapshot?.aggregate ?? null,
      inventoryRatio: 0,
      allowTakerFlatten: this.config.seedEnabled || this.config.enableTakerSeed || this.config.hedgeEnabled
    });

    if (this.runtimeHardHalt.active) {
      const now = Date.now();
      const latestMid = this.store.getRecentTickerSnapshots(this.config.symbol, 1)[0]?.mid ?? 0;
      const reason = this.runtimeHardHalt.reason || "RUNTIME_HARD_HALT";
      const quoteInputs = makeQuoteInputs({
        ts: now,
        mid: latestMid
      });
      const quotePlan = buildQuotePlan({
        inputs: quoteInputs,
        buyLevels: 0,
        sellLevels: 0,
        tobMode: "OFF",
        blockedReasons: [reason],
        hardHaltReasons: [reason]
      });
      publishQuoteDebug(quotePlan, quoteInputs);
      this.store.upsertBotStatus({
        ts: now,
        mid: latestMid,
        exposure_usd: 0,
        allow_buy: false,
        allow_sell: false,
        buy_reasons: [reason],
        sell_reasons: [reason],
        quoting: mapStatusQuoting(quotePlan, now, undefined, {}, {
          errorPolicy: this.getErrorPolicySnapshot(now)
        }),
        quoting_inputs: mapLegacyQuoteInputs(quoteInputs),
        error_policy: this.getErrorPolicySnapshot(now),
        ...mapAdverseSelectionStatus()
      });
      this.logger.warn(
        { sinceTs: this.runtimeHardHalt.sinceTs, reason: this.runtimeHardHalt.reason },
        "Runtime hard halt active"
      );
      return;
    }

    const cooldownSoftActive = Date.now() < this.cooldownUntilMs;
    const cooldownSoftReason = cooldownSoftActive
      ? `COOLDOWN_SOFT_ACTIVE (until=${new Date(this.cooldownUntilMs).toISOString()} reason=${this.cooldownReason || "volatility"})`
      : "";
    if (cooldownSoftActive) {
      this.logger.warn(
        { until: new Date(this.cooldownUntilMs).toISOString(), reason: this.cooldownReason },
        "Strategy cooldown active (soft)"
      );
    }

    if (this.privateCallBackoffUntilTs > Date.now()) {
      const remainingMs = this.privateCallBackoffUntilTs - Date.now();
      this.logger.warn(
        { remainingMs, reason: "TRANSIENT_PRIVATE_CALL_BACKOFF" },
        "Transient backoff active for private API calls"
      );
      await sleep(Math.min(1_500, Math.max(50, remainingMs)));
    }

    if (effectiveConfig.overridesActive && runtimeOverrideValidationIssues.length > 0) {
      const now = Date.now();
      const details = runtimeOverrideValidationIssues.join("; ");
      const reason = `INVALID_OVERRIDE_VALUES (${details})`;
      const quoteInputs = makeQuoteInputs({ ts: now });
      const quotePlan = buildQuotePlan({
        inputs: quoteInputs,
        buyLevels: 0,
        sellLevels: 0,
        tobMode: "OFF",
        blockedReasons: [reason]
      });
      publishQuoteDebug(quotePlan, quoteInputs);
      this.store.upsertBotStatus({
        ts: now,
        mid: this.store.getRecentTickerSnapshots(this.config.symbol, 1)[0]?.mid ?? 0,
        exposure_usd: 0,
        allow_buy: false,
        allow_sell: false,
        buy_reasons: [reason],
        sell_reasons: [reason],
        quoting: mapStatusQuoting(quotePlan, now, undefined, {}, {
          whyNotQuoting: "INVALID_OVERRIDE_VALUES",
          whyNotQuotingDetails: details,
          overrideApplied: true,
          overrideReasons: runtimeOverrideValidationIssues,
          errorPolicy: this.getErrorPolicySnapshot(now)
        }),
        quoting_inputs: mapLegacyQuoteInputs(quoteInputs),
        error_policy: this.getErrorPolicySnapshot(now),
        ...mapAdverseSelectionStatus()
      });
      this.logger.error(
        {
          symbol: this.config.symbol,
          overrideIssues: runtimeOverrideValidationIssues,
          runtimeOverrides: runtimeOverridesRecord
        },
        "Invalid runtime override values blocked quoting"
      );
      return;
    }

    const latest = this.reconciler.getLatestState();
    if (!latest || Date.now() - latest.ts > this.config.reconcileSeconds * 1500) {
      await this.reconcileOnceWithTimeout(10_000);
    }

    const ticker = await this.marketData.getTicker(this.config.symbol);
    const adverseSelection = this.updateAdverseSelectionState(Date.now(), ticker.mid);
    const tickerAgeMs = Date.now() - ticker.ts;
    if (tickerAgeMs > this.config.hardHaltStaleMarketDataSeconds * 1000) {
      const reason = `MARKET_DATA_STALE_HARD_HALT (ageMs=${tickerAgeMs} > ${this.config.hardHaltStaleMarketDataSeconds * 1000})`;
      this.activateRuntimeHardHalt(reason);
      const quoteInputs = makeQuoteInputs({
        ts: Date.now(),
        mid: ticker.mid,
        bid: ticker.bid,
        ask: ticker.ask,
        marketSpreadBps: calcSpreadBps(ticker.bid, ticker.ask, ticker.mid)
      });
      const quotePlan = buildQuotePlan({
        inputs: quoteInputs,
        buyLevels: 0,
        sellLevels: 0,
        tobMode: "OFF",
        blockedReasons: [reason],
        hardHaltReasons: [reason]
      });
      publishQuoteDebug(quotePlan, quoteInputs);
      this.store.upsertBotStatus({
        ts: quoteInputs.ts,
        mid: ticker.mid,
        exposure_usd: 0,
        allow_buy: false,
        allow_sell: false,
        buy_reasons: [reason],
        sell_reasons: [reason],
        quoting: mapStatusQuoting(quotePlan, quoteInputs.ts, undefined, {}, {
          errorPolicy: this.getErrorPolicySnapshot(quoteInputs.ts)
        }),
        quoting_inputs: mapLegacyQuoteInputs(quoteInputs),
        error_policy: this.getErrorPolicySnapshot(quoteInputs.ts),
        ...mapAdverseSelectionStatus()
      });
      return;
    }
    if (tickerAgeMs > 5_000) {
      const reason = `STALE_TICKER_SOFT (ageMs=${tickerAgeMs})`;
      this.recordRecoverableError(reason);
      const quoteInputs = makeQuoteInputs({
        ts: Date.now(),
        mid: ticker.mid,
        bid: ticker.bid,
        ask: ticker.ask,
        marketSpreadBps: calcSpreadBps(ticker.bid, ticker.ask, ticker.mid)
      });
      const quotePlan = buildQuotePlan({
        inputs: quoteInputs,
        buyLevels: 0,
        sellLevels: 0,
        tobMode: "OFF",
        blockedReasons: [reason]
      });
      publishQuoteDebug(quotePlan, quoteInputs);
      this.store.upsertBotStatus({
        ts: quoteInputs.ts,
        mid: ticker.mid,
        exposure_usd: 0,
        allow_buy: false,
        allow_sell: false,
        buy_reasons: [reason],
        sell_reasons: [reason],
        quoting: mapStatusQuoting(quotePlan, quoteInputs.ts, undefined, {}, {
          errorPolicy: this.getErrorPolicySnapshot(quoteInputs.ts)
        }),
        quoting_inputs: mapLegacyQuoteInputs(quoteInputs),
        error_policy: this.getErrorPolicySnapshot(quoteInputs.ts),
        ...mapAdverseSelectionStatus()
      });
      this.logger.warn(
        { symbol: this.config.symbol, tickerTs: ticker.ts, tickerAgeMs },
        "Stale ticker; soft skip cycle"
      );
      return;
    }

    this.store.recordMidSnapshot({
      symbol: ticker.symbol,
      bid: ticker.bid,
      ask: ticker.ask,
      mid: ticker.mid,
      last: ticker.last,
      ts: ticker.ts
    });

    this.recordMid(ticker.mid, ticker.ts);
    const signalState = this.signalEngine.update(ticker.mid, ticker.ts);
    let crossVenue: CrossVenueComputation | null = null;
    if (this.config.enableCrossVenueSignals) {
      try {
        crossVenue = await this.crossVenueSignalEngine.compute(
          this.config.symbol,
          ticker.mid,
          ticker.ts
        );
        for (const snapshot of crossVenue.rawSnapshots) {
          this.store.recordExternalPriceSnapshot(snapshot);
        }
        this.store.recordSignalSnapshot(crossVenue.signal);
      } catch (error) {
        this.logger.warn({ error }, "Cross-venue signal compute failed");
      }
    }
    const crossSignalSnapshot = crossVenue?.signal ?? null;
    const hybridSignal = this.hybridSignalEngine.computeFromQuotes(
      this.config.symbol,
      ticker.mid,
      (crossVenue?.rawSnapshots ?? []).map((row) => ({
        venue: row.venue,
        symbol: row.symbol,
        quote: row.quote,
        ts: row.ts,
        bid: row.bid,
        ask: row.ask,
        mid: row.mid,
        spread_bps: row.spread_bps,
        latency_ms: row.latency_ms,
        ok: row.ok,
        error: row.error ? String(row.error) : ""
      })),
      ticker.ts
    );
    this.lastHybridSignal = hybridSignal;
    signalDebugState.update(hybridSignal, hybridSignal.venues, this.hybridSignalEngine.getLastError());

    const fairMidForGuards =
      this.config.enableFairPrice &&
      Number.isFinite(Number(hybridSignal.fairMid)) &&
      Number(hybridSignal.fairMid) > 0
        ? Number(hybridSignal.fairMid)
        : this.config.enableFairPrice &&
            Number.isFinite(Number(crossSignalSnapshot?.fair_mid)) &&
            Number(crossSignalSnapshot?.fair_mid) > 0
          ? Number(crossSignalSnapshot?.fair_mid)
          : ticker.mid;
    const fairDispersionBps =
      this.config.enableFairPrice && Number.isFinite(Number(hybridSignal.dispersionBps))
        ? Number(hybridSignal.dispersionBps)
        : this.config.enableFairPrice && Number.isFinite(Number(crossSignalSnapshot?.dispersion_bps))
          ? Number(crossSignalSnapshot?.dispersion_bps)
          : 0;
    const fairBasisBps =
      this.config.enableFairPrice && Number.isFinite(Number(hybridSignal.basisBps))
        ? Number(hybridSignal.basisBps)
        : this.config.enableFairPrice && Number.isFinite(Number(crossSignalSnapshot?.basis_bps))
          ? Number(crossSignalSnapshot?.basis_bps)
          : 0;
    const fairDriftBps =
      this.config.enableFairPrice && Number.isFinite(Number(hybridSignal.driftBps))
        ? Number(hybridSignal.driftBps)
        : this.config.enableFairPrice && Number.isFinite(Number(crossSignalSnapshot?.drift_bps))
          ? Number(crossSignalSnapshot?.drift_bps)
          : 0;
    const fairVolRegime = this.config.enableFairPrice
      ? String(hybridSignal.volRegimeLegacy ?? crossSignalSnapshot?.vol_regime ?? "normal").toLowerCase()
      : "normal";
    const noExternalVenues =
      !this.config.enableFairPrice ||
      hybridSignal.venues.filter((row) => row.ok && Number(row.mid) > 0).length <= 0;

    const marketSpreadBps = calcSpreadBps(ticker.bid, ticker.ask, ticker.mid);
    this.recordSpread(marketSpreadBps, ticker.ts);
    const volMoveBps = Math.abs(this.computeSignedMoveBps(this.config.volWindowSeconds));
    const volPauseSoftActive = volMoveBps >= this.config.volPauseBps;
    if (volPauseSoftActive) {
      this.startCooldown(
        this.config.pauseSecondsOnVol * 1000,
        `volatility ${volMoveBps.toFixed(2)} bps >= ${this.config.volPauseBps}`
      );
    }

    const lowInsideSpread = marketSpreadBps < effectiveConfig.minMarketSpreadBps;
    const lowMovement = volMoveBps < this.config.minVolMoveBpsToQuote;
    const lowVolMode: "KEEP_QUOTING" = this.config.quotingLowVolMode;
    const quoteBlockedReasons: string[] = [];
    if (cooldownSoftActive) {
      quoteBlockedReasons.push(cooldownSoftReason);
    }
    if (volPauseSoftActive) {
      quoteBlockedReasons.push(
        `VOL_SUPER_CAUTION (volMoveBps=${volMoveBps.toFixed(2)} >= pause=${this.config.volPauseBps.toFixed(2)})`
      );
    }

    let spreadMult = clamp(
      1 + volMoveBps / this.config.volPauseBps,
      this.config.volSpreadMultMin,
      this.config.volSpreadMultMax
    );
    if (lowInsideSpread) {
      quoteBlockedReasons.push(
        `INSIDE_SPREAD_BELOW_MIN (marketSpreadBps=${marketSpreadBps.toFixed(2)} < min=${effectiveConfig.minMarketSpreadBps.toFixed(2)})`
      );
    }

    const nowMs = Date.now();
    const rolling = this.store.getRollingMetrics(nowMs);
    const sellNotionalFilled1hUsd = computeSellNotionalUsdSince(
      this.store,
      nowMs - 60 * 60 * 1000
    );
    const edgeLookback = computeEdgeStatsSince(
      this.store,
      nowMs - this.config.edgeLookbackMinutes * 60 * 1000
    );
    const fillsInTargetWindow = this.store.getFillsSince(
      nowMs - this.config.targetFillsWindowMinutes * 60 * 1000
    ).length;
    const fillsInDroughtWindow = this.store.getFillsSince(
      nowMs - this.config.fillDroughtMinutes * 60 * 1000
    ).length;
    const adverseMarkouts = this.buildAdverseMarkouts(nowMs, Math.max(300, this.config.asSampleFills * 4));
    const adverseDecision = this.adverseGuard.update({
      ts: ticker.ts,
      regime: this.lastHybridSignal?.regime ?? "CALM",
      confidence: this.lastHybridSignal?.confidence ?? 0,
      basisBps: fairBasisBps,
      driftBps: fairDriftBps,
      asAvgBps: adverseSelection.asAvgBps,
      asBadRate: adverseSelection.asBadRate,
      asSamples: adverseSelection.asSamples,
      cancels1h: rolling.cancels_last_1h,
      rejects1h: rolling.post_only_rejects_last_1h,
      markouts: adverseMarkouts
    });
    this.lastAdverseDecision = adverseDecision;
    adverseDebugState.update(adverseDecision);
    this.lastNewsSnapshot = this.newsEngine?.getSnapshot() ?? null;
    let newsDecision = this.newsGuard.evaluate({
      ts: ticker.ts,
      snapshot: this.lastNewsSnapshot,
      regime: this.lastHybridSignal?.regime ?? "CALM",
      adverseState: adverseDecision.state,
      inventoryRatio: 0
    });
    newsDecision.state = this.applyRiskStateHysteresis(
      "news",
      newsDecision.state,
      ticker.ts,
      newsDecision.reasons
    ) as NewsGuardDecision["state"];
    this.lastNewsDecision = newsDecision;
    this.lastSignalsSnapshot = this.signalsEngine?.getSnapshot() ?? null;
    let signalsDecision = this.signalsGuard.evaluate({
      ts: ticker.ts,
      aggregate: this.lastSignalsSnapshot?.aggregate ?? null,
      inventoryRatio: 0,
      allowTakerFlatten: this.config.seedEnabled || this.config.enableTakerSeed || this.config.hedgeEnabled
    });
    signalsDecision.state = this.applyRiskStateHysteresis(
      "signals",
      signalsDecision.state,
      ticker.ts,
      signalsDecision.reasons
    ) as SignalsGuardDecision["state"];
    this.lastSignalsDecision = signalsDecision;
    const intelPosture =
      this.config.enableIntel
        ? this.intelEngine?.getPosture(ticker.ts) ?? this.lastIntelPosture
        : {
            ts: ticker.ts,
            state: "NORMAL" as const,
            impact: 0,
            direction: "NEUTRAL" as const,
            confidence: 0,
            widenBps: 0,
            sizeCut: 0,
            skewBps: 0,
            haltUntilTs: 0,
            reasons: []
          };
    const intelAdjustment =
      this.config.enableIntel
        ? this.intelEngine?.getAdjustment(ticker.ts, intelPosture) ?? {
            spreadMult: 1,
            sizeMult: 1,
            tobModeOverride: "UNCHANGED" as const,
            hardBlock: false,
            cooldownSeconds: 0,
            reasonCodes: []
          }
        : {
            spreadMult: 1,
            sizeMult: 1,
            tobModeOverride: "UNCHANGED" as const,
            hardBlock: false,
            cooldownSeconds: 0,
            reasonCodes: []
          };
    this.lastIntelPosture = intelPosture;
    this.lastIntelAdjustment = intelAdjustment;
    this.logIntelAdjustment(ticker.ts, intelPosture, intelAdjustment);
    if (this.config.enableIntel && intelPosture.state !== "NORMAL" && intelAdjustment.reasonCodes.length > 0) {
      for (const code of intelAdjustment.reasonCodes.slice(0, 3)) {
        quoteBlockedReasons.push(`INTEL_ADJUST (${code})`);
      }
    }
    let shockDecision = this.lastShockDecision;

    const effectiveHalfSpreadBeforeAdaptive = effectiveConfig.baseHalfSpreadBps * spreadMult;
    const adaptive = applyAdaptiveSpreadController(
      effectiveHalfSpreadBeforeAdaptive,
      {
        fills_last_30m: fillsInDroughtWindow,
        fills_last_1h: fillsInTargetWindow,
        avg_edge_total_last_1h: edgeLookback.avgTotal,
        cancels_last_1h: rolling.cancels_last_1h
      },
      this.config
    );
    let effectiveHalfSpread = adaptive.afterHalfSpreadBps;
    const softSpreadCapBps = clamp(
      adaptive.afterHalfSpreadBps * Math.max(1, this.config.intelMaxSpreadMult),
      this.config.minHalfSpreadBps,
      this.config.maxHalfSpreadBps
    );
    const cappedNewsSpreadMult = clamp(
      newsDecision.spreadMult,
      1,
      this.config.intelNewsMaxSpreadMult
    );
    if (cappedNewsSpreadMult > 1.0001) {
      effectiveHalfSpread = clamp(
        effectiveHalfSpread * cappedNewsSpreadMult,
        this.config.minHalfSpreadBps,
        this.config.maxHalfSpreadBps
      );
      quoteBlockedReasons.push(
        `NEWS_SPREAD_WIDEN (mult=${cappedNewsSpreadMult.toFixed(2)} impact=${newsDecision.impact.toFixed(2)})`
      );
    }
    if (newsDecision.pauseMakers) {
      const superCautionSpreadMult = clamp(
        1.10 + newsDecision.impact * 0.10,
        1.10,
        this.config.intelNewsMaxSpreadMult
      );
      effectiveHalfSpread = clamp(
        effectiveHalfSpread * superCautionSpreadMult,
        this.config.minHalfSpreadBps,
        this.config.maxHalfSpreadBps
      );
      quoteBlockedReasons.push(
        `NEWS_SUPER_CAUTION (spreadMult=${superCautionSpreadMult.toFixed(2)} impact=${newsDecision.impact.toFixed(2)})`
      );
    }
    if (newsDecision.reasons.length > 0) {
      for (const reason of newsDecision.reasons) {
        quoteBlockedReasons.push(reason);
      }
    }
    const cappedSignalsSpreadMult = clamp(signalsDecision.spreadMultExtra, 1, 1.25);
    if (cappedSignalsSpreadMult > 1.0001) {
      effectiveHalfSpread = clamp(
        effectiveHalfSpread * cappedSignalsSpreadMult,
        this.config.minHalfSpreadBps,
        this.config.maxHalfSpreadBps
      );
      quoteBlockedReasons.push(
        `SIGNALS_SPREAD_WIDEN (mult=${cappedSignalsSpreadMult.toFixed(2)} impact=${signalsDecision.impact.toFixed(2)} state=${signalsDecision.state})`
      );
      for (const reason of signalsDecision.reasons) {
        quoteBlockedReasons.push(reason);
      }
    }
    if (signalsDecision.pauseMakers) {
      const superCautionSpreadMult = 1.25;
      effectiveHalfSpread = clamp(
        effectiveHalfSpread * superCautionSpreadMult,
        this.config.minHalfSpreadBps,
        this.config.maxHalfSpreadBps
      );
      quoteBlockedReasons.push(
        `SIGNALS_SUPER_CAUTION (spreadMult=${superCautionSpreadMult.toFixed(2)} impact=${signalsDecision.impact.toFixed(2)} state=${signalsDecision.state})`
      );
    }
    if (this.config.enableIntel && intelAdjustment.spreadMult > 1.0001) {
      effectiveHalfSpread = clamp(
        effectiveHalfSpread * intelAdjustment.spreadMult,
        this.config.minHalfSpreadBps,
        this.config.maxHalfSpreadBps
      );
      quoteBlockedReasons.push(
        `INTEL_WIDEN_APPLIED (mult=${intelAdjustment.spreadMult.toFixed(2)}, state=${intelPosture.state}, impact=${intelPosture.impact.toFixed(2)})`
      );
    }
    if (shockDecision.actions.spreadMult > 1.0001) {
      effectiveHalfSpread = clamp(
        effectiveHalfSpread * shockDecision.actions.spreadMult,
        this.config.minHalfSpreadBps,
        this.config.maxHalfSpreadBps
      );
      quoteBlockedReasons.push(
        `SHOCK_SPREAD_WIDEN (state=${shockDecision.state} mult=${shockDecision.actions.spreadMult.toFixed(2)})`
      );
    }
    const adaptiveSpreadDeltaBps = adaptive.deltaBps;
    const adaptiveAdjustments = adaptive.adjustments;
    let toxicReduceLevels = false;
    let toxicDisableTob = false;
    const hardHaltReasons: string[] = [];
    const toxicGuardReasons: string[] = [];
    const toxicTriggers: string[] = [];
    if (this.config.enableAdverse && this.config.adverseEnabled && this.config.enableAdverseSelectionLoop) {
      const adverseSpreadMult = clamp(
        adverseDecision.recommendedSpreadMult,
        1,
        this.config.adverseMaxSpreadMult
      );
      effectiveHalfSpread = clamp(
        effectiveHalfSpread * adverseSpreadMult,
        this.config.minHalfSpreadBps,
        this.config.maxHalfSpreadBps
      );
      if (adverseSpreadMult > 1.001) {
        const reason = `ADVERSE_SPREAD_MULT_APPLIED (x${adverseSpreadMult.toFixed(2)})`;
        quoteBlockedReasons.push(reason);
        toxicGuardReasons.push(reason);
      }
      if (adverseDecision.state === "REDUCE") {
        toxicReduceLevels = true;
      } else if (adverseDecision.state === "PAUSE") {
        toxicReduceLevels = true;
        toxicDisableTob = true;
        quoteBlockedReasons.push("ADVERSE_PAUSE_SOFT");
      } else if (adverseDecision.state === "HEDGE") {
        toxicReduceLevels = true;
        toxicDisableTob = true;
        quoteBlockedReasons.push("ADVERSE_HEDGE_SOFT");
      }
      for (const reason of adverseDecision.reasons) {
        quoteBlockedReasons.push(reason);
      }
    }
    if (fairVolRegime === "hot") toxicTriggers.push("VOL_REGIME_HOT");
    if (fairDispersionBps > this.config.fairMaxDispersionBps) {
      toxicTriggers.push(
        `DISPERSION_HIGH (${fairDispersionBps.toFixed(2)} > ${this.config.fairMaxDispersionBps.toFixed(2)})`
      );
    }
    if (Math.abs(fairBasisBps) > this.config.fairMaxBasisBps) {
      toxicTriggers.push(
        `BASIS_HIGH (${Math.abs(fairBasisBps).toFixed(2)} > ${this.config.fairMaxBasisBps.toFixed(2)})`
      );
    }
    if (Math.abs(fairDriftBps) > this.config.toxicDriftBps) {
      toxicTriggers.push(
        `DRIFT_HIGH (${Math.abs(fairDriftBps).toFixed(2)} > ${this.config.toxicDriftBps.toFixed(2)})`
      );
    }
    if (noExternalVenues) {
      toxicGuardReasons.push("NO_EXTERNAL_VENUES (fallback to REVX mid)");
    }
    if (toxicTriggers.length > 0) {
      spreadMult *= 1.1;
      effectiveHalfSpread = clamp(
        effectiveHalfSpread * 1.1,
        this.config.minHalfSpreadBps,
        this.config.maxHalfSpreadBps
      );
      toxicReduceLevels = true;
      const reason = `TOXIC_GUARD (${toxicTriggers.join(", ")})`;
      quoteBlockedReasons.push(reason);
      toxicGuardReasons.push(reason);
    }
    if (
      fairDispersionBps > this.config.fairMaxDispersionBps * 2 ||
      Math.abs(fairDriftBps) > this.config.toxicDriftBps * 2
    ) {
      toxicReduceLevels = true;
      toxicDisableTob = true;
      const reason = "TOXIC_MARKET_SUPER_CAUTION";
      quoteBlockedReasons.push(reason);
      toxicGuardReasons.push(reason);
    }
    if (this.config.enableIntel && intelAdjustment.hardBlock) {
      toxicDisableTob = true;
      if (this.config.intelHardHaltOnly) {
        toxicReduceLevels = true;
        quoteBlockedReasons.push(
          `INTEL_HALT_SOFTENED (impact=${intelPosture.impact.toFixed(2)} conf=${intelPosture.confidence.toFixed(2)} hardHaltOnly=true)`
        );
      } else {
        hardHaltReasons.push(
          `INTEL_HALT_HARD (impact=${intelPosture.impact.toFixed(2)} conf=${intelPosture.confidence.toFixed(2)} guard=true)`
        );
      }
    } else if (this.config.enableIntel && intelPosture.state === "HALT") {
      quoteBlockedReasons.push(
        `INTEL_HALT_SOFT (impact=${intelPosture.impact.toFixed(2)} conf=${intelPosture.confidence.toFixed(2)} guard=false)`
      );
    }
    const asDefensive = adverseSelection.asToxic || adverseSelection.inCooldown;
    let asRequestedDisableTob = false;
    let asRequestedReduceLevels = false;
    if (this.config.enableAdverseSelectionLoop) {
      if (adverseSelection.asToxic) {
        const toxicReason = `AS_TOXIC (avg=${adverseSelection.asAvgBps.toFixed(2)} bps, bad_rate=${(adverseSelection.asBadRate * 100).toFixed(1)}%)`;
        quoteBlockedReasons.push(toxicReason);
        toxicGuardReasons.push(toxicReason);
      }
      if (adverseSelection.asWidenBps > 0) {
        effectiveHalfSpread = clamp(
          effectiveHalfSpread + adverseSelection.asWidenBps,
          this.config.minHalfSpreadBps,
          this.config.maxHalfSpreadBps
        );
        const widenReason = `AS_WIDEN_APPLIED (+${adverseSelection.asWidenBps.toFixed(2)} bps)`;
        quoteBlockedReasons.push(widenReason);
        toxicGuardReasons.push(widenReason);
      }
      if (asDefensive && this.config.asDisableTobOnToxic) {
        asRequestedDisableTob = true;
        quoteBlockedReasons.push("AS_TOB_DISABLED");
      }
      if (asDefensive && this.config.asReduceLevelsOnToxic) {
        asRequestedReduceLevels = true;
        quoteBlockedReasons.push("AS_LEVELS_REDUCED");
      }
    }
    if (effectiveHalfSpread > softSpreadCapBps) {
      const beforeCap = effectiveHalfSpread;
      effectiveHalfSpread = softSpreadCapBps;
      quoteBlockedReasons.push(
        `SOFT_SPREAD_CAP_APPLIED (${beforeCap.toFixed(2)} -> ${softSpreadCapBps.toFixed(2)} bps)`
      );
    }

    let signalEffectEnabled = false;
    let signalSkewBps = 0;
    let signalSpreadAction = "none";

    normalizedBalancesCurrent = normalizeBalancesForSymbol(
      this.config.symbol,
      this.store.getLatestBalances(),
      ticker.mid
    );
    const balances = {
      usd_free: normalizedBalancesCurrent.usdFree,
      usd_total: normalizedBalancesCurrent.usdTotal,
      btc_free: normalizedBalancesCurrent.btcFree,
      btc_total: normalizedBalancesCurrent.btcTotal,
      snapshot_ts: normalizedBalancesCurrent.ts
    };
    const reserveUsd = Math.max(0, Math.min(10, balances.usd_free * 0.10));
    const reserveBtc = Math.max(0, this.config.balanceReserveBtc);
    const balanceView = this.balanceManager.update({
      ts: balances.snapshot_ts,
      freeUsd: balances.usd_free,
      totalUsd: balances.usd_total,
      freeBtc: balances.btc_free,
      totalBtc: balances.btc_total,
      reservedUsd: reserveUsd,
      reservedBtc: reserveBtc
    });
    const spendableUsd = this.balanceManager.getSpendableUsd(reserveUsd);
    const spendableBtc = this.balanceManager.getSpendableBtc(reserveBtc);
    this.lastBalanceSnapshotRuntime = {
      freeUsd: balanceView.freeUsd,
      freeBtc: balanceView.freeBtc,
      reservedUsd: reserveUsd,
      reservedBtc: reserveBtc,
      spendableUsd,
      spendableBtc
    };

    const equityUsd = normalizedBalancesCurrent.equityUsd;
    const hasTargetOverride = effectiveConfig.activeOverrideKeys.includes("targetBtcNotionalUsd");
    const hasMaxOverride = effectiveConfig.activeOverrideKeys.includes("maxBtcNotionalUsd");
    const targetBtcNotionalUsd =
      this.config.dynamicTargetBtc && !hasTargetOverride
        ? Math.max(0, equityUsd * 0.5)
        : effectiveConfig.targetBtcNotionalUsd;
    const maxBtcNotionalUsd =
      this.config.dynamicTargetBtc && !hasMaxOverride
        ? targetBtcNotionalUsd + this.config.dynamicTargetBufferUsd
        : Math.max(targetBtcNotionalUsd, effectiveConfig.maxBtcNotionalUsd);
    const lowBtcGate =
      targetBtcNotionalUsd - (maxBtcNotionalUsd - targetBtcNotionalUsd) / 2;

    const btcNotional = normalizedBalancesCurrent.btcNotionalUsd;
    const seedModeEarly: "ACCUMULATE_BTC" | "TWO_SIDED" =
      btcNotional < Math.max(Math.max(0.01, this.config.quotingMinNotionalUsd), lowBtcGate)
        ? "ACCUMULATE_BTC"
        : "TWO_SIDED";
    const shouldApplyExtraVolWidening =
      this.config.quotingMinVolMoveBpsForExtraWidening > 0 &&
      volMoveBps >= this.config.quotingMinVolMoveBpsForExtraWidening;
    if (lowMovement && lowVolMode === "KEEP_QUOTING") {
      quoteBlockedReasons.push(
        `LOW_VOL_KEEP_QUOTING (volMoveBps=${volMoveBps.toFixed(2)} < min=${this.config.minVolMoveBpsToQuote.toFixed(2)}, mode=${lowVolMode})`
      );
    }
    if (
      shouldApplyExtraVolWidening &&
      this.config.volProtectMode === "widen" &&
      seedModeEarly !== "ACCUMULATE_BTC"
    ) {
      const widenMult = computeVolWidenMultiplier(
        volMoveBps,
        this.config.quotingMinVolMoveBpsForExtraWidening,
        this.config.volWidenMultMin,
        this.config.volWidenMultMax,
        this.config.volWidenInCalm,
        this.config.volWidenMultCalm
      );
      if (widenMult > 1.0001) {
        spreadMult *= widenMult;
        quoteBlockedReasons.push(
          `VOL_WIDEN_APPLIED (volMoveBps=${volMoveBps.toFixed(2)} >= minExtra=${this.config.quotingMinVolMoveBpsForExtraWidening.toFixed(2)} mode=${this.config.volProtectMode} mult=${widenMult.toFixed(2)})`
        );
      }
    }
    const inventoryError = btcNotional - targetBtcNotionalUsd;
    const invDenom = Math.max(1, maxBtcNotionalUsd - targetBtcNotionalUsd);
    const inventoryRatio = clamp(inventoryError / invDenom, -1, 1);
    newsDecision = this.newsGuard.evaluate({
      ts: ticker.ts,
      snapshot: this.lastNewsSnapshot,
      regime: this.lastHybridSignal?.regime ?? "CALM",
      adverseState: adverseDecision.state,
      inventoryRatio
    });
    newsDecision.state = this.applyRiskStateHysteresis(
      "news",
      newsDecision.state,
      ticker.ts,
      newsDecision.reasons
    ) as NewsGuardDecision["state"];
    this.lastNewsDecision = newsDecision;
    signalsDecision = this.signalsGuard.evaluate({
      ts: ticker.ts,
      aggregate: this.lastSignalsSnapshot?.aggregate ?? null,
      inventoryRatio,
      allowTakerFlatten: this.config.seedEnabled || this.config.enableTakerSeed || this.config.hedgeEnabled
    });
    signalsDecision.state = this.applyRiskStateHysteresis(
      "signals",
      signalsDecision.state,
      ticker.ts,
      signalsDecision.reasons
    ) as SignalsGuardDecision["state"];
    this.lastSignalsDecision = signalsDecision;
    const vol1mBps = this.computeRealizedVolBps(60);
    const vol5mBps = this.computeRealizedVolBps(300);
    const baselineSpreadBps = this.computeBaselineSpreadBps();
    const newLowInWindow = this.isNewLowInWindow(
      Math.max(this.config.reentryNoNewLowSeconds, 60),
      ticker.mid
    );
    const bookDepthScore = this.computeBookDepthScore(ticker.ts);
    const shockVolPeakBpsInput = Math.max(
      Number(this.lastShockDecision?.shockVolPeakBps || 0),
      vol1mBps
    );
    shockDecision = this.shockController.update({
      ts: ticker.ts,
      revxMid: ticker.mid,
      revxBid: ticker.bid,
      revxAsk: ticker.ask,
      spreadBps: marketSpreadBps,
      vol1mBps,
      vol5mBps,
      shockVolPeakBps: shockVolPeakBpsInput,
      newLowInWindow,
      dispersionBps: fairDispersionBps,
      bookDepthScore
    });
    this.lastShockDecision = shockDecision;
    const phase = shockDecision.phase;
    for (const reason of shockDecision.reasons) {
      quoteBlockedReasons.push(`PHASE_${phase}_${reason}`);
    }
    const inventorySkewBps = inventoryRatio * effectiveConfig.skewMaxBps;
    let skewBps = inventorySkewBps;
    let signalBiasSkewBps = 0;
    if (
      this.lastHybridSignal &&
      this.lastHybridSignal.confidence >= this.config.signalMinConf &&
      (this.lastHybridSignal.bias === "LONG" || this.lastHybridSignal.bias === "SHORT")
    ) {
      signalBiasSkewBps = mapSignalBiasToSkewBps(
        this.lastHybridSignal.bias,
        this.lastHybridSignal.biasConfidence,
        this.config.signalMaxSkewBps
      );
      skewBps += signalBiasSkewBps;
      quoteBlockedReasons.push(
        `SIGNAL_BIAS_${this.lastHybridSignal.bias} (skew=${signalBiasSkewBps.toFixed(2)} conf=${this.lastHybridSignal.biasConfidence.toFixed(2)})`
      );
    }
    if (this.config.enableAdverse && this.config.adverseEnabled && this.config.enableAdverseSelectionLoop) {
      skewBps += adverseDecision.recommendedSkewBps;
      if (Math.abs(adverseDecision.recommendedSkewBps) > 0.0001) {
        quoteBlockedReasons.push(
          `ADVERSE_SKEW_APPLIED (${adverseDecision.recommendedSkewBps.toFixed(2)} bps)`
        );
      }
    }
    if (this.config.enableIntel && Math.abs(intelPosture.skewBps) > 0.0001) {
      skewBps += intelPosture.skewBps;
      quoteBlockedReasons.push(
        `INTEL_SKEW_APPLIED (${intelPosture.skewBps.toFixed(2)} bps)`
      );
    }
    if (shockDecision.actions.sellSkewBps > 0) {
      skewBps += shockDecision.actions.sellSkewBps;
      quoteBlockedReasons.push(
        `SHOCK_SELL_SKEW_APPLIED (+${shockDecision.actions.sellSkewBps.toFixed(2)} bps)`
      );
    }
    if (shockDecision.actions.buySkewBps > 0) {
      skewBps -= shockDecision.actions.buySkewBps;
      quoteBlockedReasons.push(
        `REENTRY_BUY_SKEW_APPLIED (+${shockDecision.actions.buySkewBps.toFixed(2)} bps)`
      );
    }

    let bidHalfSpreadBps = effectiveHalfSpread + Math.max(0, skewBps);
    let askHalfSpreadBps = effectiveHalfSpread - Math.min(0, skewBps);

    const pnl = this.risk.evaluateDailyLoss(
      ticker.mid,
      [
        { asset: "USD", free: balances.usd_free, total: balances.usd_total, ts: balances.snapshot_ts },
        { asset: "BTC", free: balances.btc_free, total: balances.btc_total, ts: balances.snapshot_ts }
      ],
      "BTC",
      "USD"
    );
    if (pnl.tripped) {
      const lossReason = "DAILY_LOSS_TRIPPED (daily loss guard triggered)";
      this.activateRuntimeHardHalt(lossReason);
      const quoteInputs = makeQuoteInputs({
        ts: ticker.ts,
        symbol: this.config.symbol,
        mid: ticker.mid,
        bid: ticker.bid,
        ask: ticker.ask,
        marketSpreadBps,
        volMoveBps,
        usdFree: balances.usd_free,
        usdTotal: balances.usd_total,
        btcFree: balances.btc_free,
        btcTotal: balances.btc_total,
        btcNotionalUsd: btcNotional,
        inventoryRatio,
        config: {
          levels: Math.max(effectiveConfig.levelsBuy, effectiveConfig.levelsSell),
          enableTopOfBook: effectiveConfig.tobEnabled,
          minInsideSpreadBps: effectiveConfig.minMarketSpreadBps,
          minVolMoveBpsToQuote: this.config.minVolMoveBpsToQuote,
          volProtectMode: this.config.volProtectMode,
          cashReserveUsd: reserveUsd,
          workingCapUsd: effectiveConfig.workingCapUsd,
          targetBtcNotionalUsd,
          lowBtcGateUsd: lowBtcGate,
          maxActionsPerLoop: effectiveConfig.maxActionsPerLoop,
          maxBtcNotionalUsd,
          minBtcNotionalUsd: Math.max(0.01, this.config.quotingMinNotionalUsd),
          seedTargetBtcNotionalUsd: Math.max(0.01, this.config.seedTargetBtcNotionalUsd),
          seedForceTob: this.config.seedForceTob,
          seedEnabled: this.config.seedEnabled
        }
      });
      const quotePlan = buildQuotePlan({
        inputs: quoteInputs,
        buyLevels: 0,
        sellLevels: 0,
        tobMode: "OFF",
        blockedReasons: [lossReason],
        hardHaltReasons: [lossReason]
      });
      publishQuoteDebug(quotePlan, quoteInputs);
      await this.cancelAllIfNeeded("DAILY_LOSS_TRIPPED", 5_000);
      this.store.upsertBotStatus({
        ts: ticker.ts,
        mid: ticker.mid,
        exposure_usd: 0,
        allow_buy: false,
        allow_sell: false,
        buy_reasons: [lossReason],
        sell_reasons: [lossReason],
        quoting: mapStatusQuoting(quotePlan, ticker.ts, undefined, {}, {
          errorPolicy: this.getErrorPolicySnapshot(ticker.ts)
        }),
        quoting_inputs: mapLegacyQuoteInputs(quoteInputs),
        error_policy: this.getErrorPolicySnapshot(ticker.ts),
        ...mapAdverseSelectionStatus()
      });
      return;
    }

    const activeBotOrders = this.store.getActiveBotOrders(this.config.symbol);
    const buyOpenUsd = activeBotOrders
      .filter((o) => o.side === "BUY")
      .reduce((sum, o) => sum + o.quote_size, 0);

    const buyReasons: string[] = [];
    const sellReasons: string[] = [];
    for (const reason of toxicGuardReasons) {
      buyReasons.push(reason);
      sellReasons.push(reason);
    }

    if (effectiveConfig.overridesActive) {
      this.logger.debug(
        {
          symbol: this.config.symbol,
          activeOverrideKeys: effectiveConfig.activeOverrideKeys,
          overrideSource: effectiveConfig.overrideSource
        },
        "Runtime overrides active (non-blocking)"
      );
      if (runtimeOverrideEnabledIgnored) {
        const reason = "OVERRIDE_ENABLED_FALSE_IGNORED (enabled=false is non-blocking)";
        buyReasons.push(reason);
        sellReasons.push(reason);
      }
      if (runtimeOverrideAllowBuyIgnored) {
        const reason = "OVERRIDE_ALLOW_BUY_FALSE_IGNORED (non-blocking)";
        buyReasons.push(reason);
        sellReasons.push(reason);
      }
      if (runtimeOverrideAllowSellIgnored) {
        const reason = "OVERRIDE_ALLOW_SELL_FALSE_IGNORED (non-blocking)";
        buyReasons.push(reason);
        sellReasons.push(reason);
      }
    }

    if (adaptiveAdjustments.length > 0) {
      const msg = `Adaptive spread delta=${adaptiveSpreadDeltaBps.toFixed(2)} bps reasons=${adaptiveAdjustments.join(",")} (fills30m=${rolling.fills_last_30m}, fills1h=${rolling.fills_last_1h})`;
      buyReasons.push(msg);
      sellReasons.push(msg);
    }

    let buyLevels = effectiveConfig.levelsBuy;
    let sellLevels = effectiveConfig.levelsSell;
    const initialSellLevels = sellLevels;
    if (toxicReduceLevels) {
      const beforeBuy = buyLevels;
      const beforeSell = sellLevels;
      buyLevels = Math.max(0, buyLevels - 1);
      sellLevels = Math.max(0, sellLevels - 1);
      buyReasons.push(
        `Toxic guard reduced BUY levels ${beforeBuy} -> ${buyLevels} (regime=${fairVolRegime}, dispersion=${fairDispersionBps.toFixed(2)}, drift=${fairDriftBps.toFixed(2)})`
      );
      sellReasons.push(
        `Toxic guard reduced SELL levels ${beforeSell} -> ${sellLevels} (regime=${fairVolRegime}, dispersion=${fairDispersionBps.toFixed(2)}, drift=${fairDriftBps.toFixed(2)})`
      );
    }
    if (asRequestedReduceLevels) {
      const floor = Math.max(0, this.config.asLevelsFloor);
      const beforeBuy = buyLevels;
      const beforeSell = sellLevels;
      buyLevels = buyLevels > 0 ? Math.max(floor, buyLevels - 1) : 0;
      sellLevels = sellLevels > 0 ? Math.max(floor, sellLevels - 1) : 0;
      buyReasons.push(
        `AS_LEVELS_REDUCED (BUY ${beforeBuy} -> ${buyLevels}, floor=${floor}, toxic=${adverseSelection.asToxic}, cooldown=${adverseSelection.asCooldownRemainingSeconds}s)`
      );
      sellReasons.push(
        `AS_LEVELS_REDUCED (SELL ${beforeSell} -> ${sellLevels}, floor=${floor}, toxic=${adverseSelection.asToxic}, cooldown=${adverseSelection.asCooldownRemainingSeconds}s)`
      );
    }
    if (shockDecision.actions.reduceLevelsBy > 0) {
      const reduceBy = Math.max(1, Math.floor(shockDecision.actions.reduceLevelsBy));
      const beforeBuy = buyLevels;
      const beforeSell = sellLevels;
      buyLevels = buyLevels > 0 ? Math.max(1, buyLevels - reduceBy) : 0;
      sellLevels = sellLevels > 0 ? Math.max(1, sellLevels - reduceBy) : 0;
      const reason = `SHOCK_LEVELS_REDUCED (state=${shockDecision.state} B ${beforeBuy}->${buyLevels} S ${beforeSell}->${sellLevels})`;
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    const trendMoveBps = this.computeSignedMoveBps(this.config.trendWindowSeconds);
    const trendEffect: TrendEffect = {
      applied: false,
      direction: trendMoveBps > 0 ? "UP" : trendMoveBps < 0 ? "DOWN" : "NONE",
      mode: this.config.trendProtectionMode
    };

    if (Math.abs(trendMoveBps) >= this.config.trendPauseBps) {
      quoteBlockedReasons.push(
        `TREND_PAUSE (trendMoveBps=${Math.abs(trendMoveBps).toFixed(2)} > pause=${this.config.trendPauseBps.toFixed(2)})`
      );
      trendEffect.applied = true;
      if (trendMoveBps > 0) {
        if (this.config.trendProtectionMode === "reduce_level") {
          sellLevels = Math.max(0, sellLevels - 1);
          sellReasons.push(
            `Trend guard UP ${trendMoveBps.toFixed(2)} bps: reduced sell levels by 1`
          );
        } else {
          askHalfSpreadBps += this.config.trendSkewBps;
          sellReasons.push(
            `Trend guard UP ${trendMoveBps.toFixed(2)} bps: widened ask by ${this.config.trendSkewBps.toFixed(2)} bps`
          );
        }
      } else if (trendMoveBps < 0) {
        if (this.config.trendProtectionMode === "reduce_level") {
          buyLevels = Math.max(0, buyLevels - 1);
          buyReasons.push(
            `Trend guard DOWN ${trendMoveBps.toFixed(2)} bps: reduced buy levels by 1`
          );
        } else {
          bidHalfSpreadBps += this.config.trendSkewBps;
          buyReasons.push(
            `Trend guard DOWN ${trendMoveBps.toFixed(2)} bps: widened bid by ${this.config.trendSkewBps.toFixed(2)} bps`
          );
        }
      }
    }

    signalEffectEnabled = this.config.signalEnabled && signalState.confidence >= this.config.signalMinConf;
    if (signalEffectEnabled) {
      const preSignalHalfSpread = effectiveHalfSpread;
      signalSkewBps = clamp(
        signalState.zScore * this.config.signalZscoreToSkew +
          signalState.driftBps * this.config.signalDriftToSkew,
        -this.config.signalMaxSkewBps,
        this.config.signalMaxSkewBps
      );
      skewBps += signalSkewBps;

      if (signalState.volRegime === "calm") {
        effectiveHalfSpread *= this.config.signalCalmTighten;
        signalSpreadAction = `calm_tighten_x${this.config.signalCalmTighten.toFixed(2)}`;
      } else if (signalState.volRegime === "hot") {
        effectiveHalfSpread *= this.config.signalHotWiden;
        signalSpreadAction = `hot_widen_x${this.config.signalHotWiden.toFixed(2)}`;
        const hotLevelCap = Math.max(0, this.config.signalLevelsInHot);
        buyLevels = Math.min(buyLevels, hotLevelCap);
        sellLevels = Math.min(sellLevels, hotLevelCap);
      }

      effectiveHalfSpread = clamp(
        effectiveHalfSpread,
        this.config.minHalfSpreadBps,
        this.config.maxHalfSpreadBps
      );
      const halfSpreadDelta = effectiveHalfSpread - preSignalHalfSpread;
      bidHalfSpreadBps += halfSpreadDelta + Math.max(0, signalSkewBps);
      askHalfSpreadBps += halfSpreadDelta - Math.min(0, signalSkewBps);

      const msg = `Signals ${signalSpreadAction}: regime=${signalState.volRegime} z=${signalState.zScore.toFixed(2)} drift=${signalState.driftBps.toFixed(2)} skew=${signalSkewBps.toFixed(2)} bps conf=${signalState.confidence.toFixed(2)}`;
      buyReasons.push(msg);
      sellReasons.push(msg);
    } else {
      signalSpreadAction = "disabled_or_low_confidence";
    }

    const sideEdgeAdjust = computeSideEdgeAdjustments(
      edgeLookback.avgBuy,
      edgeLookback.avgSell,
      this.config
    );
    bidHalfSpreadBps += sideEdgeAdjust.bidBps;
    askHalfSpreadBps += sideEdgeAdjust.askBps;

    buyReasons.push(
      `Edge-weight BUY adjust=${sideEdgeAdjust.bidBps.toFixed(2)} bps from avg_edge_buy=${edgeLookback.avgBuy.toFixed(2)}`
    );
    sellReasons.push(
      `Edge-weight SELL adjust=${sideEdgeAdjust.askBps.toFixed(2)} bps from avg_edge_sell=${edgeLookback.avgSell.toFixed(2)}`
    );

    if (btcNotional > maxBtcNotionalUsd) {
      buyLevels = 0;
      quoteBlockedReasons.push(
        `HIGH_BTC_GATE (btcNotional=${fmtUsd(btcNotional)} > maxGate=${fmtUsd(maxBtcNotionalUsd)})`
      );
      buyReasons.push(
        `BTC notional ${fmtUsd(btcNotional)} > max ${fmtUsd(maxBtcNotionalUsd)}`
      );
    }

    const initialQuoteSizing = computeSideQuoteSizes(
      effectiveConfig.levelQuoteSizeUsd,
      this.config.minQuoteSizeUsd,
      inventoryRatio
    );
    let buyQuoteSizeUsd = initialQuoteSizing.buyQuoteSizeUsd;
    let sellQuoteSizeUsd = initialQuoteSizing.sellQuoteSizeUsd;
    const competitivePostureRaw = resolveCompetitivePosture(
      hardHaltReasons,
      intelPosture.state,
      newsDecision.state,
      signalsDecision.state
    );
    const competitivePosture = this.applyRiskStateHysteresis(
      "posture",
      competitivePostureRaw,
      ticker.ts,
      quoteBlockedReasons
    ) as CompetitivePosture;
    let competitiveDistanceTicks = 0;
    const newsPauseSizeMult = newsDecision.pauseMakers
      ? clamp(0.90 - newsDecision.impact * 0.20, this.config.intelNewsMinSizeMult, 0.90)
      : 1;
    const effectiveNewsSizeMult = clamp(
      Math.min(newsDecision.sizeMult, newsPauseSizeMult),
      Math.max(this.config.intelNewsMinSizeMult, this.config.intelMinSizeMult),
      1
    );
    if (effectiveNewsSizeMult < 0.999) {
      const beforeBuy = buyQuoteSizeUsd;
      const beforeSell = sellQuoteSizeUsd;
      buyQuoteSizeUsd = clamp(
        buyQuoteSizeUsd * effectiveNewsSizeMult,
        this.config.minQuoteSizeUsd,
        beforeBuy
      );
      sellQuoteSizeUsd = clamp(
        sellQuoteSizeUsd * effectiveNewsSizeMult,
        this.config.minQuoteSizeUsd,
        beforeSell
      );
      const reason = `NEWS_SIZE_CUT (mult=${effectiveNewsSizeMult.toFixed(2)} impact=${newsDecision.impact.toFixed(2)} state=${newsDecision.state})`;
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    const signalsPauseSizeMult = signalsDecision.pauseMakers ? 0.50 : 1;
    const effectiveSignalsSizeMult = clamp(
      Math.min(signalsDecision.sizeMultExtra, signalsPauseSizeMult),
      Math.max(0.50, this.config.intelMinSizeMult),
      1
    );
    if (effectiveSignalsSizeMult < 0.999) {
      const beforeBuy = buyQuoteSizeUsd;
      const beforeSell = sellQuoteSizeUsd;
      buyQuoteSizeUsd = clamp(
        buyQuoteSizeUsd * effectiveSignalsSizeMult,
        this.config.minQuoteSizeUsd,
        beforeBuy
      );
      sellQuoteSizeUsd = clamp(
        sellQuoteSizeUsd * effectiveSignalsSizeMult,
        this.config.minQuoteSizeUsd,
        beforeSell
      );
      const reason = `SIGNALS_SIZE_CUT (mult=${effectiveSignalsSizeMult.toFixed(2)} impact=${signalsDecision.impact.toFixed(2)} state=${signalsDecision.state})`;
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    if (this.config.enableIntel && intelAdjustment.sizeMult < 0.999) {
      const intelSizeMult = clamp(
        intelAdjustment.sizeMult,
        Math.max(0.1, this.config.intelMinSizeMult),
        1
      );
      const beforeBuy = buyQuoteSizeUsd;
      const beforeSell = sellQuoteSizeUsd;
      buyQuoteSizeUsd = clamp(
        buyQuoteSizeUsd * intelSizeMult,
        this.config.minQuoteSizeUsd,
        beforeBuy
      );
      sellQuoteSizeUsd = clamp(
        sellQuoteSizeUsd * intelSizeMult,
        this.config.minQuoteSizeUsd,
        beforeSell
      );
      const reason = `INTEL_SIZE_CUT (mult=${intelSizeMult.toFixed(2)} state=${intelPosture.state} impact=${intelPosture.impact.toFixed(2)})`;
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    if (shockDecision.actions.sizeMult < 0.999) {
      const beforeBuy = buyQuoteSizeUsd;
      const beforeSell = sellQuoteSizeUsd;
      const shockSizeMult = clamp(
        shockDecision.actions.sizeMult,
        Math.max(this.config.intelMinSizeMult, 0.25),
        1
      );
      buyQuoteSizeUsd = clamp(
        buyQuoteSizeUsd * shockSizeMult,
        this.config.minQuoteSizeUsd,
        beforeBuy
      );
      sellQuoteSizeUsd = clamp(
        sellQuoteSizeUsd * shockSizeMult,
        this.config.minQuoteSizeUsd,
        beforeSell
      );
      const reason = `SHOCK_SIZE_CUT (state=${shockDecision.state} mult=${shockSizeMult.toFixed(2)})`;
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    if (competitivePosture === "CAUTION") {
      competitiveDistanceTicks = 1;
      const cautionSizeMult = 0.5;
      const beforeBuy = buyQuoteSizeUsd;
      const beforeSell = sellQuoteSizeUsd;
      buyQuoteSizeUsd = clamp(
        buyQuoteSizeUsd * cautionSizeMult,
        this.config.minQuoteSizeUsd,
        beforeBuy
      );
      sellQuoteSizeUsd = clamp(
        sellQuoteSizeUsd * cautionSizeMult,
        this.config.minQuoteSizeUsd,
        beforeSell
      );
      const reason = "COMPETITIVE_CAUTION (join+1 tick, size 50%)";
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    } else if (competitivePosture === "RISK_OFF") {
      competitiveDistanceTicks = 2;
      const riskOffSizeMult = 0.5;
      const beforeBuy = buyQuoteSizeUsd;
      const beforeSell = sellQuoteSizeUsd;
      buyQuoteSizeUsd = clamp(
        buyQuoteSizeUsd * riskOffSizeMult,
        this.config.minQuoteSizeUsd,
        beforeBuy
      );
      sellQuoteSizeUsd = clamp(
        sellQuoteSizeUsd * riskOffSizeMult,
        this.config.minQuoteSizeUsd,
        beforeSell
      );
      const reason = "COMPETITIVE_RISK_OFF (join+2 ticks, size 50%)";
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    const usdSpendable = spendableUsd;
    if (
      usdSpendable > 0 &&
      usdSpendable < buyQuoteSizeUsd &&
      buyQuoteSizeUsd > this.config.minQuoteSizeUsd
    ) {
      const previousBuyQuoteSizeUsd = buyQuoteSizeUsd;
      buyQuoteSizeUsd = clamp(
        usdSpendable,
        this.config.minQuoteSizeUsd,
        previousBuyQuoteSizeUsd
      );
      if (buyQuoteSizeUsd < previousBuyQuoteSizeUsd) {
        quoteBlockedReasons.push(
          `USD_SIZE_THROTTLE (spendableUsd=${usdSpendable.toFixed(2)} quoteSize=${previousBuyQuoteSizeUsd.toFixed(2)} -> ${buyQuoteSizeUsd.toFixed(2)})`
        );
        buyReasons.push(
          `USD spendable ${fmtUsd(usdSpendable)} below nominal quote size ${fmtUsd(
            previousBuyQuoteSizeUsd
          )}; throttled BUY quote size to ${fmtUsd(buyQuoteSizeUsd)}.`
        );
      }
    }
    let maxSellByBal = Math.max(
      0,
      Math.floor((spendableBtc * ticker.mid) / Math.max(sellQuoteSizeUsd, 0.0000001))
    );
    let sellThrottleState = "NORMAL";

    if (maxSellByBal === 0 && balances.btc_total > 0 && sellQuoteSizeUsd > this.config.minQuoteSizeUsd) {
      sellQuoteSizeUsd = this.config.minQuoteSizeUsd;
      maxSellByBal = Math.max(
        0,
        Math.floor((spendableBtc * ticker.mid) / Math.max(sellQuoteSizeUsd, 0.0000001))
      );
      sellReasons.push(
        `Reduced SELL quote size to minimum ${fmtUsd(sellQuoteSizeUsd)} to keep sell quoting possible. ${formatSellDiagnostics({
          btcTotal: balances.btc_total,
          btcFree: balances.btc_free,
          btcNotional,
          targetBtcNotionalUsd,
          lowBtcGate,
          maxSellByBal
        })}`
      );
    }

    if (btcNotional < this.config.sellDisableBelowNotionalUsd) {
      const before = sellLevels;
      sellLevels = Math.min(sellLevels, 1);
      quoteBlockedReasons.push(
        `LOW_BTC_SOFT_THROTTLE (btcNotional=${fmtUsd(btcNotional)} < minNotional=${fmtUsd(this.config.sellDisableBelowNotionalUsd)})`
      );
      sellThrottleState = "THROTTLED_MIN_NOTIONAL";
      if (before !== sellLevels) {
        sellReasons.push(
          `BTC notional below minimal sell threshold (${fmtUsd(
            btcNotional
          )} < ${fmtUsd(this.config.sellDisableBelowNotionalUsd)}); softened SELL throttle ${before} -> ${sellLevels}. ${formatSellDiagnostics({
            btcTotal: balances.btc_total,
            btcFree: balances.btc_free,
            btcNotional,
            targetBtcNotionalUsd,
            lowBtcGate,
            maxSellByBal
          })}`
        );
      }
    } else if (this.config.sellThrottleBelowLowGate && btcNotional < lowBtcGate) {
      quoteBlockedReasons.push(
        `LOW_BTC_SOFT_THROTTLE (btcNotional=${fmtUsd(btcNotional)} < lowGate=${fmtUsd(lowBtcGate)})`
      );
      const before = sellLevels;
      sellLevels = Math.min(sellLevels, Math.max(1, this.config.minSellLevelsBelowLowGate));
      sellThrottleState = "THROTTLED_LOW_GATE";
      sellReasons.push(
        `BTC notional below low gate; throttling sells to ${sellLevels}. ${formatSellDiagnostics({
          btcTotal: balances.btc_total,
          btcFree: balances.btc_free,
          btcNotional,
          targetBtcNotionalUsd,
          lowBtcGate,
          maxSellByBal
        })}`
      );
      if (before !== sellLevels) {
        sellReasons.push(`Sell levels adjusted ${before} -> ${sellLevels} by low-gate throttle.`);
      }
    }

    const maxBuyByCash = Math.max(
      0,
      Math.floor(spendableUsd / Math.max(buyQuoteSizeUsd, 0.0000001))
    );
    if (maxBuyByCash < buyLevels) {
      const requiredPerLevel = buyQuoteSizeUsd;
      if (maxBuyByCash === 0) {
        const noUsdAfterReserve = spendableUsd <= 0;
        quoteBlockedReasons.push(
          noUsdAfterReserve
            ? `NO_USD_AFTER_RESERVE (usdFree=${balances.usd_free.toFixed(2)} reserve=${reserveUsd.toFixed(2)})`
            : `BUY_LEVEL_SOFT_THROTTLE (usdFree=${balances.usd_free.toFixed(2)} reserve=${reserveUsd.toFixed(2)} spendable=${spendableUsd.toFixed(2)})`
        );
      }
      const suggestion =
        spendableUsd < requiredPerLevel
          ? " Reduce CASH_RESERVE_USD or LEVEL_QUOTE_SIZE_USD to enable buys."
          : "";
      buyReasons.push(
        `USD free ${fmtUsd(balances.usd_free)} only supports ${maxBuyByCash} buy levels after reserve (spendableUsd=${fmtUsd(
          spendableUsd
        )}, requiredPerLevel=${fmtUsd(requiredPerLevel)}).${suggestion}`
      );
      buyLevels = maxBuyByCash;
    }

    const maxBuyByCap = Math.max(
      0,
      Math.floor((effectiveConfig.workingCapUsd - buyOpenUsd) / Math.max(buyQuoteSizeUsd, 0.0000001))
    );
    if (maxBuyByCap < buyLevels) {
      buyReasons.push(
        `Working cap ${fmtUsd(effectiveConfig.workingCapUsd)} limits buy levels to ${maxBuyByCap}`
      );
      buyLevels = maxBuyByCap;
    }

    if (maxSellByBal < sellLevels) {
      if (maxSellByBal === 0) {
        quoteBlockedReasons.push(
          `NO_BTC_LEVELS (btcNotional=${fmtUsd(btcNotional)} supports=${maxSellByBal})`
        );
      }
      sellReasons.push(
        `BTC free ${balances.btc_free.toFixed(8)} supports ${maxSellByBal} sell levels. ${formatSellDiagnostics({
          btcTotal: balances.btc_total,
          btcFree: balances.btc_free,
          btcNotional,
          targetBtcNotionalUsd,
          lowBtcGate,
          maxSellByBal
        })}`
      );
      sellLevels = maxSellByBal;
    }

    const totalLevels = buyLevels + sellLevels;
    if (totalLevels > effectiveConfig.maxActiveOrders) {
      let trim = totalLevels - effectiveConfig.maxActiveOrders;
      while (trim > 0 && (buyLevels > 0 || sellLevels > 0)) {
        if (sellLevels >= buyLevels && sellLevels > 0) {
          sellLevels -= 1;
          sellReasons.push(
            `Trimmed by MAX_ACTIVE_ORDERS. ${formatSellDiagnostics({
              btcTotal: balances.btc_total,
              btcFree: balances.btc_free,
              btcNotional,
              targetBtcNotionalUsd,
              lowBtcGate,
              maxSellByBal
            })}`
          );
        } else if (buyLevels > 0) {
          buyLevels -= 1;
          buyReasons.push("Trimmed by MAX_ACTIVE_ORDERS");
        }
        trim -= 1;
      }
    }

    if (sellLevels < initialSellLevels) {
      sellReasons.push(
        `Sell levels reduced ${initialSellLevels} -> ${sellLevels}. ${formatSellDiagnostics({
          btcTotal: balances.btc_total,
          btcFree: balances.btc_free,
          btcNotional,
          targetBtcNotionalUsd,
          lowBtcGate,
          maxSellByBal
        })}`
      );
    }

    const preOverrideBuyLevels = buyLevels;
    const preOverrideSellLevels = sellLevels;
    buyLevels = Math.min(buyLevels, effectiveConfig.levelsBuy);
    sellLevels = Math.min(sellLevels, effectiveConfig.levelsSell);
    if (buyLevels !== preOverrideBuyLevels) {
      buyReasons.push(
        `Override level cap applied: buy levels ${preOverrideBuyLevels} -> ${buyLevels}`
      );
    }
    if (sellLevels !== preOverrideSellLevels) {
      sellReasons.push(
        `Override level cap applied: sell levels ${preOverrideSellLevels} -> ${sellLevels}`
      );
    }
    if (runtimeOverrideAllowBuyIgnored) {
      buyReasons.push("Override allowBuy=false ignored (non-blocking)");
    }
    if (runtimeOverrideAllowSellIgnored) {
      sellReasons.push("Override allowSell=false ignored (non-blocking)");
    }
    if (this.config.adverseEnabled && adverseDecision.allowBuy === false) {
      buyLevels = 0;
      quoteBlockedReasons.push("ADVERSE_BLOCK_BUY");
      buyReasons.push("Adverse guard disabled BUY side.");
    }
    if (this.config.adverseEnabled && adverseDecision.allowSell === false) {
      sellLevels = 0;
      quoteBlockedReasons.push("ADVERSE_BLOCK_SELL");
      sellReasons.push("Adverse guard disabled SELL side.");
    }
    const newsSkewCapBps = 3;
    const newsSkewBps = clamp(newsDecision.impact * newsSkewCapBps, 0, newsSkewCapBps);
    const newsRiskySideSizeMult = clamp(1 - newsDecision.impact * 0.25, this.config.intelNewsMinSizeMult, 1);
    if (newsDecision.direction === "DOWN" && newsSkewBps > 0) {
      bidHalfSpreadBps += newsSkewBps;
      const beforeBuyQuoteSizeUsd = buyQuoteSizeUsd;
      buyQuoteSizeUsd = clamp(
        buyQuoteSizeUsd * newsRiskySideSizeMult,
        this.config.minQuoteSizeUsd,
        beforeBuyQuoteSizeUsd
      );
      const reason = `NEWS_DOWN_SKEW_APPLIED (skewBps=${newsSkewBps.toFixed(2)} buySizeMult=${newsRiskySideSizeMult.toFixed(2)})`;
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    } else if (newsDecision.direction === "UP" && newsSkewBps > 0) {
      askHalfSpreadBps += newsSkewBps;
      const beforeSellQuoteSizeUsd = sellQuoteSizeUsd;
      sellQuoteSizeUsd = clamp(
        sellQuoteSizeUsd * newsRiskySideSizeMult,
        this.config.minQuoteSizeUsd,
        beforeSellQuoteSizeUsd
      );
      const reason = `NEWS_UP_SKEW_APPLIED (skewBps=${newsSkewBps.toFixed(2)} sellSizeMult=${newsRiskySideSizeMult.toFixed(2)})`;
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    if (newsDecision.pauseMakers) {
      const beforeBuy = buyLevels;
      const beforeSell = sellLevels;
      if (strategyAllowBuy) {
        buyLevels = Math.max(1, Math.min(Math.max(buyLevels, 1), this.config.quotingMinLevelsFloorBuy || 1));
      } else {
        buyLevels = 0;
      }
      if (strategyAllowSell) {
        sellLevels = Math.max(1, Math.min(Math.max(sellLevels, 1), this.config.quotingMinLevelsFloorSell || 1));
      } else {
        sellLevels = 0;
      }
      const reason = `NEWS_SUPER_CAUTION (state=${newsDecision.state}, impact=${newsDecision.impact.toFixed(2)}, dir=${newsDecision.direction}, conf=${newsDecision.confidence.toFixed(2)}, levels=${beforeBuy}/${beforeSell}->${buyLevels}/${sellLevels})`;
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    if (signalsDecision.gateBuy === true) {
      const before = buyLevels;
      if (strategyAllowBuy) {
        const softFloorBuy = Math.max(1, this.config.quotingMinLevelsFloorBuy);
        buyLevels = Math.max(softFloorBuy, Math.min(Math.max(buyLevels, softFloorBuy), softFloorBuy));
      } else {
        buyLevels = 0;
      }
      quoteBlockedReasons.push("SIGNALS_BLOCK_BUY_SOFT");
      buyReasons.push(
        `Signals guard reduced BUY side (state=${signalsDecision.state}, impact=${signalsDecision.impact.toFixed(2)}, conf=${signalsDecision.confidence.toFixed(2)}, levels=${before}->${buyLevels}).`
      );
    }
    if (signalsDecision.gateSell === true) {
      const before = sellLevels;
      if (strategyAllowSell) {
        const softFloorSell = Math.max(1, this.config.quotingMinLevelsFloorSell);
        sellLevels = Math.max(softFloorSell, Math.min(Math.max(sellLevels, softFloorSell), softFloorSell));
      } else {
        sellLevels = 0;
      }
      quoteBlockedReasons.push("SIGNALS_BLOCK_SELL_SOFT");
      sellReasons.push(
        `Signals guard reduced SELL side (state=${signalsDecision.state}, impact=${signalsDecision.impact.toFixed(2)}, conf=${signalsDecision.confidence.toFixed(2)}, levels=${before}->${sellLevels}).`
      );
    }
    if (signalsDecision.pauseMakers) {
      const beforeBuy = buyLevels;
      const beforeSell = sellLevels;
      if (strategyAllowBuy) {
        buyLevels = Math.max(1, Math.min(Math.max(buyLevels, 1), this.config.quotingMinLevelsFloorBuy || 1));
      } else {
        buyLevels = 0;
      }
      if (strategyAllowSell) {
        sellLevels = Math.max(1, Math.min(Math.max(sellLevels, 1), this.config.quotingMinLevelsFloorSell || 1));
      } else {
        sellLevels = 0;
      }
      toxicDisableTob = true;
      const reason = `SIGNALS_SUPER_CAUTION (state=${signalsDecision.state}, impact=${signalsDecision.impact.toFixed(2)}, dir=${signalsDecision.direction}, conf=${signalsDecision.confidence.toFixed(2)}, levels=${beforeBuy}/${beforeSell}->${buyLevels}/${sellLevels})`;
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    const floorBtcNotionalUsd = Math.max(0.01, this.config.inventoryFloorBtcNotionalUsd);
    const reentryTargetUsd = Math.max(
      this.config.inventoryTargetBtcNotionalUsd,
      this.config.reentryBtcTargetNotionalUsd,
      targetBtcNotionalUsd
    );
    const capBtcNotionalUsd = Math.max(
      reentryTargetUsd,
      this.config.inventoryCapBtcNotionalUsd
    );
    const inventoryHysteresisUsd = 5;
    const inventoryAction = resolveInventoryAction({
      btcNotionalUsd: btcNotional,
      targetUsd: reentryTargetUsd,
      hysteresisUsd: inventoryHysteresisUsd
    });
    const marketPhaseNow = shockDecision.phase;
    let reentryRebuildBtc =
      (marketPhaseNow === "STABILIZING" || marketPhaseNow === "RECOVERY") &&
      btcNotional < reentryTargetUsd;
    const bandPolicy = applyInventoryBandPolicy({
      buyLevels,
      sellLevels,
      btcNotionalUsd: btcNotional,
      floorUsd: floorBtcNotionalUsd,
      targetUsd: reentryTargetUsd,
      capUsd: capBtcNotionalUsd,
      hysteresisUsd: inventoryHysteresisUsd,
      inventoryAction,
      maxSellUsdPerHour: this.config.phaseAwareMaxSellUsdPerHour,
      sellNotionalFilled1hUsd,
      sellQuoteSizeUsd,
      spendableUsd,
      minNotionalUsd: Math.max(0.01, this.config.quotingMinNotionalUsd),
      phase: marketPhaseNow,
      strategyAllowBuy,
      strategyAllowSell,
      hardHalt: hardHaltReasons.length > 0
    });
    buyLevels = bandPolicy.buyLevels;
    sellLevels = bandPolicy.sellLevels;
    reentryRebuildBtc = bandPolicy.reentryActive;
    for (const reason of bandPolicy.reasons) {
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    if (
      btcNotional <= floorBtcNotionalUsd &&
      hardHaltReasons.length === 0 &&
      (newsDecision.allowBuy === false || signalsDecision.gateBuy === true)
    ) {
      const reason = "BUY_UNBLOCKED_FOR_BTC_FLOOR (news/signals cannot block all buys below floor)";
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    if (newsDecision.state === "CAUTION" || newsDecision.state === "PAUSE") {
      competitiveDistanceTicks = Math.max(competitiveDistanceTicks, 1);
      const reason = `NEWS_SUPER_CAUTION (TOB join+1, state=${newsDecision.state})`;
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    if (this.config.enableIntel && intelPosture.state === "RISK_OFF") {
      const beforeBuy = buyLevels;
      const beforeSell = sellLevels;
      buyLevels = buyLevels > 0 ? Math.min(buyLevels, 2) : 0;
      sellLevels = sellLevels > 0 ? Math.min(sellLevels, 2) : 0;
      if (beforeBuy !== buyLevels || beforeSell !== sellLevels) {
        const reason = `INTEL_LEVELS_REDUCED (B ${beforeBuy}->${buyLevels}, S ${beforeSell}->${sellLevels})`;
        quoteBlockedReasons.push(reason);
        buyReasons.push(reason);
        sellReasons.push(reason);
      }
    }
    if (this.config.enableIntel && intelAdjustment.tobModeOverride === "OFF") {
      competitiveDistanceTicks = Math.max(competitiveDistanceTicks, 2);
      const reason = `INTEL_SUPER_CAUTION (TOB softened, state=${intelPosture.state})`;
      quoteBlockedReasons.push(reason);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }
    const suppressSellForInventory =
      inventoryAction === "ACCUMULATE" ||
      btcNotional <= floorBtcNotionalUsd ||
      (marketPhaseNow === "SHOCK" && btcNotional <= reentryTargetUsd + inventoryHysteresisUsd);
    if (competitivePosture === "CAUTION" && hardHaltReasons.length === 0) {
      const minLevel = Math.max(1, this.config.intelMinQuoteLevels);
      const canBuyAtLeastOne =
        strategyAllowBuy &&
        spendableUsd >=
          Math.max(this.config.minQuoteSizeUsd, buyQuoteSizeUsd);
      const canSellAtLeastOne =
        strategyAllowSell &&
        !suppressSellForInventory &&
        spendableBtc * ticker.mid >=
          Math.max(this.config.minQuoteSizeUsd, sellQuoteSizeUsd);
      if (canBuyAtLeastOne && buyLevels < minLevel) {
        const before = buyLevels;
        buyLevels = minLevel;
        const reason = `CAUTION_MIN_BUY_LEVEL (levels ${before} -> ${buyLevels})`;
        quoteBlockedReasons.push(reason);
        buyReasons.push(reason);
      }
      if (canSellAtLeastOne && sellLevels < minLevel) {
        const before = sellLevels;
        sellLevels = minLevel;
        const reason = `CAUTION_MIN_SELL_LEVEL (levels ${before} -> ${sellLevels})`;
        quoteBlockedReasons.push(reason);
        sellReasons.push(reason);
      }
    }
    if (
      this.config.intelAlwaysOn &&
      hardHaltReasons.length === 0 &&
      buyLevels + sellLevels <= 0 &&
      (strategyAllowBuy || strategyAllowSell)
    ) {
      const canBuy =
        strategyAllowBuy &&
        spendableUsd >= Math.max(this.config.minQuoteSizeUsd, buyQuoteSizeUsd);
      const canSell =
        strategyAllowSell &&
        !suppressSellForInventory &&
        spendableBtc * ticker.mid >= Math.max(this.config.minQuoteSizeUsd, sellQuoteSizeUsd);
      if (canBuy || canSell) {
        if (canBuy && (!canSell || inventoryRatio <= 0)) {
          buyLevels = Math.max(1, this.config.intelMinQuoteLevels);
        } else if (canSell) {
          sellLevels = Math.max(1, this.config.intelMinQuoteLevels);
        }
        quoteBlockedReasons.push(
          `ALWAYS_ON_MIN_QUOTING (restored levels B=${buyLevels} S=${sellLevels})`
        );
      }
    }
    if (
      hardHaltReasons.length === 0 &&
      this.config.quotingMinLevelsFloorEnabled
    ) {
      const canBuyAtLeastOne =
        strategyAllowBuy &&
        spendableUsd >=
          Math.max(this.config.minQuoteSizeUsd, buyQuoteSizeUsd);
      const canSellAtLeastOne =
        strategyAllowSell &&
        !suppressSellForInventory &&
        spendableBtc * ticker.mid >=
          Math.max(this.config.minQuoteSizeUsd, sellQuoteSizeUsd);
      const floorBuy = Math.max(0, Math.floor(this.config.quotingMinLevelsFloorBuy));
      const floorSell = Math.max(0, Math.floor(this.config.quotingMinLevelsFloorSell));
      if (canBuyAtLeastOne && floorBuy > 0 && buyLevels < floorBuy) {
        const before = buyLevels;
        buyLevels = floorBuy;
        const reason = `MIN_BUY_LEVEL_ENFORCED (${before} -> ${buyLevels})`;
        quoteBlockedReasons.push(reason);
        buyReasons.push(reason);
      }
      if (
        canSellAtLeastOne &&
        floorSell > 0 &&
        sellLevels < floorSell &&
        !(this.config.seedEnabled && btcNotional < lowBtcGate) &&
        !suppressSellForInventory
      ) {
        const before = sellLevels;
        sellLevels = floorSell;
        const reason = `MIN_SELL_LEVEL_ENFORCED (${before} -> ${sellLevels})`;
        quoteBlockedReasons.push(reason);
        sellReasons.push(reason);
      }
      if (canBuyAtLeastOne && canSellAtLeastOne && buyLevels + sellLevels <= 0) {
        const restoredBuy = Math.max(1, floorBuy);
        const restoredSell = Math.max(1, floorSell);
        buyLevels = restoredBuy;
        sellLevels = restoredSell;
        const reason = `MIN_LEVELS_FLOOR_RESTORE (B=${restoredBuy}, S=${restoredSell})`;
        quoteBlockedReasons.push(reason);
        buyReasons.push(reason);
        sellReasons.push(reason);
      }
    }
    if (
      hardHaltReasons.length === 0 &&
      (newsDecision.state !== "NORMAL" || signalsDecision.state !== "NORMAL" || competitivePosture !== "NORMAL")
    ) {
      const beforeBuy = buyLevels;
      const beforeSell = sellLevels;
      if (buyLevels > 0) buyLevels = Math.min(Math.max(1, buyLevels), 2);
      if (sellLevels > 0) sellLevels = Math.min(Math.max(1, sellLevels), 2);
      if (beforeBuy !== buyLevels || beforeSell !== sellLevels) {
        const reason = `SOFT_RISK_LEVEL_CAP (B ${beforeBuy}->${buyLevels}, S ${beforeSell}->${sellLevels})`;
        quoteBlockedReasons.push(reason);
        buyReasons.push(reason);
        sellReasons.push(reason);
      }
    }

    const rejectSpikeThreshold = Math.max(3, this.config.targetFillsPerHour);
    const rejectsSpiking = rolling.post_only_rejects_last_1h >= rejectSpikeThreshold;
    const churnWarning = rolling.cancels_last_1h > this.config.maxCancelsPerHour;
    const tobRegime: "calm" | "normal" | "hot" =
      volMoveBps <= this.config.calmVolBps
        ? "calm"
        : volMoveBps <= this.config.tobMaxVolBps
          ? "normal"
          : "hot";
    const absInventoryRatio = Math.abs(inventoryRatio);
    const tobQuoteSizeActive =
      tobRegime === "calm"
        ? effectiveConfig.tobQuoteSizeUsd
        : Math.min(effectiveConfig.tobQuoteSizeUsd, this.config.tobQuoteSizeUsdNormal);

    if (
      absInventoryRatio > this.config.tobMaxInventoryRatioForOneSided &&
      inventoryRatio < -this.config.tobMaxInventoryRatioForBoth
    ) {
      const before = sellLevels;
      sellLevels = Math.max(0, sellLevels - 1);
      if (before !== sellLevels) {
        sellReasons.push(
          `Inventory extreme (BTC-light, ratio=${inventoryRatio.toFixed(
            3
          )}); softened SELL levels ${before} -> ${sellLevels}`
        );
      }
    } else if (
      absInventoryRatio > this.config.tobMaxInventoryRatioForOneSided &&
      inventoryRatio > this.config.tobMaxInventoryRatioForBoth
    ) {
      const before = buyLevels;
      buyLevels = Math.max(0, buyLevels - 1);
      if (before !== buyLevels) {
        buyReasons.push(
          `Inventory extreme (BTC-heavy, ratio=${inventoryRatio.toFixed(
            3
          )}); softened BUY levels ${before} -> ${buyLevels}`
        );
      }
    }

    const tickSize = ticker.tickSize > 0 ? ticker.tickSize : 0.01;
    let tobMode: "OFF" | "BOTH" | "BUY-ONLY" | "SELL-ONLY" = "OFF";
    let tobReason = "Disabled in config";
    let allowTobBuy = false;
    let allowTobSell = false;

    if (effectiveConfig.tobEnabled) {
      if (tobRegime === "hot") {
        tobMode = "OFF";
        tobReason = `Hot volatility regime (${volMoveBps.toFixed(2)} bps > ${this.config.tobMaxVolBps.toFixed(2)})`;
      } else if (rolling.cancels_last_1h >= this.config.maxCancelsPerHour) {
        tobMode = "OFF";
        tobReason = `High churn (${rolling.cancels_last_1h} cancels/1h >= ${this.config.maxCancelsPerHour})`;
      } else if (rejectsSpiking) {
        tobMode = "OFF";
        tobReason = `Post-only rejects spiking (${rolling.post_only_rejects_last_1h}/1h)`;
      } else if (absInventoryRatio <= this.config.tobMaxInventoryRatioForBoth) {
        tobMode = "BOTH";
        tobReason = `Inventory balanced (|ratio|=${absInventoryRatio.toFixed(3)} <= ${this.config.tobMaxInventoryRatioForBoth.toFixed(2)})`;
        allowTobBuy = true;
        allowTobSell = true;
      } else if (inventoryRatio < -this.config.tobMaxInventoryRatioForBoth) {
        tobMode = "BUY-ONLY";
        tobReason = `BTC-light inventory (ratio=${inventoryRatio.toFixed(3)}): TOB BUY-only for rebalance`;
        allowTobBuy = true;
      } else {
        tobMode = "SELL-ONLY";
        tobReason = `BTC-heavy inventory (ratio=${inventoryRatio.toFixed(3)}): TOB SELL-only for rebalance`;
        allowTobSell = true;
      }
    }
    if (toxicDisableTob) {
      tobMode = "OFF";
      allowTobBuy = false;
      allowTobSell = false;
      tobReason = `Disabled by toxic guard (regime=${fairVolRegime}, dispersion=${fairDispersionBps.toFixed(2)}, basis=${fairBasisBps.toFixed(2)}, drift=${fairDriftBps.toFixed(2)})`;
      buyReasons.push(tobReason);
      sellReasons.push(tobReason);
    } else if (asRequestedDisableTob) {
      tobMode = "OFF";
      allowTobBuy = false;
      allowTobSell = false;
      tobReason = `AS_TOB_DISABLED (avg=${adverseSelection.asAvgBps.toFixed(2)} bps, bad_rate=${(adverseSelection.asBadRate * 100).toFixed(1)}%, widen=${adverseSelection.asWidenBps.toFixed(2)} bps, cooldown=${adverseSelection.asCooldownRemainingSeconds}s)`;
      buyReasons.push(tobReason);
      sellReasons.push(tobReason);
    }

    const quoteInputs = makeQuoteInputs({
      ts: ticker.ts,
      symbol: this.config.symbol,
      mid: ticker.mid,
      bid: ticker.bid,
      ask: ticker.ask,
      marketSpreadBps,
      volMoveBps,
      trendMoveBps,
      usdFree: balances.usd_free,
      usdTotal: balances.usd_total,
      btcFree: balances.btc_free,
      btcTotal: balances.btc_total,
      btcNotionalUsd: btcNotional,
      inventoryRatio,
      signals: {
        state: signalsDecision.state,
        impact: signalsDecision.impact,
        direction: signalsDecision.direction,
        confidence: signalsDecision.confidence,
        reasons: signalsDecision.reasons,
        latestTs: this.lastSignalsSnapshot?.aggregate?.latestTs ?? 0
      },
      config: {
        levels: Math.max(effectiveConfig.levelsBuy, effectiveConfig.levelsSell),
        enableTopOfBook: effectiveConfig.tobEnabled,
        minInsideSpreadBps: effectiveConfig.minMarketSpreadBps,
        minVolMoveBpsToQuote: this.config.minVolMoveBpsToQuote,
        volProtectMode: this.config.volProtectMode,
        cashReserveUsd: reserveUsd,
        workingCapUsd: effectiveConfig.workingCapUsd,
        targetBtcNotionalUsd,
        lowBtcGateUsd: lowBtcGate,
        maxActionsPerLoop: effectiveConfig.maxActionsPerLoop,
        maxBtcNotionalUsd,
        minBtcNotionalUsd: Math.max(0.01, this.config.quotingMinNotionalUsd),
        seedTargetBtcNotionalUsd: Math.max(0.01, this.config.seedTargetBtcNotionalUsd),
        seedForceTob: this.config.seedForceTob,
        seedEnabled: this.config.seedEnabled,
        allowBuy: strategyAllowBuy,
        allowSell: strategyAllowSell,
        minLevelsFloorEnabled: this.config.quotingMinLevelsFloorEnabled,
        minLevelsFloorBuy: this.config.quotingMinLevelsFloorBuy,
        minLevelsFloorSell: this.config.quotingMinLevelsFloorSell,
        pauseImpactThreshold: this.config.intelPauseImpactThreshold,
        pauseConfidenceThreshold: this.config.intelPauseConfidenceThreshold,
        pausePersistenceSeconds: this.config.intelPausePersistenceSeconds
      }
    });

    const quotePlan = buildQuotePlan({
      inputs: quoteInputs,
      buyLevels,
      sellLevels,
      tobMode,
      blockedReasons: quoteBlockedReasons,
      hardHaltReasons
    });
    quotePlan.adverseState = adverseDecision.state;
    quotePlan.toxicityScore = adverseDecision.toxicityScore;
    quotePlan.adverseReasons = adverseDecision.reasons;
    quotePlan.newsState = newsDecision.state;
    quotePlan.newsImpact = newsDecision.impact;
    quotePlan.newsDirection = newsDecision.direction;
    quotePlan.newsConfidence = newsDecision.confidence;
    quotePlan.newsReasons = newsDecision.reasons;
    quotePlan.signalsState = signalsDecision.state;
    quotePlan.signalsImpact = signalsDecision.impact;
    quotePlan.signalsDirection = signalsDecision.direction;
    quotePlan.signalsConfidence = signalsDecision.confidence;
    quotePlan.signalsReasons = signalsDecision.reasons;
    quotePlan.regime = this.lastHybridSignal?.regime;
    quotePlan.bias = this.lastHybridSignal?.bias;
    quotePlan.biasConfidence = this.lastHybridSignal?.biasConfidence;
    quotePlan.signalConfidence = this.lastHybridSignal?.confidence;
    quotePlan.globalMid = this.lastHybridSignal?.globalMid;
    quotePlan.fairMid = this.lastHybridSignal?.fairMid;
    quotePlan.basisBps = this.lastHybridSignal?.basisBps;
    quotePlan.dispersionBps = this.lastHybridSignal?.dispersionBps;
    quotePlan.marketPhase = shockDecision.phase;
    quotePlan.phaseReasons = shockDecision.reasons.slice(0, 8);
    quotePlan.phaseSinceTs = shockDecision.sinceTs;
    quotePlan.shockVolPeakBps = shockDecision.shockVolPeakBps;
    quotePlan.shockState =
      shockDecision.phase === "SHOCK"
        ? "SHOCK"
        : shockDecision.phase === "COOLDOWN"
          ? "COOLDOWN"
          : shockDecision.phase === "RECOVERY"
            ? "REENTRY"
            : "NORMAL";
    quotePlan.shockReasons = shockDecision.reasons.slice(0, 8);
    quotePlan.shockSinceTs = shockDecision.sinceTs;
    if (reentryRebuildBtc) {
      quotePlan.seedMode = "ACCUMULATE_BTC";
      quotePlan.seedReason = `Reentry inventory rebuild (${fmtUsd(btcNotional)} < ${fmtUsd(reentryTargetUsd)})`;
      quotePlan.seedProgress = {
        btcNotionalUsd: btcNotional,
        lowGateUsd: lowBtcGate,
        targetUsd: reentryTargetUsd
      };
    }
    const rawTargetLevels: { buy: number; sell: number; tob: "OFF" | "BUY" | "SELL" | "BOTH" } = {
      buy: Math.max(0, Math.floor(Number(quotePlan.buyLevels) || 0)),
      sell: Math.max(0, Math.floor(Number(quotePlan.sellLevels) || 0)),
      tob: quotePlan.tob
    };
    const effectiveTargetLevels: {
      buy: number;
      sell: number;
      tob: "OFF" | "BUY" | "SELL" | "BOTH";
    } = {
      buy: rawTargetLevels.buy,
      sell: rawTargetLevels.sell,
      tob: rawTargetLevels.tob
    };
    let tobPolicy: "JOIN" | "JOIN+1" | "JOIN+2" | "OFF" = "JOIN";
    if (quotePlan.hardHalt) {
      tobPolicy = "OFF";
    } else if (shockDecision.phase === "SHOCK") {
      tobPolicy = "JOIN+2";
    } else if (shockDecision.phase === "COOLDOWN" || shockDecision.phase === "STABILIZING") {
      tobPolicy = "JOIN+1";
    } else if (competitivePosture === "RISK_OFF") {
      tobPolicy = "JOIN+2";
    } else if (
      competitivePosture === "CAUTION" ||
      newsDecision.pauseMakers ||
      signalsDecision.pauseMakers ||
      newsDecision.state === "CAUTION" ||
      signalsDecision.state === "CAUTION"
    ) {
      tobPolicy = "JOIN+1";
    }
    let minLevelsFloorApplied = false;
    let overrideApplied = false;
    const overrideReasons: string[] = [];
    const pauseDrivenFloorCandidate =
      quotePlan.signalsState === "PAUSE" || quotePlan.newsState === "PAUSE";
    if (
      !quotePlan.hardHalt &&
      !quotePlan.quoteEnabled &&
      rawTargetLevels.buy <= 0 &&
      rawTargetLevels.sell <= 0
    ) {
      const baselineReason =
        "SAFE_BASELINE_OVERRIDE (both sides soft-blocked; forcing 1/1 JOIN+1tick @ sizeMult=0.50)";
      overrideApplied = true;
      overrideReasons.push(baselineReason);
      quotePlan.quoteEnabled = true;
      quotePlan.blockedReasons = dedupeStrings([
        ...quotePlan.blockedReasons.filter((reason) => !String(reason).startsWith("UNKNOWN_BLOCK")),
        baselineReason
      ]);
      effectiveTargetLevels.buy = Math.max(1, effectiveTargetLevels.buy);
      effectiveTargetLevels.sell = Math.max(1, effectiveTargetLevels.sell);
      tobPolicy = "JOIN+1";
      buyQuoteSizeUsd = clamp(buyQuoteSizeUsd * 0.5, this.config.minQuoteSizeUsd, buyQuoteSizeUsd);
      sellQuoteSizeUsd = clamp(sellQuoteSizeUsd * 0.5, this.config.minQuoteSizeUsd, sellQuoteSizeUsd);
    }
    if (
      this.config.quotingMinLevelsFloorEnabled &&
      !quotePlan.hardHalt &&
      (quotePlan.quoteEnabled || pauseDrivenFloorCandidate)
    ) {
      const floorBuy = Math.max(0, Math.floor(this.config.quotingMinLevelsFloorBuy));
      const floorSell = Math.max(0, Math.floor(this.config.quotingMinLevelsFloorSell));
      const nextBuy = Math.max(effectiveTargetLevels.buy, floorBuy);
      const nextSell = Math.max(effectiveTargetLevels.sell, floorSell);
      if (nextBuy !== effectiveTargetLevels.buy || nextSell !== effectiveTargetLevels.sell) {
        minLevelsFloorApplied = true;
        effectiveTargetLevels.buy = nextBuy;
        effectiveTargetLevels.sell = nextSell;
        const floorCause =
          quotePlan.signalsState === "PAUSE"
            ? "signalsState=PAUSE"
            : quotePlan.newsState === "PAUSE"
              ? "newsState=PAUSE"
              : quotePlan.signalsState
                ? `signalsState=${quotePlan.signalsState}`
                : quotePlan.newsState
                  ? `newsState=${quotePlan.newsState}`
                  : "softState=NONE";
        quotePlan.blockedReasons = dedupeStrings([
          ...quotePlan.blockedReasons,
          `MIN_LEVELS_FLOOR_APPLIED (raw ${rawTargetLevels.buy}/${rawTargetLevels.sell} -> ${nextBuy}/${nextSell}, cause=${floorCause})`
        ]);
        if (!quotePlan.quoteEnabled) {
          quotePlan.quoteEnabled = true;
          quotePlan.blockedReasons = quotePlan.blockedReasons.filter(
            (reason) => !String(reason).startsWith("UNKNOWN_BLOCK")
          );
        }
      }
    }
    if (!quotePlan.hardHalt && quotePlan.quoteEnabled) {
      const baselineBuy = Math.max(1, effectiveTargetLevels.buy);
      const baselineSell = Math.max(1, effectiveTargetLevels.sell);
      if (baselineBuy !== effectiveTargetLevels.buy || baselineSell !== effectiveTargetLevels.sell) {
        overrideApplied = true;
        minLevelsFloorApplied = true;
        const reason = `ALWAYS_ON_BASELINE (levels ${effectiveTargetLevels.buy}/${effectiveTargetLevels.sell} -> ${baselineBuy}/${baselineSell})`;
        overrideReasons.push(reason);
        quotePlan.blockedReasons = dedupeStrings([...quotePlan.blockedReasons, reason]);
        effectiveTargetLevels.buy = baselineBuy;
        effectiveTargetLevels.sell = baselineSell;
      }
      if (quotePlan.tob === "OFF") {
        overrideApplied = true;
        const reason = `ALWAYS_ON_TOB_BASELINE (policy=${tobPolicy})`;
        overrideReasons.push(reason);
        quotePlan.blockedReasons = dedupeStrings([...quotePlan.blockedReasons, reason]);
      }
      quotePlan.tob = "BOTH";
      effectiveTargetLevels.tob = "BOTH";
    }
    const appliedSpreadMult =
      effectiveConfig.baseHalfSpreadBps > 0
        ? clamp(effectiveHalfSpread / effectiveConfig.baseHalfSpreadBps, 0, 10)
        : 1;
    const baseQuoteSizeForMult = Math.max(this.config.minQuoteSizeUsd, effectiveConfig.levelQuoteSizeUsd);
    const appliedSizeMult = clamp(
      Math.min(
        buyQuoteSizeUsd / Math.max(baseQuoteSizeForMult, 0.0000001),
        sellQuoteSizeUsd / Math.max(baseQuoteSizeForMult, 0.0000001)
      ),
      0,
      1
    );
    const policyTobOffsetTicks = tobPolicy === "JOIN+2" ? 2 : tobPolicy === "JOIN+1" ? 1 : 0;
    const tobOffsetTicks = Math.max(
      policyTobOffsetTicks,
      Math.max(0, Math.floor(Number(shockDecision.actions.tobStepBackTicks) || 0))
    );
    competitiveDistanceTicks = Math.max(competitiveDistanceTicks, tobOffsetTicks);
    quotePlan.blockedReasons = dedupeStrings(quotePlan.blockedReasons);
    publishQuoteDebug(quotePlan, quoteInputs);
    const plannerTargetLevels = {
      buy: Math.max(0, Math.floor(Number(effectiveTargetLevels.buy) || 0)),
      sell: Math.max(0, Math.floor(Number(effectiveTargetLevels.sell) || 0)),
      tob: effectiveTargetLevels.tob
    };
    const usedPlannerTob = plannerTargetLevels.tob;
    buyLevels = plannerTargetLevels.buy;
    sellLevels = plannerTargetLevels.sell;
    if (usedPlannerTob === "OFF") {
      tobMode = "OFF";
      allowTobBuy = false;
      allowTobSell = false;
      if (!quotePlan.quoteEnabled && quotePlan.blockedReasons.length > 0) {
        tobReason = `Quote plan disabled: ${quotePlan.blockedReasons[0]}`;
      } else if (!quotePlan.quoteEnabled && quotePlan.hardHaltReasons.length > 0) {
        tobReason = `Hard halt: ${quotePlan.hardHaltReasons[0]}`;
      }
    } else if (usedPlannerTob === "BUY") {
      tobMode = "BUY-ONLY";
      allowTobBuy = true;
      allowTobSell = false;
    } else if (usedPlannerTob === "SELL") {
      tobMode = "SELL-ONLY";
      allowTobBuy = false;
      allowTobSell = true;
    } else {
      tobMode = "BOTH";
      allowTobBuy = true;
      allowTobSell = true;
    }
    if (!quotePlan.hardHalt && tobMode !== "OFF") {
      tobReason = `Always-on TOB policy ${tobPolicy}`;
    }
    const seedAccumulateActive =
      ((quotePlan.seedMode === "SEED_BUY" || quotePlan.seedMode === "ACCUMULATE_BTC") ||
        reentryRebuildBtc) &&
      this.config.seedEnabled;
    const seedBuySizeUsd = clamp(
      this.config.seedBuyUsd,
      Math.max(0.01, this.config.quotingMinNotionalUsd),
      Math.max(this.config.seedBuyUsd, this.config.maxSeedBuyUsd)
    );
    if (seedAccumulateActive) {
      const beforeBuyQuoteSizeUsd = buyQuoteSizeUsd;
      buyQuoteSizeUsd = seedBuySizeUsd;
      if (beforeBuyQuoteSizeUsd !== buyQuoteSizeUsd) {
        const msg = `SEED_BUY_SIZE_APPLIED (buyQuoteSizeUsd=${beforeBuyQuoteSizeUsd.toFixed(2)} -> ${buyQuoteSizeUsd.toFixed(2)})`;
        quotePlan.blockedReasons.push(msg);
        buyReasons.push(msg);
      }
    }
    if (
      seedAccumulateActive
    ) {
      const before = bidHalfSpreadBps;
      bidHalfSpreadBps = Math.min(
        bidHalfSpreadBps,
        Math.max(0.1, Number(this.config.seedHalfSpreadBps) || 0.1)
      );
      if (bidHalfSpreadBps !== before) {
        const msg = `SEED_HALF_SPREAD_APPLIED (buyHalfSpread=${before.toFixed(2)} -> ${bidHalfSpreadBps.toFixed(2)})`;
        buyReasons.push(msg);
        sellReasons.push(msg);
      }
    }

    let plannerZeroOutputDetails: string | undefined;
    let desired = quotePlan.quoteEnabled
      ? buildDesiredQuotes({
          symbol: this.config.symbol,
          execution: this.execution,
          mid: ticker.mid,
          bestBid: ticker.bid,
          bestAsk: ticker.ask,
          tickSize,
          buyLevels: plannerTargetLevels.buy,
          sellLevels: plannerTargetLevels.sell,
          bidHalfSpreadBps,
          askHalfSpreadBps,
          levelStepBps: effectiveConfig.levelStepBps,
          competitiveDistanceTicks,
          maxDistanceFromTobBps: this.config.maxDistanceFromTobBps,
          buyQuoteSizeUsd,
          sellQuoteSizeUsd
        })
      : [];

    const topOfBookEnabled = tobMode !== "OFF";
    const topOfBookDiagnostics: string[] = [];
    topOfBookDiagnostics.push(`TOB mode ${tobMode}: ${tobReason}`);
    topOfBookDiagnostics.push(`TOB policy ${tobPolicy} (offsetTicks=${tobOffsetTicks})`);
    let topOfBookBuyAdded = false;
    let topOfBookSellAdded = false;

    if (topOfBookEnabled) {
      const tobUsd = roundUsd(tobQuoteSizeActive);
      const tobCapacity = effectiveConfig.maxActiveOrders - desired.length;
      const competitiveBid = enforcePostOnlyPrice(
        roundToTick(Math.max(tickSize, ticker.bid - tobOffsetTicks * tickSize), tickSize, "BUY"),
        "BUY",
        ticker.bid,
        ticker.ask,
        tickSize
      );
      const competitiveAsk = enforcePostOnlyPrice(
        roundToTick(Math.max(tickSize, ticker.ask + tobOffsetTicks * tickSize), tickSize, "SELL"),
        "SELL",
        ticker.bid,
        ticker.ask,
        tickSize
      );
      const hasCompetitiveBuy = desired.some(
        (row) => row.side === "BUY" && Math.abs(row.price - competitiveBid) < tickSize / 2
      );
      const hasCompetitiveSell = desired.some(
        (row) => row.side === "SELL" && Math.abs(row.price - competitiveAsk) < tickSize / 2
      );

      if (allowTobBuy && plannerTargetLevels.buy > 0 && tobCapacity > 0) {
        if (hasCompetitiveBuy) {
          topOfBookBuyAdded = true;
          topOfBookDiagnostics.push("TOB BUY already covered by competitive L0 quote");
        } else if (spendableUsd >= tobUsd) {
          desired.push({
            tag: this.execution.makeTag(this.config.symbol, "BUY", "L0-TOB"),
            side: "BUY",
            level: "L0-TOB",
            price: enforcePostOnlyPrice(
              roundToTick(Math.max(tickSize, ticker.bid - tobOffsetTicks * tickSize), tickSize, "BUY"),
              "BUY",
              ticker.bid,
              ticker.ask,
              tickSize
            ),
            quoteSizeUsd: tobUsd
          });
          topOfBookBuyAdded = true;
        } else {
          topOfBookDiagnostics.push(
            `TOB BUY skipped: usd_free ${fmtUsd(balances.usd_free)} below reserve + size`
          );
        }
      } else if (!allowTobBuy) {
        topOfBookDiagnostics.push("TOB BUY disabled by inventory rebalance policy");
      }

      if (allowTobSell && plannerTargetLevels.sell > 0 && effectiveConfig.maxActiveOrders - desired.length > 0) {
        if (hasCompetitiveSell) {
          topOfBookSellAdded = true;
          topOfBookDiagnostics.push("TOB SELL already covered by competitive L0 quote");
        } else if (spendableBtc * ticker.mid >= tobUsd) {
          desired.push({
            tag: this.execution.makeTag(this.config.symbol, "SELL", "L0-TOB"),
            side: "SELL",
            level: "L0-TOB",
            price: enforcePostOnlyPrice(
              roundToTick(Math.max(tickSize, ticker.ask + tobOffsetTicks * tickSize), tickSize, "SELL"),
              "SELL",
              ticker.bid,
              ticker.ask,
              tickSize
            ),
            quoteSizeUsd: tobUsd
          });
          topOfBookSellAdded = true;
        } else {
          topOfBookDiagnostics.push(
            `TOB SELL skipped: spendable_btc ${spendableBtc.toFixed(8)} insufficient for ${fmtUsd(tobUsd)}`
          );
        }
      } else if (!allowTobSell) {
        topOfBookDiagnostics.push("TOB SELL disabled by inventory rebalance policy");
      }
    } else if (effectiveConfig.tobEnabled) {
      topOfBookDiagnostics.push(
        `TOB disabled by guards (regime=${tobRegime}, vol=${volMoveBps.toFixed(2)}, calm<=${this.config.calmVolBps.toFixed(2)}, hot>${this.config.tobMaxVolBps.toFixed(2)}, inventoryRatio=${inventoryRatio.toFixed(3)}, cancels1h=${rolling.cancels_last_1h}, rejects1h=${rolling.post_only_rejects_last_1h})`
      );
    }

    const desiredBeforeMakerEdgeGuard = desired.slice();
    const makerMinEdgeBps = computeMakerMinEdgeBps(this.config.minMakerEdgeBps, marketSpreadBps);
    if (fairMidForGuards > 0 && Number.isFinite(fairMidForGuards) && desired.length > 0) {
      const edgeGuard = applyMakerQuoteGuard({
        orders: desired,
        fairMid: fairMidForGuards,
        minMakerEdgeBps: makerMinEdgeBps,
        currentSpreadBps: marketSpreadBps
      });
      if (edgeGuard.kept.length !== desired.length) {
        desired = edgeGuard.kept;
        const reason = `MAKER_EDGE_SOFT_FILTER (minMakerEdge=${edgeGuard.appliedMinMakerEdgeBps.toFixed(2)} fairMid=${fairMidForGuards.toFixed(2)} dropped=${desired.length === 0 ? "all" : "some"})`;
        quotePlan.blockedReasons.push(reason);
        if (edgeGuard.droppedBySide.BUY > 0) {
          const buyReason = `Maker guard dropped ${edgeGuard.droppedBySide.BUY} BUY maker levels below ${edgeGuard.appliedMinMakerEdgeBps.toFixed(2)} bps`;
          quotePlan.blockedReasons.push(`BUY_${buyReason}`);
          buyReasons.push(buyReason);
        }
        if (edgeGuard.droppedBySide.SELL > 0) {
          const sellReason = `Maker guard dropped ${edgeGuard.droppedBySide.SELL} SELL maker levels below ${edgeGuard.appliedMinMakerEdgeBps.toFixed(2)} bps`;
          quotePlan.blockedReasons.push(`SELL_${sellReason}`);
          sellReasons.push(sellReason);
        }
      }
    }
    if (quotePlan.quoteEnabled && !quotePlan.hardHalt && desired.length === 0) {
      const tobFallback = desiredBeforeMakerEdgeGuard.filter(
        (row) => String(row.level).toUpperCase() === "L0-TOB"
      );
      if (tobFallback.length > 0) {
        desired = tobFallback;
        quotePlan.blockedReasons.push(
          "MAKER_TOB_FALLBACK_APPLIED (edge filter would zero output; keeping TOB post-only maker quotes)"
        );
      }
    }
    if (seedAccumulateActive && quotePlan.quoteEnabled && !quotePlan.hardHalt) {
      const forcedSeedLevel: "SEED_BUY" | "REENTRY_BUY" = reentryRebuildBtc ? "REENTRY_BUY" : "SEED_BUY";
      const seeded = ensureSeedBuyOrder({
        orders: desired,
        symbol: this.config.symbol,
        execution: this.execution,
        bestBid: ticker.bid,
        bestAsk: ticker.ask,
        tickSize,
        quoteSizeUsd: seedBuySizeUsd,
        level: forcedSeedLevel
      });
      desired = seeded.orders;
      if (seeded.applied) {
        this.lastSeedOrderTs = ticker.ts;
        if (forcedSeedLevel === "REENTRY_BUY") {
          this.lastReentryBuyTs = ticker.ts;
        }
        const reason =
          forcedSeedLevel === "REENTRY_BUY" ? "REENTRY_OVERRIDE_BUY_FORCED" : "SEED_OVERRIDE_BUY_FORCED";
        quotePlan.blockedReasons.push(reason);
        buyReasons.push(`${reason} (maker buy injected at TOB)`);
      }
    }
    if (
      quotePlan.quoteEnabled &&
      !quotePlan.hardHalt &&
      plannerTargetLevels.sell > 0 &&
      plannerTargetLevels.buy <= 0 &&
      desired.length <= 0 &&
      quotePlan.blockedReasons.some((row) => String(row || "").toUpperCase().includes("BUY_LEVEL_SOFT_THROTTLE"))
    ) {
      desired = buildDesiredQuotes({
        symbol: this.config.symbol,
        execution: this.execution,
        mid: ticker.mid,
        bestBid: ticker.bid,
        bestAsk: ticker.ask,
        tickSize,
        buyLevels: 0,
        sellLevels: plannerTargetLevels.sell,
        bidHalfSpreadBps,
        askHalfSpreadBps,
        levelStepBps: effectiveConfig.levelStepBps,
        competitiveDistanceTicks,
        maxDistanceFromTobBps: this.config.maxDistanceFromTobBps,
        buyQuoteSizeUsd,
        sellQuoteSizeUsd
      });
      const reason = `SELL_SIDE_PRESERVED_UNDER_BUY_THROTTLE (sellLevels=${plannerTargetLevels.sell})`;
      quotePlan.blockedReasons = dedupeStrings([...quotePlan.blockedReasons, reason]);
      sellReasons.push(reason);
      buyReasons.push(reason);
    }
    const plannerShouldHaveOutput =
      quotePlan.quoteEnabled &&
      !quotePlan.hardHalt &&
      !runtimePauseActive &&
      !runtimeKillActive &&
      (plannerTargetLevels.buy > 0 || plannerTargetLevels.sell > 0);
    const plannerInvalidSize =
      !Number.isFinite(buyQuoteSizeUsd) ||
      !Number.isFinite(sellQuoteSizeUsd) ||
      buyQuoteSizeUsd <= 0 ||
      sellQuoteSizeUsd <= 0;
    const plannerMinNotionalBlocked =
      buyQuoteSizeUsd + 1e-9 < Math.max(0.01, this.config.quotingMinNotionalUsd) ||
      sellQuoteSizeUsd + 1e-9 < Math.max(0.01, this.config.quotingMinNotionalUsd);
    const plannerPostOnlyCrossBlocked = ticker.bid > 0 && ticker.ask > 0 && ticker.bid >= ticker.ask;
    const plannerAllowedZeroOutput = quotePlan.blockedReasons.some((row) => {
      const reason = String(row || "").toUpperCase();
      return (
        reason.includes("INVALID_SIZE") ||
        reason.includes("MIN_NOTIONAL") ||
        reason.includes("POST_ONLY_CROSS") ||
        reason.includes("POST_ONLY_WOULD_CROSS")
      );
    }) || plannerInvalidSize || plannerMinNotionalBlocked || plannerPostOnlyCrossBlocked;
    if (plannerShouldHaveOutput && desired.length <= 0 && !plannerAllowedZeroOutput) {
      plannerZeroOutputDetails =
        `usedLevelsBuy=${plannerTargetLevels.buy} usedLevelsSell=${plannerTargetLevels.sell} usedTob=${plannerTargetLevels.tob} blockedReasons=${quotePlan.blockedReasons.join(" | ") || "-"}`;
      const reason = `PLANNER_ZERO_OUTPUT (${plannerZeroOutputDetails})`;
      quotePlan.blockedReasons = dedupeStrings([...quotePlan.blockedReasons, reason]);
      buyReasons.push(reason);
      sellReasons.push(reason);
    }

    if (topOfBookBuyAdded) {
      buyReasons.push("TOB BUY active at best bid");
    }
    if (topOfBookSellAdded) {
      sellReasons.push("TOB SELL active at best ask");
    }
    for (const detail of topOfBookDiagnostics) {
      buyReasons.push(detail);
      sellReasons.push(detail);
    }
    for (const reason of quotePlan.blockedReasons) {
      const msg = `QuotePlan: ${reason}`;
      buyReasons.push(msg);
      sellReasons.push(msg);
    }
    for (const reason of quotePlan.hardHaltReasons) {
      const msg = `HardHalt: ${reason}`;
      buyReasons.push(msg);
      sellReasons.push(msg);
    }

    if (quotePlan.seedMode === "SEED_BUY" || quotePlan.seedMode === "ACCUMULATE_BTC") {
      if (this.seedStartTs <= 0) {
        this.seedStartTs = ticker.ts;
        this.seedReposts = 0;
        this.seedTakerFired = false;
        this.seedTakerClientOrderId = null;
        this.seedTakerVenueOrderId = null;
      }
      const hasSeedTob = desired.some(
        (row) =>
          row.side === "BUY" &&
          (String(row.level).toUpperCase() === "L0-TOB" ||
            String(row.level).toUpperCase() === "SEED_BUY" ||
            String(row.tag || "").toUpperCase().includes("SEED_BUY"))
      );
      if (hasSeedTob) {
        this.seedReposts += 1;
      }
      const seedElapsedSeconds = Math.max(0, (ticker.ts - this.seedStartTs) / 1000);
      const seedTimeExceeded = seedElapsedSeconds >= this.config.seedMaxSeconds;
      const seedRepostsExceeded = this.seedReposts >= this.config.seedMaxReposts;
      if (!this.seedTakerFired && btcNotional < lowBtcGate && (seedTimeExceeded || seedRepostsExceeded)) {
        const seedFailReason = seedTimeExceeded
          ? `SEED_TAKER_ELIGIBLE (elapsed=${seedElapsedSeconds.toFixed(1)}s >= max=${this.config.seedMaxSeconds}s, reposts=${this.seedReposts})`
          : `SEED_TAKER_ELIGIBLE (reposts=${this.seedReposts} >= max=${this.config.seedMaxReposts}, elapsed=${seedElapsedSeconds.toFixed(1)}s)`;

        if (!this.config.enableTakerSeed) {
          const makerOnlyReason = `SEED_MAKER_ONLY_CONTINUE (ENABLE_TAKER_SEED=false; ${seedFailReason})`;
          quotePlan.blockedReasons = dedupeStrings([...quotePlan.blockedReasons, makerOnlyReason]);
          buyReasons.push(makerOnlyReason);
          sellReasons.push(makerOnlyReason);
        } else if (this.config.dryRun) {
          buyReasons.push(`Seed taker disabled in DRY_RUN. ${seedFailReason}`);
          sellReasons.push(`Seed taker disabled in DRY_RUN. ${seedFailReason}`);
        } else if (!(ticker.ask > 0) || !Number.isFinite(ticker.ask)) {
          buyReasons.push(`Seed taker skipped: invalid ask price. ${seedFailReason}`);
          sellReasons.push(`Seed taker skipped: invalid ask price. ${seedFailReason}`);
        } else {
          const seedTakerUsd = Math.min(this.config.seedTakerUsd, this.config.seedTakerMaxUsd);
          const seedSlippageBps = Math.min(
            this.config.seedTakerSlippageBps,
            this.config.seedTakerMaxSlippageBps
          );
          const seedPrice = roundToTick(
            ticker.ask * (1 + seedSlippageBps / 10_000),
            tickSize,
            "BUY"
          );
          const fairMidForTaker = fairMidForGuards > 0 ? fairMidForGuards : ticker.mid;
          const expectedTakerEdgeBps =
            fairMidForTaker > 0
              ? ((fairMidForTaker - seedPrice) / fairMidForTaker) * 10_000
              : Number.NEGATIVE_INFINITY;
          const minTakerEdgeBps =
            this.config.minTakerEdgeBps +
            this.config.takerFeeBps +
            this.config.takerSlipBps +
            this.config.takerSafetyBps;
          if (expectedTakerEdgeBps < minTakerEdgeBps) {
            const msg = `TAKER_EDGE_TOO_LOW (edge=${expectedTakerEdgeBps.toFixed(2)} < min=${minTakerEdgeBps.toFixed(2)} bps)`;
            quoteBlockedReasons.push(msg);
            buyReasons.push(`Seed taker skipped by edge guard. ${msg}`);
            sellReasons.push(`Seed taker skipped by edge guard. ${msg}`);
          } else {
            try {
              const seedOrder = await this.execution.placeSeedTakerIocOrder({
                symbol: this.config.symbol,
                side: "BUY",
                price: seedPrice,
                quoteSizeUsd: seedTakerUsd,
                botTag: this.execution.makeTag(this.config.symbol, "BUY", "SEED-TAKER"),
                reason: seedFailReason
              });
              this.seedTakerFired = true;
              this.seedTakerClientOrderId = seedOrder.clientOrderId;
              this.seedTakerVenueOrderId = seedOrder.venueOrderId ?? null;
              const detailsJson = JSON.stringify({
                mode: quotePlan.seedMode,
                reason: seedFailReason,
                seedStartTs: this.seedStartTs,
                seedReposts: this.seedReposts,
                seedElapsedSeconds: Number(seedElapsedSeconds.toFixed(1)),
                btcNotionalUsd: Number(btcNotional.toFixed(2)),
                lowBtcGateUsd: Number(lowBtcGate.toFixed(2)),
                quoteSizeUsd: seedTakerUsd,
                slippageBps: seedSlippageBps,
                expectedTakerEdgeBps: Number(expectedTakerEdgeBps.toFixed(2)),
                minTakerEdgeBps: Number(minTakerEdgeBps.toFixed(2)),
                venueOrderId: seedOrder.venueOrderId ?? null,
                clientOrderId: seedOrder.clientOrderId,
                orderStatus: seedOrder.status
              });
              this.store.recordBotEvent({
                event_id: randomUUID(),
                ts: Date.now(),
                type: "SEED_TAKER",
                side: "BUY",
                price: seedPrice,
                quote_size_usd: seedTakerUsd,
                venue_order_id: seedOrder.venueOrderId ?? null,
                client_order_id: seedOrder.clientOrderId,
                reason: seedFailReason,
                bot_tag: "seed-taker",
                details_json: detailsJson
              });
              buyReasons.push(`Seed taker fired (${seedOrder.clientOrderId}) at ${fmtUsd(seedPrice)}.`);
              sellReasons.push(`Seed taker fired (${seedOrder.clientOrderId}) at ${fmtUsd(seedPrice)}.`);
            } catch (error) {
              this.seedTakerFired = true;
              this.store.recordBotEvent({
                event_id: randomUUID(),
                ts: Date.now(),
                type: "SEED_TAKER",
                side: "BUY",
                price: seedPrice,
                quote_size_usd: seedTakerUsd,
                venue_order_id: null,
                client_order_id: "-",
                reason: `${seedFailReason} FAILED`,
                bot_tag: "seed-taker",
                details_json: JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                  mode: quotePlan.seedMode,
                  seedStartTs: this.seedStartTs,
                  seedReposts: this.seedReposts
                })
              });
              buyReasons.push(
                `Seed taker attempt failed: ${error instanceof Error ? error.message : String(error)}`
              );
              sellReasons.push(
                `Seed taker attempt failed: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        }
      }
    } else {
      this.seedStartTs = 0;
      this.seedReposts = 0;
      this.seedTakerFired = false;
      this.seedTakerClientOrderId = null;
      this.seedTakerVenueOrderId = null;
    }
    await this.maybeExecuteTakerReentry({
      phase: shockDecision.phase,
      ticker,
      tickSize,
      fairMidForGuards,
      btcNotional,
      reentryTargetUsd,
      spreadBps: marketSpreadBps,
      dispersionBps: fairDispersionBps,
      vol1mBps,
      buyReasons,
      sellReasons
    });
    await this.maybeExecuteAdverseHedge({
      decision: adverseDecision,
      ticker,
      tickSize,
      fairMidForGuards,
      confidence: this.lastHybridSignal?.confidence ?? 0,
      btcNotional,
      targetBtcNotionalUsd,
      buyReasons,
      sellReasons
    });

    const balancePreflight = this.balanceManager.preflightQuotes({
      desired,
      minNotionalUsd: Math.max(0.01, this.config.quotingMinNotionalUsd),
      reserveUsd,
      reserveBtc,
      btcDustBuffer: this.config.balanceDustBtc,
      ts: ticker.ts
    });
    desired = balancePreflight.desired;
    if (balancePreflight.events.length > 0) {
      const reasonsFromEvents = balancePreflight.events.map(
        (event) =>
          `${event.side}_${event.reason} (tag=${event.tag} ${event.beforeQuoteUsd.toFixed(2)} -> ${event.afterQuoteUsd.toFixed(2)})`
      );
      quotePlan.blockedReasons = dedupeStrings([...quotePlan.blockedReasons, ...reasonsFromEvents]);
      const summaryBySide = {
        BUY: balancePreflight.events.filter((event) => event.side === "BUY").length,
        SELL: balancePreflight.events.filter((event) => event.side === "SELL").length
      };
      if (summaryBySide.BUY > 0) {
        buyReasons.push(
          `Balance preflight adjusted/skipped ${summaryBySide.BUY} BUY orders (${balancePreflight.perSideBlockReasons.BUY.join(" | ") || "insufficient USD"})`
        );
      }
      if (summaryBySide.SELL > 0) {
        sellReasons.push(
          `Balance preflight adjusted/skipped ${summaryBySide.SELL} SELL orders (${balancePreflight.perSideBlockReasons.SELL.join(" | ") || "insufficient BTC"})`
        );
      }
    }
    const clampSnapshot = this.balanceManager.getClampSnapshot();

    seedDebugState.update({
      seedMode: quotePlan.seedMode ?? "TWO_SIDED",
      seedStartTs: this.seedStartTs,
      seedReposts: this.seedReposts,
      seedTakerFired: this.seedTakerFired,
      lastSeedOrderIds: {
        clientOrderId: this.seedTakerClientOrderId,
        venueOrderId: this.seedTakerVenueOrderId
      },
      btcNotionalUsd: quotePlan.seedProgress?.btcNotionalUsd ?? btcNotional,
      lowGateUsd: quotePlan.seedProgress?.lowGateUsd ?? lowBtcGate,
      targetUsd: quotePlan.seedProgress?.targetUsd ?? targetBtcNotionalUsd,
      blockedReasons: quotePlan.blockedReasons,
      lastUpdatedTs: ticker.ts
    });

    const finalBuyEnabled = desired.some((q) => q.side === "BUY");
    const finalSellEnabled = desired.some((q) => q.side === "SELL");

    const decisionTargets = desired.map((q) => ({
      tag: q.tag,
      side: q.side,
      level: q.level,
      price: q.price,
      quote_size_usd: q.quoteSizeUsd
    }));
    const crossSignal = crossVenue?.signal ?? null;
    const crossVenueState = (crossVenue?.venues ?? []).map((venue) => ({
      venue: venue.venue,
      mid: venue.mid,
      spread_bps: venue.spread_bps,
      age_ms: venue.age_ms,
      ok: venue.ok && !venue.stale,
      latency_ms: venue.latency_ms,
      weight: venue.weight,
      error: venue.error ?? null
    }));

    const botStatusBase = {
      ts: ticker.ts,
      mid: ticker.mid,
      exposure_usd: btcNotional,
      balances: {
        freeUsd: this.lastBalanceSnapshotRuntime.freeUsd,
        freeBtc: this.lastBalanceSnapshotRuntime.freeBtc,
        reservedUsd: this.lastBalanceSnapshotRuntime.reservedUsd,
        reservedBtc: this.lastBalanceSnapshotRuntime.reservedBtc,
        spendableUsd: this.lastBalanceSnapshotRuntime.spendableUsd,
        spendableBtc: this.lastBalanceSnapshotRuntime.spendableBtc
      },
      market_phase: shockDecision.phase,
      phase_reasons: shockDecision.reasons.slice(0, 8),
      phase_since_ts: shockDecision.sinceTs,
      shock_vol_peak_bps: shockDecision.shockVolPeakBps,
      inventory_action: inventoryAction,
      inventory_bands: {
        floor: floorBtcNotionalUsd,
        target: reentryTargetUsd,
        cap: capBtcNotionalUsd,
        hysteresis: inventoryHysteresisUsd
      },
      phase_aware_caps: {
        maxSellUsdPerHour: this.config.phaseAwareMaxSellUsdPerHour,
        seedBuyUsd: seedBuySizeUsd
      },
      shock_state:
        shockDecision.phase === "SHOCK"
          ? "SHOCK"
          : shockDecision.phase === "COOLDOWN"
            ? "COOLDOWN"
            : shockDecision.phase === "RECOVERY"
              ? "REENTRY"
              : "NORMAL",
      shock_reasons: shockDecision.reasons.slice(0, 8),
      shock_since_ts: shockDecision.sinceTs,
      reentry_progress: {
        btcNotionalUsd: btcNotional,
        targetUsd: reentryTargetUsd,
        seedOrdersPlaced: this.seedReposts,
        lastSeedTs: Math.max(this.lastSeedOrderTs, this.lastReentryBuyTs)
      },
      error_policy: this.getErrorPolicySnapshot(ticker.ts),
      market_spread_bps: marketSpreadBps,
      vol_move_bps: volMoveBps,
      trend_move_bps: trendMoveBps,
      spread_mult: spreadMult,
      inventory_ratio: inventoryRatio,
      skew_bps_applied: skewBps,
      fills_30m: rolling.fills_last_30m,
      fills_1h: rolling.fills_last_1h,
      avg_edge_buy_1h: edgeLookback.avgBuy,
      avg_edge_sell_1h: edgeLookback.avgSell,
      cancels_1h: rolling.cancels_last_1h,
      rejects_1h: rolling.post_only_rejects_last_1h,
      adaptive_spread_bps_delta: adaptiveSpreadDeltaBps,
      churn_warning: churnWarning,
      adaptive_reasons: adaptiveAdjustments,
      tob_mode: tobMode,
      tob_reason: tobReason,
      sell_throttle_state: sellThrottleState,
      seed_start_ts: this.seedStartTs > 0 ? this.seedStartTs : 0,
      seed_reposts: this.seedReposts,
      seed_attempts: this.seedReposts,
      seed_taker_fired: this.seedTakerFired,
      intel_state: intelPosture.state,
      intel_impact: intelPosture.impact,
      intel_direction: intelPosture.direction,
      intel_confidence: intelPosture.confidence,
      intel_spread_mult: intelAdjustment.spreadMult,
      intel_size_mult: intelAdjustment.sizeMult,
      intel_tob_override: intelAdjustment.tobModeOverride,
      intel_trade_guard_active: intelAdjustment.hardBlock,
      ...mapAdverseSelectionStatus(),
      quoting: mapStatusQuoting(quotePlan, ticker.ts, undefined, {
        target: rawTargetLevels,
        effective: effectiveTargetLevels,
        minLevelsFloorApplied
      }, {
        tobPolicy,
        appliedSpreadMult,
        appliedSizeMult,
        lowVolMode,
        volMoveBps,
        minVolMoveBps: this.config.minVolMoveBpsToQuote,
        overrideApplied,
        overrideReasons,
        marketPhase: shockDecision.phase,
        phaseReasons: shockDecision.reasons,
        phaseSinceTs: shockDecision.sinceTs,
        shockVolPeakBps: shockDecision.shockVolPeakBps,
        inventoryAction,
        bands: {
          floor: floorBtcNotionalUsd,
          target: reentryTargetUsd,
          cap: capBtcNotionalUsd,
          hysteresis: inventoryHysteresisUsd
        },
        phaseAwareCaps: {
          maxSellUsdPerHour: this.config.phaseAwareMaxSellUsdPerHour,
          seedBuyUsd: seedBuySizeUsd
        },
        shockState:
          shockDecision.phase === "SHOCK"
            ? "SHOCK"
            : shockDecision.phase === "COOLDOWN"
              ? "COOLDOWN"
              : shockDecision.phase === "RECOVERY"
                ? "REENTRY"
                : "NORMAL",
        shockReasons: shockDecision.reasons,
        shockSinceTs: shockDecision.sinceTs,
        reentryProgress: {
          btcNotionalUsd: btcNotional,
          targetUsd: reentryTargetUsd,
          seedOrdersPlaced: this.seedReposts,
          lastSeedTs: Math.max(this.lastSeedOrderTs, this.lastReentryBuyTs)
        },
        errorPolicy: this.getErrorPolicySnapshot(ticker.ts)
      }),
      quoting_inputs: mapLegacyQuoteInputs(quoteInputs),
      allow_buy: finalBuyEnabled,
      allow_sell: finalSellEnabled,
      buy_reasons: buyReasons,
      sell_reasons: sellReasons
    } as BotStatus & Record<string, unknown>;
    this.store.upsertBotStatus(botStatusBase);
    this.store.recordMetric({ ts: ticker.ts, key: "signalGlobalMid", value: this.lastHybridSignal?.globalMid ?? 0 });
    this.store.recordMetric({ ts: ticker.ts, key: "signalFairMid", value: this.lastHybridSignal?.fairMid ?? 0 });
    this.store.recordMetric({ ts: ticker.ts, key: "signalBasisBps", value: this.lastHybridSignal?.basisBps ?? 0 });
    this.store.recordMetric({ ts: ticker.ts, key: "signalDispersionBps", value: this.lastHybridSignal?.dispersionBps ?? 0 });
    this.store.recordMetric({ ts: ticker.ts, key: "signalConfidence", value: this.lastHybridSignal?.confidence ?? 0 });
    this.store.recordMetric({
      ts: ticker.ts,
      key: "signalRegime",
      value: signalRegimeToNumber(this.lastHybridSignal?.regime ?? "CALM")
    });
    this.store.recordMetric({
      ts: ticker.ts,
      key: "signalBias",
      value: signalBiasToNumber(this.lastHybridSignal?.bias ?? "NEUTRAL")
    });
    this.store.recordMetric({ ts: ticker.ts, key: "adverseToxicityScore", value: adverseDecision.toxicityScore });
    this.store.recordMetric({
      ts: ticker.ts,
      key: "adverseState",
      value: adverseStateToNumber(adverseDecision.state)
    });
    this.store.recordMetric({ ts: ticker.ts, key: "adverseSpreadMult", value: adverseDecision.adverseSpreadMult });
    this.store.recordMetric({ ts: ticker.ts, key: "seedAttempts", value: this.seedReposts });
    this.store.recordMetric({ ts: ticker.ts, key: "seedReposts", value: this.seedReposts });
    this.store.recordMetric({ ts: ticker.ts, key: "seedTakerFired", value: this.seedTakerFired ? 1 : 0 });
    this.store.recordMetric({ ts: ticker.ts, key: "newsImpact", value: newsDecision.impact });
    this.store.recordMetric({ ts: ticker.ts, key: "newsDirection", value: newsDirectionToNumber(newsDecision.direction) });
    this.store.recordMetric({ ts: ticker.ts, key: "newsConfidence", value: newsDecision.confidence });
    this.store.recordMetric({ ts: ticker.ts, key: "newsState", value: newsStateToNumber(newsDecision.state) });
    this.store.recordMetric({ ts: ticker.ts, key: "newsLastTs", value: newsDecision.lastHeadlineTs });
    this.store.recordMetric({ ts: ticker.ts, key: "signalsImpact", value: signalsDecision.impact });
    this.store.recordMetric({ ts: ticker.ts, key: "signalsDirection", value: newsDirectionToNumber(signalsDecision.direction) });
    this.store.recordMetric({ ts: ticker.ts, key: "signalsConfidence", value: signalsDecision.confidence });
    this.store.recordMetric({ ts: ticker.ts, key: "signalsState", value: newsStateToNumber(signalsDecision.state) });
    this.store.recordMetric({
      ts: ticker.ts,
      key: "signalsLastTs",
      value: this.lastSignalsSnapshot?.aggregate?.latestTs ?? 0
    });
    this.store.recordMetric({ ts: ticker.ts, key: "intelImpact", value: intelPosture.impact });
    this.store.recordMetric({ ts: ticker.ts, key: "intelConfidence", value: intelPosture.confidence });
    this.store.recordMetric({
      ts: ticker.ts,
      key: "intelState",
      value: intelStateToNumber(intelPosture.state)
    });

    this.store.recordStrategyDecision({
      ts: ticker.ts,
      mid: ticker.mid,
      spread_mult: spreadMult,
      inventory_ratio: inventoryRatio,
      details_json: JSON.stringify({
        market_spread_bps: marketSpreadBps,
        vol_move_bps: volMoveBps,
        trend_move_bps: trendMoveBps,
        trend_applied: trendEffect.applied,
        trend_mode: trendEffect.mode,
        trend_direction: trendEffect.direction,
        effective_half_spread_bps_before_adaptive: effectiveHalfSpreadBeforeAdaptive,
        effective_half_spread_bps_after_adaptive: effectiveHalfSpread,
        adaptive_spread_bps_delta: adaptiveSpreadDeltaBps,
        adaptive_adjustments_applied: adaptiveAdjustments,
        signal_state: {
          enabled: this.config.enableCrossVenueSignals,
          ts: this.lastHybridSignal?.ts ?? crossSignal?.ts ?? signalState.ts,
          ema: signalState.ema,
          global_mid: this.lastHybridSignal?.globalMid ?? crossSignal?.global_mid ?? ticker.mid,
          fair_mid: this.lastHybridSignal?.fairMid ?? crossSignal?.fair_mid ?? ticker.mid,
          basis_bps: this.lastHybridSignal?.basisBps ?? crossSignal?.basis_bps ?? 0,
          vol_regime: this.lastHybridSignal?.volRegimeLegacy ?? crossSignal?.vol_regime ?? signalState.volRegime,
          regime: this.lastHybridSignal?.regime ?? "CALM",
          bias: this.lastHybridSignal?.bias ?? "NEUTRAL",
          bias_confidence: this.lastHybridSignal?.biasConfidence ?? 0,
          drift_bps: this.lastHybridSignal?.driftBps ?? crossSignal?.drift_bps ?? signalState.driftBps,
          z_score: crossSignal?.z_score ?? signalState.zScore,
          confidence: this.lastHybridSignal?.confidence ?? crossSignal?.confidence ?? signalState.confidence,
          stdev_bps: crossSignal?.stdev_bps ?? signalState.stdevBps,
          dispersion_bps: this.lastHybridSignal?.dispersionBps ?? crossSignal?.dispersion_bps ?? 0,
          venues: crossVenueState
        },
        fair_mid: this.lastHybridSignal?.fairMid ?? crossSignal?.fair_mid ?? ticker.mid,
        basis_bps: this.lastHybridSignal?.basisBps ?? crossSignal?.basis_bps ?? 0,
        dispersion_bps: this.lastHybridSignal?.dispersionBps ?? crossSignal?.dispersion_bps ?? 0,
        cross_venue_confidence: this.lastHybridSignal?.confidence ?? crossSignal?.confidence ?? 0,
        signal_skew_bps_applied: signalSkewBps,
        signal_bias_skew_bps_applied: signalBiasSkewBps,
        signal_spread_action: signalSpreadAction,
        fills_last_1h: rolling.fills_last_1h,
        fills_last_30m: rolling.fills_last_30m,
        edge_lookback_minutes: this.config.edgeLookbackMinutes,
        edge_lookback_avg_buy_bps: edgeLookback.avgBuy,
        edge_lookback_avg_sell_bps: edgeLookback.avgSell,
        edge_lookback_avg_total_bps: edgeLookback.avgTotal,
        rolling_metrics: rolling,
        inventory_skew_bps: inventorySkewBps,
        total_skew_bps: skewBps,
        side_edge_adjust_bid_bps: sideEdgeAdjust.bidBps,
        side_edge_adjust_ask_bps: sideEdgeAdjust.askBps,
        bid_half_spread_bps: bidHalfSpreadBps,
        ask_half_spread_bps: askHalfSpreadBps,
        equity_usd: equityUsd,
        dynamic_target_btc: this.config.dynamicTargetBtc,
        target_btc_notional_usd: targetBtcNotionalUsd,
        max_btc_notional_usd: maxBtcNotionalUsd,
        low_btc_gate: lowBtcGate,
        btc_total: balances.btc_total,
        btc_free: balances.btc_free,
        btc_notional_usd: btcNotional,
        max_sell_by_bal: maxSellByBal,
        buy_quote_size_usd: buyQuoteSizeUsd,
        sell_quote_size_usd: sellQuoteSizeUsd,
        target_prices: decisionTargets,
        buy_levels: buyLevels,
        sell_levels: sellLevels,
        sell_throttle_state: sellThrottleState,
        top_of_book_enabled: topOfBookEnabled,
        top_of_book_mode: tobMode,
        top_of_book_reason: tobReason,
        top_of_book_regime: tobRegime,
        top_of_book_quote_size_usd: tobQuoteSizeActive,
        top_of_book_buy_added: topOfBookBuyAdded,
        top_of_book_sell_added: topOfBookSellAdded,
        top_of_book_diagnostics: topOfBookDiagnostics,
        adverse_selection: {
          avg_bps: adverseSelection.asAvgBps,
          bad_rate: adverseSelection.asBadRate,
          last_bps: adverseSelection.asLastBps,
          samples: adverseSelection.asSamples,
          toxic: adverseSelection.asToxic,
          widen_bps: adverseSelection.asWidenBps,
          cooldown_remaining_seconds: adverseSelection.asCooldownRemainingSeconds,
          toxicity_score: adverseDecision.toxicityScore,
          state: adverseDecision.state,
          spread_mult: adverseDecision.adverseSpreadMult,
          markout_avg_bps: adverseDecision.markoutAvgBps,
          markout_count: adverseDecision.markoutCount,
          reasons: adverseDecision.reasons
        },
        news_signal: {
          state: newsDecision.state,
          impact: newsDecision.impact,
          direction: newsDecision.direction,
          confidence: newsDecision.confidence,
          spread_mult: newsDecision.spreadMult,
          size_mult: newsDecision.sizeMult,
          allow_buy: newsDecision.allowBuy,
          allow_sell: newsDecision.allowSell,
          pause_makers: newsDecision.pauseMakers,
          allow_taker_flatten_only: newsDecision.allowTakerFlattenOnly,
          cooldown_remaining_seconds: newsDecision.cooldownRemainingSeconds,
          last_headline_ts: newsDecision.lastHeadlineTs,
          reasons: newsDecision.reasons
        },
        signals_signal: {
          state: signalsDecision.state,
          impact: signalsDecision.impact,
          direction: signalsDecision.direction,
          confidence: signalsDecision.confidence,
          spread_mult_extra: signalsDecision.spreadMultExtra,
          size_mult_extra: signalsDecision.sizeMultExtra,
          gate_buy: signalsDecision.gateBuy,
          gate_sell: signalsDecision.gateSell,
          pause_makers: signalsDecision.pauseMakers,
          allow_taker_flatten_only: signalsDecision.allowTakerFlattenOnly,
          cooldown_remaining_seconds: signalsDecision.cooldownRemainingSeconds,
          latest_ts: this.lastSignalsSnapshot?.aggregate?.latestTs ?? 0,
          reasons: signalsDecision.reasons
        },
        intel_signal: {
          state: intelPosture.state,
          impact: intelPosture.impact,
          direction: intelPosture.direction,
          confidence: intelPosture.confidence,
          widen_bps: intelPosture.widenBps,
          size_cut: intelPosture.sizeCut,
          skew_bps: intelPosture.skewBps,
          halt_until_ts: intelPosture.haltUntilTs,
          reasons: intelPosture.reasons,
          adjustment: {
            spread_mult: intelAdjustment.spreadMult,
            size_mult: intelAdjustment.sizeMult,
            tob_mode_override: intelAdjustment.tobModeOverride,
            hard_block: intelAdjustment.hardBlock,
            cooldown_seconds: intelAdjustment.cooldownSeconds,
            reason_codes: intelAdjustment.reasonCodes
          },
          guard_enabled: this.config.enableIntelTradeGuard
        },
        shock_signal: {
          state: shockDecision.state,
          since_ts: shockDecision.sinceTs,
          reasons: shockDecision.reasons,
          actions: shockDecision.actions
        },
        error_policy: this.getErrorPolicySnapshot(ticker.ts),
        quote_plan: {
          quote_enabled: quotePlan.quoteEnabled,
          blocked_reasons: quotePlan.blockedReasons,
          buy_levels: quotePlan.buyLevels,
          sell_levels: quotePlan.sellLevels,
          tob: quotePlan.tob,
          news_state: quotePlan.newsState ?? "NORMAL",
          news_impact: quotePlan.newsImpact ?? 0,
          news_direction: quotePlan.newsDirection ?? "NEUTRAL",
          news_confidence: quotePlan.newsConfidence ?? 0,
          news_reasons: quotePlan.newsReasons ?? [],
          signals_state: quotePlan.signalsState ?? "NORMAL",
          signals_impact: quotePlan.signalsImpact ?? 0,
          signals_direction: quotePlan.signalsDirection ?? "NEUTRAL",
          signals_confidence: quotePlan.signalsConfidence ?? 0,
          signals_reasons: quotePlan.signalsReasons ?? [],
          adverse_state: quotePlan.adverseState ?? "NORMAL",
          adverse_toxicity_score: quotePlan.toxicityScore ?? 0,
          adverse_reasons: quotePlan.adverseReasons ?? [],
          regime: quotePlan.regime ?? "CALM",
          bias: quotePlan.bias ?? "NEUTRAL",
          bias_confidence: quotePlan.biasConfidence ?? 0,
          signal_confidence: quotePlan.signalConfidence ?? 0,
          global_mid: quotePlan.globalMid ?? 0,
          fair_mid: quotePlan.fairMid ?? 0,
          basis_bps: quotePlan.basisBps ?? 0,
          dispersion_bps: quotePlan.dispersionBps ?? 0,
          shock_state: quotePlan.shockState ?? "NORMAL",
          shock_reasons: quotePlan.shockReasons ?? [],
          shock_since_ts: quotePlan.shockSinceTs ?? 0,
          seed_mode: quotePlan.seedMode ?? "TWO_SIDED",
          seed_reason: quotePlan.seedReason ?? "",
          seed_progress: quotePlan.seedProgress ?? null,
          seed_start_ts: this.seedStartTs > 0 ? this.seedStartTs : null,
          seed_reposts: this.seedReposts,
          seed_attempts: this.seedReposts,
          seed_taker_fired: this.seedTakerFired,
          seed_taker_client_order_id: this.seedTakerClientOrderId,
          seed_taker_venue_order_id: this.seedTakerVenueOrderId
        },
        quote_inputs: {
          vol_move_bps: volMoveBps,
          market_spread_bps: marketSpreadBps,
          usd_free: balances.usd_free,
          reserve_usd: reserveUsd,
          spendable_usd: spendableUsd,
          btc_free: balances.btc_free,
          reserve_btc: reserveBtc,
          spendable_btc: spendableBtc,
          btc_notional_usd: btcNotional,
          trend_move_bps: trendMoveBps,
          low_btc_gate_usd: lowBtcGate,
          target_btc_notional_usd: targetBtcNotionalUsd,
          max_btc_notional_usd: maxBtcNotionalUsd,
          min_vol_move_bps_to_quote: this.config.minVolMoveBpsToQuote,
          min_market_spread_bps: effectiveConfig.minMarketSpreadBps,
          trend_pause_bps: this.config.trendPauseBps,
          vol_protect_mode: this.config.volProtectMode,
          vol_widen_mult_min: this.config.volWidenMultMin,
          vol_widen_mult_max: this.config.volWidenMultMax,
          seed_force_tob: this.config.seedForceTob,
          seed_half_spread_bps: this.config.seedHalfSpreadBps,
          seed_max_seconds: this.config.seedMaxSeconds,
          seed_max_reposts: this.config.seedMaxReposts,
          seed_enabled: this.config.seedEnabled,
          enable_taker_seed: this.config.enableTakerSeed,
          seed_taker_max_usd: this.config.seedTakerMaxUsd,
          seed_taker_max_slippage_bps: this.config.seedTakerMaxSlippageBps,
          seed_taker_usd: this.config.seedTakerUsd,
          seed_taker_slippage_bps: this.config.seedTakerSlippageBps,
          hedge_enabled: this.config.hedgeEnabled,
          hedge_max_usd_per_min: this.config.hedgeMaxUsdPerMin,
          hedge_max_slippage_bps: this.config.hedgeMaxSlippageBps,
          signals_impact: signalsDecision.impact,
          signals_direction: signalsDecision.direction,
          signals_confidence: signalsDecision.confidence,
          signals_state: signalsDecision.state,
          news_impact: newsDecision.impact,
          news_direction: newsDecision.direction,
          news_confidence: newsDecision.confidence,
          news_state: newsDecision.state
        },
        runtime_overrides_active: effectiveConfig.overridesActive,
        runtime_override_keys: effectiveConfig.activeOverrideKeys,
        runtime_override_source: effectiveConfig.overrideSource,
        runtime_override_updated_at_ms: effectiveConfig.overrideUpdatedAtMs,
        effective_config: {
          enabled: effectiveConfig.enabled,
          allowBuy: effectiveConfig.allowBuy,
          allowSell: effectiveConfig.allowSell,
          levelsBuy: effectiveConfig.levelsBuy,
          levelsSell: effectiveConfig.levelsSell,
          levelQuoteSizeUsd: effectiveConfig.levelQuoteSizeUsd,
          baseHalfSpreadBps: effectiveConfig.baseHalfSpreadBps,
          levelStepBps: effectiveConfig.levelStepBps,
          minMarketSpreadBps: effectiveConfig.minMarketSpreadBps,
          repriceMoveBps: effectiveConfig.repriceMoveBps,
          queueRefreshSeconds: effectiveConfig.queueRefreshSeconds,
          tobEnabled: effectiveConfig.tobEnabled,
          tobQuoteSizeUsd: effectiveConfig.tobQuoteSizeUsd,
          targetBtcNotionalUsd: effectiveConfig.targetBtcNotionalUsd,
          maxBtcNotionalUsd: effectiveConfig.maxBtcNotionalUsd,
          skewMaxBps: effectiveConfig.skewMaxBps,
          cashReserveUsd: effectiveConfig.cashReserveUsd,
          workingCapUsd: effectiveConfig.workingCapUsd,
          maxActiveOrders: effectiveConfig.maxActiveOrders,
          maxActionsPerLoop: effectiveConfig.maxActionsPerLoop
        }
      })
    });

    const nowForRefresh = Date.now();
    const hardRiskCancel =
      quotePlan.hardHalt ||
      hardHaltReasons.length > 0 ||
      btcNotional > maxBtcNotionalUsd;
    const suppressSoftCancels = competitivePosture === "CAUTION" && !hardRiskCancel;
    const quoteRefreshDue =
      this.lastQuoteRefreshTs <= 0 ||
      nowForRefresh - this.lastQuoteRefreshTs >= this.config.quoteRefreshSeconds * 1000;
    const shouldRefreshQuotes = hardRiskCancel || quoteRefreshDue;
    let reconcileOutcome: ReconcileOutcome;
    if (shouldRefreshQuotes) {
      reconcileOutcome = await this.reconcileDesiredOrders(
        ticker.mid,
        ticker.bid,
        ticker.ask,
        tickSize,
        desired,
        activeBotOrders,
        effectiveConfig.maxActionsPerLoop,
        effectiveConfig.repriceMoveBps,
        effectiveConfig.queueRefreshSeconds,
        lowMovement ? 10 : 0,
        hardRiskCancel,
        suppressSoftCancels
      );
      this.lastQuoteRefreshTs = nowForRefresh;
    } else {
      reconcileOutcome = {
        actionsUsed: 0,
        placed: 0,
        cancelled: 0,
        kept: activeBotOrders.length,
        cancelReasonCounts: {},
        lastCancelReason: null,
        refreshSkipped: true,
        refreshSkipReason: `QUOTE_REFRESH_THROTTLED (every ${this.config.quoteRefreshSeconds.toFixed(2)}s)`
      };
    }
    let postReconcileActiveOrders = this.store.getActiveBotOrders(this.config.symbol);
    let openVenueSides = this.countOpenVenueSides(postReconcileActiveOrders);
    let whyNotQuoting: string | undefined;
    let whyNotQuotingDetails: string | undefined;
    let forceBaselineApplied = false;
    if (plannerZeroOutputDetails) {
      whyNotQuoting = "PLANNER_ZERO_OUTPUT";
      whyNotQuotingDetails = plannerZeroOutputDetails;
    }

    const quoteOrExplainApplies =
      quotePlan.quoteEnabled &&
      !quotePlan.hardHalt;
    const minNotionalForInvariant = Math.max(0.01, this.config.quotingMinNotionalUsd);
    const canFundBuyInvariant = spendableUsd >= minNotionalForInvariant;
    const canFundSellInvariant = spendableBtc * ticker.mid >= minNotionalForInvariant;
    const missingBuyVenue = openVenueSides.buy < 1 && canFundBuyInvariant;
    const missingSellVenue = openVenueSides.sell < 1 && canFundSellInvariant;
    if (quoteOrExplainApplies && (missingBuyVenue || missingSellVenue)) {
      if (plannerZeroOutputDetails) {
        whyNotQuoting = "PLANNER_ZERO_OUTPUT";
        whyNotQuotingDetails = plannerZeroOutputDetails;
      } else {
        const why = this.computeWhyNotQuoting({
          tickerAgeMs,
          desired,
          buyQuoteSizeUsd,
          sellQuoteSizeUsd,
          minNotionalUsd: Math.max(0.01, this.config.quotingMinNotionalUsd),
          bestBid: ticker.bid,
          bestAsk: ticker.ask,
          actionBudget: effectiveConfig.maxActionsPerLoop,
          actionsUsed: reconcileOutcome.actionsUsed,
          refreshSkipped: reconcileOutcome.refreshSkipped,
          refreshSkipReason: reconcileOutcome.refreshSkipReason,
          quotePlan,
          missingBuy: missingBuyVenue,
          missingSell: missingSellVenue,
          usedLevelsBuy: plannerTargetLevels.buy,
          usedLevelsSell: plannerTargetLevels.sell,
          usedTob: plannerTargetLevels.tob,
          perSideBlockReasons: {
            buy: extractSideBlockReasons(quotePlan.blockedReasons, "BUY"),
            sell: extractSideBlockReasons(quotePlan.blockedReasons, "SELL")
          }
        });
        whyNotQuoting = why.reason;
        whyNotQuotingDetails = why.details;
      }

      if (this.config.quotingForceBaselineWhenEnabled) {
        const baseline = await this.placeForcedBaseline({
          tickerMid: ticker.mid,
          bestBid: ticker.bid,
          bestAsk: ticker.ask,
          tickSize,
          balances: {
            usd_free: balances.usd_free,
            btc_free: balances.btc_free
          },
          reserveUsd,
          reserveBtc,
          maxBtcNotionalUsd,
          btcNotionalUsd: btcNotional,
          missingBuy: missingBuyVenue,
          missingSell: missingSellVenue,
          remainingActionsBudget: Math.max(
            0,
            effectiveConfig.maxActionsPerLoop - reconcileOutcome.actionsUsed
          )
        });
        if (baseline.applied) {
          forceBaselineApplied = true;
          reconcileOutcome.actionsUsed += baseline.actionsUsed;
          reconcileOutcome.placed += baseline.placed;
          quotePlan.blockedReasons = dedupeStrings([
            ...quotePlan.blockedReasons,
            "FORCE_BASELINE_APPLIED"
          ]);
        }
        if (baseline.details.length > 0) {
          const detail = baseline.details.join(" | ");
          buyReasons.push(`Baseline: ${detail}`);
          sellReasons.push(`Baseline: ${detail}`);
        }
        if (baseline.errors.length > 0) {
          const errorText = baseline.errors.join(" | ");
          whyNotQuoting = "ORDER_API_ERRORS";
          whyNotQuotingDetails = errorText;
          quotePlan.blockedReasons = dedupeStrings([
            ...quotePlan.blockedReasons,
            `FORCE_BASELINE_ERROR (${errorText})`
          ]);
          botStatusBase.lastError = errorText;
          this.logger.warn({ errors: baseline.errors }, "Forced baseline placement errors");
        }
      }

      postReconcileActiveOrders = this.store.getActiveBotOrders(this.config.symbol);
      openVenueSides = this.countOpenVenueSides(postReconcileActiveOrders);
      if (openVenueSides.buy < 1 || openVenueSides.sell < 1) {
        if (this.baselineInvariantMissingSinceTs <= 0) {
          this.baselineInvariantMissingSinceTs = Date.now();
        }
        if (Date.now() - this.baselineInvariantMissingSinceTs >= 5_000) {
          whyNotQuoting = "ORDER_ACK_MISSING";
          whyNotQuotingDetails =
            `forced baseline active but venue-open sides still missing (buy=${openVenueSides.buy} sell=${openVenueSides.sell})`;
          botStatusBase.lastError = whyNotQuotingDetails;
          orderReconcileState.markReconcileError(whyNotQuotingDetails, Date.now());
          if (Date.now() - this.baselineAckMissingLoggedAtTs >= 5_000) {
            this.baselineAckMissingLoggedAtTs = Date.now();
            this.logger.warn(
              {
                buyOpen: openVenueSides.buy,
                sellOpen: openVenueSides.sell,
                quoteEnabled: quotePlan.quoteEnabled
              },
              "Forced baseline submitted but venue ack missing"
            );
          }
        }
      } else {
        this.baselineInvariantMissingSinceTs = 0;
        this.baselineAckMissingLoggedAtTs = 0;
      }
    } else {
      this.baselineInvariantMissingSinceTs = 0;
      this.baselineAckMissingLoggedAtTs = 0;
    }

    const perSideBlockReasons = {
      buy: extractSideBlockReasons(quotePlan.blockedReasons, "BUY"),
      sell: extractSideBlockReasons(quotePlan.blockedReasons, "SELL")
    };
    if (desired.length <= 0) {
      const zeroOutputFallbackReason =
        quotePlan.blockedReasons[0]?.trim() || whyNotQuoting || "PLANNER_ZERO_OUTPUT";
      if (perSideBlockReasons.buy.length === 0) {
        perSideBlockReasons.buy = [zeroOutputFallbackReason];
      }
      if (perSideBlockReasons.sell.length === 0) {
        perSideBlockReasons.sell = [zeroOutputFallbackReason];
      }
    }

    const lastPlannerOutputSummary: PlannerOutputSummary = {
      desiredCount: desired.length,
      buyLevels: Math.max(0, Math.floor(Number(quotePlan.buyLevels) || 0)),
      sellLevels: Math.max(0, Math.floor(Number(quotePlan.sellLevels) || 0)),
      tob: quotePlan.tob,
      usedLevelsBuy: plannerTargetLevels.buy,
      usedLevelsSell: plannerTargetLevels.sell,
      usedTob: plannerTargetLevels.tob,
      perSideBlockReasons,
      actionBudget: Math.max(0, Math.floor(Number(effectiveConfig.maxActionsPerLoop) || 0)),
      actionsUsed: Math.max(0, Math.floor(Number(reconcileOutcome.actionsUsed) || 0)),
      openBuyVenue: openVenueSides.buy,
      openSellVenue: openVenueSides.sell
    };
    botStatusBase.quoting = mapStatusQuoting(quotePlan, ticker.ts, reconcileOutcome, {
      target: rawTargetLevels,
      effective: effectiveTargetLevels,
      minLevelsFloorApplied
    }, {
      tobPolicy,
      appliedSpreadMult,
      appliedSizeMult,
      makerMinEdgeBps,
      takerMinEdgeBps: this.config.minTakerEdgeBps,
      takerFeeBps: this.config.takerFeeBps,
      slippageBufferBps: this.config.takerSlipBps,
      lastSeedOrderTs: this.lastSeedOrderTs,
      lowVolMode,
      volMoveBps,
      minVolMoveBps: this.config.minVolMoveBpsToQuote,
      whyNotQuoting,
      whyNotQuotingDetails,
      lastPlannerOutputSummary,
      forceBaselineApplied,
      overrideApplied,
      overrideReasons,
      lastClampEvents: clampSnapshot.lastClampEvents,
      clampCounters: clampSnapshot.clampCounters,
      marketPhase: shockDecision.phase,
      phaseReasons: shockDecision.reasons,
      phaseSinceTs: shockDecision.sinceTs,
      shockVolPeakBps: shockDecision.shockVolPeakBps,
      inventoryAction,
      bands: {
        floor: floorBtcNotionalUsd,
        target: reentryTargetUsd,
        cap: capBtcNotionalUsd,
        hysteresis: inventoryHysteresisUsd
      },
      phaseAwareCaps: {
        maxSellUsdPerHour: this.config.phaseAwareMaxSellUsdPerHour,
        seedBuyUsd: seedBuySizeUsd
      },
      shockState:
        shockDecision.phase === "SHOCK"
          ? "SHOCK"
          : shockDecision.phase === "COOLDOWN"
            ? "COOLDOWN"
            : shockDecision.phase === "RECOVERY"
              ? "REENTRY"
              : "NORMAL",
      shockReasons: shockDecision.reasons,
      shockSinceTs: shockDecision.sinceTs,
      reentryProgress: {
        btcNotionalUsd: btcNotional,
        targetUsd: reentryTargetUsd,
        seedOrdersPlaced: this.seedReposts,
        lastSeedTs: Math.max(this.lastSeedOrderTs, this.lastReentryBuyTs)
      },
      errorPolicy: this.getErrorPolicySnapshot(ticker.ts)
    });
    this.store.upsertBotStatus({
      ...botStatusBase,
      action_budget_used: reconcileOutcome.actionsUsed,
      action_budget_max: effectiveConfig.maxActionsPerLoop
    });

    const now = Date.now();
    if (now - this.lastMetricsLogMs >= this.config.metricsLogEverySeconds * 1000) {
      this.lastMetricsLogMs = now;
      this.logger.info(
        {
          mid: ticker.mid,
          marketSpreadBps: Number(marketSpreadBps.toFixed(2)),
          volMoveBps: Number(volMoveBps.toFixed(2)),
          trendMoveBps: Number(trendMoveBps.toFixed(2)),
          spreadMult: Number(spreadMult.toFixed(3)),
          adaptiveSpreadDeltaBps: Number(adaptiveSpreadDeltaBps.toFixed(2)),
          adaptiveAdjustments,
          effectiveHalfSpreadBps: Number(effectiveHalfSpread.toFixed(2)),
          signalVolRegime: signalState.volRegime,
          signalEma: Number(signalState.ema.toFixed(2)),
          signalZScore: Number(signalState.zScore.toFixed(3)),
          signalDriftBps: Number(signalState.driftBps.toFixed(2)),
          signalSkewBpsApplied: Number(signalSkewBps.toFixed(2)),
          signalStdevBps: Number(signalState.stdevBps.toFixed(3)),
          signalConfidence: Number(signalState.confidence.toFixed(2)),
          fillsLast30m: rolling.fills_last_30m,
          fillsLast1h: rolling.fills_last_1h,
          avgEdgeBuy: Number(edgeLookback.avgBuy.toFixed(2)),
          avgEdgeSell: Number(edgeLookback.avgSell.toFixed(2)),
          cancels1h: rolling.cancels_last_1h,
          postOnlyRejects1h: rolling.post_only_rejects_last_1h,
          inventoryRatio: Number(inventoryRatio.toFixed(3)),
          skewBps: Number(skewBps.toFixed(2)),
          btcNotional: Number(btcNotional.toFixed(2)),
          targetBtcNotionalUsd: Number(targetBtcNotionalUsd.toFixed(2)),
          lowBtcGate: Number(lowBtcGate.toFixed(2)),
          buyLevels,
          sellLevels,
          quoteEnabled: quotePlan.quoteEnabled,
          quoteBlockedReasons: quotePlan.blockedReasons,
          quotePlanTob: quotePlan.tob,
          signalRegime: this.lastHybridSignal?.regime ?? "CALM",
          signalBias: this.lastHybridSignal?.bias ?? "NEUTRAL",
          signalBiasConfidence: Number((this.lastHybridSignal?.biasConfidence ?? 0).toFixed(2)),
          signalGlobalMid: Number((this.lastHybridSignal?.globalMid ?? 0).toFixed(2)),
          signalFairMid: Number((this.lastHybridSignal?.fairMid ?? 0).toFixed(2)),
          signalBasisBps: Number((this.lastHybridSignal?.basisBps ?? 0).toFixed(2)),
          signalDispersionBps: Number((this.lastHybridSignal?.dispersionBps ?? 0).toFixed(2)),
          adverseState: adverseDecision.state,
          adverseToxicityScore: Number(adverseDecision.toxicityScore.toFixed(3)),
          adverseSpreadMult: Number(adverseDecision.adverseSpreadMult.toFixed(3)),
          adverseReasons: adverseDecision.reasons,
          newsState: newsDecision.state,
          newsImpact: Number(newsDecision.impact.toFixed(3)),
          newsDirection: newsDecision.direction,
          newsConfidence: Number(newsDecision.confidence.toFixed(3)),
          newsReasons: newsDecision.reasons,
          seedMode: quotePlan.seedMode ?? "TWO_SIDED",
          seedProgress: quotePlan.seedProgress ?? null,
          seedStartTs: this.seedStartTs,
          seedReposts: this.seedReposts,
          seedTakerFired: this.seedTakerFired,
          inventoryAction,
          inventoryBands: {
            floor: Number(floorBtcNotionalUsd.toFixed(2)),
            target: Number(reentryTargetUsd.toFixed(2)),
            cap: Number(capBtcNotionalUsd.toFixed(2)),
            hysteresis: Number(inventoryHysteresisUsd.toFixed(2))
          },
          phaseAwareCaps: {
            maxSellUsdPerHour: Number(this.config.phaseAwareMaxSellUsdPerHour.toFixed(2)),
            sellNotionalFilled1hUsd: Number(sellNotionalFilled1hUsd.toFixed(2)),
            seedBuyUsd: Number(seedBuySizeUsd.toFixed(2))
          },
          marketPhase: shockDecision.phase,
          shockState:
            shockDecision.phase === "SHOCK"
              ? "SHOCK"
              : shockDecision.phase === "COOLDOWN"
                ? "COOLDOWN"
                : shockDecision.phase === "RECOVERY"
                  ? "REENTRY"
                  : "NORMAL",
          shockReasons: shockDecision.reasons,
          errorPolicy: this.getErrorPolicySnapshot(now),
          venueRawBalancesTs: BalanceState.getSnapshot().lastVenueBalancesTs,
          topOfBookBuyAdded,
          topOfBookSellAdded,
          tobMode,
          tobReason,
          sellThrottleState,
          rejectsSpiking,
          churnWarning,
          actionsUsed: reconcileOutcome.actionsUsed,
          cycleActions: {
            placed: reconcileOutcome.placed,
            cancelled: reconcileOutcome.cancelled,
            kept: reconcileOutcome.kept
          },
          cancelReasonCounts: reconcileOutcome.cancelReasonCounts,
          lastCancelReason: reconcileOutcome.lastCancelReason,
          quoteRefreshSkipped: reconcileOutcome.refreshSkipped,
          quoteRefreshSkipReason: reconcileOutcome.refreshSkipReason,
          actionBudgetMax: effectiveConfig.maxActionsPerLoop,
          buyQuoteSizeUsd: Number(buyQuoteSizeUsd.toFixed(2)),
          sellQuoteSizeUsd: Number(sellQuoteSizeUsd.toFixed(2)),
          maxSellByBal
        },
        "Maker v2 snapshot"
      );
    }
    } catch (error) {
      cycleErrored = true;
      this.logger.error({ symbol: this.config.symbol, error }, "Cycle failed");
      throw error;
    } finally {
      if (!cycleErrored) {
        this.logger.info({ symbol: this.config.symbol }, "Cycle complete");
      }
    }
  }

  private activateRuntimeHardHalt(reason: string): void {
    const normalized = String(reason || "RUNTIME_HARD_HALT").trim();
    if (!normalized) return;
    if (this.runtimeHardHalt.active && this.runtimeHardHalt.reason === normalized) {
      return;
    }
    this.runtimeHardHalt = {
      active: true,
      reason: normalized,
      sinceTs: Date.now()
    };
    this.logger.error(
      {
        reason: normalized,
        sinceTs: this.runtimeHardHalt.sinceTs
      },
      "Runtime hard halt latched"
    );
  }

  private recordRecoverableError(message: string): void {
    const now = Date.now();
    this.recoverableErrorsTs.push(now);
    this.pruneErrorWindows(now);
    this.lastRecoverableError = String(message || "RECOVERABLE_ERROR").slice(0, 500);
  }

  private registerTransientError(classification: StrategyRuntimeErrorClassification): void {
    const now = Date.now();
    if (classification.isServerFailure) {
      this.transientServerErrorsTs.push(now);
    }
    this.pruneErrorWindows(now);
  }

  private nextTransientBackoffMs(): number {
    const next = this.privateCallBackoffMs > 0 ? this.privateCallBackoffMs * 2 : 1_000;
    return Math.max(500, Math.min(30_000, Math.floor(next)));
  }

  private shouldEscalateServerFailures(): boolean {
    const now = Date.now();
    this.pruneErrorWindows(now);
    return this.transientServerErrorsTs.length >= this.config.fatal5xxThreshold;
  }

  private pruneErrorWindows(nowTs: number): void {
    const now = Math.max(0, Number(nowTs) || Date.now());
    const recoverableCutoff = now - 5 * 60 * 1000;
    while (this.recoverableErrorsTs.length > 0 && this.recoverableErrorsTs[0] < recoverableCutoff) {
      this.recoverableErrorsTs.shift();
    }
    const transientCutoff = now - this.config.fatal5xxWindowMinutes * 60 * 1000;
    while (this.transientServerErrorsTs.length > 0 && this.transientServerErrorsTs[0] < transientCutoff) {
      this.transientServerErrorsTs.shift();
    }
  }

  private getErrorPolicySnapshot(nowTs = Date.now()): ErrorPolicySnapshot {
    this.pruneErrorWindows(nowTs);
    return {
      recoverableCount5m: this.recoverableErrorsTs.length,
      lastRecoverableError: this.lastRecoverableError,
      transientBackoffMs: Math.max(0, this.privateCallBackoffUntilTs - nowTs),
      hardHalt: this.runtimeHardHalt.active,
      hardHaltReason: this.runtimeHardHalt.reason
    };
  }

  private applyRiskStateHysteresis(
    key: RiskHysteresisKey,
    proposedState: SoftRiskState,
    ts: number,
    reasons?: string[]
  ): SoftRiskState {
    const nowTs = Math.max(0, Number(ts) || Date.now());
    const entry = this.riskHysteresis[key];
    const current = entry.currentState;
    const proposed = normalizeSoftRiskState(proposedState);
    if (proposed === current) {
      entry.pendingState = null;
      entry.pendingSinceTs = 0;
      return current;
    }

    const currentRank = softRiskStateRank(current);
    const proposedRank = softRiskStateRank(proposed);
    const worsen = proposedRank > currentRank;
    const requiredMs = worsen ? RISK_WORSEN_PERSIST_MS : RISK_RELAX_PERSIST_MS;

    if (entry.pendingState !== proposed) {
      entry.pendingState = proposed;
      entry.pendingSinceTs = nowTs;
      if (Array.isArray(reasons)) {
        const msg = worsen
          ? `STATE_WORSEN_PENDING (${key}: ${current} -> ${proposed}, hold ${Math.floor(
              requiredMs / 1000
            )}s)`
          : `STATE_RELAX_PENDING (${key}: ${current} -> ${proposed}, clean ${Math.floor(
              requiredMs / 1000
            )}s)`;
        reasons.push(msg);
      }
      return current;
    }

    const pendingForMs = nowTs - entry.pendingSinceTs;
    if (pendingForMs < requiredMs) {
      if (Array.isArray(reasons)) {
        const msg = worsen
          ? `STATE_WORSEN_PENDING (${key}: ${current} -> ${proposed}, ${Math.floor(
              pendingForMs / 1000
            )}/${Math.floor(requiredMs / 1000)}s)`
          : `STATE_RELAX_PENDING (${key}: ${current} -> ${proposed}, ${Math.floor(
              pendingForMs / 1000
            )}/${Math.floor(requiredMs / 1000)}s)`;
        reasons.push(msg);
      }
      return current;
    }

    entry.currentState = proposed;
    entry.pendingState = null;
    entry.pendingSinceTs = 0;
    if (Array.isArray(reasons)) {
      reasons.push(`STATE_HYSTERESIS_APPLIED (${key}: ${current} -> ${proposed})`);
    }
    return proposed;
  }

  private updateAdverseSelectionState(
    nowTs: number,
    latestMid: number
  ): AdverseSelectionRuntimeSummary {
    const now = Math.max(0, Number(nowTs) || Date.now());
    const sampleLimit = Math.max(1, this.config.asSampleFills);
    const fills = this.store
      .getRecentFills(Math.max(sampleLimit * 4, 200))
      .slice()
      .sort((a, b) => a.ts - b.ts);

    for (const fill of fills) {
      const order = this.store.getOrderByVenueId(fill.venue_order_id);
      const side: Side | null =
        order?.side === "BUY" || order?.side === "SELL" ? order.side : null;
      if (!side) continue;

      const fillTs = Math.max(0, Number(fill.ts) || 0);
      if (!(fillTs > 0)) continue;

      const fillMidRaw = Number(fill.mid_at_fill);
      const fillMid =
        Number.isFinite(fillMidRaw) && fillMidRaw > 0
          ? fillMidRaw
          : Number.isFinite(Number(fill.price)) && Number(fill.price) > 0
            ? Number(fill.price)
            : Number(latestMid) > 0
              ? Number(latestMid)
              : 0;
      if (!(fillMid > 0)) continue;

      const fillIdParts = [String(fill.venue_order_id || ""), String(fill.trade_id || "")]
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const fallbackId = `${fillTs}:${side}:${Number(fill.price) || 0}:${Number(fill.qty) || 0}`;
      const fillId = fillIdParts.length > 0 ? fillIdParts.join(":") : fallbackId;

      this.asTracker.ingestFill({
        id: fillId,
        ts: fillTs,
        side,
        fillMid
      });
    }

    const trackerSummary: AdverseSelectionSummary = this.asTracker.onTick({
      ts: now,
      latestMid: Number(latestMid) > 0 ? Number(latestMid) : 0
    });

    this.asLastSummary = {
      asAvgBps: trackerSummary.as_avg_bps,
      asBadRate: trackerSummary.as_bad_rate,
      asLastBps: trackerSummary.as_last_bps,
      asSamples: trackerSummary.as_samples,
      asToxic: trackerSummary.as_toxic,
      asWidenBps: trackerSummary.widen_bps_applied,
      asCooldownRemainingSeconds: trackerSummary.cooldown_remaining_s,
      inCooldown: trackerSummary.in_cooldown
    };
    return this.asLastSummary;
  }

  private buildAdverseMarkouts(nowTs: number, fillLimit: number): AdverseMarkoutPoint[] {
    const fills = this.store
      .getRecentFills(Math.max(20, fillLimit))
      .slice()
      .sort((a, b) => a.ts - b.ts);
    const snapshots = this.store
      .getRecentTickerSnapshots(this.config.symbol, 2_000)
      .slice()
      .sort((a, b) => a.ts - b.ts);
    if (fills.length === 0 || snapshots.length === 0) {
      return [];
    }

    const latestMid = snapshots[snapshots.length - 1]?.mid ?? 0;
    const maxWindow = Math.max(0, ...this.config.adverseMarkoutWindowsMs);
    const oldestTs = nowTs - Math.max(120_000, maxWindow * 3);
    const markouts: AdverseMarkoutPoint[] = [];

    for (const fill of fills) {
      if (fill.ts < oldestTs) continue;
      const order = this.store.getOrderByVenueId(fill.venue_order_id);
      const side = order?.side === "BUY" || order?.side === "SELL" ? order.side : null;
      if (!side) continue;
      const fillMid = Number(fill.mid_at_fill);
      const referenceMid =
        Number.isFinite(fillMid) && fillMid > 0
          ? fillMid
          : Number.isFinite(Number(fill.price)) && Number(fill.price) > 0
            ? Number(fill.price)
            : latestMid > 0
              ? latestMid
              : 0;
      if (!(referenceMid > 0)) continue;

      for (const windowMsRaw of this.config.adverseMarkoutWindowsMs) {
        const windowMs = Math.max(1000, Math.floor(windowMsRaw));
        const targetTs = fill.ts + windowMs;
        const futureMid = this.findMidAtOrAfter(snapshots, targetTs) ?? latestMid;
        if (!(futureMid > 0)) continue;
        const markoutBps =
          side === "BUY"
            ? ((futureMid - referenceMid) / referenceMid) * 10_000
            : ((referenceMid - futureMid) / referenceMid) * 10_000;
        markouts.push({
          ts: fill.ts,
          side,
          fillMid: referenceMid,
          futureMid,
          windowMs,
          markoutBps
        });
      }
    }
    return markouts;
  }

  private findMidAtOrAfter(
    snapshots: Array<{ ts: number; mid: number }>,
    targetTs: number
  ): number | null {
    for (const row of snapshots) {
      if (row.ts >= targetTs && row.mid > 0) return row.mid;
    }
    const latest = snapshots[snapshots.length - 1];
    return latest && latest.mid > 0 ? latest.mid : null;
  }

  private async maybeExecuteTakerReentry(params: {
    phase: MarketPhase;
    ticker: { bid: number; ask: number; mid: number; ts: number };
    tickSize: number;
    fairMidForGuards: number;
    btcNotional: number;
    reentryTargetUsd: number;
    spreadBps: number;
    dispersionBps: number;
    vol1mBps: number;
    buyReasons: string[];
    sellReasons: string[];
  }): Promise<void> {
    if (!this.config.enableTakerReentry) return;
    if (this.config.dryRun) return;
    if (params.phase !== "RECOVERY") return;
    if (!(params.btcNotional < params.reentryTargetUsd * 0.7)) return;
    if (params.vol1mBps > this.config.shockEnterBps * 0.8) return;
    if (params.dispersionBps > this.config.recoveryDispersionBps * 1.2) return;

    const now = Date.now();
    if (this.takerReentryWindowStartTs <= 0 || now - this.takerReentryWindowStartTs >= 60 * 60 * 1000) {
      this.takerReentryWindowStartTs = now;
      this.takerReentrySpentUsdInWindow = 0;
    }
    const remainingBudget = Math.max(
      0,
      this.config.maxTakerReentryUsdPerHour - this.takerReentrySpentUsdInWindow
    );
    if (remainingBudget < Math.max(0.01, this.config.quotingMinNotionalUsd)) return;

    const targetSpendUsd = clamp(
      this.config.seedBuyUsd,
      Math.max(0.01, this.config.quotingMinNotionalUsd),
      Math.max(remainingBudget, this.config.quotingMinNotionalUsd)
    );
    const rawPrice =
      params.ticker.ask > 0
        ? params.ticker.ask * (1 + this.config.seedTakerSlippageBps / 10_000)
        : 0;
    if (!(rawPrice > 0)) return;
    const price = roundToTick(rawPrice, params.tickSize, "BUY");
    const fairMid = params.fairMidForGuards > 0 ? params.fairMidForGuards : params.ticker.mid;
    if (!(fairMid > 0)) return;
    const expectedEdgeBps = ((fairMid - price) / fairMid) * 10_000;
    const minEdge =
      this.config.takerFeeBps +
      this.config.takerSlipBps +
      this.config.takerSafetyBps +
      this.config.reentryMinEdgeOverFeesBps;
    if (expectedEdgeBps < minEdge) {
      const reason = `TAKER_REENTRY_SKIPPED_EDGE (edge=${expectedEdgeBps.toFixed(2)} < min=${minEdge.toFixed(2)})`;
      params.buyReasons.push(reason);
      params.sellReasons.push(reason);
      return;
    }

    try {
      const order = await this.execution.placeSeedTakerIocOrder({
        symbol: this.config.symbol,
        side: "BUY",
        price,
        quoteSizeUsd: targetSpendUsd,
        botTag: this.execution.makeTag(this.config.symbol, "BUY", "REENTRY-TAKER"),
        reason: "REENTRY_TAKER_RECOVERY"
      });
      this.takerReentrySpentUsdInWindow += targetSpendUsd;
      this.lastReentryBuyTs = params.ticker.ts;
      this.store.recordBotEvent({
        event_id: randomUUID(),
        ts: Date.now(),
        type: "SEED_TAKER",
        side: "BUY",
        price,
        quote_size_usd: targetSpendUsd,
        venue_order_id: order.venueOrderId ?? null,
        client_order_id: order.clientOrderId,
        reason: "REENTRY_TAKER_RECOVERY",
        bot_tag: "reentry-taker",
        details_json: JSON.stringify({
          phase: params.phase,
          btcNotional: Number(params.btcNotional.toFixed(2)),
          targetUsd: Number(params.reentryTargetUsd.toFixed(2)),
          expectedEdgeBps: Number(expectedEdgeBps.toFixed(2)),
          minEdgeBps: Number(minEdge.toFixed(2)),
          remainingBudget: Number(
            Math.max(0, this.config.maxTakerReentryUsdPerHour - this.takerReentrySpentUsdInWindow).toFixed(2)
          )
        })
      });
      const reason = `REENTRY_TAKER_EXECUTED (${targetSpendUsd.toFixed(2)} @ ${price.toFixed(2)})`;
      params.buyReasons.push(reason);
      params.sellReasons.push(reason);
    } catch (error) {
      const reason = `REENTRY_TAKER_FAILED (${error instanceof Error ? error.message : String(error)})`;
      params.buyReasons.push(reason);
      params.sellReasons.push(reason);
      this.logger.warn({ error }, "Recovery taker reentry failed");
    }
  }

  private async maybeExecuteAdverseHedge(params: {
    decision: AdverseSelectionDecision;
    ticker: { bid: number; ask: number; mid: number; ts: number };
    tickSize: number;
    fairMidForGuards: number;
    confidence: number;
    btcNotional: number;
    targetBtcNotionalUsd: number;
    buyReasons: string[];
    sellReasons: string[];
  }): Promise<void> {
    if (!this.config.hedgeEnabled) return;
    if (!params.decision.takerHedgeAllowed) return;
    if (this.config.hedgeOnlyWhenConfident && params.confidence < this.config.signalMinConf) {
      params.buyReasons.push(
        `HEDGE_SKIPPED_LOW_CONF (conf=${params.confidence.toFixed(2)} < min=${this.config.signalMinConf.toFixed(2)})`
      );
      params.sellReasons.push(
        `HEDGE_SKIPPED_LOW_CONF (conf=${params.confidence.toFixed(2)} < min=${this.config.signalMinConf.toFixed(2)})`
      );
      return;
    }

    const now = Date.now();
    if (this.hedgeWindowStartTs <= 0 || now - this.hedgeWindowStartTs >= 60_000) {
      this.hedgeWindowStartTs = now;
      this.hedgeSpentUsdInWindow = 0;
    }
    const remainingBudget = Math.max(0, this.config.hedgeMaxUsdPerMin - this.hedgeSpentUsdInWindow);
    if (remainingBudget <= 0.5) {
      return;
    }

    const deltaUsd = params.btcNotional - params.targetBtcNotionalUsd;
    if (Math.abs(deltaUsd) < 5) return;
    const side: Side = deltaUsd > 0 ? "SELL" : "BUY";
    const desiredUsd = Math.min(Math.abs(deltaUsd), remainingBudget, this.config.hedgeMaxUsdPerMin);
    if (desiredUsd < 1) return;

    const maxSlip = this.config.hedgeMaxSlippageBps;
    const rawPrice =
      side === "BUY"
        ? params.ticker.ask * (1 + maxSlip / 10_000)
        : params.ticker.bid * (1 - maxSlip / 10_000);
    if (!(rawPrice > 0) || !Number.isFinite(rawPrice)) return;
    const price = roundToTick(rawPrice, params.tickSize, side);

    const fairMid = params.fairMidForGuards > 0 ? params.fairMidForGuards : params.ticker.mid;
    const expectedTakerEdgeBps =
      fairMid > 0
        ? side === "BUY"
          ? ((fairMid - price) / fairMid) * 10_000
          : ((price - fairMid) / fairMid) * 10_000
        : Number.NEGATIVE_INFINITY;
    const minEdge =
      this.config.minTakerEdgeBps +
      this.config.takerFeeBps +
      this.config.takerSlipBps +
      this.config.takerSafetyBps;
    if (expectedTakerEdgeBps < minEdge) {
      const msg = `TAKER_EDGE_TOO_LOW (edge=${expectedTakerEdgeBps.toFixed(2)} < min=${minEdge.toFixed(2)} bps)`;
      params.buyReasons.push(`Hedge skipped by fee/edge guard. ${msg}`);
      params.sellReasons.push(`Hedge skipped by fee/edge guard. ${msg}`);
      return;
    }

    try {
      const order = await this.execution.placeSeedTakerIocOrder({
        symbol: this.config.symbol,
        side,
        price,
        quoteSizeUsd: desiredUsd,
        botTag: this.execution.makeTag(this.config.symbol, side, "ADVERSE-HEDGE"),
        reason: `ADVERSE_HEDGE ${params.decision.state}`
      });
      this.hedgeSpentUsdInWindow += desiredUsd;
      this.store.recordBotEvent({
        event_id: randomUUID(),
        ts: Date.now(),
        type: "HEDGE",
        side,
        price,
        quote_size_usd: desiredUsd,
        venue_order_id: order.venueOrderId ?? null,
        client_order_id: order.clientOrderId,
        reason: `ADVERSE_HEDGE ${params.decision.state}`,
        bot_tag: "adverse-hedge",
        details_json: JSON.stringify({
          state: params.decision.state,
          toxicityScore: Number(params.decision.toxicityScore.toFixed(3)),
          confidence: Number(params.confidence.toFixed(3)),
          remainingBudgetAfter: Number(
            Math.max(0, this.config.hedgeMaxUsdPerMin - this.hedgeSpentUsdInWindow).toFixed(2)
          ),
          btcNotional: Number(params.btcNotional.toFixed(2)),
          targetBtcNotionalUsd: Number(params.targetBtcNotionalUsd.toFixed(2)),
          expectedTakerEdgeBps: Number(expectedTakerEdgeBps.toFixed(2)),
          minEdgeBps: Number(minEdge.toFixed(2))
        })
      });
      const message = `Adverse hedge ${side} IOC fired (${order.clientOrderId}) ${fmtUsd(desiredUsd)} @ ${fmtUsd(price)}.`;
      params.buyReasons.push(message);
      params.sellReasons.push(message);
    } catch (error) {
      const message = `Adverse hedge failed: ${error instanceof Error ? error.message : String(error)}`;
      params.buyReasons.push(message);
      params.sellReasons.push(message);
      this.logger.warn(
        {
          error,
          side,
          desiredUsd: Number(desiredUsd.toFixed(2)),
          state: params.decision.state
        },
        "Adverse hedge IOC failed"
      );
    }
  }

  private logQuoteBlockedIfNeeded(plan: QuotePlan, inputs: QuoteInputs): void {
    if (plan.quoteEnabled) return;
    const now = Date.now();
    if (now - this.lastQuoteBlockedLogMs < QUOTE_BLOCKED_LOG_THROTTLE_MS) return;
    this.lastQuoteBlockedLogMs = now;
    this.logger.warn(
      {
        reasons: plan.blockedReasons.slice(0, 2),
        planned: {
          buyLevels: plan.buyLevels,
          sellLevels: plan.sellLevels,
          tob: plan.tob
        },
        inputs: {
          marketSpreadBps: Number(inputs.marketSpreadBps.toFixed(2)),
          volMoveBps: Number(inputs.volMoveBps.toFixed(2)),
          trendMoveBps: Number(inputs.trendMoveBps.toFixed(2)),
          usdFree: Number(inputs.usdFree.toFixed(2)),
          btcNotionalUsd: Number(inputs.btcNotionalUsd.toFixed(2)),
          inventoryRatio: Number(inputs.inventoryRatio.toFixed(3))
        }
      },
      "Quote plan disabled"
    );
  }

  private countOpenVenueSides(orders: OrderRecord[]): OpenVenueSideCounts {
    let buy = 0;
    let sell = 0;
    for (const order of orders) {
      if (!order || String(order.venue_order_id ?? "").trim().length === 0) continue;
      const side = String(order.side ?? "").toUpperCase();
      if (side === "BUY") buy += 1;
      if (side === "SELL") sell += 1;
    }
    return { buy, sell };
  }

  private computeWhyNotQuoting(params: {
    tickerAgeMs: number;
    desired: DesiredQuote[];
    buyQuoteSizeUsd: number;
    sellQuoteSizeUsd: number;
    minNotionalUsd: number;
    bestBid: number;
    bestAsk: number;
    actionBudget: number;
    actionsUsed: number;
    refreshSkipped: boolean;
    refreshSkipReason: string;
    quotePlan: QuotePlan;
    missingBuy: boolean;
    missingSell: boolean;
    usedLevelsBuy: number;
    usedLevelsSell: number;
    usedTob: "OFF" | "BUY" | "SELL" | "BOTH";
    perSideBlockReasons: {
      buy: string[];
      sell: string[];
    };
  }): WhyNotQuotingInfo {
    if (params.tickerAgeMs > 5_000) {
      return {
        reason: "MARKET_DATA_STALE",
        details: `tickerAgeMs=${Math.floor(params.tickerAgeMs)}`
      };
    }

    if (
      !Number.isFinite(params.buyQuoteSizeUsd) ||
      !Number.isFinite(params.sellQuoteSizeUsd) ||
      params.buyQuoteSizeUsd <= 0 ||
      params.sellQuoteSizeUsd <= 0
    ) {
      return {
        reason: "INVALID_SIZE",
        details: `buyQuoteSizeUsd=${params.buyQuoteSizeUsd} sellQuoteSizeUsd=${params.sellQuoteSizeUsd}`
      };
    }

    if (
      params.buyQuoteSizeUsd + 1e-9 < params.minNotionalUsd ||
      params.sellQuoteSizeUsd + 1e-9 < params.minNotionalUsd
    ) {
      return {
        reason: "MIN_NOTIONAL_FAILED",
        details:
          `buyQuoteSizeUsd=${params.buyQuoteSizeUsd.toFixed(2)} sellQuoteSizeUsd=${params.sellQuoteSizeUsd.toFixed(2)} minNotionalUsd=${params.minNotionalUsd.toFixed(2)}`
      };
    }

    const bestBuyPlanned = params.desired
      .filter((row) => row.side === "BUY")
      .reduce((acc, row) => Math.max(acc, Number(row.price) || 0), 0);
    const bestSellPlanned = params.desired
      .filter((row) => row.side === "SELL")
      .reduce((acc, row) => (acc === 0 ? Number(row.price) || 0 : Math.min(acc, Number(row.price) || acc)), 0);
    const buyCrosses = params.missingBuy && params.bestAsk > 0 && bestBuyPlanned >= params.bestAsk;
    const sellCrosses = params.missingSell && params.bestBid > 0 && bestSellPlanned > 0 && bestSellPlanned <= params.bestBid;
    if (buyCrosses || sellCrosses) {
      return {
        reason: "POST_ONLY_WOULD_CROSS",
        details:
          `bestBid=${params.bestBid.toFixed(2)} bestAsk=${params.bestAsk.toFixed(2)} plannedBuy=${bestBuyPlanned.toFixed(2)} plannedSell=${bestSellPlanned.toFixed(2)}`
      };
    }

    if (params.actionsUsed >= params.actionBudget) {
      return {
        reason: "ACTION_BUDGET_EXHAUSTED",
        details: `actionsUsed=${params.actionsUsed} actionBudget=${params.actionBudget}`
      };
    }

    if (params.refreshSkipped) {
      return {
        reason: "REFRESH_SKIPPED_MIN_REST",
        details: params.refreshSkipReason || "refresh skipped"
      };
    }

    if (
      params.desired.length <= 0 ||
      (params.quotePlan.buyLevels <= 0 && params.quotePlan.sellLevels <= 0 && params.quotePlan.tob === "OFF")
    ) {
      return {
        reason: "PLANNER_ZERO_OUTPUT",
        details:
          `desiredCount=${params.desired.length} usedLevelsBuy=${params.usedLevelsBuy} usedLevelsSell=${params.usedLevelsSell} usedTob=${params.usedTob} perSideBlockReasons.buy=${params.perSideBlockReasons.buy.join(" | ") || "-"} perSideBlockReasons.sell=${params.perSideBlockReasons.sell.join(" | ") || "-"} quotePlan.buyLevels=${params.quotePlan.buyLevels} quotePlan.sellLevels=${params.quotePlan.sellLevels} quotePlan.tob=${params.quotePlan.tob}`
      };
    }

    const submitSnapshot = orderSubmitState.getSnapshot();
    const reconcileSnapshot = orderReconcileState.getSnapshot();
    if (!submitSnapshot.ok || (submitSnapshot.lastError || "").trim().length > 0) {
      return {
        reason: "ORDER_API_ERRORS",
        details: `submitError=${(submitSnapshot.lastError || "").trim() || "unknown"}`
      };
    }
    if ((reconcileSnapshot.lastError || "").trim().length > 0) {
      return {
        reason: "ORDER_API_ERRORS",
        details: `reconcileError=${reconcileSnapshot.lastError}`
      };
    }

    return {
      reason: "MISSING_OPEN_VENUE_SIDE",
      details: `missingBuy=${params.missingBuy} missingSell=${params.missingSell}`
    };
  }

  private async placeForcedBaseline(params: {
    tickerMid: number;
    bestBid: number;
    bestAsk: number;
    tickSize: number;
    balances: { usd_free: number; btc_free: number };
    reserveUsd: number;
    reserveBtc: number;
    maxBtcNotionalUsd: number;
    btcNotionalUsd: number;
    missingBuy: boolean;
    missingSell: boolean;
    remainingActionsBudget: number;
  }): Promise<{ applied: boolean; placed: number; actionsUsed: number; details: string[]; errors: string[] }> {
    const details: string[] = [];
    const errors: string[] = [];
    let placed = 0;
    let actionsUsed = 0;
    let applied = false;

    const minNotionalUsd = Math.max(0.01, this.config.quotingMinNotionalUsd);
    const baselineNotionalUsd = Math.max(minNotionalUsd, this.config.quotingBaselineNotionalUsd);
    const buySpendableUsd = Math.max(0, params.balances.usd_free - params.reserveUsd);
    const sellSpendableUsd = Math.max(
      0,
      Math.max(0, params.balances.btc_free - Math.max(0, params.reserveBtc)) * params.tickerMid
    );
    const allowBuyByInventory = params.btcNotionalUsd < params.maxBtcNotionalUsd;

    if (params.missingBuy && actionsUsed < params.remainingActionsBudget) {
      if (!allowBuyByInventory) {
        errors.push(
          `baseline BUY blocked by inventory cap (btcNotional=${params.btcNotionalUsd.toFixed(2)} >= max=${params.maxBtcNotionalUsd.toFixed(2)})`
        );
      } else if (buySpendableUsd + 1e-9 < minNotionalUsd) {
        errors.push(
          `baseline BUY blocked by spendable USD (spendable=${buySpendableUsd.toFixed(2)} < minNotional=${minNotionalUsd.toFixed(2)})`
        );
      } else {
        const quoteSizeUsd = clamp(baselineNotionalUsd, minNotionalUsd, buySpendableUsd);
        const rawBuy = params.bestBid > 0 ? params.bestBid : Math.max(params.tickSize, params.tickerMid - params.tickSize);
        const buyPrice = enforcePostOnlyPrice(
          roundToTick(rawBuy, params.tickSize, "BUY"),
          "BUY",
          params.bestBid,
          params.bestAsk,
          params.tickSize
        );
        try {
          await this.execution.placeTaggedMakerOrder({
            symbol: this.config.symbol,
            side: "BUY",
            price: buyPrice,
            quoteSizeUsd,
            botTag: this.execution.makeTag(this.config.symbol, "BUY", "L0-BASELINE"),
            retryOnPostOnlyReject: true
          });
          placed += 1;
          actionsUsed += 1;
          applied = true;
          details.push(`baseline BUY placed @ ${buyPrice.toFixed(2)} q=${quoteSizeUsd.toFixed(2)}`);
        } catch (error) {
          const classification = classifyStrategyRuntimeError(error);
          errors.push(`baseline BUY submit failed: ${error instanceof Error ? error.message : String(error)}`);
          if (classification.isInsufficientBalance) {
            this.balanceManager.requestRefresh("insufficient_balance");
            await this.reconciler.refreshBalancesNow("insufficient_balance");
          }
        }
      }
    }

    if (params.missingSell && actionsUsed < params.remainingActionsBudget) {
      if (sellSpendableUsd + 1e-9 < minNotionalUsd) {
        errors.push(
          `baseline SELL blocked by BTC inventory (sellNotional=${sellSpendableUsd.toFixed(2)} < minNotional=${minNotionalUsd.toFixed(2)})`
        );
      } else {
        const quoteSizeUsd = clamp(baselineNotionalUsd, minNotionalUsd, sellSpendableUsd);
        const rawSell = params.bestAsk > 0 ? params.bestAsk : Math.max(params.tickSize, params.tickerMid + params.tickSize);
        const sellPrice = enforcePostOnlyPrice(
          roundToTick(rawSell, params.tickSize, "SELL"),
          "SELL",
          params.bestBid,
          params.bestAsk,
          params.tickSize
        );
        try {
          await this.execution.placeTaggedMakerOrder({
            symbol: this.config.symbol,
            side: "SELL",
            price: sellPrice,
            quoteSizeUsd,
            botTag: this.execution.makeTag(this.config.symbol, "SELL", "L0-BASELINE"),
            retryOnPostOnlyReject: true
          });
          placed += 1;
          actionsUsed += 1;
          applied = true;
          details.push(`baseline SELL placed @ ${sellPrice.toFixed(2)} q=${quoteSizeUsd.toFixed(2)}`);
        } catch (error) {
          const classification = classifyStrategyRuntimeError(error);
          errors.push(`baseline SELL submit failed: ${error instanceof Error ? error.message : String(error)}`);
          if (classification.isInsufficientBalance) {
            this.balanceManager.requestRefresh("insufficient_balance");
            await this.reconciler.refreshBalancesNow("insufficient_balance");
          }
        }
      }
    }

    return { applied, placed, actionsUsed, details, errors };
  }

  private logIntelAdjustment(ts: number, posture: IntelPosture, adjustment: IntelAdjustment): void {
    if (!this.config.enableIntel) return;
    const reasons = Array.isArray(adjustment.reasonCodes)
      ? adjustment.reasonCodes.slice(0, 4)
      : [];
    const key = [
      posture.state,
      adjustment.hardBlock ? "hard" : "soft",
      adjustment.spreadMult.toFixed(2),
      adjustment.sizeMult.toFixed(2),
      adjustment.tobModeOverride,
      reasons.join("|")
    ].join(":");
    const throttleMs = Math.max(5_000, this.config.intelEventCooldownSeconds * 1000);
    if (this.lastIntelAdjustmentLogKey === key && ts - this.lastIntelAdjustmentLogTs < throttleMs) {
      return;
    }
    this.lastIntelAdjustmentLogKey = key;
    this.lastIntelAdjustmentLogTs = ts;
    this.logger.info(
      {
        state: posture.state,
        impact: Number(posture.impact.toFixed(3)),
        confidence: Number(posture.confidence.toFixed(3)),
        spreadMult: Number(adjustment.spreadMult.toFixed(3)),
        sizeMult: Number(adjustment.sizeMult.toFixed(3)),
        tobModeOverride: adjustment.tobModeOverride,
        hardBlock: adjustment.hardBlock,
        reasons
      },
      "Intel adjustment applied"
    );
  }

  private async reconcileOnceWithTimeout(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    const reconcilePromise = this.reconciler
      .reconcileOnce()
      .then(() => ({ type: "done" as const }))
      .catch((error: unknown) => ({ type: "error" as const, error }));
    const timeoutPromise = new Promise<{ type: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
    });
    const result = await Promise.race([reconcilePromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    if (result.type === "timeout") {
      this.logger.warn({ symbol: this.config.symbol, timeoutMs }, "Reconcile timeout");
      return;
    }
    if (result.type === "error") {
      throw result.error;
    }
  }

  private async reconcileDesiredOrders(
    mid: number,
    bestBid: number,
    bestAsk: number,
    tickSize: number,
    desired: DesiredQuote[],
    activeBotOrders: OrderRecord[],
    budget: number,
    repriceMoveBps: number,
    queueRefreshSeconds: number,
    lowVolMinRestSecondsBonus: number,
    allowHardRiskCancel: boolean,
    suppressSoftCancels: boolean
  ): Promise<ReconcileOutcome> {
    const outcome: ReconcileOutcome = {
      actionsUsed: 0,
      placed: 0,
      cancelled: 0,
      kept: 0,
      cancelReasonCounts: {},
      lastCancelReason: null,
      refreshSkipped: false,
      refreshSkipReason: ""
    };
    const minRestingSeconds = Math.max(
      MIN_RESTING_SECONDS_BEFORE_CANCEL,
      this.config.minOrderAgeSeconds + Math.max(0, Math.floor(lowVolMinRestSecondsBonus))
    );
    const desiredMap = new Map(desired.map((q) => [q.tag, q]));
    const activeByTag = new Map<string, OrderRecord[]>();
    const nowTs = Date.now();

    const bumpCancelReason = (reason: string): void => {
      const key = String(reason || "UNKNOWN");
      outcome.cancelReasonCounts[key] = (outcome.cancelReasonCounts[key] ?? 0) + 1;
      outcome.lastCancelReason = key;
    };
    const ageSeconds = (order: OrderRecord): number => Math.max(0, (nowTs - order.created_at) / 1000);
    const isOrderTerminalHint = (order: OrderRecord): boolean => {
      const status = String(order.status || order.last_seen_status || "").toUpperCase();
      return (
        status.includes("REJECT") ||
        status.includes("EXPIRE") ||
        status.includes("CANCELLED") ||
        status.includes("CANCELED") ||
        status.includes("FAILED")
      );
    };
    const canCancel = (
      order: OrderRecord,
      reason: string,
      target?: DesiredQuote
    ): { allowed: boolean; reason: string } => {
      if (allowHardRiskCancel) {
        return { allowed: true, reason: "HARD_RISK_CANCEL" };
      }
      if (isOrderTerminalHint(order)) {
        return { allowed: true, reason: "TERMINAL_STATUS" };
      }
      if (suppressSoftCancels) {
        return { allowed: false, reason: "CAUTION_KEEP_RESTING" };
      }
      const age = ageSeconds(order);
      if (age < minRestingSeconds) {
        return { allowed: false, reason: "MIN_REST_NOT_REACHED" };
      }
      if (target) {
        const moveTicks = calcMoveTicks(order.price, target.price, tickSize);
        if (moveTicks >= 1) {
          return { allowed: true, reason };
        }
        return { allowed: false, reason: "MOVE_LT_1_TICK" };
      }
      return { allowed: false, reason: "NO_TARGET_KEEP_RESTING" };
    };

    for (const order of activeBotOrders) {
      if (!order.bot_tag) continue;
      const bucket = activeByTag.get(order.bot_tag) ?? [];
      bucket.push(order);
      activeByTag.set(order.bot_tag, bucket);
    }

    const primaryByTag = new Map<string, OrderRecord>();
    const extraOrders: OrderRecord[] = [];
    for (const [tag, bucket] of activeByTag.entries()) {
      bucket.sort((a, b) => b.updated_at - a.updated_at);
      primaryByTag.set(tag, bucket[0]);
      for (const extra of bucket.slice(1)) {
        extraOrders.push(extra);
      }
    }

    for (const order of extraOrders) {
      if (outcome.actionsUsed >= budget) return outcome;
      if (!order.venue_order_id) continue;
      const decision = canCancel(order, "DUPLICATE_TAG");
      if (!decision.allowed) {
        outcome.kept += 1;
        continue;
      }
      await this.execution.cancelOrder(order.venue_order_id);
      outcome.actionsUsed += 1;
      outcome.cancelled += 1;
      bumpCancelReason(decision.reason);
    }

    for (const [tag, order] of primaryByTag.entries()) {
      if (outcome.actionsUsed >= budget) return outcome;
      if (desiredMap.has(tag)) {
        continue;
      }
      if (!order.venue_order_id) continue;
      const decision = canCancel(order, "TAG_REMOVED");
      if (!decision.allowed) {
        outcome.kept += 1;
        continue;
      }
      await this.execution.cancelOrder(order.venue_order_id);
      outcome.actionsUsed += 1;
      outcome.cancelled += 1;
      bumpCancelReason(decision.reason);
    }

    const replaceList: Array<{ existing: OrderRecord; target: DesiredQuote }> = [];
    const placeList: DesiredQuote[] = [];

    for (const target of desired) {
      const existing = primaryByTag.get(target.tag);
      if (!existing) {
        placeList.push(target);
        continue;
      }

      const violatesPostOnly = violatesPostOnlyConstraint(
        existing.side,
        existing.price,
        bestBid,
        bestAsk,
        tickSize
      );
      const moveBps = calcMoveBps(existing.price, target.price, mid);
      const moveTicks = calcMoveTicks(existing.price, target.price, tickSize);
      const priceMoveEligible = moveTicks >= 1 || moveBps >= repriceMoveBps;
      const ageSec = ageSeconds(existing);
      const refreshEligible = ageSec >= Math.max(15, minRestingSeconds);
      const replaceReason = violatesPostOnly
        ? "POST_ONLY_VIOLATION"
        : priceMoveEligible
          ? "PRICE_MOVE"
          : refreshEligible
            ? "AGE_REFRESH"
            : "";
      if (!replaceReason) {
        outcome.kept += 1;
        continue;
      }
      const decision = canCancel(existing, replaceReason, target);
      if (!decision.allowed) {
        outcome.kept += 1;
        continue;
      }
      replaceList.push({ existing, target });
    }

    for (const item of replaceList) {
      if (outcome.actionsUsed + 2 > budget) break;
      if (!item.existing.venue_order_id) continue;
      await this.execution.cancelOrder(item.existing.venue_order_id);
      outcome.actionsUsed += 1;
      outcome.cancelled += 1;
      bumpCancelReason("REPRICE_REPLACE");
      try {
        await this.execution.placeTaggedMakerOrder({
          symbol: this.config.symbol,
          side: item.target.side,
          price: item.target.price,
          quoteSizeUsd: item.target.quoteSizeUsd,
          botTag: item.target.tag,
          retryOnPostOnlyReject: true
        });
        outcome.actionsUsed += 1;
        outcome.placed += 1;
        this.recordReplacementEvent(item.existing, item.target, "REPRICE_REPLACE");
      } catch (error) {
        const classification = classifyStrategyRuntimeError(error);
        if (!classification.recoverable) {
          throw error;
        }
        bumpCancelReason("RECOVERABLE_REPLACE_SUBMIT");
        if (classification.isInsufficientBalance) {
          this.balanceManager.requestRefresh("insufficient_balance");
          await this.reconciler.refreshBalancesNow("insufficient_balance");
        }
      }
    }

    const refreshCandidate = this.pickQueueRefreshCandidate(
      desired,
      primaryByTag,
      Math.max(queueRefreshSeconds, minRestingSeconds)
    );
    if (refreshCandidate && outcome.actionsUsed + 2 <= budget) {
      const { target, existing } = refreshCandidate;
      if (existing.venue_order_id) {
        const decision = canCancel(existing, "QUEUE_REFRESH", target);
        if (!decision.allowed) {
          outcome.kept += 1;
        } else {
        await this.execution.cancelOrder(existing.venue_order_id);
          outcome.actionsUsed += 1;
          outcome.cancelled += 1;
          bumpCancelReason("QUEUE_REFRESH");
          try {
            await this.execution.placeTaggedMakerOrder({
              symbol: this.config.symbol,
              side: target.side,
              price: target.price,
              quoteSizeUsd: target.quoteSizeUsd,
              botTag: target.tag,
              retryOnPostOnlyReject: true
            });
            outcome.actionsUsed += 1;
            outcome.placed += 1;
            this.recordReplacementEvent(existing, target, "QUEUE_REFRESH");
          } catch (error) {
            const classification = classifyStrategyRuntimeError(error);
            if (!classification.recoverable) {
              throw error;
            }
            bumpCancelReason("RECOVERABLE_QUEUE_SUBMIT");
            if (classification.isInsufficientBalance) {
              this.balanceManager.requestRefresh("insufficient_balance");
              await this.reconciler.refreshBalancesNow("insufficient_balance");
            }
          }
        }
      }
    }

    for (const target of placeList) {
      if (outcome.actionsUsed >= budget) break;
      try {
        await this.execution.placeTaggedMakerOrder({
          symbol: this.config.symbol,
          side: target.side,
          price: target.price,
          quoteSizeUsd: target.quoteSizeUsd,
          botTag: target.tag,
          retryOnPostOnlyReject: true
        });
        outcome.actionsUsed += 1;
        outcome.placed += 1;
      } catch (error) {
        const classification = classifyStrategyRuntimeError(error);
        if (!classification.recoverable) {
          throw error;
        }
        bumpCancelReason("RECOVERABLE_PLACE_SKIP");
        if (classification.isInsufficientBalance) {
          this.balanceManager.requestRefresh("insufficient_balance");
          await this.reconciler.refreshBalancesNow("insufficient_balance");
        }
      }
    }
    if (outcome.kept <= 0) {
      const estimatedKept = Math.max(0, activeBotOrders.length - outcome.cancelled);
      outcome.kept = estimatedKept;
    }
    return outcome;
  }

  private recordReplacementEvent(
    existing: OrderRecord,
    target: DesiredQuote,
    reason: string
  ): void {
    this.store.recordBotEvent({
      event_id: randomUUID(),
      ts: Date.now(),
      type: "REPLACED",
      side: target.side,
      price: target.price,
      quote_size_usd: target.quoteSizeUsd,
      venue_order_id: existing.venue_order_id,
      client_order_id: existing.client_order_id,
      reason,
      bot_tag: target.tag
    });
  }

  private pickQueueRefreshCandidate(
    desired: DesiredQuote[],
    activeByTag: Map<string, OrderRecord>,
    queueRefreshSeconds: number
  ): { target: DesiredQuote; existing: OrderRecord } | null {
    if (desired.length === 0) return null;
    const ordered = [...desired].sort((a, b) => a.tag.localeCompare(b.tag));
    this.refreshCursor = this.refreshCursor % ordered.length;

    for (let i = 0; i < ordered.length; i += 1) {
      const idx = (this.refreshCursor + i) % ordered.length;
      const target = ordered[idx];
      const existing = activeByTag.get(target.tag);
      if (!existing) continue;

      const ageSec = (Date.now() - existing.created_at) / 1000;
      if (ageSec < queueRefreshSeconds) continue;
      if (ageSec < this.config.minOrderAgeSeconds) continue;

      this.refreshCursor = idx + 1;
      return { target, existing };
    }

    this.refreshCursor += 1;
    return null;
  }

  private recordMid(mid: number, ts: number): void {
    this.mids.push({ ts, mid });
    const maxWindowSec = Math.max(
      this.config.volWindowSeconds,
      this.config.trendWindowSeconds,
      15 * 60
    );
    const cutoff = ts - maxWindowSec * 1000;
    while (this.mids.length > 0 && this.mids[0].ts < cutoff) {
      this.mids.shift();
    }
  }

  private recordSpread(spreadBps: number, ts: number): void {
    this.spreads.push({ ts, spreadBps: Math.max(0, Number(spreadBps) || 0) });
    const cutoff = ts - 30 * 60 * 1000;
    while (this.spreads.length > 0 && this.spreads[0].ts < cutoff) {
      this.spreads.shift();
    }
  }

  private recordDepthNotional(notionalUsd: number, ts: number): void {
    this.depthNotionals.push({ ts, notionalUsd: Math.max(0, Number(notionalUsd) || 0) });
    const cutoff = ts - 30 * 60 * 1000;
    while (this.depthNotionals.length > 0 && this.depthNotionals[0].ts < cutoff) {
      this.depthNotionals.shift();
    }
  }

  private computeSignedMoveBps(windowSeconds: number): number {
    if (this.mids.length < 2) return 0;
    const latest = this.mids[this.mids.length - 1];
    const cutoff = latest.ts - windowSeconds * 1000;

    let anchor = this.mids[0];
    for (const point of this.mids) {
      anchor = point;
      if (point.ts >= cutoff) break;
    }

    if (!anchor || anchor.mid <= 0 || latest.mid <= 0) return 0;
    return ((latest.mid - anchor.mid) / anchor.mid) * 10_000;
  }

  private computeRealizedVolBps(windowSeconds: number): number {
    if (this.mids.length < 3) return 0;
    const latest = this.mids[this.mids.length - 1];
    const cutoff = latest.ts - Math.max(1, windowSeconds) * 1000;
    const points = this.mids.filter((row) => row.ts >= cutoff && row.mid > 0);
    if (points.length < 3) return 0;
    const returns: number[] = [];
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1].mid;
      const next = points[i].mid;
      if (prev > 0 && next > 0) {
        returns.push((next - prev) / prev);
      }
    }
    if (returns.length < 2) return 0;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance =
      returns.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / returns.length;
    const stdev = Math.sqrt(Math.max(0, variance));
    return stdev * 10_000;
  }

  private computeBaselineSpreadBps(): number {
    const values = this.spreads.map((row) => row.spreadBps).filter((row) => Number.isFinite(row) && row >= 0);
    if (values.length <= 0) return Math.max(0.1, this.config.minInsideSpreadBps);
    return median(values);
  }

  private isNewLowInWindow(windowSeconds: number, currentMid: number): boolean {
    if (!(currentMid > 0) || this.mids.length <= 1) return false;
    const latest = this.mids[this.mids.length - 1];
    const cutoff = latest.ts - Math.max(1, windowSeconds) * 1000;
    const windowPoints = this.mids.filter((row) => row.ts >= cutoff && row.mid > 0);
    if (windowPoints.length <= 1) return false;
    const priorMin = windowPoints
      .slice(0, -1)
      .reduce((acc, row) => Math.min(acc, row.mid), Number.POSITIVE_INFINITY);
    return Number.isFinite(priorMin) && currentMid <= priorMin;
  }

  private computeBookDepthScore(ts: number): number {
    const active = this.store.getActiveBotOrders(this.config.symbol);
    const notional = active
      .slice()
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
      .slice(0, 6)
      .reduce((sum, row) => sum + Math.max(0, Number(row.quote_size) || 0), 0);
    this.recordDepthNotional(notional, ts);
    const med = median(
      this.depthNotionals.map((row) => row.notionalUsd).filter((row) => Number.isFinite(row) && row > 0)
    );
    if (!(med > 0)) return 1;
    return clamp(notional / med, 0, 3);
  }

  private startCooldown(durationMs: number, reason: string): void {
    this.cooldownUntilMs = Date.now() + durationMs;
    this.cooldownReason = reason;
    this.logger.warn({ cooldownUntilMs: this.cooldownUntilMs, reason }, "Maker strategy cooldown");
  }

  private async cancelAllIfNeeded(reason: string, minIntervalMs: number): Promise<boolean> {
    const now = Date.now();
    if (
      this.lastCancelAllReason === reason &&
      now - this.lastCancelAllTs < Math.max(1000, minIntervalMs)
    ) {
      return false;
    }
    const active = this.store.getActiveBotOrders(this.config.symbol);
    if (active.length <= 0) {
      this.lastCancelAllTs = now;
      this.lastCancelAllReason = reason;
      return false;
    }
    await this.execution.cancelAllBotOrders(this.config.symbol);
    this.lastCancelAllTs = now;
    this.lastCancelAllReason = reason;
    return true;
  }
}

function buildDesiredQuotes(params: {
  symbol: string;
  execution: Execution;
  mid: number;
  bestBid: number;
  bestAsk: number;
  tickSize: number;
  buyLevels: number;
  sellLevels: number;
  bidHalfSpreadBps: number;
  askHalfSpreadBps: number;
  levelStepBps: number;
  competitiveDistanceTicks: number;
  maxDistanceFromTobBps: number;
  buyQuoteSizeUsd: number;
  sellQuoteSizeUsd: number;
}): DesiredQuote[] {
  const quotes: DesiredQuote[] = [];
  const tick = params.tickSize > 0 ? params.tickSize : 0.01;
  const bestBid = Number.isFinite(params.bestBid) && params.bestBid > 0 ? params.bestBid : params.mid;
  const bestAsk = Number.isFinite(params.bestAsk) && params.bestAsk > 0 ? params.bestAsk : params.mid;
  const maxDistanceTicksFromBps = distanceTicksFromBps(
    Math.max(params.mid, bestBid, bestAsk, tick),
    params.maxDistanceFromTobBps,
    tick
  );
  const competitiveDistanceTicks = clamp(
    Math.floor(params.competitiveDistanceTicks || 0),
    0,
    maxDistanceTicksFromBps
  );
  const cautionBpsTickCap = distanceTicksFromBps(Math.max(params.mid, tick), 5, tick);
  const effectiveDistanceTicks =
    competitiveDistanceTicks === 2
      ? Math.min(competitiveDistanceTicks, cautionBpsTickCap)
      : competitiveDistanceTicks;

  for (let i = 0; i < params.buyLevels; i += 1) {
    const ticksFromTop = clamp(i + effectiveDistanceTicks, 0, maxDistanceTicksFromBps);
    const raw = bestBid - ticksFromTop * tick;
    const rounded = roundToTick(raw, params.tickSize, "BUY");
    const safe = enforcePostOnlyPrice(rounded, "BUY", params.bestBid, params.bestAsk, params.tickSize);

    quotes.push({
      tag: params.execution.makeTag(params.symbol, "BUY", i),
      side: "BUY",
      level: i,
      price: safe,
      quoteSizeUsd: roundUsd(params.buyQuoteSizeUsd)
    });
  }

  for (let i = 0; i < params.sellLevels; i += 1) {
    const ticksFromTop = clamp(i + effectiveDistanceTicks, 0, maxDistanceTicksFromBps);
    const raw = bestAsk + ticksFromTop * tick;
    const rounded = roundToTick(raw, params.tickSize, "SELL");
    const safe = enforcePostOnlyPrice(rounded, "SELL", params.bestBid, params.bestAsk, params.tickSize);

    quotes.push({
      tag: params.execution.makeTag(params.symbol, "SELL", i),
      side: "SELL",
      level: i,
      price: safe,
      quoteSizeUsd: roundUsd(params.sellQuoteSizeUsd)
    });
  }

  return quotes;
}

export function ensureSeedBuyOrder(params: {
  orders: DesiredQuote[];
  symbol: string;
  execution: Execution;
  bestBid: number;
  bestAsk: number;
  tickSize: number;
  quoteSizeUsd: number;
  level?: "SEED_BUY" | "REENTRY_BUY";
}): { orders: DesiredQuote[]; applied: boolean } {
  const forcedLevel = params.level === "REENTRY_BUY" ? "REENTRY_BUY" : "SEED_BUY";
  const hasSeedBuy = params.orders.some(
    (row) =>
      row.side === "BUY" &&
      (String(row.level).toUpperCase() === "SEED_BUY" ||
        String(row.level).toUpperCase() === "REENTRY_BUY" ||
        String(row.tag || "").toUpperCase().includes("SEED_BUY") ||
        String(row.tag || "").toUpperCase().includes("REENTRY_BUY"))
  );
  if (hasSeedBuy) {
    return {
      orders: params.orders,
      applied: false
    };
  }

  const safeTick = params.tickSize > 0 ? params.tickSize : 0.01;
  const bid = Number.isFinite(params.bestBid) && params.bestBid > 0 ? params.bestBid : safeTick;
  const seedPrice = enforcePostOnlyPrice(
    roundToTick(bid, safeTick, "BUY"),
    "BUY",
    params.bestBid,
    params.bestAsk,
    safeTick
  );
  const seedQuote: DesiredQuote = {
    tag: params.execution.makeTag(params.symbol, "BUY", forcedLevel),
    side: "BUY",
    level: forcedLevel,
    price: seedPrice,
    quoteSizeUsd: roundUsd(Math.max(0.01, params.quoteSizeUsd))
  };
  return {
    orders: [...params.orders, seedQuote],
    applied: true
  };
}

function computeSideQuoteSizes(
  baseQuoteSizeUsd: number,
  minQuoteSizeUsd: number,
  inventoryRatio: number
): { buyQuoteSizeUsd: number; sellQuoteSizeUsd: number } {
  const base = Math.max(baseQuoteSizeUsd, minQuoteSizeUsd);
  const min = Math.max(1, Math.min(minQuoteSizeUsd, base));

  let buy = base;
  let sell = base;

  if (inventoryRatio > 0) {
    buy = base - inventoryRatio * (base - min);
  } else if (inventoryRatio < 0) {
    sell = base - Math.abs(inventoryRatio) * (base - min);
  }

  return {
    buyQuoteSizeUsd: clamp(buy, min, base),
    sellQuoteSizeUsd: clamp(sell, min, base)
  };
}

function roundToTick(price: number, tickSize: number, side: Side): number {
  const tick = tickSize > 0 ? tickSize : 0.01;
  const rawTicks = price / tick;
  const ticks = side === "BUY" ? Math.floor(rawTicks + 1e-12) : Math.ceil(rawTicks - 1e-12);
  const rounded = ticks * tick;
  const decimals = countDecimals(tick);
  return Number(rounded.toFixed(decimals));
}

function enforcePostOnlyPrice(
  price: number,
  side: Side,
  bestBid: number,
  bestAsk: number,
  tickSize: number
): number {
  const tick = tickSize > 0 ? tickSize : 0.01;

  if (side === "BUY") {
    const maxFromAsk = bestAsk > 0 ? bestAsk - tick : Number.POSITIVE_INFINITY;
    const maxPrice = Number.isFinite(maxFromAsk) ? Math.min(bestBid, maxFromAsk) : bestBid;
    const fallback = Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : Math.max(tick, price);
    const safe = price >= maxFromAsk ? fallback : price;
    return Math.max(tick, roundToTick(safe, tick, "BUY"));
  }

  const minFromBid = bestBid > 0 ? bestBid + tick : 0;
  const minPrice = Math.max(bestAsk, minFromBid);
  const fallback = minPrice > 0 ? minPrice : Math.max(tick, price);
  const safe = price <= minFromBid ? fallback : price;
  return Math.max(tick, roundToTick(safe, tick, "SELL"));
}

function violatesPostOnlyConstraint(
  side: Side,
  price: number,
  bestBid: number,
  bestAsk: number,
  tickSize: number
): boolean {
  const tick = tickSize > 0 ? tickSize : 0.01;
  if (side === "BUY") {
    if (bestAsk <= 0) return false;
    return price >= bestAsk - tick;
  }
  if (bestBid <= 0) return false;
  return price <= bestBid + tick;
}

function calcSpreadBps(bid: number, ask: number, mid: number): number {
  if (bid <= 0 || ask <= 0 || mid <= 0) return 0;
  return ((ask - bid) / mid) * 10_000;
}

function calcMoveBps(currentPrice: number, targetPrice: number, mid: number): number {
  if (currentPrice <= 0 || targetPrice <= 0 || mid <= 0) return Number.POSITIVE_INFINITY;
  return (Math.abs(currentPrice - targetPrice) / mid) * 10_000;
}

function calcMoveTicks(currentPrice: number, targetPrice: number, tickSize: number): number {
  const tick = tickSize > 0 ? tickSize : 0.01;
  if (tick <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(currentPrice - targetPrice) / tick;
}

function distanceTicksFromBps(referencePrice: number, distanceBps: number, tickSize: number): number {
  const tick = tickSize > 0 ? tickSize : 0.01;
  const price = referencePrice > 0 ? referencePrice : 1;
  const bps = Math.max(0, distanceBps);
  const maxDistance = (price * bps) / 10_000;
  return Math.max(1, Math.floor(maxDistance / tick));
}

function resolveCompetitivePosture(
  hardHaltReasons: string[],
  intelState: IntelPosture["state"],
  newsState: NewsGuardDecision["state"],
  signalsState: SignalsGuardDecision["state"]
): CompetitivePosture {
  if (Array.isArray(hardHaltReasons) && hardHaltReasons.length > 0) return "HALT";
  if (intelState === "RISK_OFF" || newsState === "RISK_OFF" || signalsState === "RISK_OFF") {
    return "RISK_OFF";
  }
  if (
    intelState === "CAUTION" ||
    newsState === "CAUTION" ||
    newsState === "PAUSE" ||
    signalsState === "CAUTION" ||
    signalsState === "PAUSE"
  ) {
    return "CAUTION";
  }
  return "NORMAL";
}

function normalizeSoftRiskState(value: SoftRiskState): SoftRiskState {
  if (
    value === "NORMAL" ||
    value === "CAUTION" ||
    value === "RISK_OFF" ||
    value === "RISK_ON" ||
    value === "PAUSE" ||
    value === "HALT"
  ) {
    return value;
  }
  return "NORMAL";
}

function softRiskStateRank(value: SoftRiskState): number {
  switch (value) {
    case "HALT":
      return 4;
    case "PAUSE":
      return 3;
    case "RISK_OFF":
      return 2;
    case "CAUTION":
      return 1;
    case "NORMAL":
    case "RISK_ON":
    default:
      return 0;
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function countDecimals(value: number): number {
  const str = value.toString();
  const idx = str.indexOf(".");
  if (idx < 0) return 0;
  return str.length - idx - 1;
}

export function applyAdaptiveSpreadController(
  currentHalfSpreadBps: number,
  metrics: {
    fills_last_30m: number;
    fills_last_1h: number;
    avg_edge_total_last_1h: number;
    cancels_last_1h: number;
  },
  config: Pick<
    BotConfig,
    | "adaptiveSpread"
    | "adaptiveStepBps"
    | "targetFillsPerHour"
    | "edgeBadBps"
    | "edgeGoodBps"
    | "maxCancelsPerHour"
    | "minHalfSpreadBps"
    | "maxHalfSpreadBps"
  >
): AdaptiveControllerResult {
  let next = currentHalfSpreadBps;
  const adjustments: string[] = [];

  if (config.adaptiveSpread) {
    if (metrics.fills_last_30m === 0) {
      next -= config.adaptiveStepBps;
      adjustments.push("FILL_DROUGHT_TIGHTEN");
    } else if (
      config.targetFillsPerHour > 0 &&
      metrics.fills_last_1h >= config.targetFillsPerHour
    ) {
      next += config.adaptiveStepBps;
      adjustments.push("OVER_TARGET_WIDEN");
    }

    if (metrics.avg_edge_total_last_1h < config.edgeBadBps) {
      next += config.adaptiveStepBps * 2;
      adjustments.push("NEG_EDGE_WIDEN");
    } else if (metrics.avg_edge_total_last_1h > config.edgeGoodBps) {
      next -= config.adaptiveStepBps;
      adjustments.push("GOOD_EDGE_TIGHTEN");
    }

    if (metrics.cancels_last_1h > config.maxCancelsPerHour) {
      next += config.adaptiveStepBps * 2;
      adjustments.push("HIGH_CHURN_WIDEN");
    }
  }

  const clamped = clamp(next, config.minHalfSpreadBps, config.maxHalfSpreadBps);
  return {
    afterHalfSpreadBps: clamped,
    deltaBps: clamped - currentHalfSpreadBps,
    adjustments
  };
}

export function computeSideEdgeAdjustments(
  avgBuyEdgeBps: number,
  avgSellEdgeBps: number,
  config: Pick<BotConfig, "edgeGoodBps" | "edgeBadBps" | "edgeAdjustBps" | "edgeMaxSideAdjustBps">
): SideEdgeAdjustments {
  let bidBps = 0;
  let askBps = 0;

  if (avgBuyEdgeBps > config.edgeGoodBps) {
    bidBps -= config.edgeAdjustBps;
  } else if (avgBuyEdgeBps < config.edgeBadBps) {
    bidBps += config.edgeAdjustBps;
  }

  if (avgSellEdgeBps > config.edgeGoodBps) {
    askBps -= config.edgeAdjustBps;
  } else if (avgSellEdgeBps < config.edgeBadBps) {
    askBps += config.edgeAdjustBps;
  }

  return {
    bidBps: clamp(bidBps, -config.edgeMaxSideAdjustBps, config.edgeMaxSideAdjustBps),
    askBps: clamp(askBps, -config.edgeMaxSideAdjustBps, config.edgeMaxSideAdjustBps)
  };
}

export function buildQuotePlan(params: QuotePlanParams): QuotePlan {
  const reasons = dedupeStrings(params.blockedReasons);
  const hardHaltReasons = dedupeStrings(params.hardHaltReasons ?? []);
  const minVolMoveBpsToQuote = Number(params.inputs.config.minVolMoveBpsToQuote) || 0;
  const lowMovement =
    minVolMoveBpsToQuote > 0 && params.inputs.volMoveBps < minVolMoveBpsToQuote;
  const levelsCap = clamp(
    Math.max(1, Math.floor(Number(params.inputs.config.levels) || 1)),
    1,
    10
  );
  const seedState = computeSeedState(params.inputs, {
    lowBtcGateUsd: Number(params.inputs.config.lowBtcGateUsd) || 0,
    targetBtcNotionalUsd: Number(params.inputs.config.targetBtcNotionalUsd) || 0,
    minBtcNotionalUsd: Number(params.inputs.config.minBtcNotionalUsd) || 0,
    seedTargetBtcNotionalUsd: Number(params.inputs.config.seedTargetBtcNotionalUsd) || 0,
    maxBtcNotionalUsd:
      Number.isFinite(Number(params.inputs.config.maxBtcNotionalUsd)) &&
      Number(params.inputs.config.maxBtcNotionalUsd) > 0
        ? Number(params.inputs.config.maxBtcNotionalUsd)
        : undefined
  });
  const seedEnabled = params.inputs.config.seedEnabled !== false;
  let buyLevels = Math.max(0, Math.floor(params.buyLevels));
  let sellLevels = Math.max(0, Math.floor(params.sellLevels));
  let tob = normalizeQuotePlanTob(params.tobMode);
  if (lowMovement) {
    reasons.push(
      `LOW_VOL_KEEP_QUOTING (volMoveBps=${params.inputs.volMoveBps.toFixed(2)} < min=${minVolMoveBpsToQuote.toFixed(2)})`
    );
  }

  if (seedEnabled && (seedState.mode === "SEED_BUY" || seedState.mode === "ACCUMULATE_BTC")) {
    const seedBuyCap = Math.min(levelsCap, 3);
    buyLevels = Math.max(1, Math.min(seedBuyCap, Math.max(0, buyLevels)));
    sellLevels = 0;
    const seedTobAllowed = Boolean(params.inputs.config.enableTopOfBook) || Boolean(params.inputs.config.seedForceTob);
    tob = seedTobAllowed ? "BUY" : "OFF";
    reasons.push("SEED_OVERRIDE_BUY_FORCED");
    reasons.push(
      `SEEDING_BTC (btcNotional=${fmtUsd(seedState.progress.btcNotionalUsd)} target=${fmtUsd(seedState.progress.targetUsd)} lowGate=${fmtUsd(seedState.progress.lowGateUsd)})`
    );
  } else if (seedEnabled && seedState.mode === "REBALANCE") {
    const sellCap = Math.min(levelsCap, 3);
    sellLevels = Math.min(sellCap, Math.max(1, sellLevels));
    buyLevels = Math.min(Math.max(0, buyLevels), 1);
    tob = params.inputs.config.enableTopOfBook ? "SELL" : "OFF";
    reasons.push(
      `REBALANCING (btcNotional=${fmtUsd(seedState.progress.btcNotionalUsd)} > max=${fmtUsd(
        Math.max(
          Number(params.inputs.config.maxBtcNotionalUsd) || 0,
          seedState.progress.targetUsd * 1.5
        )
      )})`
    );
  } else {
    if (
      seedState.progress.targetUsd > 0 &&
      seedState.progress.btcNotionalUsd < seedState.progress.targetUsd * 0.75 &&
      sellLevels > 1
    ) {
      const before = sellLevels;
      sellLevels = Math.max(1, sellLevels - 1);
      if (sellLevels !== before) {
        reasons.push(
          `SELL_SOFT_THROTTLE (btcNotional=${fmtUsd(seedState.progress.btcNotionalUsd)} < 75% target=${fmtUsd(seedState.progress.targetUsd)})`
        );
      }
    }
    if (params.inputs.config.enableTopOfBook && Math.abs(params.inputs.inventoryRatio) <= 0.25 && tob !== "OFF") {
      tob = "BOTH";
    }
  }

  const hardHalt = hardHaltReasons.length > 0;
  if (hardHalt) {
    buyLevels = 0;
    sellLevels = 0;
    tob = "OFF";
  }

  const minSellNotionalUsd =
    Number.isFinite(Number(params.inputs.config.minBtcNotionalUsd)) &&
    Number(params.inputs.config.minBtcNotionalUsd) > 0
      ? Number(params.inputs.config.minBtcNotionalUsd)
      : 10;
  if (seedState.progress.btcNotionalUsd < minSellNotionalUsd) {
    sellLevels = 0;
    if (seedEnabled && (seedState.mode === "SEED_BUY" || seedState.mode === "ACCUMULATE_BTC")) {
      buyLevels = Math.max(1, buyLevels);
    }
  }

  const plannedOrderCount = buyLevels + sellLevels + tobPlannedOrderCount(tob);
  const quoteEnabled = !hardHalt && plannedOrderCount > 0;
  if (!quoteEnabled && reasons.length === 0 && hardHaltReasons.length === 0) {
    reasons.push("UNKNOWN_BLOCK (planner wired but no reasons emitted)");
  }

  return {
    quoteEnabled,
    hardHalt,
    hardHaltReasons,
    blockedReasons: dedupeStrings(reasons),
    buyLevels,
    sellLevels,
    tob,
    seedMode: seedEnabled ? seedState.mode : "TWO_SIDED",
    seedReason: seedEnabled ? seedState.reason : "Seed mode disabled by config",
    seedProgress: {
      btcNotionalUsd: seedState.progress.btcNotionalUsd,
      lowGateUsd: seedState.progress.lowGateUsd,
      targetUsd: seedState.progress.targetUsd
    }
  };
}

export function applyInventoryBandPolicy(params: {
  buyLevels: number;
  sellLevels: number;
  btcNotionalUsd: number;
  floorUsd: number;
  targetUsd: number;
  capUsd: number;
  hysteresisUsd: number;
  inventoryAction: InventoryAction;
  maxSellUsdPerHour: number;
  sellNotionalFilled1hUsd: number;
  sellQuoteSizeUsd: number;
  spendableUsd: number;
  minNotionalUsd: number;
  phase: MarketPhase;
  strategyAllowBuy: boolean;
  strategyAllowSell: boolean;
  hardHalt: boolean;
}): {
  buyLevels: number;
  sellLevels: number;
  reentryActive: boolean;
  reasons: string[];
} {
  let buyLevels = Math.max(0, Math.floor(params.buyLevels || 0));
  let sellLevels = Math.max(0, Math.floor(params.sellLevels || 0));
  const reasons: string[] = [];
  const floor = Math.max(0.01, Number(params.floorUsd) || 0.01);
  const target = Math.max(floor, Number(params.targetUsd) || floor);
  const cap = Math.max(target, Number(params.capUsd) || target);
  const hysteresis = Math.max(0, Number(params.hysteresisUsd) || 0);
  const maxSellUsdPerHour = Math.max(0, Number(params.maxSellUsdPerHour) || 0);
  const filledSell1h = Math.max(0, Number(params.sellNotionalFilled1hUsd) || 0);
  const sellQuoteUsd = Math.max(0.01, Number(params.sellQuoteSizeUsd) || 0.01);
  const spendableUsd = Math.max(0, Number(params.spendableUsd) || 0);
  const minNotionalUsd = Math.max(0.01, Number(params.minNotionalUsd) || 0.01);
  const reentryActive =
    (params.phase === "STABILIZING" || params.phase === "RECOVERY") &&
    params.btcNotionalUsd < target;

  if (params.hardHalt) {
    return { buyLevels: 0, sellLevels: 0, reentryActive: false, reasons };
  }

  if (params.btcNotionalUsd <= floor) {
    if (params.strategyAllowBuy && spendableUsd + 1e-9 >= minNotionalUsd) {
      buyLevels = Math.max(1, buyLevels);
    } else {
      buyLevels = 0;
      reasons.push(
        `BTC_FLOOR_BUY_FORCE_SKIPPED (spendableUsd=${fmtUsd(spendableUsd)} < minNotional=${fmtUsd(minNotionalUsd)})`
      );
    }
    if (sellLevels > 0) {
      sellLevels = 0;
    }
    reasons.push(
      `BTC_FLOOR_BUY_PROTECTION (btcNotional=${fmtUsd(params.btcNotionalUsd)} <= floor=${fmtUsd(floor)})`
    );
    reasons.push("BTC_FLOOR_SELL_DISABLED");
  }

  if (params.btcNotionalUsd >= cap) {
    if (buyLevels > 0) {
      buyLevels = 0;
      reasons.push(
        `BTC_CAP_BUY_DISABLED (btcNotional=${fmtUsd(params.btcNotionalUsd)} >= cap=${fmtUsd(cap)})`
      );
    }
    if (params.strategyAllowSell) {
      sellLevels = Math.max(1, sellLevels);
    }
  }

  if (reentryActive) {
    if (params.strategyAllowBuy) {
      buyLevels = Math.max(1, buyLevels);
    } else {
      buyLevels = 0;
    }
    if (sellLevels > 0) {
      const before = sellLevels;
      sellLevels = Math.max(0, sellLevels - 1);
      if (before !== sellLevels) {
        reasons.push(`REENTRY_SELL_PRESSURE_REDUCED (${before}->${sellLevels})`);
      }
    }
    reasons.push(`REENTRY_BTC_REBUILD (btcNotional=${fmtUsd(params.btcNotionalUsd)} < target=${fmtUsd(target)})`);
  }

  if (!params.hardHalt && params.phase === "SHOCK") {
    if (params.btcNotionalUsd <= target + hysteresis && sellLevels > 0) {
      sellLevels = 0;
      reasons.push(
        `SHOCK_SELL_STOP_AT_TARGET (btcNotional=${fmtUsd(params.btcNotionalUsd)} <= target=${fmtUsd(target)}+hys=${fmtUsd(hysteresis)})`
      );
    }
  }

  if (!params.hardHalt && params.phase === "COOLDOWN") {
    const remainingSellBudgetUsd = Math.max(0, maxSellUsdPerHour - filledSell1h);
    const capLevels = Math.max(0, Math.floor(remainingSellBudgetUsd / Math.max(sellQuoteUsd, 0.01)));
    if (sellLevels > capLevels) {
      const before = sellLevels;
      sellLevels = capLevels;
      reasons.push(
        `COOLDOWN_SELL_CAP_APPLIED (${before}->${sellLevels}, sold1h=${fmtUsd(filledSell1h)}, cap=${fmtUsd(maxSellUsdPerHour)})`
      );
    }
    if (params.btcNotionalUsd <= target + hysteresis && sellLevels > 0) {
      const before = sellLevels;
      sellLevels = 0;
      reasons.push(
        `COOLDOWN_HOLD_NEAR_TARGET (${before}->0, btcNotional=${fmtUsd(params.btcNotionalUsd)} target=${fmtUsd(target)} hys=${fmtUsd(hysteresis)})`
      );
    }
  }

  if (!params.hardHalt && params.inventoryAction === "ACCUMULATE" && sellLevels > 0) {
    const before = sellLevels;
    sellLevels = Math.max(0, sellLevels - 1);
    if (before !== sellLevels) {
      reasons.push(`ACCUMULATE_SELL_PRESSURE_REDUCED (${before}->${sellLevels})`);
    }
  }

  return { buyLevels, sellLevels, reentryActive, reasons: dedupeStrings(reasons) };
}

export type MakerQuoteGuardOrder = {
  tag?: string;
  side: Side;
  level: number | string;
  price: number;
};

export function computeMakerMinEdgeBps(
  configuredMinMakerEdgeBps: number,
  currentSpreadBps: number
): number {
  const configured = Number.isFinite(Number(configuredMinMakerEdgeBps))
    ? Math.max(0, Number(configuredMinMakerEdgeBps))
    : 0.2;
  const spreadCap =
    Number.isFinite(Number(currentSpreadBps)) && Number(currentSpreadBps) > 0
      ? Math.max(0, Number(currentSpreadBps) * 0.5)
      : configured;
  return clamp(configured, 0, spreadCap);
}

export function applyMakerQuoteGuard<T extends MakerQuoteGuardOrder>(params: {
  orders: T[];
  fairMid: number;
  minMakerEdgeBps: number;
  currentSpreadBps: number;
}): {
  kept: T[];
  droppedBySide: { BUY: number; SELL: number };
  appliedMinMakerEdgeBps: number;
} {
  const droppedBySide = { BUY: 0, SELL: 0 };
  const appliedMinMakerEdgeBps = computeMakerMinEdgeBps(
    params.minMakerEdgeBps,
    params.currentSpreadBps
  );
  if (!(params.fairMid > 0) || !Number.isFinite(params.fairMid) || params.orders.length === 0) {
    return {
      kept: params.orders.slice(),
      droppedBySide,
      appliedMinMakerEdgeBps
    };
  }

  const kept: T[] = [];
  for (const order of params.orders) {
    const upperTag = String(order.tag ?? "").toUpperCase();
    const upperLevel = String(order.level ?? "").toUpperCase();
    const isSeedBuyTag =
      upperTag.includes("SEED_BUY") ||
      upperTag.includes("REENTRY_BUY") ||
      upperLevel === "SEED_BUY" ||
      upperLevel === "REENTRY_BUY";
    if (isSeedBuyTag) {
      kept.push(order);
      continue;
    }
    const expectedEdgeBps =
      order.side === "BUY"
        ? ((params.fairMid - order.price) / params.fairMid) * 10_000
        : ((order.price - params.fairMid) / params.fairMid) * 10_000;
    if (expectedEdgeBps + 1e-9 < appliedMinMakerEdgeBps) {
      droppedBySide[order.side] += 1;
      continue;
    }
    kept.push(order);
  }

  return {
    kept,
    droppedBySide,
    appliedMinMakerEdgeBps
  };
}

export function computeVolWidenMultiplier(
  volMoveBps: number,
  minVolMoveBpsForExtraWidening: number,
  volWidenMultMin: number,
  volWidenMultMax: number,
  volWidenInCalm: boolean,
  volWidenMultCalm: number
): number {
  if (minVolMoveBpsForExtraWidening <= 0 || volMoveBps < minVolMoveBpsForExtraWidening) {
    return 1;
  }
  const threshold = Math.max(1, minVolMoveBpsForExtraWidening);
  const ratio = clamp((volMoveBps - minVolMoveBpsForExtraWidening) / threshold, 0, 1);
  const maxMult = Math.max(1, volWidenMultMax);
  const floorMult = volWidenInCalm ? Math.max(1, volWidenMultCalm) : Math.max(1, volWidenMultMin);
  return clamp(1 + ratio * (maxMult - 1), Math.min(floorMult, maxMult), maxMult);
}

export function validateRuntimeOverrideValues(config: {
  levelsBuy: number;
  levelsSell: number;
  levelQuoteSizeUsd: number;
  tobQuoteSizeUsd: number;
  baseHalfSpreadBps: number;
  queueRefreshSeconds: number;
}): string[] {
  const issues: string[] = [];
  const check = (field: string, value: number, validator: (n: number) => boolean, hint: string): void => {
    if (!Number.isFinite(value) || !validator(value)) {
      issues.push(`${field}=${Number.isFinite(value) ? value : "NaN"} (${hint})`);
    }
  };

  check("levelsBuy", Number(config.levelsBuy), (n) => n >= 0, "must be >= 0");
  check("levelsSell", Number(config.levelsSell), (n) => n >= 0, "must be >= 0");
  check("levelQuoteSizeUsd", Number(config.levelQuoteSizeUsd), (n) => n > 0, "must be > 0");
  check("tobQuoteSizeUsd", Number(config.tobQuoteSizeUsd), (n) => n > 0, "must be > 0");
  check("baseHalfSpreadBps", Number(config.baseHalfSpreadBps), (n) => n > 0, "must be > 0");
  check("queueRefreshSeconds", Number(config.queueRefreshSeconds), (n) => n > 0, "must be > 0");
  return issues;
}

function computeEdgeStatsSince(store: Store, sinceTs: number): { avgBuy: number; avgSell: number; avgTotal: number } {
  const fills = store.getFillsSince(sinceTs);
  let buySum = 0;
  let buyCount = 0;
  let sellSum = 0;
  let sellCount = 0;

  for (const fill of fills) {
    if (!Number.isFinite(fill.edge_bps ?? Number.NaN)) continue;
    const side = store.getOrderByVenueId(fill.venue_order_id)?.side;
    if (side === "BUY") {
      buySum += fill.edge_bps as number;
      buyCount += 1;
    } else if (side === "SELL") {
      sellSum += fill.edge_bps as number;
      sellCount += 1;
    }
  }

  const avgBuy = buyCount > 0 ? buySum / buyCount : 0;
  const avgSell = sellCount > 0 ? sellSum / sellCount : 0;
  const avgTotal = buyCount + sellCount > 0 ? (buySum + sellSum) / (buyCount + sellCount) : 0;
  return { avgBuy, avgSell, avgTotal };
}

function computeSellNotionalUsdSince(store: Store, sinceTs: number): number {
  const fills = store.getFillsSince(sinceTs);
  let total = 0;
  for (const fill of fills) {
    const side = store.getOrderByVenueId(fill.venue_order_id)?.side;
    if (side !== "SELL") continue;
    const qty = Number(fill.qty) || 0;
    const price = Number(fill.price) || 0;
    if (qty > 0 && price > 0) {
      total += qty * price;
    }
  }
  return total;
}

export function resolveInventoryAction(params: {
  btcNotionalUsd: number;
  targetUsd: number;
  hysteresisUsd: number;
}): InventoryAction {
  const btcNotionalUsd = Math.max(0, Number(params.btcNotionalUsd) || 0);
  const targetUsd = Math.max(0, Number(params.targetUsd) || 0);
  const hysteresisUsd = Math.max(0, Number(params.hysteresisUsd) || 0);
  if (btcNotionalUsd < targetUsd - hysteresisUsd) return "ACCUMULATE";
  if (btcNotionalUsd > targetUsd + hysteresisUsd) return "DISTRIBUTE";
  return "HOLD";
}

function normalizeQuotePlanTob(
  value: "OFF" | "BOTH" | "BUY-ONLY" | "SELL-ONLY"
): "OFF" | "BUY" | "SELL" | "BOTH" {
  if (value === "BUY-ONLY") return "BUY";
  if (value === "SELL-ONLY") return "SELL";
  if (value === "BOTH") return "BOTH";
  return "OFF";
}

function tobPlannedOrderCount(value: "OFF" | "BUY" | "SELL" | "BOTH"): number {
  if (value === "BOTH") return 2;
  if (value === "BUY" || value === "SELL") return 1;
  return 0;
}

function dedupeStrings(input: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const value = String(raw ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function extractSideBlockReasons(reasons: string[], side: "BUY" | "SELL"): string[] {
  const token = side === "BUY" ? "BUY" : "SELL";
  const opposite = side === "BUY" ? "SELL" : "BUY";
  const out: string[] = [];
  for (const raw of reasons) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const upper = value.toUpperCase();
    if (upper.includes(token) || (!upper.includes(opposite) && upper.includes("BOTH"))) {
      out.push(value);
    }
  }
  return dedupeStrings(out).slice(0, 10);
}

function median(values: number[]): number {
  const cleaned = values.filter((row) => Number.isFinite(row)).sort((a, b) => a - b);
  if (cleaned.length <= 0) return 0;
  const mid = Math.floor(cleaned.length / 2);
  if (cleaned.length % 2 === 1) return cleaned[mid];
  return (cleaned[mid - 1] + cleaned[mid]) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function formatSellDiagnostics(params: {
  btcTotal: number;
  btcFree: number;
  btcNotional: number;
  targetBtcNotionalUsd: number;
  lowBtcGate: number;
  maxSellByBal: number;
}): string {
  return `btc_total=${params.btcTotal.toFixed(8)} btc_free=${params.btcFree.toFixed(8)} btcNotional=${fmtUsd(
    params.btcNotional
  )} targetBtcNotionalUsd=${fmtUsd(params.targetBtcNotionalUsd)} lowBtcGate=${fmtUsd(
    params.lowBtcGate
  )} maxSellByBal=${params.maxSellByBal}`;
}


function signalRegimeToNumber(value: "CALM" | "TREND" | "VOLATILE" | "CRISIS"): number {
  if (value === "CALM") return 0;
  if (value === "TREND") return 1;
  if (value === "VOLATILE") return 2;
  return 3;
}

function signalBiasToNumber(value: "LONG" | "SHORT" | "NEUTRAL"): number {
  if (value === "LONG") return 1;
  if (value === "SHORT") return -1;
  return 0;
}

function adverseStateToNumber(value: "NORMAL" | "WIDEN" | "REDUCE" | "PAUSE" | "HEDGE"): number {
  if (value === "NORMAL") return 0;
  if (value === "WIDEN") return 1;
  if (value === "REDUCE") return 2;
  if (value === "PAUSE") return 3;
  return 4;
}

function newsDirectionToNumber(value: "UP" | "DOWN" | "NEUTRAL"): number {
  if (value === "UP") return 1;
  if (value === "DOWN") return -1;
  return 0;
}

function newsStateToNumber(value: "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE"): number {
  if (value === "NORMAL") return 0;
  if (value === "CAUTION") return 1;
  if (value === "RISK_OFF") return 2;
  if (value === "RISK_ON") return 3;
  return 4;
}

function intelStateToNumber(value: "NORMAL" | "CAUTION" | "RISK_OFF" | "HALT"): number {
  if (value === "NORMAL") return 0;
  if (value === "CAUTION") return 1;
  if (value === "RISK_OFF") return 2;
  return 3;
}

export type StrategyRuntimeErrorClassification = {
  category: "RECOVERABLE" | "TRANSIENT" | "FATAL";
  recoverable: boolean;
  stopEligible: boolean;
  isInsufficientBalance: boolean;
  isPostOnlyReject: boolean;
  isAuthOrSignatureFailure: boolean;
  isServerFailure: boolean;
  isRateLimited: boolean;
  isTimeout: boolean;
  isStaleSnapshot: boolean;
  retryAfterMs?: number;
  message: string;
};

export function classifyStrategyRuntimeError(error: unknown): StrategyRuntimeErrorClassification {
  const httpStatus = error instanceof RevXHttpError ? Number(error.status) : null;
  const retryAfterMs =
    error instanceof RevXHttpError && Number.isFinite(Number(error.retryAfterMs))
      ? Math.max(0, Number(error.retryAfterMs))
      : undefined;
  const messageRaw =
    error instanceof RevXHttpError
      ? `${error.message || ""} ${extractRuntimeErrorMessage(error.responseBody)}`
      : error instanceof Error
        ? error.message
        : String(error ?? "");
  const message = String(messageRaw || "").toLowerCase();
  const isInsufficientBalance =
    message.includes("insufficient balance") ||
    message.includes("insufficient funds") ||
    message.includes("not enough") && message.includes("balance");
  const isMinNotional =
    message.includes("min notional") ||
    message.includes("minimum notional") ||
    message.includes("notional too low") ||
    message.includes("below min notional");
  const isPostOnlyReject =
    message.includes("post") &&
    (message.includes("only") ||
      message.includes("maker") ||
      message.includes("would cross") ||
      message.includes("crossing"));
  const isRateLimited = httpStatus === 429 || message.includes("rate limit") || message.includes("too many requests");
  const isTimeout =
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("etimedout");
  const isStaleSnapshot = message.includes("stale") && message.includes("snapshot");
  const isProviderFailure =
    message.includes("provider") &&
    (message.includes("fail") || message.includes("degraded") || message.includes("unavailable"));
  const isAuthOrSignatureFailure =
    (httpStatus === 401 || httpStatus === 403) ||
    message.includes("invalid api key") ||
    message.includes("invalid signature") ||
    message.includes("signature");
  const isServerFailure = httpStatus !== null && httpStatus >= 500;
  const recoverable =
    isInsufficientBalance ||
    isPostOnlyReject ||
    isMinNotional ||
    isRateLimited ||
    isStaleSnapshot ||
    isProviderFailure ||
    (httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && !isAuthOrSignatureFailure);
  const transient = isServerFailure || isTimeout;
  const category: "RECOVERABLE" | "TRANSIENT" | "FATAL" = isAuthOrSignatureFailure
    ? "FATAL"
    : transient
      ? "TRANSIENT"
      : "RECOVERABLE";
  const stopEligible = isAuthOrSignatureFailure || isServerFailure;
  return {
    category,
    recoverable,
    stopEligible,
    isInsufficientBalance,
    isPostOnlyReject,
    isAuthOrSignatureFailure,
    isServerFailure,
    isRateLimited,
    isTimeout,
    isStaleSnapshot,
    retryAfterMs,
    message: messageRaw.trim()
  };
}

function extractRuntimeErrorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.error === "string") return obj.error;
  return "";
}
