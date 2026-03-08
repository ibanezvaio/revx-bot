import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { BotConfig } from "../config";
import { Logger } from "../logger";
import { Store } from "../store/Store";
import { CrossVenueFetcher } from "../signals/CrossVenueFetcher";
import { sleep } from "../util/time";
import {
  PolymarketClient,
  PolymarketMarketContext,
  PolymarketMarketResolution,
  RawPolymarketEvent,
  RawPolymarketMarket
} from "./PolymarketClient";
import { PolymarketExecution } from "./Execution";
import { LiveExecutionAdapter, PaperExecutionAdapter } from "./ExecutionAdapters";
import { MarketScanner } from "./MarketScanner";
import type { MarketScanDiagnostics, MarketScanWindowRejection, MarketScanWindowSample } from "./MarketScanner";
import { LagProfiler, LagProfilerStats, LagSample } from "./LagProfiler";
import { OracleEstimator } from "./OracleEstimator";
import { OracleRouter, OracleSnapshot, OracleState } from "./OracleRouter";
import { ProbModel } from "./ProbModel";
import { PolymarketRisk } from "./Risk";
import { Sizing } from "./Sizing";
import { Strategy } from "./Strategy";
import { FIVE_MIN_SEC, slugForTs, windowTs } from "./btc5m";
import { BtcWindowMarket, DecisionLogLine, SpotFeed, SpotVenueTick } from "./types";
import { VolEstimator } from "./VolEstimator";
import { PaperLedger, getPaperTradeStatus } from "./paper/PaperLedger";
import { getTradingTruthReporter } from "../logging/truth";
import {
  applySellSlippage,
  applyTakerSlippage,
  classifyPaperResult,
  computePaperBinarySettlementPnl,
  computePaperClosePnl,
  estimateNoBidFromYesBook,
  estimateNoAskFromYesBook,
  getPaperBinarySettlementBounds,
  inferOutcomeFromOracle
} from "./paper/PaperMath";

type RejectStage = "active" | "search" | "window" | "pattern" | "scoring" | "dataHealth";
type RejectCountsByStage = Record<RejectStage, Record<string, number>>;
type RejectSample = {
  stage: RejectStage;
  reason: string;
  marketId?: string;
  slug?: string;
  nowIso?: string;
  windowStartMs?: number;
  windowEndMs?: number;
  windowEndTsMs?: number;
  nowTsMs?: number;
  remainingSec?: number;
  rejectReason?: string;
};
type WindowRejectCounters = {
  tooSoon: number;
  tooLate: number;
  invalidEndTs: number;
  invalidRemaining: number;
  unitSecondsDetected: number;
};
type ClosestExpirySample = {
  slug: string;
  marketId: string;
  rawWindowEndTs: string;
  windowEndMs: number;
  remainingSec: number;
};
type Btc5mFetchAttempt = {
  stage: string;
  endpoint: "markets" | "events";
  mode: "search" | "query";
  count: number;
};
type Btc5mFetchResult = {
  markets: BtcWindowMarket[];
  attempts: Btc5mFetchAttempt[];
  rawCount: number;
  timeWindowCount: number;
  patternPassCount: number;
  patternRejectCounts: {
    no_btc: number;
    no_cadence: number;
    no_direction: number;
    passed: number;
  };
  patternRejectSamples: Array<{ slug: string; title: string; reason: "no_btc" | "no_cadence" | "no_direction" }>;
  sampleTitles: Array<{ slug: string; title: string }>;
  windowSamples: MarketScanWindowSample[];
  rejectedWindow: MarketScanWindowRejection[];
  windowRejectCounters: WindowRejectCounters;
};
type PolymarketState = {
  lastUpdateTs: number;
  lastFetchAttemptTs: number;
  lastFetchOkTs: number;
  lastHttpStatus: number;
  lastFetchErr: string | null;
  latestPolymarketTs: number | null;
  lastBookTsMs: number;
  lastYesBid: number | null;
  lastYesAsk: number | null;
  lastYesMid: number | null;
  lastModelTs: number;
  fetchedCount: number;
  afterWindowCount: number;
  finalCandidatesCount: number;
  selectedSlug: string | null;
  selectedMarketId: string | null;
  holdDetailReason: string | null;
  dominantReject: string | null;
  rejectCountsByStage: RejectCountsByStage;
  sampleRejected: RejectSample[];
  oracleSource: string | null;
  oracleState: string | null;
};
type YesBookSnapshot = {
  yesBid: number;
  yesAsk: number;
  yesMid: number;
  spread: number;
  topBidSize: number;
  topAskSize: number;
  bookTs: number;
};

type TokenBookSnapshot = {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  mark: number | null;
  markSource: string | null;
  bookTs: number;
};

function prefixCachedMarkSource(source: string | null): string {
  const normalized = String(source || "").trim();
  if (normalized.startsWith("CACHED_LAST_GOOD")) return normalized;
  return normalized ? `CACHED_LAST_GOOD_${normalized}` : "CACHED_LAST_GOOD";
}

type PaperIntervalContext = {
  key: string;
  marketId: string;
  slug: string;
  yesTokenId: string;
  noTokenId: string;
  intervalStartTs: number;
  intervalEndTs: number;
  remainingSec: number;
  priceToBeat: number;
  market: BtcWindowMarket;
};

type PaperIntervalSelection = {
  interval: PaperIntervalContext | null;
  selectedReason: string;
  dominantReject: string;
  attemptedSlugs: string[];
};

type PaperIntervalDecisionMemo = {
  decidedAt: number;
  action: "ENTRY_OPENED" | "ENTRY_SKIPPED";
  reason: string;
};

type PaperSideChoice = {
  chosenSide: "YES" | "NO" | null;
  chooserReason: string;
};

export class PolymarketEngine {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private consecutiveErrors = 0;
  private readonly logPath: string;
  private readonly logsDirPath: string;
  private readonly client: PolymarketClient;
  private readonly scanner: MarketScanner;
  private readonly oracleEstimator: OracleEstimator;
  private readonly oracleRouter: OracleRouter;
  private readonly volEstimator: VolEstimator;
  private readonly probModel: ProbModel;
  private readonly strategy: Strategy;
  private readonly sizing: Sizing;
  private readonly execution: PolymarketExecution;
  private readonly paperExecutionAdapter: PaperExecutionAdapter;
  private readonly liveExecutionAdapter: LiveExecutionAdapter;
  private readonly risk: PolymarketRisk;
  private readonly paperLedger: PaperLedger;
  private readonly truthReporter: ReturnType<typeof getTradingTruthReporter>;
  private readonly paperLedgerPath: string;
  private readonly dataDirPath: string;
  private readonly paperTradeLogPath: string;
  private readonly lagProfiler: LagProfiler;
  private readonly debugPoly = process.env.DEBUG_POLY === "1";
  private readonly oracleSamples: Array<{ ts: number; px: number; source: string }> = [];
  private readonly marketLagState = new Map<
    string,
    { impliedMid: number; oracleEst: number; ts: number }
  >();
  private readonly latestYesBookByMarketId = new Map<string, YesBookSnapshot>();
  private readonly latestTokenBookByTokenId = new Map<string, TokenBookSnapshot>();
  private readonly cachedPaperIntervalsBySlug = new Map<string, PaperIntervalContext>();
  private readonly resolutionPendingLogByTradeId = new Map<string, number>();
  private readonly paperStopLossTicksByTradeId = new Map<string, number>();
  private readonly paperBestUnrealizedPnlUsdByTradeId = new Map<string, number>();
  private readonly paperDecisionByIntervalKey = new Map<string, PaperIntervalDecisionMemo>();
  private lastPaperIntervalKey: string | null = null;
  private lastPaperIntervalEndTs: number | null = null;
  private latestPolymarketSnapshot: {
    ts: number;
    windowSlug: string;
    tauSec: number | null;
    priceToBeat: number | null;
    fastMid: number | null;
    yesMid: number | null;
    impliedProbMid: number | null;
  } | null = null;
  private latestModelSnapshot: {
    ts: number;
    pBase: number | null;
    pBoosted: number | null;
    z: number | null;
    d: number | null;
    sigma: number | null;
    tauSec: number | null;
    polyUpdateAgeMs: number | null;
    lagPolyP90Ms: number | null;
    oracleAgeMs: number | null;
    boostApplied: boolean;
    boostReason: string | null;
  } | null = null;
  private oracleStaleSinceTs: number | null = null;
  private tradingPaused = false;
  private pauseReason = "";
  private pauseSinceTs: number | null = null;
  private truthLastAction: "OPEN" | "CLOSE" | "RESOLVE" | "HOLD" = "HOLD";
  private truthLastActionTs = 0;
  private truthLastTradeId: string | null = null;
  private truthLastSlug: string | null = null;
  private truthLastTradeTs: number | null = null;
  private truthHoldReason: string | null = null;
  private truthChosenDirection: string | null = null;
  private truthEntriesInWindow: number | null = null;
  private truthWindowRealizedPnlUsd: number | null = null;
  private truthResolutionSource: string | null = null;
  private truthSelection: {
    finalCandidatesCount: number | null;
    selectedSlug: string | null;
    selectedMarketId: string | null;
    windowStartTs: number | null;
    windowEndTs: number | null;
    remainingSec: number | null;
  } = {
    finalCandidatesCount: null,
    selectedSlug: null,
    selectedMarketId: null,
    windowStartTs: null,
    windowEndTs: null,
    remainingSec: null
  };
  private selectedTokenIds: string[] = [];
  private truthDataHealth: {
    oracleSource: string | null;
    oracleState: string | null;
    latestPolymarketTs: number | null;
    latestModelTs: number | null;
    lastFetchAttemptTs: number;
    lastFetchOkTs: number;
    lastFetchErr: string | null;
    lastHttpStatus: number;
  } = {
    oracleSource: null,
    oracleState: null,
    latestPolymarketTs: null,
    latestModelTs: null,
    lastFetchAttemptTs: 0,
    lastFetchOkTs: 0,
    lastFetchErr: null,
    lastHttpStatus: 0
  };
  private polyEngineRunning = false;
  private noDataSinceTs: number | null = null;
  private noDataWarned = false;
  private noWindowsConsecutiveTicks = 0;
  private lastFetchDisabledLogTs = 0;
  private lastTickLogTs = 0;
  private lastForceTradeTs = 0;
  private paperFatalLogged = false;
  private lastOracleSnapshot: OracleSnapshot | null = null;
  private readonly windowStateBySlug = new Map<
    string,
    {
      windowStartMs: number;
      windowEndMs: number;
      priceToBeat?: number;
      priceToBeatTs?: number;
      waitingLogged?: boolean;
    }
  >();
  private readonly polyState: PolymarketState = {
    lastUpdateTs: 0,
    lastFetchAttemptTs: 0,
    lastFetchOkTs: 0,
    lastHttpStatus: 0,
    lastFetchErr: null,
    latestPolymarketTs: null,
    lastBookTsMs: 0,
    lastYesBid: null,
    lastYesAsk: null,
    lastYesMid: null,
    lastModelTs: 0,
    fetchedCount: 0,
    afterWindowCount: 0,
    finalCandidatesCount: 0,
    selectedSlug: null,
    selectedMarketId: null,
    holdDetailReason: null,
    dominantReject: null,
    rejectCountsByStage: createRejectCountsByStage(),
    sampleRejected: [],
    oracleSource: null,
    oracleState: null
  };

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    options: { store?: Store } = {}
  ) {
    const spotFeed = new ExistingSpotFeedAdapter(config);
    this.client = new PolymarketClient(config, logger);
    this.scanner = new MarketScanner(config, logger, this.client);
    this.oracleEstimator = new OracleEstimator(config, spotFeed);
    this.oracleRouter = new OracleRouter(config, logger, {
      symbol: this.config.polymarket.marketQuery.symbol,
      estimator: this.oracleEstimator,
      store: options.store
    });
    this.volEstimator = new VolEstimator(config);
    this.probModel = new ProbModel(config);
    this.strategy = new Strategy(config);
    this.sizing = new Sizing(config);
    this.execution = new PolymarketExecution(config, logger, this.client);
    this.paperExecutionAdapter = new PaperExecutionAdapter();
    this.liveExecutionAdapter = new LiveExecutionAdapter(this.execution);
    this.risk = new PolymarketRisk(config, logger);

    this.logsDirPath = path.resolve(process.cwd(), "logs");
    this.dataDirPath = path.resolve(process.cwd(), "data");
    mkdirSync(this.logsDirPath, { recursive: true });
    mkdirSync(this.dataDirPath, { recursive: true });
    this.logPath = path.join(this.logsDirPath, "polymarket-decisions.jsonl");
    this.paperTradeLogPath = path.join(this.logsDirPath, "polymarket-paper-trades.jsonl");
    this.lagProfiler = new LagProfiler({
      maxSamples: 2000,
      logPath: path.join(this.logsDirPath, "polymarket-lag.jsonl")
    });
    this.paperLedgerPath = path.resolve(process.cwd(), this.config.polymarket.paper.ledgerPath);
    mkdirSync(path.dirname(this.paperLedgerPath), { recursive: true });
    this.paperLedger = new PaperLedger(this.paperLedgerPath);
    this.truthReporter = getTradingTruthReporter(this.config, this.logger);
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.paperFatalLogged = false;
    this.ensureOutputFilesAndWriteStartupMarkers();
    this.assertPaperSettlementSanityAtStartup();
    const windowCfg = this.isDeterministicBtc5mMode()
      ? {
          minWindowSec: this.config.polymarket.paper.entryMinRemainingSec,
          maxWindowSec: this.config.polymarket.paper.entryMaxRemainingSec
        }
      : this.scanner.getPrimaryWindowConfig();
    this.logger.info(
      { minRemainingSec: windowCfg.minWindowSec, maxRemainingSec: windowCfg.maxWindowSec },
      `POLY_WINDOW_CFG minRemainingSec=${windowCfg.minWindowSec} maxRemainingSec=${windowCfg.maxWindowSec}`
    );
    await this.client.runStartupSanityCheck(this.config.strictSanityCheck);
    this.running = true;
    if (
      this.config.polymarket.mode === "live" &&
      this.config.polymarket.execution.cancelAllOnStart &&
      this.canMutateVenueState()
    ) {
      await this.execution.cancelAll("STARTUP_CANCEL_ALL");
    } else if (
      this.config.polymarket.mode === "live" &&
      this.config.polymarket.execution.cancelAllOnStart &&
      !this.canMutateVenueState()
    ) {
      this.logger.warn(
        {
          killSwitch: this.config.polymarket.killSwitch,
          liveConfirmed: this.config.polymarket.liveConfirmed,
          liveExecutionEnabled: this.config.polymarket.liveExecutionEnabled
        },
        "Skipping startup cancel-all because live venue mutation is not armed"
      );
    }
    this.loopPromise = this.runLoopWithRestart();
    if (this.config.polymarket.mode === "live" && !this.canMutateVenueState()) {
      this.logger.warn(
        {
          killSwitch: this.config.polymarket.killSwitch,
          liveConfirmed: this.config.polymarket.liveConfirmed,
          liveExecutionEnabled: this.config.polymarket.liveExecutionEnabled
        },
        "Polymarket live mode running in shadow auth-only mode (no place/cancel mutations)"
      );
    }
    this.logger.warn(
      {
        mode: this.config.polymarket.mode,
        loopMs: this.config.polymarket.loopMs,
        decisionLog: this.logPath,
        paperLedger: this.config.polymarket.paper.ledgerPath,
        paperTradeLog: this.paperTradeLogPath,
        marketQuery: this.config.polymarket.marketQuery
      },
      "Polymarket engine started"
    );
  }

  async stop(reason = "STOP"): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch (error) {
        this.logger.warn({ error }, "Polymarket loop exited with error during stop");
      }
      this.loopPromise = null;
    }
    if (this.canMutateVenueState()) {
      await this.execution.cancelAll(reason);
    } else {
      this.logger.warn(
        {
          reason,
          killSwitch: this.config.polymarket.killSwitch,
          liveConfirmed: this.config.polymarket.liveConfirmed,
          liveExecutionEnabled: this.config.polymarket.liveExecutionEnabled
        },
        "Skipping cancel-all on stop because live venue mutation is not armed"
      );
    }
    this.paperLedger.flush();
    this.logger.warn({ reason }, "Polymarket engine stopped");
  }

  getLagSnapshot(limit = 50): { stats: LagProfilerStats; recent: LagSample[] } {
    return {
      stats: this.lagProfiler.getStats(),
      recent: this.lagProfiler.getRecent(limit)
    };
  }

  getDashboardSnapshot(): {
    latestPolymarket: {
      ts: number;
      windowSlug: string;
      tauSec: number | null;
      priceToBeat: number | null;
      fastMid: number | null;
      yesMid: number | null;
      impliedProbMid: number | null;
    } | null;
    latestModel: {
      ts: number;
      pBase: number | null;
      pBoosted: number | null;
      z: number | null;
      d: number | null;
      sigma: number | null;
      tauSec: number | null;
      polyUpdateAgeMs: number | null;
      lagPolyP90Ms: number | null;
      oracleAgeMs: number | null;
      boostApplied: boolean;
      boostReason: string | null;
    } | null;
    latestLag: LagProfilerStats;
    sniperWindow: {
      minRemainingSec: number;
      maxRemainingSec: number;
    };
    tradingPaused: boolean;
    pauseReason: string | null;
    warningState: string | null;
    mode: "paper" | "live";
    polyMoney: boolean;
    lastAction: "OPEN" | "CLOSE" | "RESOLVE" | "HOLD";
    holdReason: string | null;
    currentWindowHoldReason: string | null;
    openTradesCount: number;
    awaitingResolutionCount: number;
    resolutionErrorCount: number;
    resolutionQueueCount: number;
    selection: {
      finalCandidatesCount: number | null;
      discoveredCandidatesCount: number | null;
      windowsCount: number | null;
      selectedSlug: string | null;
      selectedMarketId: string | null;
      windowStartTs: number | null;
      windowEndTs: number | null;
      remainingSec: number | null;
      chosenDirection: string | null;
      entriesInWindow: number | null;
      realizedPnlUsd: number | null;
      resolutionSource: string | null;
      lifecycleStatus: string | null;
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
      lastBookTsMs: number;
      lastYesBid: number | null;
      lastYesAsk: number | null;
      lastYesMid: number | null;
      lastModelTs: number;
    };
    state: {
      holdDetailReason: string | null;
      dominantReject: string | null;
      rejectCountsByStage: RejectCountsByStage;
      sampleRejected: RejectSample[];
    };
    lastTrade: {
      id: string | null;
      slug: string | null;
      ts: number | null;
    };
    openTrade: {
      tradeId: string;
      marketId: string;
      marketSlug: string | null;
      windowStartTs: number;
      windowEndTs: number;
      side: "YES" | "NO";
      direction: string;
      heldTokenId: string | null;
      strikePrice: number | null;
      btcStartPrice: number | null;
      entryBtcReferencePrice: number | null;
      btcReferencePrice: number | null;
      btcReferenceTs: number | null;
      btcReferenceAgeMs: number | null;
      btcReferenceStale: boolean;
      contractEntryPrice: number;
      contractLivePrice: number | null;
      impliedProbPct: number | null;
      bestBid: number | null;
      bestAsk: number | null;
      livePrice: number | null;
      markSource: string | null;
      markTs: number | null;
      markAgeMs: number | null;
      markStale: boolean;
      isStale: boolean;
      qty: number;
      shares: number;
      entryPrice: number;
      entryNotionalUsd: number;
      feesUsd: number;
      markValueUsd: number | null;
      unrealizedPnlUsd: number | null;
    } | null;
    serverNowTs: number;
    lastActionTs: number;
    polyEngineRunning: boolean;
    lastUpdateTs: number;
    lastUpdateAgeSec: number | null;
    status: "STARTING" | "RUNNING" | "STALE";
  } {
    const nowTs = Date.now();
    const polyEngineRunning = this.polyState.lastFetchAttemptTs > 0;
    const lastUpdateTs = Math.max(0, this.polyState.lastUpdateTs, this.polyState.lastFetchOkTs);
    const lastUpdateAgeSec =
      lastUpdateTs > 0 ? Math.max(0, Math.floor((nowTs - lastUpdateTs) / 1000)) : null;
    const fetchRecent =
      this.polyState.lastFetchOkTs > 0 && nowTs - this.polyState.lastFetchOkTs <= 60_000;
    const status: "STARTING" | "RUNNING" | "STALE" =
      lastUpdateTs <= 0 ? "STARTING" : fetchRecent || (lastUpdateAgeSec !== null && lastUpdateAgeSec <= 30) ? "RUNNING" : "STALE";
    const selectionSnapshot = this.getTruthSelectionSnapshot(nowTs);
    const lifecycleStatus = this.getPaperLifecycleStatus(nowTs, selectionSnapshot);
    const paperWindowContext = this.getCurrentPaperWindowRuntimeContext(nowTs);
    const openTrade = this.buildOpenTradeMonitorSnapshot(nowTs);
    const paperResolutionStats = this.getPaperResolutionStats(nowTs);
    const pausePresentation = this.getStatusPausePresentation(this.tradingPaused, this.pauseReason || null);
    const holdSnapshotFreshMs = Math.max(5_000, this.config.polymarket.loopMs * 3);
    const normalizedTruthHoldReason = this.truthHoldReason
      ? String(this.truthHoldReason).trim().toUpperCase()
      : null;
    const truthHoldReasonIsFresh =
      Boolean(normalizedTruthHoldReason) &&
      this.polyState.lastUpdateTs > 0 &&
      nowTs - this.polyState.lastUpdateTs <= holdSnapshotFreshMs;
    const truthDynamicHoldReason =
      normalizedTruthHoldReason &&
      (normalizedTruthHoldReason === "REENTRY_COOLDOWN" ||
        normalizedTruthHoldReason === "OPEN_POSITION_IN_WINDOW" ||
        normalizedTruthHoldReason === "TOO_LATE_FOR_ENTRY" ||
        normalizedTruthHoldReason === "EXPIRED_WINDOW")
        ? normalizedTruthHoldReason
        : null;
    const derivedDynamicHoldReason =
      paperWindowContext?.holdReason ??
      (truthDynamicHoldReason === "OPEN_POSITION_IN_WINDOW" && openTrade
        ? "OPEN_POSITION_IN_WINDOW"
        : truthDynamicHoldReason === "TOO_LATE_FOR_ENTRY" &&
            selectionSnapshot.remainingSec !== null &&
            selectionSnapshot.remainingSec < this.config.polymarket.paper.entryMinRemainingSec
          ? "TOO_LATE_FOR_ENTRY"
          : truthDynamicHoldReason === "EXPIRED_WINDOW" &&
              selectionSnapshot.remainingSec !== null &&
              selectionSnapshot.remainingSec <= 0
            ? "EXPIRED_WINDOW"
            : null);
    const freshPaperCycleWithoutOpenTrade =
      this.config.polymarket.mode === "paper" &&
      !openTrade &&
      this.polyState.lastUpdateTs > this.truthLastActionTs;
    const freshPaperHoldCycleWithoutOpenTrade =
      this.config.polymarket.mode === "paper" &&
      !openTrade &&
      truthHoldReasonIsFresh &&
      this.polyState.lastUpdateTs >= this.truthLastActionTs;
    const effectiveLastAction =
      freshPaperHoldCycleWithoutOpenTrade || freshPaperCycleWithoutOpenTrade
        ? "HOLD"
        : this.truthLastAction;
    const effectiveLastActionTs =
      (freshPaperHoldCycleWithoutOpenTrade || freshPaperCycleWithoutOpenTrade || effectiveLastAction === "HOLD") &&
      this.polyState.lastUpdateTs > 0
        ? Math.max(this.truthLastActionTs, this.polyState.lastUpdateTs)
        : this.truthLastActionTs;
    const currentWindowHoldReason =
      effectiveLastAction === "HOLD"
        ? derivedDynamicHoldReason ??
          (truthHoldReasonIsFresh && !truthDynamicHoldReason ? normalizedTruthHoldReason : null)
        : null;
    const latestPolymarket =
      this.latestPolymarketSnapshot
        ? {
            ...this.latestPolymarketSnapshot,
            tauSec:
              selectionSnapshot.remainingSec ??
              (Number(this.latestPolymarketSnapshot.tauSec) >= 0
                ? Number(this.latestPolymarketSnapshot.tauSec)
                : null),
            windowSlug:
              selectionSnapshot.selectedSlug ??
              this.latestPolymarketSnapshot.windowSlug
          }
        : null;
    const latestModel =
      this.latestModelSnapshot
        ? {
            ...this.latestModelSnapshot,
            tauSec:
              selectionSnapshot.remainingSec ??
              (Number(this.latestModelSnapshot.tauSec) >= 0 ? Number(this.latestModelSnapshot.tauSec) : null)
          }
        : null;
    return {
      latestPolymarket,
      latestModel,
      latestLag: this.lagProfiler.getStats(),
      sniperWindow: {
        minRemainingSec: this.config.polymarket.paper.entryMinRemainingSec,
        maxRemainingSec: this.config.polymarket.paper.entryMaxRemainingSec
      },
      tradingPaused: pausePresentation.tradingPaused,
      pauseReason: pausePresentation.pauseReason,
      warningState: pausePresentation.warningState,
      mode: this.config.polymarket.mode,
      polyMoney:
        this.config.polymarket.mode !== "paper" &&
        !this.config.polymarket.killSwitch &&
        this.config.polymarket.liveConfirmed &&
        this.config.polymarket.liveExecutionEnabled,
      lastAction: effectiveLastAction,
      holdReason: currentWindowHoldReason,
      currentWindowHoldReason,
      openTradesCount: paperResolutionStats.openTradesCount,
      awaitingResolutionCount: paperResolutionStats.awaitingResolutionCount,
      resolutionErrorCount: paperResolutionStats.resolutionErrorCount,
      resolutionQueueCount: paperResolutionStats.resolutionQueueCount,
      selection: {
        finalCandidatesCount:
          this.polyState.finalCandidatesCount > 0
            ? this.polyState.finalCandidatesCount
            : selectionSnapshot.finalCandidatesCount,
        discoveredCandidatesCount: this.polyState.fetchedCount,
        windowsCount: this.polyState.afterWindowCount,
        selectedSlug: selectionSnapshot.selectedSlug,
        selectedMarketId: selectionSnapshot.selectedMarketId,
        windowStartTs: selectionSnapshot.windowStartTs,
        windowEndTs: selectionSnapshot.windowEndTs,
        remainingSec: selectionSnapshot.remainingSec,
        chosenDirection: paperWindowContext?.chosenDirection ?? this.truthChosenDirection,
        entriesInWindow: paperWindowContext?.entriesInWindow ?? this.truthEntriesInWindow,
        realizedPnlUsd: paperWindowContext?.realizedPnlUsd ?? this.truthWindowRealizedPnlUsd,
        resolutionSource: this.truthResolutionSource,
        lifecycleStatus
      },
      dataHealth: {
        oracleSource: this.polyState.oracleSource ?? this.truthDataHealth.oracleSource,
        oracleState: this.polyState.oracleState ?? this.truthDataHealth.oracleState,
        latestPolymarketTs: this.polyState.latestPolymarketTs,
        latestModelTs: this.polyState.lastModelTs > 0 ? this.polyState.lastModelTs : null,
        lastFetchAttemptTs: this.polyState.lastFetchAttemptTs,
        lastFetchOkTs: this.polyState.lastFetchOkTs,
        lastFetchErr: this.polyState.lastFetchErr,
        lastHttpStatus: this.polyState.lastHttpStatus,
        lastBookTsMs: this.polyState.lastBookTsMs,
        lastYesBid: this.polyState.lastYesBid,
        lastYesAsk: this.polyState.lastYesAsk,
        lastYesMid: this.polyState.lastYesMid,
        lastModelTs: this.polyState.lastModelTs
      },
      state: {
        holdDetailReason: this.polyState.holdDetailReason,
        dominantReject: this.polyState.dominantReject,
        rejectCountsByStage: cloneRejectCountsByStage(this.polyState.rejectCountsByStage),
        sampleRejected: this.polyState.sampleRejected.slice(0, 5).map((row) => ({ ...row }))
      },
      lastTrade: {
        id: this.truthLastTradeId,
        slug: this.truthLastSlug,
        ts: this.truthLastTradeTs
      },
      openTrade,
      serverNowTs: nowTs,
      lastActionTs: effectiveLastActionTs,
      polyEngineRunning,
      lastUpdateTs,
      lastUpdateAgeSec,
      status
    };
  }

  private getTickTimestamp(now: string | null | undefined): number {
    return toMs(now) || Date.now();
  }

  private getTickActionRoot(action: string | null | undefined): string {
    return String(action || "")
      .split(":")[0]
      .trim()
      .toUpperCase();
  }

  private isSelectionRollover(input: Pick<TickLogLine, "selectedSlug" | "currentMarketId" | "windowEnd">): boolean {
    const nextSelectedSlug =
      input.selectedSlug !== undefined ? input.selectedSlug : this.truthSelection.selectedSlug;
    const nextSelectedMarketId =
      input.currentMarketId !== undefined ? input.currentMarketId : this.truthSelection.selectedMarketId;
    const nextWindowEndTs =
      input.windowEnd !== undefined ? input.windowEnd : this.truthSelection.windowEndTs;
    const hasNextSelection = Boolean(nextSelectedSlug || nextSelectedMarketId);
    if (!hasNextSelection) {
      return false;
    }
    const prevSelectedSlug = this.truthSelection.selectedSlug ?? this.polyState.selectedSlug ?? null;
    const prevSelectedMarketId = this.truthSelection.selectedMarketId ?? this.polyState.selectedMarketId ?? null;
    const prevWindowEndTs = Number(this.truthSelection.windowEndTs || 0) || null;
    return (
      nextSelectedSlug !== prevSelectedSlug ||
      nextSelectedMarketId !== prevSelectedMarketId ||
      Number(nextWindowEndTs || 0) !== Number(prevWindowEndTs || 0)
    );
  }

  private getStatusPausePresentation(
    tradingPaused: boolean | null | undefined,
    pauseReason: string | null | undefined
  ): {
    tradingPaused: boolean;
    pauseReason: string | null;
    warningState: string | null;
  } {
    const normalizedPauseReason = String(pauseReason || "")
      .trim()
      .toUpperCase();
    if (
      this.config.polymarket.mode === "paper" &&
      tradingPaused &&
      normalizedPauseReason.includes("NETWORK")
    ) {
      return {
        tradingPaused: false,
        pauseReason: null,
        warningState: "NETWORK_ERROR"
      };
    }
    return {
      tradingPaused: Boolean(tradingPaused),
      pauseReason: tradingPaused ? (normalizedPauseReason || null) : null,
      warningState: null
    };
  }

  private getTruthSelectionSnapshot(nowTs: number): {
    finalCandidatesCount: number | null;
    selectedSlug: string | null;
    selectedMarketId: string | null;
    windowStartTs: number | null;
    windowEndTs: number | null;
    remainingSec: number | null;
  } {
    const selectedSlug = this.truthSelection.selectedSlug ?? null;
    const selectedMarketId = this.truthSelection.selectedMarketId ?? null;
    const windowEndTs =
      Number(this.truthSelection.windowEndTs || 0) > 0 ? Number(this.truthSelection.windowEndTs) : null;
    const windowStartTs =
      Number(this.truthSelection.windowStartTs || 0) > 0
        ? Number(this.truthSelection.windowStartTs)
        : windowEndTs !== null
          ? Math.max(0, windowEndTs - FIVE_MIN_SEC * 1000)
          : null;
    const hasTrackedSelection = Boolean(selectedSlug || selectedMarketId);
    const hasActiveSelection = hasTrackedSelection && windowEndTs !== null && windowEndTs > nowTs;
    const remainingSec = hasActiveSelection ? Math.max(0, Math.floor((windowEndTs - nowTs) / 1000)) : null;
    return {
      finalCandidatesCount: this.truthSelection.finalCandidatesCount,
      selectedSlug: hasActiveSelection ? selectedSlug : null,
      selectedMarketId: hasActiveSelection ? selectedMarketId : null,
      windowStartTs: hasActiveSelection ? windowStartTs : null,
      windowEndTs: hasActiveSelection ? windowEndTs : null,
      remainingSec
    };
  }

  private getPaperLifecycleStatus(
    nowTs: number,
    selectionSnapshot: {
      selectedSlug: string | null;
      selectedMarketId: string | null;
      windowEndTs: number | null;
    }
  ): string | null {
    const paperResolutionStats = this.getPaperResolutionStats(nowTs);
    const hasActiveSelection = Boolean(selectionSnapshot.selectedSlug || selectionSnapshot.selectedMarketId);
    if (hasActiveSelection) {
      return paperResolutionStats.openTradesCount > 0 ? "OPEN" : "ACTIVE";
    }
    if (paperResolutionStats.openTradesCount > 0) {
      return "OPEN";
    }
    if (paperResolutionStats.awaitingResolutionCount > 0 || this.truthHoldReason === "AWAITING_RESOLUTION") {
      return "AWAITING_RESOLUTION";
    }
    if (paperResolutionStats.resolutionErrorCount > 0) {
      return "RESOLUTION_ERROR";
    }
    if (this.truthLastAction === "RESOLVE" || this.truthLastAction === "CLOSE") {
      const latestTrade = this.paperLedger
        .getAllTrades()
        .slice()
        .sort((a, b) => Number(b.statusUpdatedAt || b.resolvedAt || b.createdTs || 0) - Number(a.statusUpdatedAt || a.resolvedAt || a.createdTs || 0))[0];
      return latestTrade ? getPaperTradeStatus(latestTrade) : this.truthLastAction;
    }
    if (this.truthLastAction === "OPEN" && paperResolutionStats.openTradesCount > 0) {
      return "OPEN";
    }
    return hasActiveSelection && selectionSnapshot.windowEndTs && selectionSnapshot.windowEndTs > nowTs ? "ACTIVE" : "IDLE";
  }

  private getPaperResolutionStats(nowTs: number): {
    openTradesCount: number;
    awaitingResolutionCount: number;
    resolutionErrorCount: number;
    resolutionQueueCount: number;
  } {
    if (this.config.polymarket.mode !== "paper") {
      return {
        openTradesCount: 0,
        awaitingResolutionCount: 0,
        resolutionErrorCount: 0,
        resolutionQueueCount: 0
      };
    }
    let openTradesCount = 0;
    let awaitingResolutionCount = 0;
    let resolutionErrorCount = 0;
    for (const trade of this.paperLedger.getAllTrades()) {
      const status = getPaperTradeStatus(trade);
      const expiryTs = Number(trade.expectedCloseTs || trade.windowEndTs || 0);
      if (status === "OPEN") {
        if (expiryTs > 0 && expiryTs <= nowTs) {
          awaitingResolutionCount += 1;
        } else {
          openTradesCount += 1;
        }
      } else if (status === "AWAITING_RESOLUTION") {
        awaitingResolutionCount += 1;
      } else if (status === "RESOLUTION_ERROR") {
        resolutionErrorCount += 1;
      }
    }
    return {
      openTradesCount,
      awaitingResolutionCount,
      resolutionErrorCount,
      resolutionQueueCount: awaitingResolutionCount + resolutionErrorCount
    };
  }

  private getCurrentPaperWindowRuntimeContext(nowTs: number): {
    chosenDirection: string | null;
    entriesInWindow: number | null;
    realizedPnlUsd: number | null;
    holdReason: string | null;
  } | null {
    if (this.config.polymarket.mode !== "paper") return null;
    const marketId = this.truthSelection.selectedMarketId ?? null;
    const windowStartTs =
      Number(this.truthSelection.windowStartTs || 0) > 0 ? Number(this.truthSelection.windowStartTs) : null;
    const windowEndTs =
      Number(this.truthSelection.windowEndTs || 0) > 0 ? Number(this.truthSelection.windowEndTs) : null;
    if (!marketId || windowStartTs === null || windowEndTs === null) {
      return null;
    }
    const windowStats = this.getPaperWindowStats(marketId, windowStartTs, windowEndTs);
    const windowTrades = windowStats.trades;
    const openWindowTrade = windowTrades.find((row) => getPaperTradeStatus(row) === "OPEN") || null;
    const lastExitedEarlyTrade =
      windowTrades
        .filter((row) => getPaperTradeStatus(row) === "EXITED_EARLY" && Number(row.resolvedAt || 0) > 0)
        .sort((a, b) => Number(b.resolvedAt || 0) - Number(a.resolvedAt || 0))[0] || null;
    const cooldownUntilTs =
      lastExitedEarlyTrade && Number(lastExitedEarlyTrade.resolvedAt || 0) > 0
        ? Number(lastExitedEarlyTrade.resolvedAt || 0) + this.config.polymarket.paper.reentryCooldownSec * 1000
        : 0;
    const latestWindowTrade =
      windowTrades
        .slice()
        .sort(
          (a, b) =>
            Number(b.statusUpdatedAt || b.resolvedAt || b.createdTs || 0) -
            Number(a.statusUpdatedAt || a.resolvedAt || a.createdTs || 0)
        )[0] || null;
    return {
      chosenDirection: latestWindowTrade
        ? this.getPaperDirectionLabel({
            side: latestWindowTrade.side,
            yesDisplayLabel: latestWindowTrade.yesDisplayLabel,
            noDisplayLabel: latestWindowTrade.noDisplayLabel,
            marketQuestion: latestWindowTrade.marketQuestion
          })
        : this.truthChosenDirection,
      entriesInWindow: windowStats.entriesTaken,
      realizedPnlUsd: windowStats.realizedPnlUsd,
      holdReason:
        windowEndTs > nowTs && !openWindowTrade && cooldownUntilTs > nowTs
          ? "REENTRY_COOLDOWN"
          : null
    };
  }

  private buildOpenTradeMonitorSnapshot(nowTs: number): {
    tradeId: string;
    marketId: string;
    marketSlug: string | null;
    windowStartTs: number;
    windowEndTs: number;
    side: "YES" | "NO";
    direction: string;
    heldTokenId: string | null;
    strikePrice: number | null;
    btcStartPrice: number | null;
    entryBtcReferencePrice: number | null;
    btcReferencePrice: number | null;
    btcReferenceTs: number | null;
    btcReferenceAgeMs: number | null;
    btcReferenceStale: boolean;
    contractEntryPrice: number;
    contractLivePrice: number | null;
    impliedProbPct: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    livePrice: number | null;
    markSource: string | null;
    markTs: number | null;
    markAgeMs: number | null;
    markStale: boolean;
    isStale: boolean;
    qty: number;
    shares: number;
    entryPrice: number;
    entryNotionalUsd: number;
    feesUsd: number;
    markValueUsd: number | null;
    unrealizedPnlUsd: number | null;
  } | null {
    if (this.config.polymarket.mode !== "paper") return null;
    const openTrade = this.paperLedger
      .getOpenTrades()
      .filter((row) => Number(row.expectedCloseTs || row.windowEndTs || 0) > nowTs)
      .slice()
      .sort((a, b) => Number(b.createdTs || 0) - Number(a.createdTs || 0))[0];
    if (!openTrade) return null;

    const yesSnapshot = this.getCachedYesBookSnapshot(openTrade.marketId, nowTs);
    const heldTokenId =
      String(
        openTrade.heldTokenId ||
          (openTrade.side === "YES" ? openTrade.yesTokenId : openTrade.noTokenId) ||
          ""
      ).trim() || null;
    const actualHeldSnapshot = heldTokenId ? this.getCachedTokenBookSnapshot(heldTokenId, nowTs) : null;
    let bestBid: number | null = actualHeldSnapshot?.bestBid ?? null;
    let bestAsk: number | null = actualHeldSnapshot?.bestAsk ?? null;
    let livePrice: number | null = actualHeldSnapshot?.mark ?? null;
    let markSource: string | null = actualHeldSnapshot?.markSource ?? null;
    let markTs: number | null = actualHeldSnapshot?.bookTs ?? null;

    if (openTrade.side === "YES") {
      if (yesSnapshot) {
        bestBid = bestBid ?? (yesSnapshot.yesBid > 0 ? yesSnapshot.yesBid : null);
        bestAsk = bestAsk ?? (yesSnapshot.yesAsk > 0 ? yesSnapshot.yesAsk : null);
        livePrice =
          livePrice ??
          (bestBid !== null && bestAsk !== null
            ? clamp((bestBid + bestAsk) / 2, Math.min(bestBid, bestAsk), Math.max(bestBid, bestAsk))
            : bestBid ?? bestAsk ?? null);
        markSource =
          markSource ??
          (bestBid !== null && bestAsk !== null
            ? "MID"
            : bestBid !== null
              ? "BID_FALLBACK"
              : bestAsk !== null
                ? "ASK_FALLBACK"
                : null);
        markTs = markTs ?? yesSnapshot.bookTs;
      }
    } else if (yesSnapshot) {
      const derivedNoBid = yesSnapshot.yesAsk > 0 ? estimateNoBidFromYesBook(yesSnapshot.yesAsk) : null;
      const derivedNoAsk = yesSnapshot.yesBid > 0 ? estimateNoAskFromYesBook(yesSnapshot.yesBid) : null;
      bestBid = bestBid ?? derivedNoBid;
      bestAsk = bestAsk ?? derivedNoAsk;
      livePrice =
        livePrice ??
        (bestBid !== null && bestAsk !== null
          ? clamp((bestBid + bestAsk) / 2, Math.min(bestBid, bestAsk), Math.max(bestBid, bestAsk))
          : bestBid ?? bestAsk ?? null);
      markSource =
        markSource ??
        (bestBid !== null && bestAsk !== null
          ? "DERIVED_NO_MID"
          : bestBid !== null
            ? "DERIVED_NO_BID_FALLBACK"
            : bestAsk !== null
              ? "DERIVED_NO_ASK_FALLBACK"
              : null);
      markTs = markTs ?? yesSnapshot.bookTs;
    }

    const entryNotionalUsd = Math.max(0, Number(openTrade.entryCostUsd || openTrade.notionalUsd || 0));
    const feesUsd = Math.max(0, Number(openTrade.feesUsd || 0));
    const qty = Math.max(0, Number(openTrade.qty || 0));
    const markValueUsd = livePrice !== null ? qty * livePrice : null;
    const unrealizedPnlUsd = markValueUsd !== null ? markValueUsd - entryNotionalUsd - feesUsd : null;
    const markAgeMs = markTs !== null && markTs > 0 ? Math.max(0, nowTs - markTs) : null;
    const staleThresholdMs = Math.max(5_000, this.config.polymarket.risk.staleMs);
    const cachedThresholdMs = Math.max(staleThresholdMs, this.config.polymarket.loopMs * 2);
    const isStale = markAgeMs !== null ? markAgeMs > staleThresholdMs : true;
    const btcReferencePrice =
      Number(this.lastOracleSnapshot?.price || 0) > 0
        ? Number(this.lastOracleSnapshot?.price || 0)
        : Number(openTrade.referencePriceAtEntry || 0) > 0
          ? Number(openTrade.referencePriceAtEntry || 0)
          : null;
    const btcReferenceTs =
      toMs(this.lastOracleSnapshot?.rawTs || 0) > 0
        ? toMs(this.lastOracleSnapshot?.rawTs || 0)
        : Number(openTrade.entryTs || openTrade.createdTs || 0) > 0
          ? Number(openTrade.entryTs || openTrade.createdTs || 0)
          : null;
    const btcReferenceAgeMs =
      btcReferenceTs !== null && btcReferenceTs > 0 ? Math.max(0, nowTs - btcReferenceTs) : null;
    const btcReferenceStale =
      btcReferenceAgeMs !== null ? btcReferenceAgeMs > Math.max(5_000, this.config.polymarket.risk.staleMs) : true;
    const contractEntryPrice = Math.max(0, Number(openTrade.entryPrice || 0));
    const contractLivePrice = livePrice;
    const impliedProbPct = contractLivePrice !== null ? contractLivePrice * 100 : null;
    const btcStartPrice =
      Number(openTrade.referencePriceAtEntry || 0) > 0 ? Number(openTrade.referencePriceAtEntry) : null;
    if (livePrice === null) {
      markSource = "UNAVAILABLE";
    } else if (markAgeMs !== null && markAgeMs > cachedThresholdMs) {
      markSource = prefixCachedMarkSource(markSource);
    }
    return {
      tradeId: openTrade.id,
      marketId: openTrade.marketId,
      marketSlug: openTrade.marketSlug || null,
      windowStartTs: openTrade.windowStartTs,
      windowEndTs: openTrade.windowEndTs,
      side: openTrade.side,
      direction: this.getPaperDirectionLabel({
        side: openTrade.side,
        yesDisplayLabel: openTrade.yesDisplayLabel,
        noDisplayLabel: openTrade.noDisplayLabel,
        marketQuestion: openTrade.marketQuestion
      }),
      heldTokenId,
      strikePrice: Number(openTrade.priceToBeat || 0) > 0 ? Number(openTrade.priceToBeat) : null,
      btcStartPrice,
      entryBtcReferencePrice:
        Number(openTrade.referencePriceAtEntry || 0) > 0 ? Number(openTrade.referencePriceAtEntry) : null,
      btcReferencePrice,
      btcReferenceTs,
      btcReferenceAgeMs,
      btcReferenceStale,
      contractEntryPrice,
      contractLivePrice,
      impliedProbPct,
      bestBid,
      bestAsk,
      livePrice,
      markSource,
      markTs,
      markAgeMs,
      markStale: isStale,
      isStale,
      qty,
      shares: qty,
      entryPrice: contractEntryPrice,
      entryNotionalUsd,
      feesUsd,
      markValueUsd,
      unrealizedPnlUsd
    };
  }

  private getPaperTakeProfitUsd(remainingSec: number): number {
    if (remainingSec >= 240) return this.config.polymarket.paper.takeProfitUsdGte240;
    if (remainingSec >= 180) return this.config.polymarket.paper.takeProfitUsdGte180;
    if (remainingSec >= 120) return this.config.polymarket.paper.takeProfitUsdGte120;
    if (remainingSec >= 60) return this.config.polymarket.paper.takeProfitUsdGte60;
    if (remainingSec >= this.config.polymarket.paper.entryMinRemainingSec) {
      return this.config.polymarket.paper.takeProfitUsdGte45;
    }
    return this.config.polymarket.paper.takeProfitUsdGte45;
  }

  private getPaperTrailingRetraceFraction(remainingSec: number): number {
    if (remainingSec > 180) return this.config.polymarket.paper.trailingRetraceFracGt180;
    if (remainingSec >= 60) return this.config.polymarket.paper.trailingRetraceFracGte60;
    return this.config.polymarket.paper.trailingRetraceFracLt60;
  }

  private getPaperWindowStats(marketId: string, windowStartTs: number, windowEndTs: number): {
    trades: ReturnType<PaperLedger["getTradesForWindow"]>;
    entriesTaken: number;
    realizedPnlUsd: number;
  } {
    const trades = this.paperLedger.getTradesForWindow(marketId, windowStartTs, windowEndTs);
    const realizedPnlUsd = trades
      .filter((trade) => Boolean(trade.resolvedAt))
      .reduce((sum, trade) => sum + Number(trade.pnlUsd || 0), 0);
    return {
      trades,
      entriesTaken: trades.length,
      realizedPnlUsd
    };
  }

  private updateTruthWindowContextFromTrade(
    trade: {
      marketId: string;
      marketSlug?: string;
      marketQuestion?: string;
      windowStartTs: number;
      windowEndTs: number;
      side: "YES" | "NO";
      yesDisplayLabel?: string;
      noDisplayLabel?: string;
    },
    resolutionSource?: string | null
  ): void {
    const windowStats = this.getPaperWindowStats(trade.marketId, trade.windowStartTs, trade.windowEndTs);
    this.truthChosenDirection = this.getPaperDirectionLabel({
      side: trade.side,
      yesDisplayLabel: trade.yesDisplayLabel,
      noDisplayLabel: trade.noDisplayLabel,
      marketQuestion: trade.marketQuestion
    });
    this.truthEntriesInWindow = windowStats.entriesTaken;
    this.truthWindowRealizedPnlUsd = windowStats.realizedPnlUsd;
    if (resolutionSource !== undefined) {
      this.truthResolutionSource = resolutionSource;
    }
    if (trade.marketSlug) {
      this.truthSelection.selectedSlug = trade.marketSlug;
    }
    this.truthSelection.selectedMarketId = trade.marketId;
    this.truthSelection.windowStartTs = trade.windowStartTs;
    this.truthSelection.windowEndTs = trade.windowEndTs;
  }

  private getPaperDirectionLabel(input: {
    side: "YES" | "NO";
    yesDisplayLabel?: string | null;
    noDisplayLabel?: string | null;
    marketQuestion?: string | null;
  }): string {
    const yesLabel = normalizeDirectionalDisplayLabel(input.yesDisplayLabel, input.marketQuestion, "YES");
    const noLabel = normalizeDirectionalDisplayLabel(input.noDisplayLabel, input.marketQuestion, "NO");
    return input.side === "YES" ? yesLabel : noLabel;
  }

  private choosePaperEntrySide(input: {
    netEdgeYes: number;
    netEdgeNo: number;
    pUpModel: number;
  }): PaperSideChoice {
    const diff = Number(input.netEdgeYes) - Number(input.netEdgeNo);
    if (diff > 1e-9) {
      return { chosenSide: "YES", chooserReason: "NET_EDGE_YES_GT_NO" };
    }
    if (diff < -1e-9) {
      return { chosenSide: "NO", chooserReason: "NET_EDGE_NO_GT_YES" };
    }
    if (input.pUpModel > 0.5005) {
      return { chosenSide: "YES", chooserReason: "PUP_GT_50_TIEBREAK" };
    }
    if (input.pUpModel < 0.4995) {
      return { chosenSide: "NO", chooserReason: "PDOWN_GT_50_TIEBREAK" };
    }
    return { chosenSide: null, chooserReason: "EDGE_TIE_NO_DIRECTION" };
  }

  private buildPaperResolutionHints(trade: {
    marketQuestion?: string;
    yesDisplayLabel?: string;
    noDisplayLabel?: string;
  }): Pick<PolymarketMarketResolution, "yesOutcomeMapped" | "noOutcomeMapped"> {
    return {
      yesOutcomeMapped: normalizeDirectionalDisplayLabel(
        trade.yesDisplayLabel,
        trade.marketQuestion,
        "YES"
      ) as "UP" | "DOWN",
      noOutcomeMapped: normalizeDirectionalDisplayLabel(
        trade.noDisplayLabel,
        trade.marketQuestion,
        "NO"
      ) as "UP" | "DOWN"
    };
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const startedTs = Date.now();
      try {
        await this.runOnce(startedTs);
        this.consecutiveErrors = 0;
      } catch (error) {
        this.consecutiveErrors += 1;
        const transient = isTransientPolymarketError(error);
        this.logger[transient ? "warn" : "error"](
          {
            error,
            transient,
            consecutiveErrors: this.consecutiveErrors
          },
          transient ? "Polymarket transient tick failure (skipping tick)" : "Polymarket loop error"
        );
        if (transient) {
          this.setTradingPaused(true, "NETWORK_ERROR", startedTs);
        }
        this.maybeEmitTickLog({
          marketsSeen: 0,
          activeWindows: 0,
          now: new Date(startedTs).toISOString(),
          currentMarketId: null,
          tauSec: null,
          priceToBeat: null,
          oracleEst: null,
          sigma: null,
          yesBid: null,
          yesAsk: null,
          yesMid: null,
          pUpModel: null,
          edge: null,
          threshold: null,
          action: "ERROR",
          holdReason: "LOOP_ERROR",
          size: null,
          openTrades: this.paperLedger.getOpenTrades().length,
          resolvedTrades: this.paperLedger.getResolvedTrades().length,
          oracleSource: this.lastOracleSnapshot?.source ?? "none",
          oracleTs: this.lastOracleSnapshot?.rawTs ?? null,
          oracleStaleMs:
            this.lastOracleSnapshot && this.lastOracleSnapshot.rawTs > 0
              ? Math.max(0, startedTs - toMs(this.lastOracleSnapshot.rawTs))
              : null,
          oracleState: this.lastOracleSnapshot?.state ?? "INIT",
          selectedSlug: null,
          windowStart: null,
          windowEnd: null,
          acceptingOrders: null,
          enableOrderBook: null,
          tradingPaused: this.tradingPaused,
          pauseReason: this.pauseReason || null,
          pauseSinceTs: this.pauseSinceTs
        });
        if (!transient && this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
          this.logger.error(
            { consecutiveErrors: this.consecutiveErrors },
            "Polymarket reached max consecutive errors; continuing loop and waiting for recovery"
          );
          this.consecutiveErrors = 0;
        }
      }

      const elapsed = Date.now() - startedTs;
      const waitMs = Math.max(25, this.config.polymarket.loopMs - elapsed);
      await sleep(waitMs);
    }
  }

  private async runLoopWithRestart(): Promise<void> {
    let restartBackoffMs = 1_000;
    while (this.running) {
      try {
        await this.runLoop();
        if (!this.running) {
          return;
        }
        this.logger.error("Polymarket loop exited unexpectedly; restarting");
      } catch (error) {
        if (!this.running) {
          return;
        }
        this.logger.error(
          { error, restartBackoffMs },
          "Polymarket loop crashed unexpectedly; restarting"
        );
      }
      await sleep(restartBackoffMs);
      restartBackoffMs = Math.min(30_000, restartBackoffMs * 2);
    }
  }

  private isDeterministicBtc5mMode(): boolean {
    if (process.argv.includes("--btc5m")) {
      return true;
    }
    const cadence = Math.max(1, Math.floor(Number(this.config.polymarket.marketQuery.cadenceMinutes || 0)));
    const symbol = String(this.config.polymarket.marketQuery.symbol || "")
      .trim()
      .toUpperCase();
    return cadence === 5 && symbol === "BTC-USD";
  }

  private makePaperIntervalKey(marketId: string, intervalStartTs: number, intervalEndTs: number): string {
    return `${marketId}:${intervalStartTs}:${intervalEndTs}`;
  }

  private prunePaperIntervalDecisions(nowTs: number): void {
    const cutoffTs = nowTs - 3 * 60 * 60 * 1000;
    for (const [key, memo] of this.paperDecisionByIntervalKey.entries()) {
      if (memo.decidedAt < cutoffTs) {
        this.paperDecisionByIntervalKey.delete(key);
      }
    }
  }

  private writePaperIntervalEvent(
    event: string,
    nowTs: number,
    payload: Record<string, unknown> = {},
    level: "info" | "warn" = "info"
  ): void {
    this.writePaperTradeLog({
      ts: new Date(nowTs).toISOString(),
      event,
      ...payload
    });
    const loggerPayload = {
      event,
      ...payload
    };
    if (level === "warn") {
      this.logger.warn(loggerPayload, `POLY_PAPER_${event}`);
      return;
    }
    this.logger.info(loggerPayload, `POLY_PAPER_${event}`);
  }

  private notePaperIntervalSelection(interval: PaperIntervalContext | null, nowTs: number): void {
    const nextKey = interval?.key ?? null;
    if (
      this.lastPaperIntervalKey &&
      this.lastPaperIntervalEndTs &&
      nowTs >= this.lastPaperIntervalEndTs &&
      this.lastPaperIntervalKey !== nextKey
    ) {
      this.writePaperIntervalEvent("INTERVAL_EXPIRED", nowTs, {
        intervalKey: this.lastPaperIntervalKey,
        intervalEndTs: this.lastPaperIntervalEndTs
      });
    }
    if (interval && nextKey !== this.lastPaperIntervalKey) {
      this.cachedPaperIntervalsBySlug.set(interval.slug, { ...interval, market: { ...interval.market } });
      this.writePaperIntervalEvent(this.lastPaperIntervalKey ? "NEXT_INTERVAL_SELECTED" : "INTERVAL_SELECTED", nowTs, {
        intervalKey: interval.key,
        marketId: interval.marketId,
        slug: interval.slug,
        intervalStartTs: interval.intervalStartTs,
        intervalEndTs: interval.intervalEndTs,
        remainingSec: interval.remainingSec
      });
    }
    this.lastPaperIntervalKey = nextKey;
    this.lastPaperIntervalEndTs = interval?.intervalEndTs ?? null;
  }

  private getCachedPaperInterval(slug: string, nowTs: number): PaperIntervalContext | null {
    const cached = this.cachedPaperIntervalsBySlug.get(slug);
    if (!cached) {
      return null;
    }
    if (cached.intervalEndTs <= nowTs || cached.intervalStartTs - FIVE_MIN_SEC * 1000 > nowTs) {
      return null;
    }
    return {
      ...cached,
      market: { ...cached.market },
      remainingSec: Math.max(0, Math.floor((cached.intervalEndTs - nowTs) / 1000))
    };
  }

  private async selectPaperInterval(nowTs: number): Promise<PaperIntervalSelection> {
    const nowStartSec = windowTs(nowTs);
    const previousStartSec = nowStartSec - FIVE_MIN_SEC;
    const attemptedSlugs = [slugForTs(nowStartSec), slugForTs(previousStartSec)];
    for (const slug of attemptedSlugs) {
      let raw: Record<string, unknown> | null = null;
      try {
        raw = await this.client.getActiveMarketBySlug(slug);
      } catch (error) {
        this.logger.warn(
          {
            slug,
            error: this.shortErrorText(error)
          },
          "POLY_PAPER_INTERVAL_FETCH_FAILED"
        );
      }
      if (!raw) {
        continue;
      }
      const startSec = parseBtc5mWindowStartSec(slug) ?? nowStartSec;
      const intervalStartTs = startSec * 1000;
      const intervalEndTs = (startSec + FIVE_MIN_SEC) * 1000;
      const parsed = parseRawMarketToBtcWindow(raw, nowTs, intervalEndTs, this.lastOracleSnapshot?.price ?? null);
      if (!parsed) {
        continue;
      }
      const market = this.applyWindowState(
        {
          ...parsed,
          startTs: intervalStartTs,
          endTs: intervalEndTs
        },
        nowTs
      );
      const remainingSec = Math.floor((intervalEndTs - nowTs) / 1000);
      if (
        remainingSec <= 0 ||
        market.closed ||
        !slug.startsWith("btc-updown-5m-")
      ) {
        continue;
      }
      return {
        interval: {
          key: this.makePaperIntervalKey(market.marketId, intervalStartTs, intervalEndTs),
          marketId: market.marketId,
          slug,
          yesTokenId: market.yesTokenId,
          noTokenId: String(market.noTokenId || "").trim(),
          intervalStartTs,
          intervalEndTs,
          remainingSec,
          priceToBeat: market.priceToBeat,
          market
        },
        selectedReason: slug === attemptedSlugs[0] ? "btc5m_current_interval" : "btc5m_previous_interval",
        dominantReject: "OK",
        attemptedSlugs
      };
    }
    const cachedCurrentInterval = this.getCachedPaperInterval(attemptedSlugs[0], nowTs);
    if (cachedCurrentInterval) {
      return {
        interval: cachedCurrentInterval,
        selectedReason: "btc5m_cached_current_interval",
        dominantReject: "FETCH_STALE",
        attemptedSlugs
      };
    }
    return {
      interval: null,
      selectedReason: "btc5m_not_found",
      dominantReject: "NO_ACTIVE_BTC5M_MARKET",
      attemptedSlugs
    };
  }

  private async runPaperIntervalEngine(nowTs: number): Promise<void> {
    this.prunePaperIntervalDecisions(nowTs);
    await this.resolvePaperTrades(nowTs);

    const selection = await this.selectPaperInterval(nowTs);
    const interval = selection.interval;
    this.notePaperIntervalSelection(interval, nowTs);

    this.selectedTokenIds = interval ? [interval.yesTokenId, interval.noTokenId].filter(Boolean) : [];

    const openTradesBefore = this.paperLedger.getOpenTrades();
    const resolutionQueueBefore = this.paperLedger.getResolutionQueueTrades();
    const shouldEstimateOracle =
      Boolean(interval) || openTradesBefore.length > 0 || resolutionQueueBefore.length > 0;
    let oracleEst = 0;
    let oracleAgeMs = 0;
    let sigmaPricePerSqrtSec = 0;
    let sigmaPerSqrtSec = 0;
    let oracleState: OracleState | "IDLE" = "IDLE";
    let oracleSource = "none";
    let oracleTs: number | null = null;
    let oracleStaleMs: number | null = null;

    if (shouldEstimateOracle) {
      const oracle = await this.oracleRouter.getOracleNow(nowTs);
      const oracleRawTsMs = toMs(oracle.rawTs);
      this.lastOracleSnapshot = oracle;
      oracleState = oracle.state;
      oracleSource = oracle.source;
      oracleTs = oracleRawTsMs > 0 ? oracleRawTsMs : null;
      oracleStaleMs = Number.isFinite(oracle.staleMs) ? oracle.staleMs : null;
      if (oracle.price > 0 && oracleRawTsMs > 0) {
        oracleEst = oracle.price;
        this.volEstimator.update(oracle.price, oracleRawTsMs);
        this.recordOracleSample(oracle.price, oracleRawTsMs, oracle.source);
        const vol = this.volEstimator.getEstimate(oracle.price, nowTs);
        sigmaPricePerSqrtSec = vol.sigmaPricePerSqrtSec;
        sigmaPerSqrtSec = vol.sigmaPerSqrtSec;
        if (!(sigmaPricePerSqrtSec > 0) && oracle.fallbackSigmaPricePerSqrtSec > 0) {
          sigmaPricePerSqrtSec = oracle.fallbackSigmaPricePerSqrtSec;
          sigmaPerSqrtSec = oracleEst > 0 ? sigmaPricePerSqrtSec / oracleEst : 0;
        }
        oracleAgeMs = Math.max(0, nowTs - oracleRawTsMs);
      } else {
        oracleAgeMs = Number.POSITIVE_INFINITY;
      }
    }

    const discoveryTickFields = {
      discoveredCandidates: interval ? 1 : 0,
      fetchedCount: interval ? 1 : 0,
      afterActiveCount: interval ? 1 : 0,
      afterSearchCount: interval ? 1 : 0,
      afterWindowCount: interval ? 1 : 0,
      afterPatternCount: interval ? 1 : 0,
      finalCandidatesCount: interval ? 1 : 0,
      fallbackUsed: "none" as const,
      selectedReason: selection.selectedReason,
      selectedScore: null,
      rejectCountsByStage: createRejectCountsByStage(),
      dominantReject: selection.dominantReject,
      windowRejectCounters: createWindowRejectCounters(),
      windowReject: interval ? null : selection.dominantReject,
      minWindowSec: this.config.polymarket.paper.entryMinRemainingSec,
      maxWindowSec: this.config.polymarket.paper.entryMaxRemainingSec,
      acceptedSampleCount: interval ? 1 : 0,
      sampleRejected: [] as RejectSample[]
    };

    if (!interval) {
      const openTrades = this.paperLedger.getOpenTrades().length;
      const awaitingResolutionCount = this.paperLedger.getResolutionQueueTrades().length;
      this.maybeEmitTickLog({
        marketsSeen: openTrades > 0 ? 1 : 0,
        ...discoveryTickFields,
        activeWindows: 0,
        now: new Date(nowTs).toISOString(),
        currentMarketId: null,
        tauSec: null,
        priceToBeat: null,
        oracleEst: oracleEst > 0 ? oracleEst : null,
        sigma: sigmaPricePerSqrtSec > 0 ? sigmaPricePerSqrtSec : null,
        yesBid: null,
        yesAsk: null,
        yesMid: null,
        pUpModel: null,
        edge: null,
        threshold: null,
        action: "HOLD",
        holdReason: selection.dominantReject || "NO_ACTIVE_BTC5M_MARKET",
        holdDetailReason: selection.dominantReject,
        chosenDirection: null,
        size: null,
        openTrades,
        awaitingResolutionCount,
        resolutionQueueCount: awaitingResolutionCount,
        resolvedTrades: this.paperLedger.getResolvedTrades().length,
        entriesInWindow: 0,
        windowRealizedPnlUsd: 0,
        oracleSource,
        oracleTs,
        oracleStaleMs,
        oracleState,
        selectedSlug: null,
        windowStart: null,
        windowEnd: null,
        acceptingOrders: null,
        enableOrderBook: null
      });
      return;
    }

    const market = interval.market;
    const implied = await this.getImpliedYesBook(market, {
      isSelectedMarket: true,
      remainingSec: interval.remainingSec
    });
    const polyUpdateAgeMs = implied.bookTs > 0 ? Math.max(0, nowTs - implied.bookTs) : 0;
    const paperSoftOracleStaleAllowed =
      oracleState === "ORACLE_STALE" && polyUpdateAgeMs <= this.config.polymarket.risk.staleMs;

    if (paperSoftOracleStaleAllowed) {
      this.logger.warn(
        {
          marketId: market.marketId,
          slug: interval.slug,
          oracleState,
          oracleSource,
          oracleTs,
          oracleStaleMs,
          polyUpdateAgeMs
        },
        "Paper mode allowing interval entry despite ORACLE_STALE because the selected BTC5m book is fresh"
      );
    }

    let noAsk = estimateNoAskFromYesBook(implied.yesBid);
    let noTopAskSize = 0;
    if (market.noTokenId) {
      const noQuote = await this.getNoAskAndDepthFromTokenId(market.noTokenId, noAsk);
      noAsk = noQuote.noAsk;
      noTopAskSize = noQuote.topAskSize;
    }

    const fastMidSnapshot = this.oracleRouter.getFastMidNow(nowTs);
    const fastMidNow =
      fastMidSnapshot && fastMidSnapshot.price > 0
        ? fastMidSnapshot.price
        : oracleEst > 0
          ? oracleEst
          : 0;
    const lagStatsSnapshot = this.lagProfiler.getStats();
    const lagPolyP90Ms = lagStatsSnapshot.metrics.polyUpdateAgeMs.p90;
    const shortReturn = this.computeShortReturn(nowTs, 45);
    const realizedVolPricePerSqrtSec = this.computeRealizedVolPricePerSqrtSec(
      nowTs,
      fastMidNow > 0 ? fastMidNow : oracleEst,
      sigmaPricePerSqrtSec,
      300
    );
    const tauSec = interval.remainingSec;
    const orderBook = {
      marketId: market.marketId,
      tokenId: market.yesTokenId,
      yesBid: implied.yesBid,
      yesAsk: implied.yesAsk,
      yesMid: implied.yesMid,
      spread: implied.spread,
      bids: [],
      asks: [],
      ts: nowTs
    };
    const prob = this.probModel.computeAdaptive({
      oracleEst: fastMidNow > 0 ? fastMidNow : oracleEst,
      priceToBeat: market.priceToBeat,
      tauSec,
      cadenceSec: this.config.polymarket.marketQuery.cadenceMinutes * 60,
      shortReturn,
      realizedVolPricePerSqrtSec
    });
    const decision = this.strategy.decide({
      pUpModel: prob.pUpModel,
      orderBook,
      sigmaPerSqrtSec,
      tauSec
    });
    const calibrated = this.probModel.computeExpiryProbCalibrated({
      fastMid: fastMidNow > 0 ? fastMidNow : oracleEst,
      priceToBeat: market.priceToBeat,
      sigmaPricePerSqrtSec,
      tauSec,
      polyUpdateAgeMs,
      lagPolyP90Ms,
      oracleAgeMs: oracleAgeMs > 0 && Number.isFinite(oracleAgeMs) ? oracleAgeMs : 0
    });

    this.lagProfiler.record({
      tsMs: nowTs,
      windowSlug: interval.slug,
      tauSec,
      priceToBeat: market.priceToBeat,
      fastMid: fastMidNow > 0 ? fastMidNow : null,
      oraclePrice: oracleEst > 0 ? oracleEst : null,
      oracleUpdatedAtMs: oracleTs ?? null,
      yesBid: implied.yesBid,
      yesAsk: implied.yesAsk,
      yesMid: implied.yesMid,
      impliedProbMid: implied.yesMid,
      pModel: prob.pUpModel,
      absProbGap: Math.abs(prob.pUpModel - implied.yesMid)
    });

    this.latestPolymarketSnapshot = {
      ts: nowTs,
      windowSlug: interval.slug,
      tauSec,
      priceToBeat: market.priceToBeat,
      fastMid: fastMidNow > 0 ? fastMidNow : null,
      yesMid: implied.yesMid,
      impliedProbMid: implied.yesMid
    };
    this.latestModelSnapshot = {
      ts: nowTs,
      pBase: calibrated.pBase,
      pBoosted: calibrated.pBoosted,
      z: calibrated.z,
      d: calibrated.d,
      sigma: calibrated.sigma,
      tauSec: calibrated.tauSec,
      polyUpdateAgeMs: calibrated.polyUpdateAgeMs,
      lagPolyP90Ms: calibrated.lagPolyP90Ms,
      oracleAgeMs: calibrated.oracleAgeMs,
      boostApplied: calibrated.boostApplied,
      boostReason: calibrated.boostReason
    };
    this.polyState.lastModelTs = nowTs;

    await this.managePaperOpenPositions({
      nowTs,
      market,
      implied,
      edgeYes: prob.pUpModel - (decision.yesAsk > 0 ? decision.yesAsk : decision.yesMid),
      edgeNo: (1 - prob.pUpModel) - noAsk,
      costPenaltyProb:
        (this.config.polymarket.paper.feeBps + this.config.polymarket.paper.slippageBps) / 10_000 +
        Math.max(0, decision.spread) / 2,
      remainingSec: tauSec
    });

    const yesEntryPrice = decision.yesAsk > 0 ? decision.yesAsk : decision.yesMid;
    const noEntryPrice = noAsk > 0 ? noAsk : estimateNoAskFromYesBook(decision.yesBid);
    const feeBps = this.config.polymarket.paper.feeBps;
    const slippageBps = this.config.polymarket.paper.slippageBps;
    const spreadProxy = Math.max(0, decision.spread) / 2;
    const costPenaltyProb = Math.max(0, feeBps + slippageBps) / 10_000 + spreadProxy;
    const edgeYes = prob.pUpModel - yesEntryPrice;
    const edgeNo = (1 - prob.pUpModel) - noEntryPrice;
    const netEdgeYes = edgeYes - costPenaltyProb;
    const netEdgeNo = edgeNo - costPenaltyProb;
    const sideChoice = this.choosePaperEntrySide({
      netEdgeYes,
      netEdgeNo,
      pUpModel: prob.pUpModel
    });
    const chosenSide = sideChoice.chosenSide;
    const chosenDirection =
      chosenSide === null
        ? null
        : this.getPaperDirectionLabel({
            side: chosenSide,
            yesDisplayLabel: market.yesDisplayLabel,
            noDisplayLabel: market.noDisplayLabel,
            marketQuestion: market.question
          });
    const chosenEdge = chosenSide === "YES" ? edgeYes : chosenSide === "NO" ? edgeNo : 0;
    const signedEdge = chosenSide === "YES" ? edgeYes : chosenSide === "NO" ? -edgeNo : 0;
    const netEdgeAfterCosts =
      chosenSide === "YES" ? netEdgeYes : chosenSide === "NO" ? netEdgeNo : Number.NEGATIVE_INFINITY;
    const chosenAsk = chosenSide === "YES" ? yesEntryPrice : chosenSide === "NO" ? noEntryPrice : 0;
    const stalenessEdge = this.computeStalenessEdge(market.marketId, decision.yesMid, oracleEst, nowTs);
    const conviction = clamp(Math.abs(prob.pUpModel - decision.yesMid) + stalenessEdge, 0, 0.9999);
    const extremeLow = this.config.polymarket.paper.extremeLowPrice;
    const extremeHigh = this.config.polymarket.paper.extremeHighPrice;
    const isExtremePrice = chosenSide !== null && (chosenAsk <= extremeLow || chosenAsk >= extremeHigh);
    const pForExtreme = calibrated.pBoosted;
    const probExtreme = this.config.polymarket.paper.probExtreme;
    const hasExtremeModel =
      chosenSide === "YES"
        ? pForExtreme >= probExtreme
        : chosenSide === "NO"
          ? pForExtreme <= 1 - probExtreme
          : false;

    const decisionMemo = this.paperDecisionByIntervalKey.get(interval.key) || null;
    const windowStats = this.getPaperWindowStats(
      interval.marketId,
      interval.intervalStartTs,
      interval.intervalEndTs
    );
    const windowTrades = windowStats.trades;
    const openWindowTrade = windowTrades.find((row) => getPaperTradeStatus(row) === "OPEN") || null;
    const lastExitedEarlyTrade = windowTrades
      .filter((row) => getPaperTradeStatus(row) === "EXITED_EARLY" && Number(row.resolvedAt || 0) > 0)
      .sort((a, b) => Number(b.resolvedAt || 0) - Number(a.resolvedAt || 0))[0] || null;
    const reentryCooldownUntilTs =
      lastExitedEarlyTrade && Number(lastExitedEarlyTrade.resolvedAt || 0) > 0
        ? Number(lastExitedEarlyTrade.resolvedAt || 0) + this.config.polymarket.paper.reentryCooldownSec * 1000
        : 0;
    const cooldownActive = reentryCooldownUntilTs > nowTs;
    const intervalEligibleForEntry =
      tauSec > 0 &&
      tauSec >= this.config.polymarket.paper.entryMinRemainingSec &&
      tauSec <= this.config.polymarket.paper.entryMaxRemainingSec &&
      tauSec >= this.config.polymarket.risk.noNewOrdersInLastSec;

    let action = "HOLD";
    let holdReason: string | null = null;
    let holdDetailReason: string | null = null;
    let executedSize: number | null = null;

    if (!intervalEligibleForEntry) {
      holdReason = tauSec <= 0 ? "EXPIRED_WINDOW" : "TOO_LATE_FOR_ENTRY";
      holdDetailReason = holdReason;
    } else if (openWindowTrade) {
      holdReason = "OPEN_POSITION_IN_WINDOW";
      holdDetailReason = holdReason;
    } else if (cooldownActive) {
      holdReason = "REENTRY_COOLDOWN";
      holdDetailReason = holdReason;
    } else {
      if (oracleState !== "OK" && !(oracleState === "ORACLE_STALE" && paperSoftOracleStaleAllowed)) {
        holdReason = normalizeHoldReason(oracleState) || "ORACLE_UNAVAILABLE";
        holdDetailReason = holdReason;
      } else if (!chosenSide) {
        holdReason = "EDGE_BELOW_THRESHOLD";
        holdDetailReason = sideChoice.chooserReason;
      } else if (!isExtremePrice || !hasExtremeModel) {
        holdReason = "EDGE_BELOW_THRESHOLD";
        holdDetailReason = holdReason;
      } else {
        const openOrderCount = 0;
        const totalExposureUsd = this.paperLedger
          .getOpenTrades()
          .reduce((sum, row) => sum + row.entryCostUsd + row.feesUsd, 0);
        const concurrentWindows = new Set(this.paperLedger.getOpenTrades().map((row) => row.marketId)).size;
        const paperOpenNotional = this.paperLedger.getOpenNotionalForMarket(market.marketId);
        const remainingWindowBudget = Math.max(
          0,
          Math.min(
            this.config.polymarket.sizing.maxNotionalPerWindow,
            this.config.polymarket.paper.maxNotionalPerWindow - paperOpenNotional
          )
        );
        const remainingExposureBudget = Math.max(0, this.config.polymarket.risk.maxExposure - totalExposureUsd);
        const sidePrice = chosenSide === "YES" ? decision.yesAsk : noAsk;
        const sideProb = chosenSide === "YES" ? prob.pUpModel : 1 - prob.pUpModel;
        const topAskDepthShares = chosenSide === "YES" ? implied.topAskSize : noTopAskSize;
        const depthCapNotionalUsd =
          topAskDepthShares > 0 ? topAskDepthShares * Math.max(0.0001, sidePrice) * 0.35 : 0;
        const size = this.sizing.compute({
          edge: Math.max(0, netEdgeAfterCosts),
          pUpModel: sideProb,
          yesAsk: sidePrice,
          conviction,
          remainingSec: tauSec,
          entryMaxRemainingSec: this.config.polymarket.paper.entryMaxRemainingSec,
          depthCapNotionalUsd,
          remainingWindowBudget,
          remainingExposureBudget,
          remainingDailyLossBudget: this.risk.getRemainingDailyLossBudget()
        });
        const requiredNetEdge = Math.max(
          this.config.polymarket.paper.minNetEdge,
          this.config.polymarket.paper.minEdgeThreshold,
          decision.threshold
        );
        if (!(netEdgeAfterCosts > requiredNetEdge)) {
          holdReason = "EDGE_BELOW_THRESHOLD";
          holdDetailReason = holdReason;
        } else if (!(size.notionalUsd > 0)) {
          holdReason = "EDGE_BELOW_THRESHOLD";
          holdDetailReason = holdReason;
        } else {
          const check = this.risk.checkNewOrder({
            tauSec,
            oracleAgeMs,
            projectedOrderNotionalUsd: size.notionalUsd,
            openOrders: openOrderCount,
            totalExposureUsd,
            concurrentWindows
          });
          if (!check.ok) {
            holdReason = check.reason || "RISK_BLOCKED";
            holdDetailReason = holdReason;
          } else {
            const accepted = this.executePaperTrade({
              marketId: market.marketId,
              marketSlug: interval.slug,
              marketQuestion: market.question,
              referenceSymbol: this.config.polymarket.marketQuery.symbol,
              windowStartTs: interval.intervalStartTs,
              windowEndTs: interval.intervalEndTs,
              priceToBeat: market.priceToBeat,
              referencePriceAtEntry: fastMidNow > 0 ? fastMidNow : oracleEst,
              side: chosenSide,
              yesTokenId: market.yesTokenId,
              noTokenId: market.noTokenId,
              yesDisplayLabel: market.yesDisplayLabel,
              noDisplayLabel: market.noDisplayLabel,
              yesBid: decision.yesBid,
              yesAsk: decision.yesAsk,
              noAsk,
              edge: netEdgeAfterCosts,
              pBase: calibrated.pBase,
              pBoosted: calibrated.pBoosted,
              boostApplied: calibrated.boostApplied,
              boostReason: calibrated.boostReason,
              requestedNotionalUsd: size.notionalUsd,
              ts: nowTs
            });
            if (accepted) {
              action = chosenSide === "YES" ? "BUY_YES" : "BUY_NO";
              executedSize = size.notionalUsd;
              this.paperDecisionByIntervalKey.set(interval.key, {
                decidedAt: nowTs,
                action: "ENTRY_OPENED",
                reason: "ENTRY_OPENED"
              });
              this.writePaperIntervalEvent("ENTRY_OPENED", nowTs, {
                intervalKey: interval.key,
                marketId: interval.marketId,
                slug: interval.slug,
                side: chosenSide,
                direction: chosenDirection,
                chooserReason: sideChoice.chooserReason,
                edgeYes,
                edgeNo,
                netEdgeYes,
                netEdgeNo,
                notionalUsd: size.notionalUsd,
                entryPrice: chosenSide === "YES" ? decision.yesAsk : noAsk
              });
            } else {
              holdReason = "ENTRY_REJECTED";
              holdDetailReason = holdReason;
            }
          }
        }
      }
      if (
        action === "HOLD" &&
        holdReason &&
        (!decisionMemo ||
          decisionMemo.action !== "ENTRY_SKIPPED" ||
          decisionMemo.reason !== holdReason)
      ) {
        this.paperDecisionByIntervalKey.set(interval.key, {
          decidedAt: nowTs,
          action: "ENTRY_SKIPPED",
          reason: holdReason
        });
        this.writePaperIntervalEvent("ENTRY_SKIPPED", nowTs, {
          intervalKey: interval.key,
          marketId: interval.marketId,
          slug: interval.slug,
          reason: holdReason,
          chooserReason: sideChoice.chooserReason,
          edgeYes,
          edgeNo,
          netEdgeYes,
          netEdgeNo,
          chosenSide,
          chosenDirection
        });
      }
    }

    if (action === "HOLD" && !holdReason) {
      holdReason = "EDGE_BELOW_THRESHOLD";
      holdDetailReason = "EDGE_BELOW_THRESHOLD";
    }

    const postDecisionWindowStats =
      action === "HOLD"
        ? windowStats
        : this.getPaperWindowStats(interval.marketId, interval.intervalStartTs, interval.intervalEndTs);
    const openTrades = this.paperLedger.getOpenTrades().length;
    const awaitingResolutionCount = this.paperLedger.getResolutionQueueTrades().length;
    const resolvedTrades = this.paperLedger.getResolvedTrades().length;
    this.maybeEmitTickLog({
      marketsSeen: 1,
      ...discoveryTickFields,
      activeWindows: 1,
      now: new Date(nowTs).toISOString(),
      currentMarketId: interval.marketId,
      tauSec,
      priceToBeat: market.priceToBeat,
      oracleEst: oracleEst > 0 ? oracleEst : null,
      sigma: sigmaPricePerSqrtSec > 0 ? sigmaPricePerSqrtSec : null,
      yesBid: decision.yesBid,
      yesAsk: decision.yesAsk,
      yesMid: decision.yesMid,
      pUpModel: prob.pUpModel,
      pBase: calibrated.pBase,
      pBoosted: calibrated.pBoosted,
      z: calibrated.z,
      d: calibrated.d,
      sigmaCalibrated: calibrated.sigma,
      polyUpdateAgeMs: calibrated.polyUpdateAgeMs,
      lagPolyP90Ms: calibrated.lagPolyP90Ms,
      boostApplied: calibrated.boostApplied,
      boostReason: calibrated.boostReason,
      edge: signedEdge,
      edgeYes,
      edgeNo,
      chosenSide,
      chosenDirection,
      chosenEdge,
      conviction,
      stalenessEdge,
      netEdgeAfterCosts,
      threshold: decision.threshold,
      action,
      holdReason,
      holdDetailReason,
      size: executedSize,
      openTrades,
      awaitingResolutionCount,
      resolutionQueueCount: awaitingResolutionCount,
      resolvedTrades,
      entriesInWindow: postDecisionWindowStats.entriesTaken,
      windowRealizedPnlUsd: postDecisionWindowStats.realizedPnlUsd,
      oracleSource,
      oracleTs,
      oracleStaleMs,
      oracleState,
      selectedSlug: interval.slug,
      windowStart: interval.intervalStartTs,
      windowEnd: interval.intervalEndTs,
      acceptingOrders: market.acceptingOrders ?? null,
      enableOrderBook: market.enableOrderBook ?? null
    });
  }

  private async runOnce(_tickStartedTs: number): Promise<void> {
    const nowTs = Date.now();
    this.syncPaperLedgerFromDisk();
    await this.execution.refreshLiveState();
    await this.fetchAttempt(nowTs);

    if (this.risk.isKillSwitchActive()) {
      if (this.config.polymarket.mode === "live" && this.canMutateVenueState()) {
        await this.execution.cancelAll("KILL_SWITCH_ACTIVE");
      }
      this.maybeEmitTickLog({
        marketsSeen: 0,
        activeWindows: 0,
        now: new Date(nowTs).toISOString(),
        currentMarketId: null,
        tauSec: null,
        priceToBeat: null,
        oracleEst: null,
        sigma: null,
        yesBid: null,
        yesAsk: null,
        yesMid: null,
        pUpModel: null,
        edge: null,
        threshold: null,
        action: "HOLD",
        holdReason: "TRADING_PAUSED",
        size: null,
        openTrades: this.paperLedger.getOpenTrades().length,
        resolvedTrades: this.paperLedger.getResolvedTrades().length,
        oracleSource: this.lastOracleSnapshot?.source ?? "none",
        oracleTs: this.lastOracleSnapshot?.rawTs ?? null,
        oracleStaleMs:
          this.lastOracleSnapshot && this.lastOracleSnapshot.rawTs > 0
            ? Math.max(0, nowTs - toMs(this.lastOracleSnapshot.rawTs))
            : null,
        oracleState: this.lastOracleSnapshot?.state ?? "INIT",
        selectedSlug: null,
        windowStart: null,
        windowEnd: null,
        acceptingOrders: null,
        enableOrderBook: null
      });
      return;
    }

    if (this.config.polymarket.mode === "paper" && this.isDeterministicBtc5mMode()) {
      await this.runPaperIntervalEngine(nowTs);
      return;
    }

    const paperMode = this.config.polymarket.mode === "paper";
    const deterministicBtc5mMode = this.isDeterministicBtc5mMode();
    const nowSec = Math.floor(nowTs / 1000);
    const epochStartSec = Math.floor(nowSec / FIVE_MIN_SEC) * FIVE_MIN_SEC;
    const slugNow = slugForTs(epochStartSec);
    const slugPrev = slugForTs(epochStartSec - FIVE_MIN_SEC);
    const attemptedSlugs = [slugNow, slugPrev];
    const sniperMinRemainingSec = Math.max(1, this.config.polymarket.paper.entryMinRemainingSec);
    const sniperMaxRemainingSec = Math.max(
      sniperMinRemainingSec,
      this.config.polymarket.paper.entryMaxRemainingSec
    );
    let selectedRawMarket: Record<string, unknown> | null = null;
    let resolvedSlug: string | null = null;
    if (deterministicBtc5mMode) {
      for (const slug of attemptedSlugs) {
        const row = await this.client.getActiveMarketBySlug(slug);
        if (row) {
          selectedRawMarket = row;
          resolvedSlug = slug;
          break;
        }
      }
    }
    let markets: BtcWindowMarket[] = [];
    let selectedMarket: BtcWindowMarket | null = null;
    let selectedSlug: string | null = resolvedSlug;
    let selectedWindowStart: number | null = null;
    let selectedWindowEnd: number | null = null;
    let selectedAcceptingOrders: boolean | null = null;
    let selectedEnableOrderBook: boolean | null = null;
    let selectedReason: string | null = "btc5m_slug_event";
    let selectedScore: number | null = null;
    let dominantReject: string | null = deterministicBtc5mMode ? "BTC5M_NOT_FOUND" : "OK";
    if (!selectedRawMarket) {
      this.selectedTokenIds = [];
      selectedReason = deterministicBtc5mMode ? "btc5m_not_found" : "no_market_selected";
      selectedSlug = null;
      if (deterministicBtc5mMode) {
        this.logger.warn({ tried: attemptedSlugs }, "POLY_BTC5M_NOT_FOUND");
      }
    } else {
      const tokenIds = parseRawStringArray(selectedRawMarket.clobTokenIds);
      this.selectedTokenIds = tokenIds;
      const resolvedWindowStartSec = parseBtc5mWindowStartSec(resolvedSlug) ?? windowTs(nowTs);
      const resolvedWindowEndSec = resolvedWindowStartSec + FIVE_MIN_SEC;
      const resolvedWindowStartMs = resolvedWindowStartSec * 1000;
      const resolvedWindowEndMs = resolvedWindowEndSec * 1000;
      const remainingSec = Math.floor((resolvedWindowEndMs - nowTs) / 1000);
      const parsed = parseRawMarketToBtcWindow(
        selectedRawMarket,
        nowTs,
        resolvedWindowEndMs,
        this.lastOracleSnapshot?.price ?? null
      );
      if (!parsed) {
        dominantReject = deterministicBtc5mMode ? "BTC5M_NOT_FOUND" : "market_parse_failed";
        selectedReason = "btc5m_parse_failed";
        selectedSlug = null;
        if (deterministicBtc5mMode) {
          this.logger.warn(
            {
              tried: attemptedSlugs,
              marketId:
                pickRawString(selectedRawMarket, ["id", "market_id", "conditionId", "condition_id"]) || null
            },
            "POLY_BTC5M_NOT_FOUND"
          );
        }
      } else {
        selectedSlug = resolvedSlug;
        const normalized = {
          ...parsed,
          startTs: resolvedWindowStartMs,
          endTs: resolvedWindowEndMs
        };
        selectedMarket = this.applyWindowState(normalized, nowTs);
        markets = [selectedMarket];
        selectedWindowStart = resolvedWindowStartMs;
        selectedWindowEnd = resolvedWindowEndMs;
        selectedAcceptingOrders = selectedMarket.acceptingOrders ?? null;
        selectedEnableOrderBook = selectedMarket.enableOrderBook ?? null;
        const slugGuardFailed = deterministicBtc5mMode && (!selectedSlug || !selectedSlug.startsWith("btc-updown-5m-"));
        const outsideSniperRange =
          deterministicBtc5mMode &&
          (remainingSec <= 0 ||
            remainingSec < sniperMinRemainingSec ||
            remainingSec > sniperMaxRemainingSec);
        if (slugGuardFailed) {
          dominantReject = "BTC5M_NOT_FOUND";
          selectedReason = "btc5m_slug_guard";
          this.selectedTokenIds = [];
          selectedMarket = null;
          markets = [];
          selectedSlug = null;
        } else if (outsideSniperRange) {
          dominantReject = remainingSec <= 0 ? "EXPIRED_WINDOW" : "window_outside_sniper_range";
          selectedReason = remainingSec <= 0 ? "btc5m_window_expired" : "btc5m_window_out_of_range";
          selectedMarket = null;
          markets = [];
          selectedSlug = null;
        } else {
          dominantReject = "OK";
          selectedReason = deterministicBtc5mMode ? "btc5m_deterministic_slug" : "market_selected";
          this.logger.info(
            { slug: selectedSlug, marketId: selectedMarket.marketId },
            "POLY_BTC5M_SELECTED"
          );
        }
      }
    }
    const forceSlug = "";
    const stageCounts = {
      fetchedCount: selectedRawMarket ? 1 : 0,
      afterActiveCount: selectedRawMarket ? 1 : 0,
      afterSearchCount: selectedRawMarket ? 1 : 0,
      afterWindowCount: selectedMarket ? 1 : 0,
      afterPatternCount: selectedMarket ? 1 : 0,
      finalCandidatesCount: selectedMarket ? 1 : 0
    };
    const discoveredCandidates = stageCounts.fetchedCount;
    const effectiveMinWindowSec = sniperMinRemainingSec;
    const effectiveMaxWindowSec = sniperMaxRemainingSec;
    const fallbackUsed: "none" | "window" | "patterns" | "topActive" = "none";
    const windowRejectCounters = createWindowRejectCounters();
    const rejectCountsByStage = createRejectCountsByStage();
    if (!selectedMarket) {
      addRejectCount(
        rejectCountsByStage,
        stageCounts.fetchedCount > 0 ? "window" : "search",
        dominantReject || "BTC5M_NOT_FOUND",
        1
      );
    }
    const sampleRejected: RejectSample[] = [];
    const deterministicWindowSamples: MarketScanWindowSample[] = selectedMarket
      ? [
          {
            marketId: selectedMarket.marketId,
            slug: selectedMarket.eventSlug || selectedMarket.slug || selectedMarket.marketId,
            windowStartField: "startTs",
            windowStartParseNote: "milliseconds",
            windowStartRaw: String(selectedMarket.startTs || ""),
            windowStartTsMs: toMs(selectedMarket.startTs),
            windowEndField: "endTs",
            windowEndParseNote: "milliseconds",
            windowEndRaw: String(selectedMarket.endTs || ""),
            windowEndTsMs: toMs(selectedMarket.endTs),
            nowTsMs: nowTs,
            remainingSec: Math.max(0, Math.floor((toMs(selectedMarket.endTs) - nowTs) / 1000)),
            passWindow: true
          }
        ]
      : [];
    this.polyState.fetchedCount = stageCounts.fetchedCount;
    this.polyState.afterWindowCount = stageCounts.afterWindowCount;
    this.polyState.finalCandidatesCount = stageCounts.finalCandidatesCount;
    this.polyState.selectedSlug = selectedSlug ?? null;
    this.polyState.selectedMarketId = selectedMarket?.marketId ?? null;
    const discoveryTickFields = {
      discoveredCandidates,
      fetchedCount: stageCounts.fetchedCount,
      afterActiveCount: stageCounts.afterActiveCount,
      afterSearchCount: stageCounts.afterSearchCount,
      afterWindowCount: stageCounts.afterWindowCount,
      afterPatternCount: stageCounts.afterPatternCount,
      finalCandidatesCount: stageCounts.finalCandidatesCount,
      fallbackUsed,
      selectedReason,
      selectedScore,
      rejectCountsByStage: cloneRejectCountsByStage(rejectCountsByStage),
      dominantReject,
      windowRejectCounters: { ...windowRejectCounters },
      windowReject: formatWindowRejectSummaryFromCounters(windowRejectCounters),
      minWindowSec: effectiveMinWindowSec,
      maxWindowSec: effectiveMaxWindowSec,
      acceptedSampleCount: deterministicWindowSamples.length,
      sampleRejected: sampleRejected.slice(0, 5)
    };
    let forceTradeFired = false;
    let forceTradeMode: "none" | "normal" | "smoke" = "none";
    const hasOpenPaperTrades = paperMode && this.paperLedger.getOpenTrades().length > 0;
    let oracleEst = 0;
    let oracleAgeMs = 0;
    let sigmaPricePerSqrtSec = 0;
    let sigmaPerSqrtSec = 0;
    let hydratedMarkets = markets.map((market) => this.applyWindowState(market, nowTs));
    if (selectedMarket && !hydratedMarkets.some((row) => row.marketId === selectedMarket?.marketId)) {
      hydratedMarkets = [selectedMarket, ...hydratedMarkets];
    }
    if (forceSlug.length > 0) {
      hydratedMarkets = hydratedMarkets.filter((market) => this.matchesForceSlug(market, forceSlug));
      if (selectedMarket && this.matchesForceSlug(selectedMarket, forceSlug)) {
        hydratedMarkets = [selectedMarket];
      }
    }

    this.pruneOldWindowState(nowTs);

    const shouldEstimateOracle =
      hydratedMarkets.length > 0 ||
      hasOpenPaperTrades ||
      (paperMode && this.config.polymarket.paper.forceTrade && Boolean(selectedMarket));
    let oracleState: OracleState | "IDLE" = "IDLE";
    let oracleSource = "none";
    let oracleTs: number | null = null;
    let oracleStaleMs: number | null = null;

    if (shouldEstimateOracle) {
      const oracle = await this.oracleRouter.getOracleNow(nowTs);
      const oracleRawTsMs = toMs(oracle.rawTs);
      this.lastOracleSnapshot = oracle;
      oracleState = oracle.state;
      oracleSource = oracle.source;
      oracleTs = oracleRawTsMs > 0 ? oracleRawTsMs : null;
      oracleStaleMs = Number.isFinite(oracle.staleMs) ? oracle.staleMs : null;
      const oracleUnavailable = oracleState === "ORACLE_STALE" || oracleState === "ORACLE_UNAVAILABLE";
      if (oracleUnavailable) {
        if (this.oracleStaleSinceTs === null) {
          this.oracleStaleSinceTs = nowTs;
        }
      } else {
        this.oracleStaleSinceTs = null;
      }

      if (oracle.price > 0 && oracleRawTsMs > 0) {
        oracleEst = oracle.price;
        this.volEstimator.update(oracle.price, oracleRawTsMs);
        this.recordOracleSample(oracle.price, oracleRawTsMs, oracle.source);
        const vol = this.volEstimator.getEstimate(oracle.price, nowTs);
        sigmaPricePerSqrtSec = vol.sigmaPricePerSqrtSec;
        sigmaPerSqrtSec = vol.sigmaPerSqrtSec;
        if (!(sigmaPricePerSqrtSec > 0) && oracle.fallbackSigmaPricePerSqrtSec > 0) {
          sigmaPricePerSqrtSec = oracle.fallbackSigmaPricePerSqrtSec;
          sigmaPerSqrtSec = oracleEst > 0 ? sigmaPricePerSqrtSec / oracleEst : 0;
        }
        oracleAgeMs = Math.max(0, nowTs - oracleRawTsMs);
      } else {
        oracleAgeMs = Number.POSITIVE_INFINITY;
      }

      if (selectedMarket) {
        selectedMarket = this.applyWindowState(selectedMarket, nowTs, oracleEst > 0 ? oracleEst : undefined);
      }
      hydratedMarkets = hydratedMarkets.map((market) =>
        this.applyWindowState(market, nowTs, oracleEst > 0 ? oracleEst : undefined)
      );
      await this.resolvePaperTrades(nowTs);

      if (oracleUnavailable) {
        const shouldPauseForOracle =
          this.config.polymarket.mode === "live" || oracleState === "ORACLE_UNAVAILABLE";
        if (shouldPauseForOracle) {
          this.setTradingPaused(true, oracleState, nowTs);
        } else if (
          this.tradingPaused &&
          (this.pauseReason === "ORACLE_STALE" || this.pauseReason === "ORACLE_UNAVAILABLE")
        ) {
          this.setTradingPaused(false, "PAPER_SOFT_ORACLE_STALE", nowTs);
        }
      } else if (
        oracleState === "OK" &&
        (this.pauseReason === "ORACLE_STALE" ||
          this.pauseReason === "ORACLE_UNAVAILABLE" ||
          this.pauseReason === "NETWORK_ERROR")
      ) {
        this.setTradingPaused(false, "ORACLE_RECOVERED", nowTs);
      }

      if (this.config.polymarket.mode === "live" && oracleUnavailable) {
        const staleDurationMs = this.oracleStaleSinceTs ? nowTs - this.oracleStaleSinceTs : 0;
        if (staleDurationMs >= this.config.polymarket.risk.staleKillAfterMs) {
          this.logger.error(
            {
              oracleState,
              oracleSource,
              oracleTs,
              oracleStaleMs,
              staleDurationMs,
              lastOraclePrice: oracleEst > 0 ? oracleEst : this.lastOracleSnapshot?.price ?? null
            },
            "STALE_ORACLE_FEED persisted in live mode: trading paused and continuing recovery loop"
          );
        } else {
          this.logger.warn(
            {
              oracleState,
              oracleSource,
              oracleTs,
              oracleStaleMs,
              staleDurationMs,
              staleKillAfterMs: this.config.polymarket.risk.staleKillAfterMs
            },
            "Transient oracle gap in live mode; blocking new entries and continuing"
          );
        }
        this.maybeEmitTickLog({
          marketsSeen: discoveredCandidates,
          ...discoveryTickFields,
          activeWindows: hydratedMarkets.length,
          now: new Date(nowTs).toISOString(),
          currentMarketId: hydratedMarkets[0]?.marketId ?? null,
          tauSec:
            hydratedMarkets[0]
              ? Math.max(0, Math.floor((toMs(hydratedMarkets[0].endTs) - nowTs) / 1000))
              : null,
          priceToBeat: hydratedMarkets[0]?.priceToBeat ?? null,
          oracleEst: oracleEst > 0 ? oracleEst : null,
          sigma: sigmaPricePerSqrtSec > 0 ? sigmaPricePerSqrtSec : null,
          yesBid: null,
          yesAsk: null,
          yesMid: null,
          pUpModel: null,
          edge: null,
          threshold: null,
          action: `HOLD:${oracleState}`,
          holdReason: normalizeHoldReason(oracleState),
          holdDetailReason: dominantReject,
          size: null,
          openTrades: this.paperLedger.getOpenTrades().length,
          resolvedTrades: this.paperLedger.getResolvedTrades().length,
          oracleSource,
          oracleTs,
          oracleStaleMs,
          oracleState,
          selectedSlug,
          windowStart: selectedWindowStart,
          windowEnd: selectedWindowEnd,
          acceptingOrders: selectedAcceptingOrders,
          enableOrderBook: selectedEnableOrderBook
        });
        return;
      }
    }

    forceTradeFired = false;
    forceTradeMode = "none";

    if (!shouldEstimateOracle && this.pauseReason === "NETWORK_ERROR") {
      this.setTradingPaused(false, "NETWORK_RECOVERED", nowTs);
    }

    if (hydratedMarkets.length === 0) {
      this.maybeEmitTickLog({
        marketsSeen: discoveredCandidates,
        ...discoveryTickFields,
        activeWindows: 0,
        now: new Date(nowTs).toISOString(),
        currentMarketId: selectedMarket?.marketId ?? null,
        tauSec:
          selectedMarket
            ? Math.max(0, Math.floor((toMs(selectedMarket.endTs) - nowTs) / 1000))
            : null,
        priceToBeat: selectedMarket && selectedMarket.priceToBeat > 0 ? selectedMarket.priceToBeat : null,
        oracleEst: oracleEst > 0 ? oracleEst : null,
        sigma: sigmaPricePerSqrtSec > 0 ? sigmaPricePerSqrtSec : null,
        yesBid: null,
        yesAsk: null,
        yesMid: null,
        pUpModel: null,
        edge: null,
        threshold: null,
        action:
          forceTradeFired && paperMode
            ? "FORCE_TRADE"
            : oracleState !== "OK" && oracleState !== "IDLE"
              ? `HOLD:${oracleState}`
              : "HOLD",
        holdReason:
          forceTradeFired && paperMode
            ? "FORCE_TRADE"
            : hydratedMarkets.length === 0
              ? this.paperLedger.getOpenTrades().length > 0
                ? "AWAITING_RESOLUTION"
                : dominantReject === "EXPIRED_WINDOW"
                  ? "EXPIRED_WINDOW"
                  : dominantReject === "BTC5M_NOT_FOUND"
                    ? "NO_ACTIVE_BTC5M_MARKET"
                    : "NO_WINDOWS"
              : normalizeHoldReason(oracleState),
        holdDetailReason: dominantReject,
        forceTradeFired,
        forceTradeMode,
        size: null,
        openTrades: this.paperLedger.getOpenTrades().length,
        resolvedTrades: this.paperLedger.getResolvedTrades().length,
        oracleSource,
        oracleTs,
        oracleStaleMs,
        oracleState,
        selectedSlug,
        windowStart: selectedWindowStart,
        windowEnd: selectedWindowEnd,
        acceptingOrders: selectedAcceptingOrders,
        enableOrderBook: selectedEnableOrderBook
      });
      return;
    }

    if (shouldEstimateOracle && !(oracleEst > 0)) {
      this.maybeEmitTickLog({
        marketsSeen: discoveredCandidates,
        ...discoveryTickFields,
        activeWindows: hydratedMarkets.length,
        now: new Date(nowTs).toISOString(),
        currentMarketId: hydratedMarkets[0]?.marketId ?? null,
        tauSec:
          hydratedMarkets[0]
            ? Math.max(0, Math.floor((toMs(hydratedMarkets[0].endTs) - nowTs) / 1000))
            : null,
        priceToBeat: hydratedMarkets[0]?.priceToBeat ?? null,
        oracleEst: null,
        sigma: null,
        yesBid: null,
        yesAsk: null,
        yesMid: null,
        pUpModel: null,
        edge: null,
        threshold: null,
        action: `HOLD:${oracleState}`,
        holdReason: normalizeHoldReason(oracleState),
        holdDetailReason: dominantReject,
        size: null,
        openTrades: this.paperLedger.getOpenTrades().length,
        resolvedTrades: this.paperLedger.getResolvedTrades().length,
        oracleSource,
        oracleTs,
        oracleStaleMs,
        oracleState,
        selectedSlug,
        windowStart: selectedWindowStart,
        windowEnd: selectedWindowEnd,
        acceptingOrders: selectedAcceptingOrders,
        enableOrderBook: selectedEnableOrderBook
      });
      return;
    }

    let tickLog: TickLogLine = {
      marketsSeen: discoveredCandidates,
      ...discoveryTickFields,
      activeWindows: hydratedMarkets.length,
      now: new Date(nowTs).toISOString(),
      currentMarketId: hydratedMarkets[0]?.marketId ?? null,
      tauSec:
        hydratedMarkets[0]
          ? Math.max(0, Math.floor((toMs(hydratedMarkets[0].endTs) - nowTs) / 1000))
          : null,
      priceToBeat: hydratedMarkets[0]?.priceToBeat ?? null,
      oracleEst: oracleEst > 0 ? oracleEst : null,
      sigma: sigmaPricePerSqrtSec > 0 ? sigmaPricePerSqrtSec : null,
      yesBid: null,
      yesAsk: null,
      yesMid: null,
      pUpModel: null,
      edge: null,
      threshold: null,
      action: "HOLD",
      holdReason: null,
      holdDetailReason: dominantReject,
      forceTradeFired,
      forceTradeMode,
      size: null,
      openTrades: this.paperLedger.getOpenTrades().length,
      resolvedTrades: this.paperLedger.getResolvedTrades().length,
      oracleSource,
      oracleTs,
      oracleStaleMs,
      oracleState,
      selectedSlug,
      windowStart: selectedWindowStart,
      windowEnd: selectedWindowEnd,
      acceptingOrders: selectedAcceptingOrders,
      enableOrderBook: selectedEnableOrderBook
    };
    const fastMidSnapshot = this.oracleRouter.getFastMidNow(nowTs);
    const fastMidNow =
      fastMidSnapshot && fastMidSnapshot.price > 0
        ? fastMidSnapshot.price
        : oracleEst > 0
          ? oracleEst
          : 0;
    const lagStatsSnapshot = this.lagProfiler.getStats();
    const lagPolyP90Ms = lagStatsSnapshot.metrics.polyUpdateAgeMs.p90;
    const shortReturn = this.computeShortReturn(nowTs, 45);
    const realizedVolPricePerSqrtSec = this.computeRealizedVolPricePerSqrtSec(
      nowTs,
      fastMidNow > 0 ? fastMidNow : oracleEst,
      sigmaPricePerSqrtSec,
      300
    );
    const addRejectedSample = (
      stage: RejectStage,
      reason: string,
      market: { marketId: string; eventSlug?: string; slug?: string } | null
    ): void => {
      if (sampleRejected.length >= 5) return;
      sampleRejected.push({
        stage,
        reason,
        marketId: market?.marketId,
        slug: market?.eventSlug || market?.slug
      });
    };

    for (const market of hydratedMarkets) {
      const marketEndMs = toMs(market.endTs);
      const tauSec = Math.max(0, Math.floor((marketEndMs - nowTs) / 1000));
      if (tauSec <= 0) {
        addRejectCount(rejectCountsByStage, "window", "countdown_out_of_range", 1);
        addRejectedSample("window", "countdown_out_of_range", market);
        continue;
      }
      if (!(market.priceToBeat > 0)) {
        addRejectCount(rejectCountsByStage, "scoring", "missing_price_to_beat", 1);
        addRejectedSample("scoring", "missing_price_to_beat", market);
        continue;
      }

      const windowStartTs =
        market.startTs ??
        Math.max(0, market.endTs - this.config.polymarket.marketQuery.cadenceMinutes * 60_000);
      const elapsedSec = Math.max(0, Math.floor((nowTs - windowStartTs) / 1000));
      const remainingSec = tauSec;

      const implied = await this.getImpliedYesBook(market, {
        isSelectedMarket: selectedMarket?.marketId === market.marketId,
        remainingSec
      });
      this.polyState.lastBookTsMs = Math.max(this.polyState.lastBookTsMs, Math.floor(implied.bookTs));
      this.polyState.lastYesBid = Number.isFinite(implied.yesBid) ? implied.yesBid : null;
      this.polyState.lastYesAsk = Number.isFinite(implied.yesAsk) ? implied.yesAsk : null;
      this.polyState.lastYesMid = Number.isFinite(implied.yesMid) ? implied.yesMid : null;
      this.polyState.latestPolymarketTs = Math.max(
        Number(this.polyState.latestPolymarketTs || 0),
        Math.floor(implied.bookTs || nowTs)
      );
      if (
        !(implied.yesBid >= 0) ||
        !(implied.yesAsk >= 0) ||
        !(implied.yesMid >= 0) ||
        !Number.isFinite(implied.yesBid) ||
        !Number.isFinite(implied.yesAsk) ||
        !Number.isFinite(implied.yesMid)
      ) {
        addRejectCount(rejectCountsByStage, "dataHealth", "missing_yes_book", 1);
        addRejectedSample("dataHealth", "missing_yes_book", market);
        this.lagProfiler.record({
          tsMs: nowTs,
          windowSlug: market.eventSlug || market.slug || market.marketId,
          tauSec,
          priceToBeat: market.priceToBeat,
          fastMid: fastMidNow > 0 ? fastMidNow : null,
          oraclePrice: oracleEst > 0 ? oracleEst : null,
          oracleUpdatedAtMs: oracleTs ?? null,
          yesBid: this.polyState.lastYesBid,
          yesAsk: this.polyState.lastYesAsk,
          yesMid: this.polyState.lastYesMid,
          impliedProbMid: this.polyState.lastYesMid
        });
        continue;
      }
      const orderBook = {
        marketId: market.marketId,
        tokenId: market.yesTokenId,
        yesBid: implied.yesBid,
        yesAsk: implied.yesAsk,
        yesMid: implied.yesMid,
        spread: implied.spread,
        bids: [],
        asks: [],
        ts: nowTs
      };
      const prob = this.probModel.computeAdaptive({
        oracleEst: fastMidNow > 0 ? fastMidNow : oracleEst,
        priceToBeat: market.priceToBeat,
        tauSec,
        cadenceSec: this.config.polymarket.marketQuery.cadenceMinutes * 60,
        shortReturn,
        realizedVolPricePerSqrtSec
      });
      if (!Number.isFinite(prob.pUpModel)) {
        addRejectCount(rejectCountsByStage, "dataHealth", "missing_model_pup", 1);
        addRejectedSample("dataHealth", "missing_model_pup", market);
        this.lagProfiler.record({
          tsMs: nowTs,
          windowSlug: market.eventSlug || market.slug || market.marketId,
          tauSec,
          priceToBeat: market.priceToBeat,
          fastMid: fastMidNow > 0 ? fastMidNow : null,
          oraclePrice: oracleEst > 0 ? oracleEst : null,
          oracleUpdatedAtMs: oracleTs ?? null,
          yesBid: implied.yesBid,
          yesAsk: implied.yesAsk,
          yesMid: implied.yesMid,
          impliedProbMid: implied.yesMid
        });
        continue;
      }
      const polyUpdateAgeMs = implied.bookTs > 0 ? Math.max(0, nowTs - implied.bookTs) : 0;
      if (polyUpdateAgeMs > this.config.polymarket.risk.staleMs) {
        addRejectCount(rejectCountsByStage, "dataHealth", "stale_book", 1);
        addRejectedSample("dataHealth", "stale_book", market);
      }
      const calibrated = this.probModel.computeExpiryProbCalibrated({
        fastMid: fastMidNow > 0 ? fastMidNow : oracleEst,
        priceToBeat: market.priceToBeat,
        sigmaPricePerSqrtSec,
        tauSec,
        polyUpdateAgeMs,
        lagPolyP90Ms,
        oracleAgeMs: oracleAgeMs > 0 && Number.isFinite(oracleAgeMs) ? oracleAgeMs : 0
      });
      const pForExtreme = calibrated.pBoosted;

      const decision = this.strategy.decide({
        pUpModel: prob.pUpModel,
        orderBook,
        sigmaPerSqrtSec,
        tauSec
      });
      let noAsk = estimateNoAskFromYesBook(decision.yesBid);
      let noTopAskSize = 0;
      if (market.noTokenId) {
        const noQuote = await this.getNoAskAndDepthFromTokenId(market.noTokenId, noAsk);
        noAsk = noQuote.noAsk;
        noTopAskSize = noQuote.topAskSize;
      }
      const yesEntryPrice = decision.yesAsk > 0 ? decision.yesAsk : decision.yesMid;
      const noEntryPrice = noAsk > 0 ? noAsk : estimateNoAskFromYesBook(decision.yesBid);
      const feeBps = this.config.polymarket.paper.feeBps;
      const slippageBps = this.config.polymarket.paper.slippageBps;
      const spreadProxy = Math.max(0, decision.spread) / 2;
      const costPenaltyProb = Math.max(0, feeBps + slippageBps) / 10_000 + spreadProxy;
      const edgeYes = prob.pUpModel - yesEntryPrice;
      const edgeNo = (1 - prob.pUpModel) - noEntryPrice;
      const netEdgeYes = edgeYes - costPenaltyProb;
      const netEdgeNo = edgeNo - costPenaltyProb;
      const stalenessEdge = this.computeStalenessEdge(market.marketId, decision.yesMid, oracleEst, nowTs);
      const convictionBase = Math.abs(prob.pUpModel - decision.yesMid);
      const conviction = clamp(convictionBase + stalenessEdge, 0, 0.9999);
      const chosenSide: "YES" | "NO" = netEdgeYes >= netEdgeNo ? "YES" : "NO";
      const chosenEdge = chosenSide === "YES" ? edgeYes : edgeNo;
      const netEdgeAfterCosts = chosenSide === "YES" ? netEdgeYes : netEdgeNo;
      const signedEdge = chosenSide === "YES" ? edgeYes : -edgeNo;
      const chosenAsk = chosenSide === "YES" ? yesEntryPrice : noEntryPrice;
      const extremeLow = this.config.polymarket.paper.extremeLowPrice;
      const extremeHigh = this.config.polymarket.paper.extremeHighPrice;
      const isExtremePrice = chosenAsk <= extremeLow || chosenAsk >= extremeHigh;
      const probExtreme = this.config.polymarket.paper.probExtreme;
      const hasExtremeModel =
        chosenSide === "YES"
          ? pForExtreme >= probExtreme
          : pForExtreme <= 1 - probExtreme;
      const inSnipingWindow =
        remainingSec <= this.config.polymarket.paper.entryMaxRemainingSec &&
        remainingSec >= this.config.polymarket.paper.entryMinRemainingSec;
      const minEdgeThreshold = this.config.polymarket.paper.minEdgeThreshold;
      const minNetEdgeThreshold = this.config.polymarket.paper.minNetEdge;
      const minNetEdge = Math.max(
        minNetEdgeThreshold,
        minEdgeThreshold
      );
      const forceTrade = paperMode && this.config.polymarket.paper.forceTrade;
      const paperSoftOracleStaleAllowed =
        paperMode &&
        oracleState === "ORACLE_STALE" &&
        polyUpdateAgeMs <= this.config.polymarket.risk.staleMs;
      const bypassBaseAndSpreadChecks = forceTrade;
      const requiredNetEdge = forceTrade
        ? Number.NEGATIVE_INFINITY
        : Math.max(minNetEdge, decision.threshold);
      const decisionAction =
        netEdgeAfterCosts > requiredNetEdge
          ? chosenSide === "YES"
            ? "BUY_YES"
            : "BUY_NO"
          : "HOLD";

      this.lagProfiler.record({
        tsMs: nowTs,
        windowSlug: market.eventSlug || market.slug || market.marketId,
        tauSec,
        priceToBeat: market.priceToBeat,
        fastMid: fastMidNow > 0 ? fastMidNow : null,
        oraclePrice: oracleEst > 0 ? oracleEst : null,
        oracleUpdatedAtMs: oracleTs ?? null,
        yesBid: implied.yesBid,
        yesAsk: implied.yesAsk,
        yesMid: implied.yesMid,
        impliedProbMid: implied.yesMid,
        pModel: prob.pUpModel,
        absProbGap: Math.abs(prob.pUpModel - implied.yesMid)
      });

      this.latestPolymarketSnapshot = {
        ts: nowTs,
        windowSlug: market.eventSlug || market.slug || market.marketId,
        tauSec,
        priceToBeat: market.priceToBeat,
        fastMid: fastMidNow > 0 ? fastMidNow : null,
        yesMid: implied.yesMid,
        impliedProbMid: implied.yesMid
      };
      this.latestModelSnapshot = {
        ts: nowTs,
        pBase: calibrated.pBase,
        pBoosted: calibrated.pBoosted,
        z: calibrated.z,
        d: calibrated.d,
        sigma: calibrated.sigma,
        tauSec: calibrated.tauSec,
        polyUpdateAgeMs: calibrated.polyUpdateAgeMs,
        lagPolyP90Ms: calibrated.lagPolyP90Ms,
        oracleAgeMs: calibrated.oracleAgeMs,
        boostApplied: calibrated.boostApplied,
        boostReason: calibrated.boostReason
      };
      this.polyState.lastModelTs = nowTs;

      if (paperMode) {
        await this.managePaperOpenPositions({
          nowTs,
          market,
          implied,
          edgeYes,
          edgeNo,
          costPenaltyProb,
          remainingSec
        });
      }

      const openOrderCount = paperMode ? 0 : this.execution.getOpenOrderCount();
      const totalExposureUsd = paperMode
        ? this.paperLedger.getOpenTrades().reduce((sum, row) => sum + row.entryCostUsd + row.feesUsd, 0)
        : this.execution.getTotalExposureUsd();
      const concurrentWindows = paperMode
        ? new Set(this.paperLedger.getOpenTrades().map((row) => row.marketId)).size
        : this.execution.getConcurrentWindows();
      const paperOpenNotional = this.paperLedger.getOpenNotionalForMarket(market.marketId);
      const livePositions = this.execution.getPositions();
      const liveExistingPositionCost = livePositions
        .filter((row) => row.marketId === market.marketId)
        .reduce((sum, row) => sum + Math.max(0, row.costUsd), 0);
      const liveWindowBudget = Math.max(
        0,
        this.config.polymarket.sizing.maxNotionalPerWindow - liveExistingPositionCost
      );
      const paperWindowBudget = Math.max(
        0,
        this.config.polymarket.paper.maxNotionalPerWindow - paperOpenNotional
      );
      const remainingWindowBudget = paperMode
        ? Math.min(liveWindowBudget, paperWindowBudget)
        : liveWindowBudget;
      const remainingExposureBudget = Math.max(0, this.config.polymarket.risk.maxExposure - totalExposureUsd);
      const desiredSide = chosenSide;
      const sidePrice = desiredSide === "YES" ? decision.yesAsk : noAsk;
      const sideProb = desiredSide === "YES" ? prob.pUpModel : 1 - prob.pUpModel;
      const topAskDepthShares = desiredSide === "YES" ? implied.topAskSize : noTopAskSize;
      const depthCapNotionalUsd =
        topAskDepthShares > 0
          ? topAskDepthShares * Math.max(0.0001, sidePrice) * 0.35
          : 0;
      const size = this.sizing.compute({
        edge: Math.max(0, netEdgeAfterCosts),
        pUpModel: sideProb,
        yesAsk: sidePrice,
        conviction,
        remainingSec,
        entryMaxRemainingSec: this.config.polymarket.paper.entryMaxRemainingSec,
        depthCapNotionalUsd,
        remainingWindowBudget,
        remainingExposureBudget,
        remainingDailyLossBudget: this.risk.getRemainingDailyLossBudget()
      });

      let action = decisionAction;
      let executedSize = size.notionalUsd;
      let canAttemptTrade = (decisionAction === "BUY_YES" || decisionAction === "BUY_NO") && size.notionalUsd > 0;
      let blockReason = "";

      if (!(decision.yesBid > 0) || !(decision.yesAsk > 0)) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "MISSING_BBO";
      }
      if (decision.yesAsk < decision.yesBid) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "CROSSED_BBO";
      }
      if (!bypassBaseAndSpreadChecks && decision.spread > this.config.polymarket.threshold.maxSpread) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "SPREAD_TOO_WIDE";
      }
      if (decision.yesMid < 0.001 || decision.yesMid > 0.999) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "YES_MID_OUT_OF_RANGE";
      }
      if (
        paperMode &&
        oracleState !== "OK" &&
        !(oracleState === "ORACLE_STALE" && paperSoftOracleStaleAllowed)
      ) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason =
          oracleState === "ORACLE_STALE" && polyUpdateAgeMs > this.config.polymarket.risk.staleMs
            ? "ORACLE_STALE_BOOK_STALE"
            : oracleState;
      }
      if (
        paperMode &&
        !forceTrade &&
        netEdgeAfterCosts < this.config.polymarket.paper.minEdgeThreshold
      ) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "NET_EDGE_BELOW_PAPER_MIN";
      }
      if (!forceTrade && !(netEdgeAfterCosts > minNetEdge)) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "NET_EDGE_BELOW_MIN_NET_EDGE";
      }
      if (!inSnipingWindow) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "OUTSIDE_SNIPING_WINDOW";
      }
      if (!isExtremePrice) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "NON_EXTREME_PRICE";
      }
      if (!hasExtremeModel) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "MODEL_NOT_EXTREME";
      }
      if (remainingSec < this.config.polymarket.risk.noNewOrdersInLastSec) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "NO_NEW_ORDERS_FINAL_SECONDS";
      }
      if (paperMode && !this.config.polymarket.paper.allowMultipleTradesPerWindow) {
        const windowTrades = this.paperLedger.getTradesForWindow(
          market.marketId,
          windowStartTs,
          toMs(market.endTs)
        );
        const openWindowTrade = windowTrades.find((row) => !row.resolvedAt);
        if (openWindowTrade) {
          action = "HOLD";
          executedSize = 0;
          canAttemptTrade = false;
          blockReason = "WINDOW_ALREADY_OPEN";
        } else if (windowTrades.length > 0) {
          action = "HOLD";
          executedSize = 0;
          canAttemptTrade = false;
          blockReason = "WINDOW_ALREADY_TRADED";
        }
      }
      if (this.tradingPaused) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = this.pauseReason ? `TRADING_PAUSED_${this.pauseReason}` : "TRADING_PAUSED";
      }

      if (canAttemptTrade) {
        if (this.config.polymarket.killSwitch) {
          action = "HOLD";
          executedSize = 0;
          blockReason = "KILL_SWITCH";
        } else {
          if (paperSoftOracleStaleAllowed) {
            this.logger.warn(
              {
                marketId: market.marketId,
                slug: market.eventSlug || market.slug || null,
                oracleState,
                oracleSource,
                oracleTs,
                oracleStaleMs,
                polyUpdateAgeMs
              },
              "Paper mode allowing entry despite ORACLE_STALE because the selected BTC5m book is fresh"
            );
          }
          const check = this.risk.checkNewOrder({
            tauSec,
            oracleAgeMs,
            projectedOrderNotionalUsd: size.notionalUsd,
            openOrders: openOrderCount,
            totalExposureUsd,
            concurrentWindows
          });

          if (!check.ok) {
            action = "HOLD";
            executedSize = 0;
            if (
              check.reason?.startsWith("KILL_SWITCH") &&
              this.config.polymarket.mode === "live" &&
              this.canMutateVenueState()
            ) {
              await this.execution.cancelAll(check.reason);
            }
            blockReason = check.reason || "RISK_BLOCKED";
          } else if (paperMode) {
            const result = await this.paperExecutionAdapter.executeEntry({
              side: desiredSide,
              execute: () =>
                this.executePaperTrade({
                  marketId: market.marketId,
                  marketSlug: market.eventSlug || market.slug,
                  windowStartTs,
                  windowEndTs: market.endTs,
                  priceToBeat: market.priceToBeat,
                  side: desiredSide,
                  yesTokenId: market.yesTokenId,
                  noTokenId: market.noTokenId,
                  yesBid: decision.yesBid,
                  yesAsk: decision.yesAsk,
                  noAsk,
                  edge: netEdgeAfterCosts,
                  pBase: calibrated.pBase,
                  pBoosted: calibrated.pBoosted,
                  boostApplied: calibrated.boostApplied,
                  boostReason: calibrated.boostReason,
                  requestedNotionalUsd: size.notionalUsd,
                  ts: nowTs
                })
            });
            action = result.accepted ? (decisionAction === "BUY_NO" ? "BUY_NO" : "BUY_YES") : "HOLD";
            executedSize = result.accepted ? size.notionalUsd : 0;
            if (!result.accepted) {
              blockReason = "PAPER_TRADE_REJECTED";
            }
          } else {
            const liveTradeId = `live-${nowTs}-${market.marketId}-${desiredSide.toLowerCase()}`;
            const liveTokenId =
              desiredSide === "YES" ? market.yesTokenId : String(market.noTokenId || "").trim();
            const direction = this.getPaperDirectionLabel({
              side: desiredSide,
              marketQuestion: market.question
            });
            const liveOrderIntent = {
              tradeId: liveTradeId,
              marketId: market.marketId,
              marketSlug: market.eventSlug || market.slug || null,
              side: desiredSide,
              direction,
              tokenId: liveTokenId || null,
              contractPrice: sidePrice,
              btcReferencePrice: fastMidNow > 0 ? fastMidNow : oracleEst,
              notionalUsd: size.notionalUsd,
              shares: sidePrice > 0 ? size.notionalUsd / Math.max(0.0001, sidePrice) : 0
            };
            this.logger.info(
              {
                ...liveOrderIntent,
                reason: "ENTRY_SIGNAL"
              },
              "POLY_LIVE_INTENT"
            );
            if (!liveTokenId) {
              action = "HOLD";
              executedSize = 0;
              blockReason = "LIVE_TOKEN_UNAVAILABLE";
              this.logger.warn({ ...liveOrderIntent, reason: blockReason }, "POLY_LIVE_REJECT");
            } else if (!this.canMutateVenueState()) {
              action = "HOLD";
              executedSize = 0;
              blockReason = "LIVE_EXECUTION_NOT_ARMED";
              this.logger.warn(
                {
                  ...liveOrderIntent,
                  killSwitch: this.config.polymarket.killSwitch,
                  liveConfirmed: this.config.polymarket.liveConfirmed,
                  liveExecutionEnabled: this.config.polymarket.liveExecutionEnabled,
                  reason: blockReason
                },
                "POLY_LIVE_REJECT"
              );
            } else {
              const result = await this.liveExecutionAdapter.executeEntry({
                marketId: market.marketId,
                tokenId: liveTokenId,
                side: desiredSide,
                contractPrice: sidePrice,
                notionalUsd: size.notionalUsd,
                tickSize: market.tickSize,
                negRisk: market.negRisk
              });
              action = result.accepted ? decisionAction : "HOLD";
              executedSize = result.accepted ? size.notionalUsd : 0;
              if (!result.accepted) {
                blockReason = result.reason || "LIVE_REJECTED";
                this.logger.warn(
                  {
                    ...liveOrderIntent,
                    reason: blockReason
                  },
                  "POLY_LIVE_REJECT"
                );
              } else {
                this.logger.info(
                  {
                    ...liveOrderIntent,
                    orderId: result.orderId || null,
                    fillPrice: result.fillPrice ?? sidePrice,
                    filledShares: result.filledShares,
                    reason: result.reason || "LIVE_FILLED_OR_PARTIAL"
                  },
                  "POLY_LIVE_ORDER_OPEN"
                );
                this.emitPolymarketTruth({
                  ts: nowTs,
                  action: "OPEN",
                  tradeId: liveTradeId,
                  slug: market.eventSlug || market.slug || null
                });
              }
            }
          }
        }
      } else {
        action = "HOLD";
        executedSize = 0;
      }
      if (action === "HOLD" && !blockReason) {
        if (decisionAction === "HOLD") {
          if (!forceTrade && !(netEdgeAfterCosts > minNetEdge)) {
            blockReason = "NET_EDGE_BELOW_MIN_NET_EDGE";
          } else if (netEdgeAfterCosts <= decision.threshold) {
            blockReason = "NET_EDGE_BELOW_DYNAMIC_THRESHOLD";
          } else {
            blockReason = "EDGE_BELOW_THRESHOLD";
          }
        } else if (!(size.notionalUsd > 0)) {
          blockReason = "SIZE_BELOW_MIN_NOTIONAL";
        } else {
          blockReason = "HOLD_UNSPECIFIED";
        }
      }
      if (action === "HOLD" && blockReason) {
        const classified = classifyRejectReason(blockReason);
        addRejectCount(rejectCountsByStage, classified.stage, classified.reason, 1);
        addRejectedSample(classified.stage, classified.reason, market);
      }
      dominantReject = computeDominantReject(rejectCountsByStage);

      const openTradesCount = this.paperLedger.getOpenTrades().length;
      const resolvedTradesCount = this.paperLedger.getResolvedTrades().length;
      tickLog = {
        marketsSeen: discoveredCandidates,
        ...discoveryTickFields,
        rejectCountsByStage: cloneRejectCountsByStage(rejectCountsByStage),
        dominantReject,
        sampleRejected: sampleRejected.slice(0, 5),
        activeWindows: hydratedMarkets.length,
        now: new Date(nowTs).toISOString(),
        currentMarketId: market.marketId,
        tauSec,
        priceToBeat: market.priceToBeat,
        oracleEst,
        sigma: sigmaPricePerSqrtSec,
        yesBid: decision.yesBid,
        yesAsk: decision.yesAsk,
        yesMid: decision.yesMid,
        pUpModel: prob.pUpModel,
        pBase: calibrated.pBase,
        pBoosted: calibrated.pBoosted,
        z: calibrated.z,
        d: calibrated.d,
        sigmaCalibrated: calibrated.sigma,
        polyUpdateAgeMs: calibrated.polyUpdateAgeMs,
        lagPolyP90Ms: calibrated.lagPolyP90Ms,
        boostApplied: calibrated.boostApplied,
        boostReason: calibrated.boostReason,
        edge: signedEdge,
        edgeYes,
        edgeNo,
        chosenSide,
        chosenEdge,
        conviction,
        stalenessEdge,
        netEdgeAfterCosts,
        threshold: decision.threshold,
        action,
        holdReason: null,
        holdDetailReason: action === "HOLD" ? blockReason || dominantReject : null,
        size: executedSize,
        openTrades: openTradesCount,
        resolvedTrades: resolvedTradesCount,
        oracleSource,
        oracleTs,
        oracleStaleMs,
        oracleState,
        selectedSlug,
        windowStart: selectedWindowStart,
        windowEnd: selectedWindowEnd,
        acceptingOrders: selectedAcceptingOrders,
        enableOrderBook: selectedEnableOrderBook,
        tradingPaused: this.tradingPaused,
        pauseReason: this.pauseReason || null,
        pauseSinceTs: this.pauseSinceTs
      };
      const holdReason = this.deriveCanonicalHoldReason(tickLog);
      tickLog.holdReason = holdReason;

      this.writeDecisionLog({
        ts: new Date(nowTs).toISOString(),
        marketId: market.marketId,
        slug: market.eventSlug || market.slug || selectedSlug || undefined,
        selectedSlug: selectedSlug || null,
        candidatesCount: discoveredCandidates,
        windowsCount: stageCounts.afterWindowCount,
        tauSec,
        remainingSec,
        priceToBeat: market.priceToBeat,
        oracleEst,
        sigma: sigmaPricePerSqrtSec,
        pUpModel: prob.pUpModel,
        pBase: calibrated.pBase,
        pBoosted: calibrated.pBoosted,
        z: calibrated.z,
        d: calibrated.d,
        sigmaCalibrated: calibrated.sigma,
        polyUpdateAgeMs: calibrated.polyUpdateAgeMs,
        lagPolyP90Ms: calibrated.lagPolyP90Ms,
        boostApplied: calibrated.boostApplied,
        boostReason: calibrated.boostReason,
        yesBid: decision.yesBid,
        yesAsk: decision.yesAsk,
        yesMid: decision.yesMid,
        edge: signedEdge,
        edgeYes,
        edgeNo,
        chosenSide,
        grossEdge: chosenEdge,
        chosenEdge,
        conviction,
        stalenessEdge,
        netEdgeAfterCosts,
        minEdgeThreshold,
        minNetEdgeThreshold,
        threshold: decision.threshold,
        action: blockReason ? `${action}:${blockReason}` : action,
        holdReason: holdReason || undefined,
        holdDetailReason: action === "HOLD" ? (blockReason || dominantReject || undefined) : undefined,
        size: executedSize,
        mode: this.config.polymarket.mode,
        openTrades: openTradesCount,
        resolvedTrades: resolvedTradesCount,
        oracleSource,
        oracleTs: oracleTs ?? undefined,
        oracleStaleMs: oracleStaleMs ?? undefined,
        oracleState: oracleState !== "IDLE" ? oracleState : undefined,
        tradingPaused: this.tradingPaused,
        pauseReason: this.pauseReason || undefined,
        pauseSinceTs: this.pauseSinceTs ?? undefined
      });
    }

    const riskSnapshot = this.risk.snapshot({
      openOrders: this.config.polymarket.mode === "paper" ? 0 : this.execution.getOpenOrderCount(),
      totalExposureUsd:
        this.config.polymarket.mode === "paper"
          ? this.paperLedger.getOpenTrades().reduce((sum, row) => sum + row.entryCostUsd + row.feesUsd, 0)
          : this.execution.getTotalExposureUsd(),
      concurrentWindows:
        this.config.polymarket.mode === "paper"
          ? new Set(this.paperLedger.getOpenTrades().map((row) => row.marketId)).size
          : this.execution.getConcurrentWindows()
    });

    if (forceTradeFired) {
      tickLog.action = "FORCE_TRADE";
      tickLog.holdReason = "FORCE_TRADE";
      tickLog.forceTradeFired = true;
      tickLog.forceTradeMode = forceTradeMode;
    }
    this.maybeEmitTickLog(tickLog);

    if (riskSnapshot.totalExposureUsd >= this.config.polymarket.risk.maxExposure) {
      if (!this.risk.isKillSwitchActive()) {
        this.risk.triggerKillSwitch("MAX_EXPOSURE_REACHED");
      }
      if (this.config.polymarket.mode === "live" && this.canMutateVenueState()) {
        await this.execution.cancelAll("MAX_EXPOSURE_REACHED");
      }
      this.logger.error(
        {
          totalExposureUsd: riskSnapshot.totalExposureUsd,
          maxExposure: this.config.polymarket.risk.maxExposure
        },
        "Polymarket max exposure reached; kill-switch active but engine loop will continue in HOLD"
      );
    }
  }

  private executePaperTrade(params: {
    marketId: string;
    marketSlug?: string;
    marketQuestion?: string;
    referenceSymbol?: string;
    windowStartTs: number;
    windowEndTs: number;
    priceToBeat: number;
    referencePriceAtEntry?: number;
    side: "YES" | "NO";
    yesTokenId: string;
    noTokenId?: string;
    yesDisplayLabel?: string;
    noDisplayLabel?: string;
    yesBid: number;
    yesAsk: number;
    noAsk?: number;
    edge: number;
    pBase?: number;
    pBoosted?: number;
    boostApplied?: boolean;
    boostReason?: string;
    requestedNotionalUsd: number;
    ts: number;
    forced?: boolean;
  }): boolean {
    const tradesLastHour = this.paperLedger.countTradesSince(params.ts - 60 * 60 * 1000);
    if (tradesLastHour >= this.config.polymarket.paper.maxTradesPerHour) {
      return false;
    }

    const openNotional = this.paperLedger.getOpenNotionalForMarket(params.marketId);
    const remainingWindowNotional = Math.max(
      0,
      this.config.polymarket.paper.maxNotionalPerWindow - openNotional
    );
    const notionalUsd = Math.min(params.requestedNotionalUsd, remainingWindowNotional);
    if (!(notionalUsd > 0)) {
      return false;
    }

    const yesTokenId = String(params.yesTokenId || "").trim();
    const noTokenId = String(params.noTokenId || "").trim();
    if (!yesTokenId || !noTokenId || yesTokenId === noTokenId) {
      this.logger.warn(
        {
          marketId: params.marketId,
          marketSlug: params.marketSlug || null,
          side: params.side,
          yesTokenId: yesTokenId || null,
          noTokenId: noTokenId || null
        },
        "Polymarket paper trade rejected: ambiguous YES/NO token mapping"
      );
      return false;
    }
    const heldTokenId = params.side === "YES" ? yesTokenId : noTokenId;
    if (!heldTokenId) {
      return false;
    }

    const noAsk = params.noAsk && params.noAsk > 0 ? params.noAsk : estimateNoAskFromYesBook(params.yesBid);
    const noBid = estimateNoBidFromYesBook(params.yesAsk);
    const yesMid = clamp((params.yesBid + params.yesAsk) / 2, params.yesBid, params.yesAsk);
    const noMid = clamp((noBid + noAsk) / 2, noBid, noAsk);
    const takerEdgeTrigger = Math.max(this.config.polymarket.paper.minEdgeThreshold * 2, 0.05);
    const useTakerEntry = Boolean(params.forced) || params.edge >= takerEdgeTrigger;
    const rawEntryPrice =
      params.side === "YES"
        ? useTakerEntry
          ? params.yesAsk
          : yesMid
        : useTakerEntry
          ? noAsk
          : noMid;
    const effectiveSlippageBps = useTakerEntry
      ? this.config.polymarket.paper.slippageBps
      : this.config.polymarket.paper.slippageBps * 0.25;
    const entryPrice = applyTakerSlippage(rawEntryPrice, effectiveSlippageBps);
    const qty = notionalUsd / Math.max(0.0001, entryPrice);
    if (!(qty > 0)) {
      return false;
    }
    const entryCostUsd = qty * entryPrice;
    const feesUsd = entryCostUsd * (this.config.polymarket.paper.feeBps / 10_000);

    const trade = this.paperLedger.recordTrade({
      marketId: params.marketId,
      marketSlug: params.marketSlug,
      marketQuestion: params.marketQuestion,
      referenceSymbol: params.referenceSymbol,
      windowStartTs: params.windowStartTs,
      windowEndTs: params.windowEndTs,
      side: params.side,
      entryPrice,
      qty,
      notionalUsd: entryCostUsd,
      feeBps: this.config.polymarket.paper.feeBps,
      slippageBps: this.config.polymarket.paper.slippageBps,
      feesUsd,
      entryCostUsd,
      priceToBeat: params.priceToBeat,
      referencePriceAtEntry: params.referencePriceAtEntry,
      yesTokenId,
      noTokenId,
      yesDisplayLabel: params.yesDisplayLabel,
      noDisplayLabel: params.noDisplayLabel,
      heldTokenId,
      createdTs: params.ts
    });
    const openSummary = this.paperLedger.getSummary(params.ts);
    const direction = this.getPaperDirectionLabel({
      side: trade.side,
      yesDisplayLabel: trade.yesDisplayLabel,
      noDisplayLabel: trade.noDisplayLabel,
      marketQuestion: trade.marketQuestion
    });
    this.updateTruthWindowContextFromTrade(trade, null);

    this.writePaperTradeLog({
      ts: new Date(params.ts).toISOString(),
      event: "TRADE_OPEN",
      entryStyle: useTakerEntry ? "TAKER" : "MAKER_LIMIT",
      tradeId: trade.id,
      marketId: trade.marketId,
      marketSlug: trade.marketSlug || null,
      side: trade.side,
      direction,
      contractEntryPrice: trade.entryPrice,
      btcReferencePrice: trade.referencePriceAtEntry ?? null,
      qty: trade.qty,
      notionalUsd: trade.notionalUsd,
      feesUsd: trade.feesUsd,
      edge: params.edge,
      pBase: params.pBase ?? null,
      pBoosted: params.pBoosted ?? null,
      boostApplied: Boolean(params.boostApplied),
      boostReason: params.boostReason || null,
      cumulativePnlUsd: openSummary.totalPnlUsd,
      wins: openSummary.wins,
      losses: openSummary.losses,
      winRate: openSummary.winRate
    });

    this.emitPolymarketTruth({
      ts: params.ts,
      force: true,
      action: "OPEN",
      tradeId: trade.id,
      slug: trade.marketSlug || null
    });

    this.logger.info(
      {
        tradeId: trade.id,
        marketId: trade.marketId,
        marketSlug: trade.marketSlug || null,
        side: trade.side,
        direction,
        entryStyle: useTakerEntry ? "TAKER" : "MAKER_LIMIT",
        contractEntryPrice: trade.entryPrice,
        btcReferencePrice: trade.referencePriceAtEntry ?? null,
        qty: trade.qty,
        notionalUsd: trade.notionalUsd,
        feesUsd: trade.feesUsd,
        pnlUsd: null
      },
      `POLY_TRADE event=OPEN mode=PAPER tradeId=${trade.id} slug=${String(trade.marketSlug || "-")} side=${trade.side} direction=${direction} contractEntryPrice=${trade.entryPrice.toFixed(4)} btcReferencePrice=${trade.referencePriceAtEntry ? trade.referencePriceAtEntry.toFixed(2) : "-"} notionalUsd=${trade.notionalUsd.toFixed(2)} pnlUsd=- forced=${params.forced ? "1" : "0"}`
    );
    return true;
  }

  private async managePaperOpenPositions(params: {
    nowTs: number;
    remainingSec: number;
    market: {
      marketId: string;
      noTokenId?: string;
      eventSlug?: string;
      slug?: string;
    };
    implied: {
      yesBid: number;
      yesAsk: number;
      yesMid: number;
      spread: number;
    };
    edgeYes: number;
    edgeNo: number;
    costPenaltyProb: number;
  }): Promise<void> {
    if (this.config.polymarket.mode !== "paper") return;

    const openTrades = this.paperLedger.getOpenTrades().filter((row) => row.marketId === params.market.marketId);
    if (openTrades.length === 0) return;

    let noBid = estimateNoBidFromYesBook(params.implied.yesAsk);
    if (params.market.noTokenId) {
      noBid = await this.getNoBidFromTokenId(params.market.noTokenId, noBid);
    }

    for (const trade of openTrades) {
      const heldNetEdge =
        trade.side === "YES"
          ? params.edgeYes - params.costPenaltyProb
          : params.edgeNo - params.costPenaltyProb;
      const previousTicks = this.paperStopLossTicksByTradeId.get(trade.id) || 0;
      const negativeTicks =
        heldNetEdge < -this.config.polymarket.paper.stopLossEdge ? previousTicks + 1 : 0;
      this.paperStopLossTicksByTradeId.set(trade.id, negativeTicks);

      const rawExitPx = trade.side === "YES" ? params.implied.yesBid : noBid;
      const exitPrice = applySellSlippage(rawExitPx, this.config.polymarket.paper.slippageBps);
      const mtm = computePaperClosePnl({
        qty: trade.qty,
        entryCostUsd: trade.entryCostUsd,
        entryFeesUsd: trade.feesUsd,
        exitPrice,
        feeBps: trade.feeBps
      });
      const bestUnrealizedPnlUsd = Math.max(
        Number(this.paperBestUnrealizedPnlUsdByTradeId.get(trade.id) || Number.NEGATIVE_INFINITY),
        mtm.pnlUsd
      );
      this.paperBestUnrealizedPnlUsdByTradeId.set(trade.id, bestUnrealizedPnlUsd);
      const takeProfitUsd = this.getPaperTakeProfitUsd(params.remainingSec);
      const retraceFraction = this.getPaperTrailingRetraceFraction(params.remainingSec);
      const unrealizedRetraceUsd = Math.max(0, bestUnrealizedPnlUsd - mtm.pnlUsd);
      const trailingRetraceTriggered =
        bestUnrealizedPnlUsd >= this.config.polymarket.paper.trailingMinProfitUsd &&
        mtm.pnlUsd > 0 &&
        unrealizedRetraceUsd >= bestUnrealizedPnlUsd * retraceFraction;

      let closeReason: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "TRAILING_RETRACE" | null = null;
      if (negativeTicks >= this.config.polymarket.paper.stopLossConsecutiveTicks) {
        closeReason = "STOP_LOSS";
      } else if (mtm.pnlUsd >= takeProfitUsd) {
        closeReason = "TAKE_PROFIT";
      } else if (trailingRetraceTriggered) {
        closeReason = "TRAILING_RETRACE";
      } else if (
        params.remainingSec < this.config.polymarket.risk.noNewOrdersInLastSec &&
        mtm.pnlUsd > 0
      ) {
        closeReason = "TIME_EXIT_PROFIT";
      }

      if (!closeReason) continue;
      this.closePaperTrade(trade.id, closeReason, exitPrice, mtm, params.nowTs);
    }
  }

  private closePaperTrade(
    tradeId: string,
    closeReason: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "TRAILING_RETRACE" | "MANUAL",
    exitPrice: number,
    mtm: { exitProceedsUsd: number; exitFeesUsd: number; pnlUsd: number },
    nowTs: number
  ): void {
    const closed = this.paperLedger.closeTrade({
      tradeId,
      resolvedAt: nowTs,
      closeReason,
      exitPrice,
      exitProceedsUsd: mtm.exitProceedsUsd,
      exitFeesUsd: mtm.exitFeesUsd,
      pnlUsd: mtm.pnlUsd
    });
    if (!closed) return;
    this.paperStopLossTicksByTradeId.delete(tradeId);
    this.paperBestUnrealizedPnlUsdByTradeId.delete(tradeId);
    const closeSummary = this.paperLedger.getSummary(nowTs);
      const result = classifyPaperResult(mtm.pnlUsd);
    const direction = this.getPaperDirectionLabel({
      side: closed.side,
      yesDisplayLabel: closed.yesDisplayLabel,
      noDisplayLabel: closed.noDisplayLabel,
      marketQuestion: closed.marketQuestion
    });
    this.updateTruthWindowContextFromTrade(closed, "PAPER_EXIT");

    this.writePaperTradeLog({
      ts: new Date(nowTs).toISOString(),
      event: "EXITED_EARLY",
      tradeId: closed.id,
      marketId: closed.marketId,
      marketSlug: closed.marketSlug || null,
      side: closed.side,
      direction,
      status: getPaperTradeStatus(closed),
      closeReason,
      exitPrice,
      exitProceedsUsd: mtm.exitProceedsUsd,
      exitFeesUsd: mtm.exitFeesUsd,
      pnlUsd: mtm.pnlUsd,
      result,
      cumulativePnlUsd: closeSummary.totalPnlUsd,
      wins: closeSummary.wins,
      losses: closeSummary.losses,
      winRate: closeSummary.winRate
    });

    this.emitPolymarketTruth({
      ts: nowTs,
      force: true,
      action: "CLOSE",
      tradeId: closed.id,
      slug: closed.marketSlug || null
    });

    this.logger.info(
      {
        tradeId: closed.id,
        marketId: closed.marketId,
        marketSlug: closed.marketSlug || null,
        side: closed.side,
        direction,
        status: getPaperTradeStatus(closed),
        closeReason,
        exitPrice,
        notionalUsd: closed.notionalUsd,
        pnlUsd: mtm.pnlUsd
      },
      `POLY_TRADE event=EXITED_EARLY mode=PAPER tradeId=${closed.id} slug=${String(closed.marketSlug || "-")} side=${closed.side} direction=${direction} notionalUsd=${closed.notionalUsd.toFixed(2)} pnlUsd=${mtm.pnlUsd.toFixed(2)} reason=${closeReason}`
    );
  }

  private assertPaperSettlementSanityAtStartup(): void {
    if (this.config.polymarket.mode !== "paper") return;
    const ambiguousOpenTrades = this.paperLedger
      .getOpenTrades()
      .filter((trade) => !this.getPaperTradeTokenMapping(trade));
    if (ambiguousOpenTrades.length === 0) return;
    this.logger.error(
      {
        count: ambiguousOpenTrades.length,
        samples: ambiguousOpenTrades.slice(0, 5).map((trade) => ({
          tradeId: trade.id,
          marketId: trade.marketId,
          marketSlug: trade.marketSlug || null,
          side: trade.side,
          heldTokenId: trade.heldTokenId || null,
          yesTokenId: trade.yesTokenId || null,
          noTokenId: trade.noTokenId || null
        }))
      },
      "PAPER settlement startup sanity failed: ambiguous side/token mapping"
    );
    throw new Error("POLY_PAPER_SETTLEMENT_MAPPING_AMBIGUOUS");
  }

  private getPaperTradeTokenMapping(trade: {
    side: "YES" | "NO";
    heldTokenId?: string;
    yesTokenId?: string;
    noTokenId?: string;
  }): { heldSide: "YES" | "NO"; heldTokenId: string; yesTokenId: string; noTokenId: string } | null {
    const yesTokenId = String(trade.yesTokenId || "").trim();
    const noTokenId = String(trade.noTokenId || "").trim();
    if (!yesTokenId || !noTokenId || yesTokenId === noTokenId) {
      return null;
    }
    const fallbackHeld = trade.side === "YES" ? yesTokenId : noTokenId;
    const heldTokenId = String(trade.heldTokenId || fallbackHeld).trim();
    if (!heldTokenId) {
      return null;
    }
    if (trade.side === "YES" && heldTokenId !== yesTokenId) {
      return null;
    }
    if (trade.side === "NO" && heldTokenId !== noTokenId) {
      return null;
    }
    return {
      heldSide: trade.side,
      heldTokenId,
      yesTokenId,
      noTokenId
    };
  }

  private mapOutcomeToWinningTokenId(
    outcome: "UP" | "DOWN",
    tradeMapping: { yesTokenId: string; noTokenId: string },
    marketResolution:
      | Pick<PolymarketMarketResolution, "yesOutcomeMapped" | "noOutcomeMapped">
      | PolymarketMarketResolution
      | null
  ): string {
    const yesOutcome = marketResolution?.yesOutcomeMapped ?? null;
    const noOutcome = marketResolution?.noOutcomeMapped ?? null;
    if (yesOutcome && outcome === yesOutcome) {
      return tradeMapping.yesTokenId;
    }
    if (noOutcome && outcome === noOutcome) {
      return tradeMapping.noTokenId;
    }
    return outcome === "UP" ? tradeMapping.yesTokenId : tradeMapping.noTokenId;
  }

  private deriveOutcomeFromWinningTokenId(
    winningTokenId: string,
    tradeMapping: { yesTokenId: string; noTokenId: string },
    marketResolution:
      | Pick<PolymarketMarketResolution, "yesOutcomeMapped" | "noOutcomeMapped">
      | PolymarketMarketResolution
      | null
  ): "UP" | "DOWN" {
    if (winningTokenId === tradeMapping.yesTokenId) {
      return marketResolution?.yesOutcomeMapped ?? "UP";
    }
    if (winningTokenId === tradeMapping.noTokenId) {
      return marketResolution?.noOutcomeMapped ?? "DOWN";
    }
    return "UP";
  }

  private getOfficialWinningTokenId(
    tradeMapping: { yesTokenId: string; noTokenId: string },
    marketResolution: PolymarketMarketResolution | null
  ): string | null {
    const directWinner =
      marketResolution?.winningTokenId &&
      (marketResolution.winningTokenId === tradeMapping.yesTokenId ||
        marketResolution.winningTokenId === tradeMapping.noTokenId)
        ? marketResolution.winningTokenId
        : null;
    if (directWinner) return directWinner;
    if (marketResolution?.winningSide === "YES") return tradeMapping.yesTokenId;
    if (marketResolution?.winningSide === "NO") return tradeMapping.noTokenId;
    if (marketResolution?.winningOutcome) {
      return this.mapOutcomeToWinningTokenId(marketResolution.winningOutcome, tradeMapping, marketResolution);
    }
    return null;
  }

  private hasOfficialMarketWinner(marketResolution: PolymarketMarketResolution | null): boolean {
    return Boolean(
      marketResolution &&
        (marketResolution.winningTokenId || marketResolution.winningSide || marketResolution.winningOutcome)
    );
  }

  private isMarketStillOpenForPaperResolution(context: PolymarketMarketContext | null): boolean {
    if (!context) return false;
    if (context.closed) return false;
    if (context.active === false) return false;
    return true;
  }

  private shortErrorText(error: unknown): string {
    if (error instanceof Error) {
      return error.message || error.name || "error";
    }
    const raw = String(error || "error").trim();
    return raw || "error";
  }

  private upsertPaperTradeLifecycle(
    tradeId: string,
    input: {
      status: "OPEN" | "AWAITING_RESOLUTION" | "RESOLUTION_ERROR";
      nowTs: number;
      statusReason: string;
      statusDetail: string;
      awaitingResolutionSinceTs?: number | null;
      resolutionAttempts?: number;
      resolutionError?: string | null;
      resolutionContextState?: "TRADING_OPEN" | "CLOSED_AWAITING_OUTCOME" | "FETCH_FAILED";
    }
  ): { trade: ReturnType<PaperLedger["getTrade"]>; changed: boolean } {
    const current = this.paperLedger.getTrade(tradeId);
    if (!current) {
      return {
        trade: null,
        changed: false
      };
    }
    const currentStatus = getPaperTradeStatus(current);
    const same =
      currentStatus === input.status &&
      String(current.statusReason || "") === input.statusReason &&
      String(current.statusDetail || "") === input.statusDetail &&
      Number(current.awaitingResolutionSinceTs || 0) === Number(input.awaitingResolutionSinceTs || 0) &&
      Number(current.resolutionAttempts || 0) === Number(input.resolutionAttempts || 0) &&
      String(current.resolutionError || "") === String(input.resolutionError || "") &&
      String(current.resolutionContextState || "") === String(input.resolutionContextState || "");
    if (same) {
      return {
        trade: current,
        changed: false
      };
    }
    const updated = this.paperLedger.updateTradeStatus({
      tradeId,
      status: input.status,
      statusUpdatedAt: input.nowTs,
      statusReason: input.statusReason,
      statusDetail: input.statusDetail,
      awaitingResolutionSinceTs: input.awaitingResolutionSinceTs ?? null,
      lastResolutionAttemptTs: input.nowTs,
      resolutionAttempts: input.resolutionAttempts,
      resolutionError: input.resolutionError ?? null,
      resolutionErrorAt: input.resolutionError ? input.nowTs : null,
      resolutionContextState: input.resolutionContextState
    });
    return {
      trade: updated,
      changed: Boolean(updated)
    };
  }

  private async getPaperFallbackReferencePrice(nowTs: number): Promise<number | null> {
    const fastMid = this.oracleRouter.getFastMidNow(nowTs);
    if (fastMid && fastMid.price > 0) {
      return fastMid.price;
    }
    try {
      const oracle = await this.oracleRouter.getOracleNow(nowTs);
      if (oracle.price > 0) {
        return oracle.price;
      }
    } catch {
      // Fallback below.
    }
    const lastOraclePrice = Number(this.lastOracleSnapshot?.price || 0);
    return lastOraclePrice > 0 ? lastOraclePrice : null;
  }

  private async resolvePaperTradeWithDerivedFallback(
    trade: ReturnType<PaperLedger["getTrade"]> extends infer T ? NonNullable<T> : never,
    tokenMapping: { heldSide: "YES" | "NO"; heldTokenId: string; yesTokenId: string; noTokenId: string },
    nowTs: number,
    reason: string,
    detail: string
  ): Promise<boolean> {
    const referencePrice = await this.getPaperFallbackReferencePrice(nowTs);
    if (!(referencePrice && referencePrice > 0)) {
      const errorText = "Derived fallback reference price unavailable";
      this.upsertPaperTradeLifecycle(trade.id, {
        status: "RESOLUTION_ERROR",
        nowTs,
        statusReason: "DERIVED_FALLBACK_UNAVAILABLE",
        statusDetail: errorText,
        resolutionAttempts: Math.max(1, Number(trade.resolutionAttempts || 0)),
        resolutionError: errorText,
        resolutionContextState: "FETCH_FAILED"
      });
      this.writePaperIntervalEvent("RESOLUTION_ERROR", nowTs, {
        tradeId: trade.id,
        marketId: trade.marketId,
        slug: trade.marketSlug || null,
        statusReason: "DERIVED_FALLBACK_UNAVAILABLE",
        statusDetail: errorText
      }, "warn");
      return false;
    }

    const derivedOutcome = inferOutcomeFromOracle(referencePrice, Number(trade.priceToBeat || 0));
    const winningTokenId = this.mapOutcomeToWinningTokenId(
      derivedOutcome,
      tokenMapping,
      this.buildPaperResolutionHints(trade)
    );
    const settlement = computePaperBinarySettlementPnl({
      qty: trade.qty,
      entryPrice: trade.entryPrice,
      notionalUsd: trade.notionalUsd,
      entryCostUsd: trade.entryCostUsd,
      feesUsd: trade.feesUsd,
      heldSide: tokenMapping.heldSide,
      heldTokenId: tokenMapping.heldTokenId,
      yesTokenId: tokenMapping.yesTokenId,
      noTokenId: tokenMapping.noTokenId,
      winningTokenId
    });
    const resolved = this.paperLedger.resolveTrade({
      tradeId: trade.id,
      resolvedAt: nowTs,
      outcome: derivedOutcome,
      payoutUsd: settlement.exitPayoutUsd,
      pnlUsd: settlement.pnlUsd,
      winningTokenId,
      winningOutcomeText: derivedOutcome,
      oracleAtEnd: referencePrice,
      resolutionSource: "DERIVED_FALLBACK",
      statusReason: reason,
      statusDetail: detail
    });
    if (!resolved) {
      return false;
    }
    this.validateResolvedPaperSettlement(resolved);
    const resolveSummary = this.paperLedger.getSummary(nowTs);
    const result = classifyPaperResult(settlement.pnlUsd);
    const tradeDirection = this.getPaperDirectionLabel({
      side: trade.side,
      yesDisplayLabel: trade.yesDisplayLabel,
      noDisplayLabel: trade.noDisplayLabel,
      marketQuestion: trade.marketQuestion
    });
    const winningSide = winningTokenId === tokenMapping.yesTokenId ? "YES" : "NO";
    const winningDirection = this.getPaperDirectionLabel({
      side: winningSide,
      yesDisplayLabel: trade.yesDisplayLabel,
      noDisplayLabel: trade.noDisplayLabel,
      marketQuestion: trade.marketQuestion
    });
    this.updateTruthWindowContextFromTrade(resolved, "DERIVED_FALLBACK");
    this.resolutionPendingLogByTradeId.delete(trade.id);
    this.paperStopLossTicksByTradeId.delete(trade.id);
    this.paperBestUnrealizedPnlUsdByTradeId.delete(trade.id);
    this.writePaperIntervalEvent(getPaperTradeStatus(resolved), nowTs, {
      tradeId: resolved.id,
      marketId: resolved.marketId,
      slug: resolved.marketSlug || null,
      side: resolved.side,
      winner: derivedOutcome,
      winningTokenId,
      qty: resolved.qty,
      entryCostUsd: resolved.entryCostUsd,
      exitPayoutUsd: settlement.exitPayoutUsd,
      pnlUsd: settlement.pnlUsd,
      referencePrice: referencePrice,
      strikePrice: resolved.priceToBeat,
      resolutionSource: "DERIVED_FALLBACK",
      result,
      cumulativePnlUsd: resolveSummary.totalPnlUsd,
      wins: resolveSummary.wins,
      losses: resolveSummary.losses,
      winRate: resolveSummary.winRate
    });
    this.emitPolymarketTruth({
      ts: nowTs,
      force: true,
      action: "RESOLVE",
      tradeId: resolved.id,
      slug: resolved.marketSlug || null
    });
    this.logger.warn(
      {
        tradeId: resolved.id,
        marketId: resolved.marketId,
        marketSlug: resolved.marketSlug || null,
        side: resolved.side,
        direction: tradeDirection,
        outcome: derivedOutcome,
        winningDirection,
        winningTokenId,
        payoutUsd: settlement.exitPayoutUsd,
        notionalUsd: resolved.notionalUsd,
        pnlUsd: settlement.pnlUsd,
        referencePrice,
        strikePrice: resolved.priceToBeat,
        resolutionSource: "DERIVED_FALLBACK",
        result
      },
      `POLY_TRADE event=${getPaperTradeStatus(resolved)} mode=PAPER tradeId=${resolved.id} slug=${String(resolved.marketSlug || "-")} side=${resolved.side} notionalUsd=${resolved.notionalUsd.toFixed(2)} pnlUsd=${settlement.pnlUsd.toFixed(2)} reason=DERIVED_FALLBACK`
    );
    return true;
  }

  private validateResolvedPaperSettlement(trade: {
    id: string;
    marketId: string;
    marketSlug?: string;
    entryPrice: number;
    qty: number;
    notionalUsd: number;
    entryCostUsd: number;
    feesUsd: number;
    payoutUsd?: number;
    exitProceedsUsd?: number;
  }): void {
    const bounds = getPaperBinarySettlementBounds({
      qty: trade.qty,
      entryPrice: trade.entryPrice,
      entryCostUsd: trade.entryCostUsd,
      notionalUsd: trade.notionalUsd
    });
    const payoutUsd = Math.max(0, Number(trade.exitProceedsUsd ?? trade.payoutUsd ?? 0));
    if (payoutUsd < bounds.minPayoutUsd - 1e-9 || payoutUsd > bounds.maxPayoutUsd + 1e-9) {
      this.logger.error(
        {
          tradeId: trade.id,
          marketId: trade.marketId,
          marketSlug: trade.marketSlug || null,
          payoutUsd,
          minPayoutUsd: bounds.minPayoutUsd,
          maxPayoutUsd: bounds.maxPayoutUsd,
          shareCount: bounds.shareCount,
          entryPrice: trade.entryPrice,
          entryCostUsd: trade.entryCostUsd,
          feesUsd: trade.feesUsd
        },
        "POLY_PAPER_INVALID_BINARY_PAYOUT"
      );
    }
  }

  private async resolvePaperTrades(nowTs: number): Promise<void> {
    if (this.config.polymarket.mode !== "paper") {
      return;
    }

    const activeTrades = this.paperLedger.getActiveTrades();
    for (const trade of activeTrades) {
      const expiryTs = trade.expectedCloseTs || trade.windowEndTs;
      if (expiryTs <= nowTs && getPaperTradeStatus(trade) === "OPEN") {
        const statusUpdate = this.upsertPaperTradeLifecycle(trade.id, {
          status: "AWAITING_RESOLUTION",
          nowTs,
          statusReason: "EXPIRED_WINDOW",
          statusDetail: "Market window expired; awaiting official market outcome",
          awaitingResolutionSinceTs: expiryTs,
          resolutionAttempts: Math.max(0, Number(trade.resolutionAttempts || 0)),
          resolutionError: null,
          resolutionContextState: "CLOSED_AWAITING_OUTCOME"
        });
        if (statusUpdate.changed) {
          this.writePaperIntervalEvent("AWAITING_RESOLUTION", nowTs, {
            tradeId: trade.id,
            marketId: trade.marketId,
            slug: trade.marketSlug || null,
            intervalEndTs: expiryTs,
            reason: "EXPIRED_WINDOW"
          });
        }
      }
      const targetTs = expiryTs + this.config.polymarket.paper.resolveGraceMs;
      if (targetTs > nowTs) continue;

      const tokenMapping = this.getPaperTradeTokenMapping(trade);
      if (!tokenMapping) {
        this.logger.error(
          {
            tradeId: trade.id,
            marketId: trade.marketId,
            marketSlug: trade.marketSlug || null,
            heldSide: trade.side,
            heldTokenId: trade.heldTokenId || null,
            yesTokenId: trade.yesTokenId || null,
            noTokenId: trade.noTokenId || null
          },
          "PAPER settlement skipped: ambiguous side/token mapping"
        );
        continue;
      }

      const nextResolutionAttempts = Math.max(0, Number(trade.resolutionAttempts || 0)) + 1;
      let marketContext: PolymarketMarketContext | null = null;
      try {
        marketContext = await this.client.getMarketContext(trade.marketId);
      } catch (error) {
        const errorText = this.shortErrorText(error);
        const fallbackResolved = await this.resolvePaperTradeWithDerivedFallback(
          trade,
          tokenMapping,
          nowTs,
          "DERIVED_FALLBACK_AFTER_FETCH_FAILED",
          `Derived fallback used after exact market fetch failed: ${errorText}`
        );
        if (!fallbackResolved) {
          const statusUpdate = this.upsertPaperTradeLifecycle(trade.id, {
            status: "RESOLUTION_ERROR",
            nowTs,
            statusReason: "RESOLUTION_FETCH_FAILED",
            statusDetail: `Exact market fetch failed: ${errorText}`,
            resolutionAttempts: nextResolutionAttempts,
            resolutionError: errorText,
            resolutionContextState: "FETCH_FAILED"
          });
          const loggedTrade = statusUpdate.trade || trade;
          this.logger.warn(
            {
              tradeId: loggedTrade.id,
              marketId: loggedTrade.marketId,
              marketSlug: loggedTrade.marketSlug || null,
              status: "RESOLUTION_ERROR",
              resolutionAttempts: nextResolutionAttempts,
              error: errorText
            },
            "POLY_PAPER_RESOLUTION_FETCH_FAILED"
          );
          this.writePaperIntervalEvent("RESOLUTION_ERROR", nowTs, {
            tradeId: loggedTrade.id,
            marketId: loggedTrade.marketId,
            slug: loggedTrade.marketSlug || null,
            statusReason: "RESOLUTION_FETCH_FAILED",
            statusDetail: `Exact market fetch failed: ${errorText}`,
            resolutionAttempts: nextResolutionAttempts,
            resolutionError: errorText
          }, "warn");
        }
        continue;
      }

      if (!marketContext) {
        const fallbackResolved = await this.resolvePaperTradeWithDerivedFallback(
          trade,
          tokenMapping,
          nowTs,
          "DERIVED_FALLBACK_AFTER_CONTEXT_MISSING",
          "Derived fallback used because exact market context was unavailable after grace period"
        );
        if (!fallbackResolved) {
          const errorText = "Exact market context unavailable";
          const statusUpdate = this.upsertPaperTradeLifecycle(trade.id, {
            status: "RESOLUTION_ERROR",
            nowTs,
            statusReason: "RESOLUTION_FETCH_EMPTY",
            statusDetail: errorText,
            resolutionAttempts: nextResolutionAttempts,
            resolutionError: errorText,
            resolutionContextState: "FETCH_FAILED"
          });
          const loggedTrade = statusUpdate.trade || trade;
          this.logger.warn(
            {
              tradeId: loggedTrade.id,
              marketId: loggedTrade.marketId,
              marketSlug: loggedTrade.marketSlug || null,
              status: "RESOLUTION_ERROR",
              resolutionAttempts: nextResolutionAttempts
            },
            "POLY_PAPER_RESOLUTION_CONTEXT_MISSING"
          );
          this.writePaperIntervalEvent("RESOLUTION_ERROR", nowTs, {
            tradeId: loggedTrade.id,
            marketId: loggedTrade.marketId,
            slug: loggedTrade.marketSlug || null,
            statusReason: "RESOLUTION_FETCH_EMPTY",
            statusDetail: errorText,
            resolutionAttempts: nextResolutionAttempts,
            resolutionError: errorText
          }, "warn");
        }
        continue;
      }

      if (this.isMarketStillOpenForPaperResolution(marketContext)) {
        const fallbackResolved = await this.resolvePaperTradeWithDerivedFallback(
          trade,
          tokenMapping,
          nowTs,
          "DERIVED_FALLBACK_AFTER_GRACE",
          "Derived fallback used because the interval expired and exact market remained open past grace period"
        );
        if (!fallbackResolved) {
          const statusUpdate = this.upsertPaperTradeLifecycle(trade.id, {
            status: "AWAITING_RESOLUTION",
            nowTs,
            statusReason: "MARKET_STILL_OPEN",
            statusDetail: "Interval expired locally; exact market still open without official outcome",
            awaitingResolutionSinceTs: trade.awaitingResolutionSinceTs || expiryTs,
            resolutionAttempts: nextResolutionAttempts,
            resolutionError: null,
            resolutionContextState: "CLOSED_AWAITING_OUTCOME"
          });
          if (statusUpdate.changed) {
            const loggedTrade = statusUpdate.trade || trade;
            this.writePaperIntervalEvent("AWAITING_RESOLUTION", nowTs, {
              tradeId: loggedTrade.id,
              marketId: loggedTrade.marketId,
              slug: loggedTrade.marketSlug || null,
              statusReason: "MARKET_STILL_OPEN",
              statusDetail: "Interval expired locally; exact market still open without official outcome",
              resolutionAttempts: nextResolutionAttempts
            });
          }
          this.resolutionPendingLogByTradeId.delete(trade.id);
        }
        continue;
      }

      const marketResolution = marketContext.resolution;
      if (marketContext.cancelled) {
        const cancelled = this.paperLedger.cancelTrade({
          tradeId: trade.id,
          resolvedAt: nowTs,
          cancelReason: "MARKET_CANCELLED",
          status: "VOID",
          statusDetail: "Exact market context marked the BTC5m market cancelled/void",
          payoutUsd: trade.notionalUsd,
          pnlUsd: 0,
          resolutionSource: "OFFICIAL"
        });
        if (!cancelled) continue;
        this.updateTruthWindowContextFromTrade(cancelled, "OFFICIAL");
        this.resolutionPendingLogByTradeId.delete(trade.id);
        this.paperStopLossTicksByTradeId.delete(trade.id);
        this.paperBestUnrealizedPnlUsdByTradeId.delete(trade.id);
        this.writePaperIntervalEvent("VOID", nowTs, {
          tradeId: cancelled.id,
          marketId: cancelled.marketId,
          slug: cancelled.marketSlug || null,
          side: cancelled.side,
          statusReason: "MARKET_CANCELLED",
          statusDetail: cancelled.statusDetail || null,
          pnlUsd: 0,
          exitPayoutUsd: cancelled.exitProceedsUsd ?? cancelled.payoutUsd ?? cancelled.notionalUsd
        }, "warn");
        this.logger.warn(
          {
            tradeId: cancelled.id,
            marketId: cancelled.marketId,
            marketSlug: cancelled.marketSlug || null,
            status: "VOID"
          },
          "POLY_PAPER_LIFECYCLE_VOID"
        );
        continue;
      }

      const tradeResolutionHints = this.buildPaperResolutionHints(trade);
      const mergedResolution = {
        ...marketResolution,
        yesOutcomeMapped: marketResolution?.yesOutcomeMapped ?? tradeResolutionHints.yesOutcomeMapped,
        noOutcomeMapped: marketResolution?.noOutcomeMapped ?? tradeResolutionHints.noOutcomeMapped
      };
      let winningTokenId = this.getOfficialWinningTokenId(tokenMapping, mergedResolution);
      let winningOutcome = marketResolution?.winningOutcome ?? null;
      let winningOutcomeText = marketResolution?.winningOutcomeText ?? null;
      if (!winningOutcome && winningTokenId) {
        winningOutcome = this.deriveOutcomeFromWinningTokenId(winningTokenId, tokenMapping, mergedResolution);
      }
      if (!winningTokenId && this.hasOfficialMarketWinner(marketResolution) && winningOutcome) {
        winningTokenId = this.mapOutcomeToWinningTokenId(winningOutcome, tokenMapping, mergedResolution);
      }

      if (!this.hasOfficialMarketWinner(marketResolution) || !winningTokenId || !winningOutcome) {
        const fallbackResolved = await this.resolvePaperTradeWithDerivedFallback(
          trade,
          tokenMapping,
          nowTs,
          "DERIVED_FALLBACK_AFTER_OFFICIAL_UNAVAILABLE",
          "Derived fallback used because official market winner data was unavailable after grace period"
        );
        if (!fallbackResolved) {
          const awaitingSince = trade.awaitingResolutionSinceTs || (trade.expectedCloseTs || trade.windowEndTs);
          const statusDetail = "Market closed but official winner data is not published yet";
          const statusUpdate = this.upsertPaperTradeLifecycle(trade.id, {
            status: "AWAITING_RESOLUTION",
            nowTs,
            statusReason: "MARKET_CLOSED_AWAITING_OUTCOME",
            statusDetail,
            awaitingResolutionSinceTs: awaitingSince,
            resolutionAttempts: nextResolutionAttempts,
            resolutionError: null,
            resolutionContextState: "CLOSED_AWAITING_OUTCOME"
          });
          const awaitingTrade = statusUpdate.trade || trade;
          const awaitingAgeSec = Math.max(0, Math.floor((nowTs - awaitingSince) / 1000));
          const lastLogged = this.resolutionPendingLogByTradeId.get(trade.id) || 0;
          if (statusUpdate.changed || nowTs - lastLogged >= 10_000) {
            this.resolutionPendingLogByTradeId.set(trade.id, nowTs);
            this.logger.warn(
              {
                tradeId: awaitingTrade.id,
                marketId: awaitingTrade.marketId,
                marketSlug: awaitingTrade.marketSlug || null,
                status: "AWAITING_RESOLUTION",
                awaitingAgeSec,
                closed: marketContext.closed,
                active: marketContext.active,
                acceptingOrders: marketContext.acceptingOrders,
                enableOrderBook: marketContext.enableOrderBook
              },
              "POLY_PAPER_LIFECYCLE_AWAITING_RESOLUTION"
            );
            this.writePaperIntervalEvent("AWAITING_RESOLUTION", nowTs, {
              tradeId: awaitingTrade.id,
              marketId: awaitingTrade.marketId,
              slug: awaitingTrade.marketSlug || null,
              side: awaitingTrade.side,
              statusReason: "MARKET_CLOSED_AWAITING_OUTCOME",
              statusDetail,
              awaitingResolutionAgeSec: awaitingAgeSec,
              resolutionAttempts: nextResolutionAttempts
            }, "warn");
          }
        }
        continue;
      }

      const settlement = computePaperBinarySettlementPnl({
        qty: trade.qty,
        entryPrice: trade.entryPrice,
        notionalUsd: trade.notionalUsd,
        entryCostUsd: trade.entryCostUsd,
        feesUsd: trade.feesUsd,
        heldSide: tokenMapping.heldSide,
        heldTokenId: tokenMapping.heldTokenId,
        yesTokenId: tokenMapping.yesTokenId,
        noTokenId: tokenMapping.noTokenId,
        winningTokenId
      });
      const resolved = this.paperLedger.resolveTrade({
        tradeId: trade.id,
        resolvedAt: nowTs,
        outcome: winningOutcome,
        payoutUsd: settlement.exitPayoutUsd,
        pnlUsd: settlement.pnlUsd,
        winningTokenId,
        winningOutcomeText: winningOutcomeText || undefined,
        resolutionSource: "OFFICIAL",
        statusReason: "OFFICIAL_OUTCOME",
        statusDetail: "Resolved from exact market winner data"
      });
      if (!resolved) continue;
      this.validateResolvedPaperSettlement(resolved);
      const resolveSummary = this.paperLedger.getSummary(nowTs);
      const result = classifyPaperResult(settlement.pnlUsd);
      this.updateTruthWindowContextFromTrade(resolved, "OFFICIAL");
      const tradeDirection = this.getPaperDirectionLabel({
        side: trade.side,
        yesDisplayLabel: trade.yesDisplayLabel,
        noDisplayLabel: trade.noDisplayLabel,
        marketQuestion: trade.marketQuestion
      });
      const winningSide = winningTokenId === tokenMapping.yesTokenId ? "YES" : "NO";
      const winningDirection = this.getPaperDirectionLabel({
        side: winningSide,
        yesDisplayLabel: trade.yesDisplayLabel,
        noDisplayLabel: trade.noDisplayLabel,
        marketQuestion: trade.marketQuestion
      });
      const outcomeSource =
        marketResolution?.winningTokenId
          ? "market_api.winningTokenId"
          : marketResolution?.winningSide
            ? "market_api.winningSide"
            : marketResolution?.winningOutcome
              ? "market_api.winningOutcome"
              : "market_api.derived";

      this.logger.info(
        {
          tradeId: resolved.id,
          slug: resolved.marketSlug || null,
          heldSide: tokenMapping.heldSide,
          direction: tradeDirection,
          heldTokenId: tokenMapping.heldTokenId,
          winningOutcome: winningOutcomeText || winningOutcome,
          winningDirection,
          winningTokenId,
          qty: resolved.qty,
          entryCostUsd: resolved.entryCostUsd,
          exitPayoutUsd: settlement.exitPayoutUsd,
          feesUsd: resolved.feesUsd,
          pnlUsd: settlement.pnlUsd,
          result,
          outcomeSource
        },
        "POLY_PAPER_RESOLUTION"
      );

      this.writePaperIntervalEvent(getPaperTradeStatus(resolved), nowTs, {
        tradeId: resolved.id,
        marketId: resolved.marketId,
        slug: resolved.marketSlug || null,
        side: resolved.side,
        heldSide: tokenMapping.heldSide,
        heldTokenId: tokenMapping.heldTokenId,
        winner: winningOutcome,
        winningOutcome: winningOutcomeText || winningOutcome,
        winningTokenId,
        qty: resolved.qty,
        entryCostUsd: resolved.entryCostUsd,
        exitPayoutUsd: settlement.exitPayoutUsd,
        feesUsd: resolved.feesUsd,
        pnlUsd: settlement.pnlUsd,
        resolutionSource: "OFFICIAL",
        outcomeSource,
        result,
        cumulativePnlUsd: resolveSummary.totalPnlUsd,
        wins: resolveSummary.wins,
        losses: resolveSummary.losses,
        winRate: resolveSummary.winRate
      });
      this.resolutionPendingLogByTradeId.delete(trade.id);
      this.paperStopLossTicksByTradeId.delete(trade.id);
      this.paperBestUnrealizedPnlUsdByTradeId.delete(trade.id);

      this.emitPolymarketTruth({
        ts: nowTs,
        force: true,
        action: "RESOLVE",
        tradeId: resolved.id,
        slug: resolved.marketSlug || null
      });

      this.logger.info(
        {
          tradeId: resolved.id,
          marketId: resolved.marketId,
          marketSlug: resolved.marketSlug || null,
          side: resolved.side,
          direction: tradeDirection,
          outcome: winningOutcome,
          winningDirection,
          winningTokenId,
          payoutUsd: settlement.exitPayoutUsd,
          notionalUsd: resolved.notionalUsd,
          pnlUsd: settlement.pnlUsd,
          resolutionSource: "OFFICIAL",
          outcomeSource,
          result
        },
        `POLY_TRADE event=${getPaperTradeStatus(resolved)} mode=PAPER tradeId=${resolved.id} slug=${String(resolved.marketSlug || "-")} side=${resolved.side} notionalUsd=${resolved.notionalUsd.toFixed(2)} pnlUsd=${settlement.pnlUsd.toFixed(2)} reason=${winningOutcome}`
      );
    }
  }

  private async maybeForcePaperTrade(
    markets: Array<{
      marketId: string;
      slug?: string;
      priceToBeat: number;
      startTs?: number;
      endTs: number;
      yesTokenId: string;
      noTokenId?: string;
      acceptingOrders?: boolean;
      eventSlug?: string;
      yesBidHint?: number;
      yesAskHint?: number;
      yesMidHint?: number;
      yesLastTradeHint?: number;
      outcomePricesHint?: number[];
    }>,
    context: {
      nowTs: number;
      oracleEst: number;
      sigmaPricePerSqrtSec: number;
      sigmaPerSqrtSec: number;
      oracleState: OracleState | "IDLE";
    },
    discovery: {
      windowsCount: number;
      fallbackWindowSamples: Array<{
        marketId: string;
        slug: string;
        windowStartTsMs: number;
        windowEndTsMs: number;
        nowTsMs: number;
        remainingSec: number;
      }>;
      timeFirstWindowSamples: Array<{
        marketId: string;
        slug: string;
        windowStartTsMs: number;
        windowEndTsMs: number;
        nowTsMs: number;
        remainingSec: number;
      }>;
    },
    selectedMarket?: {
      marketId: string;
      slug?: string;
      priceToBeat: number;
      startTs?: number;
      endTs: number;
      yesTokenId: string;
      noTokenId?: string;
      acceptingOrders?: boolean;
      eventSlug?: string;
      yesBidHint?: number;
      yesAskHint?: number;
      yesMidHint?: number;
      yesLastTradeHint?: number;
      outcomePricesHint?: number[];
    } | null
  ): Promise<{ fired: boolean; mode: "none" | "normal" | "smoke" }> {
    if (this.config.polymarket.mode !== "paper") return { fired: false, mode: "none" };
    if (this.config.polymarket.killSwitch) return { fired: false, mode: "none" };
    if (this.tradingPaused) return { fired: false, mode: "none" };
    if (this.isDeterministicBtc5mMode()) return { fired: false, mode: "none" };
    if (!this.config.polymarket.paper.forceTrade) return { fired: false, mode: "none" };
    const allowSmokeForceTrade = false;
    const intervalMs = this.config.polymarket.paper.forceIntervalSec * 1000;
    if (context.nowTs - this.lastForceTradeTs < intervalMs) return { fired: false, mode: "none" };
    const candidate =
      markets.length > 0
        ? markets[0]
        : selectedMarket && toMs(selectedMarket.endTs) > context.nowTs
          ? selectedMarket
          : null;
    if (!candidate && discovery.windowsCount <= 0) {
      if (!allowSmokeForceTrade) {
        this.logger.info(
          {
            action: "HOLD",
            reason: "NO_WINDOWS",
            windowsCount: discovery.windowsCount,
            forceTrade: this.config.polymarket.paper.forceTrade,
            polyForceTradeEnv: process.env.POLY_FORCE_TRADE ?? null
          },
          "POLY_FORCE_TRADE_DISABLED"
        );
        return { fired: false, mode: "none" };
      }
      const firstPositive = (rows: typeof discovery.fallbackWindowSamples) => {
        const positive = rows
          .filter((row) => Number.isFinite(row.remainingSec) && row.remainingSec > 0)
          .sort((a, b) => a.remainingSec - b.remainingSec);
        return positive[0] ?? null;
      };
      const timeFirstFallback = firstPositive(discovery.timeFirstWindowSamples);
      const anyActiveFallback = firstPositive(discovery.fallbackWindowSamples);
      const fallback = timeFirstFallback ?? anyActiveFallback ?? discovery.fallbackWindowSamples[0] ?? null;
      const fallbackSource = timeFirstFallback
        ? "time_first_filtered"
        : anyActiveFallback
          ? "active_any"
          : "none";
      const fallbackSlug = String(fallback?.slug || "forced-smoke").trim() || "forced-smoke";
      const fallbackMarketId =
        String(fallback?.marketId || `force-smoke-${context.nowTs}`).trim() || `force-smoke-${context.nowTs}`;
      const forcedRemainingSec = 120;
      const windowStartTs = Math.max(0, context.nowTs - 60_000);
      const windowEndTs = context.nowTs + forcedRemainingSec * 1000;
      const configuredSide = this.config.polymarket.paper.forceSide;
      const side: "YES" | "NO" = configuredSide === "NO" ? "NO" : "YES";
      const yesTokenId = `${fallbackMarketId}:YES`;
      const noTokenId = `${fallbackMarketId}:NO`;
      const entryPrice = 0.5;
      const requestedNotionalUsd = Math.max(0.5, this.config.polymarket.paper.forceNotional || 1);
      const tradesLastHour = this.paperLedger.countTradesSince(context.nowTs - 60 * 60 * 1000);
      if (tradesLastHour >= this.config.polymarket.paper.maxTradesPerHour) {
        return { fired: false, mode: "none" };
      }
      const qty = requestedNotionalUsd / entryPrice;
      const feesUsd = requestedNotionalUsd * (this.config.polymarket.paper.feeBps / 10_000);
      const trade = this.paperLedger.recordTrade({
        marketId: fallbackMarketId,
        marketSlug: fallbackSlug,
        windowStartTs,
        windowEndTs,
        side,
        entryPrice,
        qty,
        notionalUsd: requestedNotionalUsd,
        feeBps: this.config.polymarket.paper.feeBps,
        slippageBps: this.config.polymarket.paper.slippageBps,
        feesUsd,
        entryCostUsd: requestedNotionalUsd,
        priceToBeat: 0.5,
        yesTokenId,
        noTokenId,
        heldTokenId: side === "YES" ? yesTokenId : noTokenId,
        createdTs: context.nowTs
      });
      const openSummary = this.paperLedger.getSummary(context.nowTs);
      this.writePaperTradeLog({
        ts: new Date(context.nowTs).toISOString(),
        event: "TRADE_OPEN",
        entryStyle: "FORCED_SMOKE_TEST",
        tradeId: trade.id,
        marketId: trade.marketId,
        marketSlug: trade.marketSlug || null,
        side: trade.side,
        entryPrice: trade.entryPrice,
        qty: trade.qty,
        notionalUsd: trade.notionalUsd,
        feesUsd: trade.feesUsd,
        edge: 0,
        pBase: null,
        pBoosted: null,
        boostApplied: false,
        boostReason: null,
        forceMode: "smoke",
        syntheticRemainingSec: forcedRemainingSec,
        resolutionSource: "forced_smoke_test",
        closeReason: "FORCED_SMOKE_TEST",
        cumulativePnlUsd: openSummary.totalPnlUsd,
        wins: openSummary.wins,
        losses: openSummary.losses,
        winRate: openSummary.winRate
      });
      this.emitPolymarketTruth({
        ts: context.nowTs,
        force: true,
        action: "OPEN",
        tradeId: trade.id,
        slug: trade.marketSlug || null
      });
      const resolved = this.paperLedger.resolveTrade({
        tradeId: trade.id,
        resolvedAt: context.nowTs,
        outcome: trade.side === "YES" ? "UP" : "DOWN",
        payoutUsd: requestedNotionalUsd + feesUsd,
        pnlUsd: 0,
        resolutionSource: "DERIVED_FALLBACK"
      });
      if (resolved) {
        this.validateResolvedPaperSettlement(resolved);
        const summary = this.paperLedger.getSummary(context.nowTs);
        this.writePaperTradeLog({
          ts: new Date(context.nowTs).toISOString(),
          event: "TRADE_RESOLVED",
          tradeId: resolved.id,
          marketId: resolved.marketId,
          marketSlug: resolved.marketSlug || null,
          side: resolved.side,
          winner: resolved.side,
          finalOraclePrice: null,
          exitPayoutUsd: requestedNotionalUsd + feesUsd,
          pnlUsd: 0,
          oracleAtEnd: undefined,
          resolutionSource: "forced_smoke_test",
          closeReason: "FORCED_SMOKE_TEST",
          result: "FLAT",
          cumulativePnlUsd: summary.totalPnlUsd,
          wins: summary.wins,
          losses: summary.losses,
          winRate: summary.winRate
        });
        this.emitPolymarketTruth({
          ts: context.nowTs,
          force: true,
          action: "RESOLVE",
          tradeId: resolved.id,
          slug: resolved.marketSlug || null
        });
      }
      this.lastForceTradeTs = context.nowTs;
      this.logger.warn(
        {
          action: "FORCE_TRADE",
          mode: "smoke",
          reason:
            discovery.windowsCount <= 0
              ? "NO_WINDOWS_TIME_FIRST_EMPTY"
              : "NO_SELECTED_CANDIDATE",
          fallbackSource,
          marketId: fallbackMarketId,
          selectedSlug: fallbackSlug,
          remainingSec: forcedRemainingSec,
          entryPrice,
          notionalUsd: requestedNotionalUsd
        },
        "Forced smoke paper trade executed"
      );
      return { fired: true, mode: "smoke" };
    }
    if (!candidate) return { fired: false, mode: "none" };
    if (!(candidate.priceToBeat > 0)) {
      this.logger.info(
        {
          marketId: candidate.marketId,
          selectedSlug: candidate.eventSlug || null
        },
        "forceTrade skipped: missing priceToBeat"
      );
      return { fired: false, mode: "none" };
    }

    if (!candidate.acceptingOrders) {
      this.logger.info(
        {
          marketId: candidate.marketId,
          selectedSlug: candidate.eventSlug || null
        },
        "forceTrade skipped: not accepting orders"
      );
      return { fired: false, mode: "none" };
    }

    const market = candidate;
    const marketEndMs = toMs(market.endTs);
    const tauSec = Math.max(0, Math.floor((marketEndMs - context.nowTs) / 1000));
    if (tauSec <= 0) return { fired: false, mode: "none" };

    const implied = await this.getImpliedYesBook(market);
    const shortReturn = this.computeShortReturn(context.nowTs, 45);
    const realizedVolPricePerSqrtSec = this.computeRealizedVolPricePerSqrtSec(
      context.nowTs,
      context.oracleEst,
      context.sigmaPricePerSqrtSec,
      300
    );
    const prob = this.probModel.computeAdaptive({
      oracleEst: context.oracleEst,
      priceToBeat: market.priceToBeat,
      tauSec,
      cadenceSec: this.config.polymarket.marketQuery.cadenceMinutes * 60,
      shortReturn,
      realizedVolPricePerSqrtSec
    });
    const decision = this.strategy.decide({
      pUpModel: prob.pUpModel,
      orderBook: {
        marketId: market.marketId,
        tokenId: market.yesTokenId,
        yesBid: implied.yesBid,
        yesAsk: implied.yesAsk,
        yesMid: implied.yesMid,
        spread: implied.spread,
        bids: [],
        asks: [],
        ts: context.nowTs
      },
      sigmaPerSqrtSec: context.sigmaPerSqrtSec,
      tauSec
    });

    const configured = this.config.polymarket.paper.forceSide;
    const edgeYes = prob.pUpModel - implied.yesAsk;
    let noAsk = estimateNoAskFromYesBook(implied.yesBid);
    if (market.noTokenId) {
      noAsk = await this.getNoAskFromTokenId(market.noTokenId, noAsk);
    }
    const edgeNo = (1 - prob.pUpModel) - noAsk;
    const costPenaltyProb =
      (this.config.polymarket.paper.feeBps + this.config.polymarket.paper.slippageBps) / 10_000 +
      Math.max(0, implied.spread) / 2;
    const netYes = edgeYes - costPenaltyProb;
    const netNo = edgeNo - costPenaltyProb;
    const side =
      configured === "AUTO"
        ? Number.isFinite(netYes) && Number.isFinite(netNo)
          ? netYes >= netNo
            ? "YES"
            : "NO"
          : "YES"
        : configured;
    const forceRequestedNotionalUsd = Math.max(0, this.config.polymarket.paper.forceNotional);
    const forceOpenNotional = this.paperLedger.getOpenNotionalForMarket(market.marketId);
    const forceRemainingWindowNotional = Math.max(
      0,
      this.config.polymarket.paper.maxNotionalPerWindow - forceOpenNotional
    );
    const projectedOrderNotionalUsd = Math.min(forceRequestedNotionalUsd, forceRemainingWindowNotional);
    if (!(projectedOrderNotionalUsd > 0)) return { fired: false, mode: "none" };
    const forceTotalExposureUsd = this.paperLedger
      .getOpenTrades()
      .reduce((sum, row) => sum + row.entryCostUsd + row.feesUsd, 0);
    const forceConcurrentWindows = new Set(
      this.paperLedger.getOpenTrades().map((row) => row.marketId)
    ).size;
    const forceRiskCheck = this.risk.checkNewOrder({
      tauSec,
      oracleAgeMs: 0,
      projectedOrderNotionalUsd,
      openOrders: 0,
      totalExposureUsd: forceTotalExposureUsd,
      concurrentWindows: forceConcurrentWindows
    });
    if (!forceRiskCheck.ok) return { fired: false, mode: "none" };

    const accepted = this.executePaperTrade({
      marketId: market.marketId,
      marketSlug: market.eventSlug || market.slug,
      windowStartTs:
        toMs(market.startTs) ||
        Math.max(0, marketEndMs - this.config.polymarket.marketQuery.cadenceMinutes * 60_000),
      windowEndTs: marketEndMs,
      priceToBeat: market.priceToBeat,
      side,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      yesBid: implied.yesBid,
      yesAsk: implied.yesAsk,
      noAsk,
      edge: decision.netEdgeAfterCosts,
      requestedNotionalUsd: projectedOrderNotionalUsd,
      ts: context.nowTs,
      forced: true
    });
    if (!accepted) return { fired: false, mode: "none" };

    this.lastForceTradeTs = context.nowTs;
    this.logger.info(
      {
        marketId: market.marketId,
        side,
        notionalUsd: this.config.polymarket.paper.forceNotional,
        intervalSec: this.config.polymarket.paper.forceIntervalSec
      },
      "PAPER FORCE TRADE CREATED"
    );
    return { fired: true, mode: "normal" };
  }

  private applyWindowState(
    market: {
      marketId: string;
      slug: string;
      question: string;
      priceToBeat: number;
      endTs: number;
      startTs?: number;
      yesTokenId: string;
      noTokenId?: string;
      tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
      negRisk?: boolean;
      acceptingOrders: boolean;
      enableOrderBook?: boolean;
      closed?: boolean;
      eventSlug?: string;
      yesBidHint?: number;
      yesAskHint?: number;
      yesMidHint?: number;
      yesLastTradeHint?: number;
      outcomePricesHint?: number[];
    },
    nowTs: number,
    oracleEst?: number
  ): {
    marketId: string;
    slug: string;
    question: string;
    priceToBeat: number;
    endTs: number;
    startTs?: number;
    yesTokenId: string;
    noTokenId?: string;
    tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
    negRisk?: boolean;
    acceptingOrders: boolean;
    enableOrderBook?: boolean;
    closed?: boolean;
    eventSlug?: string;
    yesBidHint?: number;
    yesAskHint?: number;
    yesMidHint?: number;
    yesLastTradeHint?: number;
    outcomePricesHint?: number[];
  } {
    const key = String(market.eventSlug || market.slug || market.marketId).trim();
    if (!key) return market;

    const fallbackStart = this.roundDownToCadence(nowTs);
    const startInputMs = toMs(market.startTs);
    const startMs = startInputMs > 0 ? startInputMs : fallbackStart;
    const endMs = toMs(market.endTs);
    const previousState = this.windowStateBySlug.get(key);
    let state = previousState;
    if (!state || state.windowEndMs !== endMs || state.windowStartMs !== startMs) {
      state = {
        windowStartMs: startMs,
        windowEndMs: endMs,
        priceToBeat:
          previousState && previousState.windowEndMs >= nowTs - 60_000 && previousState.priceToBeat
            ? previousState.priceToBeat
            : undefined,
        priceToBeatTs: previousState?.priceToBeatTs
      };
      this.windowStateBySlug.set(key, state);
    }

    if (!(state.priceToBeat && state.priceToBeat > 0) && market.priceToBeat > 0) {
      state.priceToBeat = market.priceToBeat;
      state.priceToBeatTs = nowTs;
    }

    if (!(state.priceToBeat && state.priceToBeat > 0)) {
      if (nowTs < state.windowStartMs) {
        if (!state.waitingLogged) {
          this.logger.info(
            {
              slug: key,
              windowStartMs: state.windowStartMs,
              windowEndMs: state.windowEndMs,
              nowMs: nowTs
            },
            "waiting for windowStart"
          );
          state.waitingLogged = true;
        }
      } else if (oracleEst && oracleEst > 0) {
        state.priceToBeat = oracleEst;
        state.priceToBeatTs = nowTs;
        state.waitingLogged = false;
        this.logger.info(
          {
            slug: key,
            priceToBeat: state.priceToBeat,
            windowStartMs: state.windowStartMs,
            capturedTs: nowTs
          },
          "Captured priceToBeat"
        );
      }
    }

    return {
      ...market,
      startTs: state.windowStartMs,
      endTs: state.windowEndMs,
      priceToBeat: state.priceToBeat && state.priceToBeat > 0 ? state.priceToBeat : market.priceToBeat
    };
  }

  private pruneOldWindowState(nowTs: number): void {
    const minKeepEndTs = nowTs - 2 * 60 * 60 * 1000;
    for (const [key, state] of this.windowStateBySlug.entries()) {
      if (state.windowEndMs < minKeepEndTs) {
        this.windowStateBySlug.delete(key);
      }
    }
  }

  private roundDownToCadence(ts: number): number {
    const cadenceMs = Math.max(1, this.config.polymarket.marketQuery.cadenceMinutes) * 60_000;
    return Math.floor(ts / cadenceMs) * cadenceMs;
  }

  private isInsidePaperEntryWindow(remainingSec: number): boolean {
    if (!Number.isFinite(remainingSec)) return false;
    return (
      remainingSec >= this.config.polymarket.paper.entryMinRemainingSec &&
      remainingSec <= this.config.polymarket.paper.entryMaxRemainingSec
    );
  }

  private getCachedYesBookSnapshot(marketId: string, nowTs: number): YesBookSnapshot | null {
    const cached = this.latestYesBookByMarketId.get(marketId);
    if (!cached) return null;
    const maxAgeMs = Math.max(30_000, this.config.polymarket.risk.staleMs * 4);
    if (cached.bookTs <= 0 || nowTs - cached.bookTs > maxAgeMs) {
      this.latestYesBookByMarketId.delete(marketId);
      return null;
    }
    return cached;
  }

  private cacheYesBookSnapshot(marketId: string, snapshot: YesBookSnapshot): void {
    this.latestYesBookByMarketId.set(marketId, snapshot);
    const maxEntries = 200;
    if (this.latestYesBookByMarketId.size <= maxEntries) return;
    const oldest = this.latestYesBookByMarketId.keys().next().value;
    if (typeof oldest === "string") {
      this.latestYesBookByMarketId.delete(oldest);
    }
  }

  private getCachedTokenBookSnapshot(tokenId: string, nowTs: number): TokenBookSnapshot | null {
    const normalizedTokenId = String(tokenId || "").trim();
    if (!normalizedTokenId) return null;
    const cached = this.latestTokenBookByTokenId.get(normalizedTokenId);
    if (!cached) return null;
    const maxAgeMs = Math.max(30_000, this.config.polymarket.risk.staleMs * 4);
    if (cached.bookTs <= 0 || nowTs - cached.bookTs > maxAgeMs) {
      this.latestTokenBookByTokenId.delete(normalizedTokenId);
      return null;
    }
    return cached;
  }

  private cacheTokenBookSnapshot(
    tokenId: string,
    snapshot: {
      bestBid?: number | null;
      bestAsk?: number | null;
      bookTs?: number | null;
      markSource?: string | null;
    }
  ): void {
    const normalizedTokenId = String(tokenId || "").trim();
    if (!normalizedTokenId) return;
    const previous = this.latestTokenBookByTokenId.get(normalizedTokenId) || null;
    const hasFreshBid = Number.isFinite(Number(snapshot.bestBid)) && Number(snapshot.bestBid) > 0;
    const hasFreshAsk = Number.isFinite(Number(snapshot.bestAsk)) && Number(snapshot.bestAsk) > 0;
    const nextBestBid = hasFreshBid
      ? clamp(Number(snapshot.bestBid), 0.0001, 0.9999)
      : previous?.bestBid ?? null;
    const nextBestAsk = hasFreshAsk
      ? clamp(Number(snapshot.bestAsk), 0.0001, 0.9999)
      : previous?.bestAsk ?? null;
    const nextBookTs = Number.isFinite(Number(snapshot.bookTs)) && Number(snapshot.bookTs) > 0
      ? Math.floor(Number(snapshot.bookTs))
      : previous?.bookTs ?? Date.now();
    const usedCachedSide =
      Boolean(previous) && ((!hasFreshBid && previous?.bestBid !== null) || (!hasFreshAsk && previous?.bestAsk !== null));
    const nextMark =
      nextBestBid !== null && nextBestAsk !== null
        ? clamp((nextBestBid + nextBestAsk) / 2, Math.min(nextBestBid, nextBestAsk), Math.max(nextBestBid, nextBestAsk))
        : nextBestBid !== null
          ? nextBestBid
          : nextBestAsk !== null
            ? nextBestAsk
            : previous?.mark ?? null;
    const baseMarkSource =
      nextBestBid !== null && nextBestAsk !== null
        ? "MID"
        : nextBestBid !== null
          ? "BID_FALLBACK"
          : nextBestAsk !== null
            ? "ASK_FALLBACK"
            : previous?.markSource ?? (snapshot.markSource || null);
    const nextMarkSource =
      nextMark !== null && usedCachedSide ? prefixCachedMarkSource(baseMarkSource) : baseMarkSource;
    this.latestTokenBookByTokenId.set(normalizedTokenId, {
      tokenId: normalizedTokenId,
      bestBid: nextBestBid,
      bestAsk: nextBestAsk,
      mark: nextMark,
      markSource: nextMarkSource,
      bookTs: nextBookTs
    });
    const maxEntries = 400;
    if (this.latestTokenBookByTokenId.size <= maxEntries) return;
    const oldest = this.latestTokenBookByTokenId.keys().next().value;
    if (typeof oldest === "string") {
      this.latestTokenBookByTokenId.delete(oldest);
    }
  }

  private async getImpliedYesBook(market: {
    marketId: string;
    yesTokenId: string;
    yesBidHint?: number;
    yesAskHint?: number;
    yesMidHint?: number;
    yesLastTradeHint?: number;
    outcomePricesHint?: number[];
  },
  options: {
    isSelectedMarket?: boolean;
    remainingSec?: number;
  } = {}
  ): Promise<{
    yesBid: number;
    yesAsk: number;
    yesMid: number;
    spread: number;
    topBidSize: number;
    topAskSize: number;
    bookTs: number;
  }> {
    const nowTs = Date.now();
    const remainingSec = Number(options.remainingSec);
    const shouldPreferCachedSnapshot =
      Boolean(options.isSelectedMarket) && this.isInsidePaperEntryWindow(remainingSec);
    const cachedSnapshot = shouldPreferCachedSnapshot
      ? this.getCachedYesBookSnapshot(market.marketId, nowTs)
      : null;
    try {
      const orderBook = await this.client.getYesOrderBook(market.marketId, market.yesTokenId);
      if (orderBook.yesAsk >= orderBook.yesBid && orderBook.yesAsk > 0 && orderBook.yesBid >= 0) {
        const snapshot = {
          yesBid: clamp(orderBook.yesBid, 0, 1),
          yesAsk: clamp(orderBook.yesAsk, Math.max(0, orderBook.yesBid), 1),
          yesMid: clamp(orderBook.yesMid, 0, 1),
          spread: Math.max(0, orderBook.yesAsk - orderBook.yesBid),
          topBidSize: Math.max(0, Number(orderBook.bids?.[0]?.size || 0)),
          topAskSize: Math.max(0, Number(orderBook.asks?.[0]?.size || 0)),
          bookTs: toMs(orderBook.ts || nowTs)
        } satisfies YesBookSnapshot;
        this.cacheYesBookSnapshot(market.marketId, snapshot);
        this.cacheTokenBookSnapshot(market.yesTokenId, {
          bestBid: orderBook.bids.length > 0 ? Number(orderBook.bids[0]?.price || 0) : null,
          bestAsk: orderBook.asks.length > 0 ? Number(orderBook.asks[0]?.price || 0) : null,
          bookTs: snapshot.bookTs,
          markSource: "MID"
        });
        return snapshot;
      }
      if (cachedSnapshot) {
        return cachedSnapshot;
      }
    } catch (error) {
      const transient = isTransientPolymarketError(error);
      if (!transient || !cachedSnapshot) {
        this.setTradingPaused(true, "NETWORK_ERROR", nowTs);
      }
      this.logger.warn(
        {
          marketId: market.marketId,
          tokenId: market.yesTokenId,
          remainingSec: Number.isFinite(remainingSec) ? remainingSec : null,
          selectedMarket: Boolean(options.isSelectedMarket),
          usedCachedSnapshot: Boolean(cachedSnapshot),
          transient,
          error: error instanceof Error ? error.message : String(error)
        },
        "Failed to fetch YES orderbook; using fallback implied prices"
      );
      if (cachedSnapshot) {
        return cachedSnapshot;
      }
    }

    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    const hintedMid =
      (Number.isFinite(Number(market.yesMidHint)) ? Number(market.yesMidHint) : 0) ||
      (Number.isFinite(Number(market.yesLastTradeHint)) ? Number(market.yesLastTradeHint) : 0) ||
      (Array.isArray(market.outcomePricesHint) && market.outcomePricesHint.length > 0
        ? Number(market.outcomePricesHint[0] || 0)
        : 0);
    const hintedBid = Number.isFinite(Number(market.yesBidHint)) ? Number(market.yesBidHint) : 0;
    const hintedAsk = Number.isFinite(Number(market.yesAskHint)) ? Number(market.yesAskHint) : 0;

    const fallbackMid = clamp(hintedMid > 0 ? hintedMid : 0.5, 0.01, 0.99);
    const yesBid = clamp(hintedBid > 0 ? hintedBid : fallbackMid - 0.01, 0, 1);
    const yesAsk = clamp(hintedAsk > 0 ? hintedAsk : fallbackMid + 0.01, yesBid, 1);
    return {
      yesBid,
      yesAsk,
      yesMid: (yesBid + yesAsk) / 2,
      spread: Math.max(0, yesAsk - yesBid),
      topBidSize: 0,
      topAskSize: 0,
      bookTs: toMs(nowTs)
    };
  }

  private async getNoBookFromTokenId(tokenId: string): Promise<{
    bestBid: number | null;
    bestAsk: number | null;
    topBidSize: number;
    topAskSize: number;
    bookTs: number;
  } | null> {
    try {
      const noBook = await this.client.getTokenOrderBook(tokenId);
      const bestBid = noBook.bids.length > 0 ? clamp(Number(noBook.bids[0]?.price || 0), 0.0001, 0.9999) : null;
      const bestAsk = noBook.asks.length > 0 ? clamp(Number(noBook.asks[0]?.price || 0), 0.0001, 0.9999) : null;
      const bookTs = toMs(noBook.ts || Date.now());
      this.cacheTokenBookSnapshot(tokenId, {
        bestBid,
        bestAsk,
        bookTs,
        markSource: bestBid !== null && bestAsk !== null ? "MID" : bestBid !== null ? "BID_FALLBACK" : "ASK_FALLBACK"
      });
      return {
        bestBid,
        bestAsk,
        topBidSize: Math.max(0, Number(noBook.bids?.[0]?.size || 0)),
        topAskSize: Math.max(0, Number(noBook.asks?.[0]?.size || 0)),
        bookTs
      };
    } catch (error) {
      const transient = isTransientPolymarketError(error);
      if (!transient) {
        this.setTradingPaused(true, "NETWORK_ERROR", Date.now());
      }
      this.logger.warn(
        {
          tokenId,
          transient,
          error: error instanceof Error ? error.message : String(error)
        },
        "Failed to fetch NO orderbook; using inferred NO prices"
      );
    }
    return null;
  }

  private async getNoAskFromTokenId(tokenId: string, fallbackNoAsk: number): Promise<number> {
    const noBook = await this.getNoBookFromTokenId(tokenId);
    if (noBook && noBook.bestAsk !== null && noBook.bestAsk > 0) {
      return clamp(noBook.bestAsk, 0.0001, 0.9999);
    }
    return clamp(fallbackNoAsk, 0.0001, 0.9999);
  }

  private async getNoBidFromTokenId(tokenId: string, fallbackNoBid: number): Promise<number> {
    const noBook = await this.getNoBookFromTokenId(tokenId);
    if (noBook && noBook.bestBid !== null && noBook.bestBid > 0) {
      return clamp(noBook.bestBid, 0.0001, 0.9999);
    }
    return clamp(fallbackNoBid, 0.0001, 0.9999);
  }

  private async getNoAskAndDepthFromTokenId(
    tokenId: string,
    fallbackNoAsk: number
  ): Promise<{ noAsk: number; topAskSize: number }> {
    const noBook = await this.getNoBookFromTokenId(tokenId);
    if (!noBook) {
      return {
        noAsk: clamp(fallbackNoAsk, 0.0001, 0.9999),
        topAskSize: 0
      };
    }
    return {
      noAsk: clamp(noBook.bestAsk !== null && noBook.bestAsk > 0 ? noBook.bestAsk : fallbackNoAsk, 0.0001, 0.9999),
      topAskSize: Math.max(0, noBook.topAskSize)
    };
  }

  private canMutateVenueState(): boolean {
    if (this.config.polymarket.killSwitch) return false;
    if (this.config.polymarket.mode !== "live") return true;
    return this.config.polymarket.liveConfirmed && this.config.polymarket.liveExecutionEnabled;
  }

  private async fetchAttempt(nowTs: number): Promise<void> {
    const disabledReason = this.getFetchDisabledReason();
    if (disabledReason) {
      this.client.recordFetchDisabled(disabledReason);
      if (nowTs - this.lastFetchDisabledLogTs >= 30_000) {
        this.lastFetchDisabledLogTs = nowTs;
        this.logger.warn(
          {
            fetchEnabled: false,
            reason: disabledReason
          },
          "Polymarket fetch disabled by config"
        );
      }
      const ingestion = this.client.getIngestionTelemetry();
      this.polyState.lastFetchAttemptTs = ingestion.lastFetchAttemptTs;
      this.polyState.lastFetchErr = ingestion.lastFetchErr;
      this.polyState.lastHttpStatus = ingestion.lastHttpStatus;
      return;
    }

    try {
      await this.client.listMarketsPage({
        limit: 1,
        active: true,
        closed: false,
        archived: false
      });
    } catch {
      // Keep this best-effort; scan and later tick logs still surface detailed failures.
    } finally {
      const ingestion = this.client.getIngestionTelemetry();
      this.polyState.lastFetchAttemptTs = ingestion.lastFetchAttemptTs;
      this.polyState.lastFetchOkTs = ingestion.lastFetchOkTs;
      this.polyState.lastFetchErr = ingestion.lastFetchErr;
      this.polyState.lastHttpStatus = ingestion.lastHttpStatus;
      if (ingestion.lastFetchOkTs > 0) {
        this.polyState.latestPolymarketTs = ingestion.lastFetchOkTs;
        if (!this.latestPolymarketSnapshot) {
          this.latestPolymarketSnapshot = {
            ts: ingestion.lastFetchOkTs,
            windowSlug: "fetch_attempt",
            tauSec: null,
            priceToBeat: null,
            fastMid: null,
            yesMid: null,
            impliedProbMid: null
          };
        } else {
          this.latestPolymarketSnapshot.ts = ingestion.lastFetchOkTs;
        }
      }
      this.polyEngineRunning = this.polyState.lastFetchAttemptTs > 0;
    }
  }

  private getFetchDisabledReason(): string | null {
    if (this.config.polymarket.fetchEnabled) {
      return null;
    }
    return "POLYMARKET_FETCH_ENABLED=false";
  }

  private maybeLogNoWindowsCandidates(params: {
    nowMs: number;
    stageCounts: {
      fetchedCount: number;
      afterActiveCount: number;
      afterSearchCount: number;
      afterWindowCount: number;
      afterPatternCount: number;
      finalCandidatesCount: number;
    };
    samples: Array<{
      marketId: string;
      slug: string;
      windowStartField: string | null;
      windowStartParseNote: string | null;
      windowStartRaw: string;
      windowStartTsMs: number;
      windowEndField: string | null;
      windowEndParseNote: string | null;
      windowEndRaw: string;
      windowEndTsMs: number;
      nowTsMs: number;
      remainingSec: number;
      passWindow: boolean;
      rejectReason?: string;
    }>;
    windowRejectCounters: WindowRejectCounters;
    forcedSlug: string | null;
    minWindowSec: number;
    maxWindowSec: number;
  }): void {
    const discoveredCandidates = Math.max(
      0,
      params.stageCounts.afterSearchCount,
      params.stageCounts.afterActiveCount,
      params.stageCounts.fetchedCount
    );
    if (!(discoveredCandidates > 0 && params.stageCounts.afterWindowCount <= 0)) {
      this.noWindowsConsecutiveTicks = 0;
      return;
    }
    this.noWindowsConsecutiveTicks += 1;
    const histogram = {
      "<0": 0,
      "0-60": 0,
      "60-300": 0,
      "300-1800": 0,
      "1800-7200": 0,
      ">7200": 0,
      invalid: 0
    };
    const positiveRemaining: Array<{
      slug: string;
      marketId: string;
      rawWindowEndTs: string;
      windowEndMs: number;
      remainingSec: number;
      reason: string;
    }> = [];
    for (const row of params.samples) {
      const windowEndMs = toMs(row.windowEndTsMs);
      const remainingSec = Number.isFinite(Number(row.remainingSec))
        ? Math.floor(Number(row.remainingSec))
        : Number.isFinite(windowEndMs)
          ? Math.floor((windowEndMs - params.nowMs) / 1000)
          : Number.NaN;
      if (!Number.isFinite(remainingSec)) {
        histogram.invalid += 1;
      } else if (remainingSec < 0) {
        histogram["<0"] += 1;
      } else if (remainingSec <= 60) {
        histogram["0-60"] += 1;
      } else if (remainingSec <= 300) {
        histogram["60-300"] += 1;
      } else if (remainingSec <= 1_800) {
        histogram["300-1800"] += 1;
      } else if (remainingSec <= 7_200) {
        histogram["1800-7200"] += 1;
      } else {
        histogram[">7200"] += 1;
      }
      if (remainingSec > 0) {
        positiveRemaining.push({
          slug: row.slug,
          marketId: row.marketId,
          rawWindowEndTs: row.windowEndRaw,
          windowEndMs,
          remainingSec,
          reason: normalizeWindowRejectBucket(row.rejectReason)
        });
      }
    }
    positiveRemaining.sort((a, b) => a.remainingSec - b.remainingSec);
    const smallestPositiveSample = positiveRemaining.slice(0, 5);
    const rejectSample = params.samples
      .filter((row) => !row.passWindow)
      .slice(0, 5)
      .map((row) => ({
        slug: row.slug,
        marketId: row.marketId,
        rawWindowEndTs: row.windowEndRaw,
        windowEndMs: toMs(row.windowEndTsMs),
        remainingSec: Number.isFinite(Number(row.remainingSec))
          ? Math.floor(Number(row.remainingSec))
          : Math.floor((toMs(row.windowEndTsMs) - params.nowMs) / 1000),
        reason: normalizeWindowRejectBucket(row.rejectReason)
      }));
    const nowIso = new Date(params.nowMs).toISOString();
    const rejectSummary = formatWindowRejectSummaryFromCounters(params.windowRejectCounters);
    this.logger.warn(
      {
        nowIso,
        nowMs: params.nowMs,
        minRemainingSec: params.minWindowSec,
        maxRemainingSec: params.maxWindowSec,
        candidates: discoveredCandidates,
        windows: params.stageCounts.afterWindowCount,
        buckets: histogram,
        smallestPositiveSample
      },
      "POLY_WINDOW_HIST"
    );
    this.logger.warn(
      {
        nowIso,
        nowMs: params.nowMs,
        minRemainingSec: params.minWindowSec,
        maxRemainingSec: params.maxWindowSec,
        sample: rejectSample
      },
      "POLY_WINDOW_REJECT_SAMPLE"
    );
    const dominantReason = computeDominantWindowRejectReason(params.windowRejectCounters);
    this.logger.warn(
      {
        nowIso,
        nowMs: params.nowMs,
        minRemainingSec: params.minWindowSec,
        maxRemainingSec: params.maxWindowSec,
        candidates: discoveredCandidates,
        windows: params.stageCounts.afterWindowCount,
        windowReject: rejectSummary,
        windowRejectCounts: { ...params.windowRejectCounters },
        dominantReason,
        noWindowsConsecutiveTicks: this.noWindowsConsecutiveTicks,
        forcedSlug: params.forcedSlug || null
      },
      "POLY_NO_WINDOWS"
    );
  }

  private matchesForceSlug(
    market: { slug?: string; eventSlug?: string; question?: string; marketId?: string },
    forceSlug: string
  ): boolean {
    const needle = String(forceSlug || "").trim().toLowerCase();
    if (!needle) return false;
    const values = [market.eventSlug, market.slug, market.question, market.marketId]
      .map((row) => String(row || "").trim().toLowerCase())
      .filter((row) => row.length > 0);
    if (values.some((row) => row === needle)) return true;
    return values.some((row) => row.includes(needle));
  }

  private maybeEmitTickLog(input: TickLogLine): void {
    const tickTs = this.getTickTimestamp(input.now);
    this.polyState.lastUpdateTs = Math.max(this.polyState.lastUpdateTs, tickTs);
    this.polyEngineRunning = this.polyState.lastFetchAttemptTs > 0;
    const defaultWindowCfg = this.scanner.getPrimaryWindowConfig();
    const selectionRollover = this.isSelectionRollover(input);
    if (tickTs - this.lastTickLogTs < 30_000) {
    const line: TickLogLine = {
      ...input,
      tradingPaused: input.tradingPaused ?? this.tradingPaused,
      pauseReason: input.pauseReason ?? (this.pauseReason || null),
      pauseSinceTs: input.pauseSinceTs ?? this.pauseSinceTs,
      lastFetchAttemptTs: input.lastFetchAttemptTs ?? this.polyState.lastFetchAttemptTs,
      lastFetchOkTs: input.lastFetchOkTs ?? this.polyState.lastFetchOkTs,
      lastFetchErr: input.lastFetchErr ?? this.polyState.lastFetchErr,
      lastHttpStatus: input.lastHttpStatus ?? this.polyState.lastHttpStatus,
      rejectCountsByStage:
        input.rejectCountsByStage
          ? cloneRejectCountsByStage(input.rejectCountsByStage)
          : cloneRejectCountsByStage(this.polyState.rejectCountsByStage),
      dominantReject:
        input.dominantReject !== undefined
          ? input.dominantReject
          : selectionRollover
            ? null
            : this.polyState.dominantReject,
      sampleRejected:
        input.sampleRejected && input.sampleRejected.length > 0
          ? input.sampleRejected.slice(0, 5).map((row) => ({ ...row }))
          : this.polyState.sampleRejected.slice(0, 5).map((row) => ({ ...row })),
      windowRejectCounters: input.windowRejectCounters
        ? { ...input.windowRejectCounters }
        : createWindowRejectCounters(),
      minWindowSec:
        Number.isFinite(Number(input.minWindowSec)) && Number(input.minWindowSec) > 0
          ? Math.floor(Number(input.minWindowSec))
          : defaultWindowCfg.minWindowSec,
      maxWindowSec:
        Number.isFinite(Number(input.maxWindowSec)) && Number(input.maxWindowSec) > 0
          ? Math.floor(Number(input.maxWindowSec))
          : defaultWindowCfg.maxWindowSec,
      acceptedSampleCount: Math.max(0, Math.floor(Number(input.acceptedSampleCount || 0))),
      forceTradeFired: Boolean(input.forceTradeFired),
      forceTradeMode: input.forceTradeMode ?? "none",
      holdDetailReason: input.holdDetailReason ?? (selectionRollover ? null : this.polyState.holdDetailReason)
    };
      const pausePresentation = this.getStatusPausePresentation(line.tradingPaused, line.pauseReason ?? null);
      line.tradingPaused = pausePresentation.tradingPaused;
      line.pauseReason = pausePresentation.pauseReason;
      line.warningState = pausePresentation.warningState;
      const actionRoot = this.getTickActionRoot(line.action);
      if (actionRoot === "HOLD") {
        line.holdReason = this.deriveCanonicalHoldReason(line) ?? line.holdReason ?? null;
        if ((line.holdReason === "NO_CANDIDATES" || line.holdReason === "NO_WINDOWS") && !line.holdDetailReason) {
          line.holdDetailReason = line.dominantReject ?? this.polyState.dominantReject;
        }
      } else {
        line.holdReason = null;
        line.holdDetailReason = null;
      }
      this.maybeWarnNoData(line.holdReason, tickTs);
      this.captureTruthStateFromTick(line);
      this.emitPolyStatusLine(line, tickTs);
      this.emitPolymarketTruth({
        ts: tickTs,
        force: false,
        action: actionRoot === "HOLD" && tickTs - this.truthLastActionTs >= 5_000 ? "HOLD" : undefined
      });
      return;
    }
      const line: TickLogLine = {
        ...input,
        tradingPaused: input.tradingPaused ?? this.tradingPaused,
        pauseReason: input.pauseReason ?? (this.pauseReason || null),
        pauseSinceTs: input.pauseSinceTs ?? this.pauseSinceTs,
        lastFetchAttemptTs: input.lastFetchAttemptTs ?? this.polyState.lastFetchAttemptTs,
        lastFetchOkTs: input.lastFetchOkTs ?? this.polyState.lastFetchOkTs,
        lastFetchErr: input.lastFetchErr ?? this.polyState.lastFetchErr,
        lastHttpStatus: input.lastHttpStatus ?? this.polyState.lastHttpStatus,
        rejectCountsByStage:
          input.rejectCountsByStage
            ? cloneRejectCountsByStage(input.rejectCountsByStage)
            : cloneRejectCountsByStage(this.polyState.rejectCountsByStage),
        dominantReject:
          input.dominantReject !== undefined
            ? input.dominantReject
            : selectionRollover
              ? null
              : this.polyState.dominantReject,
        sampleRejected:
          input.sampleRejected && input.sampleRejected.length > 0
            ? input.sampleRejected.slice(0, 5).map((row) => ({ ...row }))
            : this.polyState.sampleRejected.slice(0, 5).map((row) => ({ ...row })),
        windowRejectCounters: input.windowRejectCounters
          ? { ...input.windowRejectCounters }
          : createWindowRejectCounters(),
        minWindowSec:
          Number.isFinite(Number(input.minWindowSec)) && Number(input.minWindowSec) > 0
            ? Math.floor(Number(input.minWindowSec))
            : defaultWindowCfg.minWindowSec,
        maxWindowSec:
          Number.isFinite(Number(input.maxWindowSec)) && Number(input.maxWindowSec) > 0
            ? Math.floor(Number(input.maxWindowSec))
            : defaultWindowCfg.maxWindowSec,
        acceptedSampleCount: Math.max(0, Math.floor(Number(input.acceptedSampleCount || 0))),
        forceTradeFired: Boolean(input.forceTradeFired),
        forceTradeMode: input.forceTradeMode ?? "none",
        holdDetailReason: input.holdDetailReason ?? (selectionRollover ? null : this.polyState.holdDetailReason)
      };
    const pausePresentation = this.getStatusPausePresentation(line.tradingPaused, line.pauseReason ?? null);
    line.tradingPaused = pausePresentation.tradingPaused;
    line.pauseReason = pausePresentation.pauseReason;
    line.warningState = pausePresentation.warningState;
    const actionRoot = this.getTickActionRoot(line.action);
    if (actionRoot === "HOLD") {
      line.holdReason = this.deriveCanonicalHoldReason(line) ?? line.holdReason ?? null;
      if ((line.holdReason === "NO_CANDIDATES" || line.holdReason === "NO_WINDOWS") && !line.holdDetailReason) {
        line.holdDetailReason = line.dominantReject ?? this.polyState.dominantReject;
      }
    } else {
      line.holdReason = null;
      line.holdDetailReason = null;
    }
    this.maybeWarnNoData(line.holdReason, tickTs);
    this.captureTruthStateFromTick(line);
    this.emitPolyStatusLine(line, tickTs);
    this.lastTickLogTs = tickTs;
    if (this.debugPoly) {
      this.logger.info(line, "Polymarket tick");
    }
    const truthTs = tickTs;
    this.emitPolymarketTruth({
      ts: truthTs,
      force: false,
      action: actionRoot === "HOLD" && truthTs - this.truthLastActionTs >= 5_000 ? "HOLD" : undefined
    });
    appendFileSync(
      this.logPath,
      `${JSON.stringify({
        ts: new Date(truthTs).toISOString(),
        type: "tick",
        marketsSeen: line.marketsSeen,
        discoveredCandidates: line.discoveredCandidates ?? null,
        fetchedCount: line.fetchedCount ?? null,
        afterActiveCount: line.afterActiveCount ?? null,
        afterSearchCount: line.afterSearchCount ?? null,
        afterWindowCount: line.afterWindowCount ?? null,
        afterPatternCount: line.afterPatternCount ?? null,
        finalCandidatesCount: line.finalCandidatesCount ?? null,
        fallbackUsed: line.fallbackUsed ?? "none",
        selectedReason: line.selectedReason ?? null,
        selectedScore: line.selectedScore ?? null,
        holdReason: line.holdReason ?? null,
        holdDetailReason: line.holdDetailReason ?? null,
        dominantReject: line.dominantReject ?? null,
        windowReject: line.windowReject ?? null,
        minWindowSec: line.minWindowSec ?? null,
        maxWindowSec: line.maxWindowSec ?? null,
        minRemainingSec: line.minWindowSec ?? null,
        maxRemainingSec: line.maxWindowSec ?? null,
        acceptedSampleCount: line.acceptedSampleCount ?? 0,
        forceTradeFired: Boolean(line.forceTradeFired),
        forceTradeMode: line.forceTradeMode ?? "none",
        windowRejectCounters: line.windowRejectCounters ?? createWindowRejectCounters(),
        rejectCountsByStage: line.rejectCountsByStage ?? createRejectCountsByStage(),
        sampleRejected: line.sampleRejected ?? [],
        activeWindows: line.activeWindows,
        oracleEst: line.oracleEst,
        sigma: line.sigma,
        marketId: line.currentMarketId,
        slug: line.selectedSlug,
        tauSec: line.tauSec,
        priceToBeat: line.priceToBeat,
        yesBid: line.yesBid,
        yesAsk: line.yesAsk,
        yesMid: line.yesMid ?? null,
        pUp: line.pUpModel,
        pUpModel: line.pUpModel,
        pBase: line.pBase ?? null,
        pBoosted: line.pBoosted ?? null,
        z: line.z ?? null,
        d: line.d ?? null,
        sigmaCalibrated: line.sigmaCalibrated ?? null,
        polyUpdateAgeMs: line.polyUpdateAgeMs ?? null,
        lagPolyP90Ms: line.lagPolyP90Ms ?? null,
        boostApplied: line.boostApplied ?? false,
        boostReason: line.boostReason ?? null,
        edge: line.edge,
        edgeYes: line.edgeYes ?? null,
        edgeNo: line.edgeNo ?? null,
        chosenSide: line.chosenSide ?? null,
        chosenDirection: line.chosenDirection ?? null,
        chosenEdge: line.chosenEdge ?? null,
        conviction: line.conviction ?? null,
        stalenessEdge: line.stalenessEdge ?? null,
        netEdgeAfterCosts: line.netEdgeAfterCosts ?? null,
        threshold: line.threshold,
        size: line.size ?? null,
        openTrades: line.openTrades ?? 0,
        awaitingResolutionCount: line.awaitingResolutionCount ?? 0,
        resolutionQueueCount: line.resolutionQueueCount ?? line.awaitingResolutionCount ?? 0,
        resolvedTrades: line.resolvedTrades ?? 0,
        entriesInWindow: line.entriesInWindow ?? null,
        windowRealizedPnlUsd: line.windowRealizedPnlUsd ?? null,
        resolutionSource: line.resolutionSource ?? null,
        oracleSource: line.oracleSource ?? "none",
        oracleTs: line.oracleTs ?? null,
        oracleStaleMs: line.oracleStaleMs ?? null,
        oracleState: line.oracleState ?? "IDLE",
        lastFetchAttemptTs: line.lastFetchAttemptTs ?? 0,
        lastFetchOkTs: line.lastFetchOkTs ?? 0,
        lastFetchErr: line.lastFetchErr ?? null,
        lastHttpStatus: line.lastHttpStatus ?? 0,
        tradingPaused: line.tradingPaused ?? false,
        pauseReason: line.pauseReason ?? null,
        warningState: line.warningState ?? null,
        pauseSinceTs: line.pauseSinceTs ?? null,
        lastAction: line.action,
        selectedSlug: line.selectedSlug,
        windowStart: line.windowStart,
        windowEnd: line.windowEnd,
        acceptingOrders: line.acceptingOrders,
        enableOrderBook: line.enableOrderBook
      })}\n`,
      "utf8"
    );
  }

  private deriveCanonicalHoldReason(line: TickLogLine): string | null {
    const explicitHoldReason = String(line.holdReason || "")
      .trim()
      .toUpperCase();
    if (explicitHoldReason === "NO_ACTIVE_BTC5M_MARKET" || explicitHoldReason === "BTC5M_NOT_FOUND") {
      return "NO_ACTIVE_BTC5M_MARKET";
    }
    if (explicitHoldReason === "NO_NEW_ORDERS_FINAL_SECONDS") {
      return "NO_NEW_ORDERS_FINAL_SECONDS";
    }
    if (explicitHoldReason === "OPEN_POSITION_IN_WINDOW") return "OPEN_POSITION_IN_WINDOW";
    if (explicitHoldReason === "REENTRY_COOLDOWN") return "REENTRY_COOLDOWN";
    if (explicitHoldReason === "TOO_LATE_FOR_ENTRY") return "TOO_LATE_FOR_ENTRY";
    if (explicitHoldReason === "EXPIRED_WINDOW") {
      return "EXPIRED_WINDOW";
    }
    if (explicitHoldReason === "AWAITING_RESOLUTION") {
      return "AWAITING_RESOLUTION";
    }
    const detailReason = String(line.holdDetailReason || line.dominantReject || "")
      .trim()
      .toUpperCase();
    if (detailReason === "BTC5M_NOT_FOUND") {
      return "NO_ACTIVE_BTC5M_MARKET";
    }
    if (detailReason === "NO_NEW_ORDERS_FINAL_SECONDS") {
      return "NO_NEW_ORDERS_FINAL_SECONDS";
    }
    if (detailReason === "OPEN_POSITION_IN_WINDOW") return "OPEN_POSITION_IN_WINDOW";
    if (detailReason === "REENTRY_COOLDOWN") return "REENTRY_COOLDOWN";
    if (detailReason === "TOO_LATE_FOR_ENTRY") return "TOO_LATE_FOR_ENTRY";
    if (detailReason === "EXPIRED_WINDOW") {
      return "EXPIRED_WINDOW";
    }
    if (detailReason === "MARKET_CLOSED_AWAITING_OUTCOME" || detailReason === "AWAITING_RESOLUTION") {
      return "AWAITING_RESOLUTION";
    }

    const actionRoot = String(line.action || "")
      .split(":")[0]
      .trim()
      .toUpperCase();
    if (actionRoot !== "HOLD") {
      return null;
    }

    const normalizedDetail = normalizeHoldReason(line.holdDetailReason || line.dominantReject || "");
    const pauseReason = String(line.pauseReason || this.pauseReason || "")
      .trim()
      .toUpperCase();
    const oracleState = String(line.oracleState ?? this.truthDataHealth.oracleState ?? "")
      .trim()
      .toUpperCase();
    const oracleRequired =
      Number(line.activeWindows || 0) > 0 ||
      Number(line.openTrades || 0) > 0 ||
      (this.config.polymarket.mode === "paper" && this.config.polymarket.paper.forceTrade);
    const nowTsFromLine = toMsOrNull(line.now) ?? Date.now();
    const lastFetchOkTs = Number(line.lastFetchOkTs ?? this.polyState.lastFetchOkTs ?? 0);
    const fetchedCount = Number(line.fetchedCount ?? this.polyState.fetchedCount ?? 0);
    const fetchStaleAfterMs = Math.max(
      30_000,
      this.config.polymarket.risk.staleKillAfterMs,
      this.config.polymarket.risk.staleMs * 2
    );

    if (normalizedDetail === "ORACLE_STALE" || normalizedDetail === "ORACLE_STALE_BOOK_STALE") {
      return normalizedDetail;
    }
    if (normalizedDetail === "AWAITING_RESOLUTION") {
      return "AWAITING_RESOLUTION";
    }
    if (normalizedDetail === "EXPIRED_WINDOW") {
      return "EXPIRED_WINDOW";
    }
    if (normalizedDetail === "NO_NEW_ORDERS_FINAL_SECONDS") {
      return "NO_NEW_ORDERS_FINAL_SECONDS";
    }
    if (normalizedDetail === "OPEN_POSITION_IN_WINDOW") return "OPEN_POSITION_IN_WINDOW";
    if (normalizedDetail === "REENTRY_COOLDOWN") return "REENTRY_COOLDOWN";
    if (normalizedDetail === "TOO_LATE_FOR_ENTRY") return "TOO_LATE_FOR_ENTRY";
    if (normalizedDetail === "SIZE_BELOW_MIN_NOTIONAL") {
      return "SIZE_BELOW_MIN_NOTIONAL";
    }
    if (pauseReason.includes("ORACLE_STALE")) {
      return "ORACLE_STALE";
    }
    if (normalizedDetail === "ORACLE_UNAVAILABLE" || pauseReason.includes("ORACLE_UNAVAILABLE")) {
      return "ORACLE_UNAVAILABLE";
    }
    if (line.tradingPaused) {
      if (pauseReason.includes("NETWORK")) return "NETWORK_ERROR";
      if (pauseReason.includes("ORACLE_STALE")) return "ORACLE_STALE";
      if (pauseReason.includes("ORACLE_UNAVAILABLE")) return "ORACLE_UNAVAILABLE";
      return "TRADING_PAUSED";
    }

    if (!(lastFetchOkTs > 0) || fetchedCount <= 0) {
      return "NO_DATA";
    }
    if (nowTsFromLine - lastFetchOkTs >= fetchStaleAfterMs) {
      return "FETCH_STALE";
    }

    const afterWindowCount = Number(line.afterWindowCount ?? this.polyState.afterWindowCount ?? 0);
    if (afterWindowCount <= 0) {
      return "NO_ACTIVE_BTC5M_MARKET";
    }

    const finalCandidatesCount = Number(line.finalCandidatesCount ?? this.truthSelection.finalCandidatesCount ?? 0);
    if (finalCandidatesCount <= 0) {
      return "NO_CANDIDATES";
    }

    if (oracleRequired && (!oracleState || oracleState === "IDLE" || oracleState === "NULL")) {
      return "ORACLE_IDLE";
    }

    const hasSelection = Boolean(line.selectedSlug || line.currentMarketId);
    const tauSec = Number(line.tauSec);
    if (
      hasSelection &&
      Number.isFinite(tauSec) &&
      (tauSec < this.config.polymarket.paper.entryMinRemainingSec ||
        tauSec > this.config.polymarket.paper.entryMaxRemainingSec)
    ) {
      return "WINDOW_OUTSIDE_SNIPER_RANGE";
    }

    const chosenEdge = Number(line.chosenEdge);
    const threshold = Number(line.threshold);
    if (
      normalizedDetail === "EDGE_BELOW_THRESHOLD" ||
      normalizedDetail === "NET_EDGE_BELOW_PAPER_MIN" ||
      normalizedDetail === "NET_EDGE_BELOW_MIN_NET_EDGE" ||
      normalizedDetail === "NET_EDGE_BELOW_DYNAMIC_THRESHOLD" ||
      (Number.isFinite(chosenEdge) && Number.isFinite(threshold) && chosenEdge <= threshold)
    ) {
      return "EDGE_BELOW_THRESHOLD";
    }

    if (normalizedDetail && normalizedDetail !== "HOLD_GENERIC") {
      return normalizedDetail;
    }

    if (oracleRequired && (oracleState === "ORACLE_STALE" || oracleState === "ORACLE_UNAVAILABLE")) {
      return oracleState;
    }

    return "HOLD_GENERIC";
  }

  private maybeWarnNoData(holdReason: string | null, nowTs: number): void {
    if (holdReason !== "NO_DATA") {
      this.noDataSinceTs = null;
      this.noDataWarned = false;
      return;
    }
    if (this.noDataSinceTs === null) {
      this.noDataSinceTs = nowTs;
      return;
    }
    const ageMs = Math.max(0, nowTs - this.noDataSinceTs);
    if (ageMs < 30_000 || this.noDataWarned) {
      return;
    }
    this.noDataWarned = true;
    this.logger.warn(
      {
        holdReason,
        noDataForMs: ageMs,
        hints: ["check env vars", "check engine start", "check network"]
      },
      "POLY_NO_DATA"
    );
  }

  private emitPolyStatusLine(line: TickLogLine, nowTs: number): void {
    const candidatesCount = Math.max(
      0,
      Math.floor(
        Number(
          line.discoveredCandidates ??
            line.fetchedCount ??
            line.afterActiveCount ??
            line.afterSearchCount ??
            0
        )
      )
    );
    const selected = line.selectedSlug || line.currentMarketId || "-";
    const remaining = Number.isFinite(Number(line.tauSec)) ? String(Math.floor(Number(line.tauSec))) : "-";
    const minRemainingSec =
      Number.isFinite(Number(line.minWindowSec)) && Number(line.minWindowSec) > 0
        ? Math.floor(Number(line.minWindowSec))
        : this.scanner.getPrimaryWindowConfig().minWindowSec;
    const maxRemainingSec =
      Number.isFinite(Number(line.maxWindowSec)) && Number(line.maxWindowSec) > 0
        ? Math.floor(Number(line.maxWindowSec))
        : this.scanner.getPrimaryWindowConfig().maxWindowSec;
    const thresholdText = Number.isFinite(Number(line.threshold))
      ? Number(line.threshold).toFixed(4)
      : "-";
    const pauseReasonText = String(line.pauseReason || "-");
    const warningStateText = String(line.warningState || "-");
    const oracleStateText = String(line.oracleState || "-");
    const chosenSideText = String(line.chosenSide || "-");
    const chosenDirectionText = String(line.chosenDirection || "-");
    const entriesInWindowText = Number.isFinite(Number(line.entriesInWindow))
      ? String(Math.max(0, Math.floor(Number(line.entriesInWindow))))
      : "-";
    const openTradesText = Number.isFinite(Number(line.openTrades))
      ? String(Math.max(0, Math.floor(Number(line.openTrades))))
      : "-";
    const awaitingResolutionText = Number.isFinite(Number(line.awaitingResolutionCount))
      ? String(Math.max(0, Math.floor(Number(line.awaitingResolutionCount))))
      : "-";
    const resolutionQueueText = Number.isFinite(Number(line.resolutionQueueCount))
      ? String(Math.max(0, Math.floor(Number(line.resolutionQueueCount))))
      : awaitingResolutionText;
    const windowRealizedPnlText = Number.isFinite(Number(line.windowRealizedPnlUsd))
      ? Number(line.windowRealizedPnlUsd).toFixed(2)
      : "-";
    const resolutionSourceText = String(line.resolutionSource || this.truthResolutionSource || "-");
    const holdReasonText = String(line.holdReason || "-");
    const holdDetailText = String(line.holdDetailReason || line.dominantReject || "-");
    const nowIso = new Date(nowTs).toISOString();
    this.logger.info(
      `POLY_STATUS now=${nowIso} candidatesCount=${candidatesCount} windowsCount=${Number(line.afterWindowCount ?? 0)} acceptedSampleCount=${Math.max(0, Math.floor(Number(line.acceptedSampleCount || 0)))} selectedSlug=${selected} remainingSec=${remaining} dominantReject=${line.dominantReject || "-"} currentWindowHoldReason=${holdReasonText} holdDetail=${holdDetailText} oracleState=${oracleStateText} paused=${line.tradingPaused ? "1" : "0"} pauseReason=${pauseReasonText} warningState=${warningStateText} chosenSide=${chosenSideText} chosenDirection=${chosenDirectionText} openTradesCount=${openTradesText} awaitingResolutionCount=${awaitingResolutionText} resolutionQueueCount=${resolutionQueueText} entriesInWindow=${entriesInWindowText} realizedPnlWindowUsd=${windowRealizedPnlText} resolutionSource=${resolutionSourceText} threshold=${thresholdText} forceTradeFired=${line.forceTradeFired ? "1" : "0"} minRemainingSec=${minRemainingSec} maxRemainingSec=${maxRemainingSec}`
    );
  }

  private captureTruthStateFromTick(line: TickLogLine): void {
    const tickTs = this.getTickTimestamp(line.now);
    const selectionRollover = this.isSelectionRollover(line);
    this.polyState.fetchedCount = Number.isFinite(Number(line.fetchedCount))
      ? Math.max(0, Math.floor(Number(line.fetchedCount)))
      : this.polyState.fetchedCount;
    this.polyState.afterWindowCount = Number.isFinite(Number(line.afterWindowCount))
      ? Math.max(0, Math.floor(Number(line.afterWindowCount)))
      : this.polyState.afterWindowCount;
    this.polyState.finalCandidatesCount = Number.isFinite(Number(line.finalCandidatesCount))
      ? Math.max(0, Math.floor(Number(line.finalCandidatesCount)))
      : this.polyState.finalCandidatesCount;
    if (line.selectedSlug !== undefined) {
      this.polyState.selectedSlug = line.selectedSlug;
    }
    if (line.currentMarketId !== undefined) {
      this.polyState.selectedMarketId = line.currentMarketId;
    }
    this.polyState.holdDetailReason =
      line.holdDetailReason !== undefined
        ? line.holdDetailReason
        : selectionRollover
          ? null
        : String(line.action || "").toUpperCase().startsWith("HOLD")
          ? this.polyState.holdDetailReason
          : null;
    if (line.dominantReject !== undefined) {
      this.polyState.dominantReject = line.dominantReject;
    } else if (selectionRollover) {
      this.polyState.dominantReject = null;
    }
    if (line.rejectCountsByStage) {
      this.polyState.rejectCountsByStage = cloneRejectCountsByStage(line.rejectCountsByStage);
    }
    if (line.sampleRejected && line.sampleRejected.length > 0) {
      this.polyState.sampleRejected = line.sampleRejected.slice(0, 5).map((row) => ({ ...row }));
    }
    this.polyState.oracleSource = line.oracleSource ?? this.polyState.oracleSource;
    this.polyState.oracleState = line.oracleState ?? this.polyState.oracleState;
    this.polyState.lastFetchAttemptTs = Number.isFinite(Number(line.lastFetchAttemptTs))
      ? Math.max(this.polyState.lastFetchAttemptTs, Math.floor(Number(line.lastFetchAttemptTs)))
      : this.polyState.lastFetchAttemptTs;
    this.polyState.lastFetchOkTs = Number.isFinite(Number(line.lastFetchOkTs))
      ? Math.max(this.polyState.lastFetchOkTs, Math.floor(Number(line.lastFetchOkTs)))
      : this.polyState.lastFetchOkTs;
    if (line.lastFetchErr !== undefined) {
      this.polyState.lastFetchErr = line.lastFetchErr;
    }
    if (Number.isFinite(Number(line.lastHttpStatus))) {
      this.polyState.lastHttpStatus = Math.max(0, Math.floor(Number(line.lastHttpStatus)));
    }
    if (Number.isFinite(Number(line.yesBid))) this.polyState.lastYesBid = Number(line.yesBid);
    if (Number.isFinite(Number(line.yesAsk))) this.polyState.lastYesAsk = Number(line.yesAsk);
    if (Number.isFinite(Number(line.yesMid))) this.polyState.lastYesMid = Number(line.yesMid);
    if (Number.isFinite(Number(line.polyUpdateAgeMs)) && Number(line.polyUpdateAgeMs) >= 0) {
      this.polyState.lastBookTsMs = Math.max(
        this.polyState.lastBookTsMs,
        Math.max(0, tickTs - Number(line.polyUpdateAgeMs))
      );
    }
    if (Number.isFinite(Number(line.pBase)) || Number.isFinite(Number(line.pBoosted)) || Number.isFinite(Number(line.pUpModel))) {
      this.polyState.lastModelTs = Math.max(this.polyState.lastModelTs, tickTs);
    }
    this.polyState.latestPolymarketTs = Math.max(
      Number(this.polyState.latestPolymarketTs || 0),
      Number(this.latestPolymarketSnapshot?.ts || 0),
      Number(this.polyState.lastFetchOkTs || 0),
      Number.isFinite(Number(line.yesMid)) || Boolean(line.selectedSlug || line.currentMarketId) ? tickTs : 0
    ) || null;
    const nextSelectedSlug =
      line.selectedSlug !== undefined ? line.selectedSlug : this.truthSelection.selectedSlug;
    const nextSelectedMarketId =
      line.currentMarketId !== undefined ? line.currentMarketId : this.truthSelection.selectedMarketId;
    const nextWindowStartTs =
      Number((line.windowStart ?? this.truthSelection.windowStartTs) || 0) > 0
        ? Number(line.windowStart ?? this.truthSelection.windowStartTs)
        : null;
    const nextWindowEndTs =
      Number((line.windowEnd ?? this.truthSelection.windowEndTs) || 0) > 0
        ? Number(line.windowEnd ?? this.truthSelection.windowEndTs)
        : null;
    const nextHasSelection = Boolean(nextSelectedSlug || nextSelectedMarketId);
    this.truthSelection = {
      finalCandidatesCount: line.finalCandidatesCount ?? this.truthSelection.finalCandidatesCount,
      selectedSlug: nextSelectedSlug,
      selectedMarketId: nextSelectedMarketId,
      windowStartTs: nextWindowStartTs,
      windowEndTs: nextWindowEndTs,
      remainingSec:
        Number.isFinite(Number(line.tauSec)) && Number(line.tauSec) >= 0
          ? Math.floor(Number(line.tauSec))
          : nextHasSelection && nextWindowEndTs && nextWindowEndTs > tickTs
            ? Math.floor((nextWindowEndTs - tickTs) / 1000)
            : null
    };
    if (line.chosenDirection !== undefined) {
      this.truthChosenDirection = line.chosenDirection;
    }
    if (line.entriesInWindow !== undefined) {
      this.truthEntriesInWindow = Number.isFinite(Number(line.entriesInWindow))
        ? Math.max(0, Math.floor(Number(line.entriesInWindow)))
        : null;
    }
    if (line.windowRealizedPnlUsd !== undefined) {
      this.truthWindowRealizedPnlUsd = Number.isFinite(Number(line.windowRealizedPnlUsd))
        ? Number(line.windowRealizedPnlUsd)
        : null;
    }
    if (line.resolutionSource !== undefined) {
      this.truthResolutionSource = line.resolutionSource;
    }
    this.truthDataHealth = {
      oracleSource: this.polyState.oracleSource ?? this.truthDataHealth.oracleSource,
      oracleState: this.polyState.oracleState ?? this.truthDataHealth.oracleState,
      latestPolymarketTs: this.polyState.latestPolymarketTs,
      latestModelTs: this.polyState.lastModelTs > 0 ? this.polyState.lastModelTs : this.truthDataHealth.latestModelTs,
      lastFetchAttemptTs: this.polyState.lastFetchAttemptTs,
      lastFetchOkTs: this.polyState.lastFetchOkTs,
      lastFetchErr: this.polyState.lastFetchErr,
      lastHttpStatus: this.polyState.lastHttpStatus
    };
    this.polyState.lastUpdateTs = Math.max(this.polyState.lastUpdateTs, tickTs);
    this.polyEngineRunning = this.polyState.lastFetchAttemptTs > 0;
    const actionRoot = this.getTickActionRoot(line.action);
    if (actionRoot === "HOLD") {
      this.truthHoldReason = normalizeHoldReason(line.holdReason || line.action);
    } else {
      this.truthHoldReason = null;
    }
  }

  private emitPolymarketTruth(params: {
    ts: number;
    force?: boolean;
    action?: "OPEN" | "CLOSE" | "RESOLVE" | "HOLD";
    tradeId?: string | null;
    slug?: string | null;
    holdReason?: string | null;
  }): void {
    if (params.action) {
      this.truthLastAction = params.action;
      this.truthLastActionTs = params.ts;
      if (params.action !== "HOLD" && params.holdReason === undefined) {
        this.truthHoldReason = null;
      }
    }
    if (params.tradeId !== undefined) {
      this.truthLastTradeId = params.tradeId;
      this.truthLastTradeTs = params.tradeId ? params.ts : this.truthLastTradeTs;
    }
    if (params.slug !== undefined) {
      this.truthLastSlug = params.slug;
    }
    if (params.holdReason !== undefined) {
      this.truthHoldReason = params.holdReason ? normalizeHoldReason(params.holdReason) : null;
    }
    const summary = this.paperLedger.getSummary(params.ts);
    const resolutionStats = this.getPaperResolutionStats(params.ts);
    const selectionSnapshot = this.getTruthSelectionSnapshot(params.ts);
    this.truthReporter.updatePolymarket({
      ts: params.ts,
      force: params.force ?? false,
      mode: this.config.polymarket.mode === "paper" ? "PAPER" : "LIVE",
      liveConfirmed: this.config.polymarket.liveConfirmed,
      liveExecutionEnabled: this.config.polymarket.liveExecutionEnabled,
      killSwitch: this.config.polymarket.killSwitch,
      enabled: this.config.polymarket.enabled,
      polyEngineRunning: this.polyState.lastFetchAttemptTs > 0,
      fetchOk: this.polyState.lastFetchOkTs > 0 && this.polyState.lastHttpStatus === 200,
      lastAction: this.truthLastAction,
      openTrades: resolutionStats.openTradesCount,
      awaitingResolutionTrades: resolutionStats.awaitingResolutionCount,
      resolutionErrorTrades: resolutionStats.resolutionErrorCount,
      resolutionQueueCount: resolutionStats.resolutionQueueCount,
      resolvedTrades: summary.resolvedTrades,
      pnlTotalUsd: summary.totalPnlUsd,
      lastTradeId: this.truthLastTradeId,
      lastSlug: this.truthLastSlug,
      lastTradeTs: this.truthLastTradeTs,
      holdReason: this.truthHoldReason,
      currentWindowHoldReason: this.truthHoldReason,
      chosenDirection: this.truthChosenDirection,
      entriesInWindow: this.truthEntriesInWindow,
      windowRealizedPnlUsd: this.truthWindowRealizedPnlUsd,
      resolutionSource: this.truthResolutionSource,
      finalCandidatesCount: selectionSnapshot.finalCandidatesCount,
      discoveredCandidatesCount: this.polyState.fetchedCount,
      windowsCount: this.polyState.afterWindowCount,
      selectedSlug: selectionSnapshot.selectedSlug,
      selectedMarketId: selectionSnapshot.selectedMarketId,
      windowStartTs: selectionSnapshot.windowStartTs,
      windowEndTs: selectionSnapshot.windowEndTs,
      remainingSec: selectionSnapshot.remainingSec,
      oracleSource: this.truthDataHealth.oracleSource,
      oracleState: this.truthDataHealth.oracleState,
      latestPolymarketTs: this.truthDataHealth.latestPolymarketTs,
      latestModelTs: this.truthDataHealth.latestModelTs,
      lastFetchAttemptTs: this.truthDataHealth.lastFetchAttemptTs,
      lastFetchOkTs: this.truthDataHealth.lastFetchOkTs,
      lastFetchErr: this.truthDataHealth.lastFetchErr,
      lastHttpStatus: this.truthDataHealth.lastHttpStatus,
      lastUpdateTs: this.polyState.lastUpdateTs
    });
  }

  private ensureOutputFilesAndWriteStartupMarkers(): void {
    mkdirSync(this.logsDirPath, { recursive: true });
    mkdirSync(this.dataDirPath, { recursive: true });
    mkdirSync(path.dirname(this.paperLedgerPath), { recursive: true });
    const nowIso = new Date().toISOString();
    appendFileSync(
      this.logPath,
      `${JSON.stringify({
        ts: nowIso,
        type: "startup",
        mode: this.config.polymarket.mode
      })}\n`,
      "utf8"
    );
    appendFileSync(
      this.paperTradeLogPath,
      `${JSON.stringify({
        ts: nowIso,
        type: "startup",
        mode: this.config.polymarket.mode
      })}\n`,
      "utf8"
    );
    if (this.config.polymarket.mode === "paper") {
      this.paperLedger.appendStartup();
    }
  }

  private syncPaperLedgerFromDisk(): void {
    if (this.config.polymarket.mode !== "paper") {
      return;
    }
    this.paperLedger.reloadFromDisk();
    const liveTradeIds = new Set(this.paperLedger.getAllTrades().map((trade) => trade.id));
    const pruneMissing = <T>(store: Map<string, T>): void => {
      for (const tradeId of store.keys()) {
        if (!liveTradeIds.has(tradeId)) {
          store.delete(tradeId);
        }
      }
    };
    pruneMissing(this.paperStopLossTicksByTradeId);
    pruneMissing(this.paperBestUnrealizedPnlUsdByTradeId);
    pruneMissing(this.resolutionPendingLogByTradeId);
    if (liveTradeIds.size === 0) {
      this.paperDecisionByIntervalKey.clear();
      this.lastPaperIntervalKey = null;
      this.lastPaperIntervalEndTs = null;
      this.truthLastAction = "HOLD";
      this.truthLastActionTs = 0;
      this.truthLastTradeId = null;
      this.truthLastSlug = null;
      this.truthLastTradeTs = null;
      this.truthHoldReason = null;
      this.truthChosenDirection = null;
      this.truthEntriesInWindow = 0;
      this.truthWindowRealizedPnlUsd = 0;
      this.truthResolutionSource = null;
      this.truthSelection = {
        finalCandidatesCount: null,
        selectedSlug: null,
        selectedMarketId: null,
        windowStartTs: null,
        windowEndTs: null,
        remainingSec: null
      };
    }
  }

  private handlePaperFatal(reason: string, error?: unknown): void {
    if (this.config.polymarket.mode !== "paper" || this.paperFatalLogged) {
      return;
    }
    this.paperFatalLogged = true;
    this.running = false;
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message ?? reason)
        : reason;
    console.error(`[Polymarket paper fatal] ${reason}: ${message}`);
    appendFileSync(
      this.logPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        type: "error",
        error: `${reason}: ${message}`
      })}\n`,
      "utf8"
    );
  }
  private recordOracleSample(px: number, ts: number, source: string): void {
    if (!(px > 0)) return;
    this.oracleSamples.push({ px, ts, source });
    const minTs = ts - 2 * 60 * 60 * 1000;
    while (this.oracleSamples.length > 0 && this.oracleSamples[0].ts < minTs) {
      this.oracleSamples.shift();
    }
  }

  private pickOracleAtOrAfter(targetTs: number): { px: number; ts: number; source: string } | null {
    for (let i = 0; i < this.oracleSamples.length; i += 1) {
      const row = this.oracleSamples[i];
      if (row.ts >= targetTs) {
        return row;
      }
    }
    return null;
  }

  private pickOracleAtOrBefore(targetTs: number): { px: number; ts: number; source: string } | null {
    for (let i = this.oracleSamples.length - 1; i >= 0; i -= 1) {
      const row = this.oracleSamples[i];
      if (row.ts <= targetTs) {
        return row;
      }
    }
    return null;
  }

  private setTradingPaused(paused: boolean, reason: string, nowTs: number): void {
    const normalizedReason = String(reason || "").trim();
    if (paused) {
      if (!this.tradingPaused || this.pauseReason !== normalizedReason) {
        this.tradingPaused = true;
        this.pauseReason = normalizedReason || "PAUSED";
        this.pauseSinceTs = nowTs;
        this.logger.warn(
          {
            tradingPaused: true,
            pauseReason: this.pauseReason,
            pauseSinceTs: this.pauseSinceTs
          },
          "Polymarket trading paused"
        );
      }
      return;
    }

    if (this.tradingPaused) {
      this.tradingPaused = false;
      const previousReason = this.pauseReason || "PAUSED";
      const pausedForMs = this.pauseSinceTs ? Math.max(0, nowTs - this.pauseSinceTs) : null;
      this.pauseReason = "";
      this.pauseSinceTs = null;
      this.logger.info(
        {
          tradingPaused: false,
          previousReason,
          pausedForMs
        },
        "Polymarket trading resumed"
      );
    }
  }

  private computeShortReturn(nowTs: number, lookbackSec: number): number {
    if (this.oracleSamples.length < 2) return 0;
    const nowSample = this.pickOracleAtOrBefore(nowTs);
    const pastSample = this.pickOracleAtOrBefore(nowTs - Math.max(1, lookbackSec) * 1000);
    if (!nowSample || !pastSample || !(nowSample.px > 0) || !(pastSample.px > 0)) {
      return 0;
    }
    const ret = nowSample.px / pastSample.px - 1;
    return Number.isFinite(ret) ? clamp(ret, -0.05, 0.05) : 0;
  }

  private computeRealizedVolPricePerSqrtSec(
    nowTs: number,
    oracleNow: number,
    fallbackSigmaPricePerSqrtSec: number,
    lookbackSec: number
  ): number {
    const minTs = nowTs - Math.max(1, lookbackSec) * 1000;
    const window = this.oracleSamples.filter((row) => row.ts >= minTs && row.ts <= nowTs);
    if (window.length < 3) {
      return Math.max(1e-9, fallbackSigmaPricePerSqrtSec);
    }

    const scaledReturns: number[] = [];
    for (let i = 1; i < window.length; i += 1) {
      const prev = window[i - 1];
      const curr = window[i];
      const dtSec = Math.max(1e-3, (curr.ts - prev.ts) / 1000);
      if (!(prev.px > 0) || !(curr.px > 0)) continue;
      const logRet = Math.log(curr.px / prev.px);
      scaledReturns.push(logRet / Math.sqrt(dtSec));
    }
    if (scaledReturns.length < 2) {
      return Math.max(1e-9, fallbackSigmaPricePerSqrtSec);
    }

    const mean =
      scaledReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, scaledReturns.length);
    const variance =
      scaledReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      Math.max(1, scaledReturns.length - 1);
    const sigmaPerSqrtSec = Math.sqrt(Math.max(0, variance));
    const sigmaPrice = sigmaPerSqrtSec * Math.max(1, oracleNow);
    return Math.max(1e-9, Number.isFinite(sigmaPrice) ? sigmaPrice : fallbackSigmaPricePerSqrtSec);
  }

  private computeStalenessEdge(
    marketId: string,
    impliedMid: number,
    oracleEst: number,
    nowTs: number
  ): number {
    const key = String(marketId || "").trim();
    if (!key || !(impliedMid > 0) || !(oracleEst > 0)) {
      return 0;
    }
    const previous = this.marketLagState.get(key);
    this.marketLagState.set(key, {
      impliedMid,
      oracleEst,
      ts: nowTs
    });
    if (!previous) return 0;

    const impliedDelta = Math.abs(impliedMid - previous.impliedMid);
    const oracleDeltaBps = Math.abs((oracleEst - previous.oracleEst) / Math.max(1, previous.oracleEst)) * 10_000;
    const ageMs = Math.max(1, nowTs - previous.ts);

    const impliedIsSticky = impliedDelta <= 0.0025;
    const fastMidMoved = oracleDeltaBps >= 4;
    const freshComparison = ageMs <= 20_000;
    if (!impliedIsSticky || !fastMidMoved || !freshComparison) {
      return 0;
    }

    // Convert lag into a bounded additive conviction term.
    return clamp((oracleDeltaBps - 4) / 60, 0, 0.2);
  }

  private normalizeDiscoverySearchQueries(value: string[] | string | undefined): string[] {
    const tokens = Array.isArray(value) ? value : String(value || "").split(",");
    const deduped = new Set<string>();
    for (const token of tokens) {
      const normalized = String(token || "").trim();
      if (!normalized) continue;
      deduped.add(normalized);
    }
    if (deduped.size > 0) {
      return Array.from(deduped.values());
    }
    return [
      "btc",
      "bitcoin",
      "btc up down",
      "bitcoin up down",
      "btc 5m",
      "btc 5 minute",
      "up down",
      "higher lower",
      "above below"
    ];
  }

  private shouldPreferBtc5mDiscovery(): boolean {
    if (Math.max(1, this.config.polymarket.marketQuery.cadenceMinutes) === 5) {
      return true;
    }
    const searches = this.normalizeDiscoverySearchQueries(
      this.config.polymarket.marketQuery.search as unknown as string[] | string
    );
    return searches.some((row) => {
      const text = String(row || "").trim().toLowerCase();
      if (!text) return false;
      const hasBtc = /(?:\bbtc\b|bitcoin)/i.test(text);
      const hasCadence =
        /(?:\b5m\b|\b5\s*min(?:ute)?s?\b|\bfive\s*minute(?:s)?\b|next\s*5\s*minutes|in\s*5\s*minutes|within\s*5\s*minutes)/i.test(
          text
        );
      const hasDirection =
        /(?:up\s*or\s*down|up\/down|higher\s*or\s*lower|above\s*or\s*below|increase|decrease|rise|fall)/i.test(
          text
        ) ||
        (/\bup\b/i.test(text) && /\bdown\b/i.test(text)) ||
        (/\bhigher\b/i.test(text) && /\blower\b/i.test(text)) ||
        (/\babove\b/i.test(text) && /\bbelow\b/i.test(text));
      return hasBtc && hasCadence && hasDirection;
    });
  }

  private async fetchBtc5mMarkets(nowTs: number): Promise<Btc5mFetchResult> {
    const queryText = "btc 5 minute up down";
    const primaryWindow = this.scanner.getPrimaryWindowConfig();
    const minWindowSec = primaryWindow.minWindowSec;
    const maxWindowSec = primaryWindow.maxWindowSec;
    const attempts: Btc5mFetchAttempt[] = [];
    const rawByKey = new Map<string, RawPolymarketMarket>();
    const ingestRaw = (rows: RawPolymarketMarket[]): void => {
      for (const row of rows) {
        const key =
          pickRawString(row, ["id", "market_id", "conditionId", "condition_id"]) ||
          pickRawString(row, ["slug", "market_slug", "eventSlug", "event_slug"]);
        if (!key) continue;
        if (!rawByKey.has(key)) {
          rawByKey.set(key, row);
        }
      }
    };
    const attemptMarketsFetch = async (mode: "search" | "query"): Promise<number> => {
      const page = await this.client.listMarketsPage({
        limit: 200,
        active: true,
        closed: false,
        archived: false,
        search: mode === "search" ? queryText : undefined,
        query: mode === "query" ? queryText : undefined
      });
      attempts.push({
        stage: `markets_${mode}`,
        endpoint: "markets",
        mode,
        count: page.rows.length
      });
      ingestRaw(page.rows);
      return page.rows.length;
    };
    const attemptEventsFetch = async (mode: "search" | "query"): Promise<number> => {
      const page = await this.client.listEventsPage({
        limit: 200,
        active: true,
        closed: false,
        search: mode === "search" ? queryText : undefined,
        query: mode === "query" ? queryText : undefined
      });
      attempts.push({
        stage: `events_${mode}`,
        endpoint: "events",
        mode,
        count: page.rows.length
      });
      const expandedMarkets = await this.expandEventsToMarkets(page.rows, nowTs, maxWindowSec);
      ingestRaw(expandedMarkets);
      return page.rows.length;
    };

    await attemptMarketsFetch("search");
    if (rawByKey.size === 0) {
      await attemptMarketsFetch("query");
    }
    if (rawByKey.size === 0) {
      await attemptEventsFetch("search");
      if (rawByKey.size === 0) {
        await attemptEventsFetch("query");
      }
    }

    const rawRows = Array.from(rawByKey.values());
    const sampleTitles = rawRows.slice(0, 5).map((row) => ({
      slug:
        pickRawString(row, ["slug", "market_slug", "eventSlug", "event_slug"]) ||
        pickRawString(row, ["id", "market_id", "conditionId", "condition_id"]),
      title:
        pickRawString(row, ["question", "title", "description", "subtitle"]) ||
        pickRawString(row, ["slug", "market_slug"])
    }));
    const rawSample = rawRows.slice(0, 10).map((row) => {
      const text = this.extractBtc5mText(row);
      return {
        marketId: text.marketId,
        slug: text.slug,
        title: text.title,
        question: text.question,
        name: text.name,
        description: text.description,
        eventTitle: text.eventTitle,
        eventName: text.eventName,
        outcomeNames: text.outcomeNames
      };
    });
    this.logger.info(
      {
        totalReturned: rawRows.length,
        sample: rawSample
      },
      "POLY_5M_FETCH_RAW"
    );
    const patternRejectCounts = {
      no_btc: 0,
      no_cadence: 0,
      no_direction: 0,
      passed: 0
    };
    const individualMatchCounts = {
      btcMatched: 0,
      cadenceMatched: 0,
      directionMatched: 0
    };
    const patternRejectSamples: Record<"no_btc" | "no_cadence" | "no_direction", Array<{ slug: string; title: string }>> =
      {
        no_btc: [],
        no_cadence: [],
        no_direction: []
      };
    const emptyDebugSample: Array<{
      marketId: string;
      slug: string;
      title: string;
      question: string;
      name: string;
      description: string;
      eventTitle: string;
      eventName: string;
      outcomeNames: string;
      firstFailed: "btc" | "cadence" | "direction" | "none";
      tested: string;
    }> = [];
    const nearMisses: Array<{
      marketId: string;
      slug: string;
      title: string;
      missing: string;
      haystackExcerpt: string;
    }> = [];
    const filteredRows: RawPolymarketMarket[] = [];
    for (const row of rawRows) {
      const pattern = this.evaluateBtc5mPattern(row);
      if (pattern.hasBtc) individualMatchCounts.btcMatched += 1;
      if (pattern.hasCadence) individualMatchCounts.cadenceMatched += 1;
      if (pattern.hasDirection) individualMatchCounts.directionMatched += 1;
      if (emptyDebugSample.length < 10) {
        emptyDebugSample.push({
          marketId: pattern.marketId,
          slug: pattern.slug,
          title: pattern.title,
          question: pattern.question,
          name: pattern.name,
          description: pattern.description,
          eventTitle: pattern.eventTitle,
          eventName: pattern.eventName,
          outcomeNames: pattern.outcomeNames,
          firstFailed: pattern.firstFailed || "none",
          tested: truncateText(pattern.haystack, 220)
        });
      }
      if (!pattern.pass) {
        const reason: "no_btc" | "no_cadence" | "no_direction" = pattern.reason || "no_direction";
        patternRejectCounts[reason] += 1;
        if (patternRejectSamples[reason].length < 5) {
          patternRejectSamples[reason].push({ slug: pattern.slug, title: pattern.title });
        }
        if (pattern.hasBtc && (!pattern.hasCadence || !pattern.hasDirection) && nearMisses.length < 20) {
          nearMisses.push({
            marketId: pattern.marketId,
            slug: pattern.slug,
            title: pattern.title,
            missing: [pattern.hasCadence ? null : "cadence", pattern.hasDirection ? null : "direction"]
              .filter((row): row is string => Boolean(row))
              .join("+"),
            haystackExcerpt: truncateText(pattern.haystack, 140)
          });
        }
        continue;
      }
      patternRejectCounts.passed += 1;
      filteredRows.push(row);
    }
    this.logger.info(
      {
        attempts,
        rawCount: rawRows.length,
        minRemainingSec: minWindowSec,
        maxRemainingSec: maxWindowSec,
        patternPassCount: filteredRows.length,
        sample: sampleTitles
      },
      "POLY_5M_FETCH"
    );
    this.logger.info(
      {
        counts: patternRejectCounts,
        individualMatchCounts,
        sampleRejects: patternRejectSamples
      },
      "POLY_5M_FILTER_HIST"
    );
    if (filteredRows.length === 0) {
      this.logger.warn(
        {
          rawCount: rawRows.length,
          attempts,
          individualMatchCounts,
          sample: emptyDebugSample,
          nearMisses: nearMisses
            .sort((a, b) => a.missing.length - b.missing.length)
            .slice(0, 5)
        },
        "POLY_BTC5M_EMPTY_DEBUG"
      );
    }

    const parsedById = new Map<string, BtcWindowMarket>();
    for (const row of filteredRows) {
      const fallbackEndTs = pickRawTimestamp(
        row,
        [
          "windowEndTs",
          "window_end_ts",
          "endTs",
          "end_ts",
          "endDate",
          "end_date",
          "end_time",
          "endTime",
          "end_date_iso",
          "eventEndTime",
          "resolutionTime",
          "resolution_time",
          "expiresAt",
          "expires_at"
        ]
      );
      const parsed = parseRawMarketToBtcWindow(row, nowTs, fallbackEndTs, this.lastOracleSnapshot?.price ?? null);
      if (!parsed) continue;
      const remainingSec = Math.floor((toMs(parsed.endTs) - nowTs) / 1000);
      this.logger.info(
        {
          marketId: parsed.marketId,
          slug: parsed.eventSlug || parsed.slug || parsed.marketId,
          title: parsed.question,
          remainingSec
        },
        "POLY_BTC5M_MATCH"
      );
      if (!parsedById.has(parsed.marketId)) {
        parsedById.set(parsed.marketId, parsed);
      }
    }
    const markets = Array.from(parsedById.values()).sort((a, b) => a.endTs - b.endTs);
    const windowTelemetry = this.buildWindowTelemetryFromMarkets(markets, nowTs);
    return {
      markets,
      attempts,
      rawCount: rawRows.length,
      timeWindowCount: windowTelemetry.windowSamples.filter((row) => row.passWindow).length,
      patternPassCount: filteredRows.length,
      patternRejectCounts,
      patternRejectSamples: [
        ...patternRejectSamples.no_btc.map((row) => ({ ...row, reason: "no_btc" as const })),
        ...patternRejectSamples.no_cadence.map((row) => ({ ...row, reason: "no_cadence" as const })),
        ...patternRejectSamples.no_direction.map((row) => ({ ...row, reason: "no_direction" as const }))
      ],
      sampleTitles,
      windowSamples: windowTelemetry.windowSamples,
      rejectedWindow: windowTelemetry.rejectedWindow,
      windowRejectCounters: windowTelemetry.windowRejectCounters
    };
  }

  private async expandEventsToMarkets(
    events: RawPolymarketEvent[],
    nowTs: number,
    maxWindowSec: number
  ): Promise<RawPolymarketMarket[]> {
    const out: RawPolymarketMarket[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      const eventObj = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
      const eventSlug = pickRawString(eventObj, ["slug", "event_slug"]);
      const eventTitle = pickRawString(eventObj, ["title", "name", "question", "description"]);
      const eventMarkets = Array.isArray(eventObj.markets) ? eventObj.markets : [];
      if (eventMarkets.length > 0) {
        for (const raw of eventMarkets) {
          if (!raw || typeof raw !== "object") continue;
          const market = {
            ...eventObj,
            ...(raw as Record<string, unknown>),
            eventSlug: eventSlug || pickRawString(raw as Record<string, unknown>, ["eventSlug", "event_slug"]),
            slug:
              pickRawString(raw as Record<string, unknown>, ["slug", "market_slug"]) ||
              eventSlug,
            question:
              pickRawString(raw as Record<string, unknown>, ["question", "title", "description"]) ||
              eventTitle ||
              eventSlug
          } satisfies RawPolymarketMarket;
          const key =
            pickRawString(market, ["id", "market_id", "conditionId", "condition_id"]) ||
            pickRawString(market, ["slug", "market_slug"]);
          if (!key || seen.has(key)) continue;
          if (!this.passesEventNearTermGuard(market, nowTs, maxWindowSec)) continue;
          seen.add(key);
          out.push(market);
        }
        continue;
      }
      if (!eventSlug) continue;
      try {
        const page = await this.client.listMarketsPage({
          limit: 200,
          active: true,
          closed: false,
          archived: false,
          search: eventSlug
        });
        for (const market of page.rows) {
          const key =
            pickRawString(market, ["id", "market_id", "conditionId", "condition_id"]) ||
            pickRawString(market, ["slug", "market_slug"]);
          if (!key || seen.has(key)) continue;
          if (!this.passesEventNearTermGuard(market, nowTs, maxWindowSec)) continue;
          seen.add(key);
          out.push(market);
        }
      } catch {
        // Keep best-effort event expansion; failures are reflected in attempt counters.
      }
    }
    return out;
  }

  private passesEventNearTermGuard(row: RawPolymarketMarket, nowTs: number, maxWindowSec: number): boolean {
    const rawEndTs = pickRawTimestamp(row, [
      "windowEndTs",
      "window_end_ts",
      "endTs",
      "end_ts",
      "endDate",
      "end_date",
      "end_time",
      "endTime",
      "end_date_iso",
      "eventEndTime",
      "resolutionTime",
      "resolution_time",
      "expiresAt",
      "expires_at"
    ]);
    const windowEndMs = toMs(rawEndTs);
    if (!(windowEndMs > 0)) return true;
    const remainingSec = Math.floor((windowEndMs - nowTs) / 1000);
    if (remainingSec < -60) return false;
    return remainingSec <= maxWindowSec * 10;
  }

  private matchBtc5mPattern(row: RawPolymarketMarket): {
    pass: boolean;
    reason?: "no_btc" | "no_cadence" | "no_direction";
    slug: string;
    title: string;
  } {
    const evaluated = this.evaluateBtc5mPattern(row);
    return {
      pass: evaluated.pass,
      reason: evaluated.reason,
      slug: evaluated.slug,
      title: evaluated.title
    };
  }

  private evaluateBtc5mPattern(row: RawPolymarketMarket): {
    pass: boolean;
    reason?: "no_btc" | "no_cadence" | "no_direction";
    firstFailed?: "btc" | "cadence" | "direction";
    hasBtc: boolean;
    hasCadence: boolean;
    hasDirection: boolean;
    marketId: string;
    slug: string;
    title: string;
    question: string;
    name: string;
    description: string;
    eventTitle: string;
    eventName: string;
    outcomeNames: string;
    haystack: string;
  } {
    const text = this.extractBtc5mText(row);
    const hasBtc = /(?:\bbtc\b|bitcoin|\$btc\b)/i.test(text.haystack);
    const hasCadence =
      /(?:\b5m\b|\b5\s*min(?:ute)?s?\b|\bfive[-\s]*minute(?:s)?\b|next\s*5\s*minutes|in\s*5\s*minutes|within\s*5\s*minutes|over\s*the\s*next\s*5\s*minutes)/i.test(
        text.haystack
      );
    const hasDirection =
      /(?:up\s*or\s*down|up\/down|higher\s*or\s*lower|above\s*or\s*below|increase\s*or\s*decrease|be\s*higher(?:\s*or\s*lower)?|be\s*lower(?:\s*or\s*higher)?|rise|fall)/i.test(
        text.haystack
      ) ||
      (/\bup\b/i.test(text.haystack) && /\bdown\b/i.test(text.haystack)) ||
      (/\bhigher\b/i.test(text.haystack) && /\blower\b/i.test(text.haystack)) ||
      (/\babove\b/i.test(text.haystack) && /\bbelow\b/i.test(text.haystack)) ||
      (/\bincrease\b/i.test(text.haystack) && /\bdecrease\b/i.test(text.haystack));
    if (!hasBtc) {
      return {
        pass: false,
        reason: "no_btc",
        firstFailed: "btc",
        hasBtc,
        hasCadence,
        hasDirection,
        ...text
      };
    }
    if (!hasCadence) {
      return {
        pass: false,
        reason: "no_cadence",
        firstFailed: "cadence",
        hasBtc,
        hasCadence,
        hasDirection,
        ...text
      };
    }
    if (!hasDirection) {
      return {
        pass: false,
        reason: "no_direction",
        firstFailed: "direction",
        hasBtc,
        hasCadence,
        hasDirection,
        ...text
      };
    }
    return {
      pass: true,
      hasBtc,
      hasCadence,
      hasDirection,
      ...text
    };
  }

  private extractBtc5mText(row: RawPolymarketMarket): {
    marketId: string;
    slug: string;
    title: string;
    question: string;
    name: string;
    description: string;
    eventTitle: string;
    eventName: string;
    outcomeNames: string;
    haystack: string;
  } {
    const eventObj =
      row.event && typeof row.event === "object"
        ? (row.event as Record<string, unknown>)
        : {};
    const marketId =
      pickRawString(row, ["id", "market_id", "conditionId", "condition_id"]) ||
      pickRawString(eventObj, ["id", "event_id"]);
    const slug =
      pickRawString(row, ["slug", "market_slug", "eventSlug", "event_slug"]) ||
      pickRawString(eventObj, ["slug", "event_slug"]) ||
      marketId;
    const question =
      pickRawString(row, ["question", "marketQuestion", "market_question"]) ||
      pickRawString(eventObj, ["question", "name"]);
    const name = pickRawString(row, ["name", "marketName", "market_name"]);
    const title =
      pickRawString(row, ["title", "marketTitle", "market_title", "name"]) ||
      question ||
      slug;
    const description =
      pickRawString(row, ["description", "subtitle", "details", "shortDescription", "short_description"]) ||
      pickRawString(eventObj, ["description", "subtitle"]);
    const eventTitle =
      pickRawString(row, ["eventTitle", "event_title"]) ||
      pickRawString(eventObj, ["title", "name", "question"]);
    const eventName = pickRawString(eventObj, ["name"]);
    const outcomeNames = collectOutcomeText(row);
    const haystack = `${slug} ${question} ${title} ${name} ${description} ${eventTitle} ${eventName} ${outcomeNames}`
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return {
      marketId,
      slug,
      title,
      question,
      name,
      description,
      eventTitle,
      eventName,
      outcomeNames,
      haystack
    };
  }

  private buildWindowTelemetryFromMarkets(
    markets: BtcWindowMarket[],
    nowTs: number
  ): {
    windowSamples: MarketScanWindowSample[];
    rejectedWindow: MarketScanWindowRejection[];
    windowRejectCounters: WindowRejectCounters;
  } {
    const minWindowSec = this.config.polymarket.paper.entryMinRemainingSec;
    const maxWindowSec = this.config.polymarket.paper.entryMaxRemainingSec;
    const windowRejectCounters = createWindowRejectCounters();
    const windowSamples: MarketScanWindowSample[] = [];
    const rejectedWindow: MarketScanWindowRejection[] = [];
    for (const market of markets) {
      const windowEndTsMs = toMs(market.endTs);
      const remainingSec = windowEndTsMs > 0 ? Math.floor((windowEndTsMs - nowTs) / 1000) : Number.NaN;
      let passWindow = false;
      let rejectReason: string | undefined;
      if (!(windowEndTsMs > 0)) {
        windowRejectCounters.invalidEndTs += 1;
        rejectReason = "invalid_end_ts";
      } else if (!Number.isFinite(remainingSec)) {
        windowRejectCounters.invalidRemaining += 1;
        rejectReason = "invalid_remaining";
      } else if (remainingSec <= 0 || remainingSec < minWindowSec) {
        windowRejectCounters.tooLate += 1;
        rejectReason = "too_late";
      } else if (remainingSec > maxWindowSec) {
        windowRejectCounters.tooSoon += 1;
        rejectReason = "too_soon";
      } else {
        passWindow = true;
      }
      windowSamples.push({
        marketId: market.marketId,
        slug: market.eventSlug || market.slug || market.marketId,
        windowStartField: "startTs",
        windowStartParseNote: "milliseconds",
        windowStartRaw: String(market.startTs || ""),
        windowStartTsMs: toMs(market.startTs),
        windowEndField: "endTs",
        windowEndParseNote: "milliseconds",
        windowEndRaw: String(market.endTs || ""),
        windowEndTsMs,
        nowTsMs: nowTs,
        remainingSec: Number.isFinite(remainingSec) ? remainingSec : -1,
        passWindow,
        rejectReason
      });
      if (!passWindow) {
        rejectedWindow.push({
          marketId: market.marketId,
          slug: market.eventSlug || market.slug || market.marketId,
          windowStartField: "startTs",
          windowStartParseNote: "milliseconds",
          windowStartRaw: String(market.startTs || ""),
          windowStartTsMs: toMs(market.startTs),
          windowEndField: "endTs",
          windowEndParseNote: "milliseconds",
          windowEndRaw: String(market.endTs || ""),
          windowEndTsMs,
          nowTsMs: nowTs,
          remainingSec: Number.isFinite(remainingSec) ? remainingSec : -1,
          rejectReason: rejectReason || "invalid_remaining"
        });
      }
    }
    return { windowSamples, rejectedWindow, windowRejectCounters };
  }

  private buildDiagnosticsFromBtc5m(nowTs: number, input: Btc5mFetchResult): MarketScanDiagnostics {
    const primaryWindow = this.scanner.getPrimaryWindowConfig();
    const minWindowSec = primaryWindow.minWindowSec;
    const maxWindowSec = primaryWindow.maxWindowSec;
    const selected = input.markets[0] ?? null;
    return {
      ts: new Date(nowTs).toISOString(),
      counters: {
        fetchedCount: input.rawCount,
        afterActiveCount: input.rawCount,
        fetchedTotal: input.rawCount,
        afterSearchCount: input.rawCount,
        afterWindowCount: input.timeWindowCount,
        afterPatternCount: input.patternPassCount,
        finalCandidatesCount: input.markets.length,
        pagesScanned: input.attempts.length,
        recentEventsCount: input.attempts
          .filter((row) => row.endpoint === "events")
          .reduce((sum, row) => sum + row.count, 0),
        prefixMatchesCount: 0,
        tradableTotal: input.markets.filter((row) => row.acceptingOrders).length,
        btcTotal: input.patternPassCount,
        cadenceTotal: input.patternPassCount,
        directionTotal: input.patternPassCount,
        btc5mCandidates: input.patternPassCount,
        activeWindows: input.markets.length
      },
      candidates: input.markets.slice(0, 200).map((row) => ({
        marketId: row.marketId,
        question: row.question,
        acceptingOrders: row.acceptingOrders,
        enableOrderBook: row.enableOrderBook !== false,
        closed: Boolean(row.closed),
        active: row.active !== false
      })),
      rejectedNotTradable: [],
      rejectedWindow: input.rejectedWindow.slice(0, 200),
      windowSamples: input.windowSamples.slice(0, 200),
      activeMarkets: input.markets,
      selectedSlug: selected ? selected.eventSlug || selected.slug : null,
      selectedWindowStart: selected?.startTs ?? null,
      selectedWindowEnd: selected?.endTs ?? null,
      selectedAcceptingOrders: selected?.acceptingOrders ?? null,
      selectedEnableOrderBook: selected?.enableOrderBook ?? null,
      selectedMarket: selected ? { ...selected } : null,
      windowRejectCounters: { ...input.windowRejectCounters },
      effectiveMinWindowSec: minWindowSec,
      effectiveMaxWindowSec: maxWindowSec,
      attempts: [
        {
          mode: "primary",
          fallback: "none",
          searchQuery: "btc 5 minute up down",
          minWindowSec,
          maxWindowSec,
          fetchedCount: input.rawCount,
          afterActiveCount: input.rawCount,
          afterSearchCount: input.rawCount,
          afterWindowCount: input.timeWindowCount,
          afterPatternCount: input.patternPassCount,
          finalCandidatesCount: input.markets.length
        }
      ],
      fallbackUsed: null
    };
  }

  private computeFallbackSelectionScore(market: {
    slug?: string;
    eventSlug?: string;
    question?: string;
  }): number {
    const text = `${market.eventSlug || ""} ${market.slug || ""} ${market.question || ""}`.toLowerCase();
    let score = 0;
    if (/(?:\bbtc\b|bitcoin|\$btc)/i.test(text)) score += 3;
    if (/(?:\b5m\b|\b5\s*min\b|\b5\s*minute\b|minute)/i.test(text)) score += 2;
    if (/(?:up|down|higher|lower|above|below)/i.test(text)) score += 1;
    return score;
  }

  private pickBestFallbackMarket(
    markets: Array<{
      marketId: string;
      slug: string;
      question: string;
      priceToBeat: number;
      endTs: number;
      startTs?: number;
      yesTokenId: string;
      noTokenId?: string;
      tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
      negRisk?: boolean;
      acceptingOrders: boolean;
      enableOrderBook?: boolean;
      closed?: boolean;
      eventSlug?: string;
      yesBidHint?: number;
      yesAskHint?: number;
      yesMidHint?: number;
      yesLastTradeHint?: number;
      outcomePricesHint?: number[];
    }>
  ): { market: (typeof markets)[number]; score: number } | null {
    let best: { market: (typeof markets)[number]; score: number } | null = null;
    for (const market of markets) {
      const score = this.computeFallbackSelectionScore(market);
      if (!best || score > best.score) {
        best = { market, score };
      }
    }
    return best;
  }

  private getFallbackRemainingBounds(): { minRemainingSec: number; maxRemainingSec: number } {
    const paperCfg = this.config.polymarket.paper as unknown as {
      fallbackMinRemainingSec?: number;
      fallbackMaxRemainingSec?: number;
    };
    const minRemainingSec = toPositiveIntOrDefault(
      paperCfg.fallbackMinRemainingSec,
      this.config.polymarket.paper.entryMinRemainingSec
    );
    const maxRemainingSec = toPositiveIntOrDefault(
      paperCfg.fallbackMaxRemainingSec,
      this.config.polymarket.paper.entryMaxRemainingSec
    );
    if (maxRemainingSec < minRemainingSec) {
      return { minRemainingSec, maxRemainingSec: minRemainingSec };
    }
    return { minRemainingSec, maxRemainingSec };
  }

  private pickClosestExpirySample(
    samples: Array<{
      marketId: string;
      slug: string;
      windowEndRaw: string;
      windowEndTsMs: number;
      remainingSec: number;
    }>,
    nowTs: number
  ): ClosestExpirySample | null {
    let best: ClosestExpirySample | null = null;
    for (const row of samples) {
      const windowEndMs = toMs(row.windowEndTsMs);
      const remainingSec = Number.isFinite(Number(row.remainingSec))
        ? Math.floor(Number(row.remainingSec))
        : windowEndMs > 0
          ? Math.floor((windowEndMs - nowTs) / 1000)
          : Number.NaN;
      if (!Number.isFinite(remainingSec) || remainingSec <= 0) continue;
      if (!best || remainingSec < best.remainingSec) {
        best = {
          slug: String(row.slug || "").trim(),
          marketId: String(row.marketId || "").trim(),
          rawWindowEndTs: String(row.windowEndRaw || ""),
          windowEndMs,
          remainingSec
        };
      }
    }
    return best;
  }

  private async hydrateFallbackSampleToMarket(
    sample: ClosestExpirySample,
    nowTs: number
  ): Promise<BtcWindowMarket | null> {
    const lookups = [sample.marketId, sample.slug]
      .map((row) => String(row || "").trim())
      .filter((row, idx, arr) => row.length > 0 && arr.indexOf(row) === idx);
    const parse = (rows: Record<string, unknown>[]): BtcWindowMarket | null => {
      for (const row of rows) {
        if (!rawMarketMatches(row, sample.marketId, sample.slug)) continue;
        const parsed = parseRawMarketToBtcWindow(
          row,
          nowTs,
          sample.windowEndMs,
          this.lastOracleSnapshot?.price ?? null
        );
        if (parsed) return parsed;
      }
      return null;
    };
    try {
      for (const search of lookups) {
        const page = await this.client.listMarketsPage({
          limit: 200,
          search,
          active: true,
          closed: false,
          archived: false
        });
        const parsed = parse(page.rows);
        if (parsed) return parsed;
      }
      const broadPage = await this.client.listMarketsPage({
        limit: 200,
        active: true,
        closed: false,
        archived: false
      });
      return parse(broadPage.rows);
    } catch (error) {
      this.logger.warn(
        {
          marketId: sample.marketId,
          slug: sample.slug,
          error
        },
        "POLY_FALLBACK_REFUSED"
      );
      return null;
    }
  }

  private writeDecisionLog(line: DecisionLogLine): void {
    appendFileSync(this.logPath, `${JSON.stringify(line)}\n`, "utf8");
  }

  private writePaperTradeLog(line: Record<string, unknown>): void {
    appendFileSync(this.paperTradeLogPath, `${JSON.stringify(line)}\n`, "utf8");
  }
}

type TickLogLine = {
  marketsSeen: number;
  discoveredCandidates?: number | null;
  fetchedCount?: number | null;
  afterActiveCount?: number | null;
  afterSearchCount?: number | null;
  afterWindowCount?: number | null;
  afterPatternCount?: number | null;
  finalCandidatesCount?: number | null;
  rejectCountsByStage?: RejectCountsByStage;
  dominantReject?: string | null;
  windowReject?: string | null;
  windowRejectCounters?: WindowRejectCounters;
  minWindowSec?: number | null;
  maxWindowSec?: number | null;
  acceptedSampleCount?: number | null;
  sampleRejected?: RejectSample[];
  fallbackUsed?: "none" | "window" | "patterns" | "topActive";
  selectedReason?: string | null;
  selectedScore?: number | null;
  holdReason?: string | null;
  holdDetailReason?: string | null;
  forceTradeFired?: boolean;
  forceTradeMode?: "none" | "normal" | "smoke";
  activeWindows: number;
  now: string;
  currentMarketId: string | null;
  tauSec: number | null;
  priceToBeat: number | null;
  oracleEst: number | null;
  sigma: number | null;
  yesBid: number | null;
  yesAsk: number | null;
  yesMid?: number | null;
  pUpModel: number | null;
  pBase?: number | null;
  pBoosted?: number | null;
  z?: number | null;
  d?: number | null;
  sigmaCalibrated?: number | null;
  polyUpdateAgeMs?: number | null;
  lagPolyP90Ms?: number | null;
  boostApplied?: boolean;
  boostReason?: string | null;
  edge: number | null;
  edgeYes?: number | null;
  edgeNo?: number | null;
  chosenSide?: "YES" | "NO" | null;
  chosenDirection?: string | null;
  chosenEdge?: number | null;
  conviction?: number | null;
  stalenessEdge?: number | null;
  netEdgeAfterCosts?: number | null;
  threshold: number | null;
  action: string;
  size?: number | null;
  openTrades?: number;
  awaitingResolutionCount?: number;
  resolutionQueueCount?: number;
  resolvedTrades?: number;
  entriesInWindow?: number | null;
  windowRealizedPnlUsd?: number | null;
  resolutionSource?: string | null;
  oracleSource?: string;
  oracleTs?: number | null;
  oracleStaleMs?: number | null;
  oracleState?: string;
  lastFetchAttemptTs?: number;
  lastFetchOkTs?: number;
  lastFetchErr?: string | null;
  lastHttpStatus?: number;
  tradingPaused?: boolean;
  pauseReason?: string | null;
  warningState?: string | null;
  pauseSinceTs?: number | null;
  selectedSlug: string | null;
  windowStart: number | null;
  windowEnd: number | null;
  acceptingOrders: boolean | null;
  enableOrderBook: boolean | null;
};

function createRejectCountsByStage(): RejectCountsByStage {
  return {
    active: {},
    search: {},
    window: {},
    pattern: {},
    scoring: {},
    dataHealth: {}
  };
}

function cloneRejectCountsByStage(value: RejectCountsByStage): RejectCountsByStage {
  return {
    active: { ...(value.active || {}) },
    search: { ...(value.search || {}) },
    window: { ...(value.window || {}) },
    pattern: { ...(value.pattern || {}) },
    scoring: { ...(value.scoring || {}) },
    dataHealth: { ...(value.dataHealth || {}) }
  };
}

function addRejectCount(
  counts: RejectCountsByStage,
  stage: RejectStage,
  reason: string,
  value: number
): void {
  const qty = Math.max(0, Math.floor(Number(value || 0)));
  if (!(qty > 0)) return;
  const normalized = String(reason || "").trim().toLowerCase() || "unknown";
  counts[stage][normalized] = (counts[stage][normalized] || 0) + qty;
}

function computeDominantReject(counts: RejectCountsByStage): string | null {
  let bestStage: RejectStage | null = null;
  let bestReason = "";
  let bestCount = 0;
  for (const stage of Object.keys(counts) as RejectStage[]) {
    const stageCounts = counts[stage] || {};
    for (const [reason, rawCount] of Object.entries(stageCounts)) {
      const count = Math.max(0, Math.floor(Number(rawCount || 0)));
      if (count > bestCount) {
        bestCount = count;
        bestStage = stage;
        bestReason = reason;
      }
    }
  }
  if (!bestStage || !bestReason || bestCount <= 0) return null;
  return `${bestStage}:${bestReason}`;
}

function createWindowRejectCounters(): WindowRejectCounters {
  return {
    tooSoon: 0,
    tooLate: 0,
    invalidEndTs: 0,
    invalidRemaining: 0,
    unitSecondsDetected: 0
  };
}

function normalizeWindowRejectBucket(reason: string | undefined): "tooSoon" | "tooLate" | "invalid" {
  const normalized = String(reason || "")
    .trim()
    .toLowerCase();
  if (
    normalized.includes("too_soon") ||
    normalized.includes("above_max") ||
    normalized.includes("remaining_above")
  ) {
    return "tooSoon";
  }
  if (
    normalized.includes("too_late") ||
    normalized.includes("below_min") ||
    normalized.includes("remaining_below") ||
    normalized.includes("expired")
  ) {
    return "tooLate";
  }
  return "invalid";
}

function normalizeWindowRejectReason(reason: string | undefined): string {
  const normalized = String(reason || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "missing_window";
  if (
    normalized.includes("too_soon") ||
    normalized.includes("above_max") ||
    normalized.includes("remaining_above")
  ) {
    return "too_soon";
  }
  if (
    normalized.includes("too_late") ||
    normalized.includes("below_min") ||
    normalized.includes("remaining_below") ||
    normalized.includes("expired")
  ) {
    return "too_late";
  }
  if (normalized.includes("end")) {
    return "bad_end";
  }
  if (normalized.includes("window") || normalized.includes("remaining")) {
    return "missing_window";
  }
  return normalized.replace(/\s+/g, "_");
}

function deriveWindowRejectCountersFromCounts(counts?: Record<string, number>): WindowRejectCounters {
  const out = createWindowRejectCounters();
  if (!counts || Object.keys(counts).length === 0) {
    return out;
  }
  for (const [reason, raw] of Object.entries(counts)) {
    const qty = Math.max(0, Math.floor(Number(raw || 0)));
    if (!(qty > 0)) continue;
    const normalized = String(reason || "")
      .trim()
      .toLowerCase();
    if (normalized.includes("unit") || normalized.includes("seconds")) {
      out.unitSecondsDetected += qty;
      continue;
    }
    const bucket = normalizeWindowRejectBucket(normalized);
    if (bucket === "tooSoon") {
      out.tooSoon += qty;
      continue;
    }
    if (bucket === "tooLate") {
      out.tooLate += qty;
      continue;
    }
    if (normalized.includes("end")) {
      out.invalidEndTs += qty;
      continue;
    }
    out.invalidRemaining += qty;
  }
  return out;
}

function formatWindowRejectSummaryFromCounters(counters?: WindowRejectCounters): string {
  const safe = counters ? { ...counters } : createWindowRejectCounters();
  const invalid = Math.max(0, safe.invalidEndTs + safe.invalidRemaining);
  return `tooSoon:${safe.tooSoon}|tooLate:${safe.tooLate}|invalid:${invalid}|secUnitFix:${safe.unitSecondsDetected}`;
}

function computeDominantWindowRejectReason(counters: WindowRejectCounters): string {
  const ranked: Array<{ reason: string; count: number }> = [
    { reason: "tooSoon", count: counters.tooSoon },
    { reason: "tooLate", count: counters.tooLate },
    { reason: "invalidEndTs", count: counters.invalidEndTs },
    { reason: "invalidRemaining", count: counters.invalidRemaining },
    { reason: "unitSecondsDetected", count: counters.unitSecondsDetected }
  ];
  ranked.sort((a, b) => b.count - a.count);
  const top = ranked[0];
  if (!top || top.count <= 0) {
    return "none";
  }
  return top.reason;
}

function classifyRejectReason(reason: string): { stage: RejectStage; reason: string } {
  const normalized = String(reason || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!normalized) {
    return { stage: "scoring", reason: "unknown" };
  }
  if (
    normalized.includes("out_of_range") ||
    normalized.includes("window") ||
    normalized.includes("final_seconds")
  ) {
    return { stage: "window", reason: normalized };
  }
  if (
    normalized.includes("oracle") ||
    normalized.includes("missing_bbo") ||
    normalized.includes("crossed_bbo") ||
    normalized.includes("yes_mid") ||
    normalized.includes("network")
  ) {
    return { stage: "dataHealth", reason: normalized };
  }
  if (normalized.includes("spread")) {
    return { stage: "pattern", reason: normalized };
  }
  return { stage: "scoring", reason: normalized };
}

function toPositiveIntOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : fallback;
}

function parseBooleanEnv(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function truncateText(value: string, maxLen: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function collectOutcomeText(row: Record<string, unknown>): string {
  const fields: unknown[] = [
    row.outcomes,
    row.outcomeNames,
    row.outcome_names,
    row.options,
    row.tokens,
    row.outcomeTokens
  ];
  const out: string[] = [];
  const ingest = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      const normalized = value.trim();
      if (!normalized) return;
      if (normalized.startsWith("[") && normalized.endsWith("]")) {
        try {
          const parsed = JSON.parse(normalized);
          ingest(parsed);
          return;
        } catch {
          // keep raw string fallback
        }
      }
      out.push(normalized);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        ingest(item);
      }
      return;
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const candidate = pickRawString(obj, ["name", "title", "label", "outcome", "tokenName", "token_name"]);
      if (candidate) out.push(candidate);
    }
  };
  for (const field of fields) ingest(field);
  const deduped = Array.from(
    new Set(
      out
        .map((row) => row.replace(/\s+/g, " ").trim())
        .filter((row) => row.length > 0)
    )
  );
  return deduped.join(" ");
}

function rawMarketMatches(row: Record<string, unknown>, marketId: string, slug: string): boolean {
  const targetId = String(marketId || "").trim();
  const targetSlug = String(slug || "").trim().toLowerCase();
  const rowId = pickRawString(row, ["id", "market_id", "conditionId", "condition_id"]);
  const rowSlug = pickRawString(row, ["slug", "market_slug", "eventSlug", "event_slug"]).toLowerCase();
  if (targetId && rowId && rowId === targetId) return true;
  if (targetSlug && rowSlug && rowSlug === targetSlug) return true;
  return false;
}

function parseRawMarketToBtcWindow(
  row: Record<string, unknown>,
  nowTs: number,
  fallbackWindowEndMs: number,
  oracleReferencePrice: number | null
): BtcWindowMarket | null {
  const marketId = pickRawString(row, ["id", "market_id", "conditionId", "condition_id"]);
  if (!marketId) return null;
  const slug =
    pickRawString(row, ["slug", "market_slug", "eventSlug", "event_slug"]) || marketId;
  const question =
    pickRawString(row, ["question", "title", "description", "subtitle"]) || slug;
  const active = pickRawBoolean(row, ["active", "is_active"], true);
  const closed = pickRawBoolean(row, ["closed", "is_closed", "resolved"], false);
  const acceptingOrders = pickRawBoolean(
    row,
    ["accepting_orders", "acceptingOrders", "tradable"],
    true
  );
  const enableOrderBook = pickRawBoolean(
    row,
    ["enable_order_book", "enableOrderBook"],
    true
  );
  const endTs = pickRawTimestamp(
    row,
    [
      "windowEndTs",
      "window_end_ts",
      "endTs",
      "end_ts",
      "endDate",
      "end_date",
      "end_time",
      "endTime",
      "end_date_iso",
      "eventEndTime",
      "resolutionTime",
      "resolution_time",
      "expiresAt",
      "expires_at"
    ]
  );
  const normalizedEndTs = endTs > 0 ? endTs : fallbackWindowEndMs;
  if (!(normalizedEndTs > nowTs)) return null;
  const startTs = pickRawTimestamp(
    row,
    [
      "windowStartTs",
      "window_start_ts",
      "startTs",
      "start_ts",
      "startDate",
      "start_date",
      "start_time",
      "startTime"
    ]
  );
  let priceToBeat = sanitizePaperPriceToBeatCandidate(
    pickRawNumber(row, [
    "price_to_beat",
    "priceToBeat",
    "target_price",
    "strike",
    "threshold"
    ]),
    question,
    slug,
    oracleReferencePrice
  );
  if (!(priceToBeat > 0)) {
    priceToBeat = sanitizePaperPriceToBeatCandidate(
      parsePriceToBeatFromText(question),
      question,
      slug,
      oracleReferencePrice
    );
  }
  if (!(priceToBeat > 0)) {
    priceToBeat = oracleReferencePrice && oracleReferencePrice > 0 ? oracleReferencePrice : 50_000;
  }
  const clobTokenIds = parseRawStringArray(row.clobTokenIds);
  const yesTokenId = clobTokenIds[0];
  const noTokenId = clobTokenIds[1];
  if (!yesTokenId || !noTokenId || yesTokenId === noTokenId) return null;
  const directionalLabels = deriveDirectionalDisplayLabelsFromRawMarket(row, question);
  const tickSize = normalizeTickSize(
    pickRawString(row, ["minimum_tick_size", "tickSize", "tick_size"])
  );
  const negRisk = pickRawBoolean(row, ["negRisk", "neg_risk"], false);
  return {
    marketId,
    slug,
    question,
    priceToBeat,
    endTs: normalizedEndTs,
    startTs: startTs > 0 ? startTs : undefined,
    yesTokenId,
    noTokenId,
    yesDisplayLabel: directionalLabels.yesDisplayLabel,
    noDisplayLabel: directionalLabels.noDisplayLabel,
    tickSize: tickSize ?? undefined,
    negRisk,
    acceptingOrders,
    active,
    enableOrderBook,
    closed,
    eventSlug: pickRawString(row, ["eventSlug", "event_slug"]) || undefined,
    yesBidHint: pickRawNumber(row, ["bestBid", "yesBid", "bid", "best_bid"]),
    yesAskHint: pickRawNumber(row, ["bestAsk", "yesAsk", "ask", "best_ask"]),
    yesMidHint: pickRawNumber(row, ["mid", "yesMid", "mark", "price"]),
    yesLastTradeHint: pickRawNumber(row, ["lastTradePrice", "last_price", "last"]),
    outcomePricesHint: parseOutcomePricesHint(row)
  };
}

function parseOutcomePricesHint(row: Record<string, unknown>): number[] | undefined {
  const raw = row.outcomePrices;
  if (Array.isArray(raw)) {
    const prices = raw.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    return prices.length > 0 ? prices : undefined;
  }
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const prices = parsed.map((value) => Number(value)).filter((value) => Number.isFinite(value));
        return prices.length > 0 ? prices : undefined;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function deriveDirectionalDisplayLabelsFromRawMarket(
  row: Record<string, unknown>,
  question: string
): { yesDisplayLabel: string; noDisplayLabel: string } {
  const outcomes = parseRawStringArray(
    row.outcomes ??
      row.outcomeNames ??
      row.outcome_names ??
      row.options ??
      row.labels
  );
  const yesCandidate = outcomes[0];
  const noCandidate = outcomes[1];
  return {
    yesDisplayLabel: normalizeDirectionalDisplayLabel(yesCandidate, question, "YES"),
    noDisplayLabel: normalizeDirectionalDisplayLabel(noCandidate, question, "NO")
  };
}

function normalizeDirectionalDisplayLabel(
  raw: string | null | undefined,
  question: string | null | undefined,
  side: "YES" | "NO"
): string {
  const normalized = String(raw || "").trim().toUpperCase();
  if (
    normalized.includes("UP") ||
    normalized.includes("HIGHER") ||
    normalized.includes("ABOVE") ||
    normalized.includes("RISE")
  ) {
    return "UP";
  }
  if (
    normalized.includes("DOWN") ||
    normalized.includes("LOWER") ||
    normalized.includes("BELOW") ||
    normalized.includes("FALL")
  ) {
    return "DOWN";
  }
  const text = String(question || "").trim().toLowerCase();
  if (text.includes("above") || text.includes("higher") || text.includes("up")) {
    return side === "YES" ? "UP" : "DOWN";
  }
  if (text.includes("below") || text.includes("lower") || text.includes("down")) {
    return side === "YES" ? "DOWN" : "UP";
  }
  return side === "YES" ? "UP" : "DOWN";
}

function parseRawTokens(
  row: Record<string, unknown>
): Array<{ outcome: "yes" | "no" | "other"; tokenId: string }> {
  const outcomes = parseRawOutcomeNames(row);
  const tokensRaw = row.tokens;
  if (Array.isArray(tokensRaw)) {
    if (tokensRaw.every((item) => typeof item === "string" || typeof item === "number")) {
      return tokensRaw
        .map((item, idx) => {
          const tokenId = String(item || "").trim();
          if (!tokenId) return null;
          return {
            outcome: normalizeOutcomeName(outcomes[idx]),
            tokenId
          };
        })
        .filter(
          (row): row is { outcome: "yes" | "no" | "other"; tokenId: string } =>
            row !== null
        );
    }
    const out: Array<{ outcome: "yes" | "no" | "other"; tokenId: string }> = [];
    for (const token of tokensRaw) {
      if (!token || typeof token !== "object") continue;
      const obj = token as Record<string, unknown>;
      const tokenId = pickRawString(obj, ["token_id", "tokenId", "id", "clob_token_id"]);
      if (!tokenId) continue;
      out.push({
        outcome: normalizeOutcomeName(
          pickRawString(obj, ["outcome", "name", "label"]) || undefined
        ),
        tokenId
      });
    }
    if (out.length > 0) return out;
  }
  const clobTokenIds = parseRawStringArray(row.clobTokenIds);
  return clobTokenIds.map((tokenId, idx) => ({
    outcome: normalizeOutcomeName(outcomes[idx]),
    tokenId
  }));
}

function normalizeOutcomeName(value: string | undefined): "yes" | "no" | "other" {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "yes" ||
    normalized.includes("up") ||
    normalized.includes("higher") ||
    normalized.includes("above")
  ) {
    return "yes";
  }
  if (
    normalized === "no" ||
    normalized.includes("down") ||
    normalized.includes("lower") ||
    normalized.includes("below")
  ) {
    return "no";
  }
  return "other";
}

function parseRawOutcomeNames(row: Record<string, unknown>): string[] {
  if (Array.isArray(row.outcomes)) {
    return row.outcomes
      .map((value) => String(value || "").trim())
      .filter((value) => value.length > 0);
  }
  if (typeof row.outcomes === "string" && row.outcomes.trim().length > 0) {
    try {
      const parsed = JSON.parse(row.outcomes);
      if (Array.isArray(parsed)) {
        return parsed
          .map((value) => String(value || "").trim())
          .filter((value) => value.length > 0);
      }
    } catch {
      return [];
    }
  }
  return [];
}

function parseRawStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((row) => String(row || "").trim())
      .filter((row) => row.length > 0);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed
            .map((row) => String(row || "").trim())
            .filter((row) => row.length > 0);
        }
      } catch {
        return [];
      }
    }
    return trimmed
      .split(",")
      .map((row) => row.trim())
      .filter((row) => row.length > 0);
  }
  return [];
}

function pickRawString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function pickRawNumber(obj: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = obj[key];
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function pickRawBoolean(obj: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "y"].includes(normalized)) return true;
      if (["0", "false", "no", "n"].includes(normalized)) return false;
    }
  }
  return fallback;
}

function pickRawTimestamp(obj: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const ms = toMs(obj[key]);
    if (ms > 0) return ms;
  }
  return 0;
}

function parsePriceToBeatFromText(text: string): number {
  const normalized = String(text || "").replace(/,/g, "");
  const contextualPatterns = [
    /(?:price\s+to\s+beat|target(?:\s+price)?|strike|threshold|from|at|above|below|over|under|higher\s+than|lower\s+than)\s*\$?([0-9]+(?:\.[0-9]+)?)\s*(?:usd)?/i,
    /\$([0-9]+(?:\.[0-9]+)?)\s*(?:usd)?/i
  ];
  for (const pattern of contextualPatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return Number.NaN;
}

function sanitizePaperPriceToBeatCandidate(
  candidate: number,
  question: string,
  slug: string,
  oracleReferencePrice: number | null
): number {
  if (!(candidate > 0)) return Number.NaN;
  const normalizedQuestion = String(question || "").trim().toLowerCase();
  const normalizedSlug = String(slug || "").trim().toLowerCase();
  const isBtc5mFastMarket =
    normalizedSlug.startsWith("btc-updown-5m-") ||
    (normalizedQuestion.includes("bitcoin") || normalizedQuestion.includes("btc")) &&
      (normalizedQuestion.includes("5 minute") || normalizedQuestion.includes("next 5 minutes"));
  const hasExplicitStrikeHint =
    /\$\s*[0-9]/.test(normalizedQuestion) ||
    /\b(price\s+to\s+beat|target(?:\s+price)?|strike|threshold|from|at|above|below|over|under|higher\s+than|lower\s+than)\b/.test(
      normalizedQuestion
    );
  const oraclePrice = Number(oracleReferencePrice || 0);
  if (isBtc5mFastMarket && oraclePrice > 0 && !hasExplicitStrikeHint) {
    const minReasonable = oraclePrice * 0.5;
    const maxReasonable = oraclePrice * 1.5;
    if (candidate < minReasonable || candidate > maxReasonable) {
      return Number.NaN;
    }
  }
  return candidate;
}

function normalizeTickSize(value: string): "0.1" | "0.01" | "0.001" | "0.0001" | null {
  const normalized = String(value || "").trim();
  if (normalized === "0.1" || normalized === "0.01" || normalized === "0.001" || normalized === "0.0001") {
    return normalized;
  }
  return null;
}

function isTransientPolymarketError(error: unknown): boolean {
  const message = String(
    error && typeof error === "object" && "message" in error
      ? (error as { message?: unknown }).message
      : error
  )
    .toLowerCase()
    .trim();

  return (
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("socket") ||
    message.includes("fetch failed") ||
    message.includes("circuit open") ||
    message.includes("aborted") ||
    message.includes("network")
  );
}

function toMs(ts: number): number;
function toMs(ts: unknown): number;
function toMs(ts: unknown): number {
  if (ts === null || ts === undefined) return 0;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    if (ts <= 0) return 0;
    if (ts < 1e12) return Math.floor(ts * 1000);
    if (ts < 1e15) return Math.floor(ts);
    if (ts < 1e18) return Math.floor(ts / 1000);
    return 0;
  }
  if (typeof ts === "string") {
    const trimmed = ts.trim();
    if (!trimmed) return 0;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      if (numeric < 1e12) return Math.floor(numeric * 1000);
      if (numeric < 1e15) return Math.floor(numeric);
      if (numeric < 1e18) return Math.floor(numeric / 1000);
      return 0;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return 0;
}

function toMsOrNull(ts: unknown): number | null {
  const ms = toMs(ts);
  return ms > 0 ? ms : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHoldReason(reason: string | null | undefined): string | null {
  const raw = String(reason || "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper.startsWith("HOLD:")) {
    return normalizeHoldReason(raw.slice(5));
  }
  if (upper === "HOLD") return "HOLD_GENERIC";
  if (upper.includes("NO_ACTIVE_BTC5M_MARKET") || upper.includes("BTC5M_NOT_FOUND")) return "NO_ACTIVE_BTC5M_MARKET";
  if (upper.includes("EXPIRED_WINDOW")) return "EXPIRED_WINDOW";
  if (upper.includes("AWAITING_RESOLUTION") || upper.includes("MARKET_CLOSED_AWAITING_OUTCOME")) {
    return "AWAITING_RESOLUTION";
  }
  if (upper.includes("NO_NEW_ORDERS_FINAL_SECONDS")) return "NO_NEW_ORDERS_FINAL_SECONDS";
  if (upper.includes("OPEN_POSITION_IN_WINDOW")) return "OPEN_POSITION_IN_WINDOW";
  if (upper.includes("REENTRY_COOLDOWN")) return "REENTRY_COOLDOWN";
  if (upper.includes("TOO_LATE_FOR_ENTRY")) return "TOO_LATE_FOR_ENTRY";
  if (upper.includes("SIZE_BELOW_MIN_NOTIONAL")) return "SIZE_BELOW_MIN_NOTIONAL";
  if (upper.includes("WINDOW_ALREADY_OPEN") || upper.includes("WINDOW_ALREADY_TRADED")) return "DUPLICATE_WINDOW";
  if (upper.includes("ORACLE_STALE_BOOK_STALE")) return "ORACLE_STALE_BOOK_STALE";
  if (upper.includes("OUTSIDE_SNIPING_WINDOW")) return "WINDOW_OUTSIDE_SNIPER_RANGE";
  if (upper.includes("NET_EDGE_BELOW_PAPER_MIN") || upper.includes("NET_EDGE_BELOW_MIN_NET_EDGE")) {
    return "EDGE_BELOW_THRESHOLD";
  }
  if (upper.includes("TRADING_PAUSED")) return "TRADING_PAUSED";
  if (upper.includes("ORACLE_STALE")) return "ORACLE_STALE";
  if (upper.includes("ORACLE_UNAVAILABLE")) return "ORACLE_UNAVAILABLE";
  if (upper.includes("ORACLE_IDLE")) return "ORACLE_IDLE";
  if (upper.includes("NO_CANDIDATE")) return "NO_CANDIDATES";
  const normalized = raw
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function parseBtc5mWindowStartSec(slug: string | null | undefined): number | null {
  const text = String(slug || "").trim();
  const match = text.match(/^btc-updown-5m-(\d{9,12})$/i);
  if (!match) return null;
  const startSec = Number(match[1]);
  if (!Number.isFinite(startSec) || startSec <= 0) return null;
  return Math.floor(startSec);
}

class ExistingSpotFeedAdapter implements SpotFeed {
  private readonly fetcher: CrossVenueFetcher;

  constructor(config: BotConfig) {
    this.fetcher = new CrossVenueFetcher(config);
  }

  async fetch(symbol: string, nowTs = Date.now()): Promise<SpotVenueTick[]> {
    const rows = await this.fetcher.fetch(symbol, nowTs);
    return rows.map((row) => ({
      venue: row.venue,
      ts: row.ts,
      bid: row.bid,
      ask: row.ask,
      mid: row.mid,
      last: row.mid,
      spreadBps: row.spread_bps,
      ok: row.ok,
      error: row.error
    }));
  }
}
