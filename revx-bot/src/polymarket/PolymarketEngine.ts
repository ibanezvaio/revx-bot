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
import { Btc5mDirectSlugResolver } from "./Btc5mDirectSlugResolver";
import { SelectedMarketFeed } from "./SelectedMarketFeed";
import { Sizing } from "./Sizing";
import { Strategy } from "./Strategy";
import { FIVE_MIN_SEC, deriveBtc5mBuckets, slugForTs, windowTs } from "./btc5m";
import { BtcWindowMarket, DecisionLogLine, SpotFeed, SpotVenueTick, StrategyDecision } from "./types";
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
type Btc5mSelectionSource =
  | "current_slug"
  | "next_slug"
  | "fallback_discovery"
  | "DIRECT_SLUG"
  | "FALLBACK_SCAN";
type SelectionSource = Btc5mSelectionSource | "committed";
type RuntimeStartupState =
  | "STARTING"
  | "RUNNING"
  | "RUNNING_DEGRADED"
  | "HOLD_NO_ACTIVE_BTC5M_MARKET";
type LivePollMode =
  | "NORMAL"
  | "FAST"
  | "VERY_FAST"
  | "DISCOVERY_STALE"
  | "EXPIRING"
  | "FAST_DISCOVERY_NEXT"
  | "LOCKED_ON_WINDOW";
type SelectionBucketReconcileAction =
  | "KEEP_CURRENT_SELECTION"
  | "PROMOTE_CURRENT_BUCKET"
  | "KEEP_NEXT_PREFETCH"
  | "CLEAR_STALE_SELECTION";
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
type BookLookupSource = "live" | "cached" | "inferred" | "missing";
type YesBookLookup = YesBookSnapshot & {
  source: BookLookupSource;
  bookable: boolean;
};

type DecisionPriceLookup = {
  bid: number;
  ask: number;
  mid: number;
  price: number;
  spread: number;
  topBidSize: number;
  topAskSize: number;
  ts: number;
  source: BookLookupSource;
  priceFetchFailed: boolean;
};

type TokenBookSnapshot = {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  mark: number | null;
  markSource: string | null;
  bookTs: number;
};
type TokenBookLookup = {
  bestBid: number | null;
  bestAsk: number | null;
  topBidSize: number;
  topAskSize: number;
  bookTs: number;
  source: BookLookupSource;
  bookable: boolean;
};

type LiveCommittedSelection = {
  selectedSlug: string | null;
  selectedMarketId: string | null;
  selectedEpoch: number | null;
  windowStartTs: number | null;
  windowEndTs: number | null;
  selectedWindowStartSec: number | null;
  selectedWindowEndSec: number | null;
  candidateRefreshed: boolean | null;
  chosenDirection: string | null;
  chosenSide: "YES" | "NO" | null;
  yesTokenId: string | null;
  noTokenId: string | null;
  selectedTokenId: string | null;
  selectedBookable: boolean;
  selectedTradable: boolean;
  discoveredCurrent: boolean;
  discoveredNext: boolean;
  selectionSource: SelectionSource;
  selectedFrom: SelectionSource;
  liveValidationReason: string | null;
  lastBookTs: number | null;
  lastQuoteTs: number | null;
  selectionCommitTs: number | null;
  currentBucketSlug: string | null;
  nextBucketSlug: string | null;
  currentBucketStartSec: number | null;
  acceptingOrders: boolean | null;
  enableOrderBook: boolean | null;
  selectedReason: string | null;
  holdReason: string | null;
  warningState: string | null;
  executionBlockedReason: string | null;
  executionBlockedSide: "YES" | "NO" | null;
};

type PersistedPolymarketSnapshot = {
  status: string | null;
  staleState: "ACTIVE_MARKET_REFRESH_FAILED" | "ACTIVE_MARKET_PRICE_STALE" | "DISCOVERY_STALE" | null;
  pollMode: LivePollMode | null;
  action: "OPEN" | "CLOSE" | "RESOLVE" | "HOLD" | null;
  selectedSlug: string | null;
  selectedMarketId: string | null;
  selectedEpoch: number | null;
  windowStartTs: number | null;
  windowEndTs: number | null;
  remainingSec: number | null;
  chosenSide: "YES" | "NO" | null;
  chosenDirection: string | null;
  holdReason: string | null;
  executionBlockedReason: string | null;
  holdCategory: HoldCategory | null;
  strategyAction: string | null;
  selectedTokenId: string | null;
  selectedBookable: boolean;
  selectedTradable: boolean;
  discoveredCurrent: boolean;
  discoveredNext: boolean;
  selectionSource: SelectionSource | null;
  selectedFrom: SelectionSource | null;
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
  warningState: string | null;
  dynamicThresholdMetric: number | null;
  finalCandidatesCount: number | null;
  discoveredCandidatesCount: number | null;
  windowsCount: number | null;
  discoveredAtTs: number | null;
  marketExpiresAtTs: number | null;
  lastDiscoverySuccessTs: number | null;
  lastDecisionTs: number | null;
  lastSelectedMarketTs: number | null;
  currentBtcMid: number | null;
  minVenueShares: number | null;
  desiredShares: number | null;
  finalShares: number | null;
  desiredNotional: number | null;
  finalNotional: number | null;
  sizeBumped: boolean | null;
  lastNormalizedError: string | null;
  statusLine: string | null;
};

type HoldCategory = "STRATEGY" | "DATA_HEALTH" | "EXECUTION" | "AUTH" | "RISK";

type SharedDecisionEvaluation = {
  chooserReason: string;
  chosenSide: "YES" | "NO" | null;
  chosenDirection: string | null;
  chosenEdge: number;
  signedEdge: number;
  chosenAsk: number;
  score: number;
  costPenaltyProb: number;
  edgeYes: number;
  edgeNo: number;
  netEdgeYes: number;
  netEdgeNo: number;
  netEdgeAfterCosts: number;
  stalenessEdge: number;
  conviction: number;
  isExtremePrice: boolean;
  hasExtremeModel: boolean;
  requiredNetEdge: number;
  strategyBlock: string | null;
  strategyBlockDetail: string | null;
  dataHealthBlock: string | null;
  holdReason: string | null;
  blockedBy: string | null;
  blockedCategory: HoldCategory | null;
  paperWouldTrade: boolean;
  action: "BUY_YES" | "BUY_NO" | "HOLD";
};

type Btc5mWallClockBucket = {
  nowSec: number;
  bucketStartSec: number;
  currentBucketStartSec: number;
  expectedSlug: string;
  currentSlug: string;
  prevSlug: string;
  nextSlug: string;
  windowStartTs: number;
  windowEndTs: number;
  remainingSec: number;
};

type Btc5mTickContext = {
  tickNowMs: number;
  tickNowSec: number;
  currentBucketStartSec: number;
  prevBucketStartSec: number;
  nextBucketStartSec: number;
  currentBucketSlug: string;
  prevBucketSlug: string;
  nextBucketSlug: string;
  remainingSec: number;
  bucket: Btc5mWallClockBucket;
};

type LivePreorderValidationReason =
  | "ok"
  | "token_not_bookable"
  | "stale_market_selection"
  | "stale_token_ids"
  | "token_mismatch"
  | "expired_window"
  | "remaining_below_threshold"
  | "market_not_active"
  | "market_closed"
  | "market_archived"
  | "invalid_window"
  | "discovery_failed";

type LiveExecutionCandidateValidation = {
  valid: boolean;
  reason: LivePreorderValidationReason;
  selectedSlug: string | null;
  expectedSlug: string | null;
  marketId: string | null;
  tokenId: string | null;
  marketStartTs: number | null;
  marketEndTs: number | null;
  remainingSec: number | null;
  pollMode: LivePollMode | null;
  candidateRefreshed: boolean;
  refreshedMarket: BtcWindowMarket | null;
  selectedTokenId: string | null;
};

type LiveMarketTradabilityValidation = {
  tradable: boolean;
  tokenId: string | null;
  bookable: boolean;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  lastBookTs: number | null;
  lastQuoteTs: number | null;
  reason: string;
};

function createPersistedPolymarketSnapshot(): PersistedPolymarketSnapshot {
  return {
    status: null,
    staleState: null,
    pollMode: null,
    action: null,
    selectedSlug: null,
    selectedMarketId: null,
    selectedEpoch: null,
    windowStartTs: null,
    windowEndTs: null,
    remainingSec: null,
    chosenSide: null,
    chosenDirection: null,
    holdReason: null,
    executionBlockedReason: null,
    holdCategory: null,
    strategyAction: null,
    selectedTokenId: null,
    selectedBookable: false,
    selectedTradable: false,
    discoveredCurrent: false,
    discoveredNext: false,
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
    warningState: null,
    dynamicThresholdMetric: null,
    finalCandidatesCount: null,
    discoveredCandidatesCount: null,
    windowsCount: null,
    discoveredAtTs: null,
    marketExpiresAtTs: null,
    lastDiscoverySuccessTs: null,
    lastDecisionTs: null,
    lastSelectedMarketTs: null,
    currentBtcMid: null,
    minVenueShares: null,
    desiredShares: null,
    finalShares: null,
    desiredNotional: null,
    finalNotional: null,
    sizeBumped: null,
    lastNormalizedError: null,
    statusLine: null
  };
}

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
  private readonly directSlugResolver: Btc5mDirectSlugResolver;
  private readonly selectedMarketFeed: SelectedMarketFeed;
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
  private lastUsableLiveSelectedMarket: BtcWindowMarket | null = null;
  private liveCommittedSelection: LiveCommittedSelection | null = null;
  private persistedPolymarketSnapshot: PersistedPolymarketSnapshot = createPersistedPolymarketSnapshot();
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
  private runtimeWarningState: string | null = null;
  private tickWarningState: string | null = null;
  private runtimeStartupState: RuntimeStartupState = "STARTING";
  private runtimeStartupStateReason: string | null = null;
  private runtimeStartupWatchdogLastLogTs = 0;
  private runtimeStartupWatchdogLastSignature = "";
  private lastExpectedCurrentBtc5mSlugLogged: string | null = null;
  private lastDelayedBookConfirmationSignature = "";
  private lastDiscoveryDegradedSignature = "";
  private lastDiscoveryDegradedLogTs = 0;
  private lastSelectorDiagnosticSignature = "";
  private lastSelectionBugSignature = "";
  private lastSelectionCommitRecoverySignature = "";
  private lastBookFallbackWarningSignature = "";
  private lastBookFallbackWarningLogTs = 0;
  private lastIntentionalHoldSignature = "";
  private lastIntentionalHoldLogTs = 0;
  private lastPolyStatusSignature = "";
  private lastPolyRolloverSignature = "";
  private lastUiStatusSignature = "";
  private lastPolyDebugSignature = "";
  private readonly polyPollTrace: Array<Record<string, unknown>> = [];
  private readonly polyRolloverTrace: Array<Record<string, unknown>> = [];
  private lastRolloverPlanBucketSignature = "";
  private truthLastAction: "OPEN" | "CLOSE" | "RESOLVE" | "HOLD" = "HOLD";
  private truthLastActionTs = 0;
  private truthLastTradeId: string | null = null;
  private truthLastSlug: string | null = null;
  private truthLastTradeTs: number | null = null;
  private truthHoldReason: string | null = null;
  private truthChosenSide: "YES" | "NO" | null = null;
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
    this.directSlugResolver = new Btc5mDirectSlugResolver(this.client, logger);
    this.selectedMarketFeed = new SelectedMarketFeed(logger, resolvePolymarketMarketWsUrl(config.polymarket.baseUrls.clob));
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
    this.logger.warn(
      {
        minEdgeThresholdConfig: this.config.polymarket.live.minEdgeThreshold,
        maxSpreadConfig: this.config.polymarket.live.maxSpread,
        minEntryRemainingSec: this.config.polymarket.live.minEntryRemainingSec,
        enableNoSide: this.config.polymarket.live.enableNoSide
      },
      "POLY_V2_LIVE_GATE_CONFIG"
    );
    await this.client.runStartupSanityCheck(this.config.strictSanityCheck);
    this.running = true;
    this.polyEngineRunning = true;
    this.runtimeStartupState = "STARTING";
    this.runtimeStartupStateReason = "ENGINE_START";
    this.runtimeStartupWatchdogLastLogTs = 0;
    this.runtimeStartupWatchdogLastSignature = "";
    this.liveCommittedSelection = null;
    this.selectedMarketFeed.stop();
    this.lastExpectedCurrentBtc5mSlugLogged = null;
    this.lastDelayedBookConfirmationSignature = "";
    this.lastSelectionCommitRecoverySignature = "";
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
    this.polyEngineRunning = false;
    this.runtimeStartupState = "STARTING";
    this.runtimeStartupStateReason = reason;
    this.runtimeStartupWatchdogLastLogTs = 0;
    this.runtimeStartupWatchdogLastSignature = "";
    this.liveCommittedSelection = null;
    this.selectedMarketFeed.stop();
    this.lastExpectedCurrentBtc5mSlugLogged = null;
    this.lastDelayedBookConfirmationSignature = "";
    this.lastSelectionCommitRecoverySignature = "";
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
    pollMode: LivePollMode | null;
    staleState: string | null;
    statusLine: string | null;
    discoveredAtTs: number | null;
    marketExpiresAtTs: number | null;
    lastDiscoverySuccessTs: number | null;
    lastDecisionTs: number | null;
    lastSelectedMarketTs: number | null;
    threshold: number | null;
    minEdgeThresholdConfig: number;
    dynamicThresholdMetric: number | null;
    currentBtcMid: number | null;
    minVenueShares: number | null;
    desiredShares: number | null;
    finalShares: number | null;
    desiredNotional: number | null;
    finalNotional: number | null;
    sizeBumped: boolean | null;
    lastNormalizedError: string | null;
    pollTrace: Array<Record<string, unknown>>;
    rolloverTrace: Array<Record<string, unknown>>;
    currentMarketSlug: string | null;
    currentMarketRemainingSec: number | null;
    currentMarketExpiresAt: number | null;
    whyNotTrading: string | null;
    currentMarketStatus: string | null;
    mode: "paper" | "live";
    polyMoney: boolean;
    lastAction: "OPEN" | "CLOSE" | "RESOLVE" | "HOLD";
    holdReason: string | null;
    blockedBy: string | null;
    currentWindowHoldReason: string | null;
    holdCategory: HoldCategory | null;
    strategyAction: string | null;
    selectedTokenId: string | null;
    selectedBookable: boolean;
    selectedTradable: boolean;
    discoveredCurrent: boolean;
    discoveredNext: boolean;
    selectionSource: SelectionSource | null;
    selectedFrom: SelectionSource | null;
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
      chosenSide: "YES" | "NO" | null;
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
    const startupExited = this.runtimeStartupState !== "STARTING";
    const polyEngineRunning =
      this.running || this.polyEngineRunning || this.polyState.lastFetchAttemptTs > 0 || startupExited;
    const lastUpdateTs = Math.max(0, this.polyState.lastUpdateTs, this.polyState.lastFetchOkTs);
    const lastUpdateAgeSec =
      lastUpdateTs > 0 ? Math.max(0, Math.floor((nowTs - lastUpdateTs) / 1000)) : null;
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(nowTs);
    const selectionSnapshot = this.getTruthSelectionSnapshot(nowTs);
    const hasActiveSelection = Boolean(selectionSnapshot.selectedSlug || selectionSnapshot.selectedMarketId);
    const staleVisibility = persistedSnapshot.staleState;
    const fetchRecent =
      this.polyState.lastFetchOkTs > 0 && nowTs - this.polyState.lastFetchOkTs <= 60_000;
    const status: "STARTING" | "RUNNING" | "STALE" =
      lastUpdateTs <= 0
        ? polyEngineRunning || startupExited
          ? "RUNNING"
          : "STARTING"
        : fetchRecent || (lastUpdateAgeSec !== null && lastUpdateAgeSec <= 30) || hasActiveSelection
          ? "RUNNING"
          : "STALE";
    const lifecycleStatus = this.getPaperLifecycleStatus(nowTs, selectionSnapshot);
    const effectiveLifecycleStatus =
      this.config.polymarket.mode === "live" ? persistedSnapshot.pollMode : lifecycleStatus;
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
      (normalizedTruthHoldReason === "OPEN_POSITION_IN_WINDOW" ||
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
    const pendingDiscoveryHoldReason =
      hasActiveSelection &&
      (persistedSnapshot.status === "ROLLOVER_PENDING" || persistedSnapshot.status === "EXPIRED_PENDING_DISCOVERY")
        ? normalizeHoldReason(persistedSnapshot.holdReason)
        : null;
    const currentWindowHoldReason =
      effectiveLastAction === "HOLD"
        ? pendingDiscoveryHoldReason ??
          derivedDynamicHoldReason ??
          (truthHoldReasonIsFresh &&
          !truthDynamicHoldReason &&
          normalizedTruthHoldReason !== "REENTRY_COOLDOWN" &&
          normalizedTruthHoldReason !== "OPEN_POSITION_IN_WINDOW" &&
          normalizedTruthHoldReason !== "TOO_LATE_FOR_ENTRY" &&
          normalizedTruthHoldReason !== "EXPIRED_WINDOW"
            ? normalizedTruthHoldReason
            : null)
          ??
          (() => {
            const persistedHoldReason = hasActiveSelection
              ? normalizeHoldReason(persistedSnapshot.holdReason)
              : null;
            if (
              persistedHoldReason === "REENTRY_COOLDOWN" ||
              persistedHoldReason === "OPEN_POSITION_IN_WINDOW" ||
              persistedHoldReason === "TOO_LATE_FOR_ENTRY" ||
              persistedHoldReason === "EXPIRED_WINDOW"
            ) {
              return null;
            }
            return persistedHoldReason;
          })()
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
      warningState: this.combineWarningStates(
        pausePresentation.warningState,
        persistedSnapshot.warningState
      ),
      pollMode: persistedSnapshot.pollMode,
      staleState: staleVisibility,
      statusLine: persistedSnapshot.statusLine,
      discoveredAtTs: persistedSnapshot.discoveredAtTs,
      marketExpiresAtTs: persistedSnapshot.marketExpiresAtTs,
      lastDiscoverySuccessTs: persistedSnapshot.lastDiscoverySuccessTs,
      lastDecisionTs: persistedSnapshot.lastDecisionTs,
      lastSelectedMarketTs: persistedSnapshot.lastSelectedMarketTs,
      threshold: this.config.polymarket.live.minEdgeThreshold,
      minEdgeThresholdConfig: this.config.polymarket.live.minEdgeThreshold,
      dynamicThresholdMetric: persistedSnapshot.dynamicThresholdMetric,
      currentBtcMid: persistedSnapshot.currentBtcMid,
      minVenueShares: persistedSnapshot.minVenueShares,
      desiredShares: persistedSnapshot.desiredShares,
      finalShares: persistedSnapshot.finalShares,
      desiredNotional: persistedSnapshot.desiredNotional,
      finalNotional: persistedSnapshot.finalNotional,
      sizeBumped: persistedSnapshot.sizeBumped,
      lastNormalizedError: persistedSnapshot.lastNormalizedError,
      pollTrace: this.polyPollTrace.slice(0, 20).map((row) => ({ ...row })),
      rolloverTrace: this.polyRolloverTrace.slice(0, 20).map((row) => ({ ...row })),
      currentMarketSlug: persistedSnapshot.selectedSlug ?? persistedSnapshot.selectedMarketId,
      currentMarketRemainingSec: persistedSnapshot.remainingSec,
      currentMarketExpiresAt: persistedSnapshot.marketExpiresAtTs ?? persistedSnapshot.windowEndTs,
      whyNotTrading: currentWindowHoldReason,
      currentMarketStatus: persistedSnapshot.status ?? status,
      mode: this.config.polymarket.mode,
      polyMoney:
        this.config.polymarket.mode !== "paper" &&
        !this.config.polymarket.killSwitch &&
        this.config.polymarket.liveConfirmed &&
        this.config.polymarket.liveExecutionEnabled,
      lastAction: effectiveLastAction,
      holdReason: currentWindowHoldReason,
      blockedBy:
        normalizeHoldReason(
          persistedSnapshot.executionBlockedReason ||
            persistedSnapshot.holdReason ||
            currentWindowHoldReason
        ) ?? null,
      currentWindowHoldReason,
      holdCategory: persistedSnapshot.holdCategory,
      strategyAction: persistedSnapshot.strategyAction,
      selectedTokenId: persistedSnapshot.selectedTokenId,
      selectedBookable: Boolean(persistedSnapshot.selectedBookable),
      selectedTradable: Boolean(persistedSnapshot.selectedTradable),
      discoveredCurrent: Boolean(persistedSnapshot.discoveredCurrent),
      discoveredNext: Boolean(persistedSnapshot.discoveredNext),
      selectionSource: persistedSnapshot.selectionSource,
      selectedFrom: persistedSnapshot.selectedFrom ?? persistedSnapshot.selectionSource,
      selectionCommitTs: persistedSnapshot.selectionCommitTs,
      liveValidationReason: persistedSnapshot.liveValidationReason,
      lastBookTs: persistedSnapshot.lastBookTs,
      lastQuoteTs: persistedSnapshot.lastQuoteTs,
      currentBucketSlug: persistedSnapshot.currentBucketSlug,
      nextBucketSlug: persistedSnapshot.nextBucketSlug,
      currentBucketStartSec: persistedSnapshot.currentBucketStartSec,
      selectedWindowStartSec: persistedSnapshot.selectedWindowStartSec,
      selectedWindowEndSec: persistedSnapshot.selectedWindowEndSec,
      candidateRefreshed: persistedSnapshot.candidateRefreshed,
      lastPreorderValidationReason: persistedSnapshot.lastPreorderValidationReason,
      openTradesCount: paperResolutionStats.openTradesCount,
      awaitingResolutionCount: paperResolutionStats.awaitingResolutionCount,
      resolutionErrorCount: paperResolutionStats.resolutionErrorCount,
      resolutionQueueCount: paperResolutionStats.resolutionQueueCount,
      selection: {
        finalCandidatesCount: persistedSnapshot.finalCandidatesCount,
        discoveredCandidatesCount: persistedSnapshot.discoveredCandidatesCount,
        windowsCount: persistedSnapshot.windowsCount,
        selectedSlug: selectionSnapshot.selectedSlug,
        selectedMarketId: selectionSnapshot.selectedMarketId,
        windowStartTs: selectionSnapshot.windowStartTs,
        windowEndTs: selectionSnapshot.windowEndTs,
        remainingSec: selectionSnapshot.remainingSec,
        chosenSide: hasActiveSelection
          ? persistedSnapshot.chosenSide ?? this.truthChosenSide ?? this.getLiveSelectionSideHint(selectionSnapshot, nowTs)
          : null,
        chosenDirection: hasActiveSelection
          ? paperWindowContext?.chosenDirection ??
            persistedSnapshot.chosenDirection ??
            this.truthChosenDirection ??
            this.getLiveSelectionDirectionHint(selectionSnapshot, nowTs)
          : null,
        entriesInWindow: hasActiveSelection
          ? paperWindowContext?.entriesInWindow ?? this.truthEntriesInWindow
          : null,
        realizedPnlUsd: hasActiveSelection
          ? paperWindowContext?.realizedPnlUsd ?? this.truthWindowRealizedPnlUsd
          : null,
        resolutionSource: hasActiveSelection ? this.truthResolutionSource : null,
        lifecycleStatus: effectiveLifecycleStatus
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

  private markReadPathWarning(state: string | null | undefined): void {
    const normalized = String(state || "").trim().toUpperCase();
    if (!normalized) return;
    this.tickWarningState = normalized;
    this.runtimeWarningState = normalized;
  }

  private combineWarningStates(
    primary: string | null | undefined,
    secondary: string | null | undefined
  ): string | null {
    const first = String(primary || "").trim().toUpperCase();
    const second = String(secondary || "").trim().toUpperCase();
    if (first && second) {
      return first === second ? first : `${first}+${second}`;
    }
    return first || second || null;
  }

  private getSelectionFreshnessWarning(
    nowTs: number,
    lastUpdateTs: number,
    hasActiveSelection: boolean
  ): "DISCOVERY_STALE" | null {
    void hasActiveSelection;
    if (
      !(lastUpdateTs > 0) ||
      nowTs - lastUpdateTs <= Math.max(1_000, Math.floor(this.config.polymarket.live.discoveryStaleMs))
    ) {
      return null;
    }
    return "DISCOVERY_STALE";
  }

  private transitionRuntimeStartupState(
    nextState: RuntimeStartupState,
    reason: string,
    nowTs: number,
    extra: Record<string, unknown> = {}
  ): void {
    const normalizedReason = String(reason || "").trim() || "UNKNOWN";
    if (this.runtimeStartupState === nextState && this.runtimeStartupStateReason === normalizedReason) {
      return;
    }
    this.logger.info(
      {
        from: this.runtimeStartupState,
        to: nextState,
        reason: normalizedReason,
        now: new Date(nowTs).toISOString(),
        ...extra
      },
      "POLY_RUNTIME_STATE_TRANSITION"
    );
    this.runtimeStartupState = nextState;
    this.runtimeStartupStateReason = normalizedReason;
    if (nextState !== "STARTING") {
      this.polyEngineRunning = true;
    }
  }

  private maybeLogDeterministicDiscoveryDegraded(input: {
    warningSource: string;
    error: unknown;
    details?: Record<string, unknown>;
  }): void {
    if (!this.debugPoly) {
      return;
    }
    const nowTs = Date.now();
    const errorSignature = this.normalizeTransientErrorSignature(input.error);
    const signature = JSON.stringify({
      warningSource: input.warningSource,
      error: errorSignature
    });
    if (
      signature === this.lastDiscoveryDegradedSignature &&
      nowTs - this.lastDiscoveryDegradedLogTs < 15_000
    ) {
      return;
    }
    this.lastDiscoveryDegradedSignature = signature;
    this.lastDiscoveryDegradedLogTs = nowTs;
    this.logger.warn(
      {
        warningSource: input.warningSource,
        error: this.shortErrorText(input.error),
        ...(input.details ?? {})
      },
      "POLY_BTC5M_DISCOVERY_DEGRADED"
    );
  }

  private maybeLogSelectorDiagnostic(
    level: "info" | "warn",
    event: "POLY_BTC5M_SELECTED" | "POLY_BTC5M_NOT_FOUND",
    payload: Record<string, unknown>
  ): void {
    if (!this.debugPoly) {
      return;
    }
    const signature = JSON.stringify({
      event,
      currentBucketStartSec: payload.currentBucketStartSec ?? null,
      selectedSlug: payload.selectedSlug ?? payload.slug ?? null,
      selectedBucketStartSec: payload.selectedBucketStartSec ?? null,
      selectedReason: payload.selectedReason ?? null,
      dominantReject: payload.dominantReject ?? null,
      triedSlugs: Array.isArray(payload.triedSlugs) ? payload.triedSlugs : []
    });
    if (signature === this.lastSelectorDiagnosticSignature) {
      return;
    }
    this.lastSelectorDiagnosticSignature = signature;
    if (level === "warn") {
      this.logger.warn(payload, event);
      return;
    }
    this.logger.info(payload, event);
  }

  private emitSelectionCommitLine(selection: {
    selectedSlug: string | null;
    selectedTokenId: string | null;
    selectionSource: string | null;
    remainingSec: number | null;
    chosenSide: "YES" | "NO" | null;
    chosenDirection: string | null;
  }): void {
    this.logger.info(
      `POLY_SELECTION_COMMITTED selectedSlug=${String(selection.selectedSlug || "-")} tokenId=${String(
        selection.selectedTokenId || "-"
      )} source=${String(selection.selectionSource || "-")} remainingSec=${
        Number.isFinite(Number(selection.remainingSec)) ? Math.max(0, Math.floor(Number(selection.remainingSec))) : "-"
      } chosenSide=${String(selection.chosenSide || "-")} chosenDirection=${String(selection.chosenDirection || "-")}`
    );
  }

  private emitSelectionBugLine(input: {
    currentBucketSlug: string | null;
    nextBucketSlug: string | null;
    fetchedCount: number;
    afterWindowCount: number;
    finalCandidatesCount: number;
    selectedSlug: string | null;
    selectedTokenId: string | null;
    liveValidationReason: string | null;
    attemptedSlugs: string[];
  }): void {
    const signature = JSON.stringify({
      currentBucketSlug: input.currentBucketSlug,
      nextBucketSlug: input.nextBucketSlug,
      fetchedCount: input.fetchedCount,
      afterWindowCount: input.afterWindowCount,
      finalCandidatesCount: input.finalCandidatesCount,
      selectedSlug: input.selectedSlug,
      selectedTokenId: input.selectedTokenId,
      liveValidationReason: input.liveValidationReason,
      attemptedSlugs: input.attemptedSlugs
    });
    if (signature === this.lastSelectionBugSignature) {
      return;
    }
    this.lastSelectionBugSignature = signature;
    this.logger.warn(
      `POLY_SELECTION_BUG currentBucketSlug=${String(input.currentBucketSlug || "-")} nextBucketSlug=${String(
        input.nextBucketSlug || "-"
      )} fetchedCount=${Math.max(0, Math.floor(Number(input.fetchedCount || 0)))} afterWindowCount=${Math.max(
        0,
        Math.floor(Number(input.afterWindowCount || 0))
      )} finalCandidatesCount=${Math.max(0, Math.floor(Number(input.finalCandidatesCount || 0)))} selectedSlug=${String(
        input.selectedSlug || "-"
      )} selectedTokenId=${String(input.selectedTokenId || "-")} liveValidationReason=${String(
        input.liveValidationReason || "-"
      )} candidateSlugs=${input.attemptedSlugs.length > 0 ? input.attemptedSlugs.join(",") : "-"}`
    );
  }

  private emitSelectionCommitRecoveryLine(input: {
    currentBucketSlug: string | null;
    validatedSlug: string | null;
    tokenId: string | null;
    chosenSide: "YES" | "NO" | null;
    chosenDirection: string | null;
    liveValidationReason: string | null;
  }): void {
    const signature = JSON.stringify({
      currentBucketSlug: input.currentBucketSlug,
      validatedSlug: input.validatedSlug,
      tokenId: input.tokenId,
      chosenSide: input.chosenSide,
      chosenDirection: input.chosenDirection,
      liveValidationReason: input.liveValidationReason
    });
    if (signature === this.lastSelectionCommitRecoverySignature) {
      return;
    }
    this.lastSelectionCommitRecoverySignature = signature;
    this.logger.warn(
      `POLY_SELECTION_COMMIT_RECOVERY currentBucketSlug=${String(input.currentBucketSlug || "-")} validatedSlug=${String(
        input.validatedSlug || "-"
      )} tokenId=${String(input.tokenId || "-")} chosenSide=${String(input.chosenSide || "-")} chosenDirection=${String(
        input.chosenDirection || "-"
      )} liveValidationReason=${String(input.liveValidationReason || "-")}`
    );
  }

  private pickDeterministicBtc5mSlug(...values: Array<string | null | undefined>): string | null {
    for (const value of values) {
      const text = String(value || "").trim();
      if (!text) continue;
      if (parseBtc5mWindowStartSec(text) !== null) {
        return text;
      }
    }
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) return text;
    }
    return null;
  }

  private getMarketDeterministicSlug(
    market:
      | {
          slug?: string | null;
          eventSlug?: string | null;
          marketId?: string | null;
        }
      | null
      | undefined
  ): string | null {
    if (!market) return null;
    return this.pickDeterministicBtc5mSlug(market.slug, market.eventSlug, market.marketId || null);
  }

  private classifyDeterministicWindowFromSlugOrStart(
    slug: string | null,
    startSec: number | null,
    currentBucket: Btc5mWallClockBucket = this.getFreshBtc5mWallClockBucket()
  ): "current" | "next" | "previous" | "other" {
    const slugText = String(slug || "").trim();
    if (slugText) {
      if (slugText === currentBucket.currentSlug) return "current";
      if (slugText === currentBucket.nextSlug) return "next";
      if (slugText === currentBucket.prevSlug) return "previous";
    }
    if (startSec !== null) {
      if (startSec === currentBucket.currentBucketStartSec) return "current";
      if (startSec === currentBucket.currentBucketStartSec + FIVE_MIN_SEC) return "next";
      if (startSec === currentBucket.currentBucketStartSec - FIVE_MIN_SEC) return "previous";
    }
    return "other";
  }

  private getCanonicalBtc5mTimingFromSlugOrRow(input: {
    slug: string | null;
    rowStartTs: number | null | undefined;
    rowEndTs: number | null | undefined;
  }): {
    startSec: number | null;
    startTs: number | null;
    endTs: number | null;
    source: "slug" | "row" | "none";
  } {
    const slugStartSec =
      this.isDeterministicBtc5mMode() ? parseBtc5mWindowStartSec(input.slug) : null;
    if (slugStartSec !== null) {
      return {
        startSec: slugStartSec,
        startTs: slugStartSec * 1000,
        endTs: (slugStartSec + FIVE_MIN_SEC) * 1000,
        source: "slug"
      };
    }
    const startTs = toMs(input.rowStartTs);
    const endTs = toMs(input.rowEndTs);
    if (endTs > 0) {
      return {
        startSec: startTs > 0 ? Math.floor(startTs / 1000) : null,
        startTs: startTs > 0 ? startTs : null,
        endTs,
        source: "row"
      };
    }
    return {
      startSec: null,
      startTs: startTs > 0 ? startTs : null,
      endTs: null,
      source: "none"
    };
  }

  private inferSelectionSourceFromStartSec(
    startSec: number | null,
    currentBucket: Btc5mWallClockBucket = this.getFreshBtc5mWallClockBucket()
  ): "current_slug" | "next_slug" | "fallback_discovery" {
    if (startSec !== null) {
      if (startSec === currentBucket.currentBucketStartSec) {
        return "current_slug";
      }
      if (startSec === currentBucket.currentBucketStartSec + FIVE_MIN_SEC) {
        return "next_slug";
      }
    }
    return "fallback_discovery";
  }

  private recoverLiveSelectionFromValidatedMarket(params: {
    nowTs: number;
    tickContext?: Btc5mTickContext;
    market: BtcWindowMarket;
    selectedTokenId: string | null;
    chosenSide: "YES" | "NO" | null;
    chosenDirection: string | null;
    selectionSource: SelectionSource | null;
    liveValidationReason: string | null;
    logRecovery: boolean;
  }): (LiveCommittedSelection & { remainingSec: number }) | null {
    if (this.config.polymarket.mode !== "live") {
      return null;
    }
    const slug = this.getMarketDeterministicSlug(params.market);
    const currentBucket = params.tickContext?.bucket ?? this.getFreshBtc5mWallClockBucket(params.nowTs);
    const timing = this.getCanonicalBtc5mTimingFromSlugOrRow({
      slug,
      rowStartTs: params.market.startTs ?? null,
      rowEndTs: params.market.endTs ?? null
    });
    if (timing.endTs !== null && timing.endTs <= params.nowTs) {
      return null;
    }
    const chosenSide = params.chosenSide ?? "YES";
    const chosenDirection =
      params.chosenDirection ??
      normalizeDirectionalDisplayLabel(params.market.yesDisplayLabel, params.market.question, chosenSide);
    const selectionSource =
      params.selectionSource && params.selectionSource !== "committed"
        ? params.selectionSource
        : this.inferSelectionSourceFromStartSec(timing.startSec, currentBucket);
    const bucketClass = this.classifyDeterministicWindowFromSlugOrStart(slug, timing.startSec, currentBucket);
    const discoveredCurrent = selectionSource === "current_slug" || bucketClass === "current";
    const discoveredNext = selectionSource === "next_slug" || bucketClass === "next";
    const liveValidationReason =
      params.liveValidationReason ??
      (bucketClass === "current" ? "tradable_current_slug" : "preorder_validated");
    this.commitLiveSelectedMarket(params.market, params.nowTs, {
      windowStartTs: timing.startTs ?? params.market.startTs ?? null,
      windowEndTs: timing.endTs ?? params.market.endTs ?? null,
      chosenSide,
      chosenDirection,
      selectedTokenId: params.selectedTokenId,
      selectedBookable: Boolean(params.selectedTokenId),
      selectedTradable: Boolean(params.selectedTokenId),
      candidateRefreshed: true,
      discoveredCurrent,
      discoveredNext,
      selectionSource,
      selectedFrom: selectionSource,
      selectionCommitTs: params.nowTs,
      liveValidationReason,
      currentBucketSlug: currentBucket.currentSlug,
      nextBucketSlug: currentBucket.nextSlug,
      currentBucketStartSec: currentBucket.currentBucketStartSec
    });
    this.updateLiveCommittedSelectionDecision(params.market, params.nowTs, chosenSide, chosenDirection);
    if (this.liveCommittedSelection) {
      this.liveCommittedSelection = {
        ...this.liveCommittedSelection,
        selectedTokenId: params.selectedTokenId,
        selectedBookable: Boolean(params.selectedTokenId),
        selectedTradable: Boolean(params.selectedTokenId),
        candidateRefreshed: true,
        discoveredCurrent,
        discoveredNext,
        selectionSource,
        selectedFrom: selectionSource,
        selectionCommitTs: params.nowTs,
        liveValidationReason,
        currentBucketSlug: currentBucket.currentSlug,
        nextBucketSlug: currentBucket.nextSlug,
        currentBucketStartSec: currentBucket.currentBucketStartSec,
        holdReason: null,
        executionBlockedReason: null,
        executionBlockedSide: null
      };
      this.syncPersistedLiveSelectionState(params.nowTs);
    }
    const recovered = this.getActiveLiveCommittedSelection(params.nowTs);
    if (recovered) {
      this.persistedPolymarketSnapshot = {
        ...this.persistedPolymarketSnapshot,
        selectedSlug: recovered.selectedSlug,
        selectedMarketId: recovered.selectedMarketId,
        selectedTokenId: params.selectedTokenId,
        selectedBookable: Boolean(params.selectedTokenId),
        selectedTradable: Boolean(params.selectedTokenId),
        discoveredCurrent,
        discoveredNext,
        remainingSec: recovered.remainingSec,
        chosenSide: recovered.chosenSide,
        chosenDirection: recovered.chosenDirection,
        selectionSource,
        selectedFrom: selectionSource,
        selectionCommitTs: params.nowTs,
        liveValidationReason,
        currentBucketSlug: currentBucket.currentSlug,
        nextBucketSlug: currentBucket.nextSlug,
        currentBucketStartSec: currentBucket.currentBucketStartSec
      };
      if (params.logRecovery) {
        this.emitSelectionCommitRecoveryLine({
          currentBucketSlug: currentBucket.currentSlug,
          validatedSlug: recovered.selectedSlug,
          tokenId: params.selectedTokenId,
          chosenSide: recovered.chosenSide,
          chosenDirection: recovered.chosenDirection,
          liveValidationReason
        });
      }
    }
    return recovered;
  }

  private getCachedUsableLiveSelection(nowTs: number): {
    selectedSlug: string | null;
    remainingSec: number | null;
  } | null {
    if (this.config.polymarket.mode !== "live") return null;
    const committedSelection = this.getActiveLiveCommittedSelection(nowTs);
    if (committedSelection) {
      return {
        selectedSlug: committedSelection.selectedSlug,
        remainingSec: committedSelection.remainingSec
      };
    }
    if (!this.lastUsableLiveSelectedMarket) return null;
    if (!looksLikeBtc5mMarket(this.lastUsableLiveSelectedMarket)) return null;
    const currentBucket = this.getFreshBtc5mWallClockBucket(nowTs);
    const cachedStartSec =
      parseBtc5mWindowStartSec(this.getMarketDeterministicSlug(this.lastUsableLiveSelectedMarket)) ??
      (Number.isFinite(Number(this.lastUsableLiveSelectedMarket.startTs)) &&
      Number(this.lastUsableLiveSelectedMarket.startTs) > 0
        ? Math.floor(Number(this.lastUsableLiveSelectedMarket.startTs) / 1000)
        : null);
    if (cachedStartSec === null || cachedStartSec !== currentBucket.bucketStartSec) {
      this.lastUsableLiveSelectedMarket = null;
      return null;
    }
    const activeStartSec = currentBucket.bucketStartSec;
    if (!isDeterministicBtc5mMarketUsableNow(this.lastUsableLiveSelectedMarket, activeStartSec, nowTs)) {
      this.lastUsableLiveSelectedMarket = null;
      return null;
    }
    const selectedSlug =
      this.getMarketDeterministicSlug(this.lastUsableLiveSelectedMarket);
    const remainingSec =
      Number.isFinite(Number(this.lastUsableLiveSelectedMarket.endTs)) &&
      Number(this.lastUsableLiveSelectedMarket.endTs) > nowTs
        ? Math.max(0, Math.floor((Number(this.lastUsableLiveSelectedMarket.endTs) - nowTs) / 1000))
        : null;
    return selectedSlug || remainingSec !== null ? { selectedSlug, remainingSec } : null;
  }

  private buildLiveCommittedSelection(
    market: BtcWindowMarket,
    nowTs: number,
    overrides: Partial<LiveCommittedSelection> = {}
  ): (LiveCommittedSelection & { remainingSec: number }) | null {
    const selectedSlug = overrides.selectedSlug ?? this.getMarketDeterministicSlug(market);
    const selectedMarketId = overrides.selectedMarketId ?? market.marketId ?? null;
    const canonicalTiming = this.getCanonicalBtc5mTimingFromSlugOrRow({
      slug: selectedSlug,
      rowStartTs: overrides.windowStartTs ?? market.startTs ?? null,
      rowEndTs: overrides.windowEndTs ?? market.endTs ?? null
    });
    const snapshot = this.getActiveSelectionSnapshot(
      {
        finalCandidatesCount: this.truthSelection.finalCandidatesCount,
        selectedSlug,
        selectedMarketId,
        windowStartTs: canonicalTiming.startTs ?? overrides.windowStartTs ?? market.startTs ?? null,
        windowEndTs: canonicalTiming.endTs ?? overrides.windowEndTs ?? market.endTs ?? null,
        remainingSec: null
      },
      nowTs
    );
    if (!snapshot.selectedSlug && !snapshot.selectedMarketId) {
      return null;
    }
    const chosenDirection =
      overrides.chosenDirection ??
      normalizeDirectionalDisplayLabel(market.yesDisplayLabel, market.question, "YES");
    return {
      selectedSlug: snapshot.selectedSlug,
      selectedMarketId: snapshot.selectedMarketId,
      selectedEpoch:
        snapshot.windowStartTs !== null ? Math.floor(snapshot.windowStartTs / 1000) : parseBtc5mWindowStartSec(snapshot.selectedSlug),
      windowStartTs: snapshot.windowStartTs,
      windowEndTs: snapshot.windowEndTs,
      selectedWindowStartSec:
        snapshot.windowStartTs !== null
          ? Math.floor(snapshot.windowStartTs / 1000)
          : parseBtc5mWindowStartSec(snapshot.selectedSlug),
      selectedWindowEndSec:
        snapshot.windowEndTs !== null ? Math.floor(snapshot.windowEndTs / 1000) : null,
      candidateRefreshed:
        overrides.candidateRefreshed !== undefined ? Boolean(overrides.candidateRefreshed) : null,
      remainingSec: snapshot.remainingSec ?? 0,
      chosenDirection,
      chosenSide: overrides.chosenSide ?? null,
      yesTokenId: overrides.yesTokenId ?? market.yesTokenId ?? null,
      noTokenId: overrides.noTokenId ?? market.noTokenId ?? null,
      selectedTokenId:
        overrides.selectedTokenId ??
        ((overrides.chosenSide ?? null) === "NO"
          ? overrides.noTokenId ?? market.noTokenId ?? null
          : overrides.yesTokenId ?? market.yesTokenId ?? null),
      selectedBookable: Boolean(overrides.selectedBookable ?? false),
      selectedTradable: Boolean(overrides.selectedTradable ?? false),
      discoveredCurrent: Boolean(overrides.discoveredCurrent ?? false),
      discoveredNext: Boolean(overrides.discoveredNext ?? false),
      selectionSource: overrides.selectionSource ?? "committed",
      selectedFrom: overrides.selectedFrom ?? overrides.selectionSource ?? "committed",
      selectionCommitTs:
        Number.isFinite(Number(overrides.selectionCommitTs)) && Number(overrides.selectionCommitTs) > 0
          ? Number(overrides.selectionCommitTs)
          : null,
      liveValidationReason: overrides.liveValidationReason ?? null,
      lastBookTs: overrides.lastBookTs ?? null,
      lastQuoteTs: overrides.lastQuoteTs ?? null,
      currentBucketSlug: overrides.currentBucketSlug ?? null,
      nextBucketSlug: overrides.nextBucketSlug ?? null,
      currentBucketStartSec: overrides.currentBucketStartSec ?? null,
      acceptingOrders: overrides.acceptingOrders ?? market.acceptingOrders ?? null,
      enableOrderBook: overrides.enableOrderBook ?? market.enableOrderBook ?? null,
      selectedReason: overrides.selectedReason ?? null,
      holdReason: overrides.holdReason ?? null,
      warningState: overrides.warningState ?? null,
      executionBlockedReason: overrides.executionBlockedReason ?? null,
      executionBlockedSide: overrides.executionBlockedSide ?? null
    };
  }

  private getFreshBtc5mWallClockBucket(nowTs = Date.now()): Btc5mWallClockBucket {
    const derived = deriveBtc5mBuckets(nowTs);
    return {
      nowSec: derived.nowSec,
      bucketStartSec: derived.bucketStartSec,
      currentBucketStartSec: derived.bucketStartSec,
      expectedSlug: derived.currentSlug,
      currentSlug: derived.currentSlug,
      prevSlug: derived.prevSlug,
      nextSlug: derived.nextSlug,
      windowStartTs: derived.windowStartTs,
      windowEndTs: derived.windowEndTs,
      remainingSec: derived.remainingSec
    };
  }

  private createBtc5mTickContext(tickNowMs = Date.now()): Btc5mTickContext {
    const bucket = this.getFreshBtc5mWallClockBucket(tickNowMs);
    return {
      tickNowMs,
      tickNowSec: bucket.nowSec,
      currentBucketStartSec: bucket.currentBucketStartSec,
      prevBucketStartSec: bucket.currentBucketStartSec - FIVE_MIN_SEC,
      nextBucketStartSec: bucket.currentBucketStartSec + FIVE_MIN_SEC,
      currentBucketSlug: bucket.currentSlug,
      prevBucketSlug: bucket.prevSlug,
      nextBucketSlug: bucket.nextSlug,
      remainingSec: bucket.remainingSec,
      bucket
    };
  }

  private checkTickBucketContextMismatch(input: {
    tickContext: Btc5mTickContext;
    observedCurrentBucketSlug: string | null | undefined;
    observedNextBucketSlug: string | null | undefined;
    phase: string;
    selectionCommitTs?: number | null;
    selectedSlug?: string | null;
    remainingSec?: number | null;
  }): boolean {
    const observedCurrentBucketSlug = String(input.observedCurrentBucketSlug || "").trim() || null;
    const observedNextBucketSlug = String(input.observedNextBucketSlug || "").trim() || null;
    const expectedCurrentSlug = slugForTs(input.tickContext.currentBucketStartSec);
    if (
      observedCurrentBucketSlug === null ||
      observedCurrentBucketSlug === input.tickContext.currentBucketSlug ||
      observedCurrentBucketSlug === expectedCurrentSlug
    ) {
      return false;
    }
    this.logger.error(
      {
        phase: input.phase,
        tickNowSec: input.tickContext.tickNowSec,
        currentBucketStartSec: input.tickContext.currentBucketStartSec,
        expectedCurrentBucketSlug: input.tickContext.currentBucketSlug,
        observedCurrentBucketSlug,
        observedNextBucketSlug,
        expectedNextBucketSlug: input.tickContext.nextBucketSlug,
        selectionCommitTs: input.selectionCommitTs ?? null,
        selectedSlug: input.selectedSlug ?? null,
        remainingSec: input.remainingSec ?? input.tickContext.remainingSec
      },
      "POLY_BUCKET_CONTEXT_MISMATCH"
    );
    return true;
  }

  private getExpectedCurrentBtc5mBucket(nowTs = Date.now()): {
    nowSec: number;
    bucketStartSec: number;
    currentBucketStartSec: number;
    slug: string;
    currentSlug: string;
    prevSlug: string;
    nextSlug: string;
    windowStartTs: number;
    windowEndTs: number;
    remainingSec: number;
  } {
    const currentBucket = this.getFreshBtc5mWallClockBucket(nowTs);
    return {
      nowSec: currentBucket.nowSec,
      bucketStartSec: currentBucket.bucketStartSec,
      currentBucketStartSec: currentBucket.currentBucketStartSec,
      slug: currentBucket.expectedSlug,
      currentSlug: currentBucket.currentSlug,
      prevSlug: currentBucket.prevSlug,
      nextSlug: currentBucket.nextSlug,
      windowStartTs: currentBucket.windowStartTs,
      windowEndTs: currentBucket.windowEndTs,
      remainingSec: currentBucket.remainingSec
    };
  }

  private getCurrentBtc5mEpochStartSec(nowTs = Date.now()): number {
    return deriveBtc5mBuckets(nowTs).bucketStartSec;
  }

  private getLiveEntryMinRemainingSec(): number {
    if (this.config.polymarket.mode !== "live") {
      return Math.max(1, this.config.polymarket.paper.entryMinRemainingSec);
    }
    return Math.max(1, this.config.polymarket.live.minEntryRemainingSec);
  }

  private getLiveEntryMaxRemainingSec(): number {
    return Math.max(
      this.getLiveEntryMinRemainingSec(),
      this.config.polymarket.paper.entryMaxRemainingSec
    );
  }

  private evaluateDeterministicCandidateEligibility(
    market: BtcWindowMarket,
    nowTs: number
  ): { ok: boolean; reason: string } {
    if (market.active === false) return { ok: false, reason: "DIRECT_SLUG_FAILURE" };
    if (market.closed === true || market.archived === true) return { ok: false, reason: "DIRECT_SLUG_FAILURE" };
    if (market.enableOrderBook === false || market.acceptingOrders === false) {
      return { ok: false, reason: "DIRECT_SLUG_FAILURE" };
    }
    const windowEndTs = toMs(market.endTs);
    if (!(windowEndTs > nowTs)) {
      return { ok: false, reason: "EXPIRED_WINDOW" };
    }
    const remainingSec = Math.max(0, Math.floor((windowEndTs - nowTs) / 1000));
    if (remainingSec < this.getLiveEntryMinRemainingSec() || remainingSec > this.getLiveEntryMaxRemainingSec()) {
      return { ok: false, reason: remainingSec <= 0 ? "EXPIRED_WINDOW" : "DIRECT_SLUG_FAILURE" };
    }
    return { ok: true, reason: "OK" };
  }

  private maybeInvalidateLiveSelectionNearRollover(nowTs: number): void {
    if (this.config.polymarket.mode !== "live" || !this.isDeterministicBtc5mMode()) {
      return;
    }
    const activeSelection = this.getActiveLiveCommittedSelection(nowTs);
    if (!activeSelection) {
      return;
    }
    if (activeSelection.remainingSec > this.getLiveEntryMinRemainingSec()) {
      return;
    }
    const reason = activeSelection.remainingSec <= 0 ? "EXPIRED_WINDOW" : "LOW_REMAINING_ROLLOVER";
    this.clearLiveCommittedSelection(nowTs, reason);
  }

  private async fetchDeterministicLiveCandidateRows(nowTs: number): Promise<Record<string, unknown>[]> {
    const currentBucket = this.getFreshBtc5mWallClockBucket(nowTs);
    const slugs = this.getDeterministicBtc5mSlugCandidates(currentBucket);
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const addRow = (row: Record<string, unknown> | null | undefined): void => {
      if (!row || typeof row !== "object") return;
      const marketId = pickRawString(row, ["id", "market_id", "conditionId", "condition_id"]);
      const slug = pickRawString(row, ["slug", "market_slug", "eventSlug", "event_slug"]);
      const key = `${marketId}::${slug}`.trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(row);
    };
    const directLookup = await this.directSlugResolver.lookupBySlugs(slugs);
    if (directLookup.hadNetworkError) {
      this.markReadPathWarning("NETWORK_ERROR");
    }
    for (const candidate of directLookup.rows) {
      addRow(candidate.row);
    }

    // Only fall back to broad scan when direct slug lookup had no usable data.
    const shouldFallbackScan = !directLookup.hadData;
    if (!shouldFallbackScan) {
      return out;
    }
    try {
      const page = await this.client.listMarketsPage({
        limit: 200,
        active: true,
        closed: false,
        archived: false
      });
      for (const row of page.rows as Record<string, unknown>[]) {
        addRow(row);
      }
    } catch (error) {
      this.markReadPathWarning("NETWORK_ERROR");
      this.maybeLogDeterministicDiscoveryDegraded({
        warningSource: "preorder_active_scan",
        error
      });
    }
    return out;
  }

  private async validateLiveTokenBookable(
    tokenId: string,
    marketSlug: string | null
  ): Promise<{ ok: boolean; reason: string | null; lastBookTs: number | null; lastQuoteTs: number | null }> {
    try {
      const quote = await this.client.getTokenPriceQuote(tokenId, { slug: marketSlug });

      const hasBid = Number.isFinite(Number(quote.bestBid)) && Number(quote.bestBid) > 0;
      const hasAsk = Number.isFinite(Number(quote.bestAsk)) && Number(quote.bestAsk) > 0;

      if (hasBid || hasAsk) {
        return {
          ok: true,
          reason: null,
          lastBookTs: quote.source === "book_mid" ? toMs(quote.ts) : null,
          lastQuoteTs: toMs(quote.ts)
        };
      }

      try {
        const book = await this.client.getTokenOrderBook(tokenId);
        const hasBook =
          (Number.isFinite(Number(book.bestBid)) && Number(book.bestBid) > 0) ||
          (Number.isFinite(Number(book.bestAsk)) && Number(book.bestAsk) > 0);
        if (hasBook) {
          return {
            ok: true,
            reason: null,
            lastBookTs: toMs(book.ts),
            lastQuoteTs: toMs(quote.ts)
          };
        }
      } catch (bookError) {
        if (isMissingOrderbookError(bookError)) {
          this.markReadPathWarning("MISSING_ORDERBOOK_FOR_SELECTED_TOKEN");
          return {
            ok: false,
            reason: "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN",
            lastBookTs: null,
            lastQuoteTs: null
          };
        }
      }

      return { ok: false, reason: "empty_live_quote", lastBookTs: null, lastQuoteTs: toMs(quote.ts) };
    } catch (error) {
      if (isMissingOrderbookError(error)) {
        this.markReadPathWarning("MISSING_ORDERBOOK_FOR_SELECTED_TOKEN");
        return {
          ok: false,
          reason: "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN",
          lastBookTs: null,
          lastQuoteTs: null
        };
      }

      if (isTransientPolymarketError(error)) {
        this.markReadPathWarning("NETWORK_ERROR");
        return {
          ok: false,
          reason: "transient_quote_failure",
          lastBookTs: null,
          lastQuoteTs: null
        };
      }

      return { ok: false, reason: "quote_failure", lastBookTs: null, lastQuoteTs: null };
    }
  }

  private async validateLiveMarketTradability(params: {
    market: BtcWindowMarket;
    chosenSide: "YES" | "NO";
    nowTs: number;
    selectionSource: Btc5mSelectionSource;
  }): Promise<LiveMarketTradabilityValidation> {
    const slug = this.getMarketDeterministicSlug(params.market);
    const currentBucket = this.getFreshBtc5mWallClockBucket(params.nowTs);
    const nowSec = Math.floor(params.nowTs / 1000);
    if (params.market.enableOrderBook === false || params.market.acceptingOrders === false) {
      return {
        tradable: false,
        tokenId: null,
        bookable: false,
        bestBid: null,
        bestAsk: null,
        mid: null,
        lastBookTs: null,
        lastQuoteTs: null,
        reason: "SIDE_NOT_BOOKABLE"
      };
    }
    if (params.market.active === false || params.market.closed === true || params.market.archived === true) {
      return {
        tradable: false,
        tokenId: null,
        bookable: false,
        bestBid: null,
        bestAsk: null,
        mid: null,
        lastBookTs: null,
        lastQuoteTs: null,
        reason: "market_not_active"
      };
    }
    const canonicalTiming = this.getCanonicalBtc5mTimingFromSlugOrRow({
      slug,
      rowStartTs: params.market.startTs ?? null,
      rowEndTs: params.market.endTs ?? null
    });
    const startSec = canonicalTiming.startSec;
    const endTs = canonicalTiming.endTs;
    const remainingSec =
      endTs !== null ? Math.max(0, Math.floor((endTs - params.nowTs) / 1000)) : null;
    const windowClass = this.classifyDeterministicWindowFromSlugOrStart(slug, startSec, currentBucket);
    const isCurrentOrNext = windowClass === "current" || windowClass === "next";
    if (!isCurrentOrNext) {
      return {
        tradable: false,
        tokenId: null,
        bookable: false,
        bestBid: null,
        bestAsk: null,
        mid: null,
        lastBookTs: null,
        lastQuoteTs: null,
        reason: "NON_CURRENT_OR_NEXT_WINDOW"
      };
    }
    if (
      !Number.isFinite(Number(startSec)) ||
      !Number.isFinite(Number(endTs)) ||
      startSec === null ||
      endTs === null ||
      (nowSec < startSec && windowClass !== "next") ||
      params.nowTs >= endTs
    ) {
      return {
        tradable: false,
        tokenId: null,
        bookable: false,
        bestBid: null,
        bestAsk: null,
        mid: null,
        lastBookTs: null,
        lastQuoteTs: null,
        reason: "expired_window"
      };
    }
    if (!Number.isFinite(Number(remainingSec)) || Number(remainingSec) <= this.getLiveEntryMinRemainingSec()) {
      return {
        tradable: false,
        tokenId: null,
        bookable: false,
        bestBid: null,
        bestAsk: null,
        mid: null,
        lastBookTs: null,
        lastQuoteTs: null,
        reason: "remaining_below_threshold"
      };
    }
    const tokenId =
      params.chosenSide === "YES"
        ? String(params.market.yesTokenId || "").trim() || null
        : String(params.market.noTokenId || "").trim() || null;
    if (!tokenId) {
      return {
        tradable: false,
        tokenId: null,
        bookable: false,
        bestBid: null,
        bestAsk: null,
        mid: null,
        lastBookTs: null,
        lastQuoteTs: null,
        reason: "token_missing_for_side"
      };
    }

    const tryOrderBook = async (
      maybeQuoteTs: number | null
    ): Promise<LiveMarketTradabilityValidation> => {
      try {
        const book = await this.client.getTokenOrderBook(tokenId);
        const bookBestBid =
          Number.isFinite(Number(book.bestBid)) && Number(book.bestBid) > 0
            ? clamp(Number(book.bestBid), 0.0001, 0.9999)
            : null;
        const bookBestAsk =
          Number.isFinite(Number(book.bestAsk)) && Number(book.bestAsk) > 0
            ? clamp(Number(book.bestAsk), 0.0001, 0.9999)
            : null;
        if (bookBestBid !== null || bookBestAsk !== null) {
          return {
            tradable: true,
            tokenId,
            bookable: true,
            bestBid: bookBestBid,
            bestAsk: bookBestAsk,
            mid: bookBestBid !== null && bookBestAsk !== null ? (bookBestBid + bookBestAsk) / 2 : null,
            lastBookTs: toMs(book.ts),
            lastQuoteTs: maybeQuoteTs,
            reason: `tradable_book_${params.selectionSource}`
          };
        }
        return {
          tradable: false,
          tokenId,
          bookable: false,
          bestBid: null,
          bestAsk: null,
          mid: null,
          lastBookTs: toMs(book.ts),
          lastQuoteTs: maybeQuoteTs,
          reason: "empty_live_quote"
        };
      } catch (bookError) {
        if (isMissingOrderbookError(bookError)) {
          this.markReadPathWarning("MISSING_ORDERBOOK_FOR_SELECTED_TOKEN");
          return {
            tradable: false,
            tokenId,
            bookable: false,
            bestBid: null,
            bestAsk: null,
            mid: null,
            lastBookTs: null,
            lastQuoteTs: maybeQuoteTs,
            reason: "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN"
          };
        }
        if (isTransientPolymarketError(bookError)) {
          this.markReadPathWarning("NETWORK_ERROR");
          return {
            tradable: false,
            tokenId,
            bookable: false,
            bestBid: null,
            bestAsk: null,
            mid: null,
            lastBookTs: null,
            lastQuoteTs: maybeQuoteTs,
            reason: "transient_quote_failure"
          };
        }
        return {
          tradable: false,
          tokenId,
          bookable: false,
          bestBid: null,
          bestAsk: null,
          mid: null,
          lastBookTs: null,
          lastQuoteTs: maybeQuoteTs,
          reason: "quote_failure"
        };
      }
    };

    try {
      const quote = await this.client.getTokenPriceQuote(tokenId, { slug });
      const bestBid =
        Number.isFinite(Number(quote.bestBid)) && Number(quote.bestBid) > 0
          ? clamp(Number(quote.bestBid), 0.0001, 0.9999)
          : null;
      const bestAsk =
        Number.isFinite(Number(quote.bestAsk)) && Number(quote.bestAsk) > 0
          ? clamp(Number(quote.bestAsk), 0.0001, 0.9999)
          : null;
      const mid =
        Number.isFinite(Number(quote.mid)) && Number(quote.mid) > 0
          ? clamp(Number(quote.mid), 0.0001, 0.9999)
          : null;
      if (bestBid !== null || bestAsk !== null) {
        return {
          tradable: true,
          tokenId,
          bookable: true,
          bestBid,
          bestAsk,
          mid,
          lastBookTs: quote.source === "book_mid" ? toMs(quote.ts) : null,
          lastQuoteTs: toMs(quote.ts),
          reason: `tradable_${params.selectionSource}`
        };
      }
      return await tryOrderBook(toMs(quote.ts));
    } catch (error) {
      if (isMissingOrderbookError(error)) {
        this.markReadPathWarning("MISSING_ORDERBOOK_FOR_SELECTED_TOKEN");
        return {
          tradable: false,
          tokenId,
          bookable: false,
          bestBid: null,
          bestAsk: null,
          mid: null,
          lastBookTs: null,
          lastQuoteTs: null,
          reason: "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN"
        };
      }
      if (isTransientPolymarketError(error)) {
        this.markReadPathWarning("NETWORK_ERROR");
        const bookFallback = await tryOrderBook(null);
        if (bookFallback.tradable) {
          return {
            ...bookFallback,
            reason: `tradable_book_fallback_${params.selectionSource}`
          };
        }
        return bookFallback.reason === "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN"
          ? bookFallback
          : {
              ...bookFallback,
              reason: "transient_quote_failure"
            };
      }
      return {
        tradable: false,
        tokenId,
        bookable: false,
        bestBid: null,
        bestAsk: null,
        mid: null,
        lastBookTs: null,
        lastQuoteTs: null,
        reason: "quote_failure"
      };
    }
  }

  private getLiveMinVenueShares(): number {
    const configValue = Number(this.config.polymarket.sizing.minSharesRequired);
    if (Number.isFinite(configValue) && configValue > 0) {
      return Math.max(1, Math.floor(configValue));
    }
    const envValue = Number(process.env.POLYMARKET_MIN_SHARES_REQUIRED || process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES || 5);
    if (!Number.isFinite(envValue)) return 5;
    return Math.max(1, Math.floor(envValue));
  }

  private evaluateOrderSizingCheck(params: {
    selectedSlug: string | null;
    selectedTokenId: string | null;
    chosenSide: "YES" | "NO" | null;
    orderPrice: number | null;
    requestedBudget: number | null;
    computedShares: number | null;
  }): {
    orderPrice: number;
    requestedBudget: number;
    baseTargetNotional: number;
    cappedNotional: number;
    desiredShares: number;
    finalShares: number;
    desiredNotional: number;
    finalNotional: number;
    maxNotionalPerWindow: number;
    minOrderNotional: number;
    minVenueShares: number;
    sizingCapApplied: boolean;
    sizingRejectReason: "NONE" | "BELOW_MIN_NOTIONAL" | "BELOW_MIN_SHARES" | "OVER_CAP_ADJUSTED";
    sizeBumped: boolean;
    clampedToMin: boolean;
    passes: boolean;
  } {
    if (!params.chosenSide) {
      return {
        orderPrice: 0,
        requestedBudget: 0,
        baseTargetNotional: 0,
        cappedNotional: 0,
        desiredShares: 0,
        finalShares: 0,
        desiredNotional: 0,
        finalNotional: 0,
        maxNotionalPerWindow: Math.max(0, Number(this.config.polymarket.sizing.maxNotionalPerWindow || 0)),
        minOrderNotional: Math.max(0, Number(this.config.polymarket.sizing.minOrderNotional || 0)),
        minVenueShares: this.getLiveMinVenueShares(),
        sizingCapApplied: false,
        sizingRejectReason: "NONE",
        sizeBumped: false,
        clampedToMin: false,
        passes: false
      };
    }
    const orderPrice =
      Number.isFinite(Number(params.orderPrice)) && Number(params.orderPrice) > 0
        ? clamp(Number(params.orderPrice), 0.0001, 0.9999)
        : 0;
    const requestedBudget =
      Number.isFinite(Number(params.requestedBudget)) && Number(params.requestedBudget) > 0
        ? Number(params.requestedBudget)
        : 0;
    const baseShares =
      Number.isFinite(Number(params.computedShares)) && Number(params.computedShares) > 0
        ? Number(params.computedShares)
        : 0;
    const baseTargetNotionalFromShares = orderPrice > 0 && baseShares > 0 ? baseShares * orderPrice : 0;
    const baseTargetNotional = requestedBudget > 0 ? requestedBudget : baseTargetNotionalFromShares;
    const maxNotionalPerWindow = Math.max(0, Number(this.config.polymarket.sizing.maxNotionalPerWindow || 0));
    const cappedNotional = Math.max(0, Math.min(baseTargetNotional, maxNotionalPerWindow));
    const sizingCapApplied = baseTargetNotional > 0 && cappedNotional + 1e-9 < baseTargetNotional;
    const desiredShares =
      baseShares > 0
        ? baseShares
        : orderPrice > 0 && baseTargetNotional > 0
          ? baseTargetNotional / orderPrice
          : 0;
    const desiredNotional = baseTargetNotional;
    const minOrderNotional = Math.max(0, Number(this.config.polymarket.sizing.minOrderNotional || 0));
    const minVenueShares = this.config.polymarket.mode === "live" ? this.getLiveMinVenueShares() : 0;
    const finalShares = orderPrice > 0 && cappedNotional > 0 ? cappedNotional / orderPrice : 0;
    const finalNotional = cappedNotional;
    let sizingRejectReason: "NONE" | "BELOW_MIN_NOTIONAL" | "BELOW_MIN_SHARES" | "OVER_CAP_ADJUSTED" = "NONE";
    if (!(orderPrice > 0) || !(finalNotional > 0) || !(finalShares > 0)) {
      sizingRejectReason = "BELOW_MIN_NOTIONAL";
    } else if (finalNotional + 1e-9 < minOrderNotional) {
      sizingRejectReason = "BELOW_MIN_NOTIONAL";
    } else if (this.config.polymarket.mode === "live" && finalShares + 1e-9 < minVenueShares) {
      sizingRejectReason = "BELOW_MIN_SHARES";
    } else if (sizingCapApplied) {
      sizingRejectReason = "OVER_CAP_ADJUSTED";
    }
    const passes = sizingRejectReason === "NONE" || sizingRejectReason === "OVER_CAP_ADJUSTED";
    const sizeBumped = sizingRejectReason === "BELOW_MIN_SHARES";

    this.logger.info(
      `POLY_SIZING_CHECK selectedSlug=${String(params.selectedSlug || "-")} selectedTokenId=${String(
        params.selectedTokenId || "-"
      )} chosenSide=${String(params.chosenSide || "-")} orderPrice=${
        orderPrice > 0 ? orderPrice.toFixed(4) : "-"
      } requestedBudget=${requestedBudget.toFixed(4)} baseTargetNotional=${baseTargetNotional.toFixed(
        4
      )} cappedNotional=${cappedNotional.toFixed(4)} desiredShares=${desiredShares.toFixed(6)} minVenueShares=${String(
        minVenueShares || "-"
      )} finalShares=${finalShares.toFixed(6)} desiredNotional=${desiredNotional.toFixed(
        4
      )} finalNotional=${finalNotional.toFixed(4)} minOrderNotional=${minOrderNotional.toFixed(
        4
      )} maxNotionalPerWindow=${maxNotionalPerWindow.toFixed(4)} sizingCapApplied=${String(
        sizingCapApplied
      )} sizingRejectReason=${sizingRejectReason} passes=${String(passes)}`
    );

    return {
      orderPrice,
      requestedBudget,
      baseTargetNotional,
      cappedNotional,
      desiredShares,
      finalShares,
      desiredNotional,
      finalNotional,
      maxNotionalPerWindow,
      minOrderNotional,
      minVenueShares,
      sizingCapApplied,
      sizingRejectReason,
      sizeBumped,
      clampedToMin: false,
      passes
    };
  }

  private async validateLiveExecutionCandidate(params: {
    nowTs: number;
    tickContext: Btc5mTickContext;
    market: BtcWindowMarket;
    chosenSide: "YES" | "NO";
  }): Promise<LiveExecutionCandidateValidation> {
    const nowTs = params.nowTs;
    const nowSec = params.tickContext.tickNowSec;
    const currentEpochSec = params.tickContext.currentBucketStartSec;
    const expectedSlug = params.tickContext.currentBucketSlug;
    const selectedSlug =
      this.getMarketDeterministicSlug(params.market) || this.liveCommittedSelection?.selectedSlug || null;
    const pollMode = this.getPersistedPolymarketSnapshot(nowTs).pollMode;
    const minimumRemainingSec = this.getLiveEntryMinRemainingSec();

    let refreshedRow: Record<string, unknown> | null = null;
    if (selectedSlug) {
      try {
        const directLookup = await this.directSlugResolver.lookupBySlugs([selectedSlug]);
        if (directLookup.hadNetworkError) {
          this.markReadPathWarning("NETWORK_ERROR");
        }
        const match = directLookup.rows.find((candidate) =>
          rowMatchesBtc5mSlug(candidate.row, selectedSlug)
        );
        refreshedRow = match?.row || null;
      } catch (error) {
        this.markReadPathWarning("NETWORK_ERROR");
        this.maybeLogDeterministicDiscoveryDegraded({
          warningSource: "preorder_selected_slug",
          error,
          details: { selectedSlug }
        });
      }
    }
    const candidateRows = await this.fetchDeterministicLiveCandidateRows(nowTs);
    if (refreshedRow) {
      candidateRows.unshift(refreshedRow);
    }
    const parsedCandidates = candidateRows
      .map((row) => {
        const parsed = parseRawMarketToBtcWindow(
          row,
          nowTs,
          nowTs + FIVE_MIN_SEC * 1000,
          this.lastOracleSnapshot?.price ?? null
        );
        if (!parsed || !looksLikeBtc5mMarket(parsed)) return null;
        return this.applyWindowState(parsed, nowTs);
      })
      .filter((row): row is BtcWindowMarket => row !== null);
    const refreshedMarket =
      parsedCandidates.find((row) => {
        const rowSlug = this.getMarketDeterministicSlug(row);
        return (
          row.marketId === params.market.marketId ||
          (selectedSlug && rowSlug === selectedSlug)
        );
      }) || null;
    const validatedSlug = refreshedMarket?.eventSlug || refreshedMarket?.slug || selectedSlug;
    const canonicalTiming = this.getCanonicalBtc5mTimingFromSlugOrRow({
      slug: validatedSlug,
      rowStartTs: refreshedMarket?.startTs ?? null,
      rowEndTs: refreshedMarket?.endTs ?? null
    });
    const marketStartSec = canonicalTiming.startSec;
    const marketEndTs = canonicalTiming.endTs;
    const remainingSec =
      marketEndTs !== null ? Math.max(0, Math.floor((marketEndTs - nowTs) / 1000)) : null;
    const validWindow =
      marketStartSec !== null &&
      marketEndTs !== null &&
      nowSec >= marketStartSec &&
      nowTs < marketEndTs;
    const rowActive =
      refreshedRow !== null
        ? pickRawBoolean(refreshedRow, ["active", "is_active"], true)
        : refreshedMarket?.active !== false;
    const rowClosed =
      refreshedRow !== null
        ? pickRawBoolean(refreshedRow, ["closed", "is_closed", "resolved"], false)
        : refreshedMarket?.closed === true;
    const rowArchived =
      refreshedRow !== null
        ? pickRawBoolean(refreshedRow, ["archived", "is_archived"], false)
        : refreshedMarket?.archived === true;
    const rowEnableOrderBook =
      refreshedRow !== null
        ? pickRawBoolean(refreshedRow, ["enable_order_book", "enableOrderBook"], true)
        : refreshedMarket?.enableOrderBook !== false;
    const intendedWindowStartSec = marketStartSec;
    const freshestInWindow = parsedCandidates
      .filter((row) => {
        const rowTiming = this.getCanonicalBtc5mTimingFromSlugOrRow({
          slug: this.getMarketDeterministicSlug(row),
          rowStartTs: row.startTs ?? null,
          rowEndTs: row.endTs ?? null
        });
        const startSec = rowTiming.startSec;
        const endTs = rowTiming.endTs ?? 0;
        return (
          startSec !== null &&
          intendedWindowStartSec !== null &&
          startSec === intendedWindowStartSec &&
          endTs > nowTs &&
          row.active !== false &&
          row.closed !== true &&
          row.archived !== true
        );
      })
      .sort((a, b) => {
        const aRank = rankDeterministicBtc5mMarket(a, currentEpochSec, nowTs);
        const bRank = rankDeterministicBtc5mMarket(b, currentEpochSec, nowTs);
        if (aRank !== bRank) return aRank - bRank;
        return String(a.marketId).localeCompare(String(b.marketId));
      })[0];
    const freshestSlug = this.getMarketDeterministicSlug(freshestInWindow ?? null);
    const selectedTokenId =
      params.chosenSide === "YES"
        ? String(refreshedMarket?.yesTokenId || "").trim() || null
        : String(refreshedMarket?.noTokenId || "").trim() || null;
    const committedTokenId =
      params.chosenSide === "YES"
        ? String(this.liveCommittedSelection?.yesTokenId || params.market.yesTokenId || "").trim() || null
        : String(this.liveCommittedSelection?.noTokenId || params.market.noTokenId || "").trim() || null;

    const result: LiveExecutionCandidateValidation = {
      valid: false,
      reason: "ok",
      selectedSlug: validatedSlug,
      expectedSlug,
      marketId: refreshedMarket?.marketId ?? params.market.marketId ?? null,
      tokenId: selectedTokenId,
      marketStartTs: canonicalTiming.startTs ?? (marketStartSec !== null ? marketStartSec * 1000 : null),
      marketEndTs,
      remainingSec,
      pollMode,
      candidateRefreshed: refreshedMarket !== null,
      refreshedMarket,
      selectedTokenId
    };

    if (parsedCandidates.length <= 2) {
      this.markReadPathWarning("DISCOVERY_STALE");
    }
    if (!refreshedMarket) {
      result.reason = candidateRows.length > 0 ? "stale_market_selection" : "discovery_failed";
      return this.logLivePreorderValidation(result);
    }
    if (!rowActive) {
      result.reason = "market_not_active";
      return this.logLivePreorderValidation(result);
    }
    if (rowClosed) {
      result.reason = "market_closed";
      return this.logLivePreorderValidation(result);
    }
    if (rowArchived) {
      result.reason = "market_archived";
      return this.logLivePreorderValidation(result);
    }
    if (!rowEnableOrderBook) {
      result.reason = "token_not_bookable";
      return this.logLivePreorderValidation(result);
    }
    if (!validWindow) {
      result.reason =
        marketStartSec === null || marketEndTs === null ? "invalid_window" : "expired_window";
      return this.logLivePreorderValidation(result);
    }
    if (!Number.isFinite(Number(remainingSec)) || Number(remainingSec) <= minimumRemainingSec) {
      result.reason = "remaining_below_threshold";
      return this.logLivePreorderValidation(result);
    }
    if (
      intendedWindowStartSec !== null &&
      intendedWindowStartSec === currentEpochSec &&
      validatedSlug !== expectedSlug
    ) {
      result.reason = "stale_market_selection";
      return this.logLivePreorderValidation(result);
    }
    if (freshestSlug && validatedSlug && freshestSlug !== validatedSlug) {
      result.reason = "stale_market_selection";
      return this.logLivePreorderValidation(result);
    }
    if (!selectedTokenId) {
      result.reason = "token_mismatch";
      return this.logLivePreorderValidation(result);
    }
    if (
      committedTokenId &&
      selectedTokenId &&
      committedTokenId !== selectedTokenId
    ) {
      result.reason = "stale_token_ids";
      return this.logLivePreorderValidation(result);
    }
    if (
      selectedTokenId !== refreshedMarket.yesTokenId &&
      selectedTokenId !== refreshedMarket.noTokenId
    ) {
      result.reason = "token_mismatch";
      return this.logLivePreorderValidation(result);
    }

    if (selectedTokenId) {
      const bookability = await this.validateLiveTokenBookable(selectedTokenId, validatedSlug);

      if (!bookability.ok) {
        result.reason =
          String(bookability.reason || "").toUpperCase() === "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN"
            ? "token_not_bookable"
            : "token_not_bookable";
        this.persistedPolymarketSnapshot = {
          ...this.persistedPolymarketSnapshot,
          selectedTokenId,
          selectedBookable: false,
          selectedTradable: false,
          liveValidationReason: bookability.reason ?? "token_not_bookable",
          lastBookTs: bookability.lastBookTs,
          lastQuoteTs: bookability.lastQuoteTs
        };
        return this.logLivePreorderValidation(result);
      }
      this.persistedPolymarketSnapshot = {
        ...this.persistedPolymarketSnapshot,
        selectedTokenId,
        selectedBookable: true,
        selectedTradable: true,
        liveValidationReason: "preorder_token_bookable",
        lastBookTs: bookability.lastBookTs,
        lastQuoteTs: bookability.lastQuoteTs
      };
    }

    result.valid = true;
    result.reason = "ok";
    return this.logLivePreorderValidation(result);
  }

  private logLivePreorderValidation(
    result: LiveExecutionCandidateValidation
  ): LiveExecutionCandidateValidation {
    const nowIso = new Date().toISOString();
    this.persistedPolymarketSnapshot = {
      ...this.persistedPolymarketSnapshot,
      selectedSlug: result.selectedSlug ?? this.persistedPolymarketSnapshot.selectedSlug,
      selectedMarketId: result.marketId ?? this.persistedPolymarketSnapshot.selectedMarketId,
      selectedTokenId: result.selectedTokenId,
      selectedTradable: result.valid,
      remainingSec:
        Number.isFinite(Number(result.remainingSec)) && Number(result.remainingSec) >= 0
          ? Math.max(0, Math.floor(Number(result.remainingSec)))
          : this.persistedPolymarketSnapshot.remainingSec,
      candidateRefreshed: result.candidateRefreshed,
      lastPreorderValidationReason: result.reason
    };
    this.logger.info(
      `POLY_PREORDER_VALIDATE selectedSlug=${String(result.selectedSlug || "-")} expectedSlug=${String(result.expectedSlug || "-")} marketId=${String(
        result.marketId || "-"
      )} tokenId=${String(result.tokenId || "-")} now=${nowIso} marketStart=${String(
        result.marketStartTs || "-"
      )} marketEnd=${String(result.marketEndTs || "-")} remainingSec=${String(
        result.remainingSec ?? "-"
      )} pollMode=${String(result.pollMode || "-")} candidateRefreshed=${String(
        result.candidateRefreshed
      )} valid=${String(result.valid)} reason=${result.reason}`
    );
    if (!result.valid) {
      this.logger.warn(
        `ORDER_ABORT ${result.reason} selectedSlug=${String(result.selectedSlug || "-")} marketId=${String(
          result.marketId || "-"
        )} tokenId=${String(result.tokenId || "-")}`
      );
    }
    return result;
  }

  private getLiveSelectionCadenceStartSec(selection: {
    selectedSlug: string | null;
    windowStartTs: number | null;
  } | null): number | null {
    if (!selection) return null;
    if (Number(selection.windowStartTs || 0) > 0) {
      return Math.floor(Number(selection.windowStartTs) / 1000);
    }
    return parseBtc5mWindowStartSec(selection.selectedSlug);
  }

  private getSelectionRemainingSecFromSnapshot(
    snapshot: Pick<PersistedPolymarketSnapshot, "remainingSec" | "marketExpiresAtTs" | "windowEndTs">,
    nowTs: number
  ): number | null {
    if (Number.isFinite(Number(snapshot.marketExpiresAtTs)) && Number(snapshot.marketExpiresAtTs) > 0) {
      return Math.max(0, Math.floor((Number(snapshot.marketExpiresAtTs) - nowTs) / 1000));
    }
    if (Number.isFinite(Number(snapshot.windowEndTs)) && Number(snapshot.windowEndTs) > 0) {
      return Math.max(0, Math.floor((Number(snapshot.windowEndTs) - nowTs) / 1000));
    }
    if (Number.isFinite(Number(snapshot.remainingSec)) && Number(snapshot.remainingSec) >= 0) {
      return Math.floor(Number(snapshot.remainingSec));
    }
    return null;
  }

  private getAwaitingResolutionMarketIds(): Set<string> {
    const out = new Set<string>();
    for (const position of this.execution.getPositions()) {
      const marketId = String(position.marketId || "").trim();
      if (marketId.length > 0) out.add(marketId);
    }
    const openOrders =
      typeof (this.execution as { getOpenOrders?: unknown }).getOpenOrders === "function"
        ? (this.execution as { getOpenOrders: () => unknown }).getOpenOrders()
        : [];
    const openOrdersList = Array.isArray(openOrders) ? openOrders : [];
    for (const order of openOrdersList) {
      const marketId = String(order.marketId || "").trim();
      if (marketId.length > 0) out.add(marketId);
    }
    for (const trade of this.paperLedger.getOpenTrades()) {
      const marketId = String(trade.marketId || "").trim();
      if (marketId.length > 0) out.add(marketId);
    }
    for (const trade of this.paperLedger.getResolutionQueueTrades()) {
      const marketId = String(trade.marketId || "").trim();
      if (marketId.length > 0) out.add(marketId);
    }
    return out;
  }

  private clearStaleSelectionForRollover(nowTs: number, reason: string): void {
    const previousSelection = this.liveCommittedSelection;
    const previousMarketId =
      String(previousSelection?.selectedMarketId || this.persistedPolymarketSnapshot.selectedMarketId || "").trim() || null;
    const previousTokenIds = new Set(
      [
        previousSelection?.selectedTokenId,
        previousSelection?.yesTokenId,
        previousSelection?.noTokenId,
        this.persistedPolymarketSnapshot.selectedTokenId
      ]
        .map((value) => String(value || "").trim())
        .filter((value) => value.length > 0)
    );
    const normalizedReason = normalizeHoldReason(reason) || "ROLLOVER_STALE_SELECTION_CLEARED";

    this.liveCommittedSelection = null;
    this.lastUsableLiveSelectedMarket = null;
    this.selectedTokenIds = [];
    this.polyState.selectedSlug = null;
    this.polyState.selectedMarketId = null;
    this.polyState.lastBookTsMs = 0;
    this.polyState.lastYesBid = null;
    this.polyState.lastYesAsk = null;
    this.polyState.lastYesMid = null;

    if (previousMarketId) {
      this.latestYesBookByMarketId.delete(previousMarketId);
    }
    for (const tokenId of previousTokenIds) {
      this.latestTokenBookByTokenId.delete(tokenId);
    }

    this.clearPersistedPolymarketSelection();
    this.persistedPolymarketSnapshot = {
      ...this.persistedPolymarketSnapshot,
      status: "ROLLOVER_PENDING",
      holdReason: normalizedReason,
      executionBlockedReason: normalizedReason,
      liveValidationReason: normalizedReason,
      warningState: this.runtimeWarningState ?? this.persistedPolymarketSnapshot.warningState,
      lastDecisionTs: nowTs
    };
    this.truthSelection = {
      ...this.truthSelection,
      selectedSlug: null,
      selectedMarketId: null,
      windowStartTs: null,
      windowEndTs: null,
      remainingSec: null
    };
  }

  private reconcileSelectionWithCurrentBucket(params: {
    nowTs: number;
    selectedSlug: string | null;
    selectedMarketId: string | null;
    currentBucketSlug: string;
    nextBucketSlug: string;
    remainingSec: number | null;
    selectionCommitTs: number | null;
    holdReason: string | null;
    selectedTradable: boolean;
    bucketChanged: boolean;
    hasCurrentTradableCandidate: boolean;
    hasCurrentBookableCandidate: boolean;
    openTradeMarketIds: Set<string>;
  }): {
    action: SelectionBucketReconcileAction;
    hasOpenTradesForSelectedMarket: boolean;
  } {
    const selectedSlug = String(params.selectedSlug || "").trim() || null;
    const selectedMarketId = String(params.selectedMarketId || "").trim() || null;
    const selectedIsCurrent = selectedSlug !== null && selectedSlug === params.currentBucketSlug;
    const selectedIsNextPrefetch =
      selectedSlug !== null &&
      selectedSlug === params.nextBucketSlug &&
      (params.remainingSec === null || params.remainingSec > 0);
    const selectedExpired = params.remainingSec !== null && params.remainingSec <= 0;
    const selectedNonCurrent = Boolean(selectedSlug && !selectedIsCurrent && !selectedIsNextPrefetch);
    const selectedNoLongerTradable = Boolean(selectedSlug && !params.selectedTradable && !selectedIsNextPrefetch);
    const hasOpenTradesForSelectedMarket =
      selectedMarketId !== null && params.openTradeMarketIds.has(selectedMarketId);

    if (
      selectedSlug &&
      selectedSlug !== params.currentBucketSlug &&
      (selectedExpired || selectedNonCurrent || selectedNoLongerTradable)
    ) {
      this.logger.error(
        {
          selectedSlug,
          currentBucketSlug: params.currentBucketSlug,
          nextBucketSlug: params.nextBucketSlug,
          remainingSec: params.remainingSec,
          selectionCommitTs: params.selectionCommitTs,
          holdReason: normalizeHoldReason(params.holdReason) || null,
          hasOpenTradesForSelectedMarket
        },
        "POLY_SELECTION_INVARIANT_BROKEN"
      );
    }

    if (
      params.hasCurrentTradableCandidate &&
      params.hasCurrentBookableCandidate &&
      (params.bucketChanged || !selectedIsCurrent || !params.selectedTradable)
    ) {
      return {
        action: "PROMOTE_CURRENT_BUCKET",
        hasOpenTradesForSelectedMarket
      };
    }

    if (selectedIsCurrent && !selectedExpired) {
      return {
        action: "KEEP_CURRENT_SELECTION",
        hasOpenTradesForSelectedMarket
      };
    }

    if (selectedIsNextPrefetch) {
      return {
        action: "KEEP_NEXT_PREFETCH",
        hasOpenTradesForSelectedMarket
      };
    }

    if (hasOpenTradesForSelectedMarket) {
      return {
        action: "KEEP_CURRENT_SELECTION",
        hasOpenTradesForSelectedMarket
      };
    }

    return {
      action: "CLEAR_STALE_SELECTION",
      hasOpenTradesForSelectedMarket
    };
  }

  private getLivePollMode(
    snapshot: Pick<
      PersistedPolymarketSnapshot,
      | "selectedSlug"
      | "selectedMarketId"
      | "windowStartTs"
      | "remainingSec"
      | "marketExpiresAtTs"
      | "windowEndTs"
      | "holdReason"
      | "staleState"
      | "warningState"
      | "status"
      | "selectedBookable"
    >,
    nowTs: number
  ): LivePollMode | null {
    if (this.config.polymarket.mode !== "live" || !this.isDeterministicBtc5mMode()) {
      return null;
    }
    const hasRenderableSelection = Boolean(snapshot.selectedSlug || snapshot.selectedMarketId);
    const holdReasonText = String(snapshot.holdReason || "")
      .trim()
      .toUpperCase();
    const warningText = String(snapshot.warningState || "")
      .trim()
      .toUpperCase();
    if (
      !hasRenderableSelection ||
      holdReasonText.includes("TOKEN_NOT_BOOKABLE") ||
      holdReasonText.includes("MISSING_ORDERBOOK_FOR_SELECTED_TOKEN") ||
      snapshot.selectedBookable === false
    ) {
      return "VERY_FAST";
    }
    const staleDiscovery =
      snapshot.staleState === "DISCOVERY_STALE" || warningText.includes("DISCOVERY_STALE");
    if (staleDiscovery && !hasRenderableSelection) {
      return "DISCOVERY_STALE";
    }
    if (snapshot.status === "ROLLOVER_PENDING" || snapshot.status === "EXPIRED_PENDING_DISCOVERY") {
      return "VERY_FAST";
    }
    const currentBucket = this.getFreshBtc5mWallClockBucket(nowTs);
    const selectedBucketStartSec =
      Number.isFinite(Number(snapshot.windowStartTs)) && Number(snapshot.windowStartTs) > 0
        ? Math.floor(Number(snapshot.windowStartTs) / 1000)
        : parseBtc5mWindowStartSec(snapshot.selectedSlug);
    const remainingSec = this.getSelectionRemainingSecFromSnapshot(snapshot, nowTs);
    const committedSelection = this.getActiveLiveCommittedSelection(nowTs);
    const inCurrentBucket =
      hasRenderableSelection &&
      selectedBucketStartSec !== null &&
      selectedBucketStartSec === currentBucket.currentBucketStartSec;
    if (
      hasRenderableSelection &&
      selectedBucketStartSec !== null &&
      selectedBucketStartSec < currentBucket.currentBucketStartSec
    ) {
      return "VERY_FAST";
    }
    if (inCurrentBucket && remainingSec !== null) {
      if (
        committedSelection &&
        ((snapshot.selectedMarketId && committedSelection.selectedMarketId === snapshot.selectedMarketId) ||
          (snapshot.selectedSlug && committedSelection.selectedSlug === snapshot.selectedSlug))
      ) {
        return "VERY_FAST";
      }
      if (remainingSec <= 45) {
        return "VERY_FAST";
      }
      if (remainingSec <= 90) {
        return "FAST";
      }
      return "NORMAL";
    }
    if (staleDiscovery) {
      if (remainingSec !== null && remainingSec <= 120) {
        return "VERY_FAST";
      }
      return "FAST";
    }
    if (
      hasRenderableSelection &&
      selectedBucketStartSec !== null &&
      selectedBucketStartSec > currentBucket.currentBucketStartSec
    ) {
      return "FAST";
    }
    return "NORMAL";
  }

  private logExpectedCurrentBtc5mSlug(
    previousSelectedSlug: string | null,
    currentBucket: Btc5mWallClockBucket = this.getFreshBtc5mWallClockBucket()
  ): void {
    if (!this.debugPoly || this.config.polymarket.mode !== "live" || !this.isDeterministicBtc5mMode()) return;
    const expected = {
      ...currentBucket,
      slug: currentBucket.expectedSlug
    };
    const selectedBucketStartSec = this.getLiveSelectionCadenceStartSec(this.liveCommittedSelection);
    if (this.lastExpectedCurrentBtc5mSlugLogged === expected.slug) {
      return;
    }
    this.lastExpectedCurrentBtc5mSlugLogged = expected.slug;
    this.logger.info(
      {
        nowSec: expected.nowSec,
        currentBucketStartSec: expected.currentBucketStartSec,
        bucketStartSec: expected.bucketStartSec,
        currentSlug: expected.currentSlug,
        prevSlug: expected.prevSlug,
        nextSlug: expected.nextSlug,
        expectedSlug: expected.slug,
        selectedSlug: this.liveCommittedSelection?.selectedSlug ?? null,
        selectedBucketStartSec,
        bucketLagSec:
          selectedBucketStartSec === null ? null : selectedBucketStartSec - expected.currentBucketStartSec,
        bucketLag:
          selectedBucketStartSec === null ? null : selectedBucketStartSec - expected.bucketStartSec,
        expectedCurrentSlug: expected.slug,
        windowStartTs: expected.windowStartTs,
        windowEndTs: expected.windowEndTs,
        remainingSec: expected.remainingSec,
        previousSelectedSlug
      },
      "POLY_BTC5M_EXPECTED_CURRENT_SLUG"
    );
  }

  private demotePreviousCadenceLiveSelection(
    nowTs: number,
    currentBucket: Btc5mWallClockBucket = this.getFreshBtc5mWallClockBucket()
  ): {
    demoted: boolean;
    previousSelectedSlug: string | null;
  } {
    if (this.config.polymarket.mode !== "live" || !this.isDeterministicBtc5mMode() || !this.liveCommittedSelection) {
      return { demoted: false, previousSelectedSlug: null };
    }
    const expected = {
      ...currentBucket,
      slug: currentBucket.expectedSlug
    };
    const currentStartSec = this.getLiveSelectionCadenceStartSec(this.liveCommittedSelection);
    if (currentStartSec === null || currentStartSec === expected.bucketStartSec) {
      return { demoted: false, previousSelectedSlug: this.liveCommittedSelection.selectedSlug };
    }
    const previousSelectedSlug = this.liveCommittedSelection.selectedSlug;
    this.logger.info(
      {
        nowSec: expected.nowSec,
        currentBucketStartSec: expected.currentBucketStartSec,
        bucketStartSec: expected.bucketStartSec,
        currentSlug: expected.currentSlug,
        prevSlug: expected.prevSlug,
        nextSlug: expected.nextSlug,
        expectedSlug: expected.slug,
        selectedSlug: previousSelectedSlug,
        selectedBucketStartSec: currentStartSec,
        bucketLagSec: currentStartSec - expected.currentBucketStartSec,
        bucketLag: currentStartSec - expected.bucketStartSec,
        previousSelectedSlug,
        previousWindowStartSec: currentStartSec,
        expectedCurrentSlug: expected.slug,
        expectedWindowStartSec: expected.bucketStartSec
      },
      "POLY_BTC5M_PREVIOUS_WINDOW_EXPIRED"
    );
    this.clearLiveCommittedSelection(nowTs, "NON_CURRENT_CADENCE_BUCKET");
    return { demoted: true, previousSelectedSlug };
  }

  private promoteExpectedCurrentBtc5mSelection(
    nowTs: number,
    options: {
      selectedReason: string;
      previousSelectedSlug: string | null;
    },
    currentBucket: Btc5mWallClockBucket = this.getFreshBtc5mWallClockBucket()
  ): {
    selectedSlug: string;
    selectedWindowStart: number;
    selectedWindowEnd: number;
    remainingSec: number;
  } {
    const expected = {
      ...currentBucket,
      slug: currentBucket.expectedSlug
    };
    const previous = this.liveCommittedSelection;
    const matchingExpectedSelection =
      previous &&
      this.getLiveSelectionCadenceStartSec(previous) === Math.floor(expected.windowStartTs / 1000)
        ? previous
        : null;
    this.liveCommittedSelection = {
      selectedSlug: expected.slug,
      selectedMarketId: matchingExpectedSelection?.selectedMarketId ?? null,
      selectedEpoch: Math.floor(expected.windowStartTs / 1000),
      windowStartTs: expected.windowStartTs,
      windowEndTs: expected.windowEndTs,
      selectedWindowStartSec: Math.floor(expected.windowStartTs / 1000),
      selectedWindowEndSec: Math.floor(expected.windowEndTs / 1000),
      candidateRefreshed: matchingExpectedSelection?.candidateRefreshed ?? null,
      chosenDirection: matchingExpectedSelection?.chosenDirection ?? null,
      chosenSide: matchingExpectedSelection?.chosenSide ?? null,
      yesTokenId: matchingExpectedSelection?.yesTokenId ?? null,
      noTokenId: matchingExpectedSelection?.noTokenId ?? null,
      selectedTokenId: matchingExpectedSelection?.selectedTokenId ?? null,
      selectedBookable: Boolean(matchingExpectedSelection?.selectedBookable ?? false),
      selectedTradable: Boolean(matchingExpectedSelection?.selectedTradable ?? false),
      discoveredCurrent: matchingExpectedSelection?.discoveredCurrent ?? true,
      discoveredNext: matchingExpectedSelection?.discoveredNext ?? false,
      selectionSource: matchingExpectedSelection?.selectionSource ?? "committed",
      selectedFrom: matchingExpectedSelection?.selectedFrom ?? "committed",
      liveValidationReason: matchingExpectedSelection?.liveValidationReason ?? "awaiting_tradable_candidate",
      lastBookTs: matchingExpectedSelection?.lastBookTs ?? null,
      lastQuoteTs: matchingExpectedSelection?.lastQuoteTs ?? null,
      selectionCommitTs: matchingExpectedSelection?.selectionCommitTs ?? nowTs,
      currentBucketSlug: expected.currentSlug,
      nextBucketSlug: expected.nextSlug,
      currentBucketStartSec: expected.currentBucketStartSec,
      acceptingOrders: matchingExpectedSelection?.acceptingOrders ?? null,
      enableOrderBook: matchingExpectedSelection?.enableOrderBook ?? null,
      selectedReason: options.selectedReason,
      holdReason: matchingExpectedSelection?.holdReason ?? null,
      warningState: matchingExpectedSelection?.warningState ?? this.runtimeWarningState ?? null,
      executionBlockedReason: matchingExpectedSelection?.executionBlockedReason ?? null,
      executionBlockedSide: matchingExpectedSelection?.executionBlockedSide ?? null
    };
    this.polyState.selectedSlug = expected.slug;
    this.polyState.selectedMarketId = matchingExpectedSelection?.selectedMarketId ?? null;
    if (this.debugPoly) {
      this.logger.info(
        {
          nowSec: expected.nowSec,
          currentBucketStartSec: expected.currentBucketStartSec,
          bucketStartSec: expected.bucketStartSec,
          currentSlug: expected.currentSlug,
          prevSlug: expected.prevSlug,
          nextSlug: expected.nextSlug,
          expectedSlug: expected.slug,
          previousSelectedSlug: options.previousSelectedSlug,
          selectedSlug: expected.slug,
          selectedBucketStartSec: Math.floor(expected.windowStartTs / 1000),
          bucketLagSec: 0,
          bucketLag: 0,
          remainingSec: expected.remainingSec,
          selectedReason: options.selectedReason
        },
        "POLY_BTC5M_SELECTED_WINDOW_PROMOTED"
      );
    }
    return {
      selectedSlug: expected.slug,
      selectedWindowStart: expected.windowStartTs,
      selectedWindowEnd: expected.windowEndTs,
      remainingSec: expected.remainingSec
    };
  }

  private commitLiveSelectedMarket(
    market: BtcWindowMarket,
    nowTs: number,
    options: {
      selectedReason?: string | null;
      windowStartTs?: number | null;
      windowEndTs?: number | null;
      chosenDirection?: string | null;
      chosenSide?: "YES" | "NO" | null;
      selectedTokenId?: string | null;
      selectedBookable?: boolean;
      selectedTradable?: boolean;
      candidateRefreshed?: boolean | null;
      discoveredCurrent?: boolean;
      discoveredNext?: boolean;
      selectionSource?: SelectionSource;
      selectedFrom?: SelectionSource;
      selectionCommitTs?: number | null;
      liveValidationReason?: string | null;
      lastBookTs?: number | null;
      lastQuoteTs?: number | null;
      currentBucketSlug?: string | null;
      nextBucketSlug?: string | null;
      currentBucketStartSec?: number | null;
    } = {}
  ): void {
    if (this.config.polymarket.mode !== "live") return;
    const previous = this.getActiveLiveCommittedSelection(nowTs);
    const next = this.buildLiveCommittedSelection(market, nowTs, {
      selectedReason: options.selectedReason ?? null,
      windowStartTs: options.windowStartTs ?? null,
      windowEndTs: options.windowEndTs ?? null,
      chosenDirection:
        options.chosenDirection ??
        (previous &&
        ((previous.selectedMarketId && previous.selectedMarketId === market.marketId) ||
          (previous.selectedSlug &&
            previous.selectedSlug === this.getMarketDeterministicSlug(market)))
          ? previous.chosenDirection
          : null),
      chosenSide:
        options.chosenSide !== undefined
          ? options.chosenSide
          : previous &&
              ((previous.selectedMarketId && previous.selectedMarketId === market.marketId) ||
                (previous.selectedSlug &&
                  previous.selectedSlug === this.getMarketDeterministicSlug(market)))
            ? previous.chosenSide
            : null,
      selectedTokenId:
        options.selectedTokenId !== undefined
          ? options.selectedTokenId
          : options.chosenSide === "NO"
            ? market.noTokenId ?? null
            : options.chosenSide === "YES"
              ? market.yesTokenId ?? null
              : previous?.selectedTokenId ?? null,
      selectedBookable:
        options.selectedBookable !== undefined
          ? options.selectedBookable
          : previous?.selectedBookable ?? false,
      selectedTradable:
        options.selectedTradable !== undefined
          ? options.selectedTradable
          : previous?.selectedTradable ?? false,
      candidateRefreshed:
        options.candidateRefreshed !== undefined
          ? options.candidateRefreshed
          : previous?.candidateRefreshed ?? null,
      discoveredCurrent:
        options.discoveredCurrent !== undefined
          ? options.discoveredCurrent
          : previous?.discoveredCurrent ?? false,
      discoveredNext:
        options.discoveredNext !== undefined
          ? options.discoveredNext
          : previous?.discoveredNext ?? false,
      selectionSource: options.selectionSource ?? previous?.selectionSource ?? "committed",
      selectedFrom: options.selectedFrom ?? options.selectionSource ?? previous?.selectedFrom ?? "committed",
      selectionCommitTs:
        options.selectionCommitTs !== undefined
          ? options.selectionCommitTs
          : previous?.selectionCommitTs ?? null,
      liveValidationReason:
        options.liveValidationReason !== undefined
          ? options.liveValidationReason
          : previous?.liveValidationReason ?? null,
      lastBookTs: options.lastBookTs !== undefined ? options.lastBookTs : previous?.lastBookTs ?? null,
      lastQuoteTs:
        options.lastQuoteTs !== undefined ? options.lastQuoteTs : previous?.lastQuoteTs ?? null,
      currentBucketSlug:
        options.currentBucketSlug !== undefined
          ? options.currentBucketSlug
          : previous?.currentBucketSlug ?? null,
      nextBucketSlug:
        options.nextBucketSlug !== undefined ? options.nextBucketSlug : previous?.nextBucketSlug ?? null,
      currentBucketStartSec:
        options.currentBucketStartSec !== undefined
          ? options.currentBucketStartSec
          : previous?.currentBucketStartSec ?? null
    });
    if (!next) {
      return;
    }
    const selectionChanged =
      !previous ||
      previous.selectedSlug !== next.selectedSlug ||
      previous.selectedMarketId !== next.selectedMarketId ||
      previous.windowEndTs !== next.windowEndTs;
    if (selectionChanged) {
      if (this.debugPoly) {
        const currentBucket = this.getExpectedCurrentBtc5mBucket();
        const selectedBucketStartSec = this.getLiveSelectionCadenceStartSec(next);
        this.logger.info(
          {
            nowSec: currentBucket.nowSec,
            currentBucketStartSec: currentBucket.currentBucketStartSec,
            currentSlug: currentBucket.currentSlug,
            prevSlug: currentBucket.prevSlug,
            nextSlug: currentBucket.nextSlug,
            selectedSlug: next.selectedSlug,
            marketId: next.selectedMarketId,
            remainingSec: next.remainingSec,
            selectedReason: next.selectedReason
          },
          "POLY_LIVE_SELECTED_MARKET_FOUND"
        );
        this.logger.info(
          {
            nowSec: currentBucket.nowSec,
            currentBucketStartSec: currentBucket.currentBucketStartSec,
            bucketStartSec: currentBucket.bucketStartSec,
            currentSlug: currentBucket.currentSlug,
            prevSlug: currentBucket.prevSlug,
            nextSlug: currentBucket.nextSlug,
            expectedSlug: currentBucket.slug,
            previousSelectedSlug: previous?.selectedSlug ?? null,
            selectedSlug: next.selectedSlug,
            selectedBucketStartSec,
            bucketLagSec:
              selectedBucketStartSec === null ? null : selectedBucketStartSec - currentBucket.currentBucketStartSec,
            bucketLag:
              selectedBucketStartSec === null ? null : selectedBucketStartSec - currentBucket.bucketStartSec,
            marketId: next.selectedMarketId,
            remainingSec: next.remainingSec,
            selectedReason: next.selectedReason
          },
          "POLY_BTC5M_SELECTED_WINDOW_PROMOTED"
        );
      }
    }
    this.liveCommittedSelection = {
      selectedSlug: next.selectedSlug,
      selectedMarketId: next.selectedMarketId,
      selectedEpoch: next.selectedEpoch,
      windowStartTs: next.windowStartTs,
      windowEndTs: next.windowEndTs,
      selectedWindowStartSec: next.selectedWindowStartSec,
      selectedWindowEndSec: next.selectedWindowEndSec,
      candidateRefreshed: next.candidateRefreshed,
      chosenDirection: next.chosenDirection,
      chosenSide: next.chosenSide,
      yesTokenId: next.yesTokenId,
      noTokenId: next.noTokenId,
      selectedTokenId: next.selectedTokenId,
      selectedBookable: next.selectedBookable,
      selectedTradable: next.selectedTradable,
      discoveredCurrent: next.discoveredCurrent,
      discoveredNext: next.discoveredNext,
      selectionSource: next.selectionSource,
      selectedFrom: next.selectedFrom,
      selectionCommitTs: selectionChanged ? nowTs : next.selectionCommitTs ?? previous?.selectionCommitTs ?? nowTs,
      liveValidationReason: next.liveValidationReason,
      lastBookTs: next.lastBookTs,
      lastQuoteTs: next.lastQuoteTs,
      currentBucketSlug: next.currentBucketSlug,
      nextBucketSlug: next.nextBucketSlug,
      currentBucketStartSec: next.currentBucketStartSec,
      acceptingOrders: next.acceptingOrders,
      enableOrderBook: next.enableOrderBook,
      selectedReason: next.selectedReason,
      holdReason: next.holdReason,
      warningState: next.warningState ?? this.runtimeWarningState ?? null,
      executionBlockedReason: null,
      executionBlockedSide: null
    };
    this.lastUsableLiveSelectedMarket = { ...market };
    this.selectedTokenIds = [market.yesTokenId, market.noTokenId].filter(Boolean) as string[];
    this.polyState.selectedSlug = next.selectedSlug;
    this.polyState.selectedMarketId = next.selectedMarketId;
    this.syncPersistedLiveSelectionState(nowTs);
    if (
      selectionChanged ||
      previous?.selectedTokenId !== next.selectedTokenId ||
      previous?.chosenSide !== next.chosenSide ||
      previous?.chosenDirection !== next.chosenDirection
    ) {
      this.emitSelectionCommitLine({
        selectedSlug: next.selectedSlug,
        selectedTokenId: next.selectedTokenId,
        selectionSource: next.selectionSource,
        remainingSec: next.remainingSec,
        chosenSide: next.chosenSide,
        chosenDirection: next.chosenDirection
      });
    }
    if (
      selectionChanged ||
      previous?.chosenDirection !== next.chosenDirection ||
      previous?.chosenSide !== next.chosenSide
    ) {
      if (this.debugPoly) {
        this.logger.info(
          {
            selectedSlug: next.selectedSlug,
            marketId: next.selectedMarketId,
            remainingSec: next.remainingSec,
            chosenDirection: next.chosenDirection,
            chosenSide: next.chosenSide,
            yesTokenId: next.yesTokenId,
            noTokenId: next.noTokenId,
            selectedReason: next.selectedReason
          },
          "POLY_LIVE_SELECTED_MARKET_COMMITTED"
        );
      }
    }
  }

  private updateLiveCommittedSelectionDecision(
    market: BtcWindowMarket,
    nowTs: number,
    chosenSide: "YES" | "NO" | null,
    chosenDirection: string | null
  ): void {
    if (this.config.polymarket.mode !== "live") return;
    const current = this.getActiveLiveCommittedSelection(nowTs);
    if (
      !current ||
      (current.selectedMarketId && current.selectedMarketId !== market.marketId) ||
      (!current.selectedMarketId &&
        current.selectedSlug &&
        current.selectedSlug !== this.getMarketDeterministicSlug(market))
    ) {
      this.commitLiveSelectedMarket(market, nowTs, { chosenSide, chosenDirection });
      return;
    }
    this.liveCommittedSelection = {
      ...this.liveCommittedSelection!,
      chosenSide,
      chosenDirection: chosenDirection ?? current.chosenDirection,
      holdReason: null,
      warningState: this.runtimeWarningState ?? null,
      executionBlockedReason: null,
      executionBlockedSide: null
    };
    this.syncPersistedLiveSelectionState(nowTs);
  }

  private syncPersistedLiveSelectionState(nowTs: number): void {
    const current = this.getActiveLiveCommittedSelection(nowTs);
    if (!current) {
      return;
    }
    this.truthSelection = {
      ...this.truthSelection,
      selectedSlug: current.selectedSlug,
      selectedMarketId: current.selectedMarketId,
      windowStartTs: current.windowStartTs,
      windowEndTs: current.windowEndTs,
      remainingSec: current.remainingSec
    };
    this.truthChosenSide = current.chosenSide ?? this.truthChosenSide;
    this.truthChosenDirection = current.chosenDirection ?? this.truthChosenDirection;
    if (current.holdReason) {
      this.truthHoldReason = normalizeHoldReason(current.holdReason);
    }
    this.syncPersistedPolymarketSelectionState(nowTs);
  }

  private persistLiveCommittedSelectionStatus(
    nowTs: number,
    params: {
      holdReason?: string | null;
      warningState?: string | null;
      chosenSide?: "YES" | "NO" | null;
      chosenDirection?: string | null;
    }
  ): void {
    const current = this.getActiveLiveCommittedSelection(nowTs);
    if (!current || !this.liveCommittedSelection) {
      return;
    }
    this.liveCommittedSelection = {
      ...this.liveCommittedSelection,
      chosenSide:
        params.chosenSide !== undefined ? params.chosenSide : this.liveCommittedSelection.chosenSide,
      chosenDirection:
        params.chosenDirection !== undefined
          ? params.chosenDirection
          : this.liveCommittedSelection.chosenDirection,
      holdReason:
        params.holdReason !== undefined
          ? normalizeHoldReason(params.holdReason)
          : this.liveCommittedSelection.holdReason,
      warningState:
        params.warningState !== undefined ? params.warningState : this.liveCommittedSelection.warningState
    };
    this.syncPersistedLiveSelectionState(nowTs);
  }

  private markLiveSelectedMarketExecutionBlocked(params: {
    market: BtcWindowMarket;
    nowTs: number;
    side: "YES" | "NO";
    reason: "MISSING_ORDERBOOK" | "SIDE_NOT_BOOKABLE";
    source: BookLookupSource;
    tokenId: string | null;
  }): void {
    if (this.config.polymarket.mode !== "live") return;
    const current = this.getActiveLiveCommittedSelection(params.nowTs);
    const slug = this.getMarketDeterministicSlug(params.market);
    const marketMatchesSelection = Boolean(
      current &&
        ((current.selectedMarketId && current.selectedMarketId === params.market.marketId) ||
          (current.selectedSlug && current.selectedSlug === slug))
    );
    if (!marketMatchesSelection || !this.liveCommittedSelection) {
      return;
    }
    if (
      this.liveCommittedSelection.executionBlockedReason === params.reason &&
      this.liveCommittedSelection.executionBlockedSide === params.side
    ) {
      return;
    }
    this.liveCommittedSelection = {
      ...this.liveCommittedSelection,
      selectedTokenId: null,
      selectedBookable: false,
      selectedTradable: false,
      liveValidationReason:
        params.reason === "MISSING_ORDERBOOK" ? "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN" : "SIDE_NOT_BOOKABLE",
      holdReason: normalizeHoldReason("SIDE_NOT_BOOKABLE"),
      warningState: this.runtimeWarningState,
      executionBlockedReason: "SIDE_NOT_BOOKABLE",
      executionBlockedSide: params.side
    };
    this.syncPersistedLiveSelectionState(params.nowTs);
    if (this.debugPoly) {
      this.logger.warn(
        {
          selectedSlug: this.liveCommittedSelection.selectedSlug,
          marketId: this.liveCommittedSelection.selectedMarketId,
          side: params.side,
          tokenId: params.tokenId,
          source: params.source,
          reason: params.reason
        },
        "POLY_LIVE_SELECTED_MARKET_EXECUTION_BLOCKED"
      );
    }
    const currentBucket = this.getExpectedCurrentBtc5mBucket();
    const expectedCurrentSlug = currentBucket.slug;
    const selectedBucketStartSec = this.getLiveSelectionCadenceStartSec(this.liveCommittedSelection);
    const delayedBookSignature = [
      this.liveCommittedSelection.selectedSlug,
      params.side,
      params.reason,
      params.source
    ].join(":");
    if (
      this.liveCommittedSelection.selectedSlug === expectedCurrentSlug &&
      delayedBookSignature !== this.lastDelayedBookConfirmationSignature
    ) {
      this.lastDelayedBookConfirmationSignature = delayedBookSignature;
      if (this.debugPoly) {
        this.logger.warn(
          {
            nowSec: currentBucket.nowSec,
            currentBucketStartSec: currentBucket.currentBucketStartSec,
            bucketStartSec: currentBucket.bucketStartSec,
            currentSlug: currentBucket.currentSlug,
            prevSlug: currentBucket.prevSlug,
            nextSlug: currentBucket.nextSlug,
            expectedCurrentSlug,
            selectedSlug: this.liveCommittedSelection.selectedSlug,
            selectedBucketStartSec,
            bucketLagSec:
              selectedBucketStartSec === null ? null : selectedBucketStartSec - currentBucket.currentBucketStartSec,
            bucketLag:
              selectedBucketStartSec === null ? null : selectedBucketStartSec - currentBucket.bucketStartSec,
            marketId: this.liveCommittedSelection.selectedMarketId,
            side: params.side,
            tokenId: params.tokenId,
            source: params.source,
            reason: params.reason
          },
          "POLY_BTC5M_DELAYED_BOOK_CONFIRMATION"
        );
      }
    }
  }

  private clearLiveCommittedSelection(nowTs: number, reason: string): void {
    if (this.config.polymarket.mode !== "live" || !this.liveCommittedSelection) {
      return;
    }
    if (this.debugPoly) {
      this.logger.info(
        {
          selectedSlug: this.liveCommittedSelection.selectedSlug,
          selectedBucketStartSec: this.getLiveSelectionCadenceStartSec(this.liveCommittedSelection),
          marketId: this.liveCommittedSelection.selectedMarketId,
          reason,
          now: new Date(nowTs).toISOString()
        },
        "POLY_LIVE_SELECTED_MARKET_EXPIRED"
      );
    }
    this.liveCommittedSelection = null;
    this.lastUsableLiveSelectedMarket = null;
    this.selectedTokenIds = [];
    this.polyState.selectedSlug = null;
    this.polyState.selectedMarketId = null;
    const normalizedReason = String(reason || "").trim().toUpperCase();
    const pendingRollover =
      normalizedReason === "EXPIRED_WINDOW" ||
      normalizedReason === "LOW_REMAINING_ROLLOVER" ||
      normalizedReason === "PREORDER_STALE_MARKET_SELECTION" ||
      normalizedReason === "PREORDER_STALE_TOKEN_IDS" ||
      normalizedReason === "PREORDER_TOKEN_MISMATCH" ||
      normalizedReason === "PREORDER_REMAINING_BELOW_THRESHOLD" ||
      normalizedReason === "PREORDER_MARKET_NOT_ACTIVE" ||
      normalizedReason === "PREORDER_MARKET_CLOSED" ||
      normalizedReason === "PREORDER_MARKET_ARCHIVED" ||
      normalizedReason === "PREORDER_INVALID_WINDOW" ||
      normalizedReason === "PREORDER_DISCOVERY_FAILED";
    if (pendingRollover) {
      this.markPersistedPolymarketSelectionPendingRollover(
        nowTs,
        this.runtimeWarningState ? "EXPIRED_PENDING_DISCOVERY" : "ROLLOVER_PENDING"
      );
    } else {
      this.clearPersistedPolymarketSelection();
    }
  }

  private demoteLiveSelection(reason: string, nowTs: number): void {
    this.liveCommittedSelection = null;
    this.lastUsableLiveSelectedMarket = null;
    this.selectedTokenIds = [];

    this.polyState.selectedSlug = null;
    this.polyState.selectedMarketId = null;

    this.persistedPolymarketSnapshot = {
      ...this.persistedPolymarketSnapshot,
      selectedSlug: null,
      selectedMarketId: null,
      selectedTokenId: null,
      selectedBookable: false,
      selectedTradable: false,
      discoveredCurrent: false,
      discoveredNext: false,
      selectionSource: null,
      selectedFrom: null,
      selectionCommitTs: null,
      liveValidationReason: reason,
      selectedWindowStartSec: null,
      selectedWindowEndSec: null,
      holdReason: reason,
      executionBlockedReason: reason,
      status: "DEGRADED",
      pollMode: "VERY_FAST",
      lastDecisionTs: nowTs
    };

    this.truthSelection = {
      ...this.truthSelection,
      selectedSlug: null,
      selectedMarketId: null,
      windowStartTs: null,
      windowEndTs: null,
      remainingSec: null
    };
  }

  private getActiveLiveCommittedSelection(
    nowTs: number
  ): (LiveCommittedSelection & { remainingSec: number }) | null {
    if (this.config.polymarket.mode !== "live" || !this.liveCommittedSelection) {
      return null;
    }
    const snapshot = this.getActiveSelectionSnapshot(
      {
        finalCandidatesCount: this.truthSelection.finalCandidatesCount,
        selectedSlug: this.liveCommittedSelection.selectedSlug,
        selectedMarketId: this.liveCommittedSelection.selectedMarketId,
        windowStartTs: this.liveCommittedSelection.windowStartTs,
        windowEndTs: this.liveCommittedSelection.windowEndTs,
        remainingSec: null
      },
      nowTs
    );
    if (!snapshot.selectedSlug && !snapshot.selectedMarketId) {
      this.clearLiveCommittedSelection(nowTs, "EXPIRED_WINDOW");
      return null;
    }
    const selectedSlug = String(snapshot.selectedSlug || "").trim() || null;
    const selectedMarketId =
      String(snapshot.selectedMarketId || this.liveCommittedSelection.selectedMarketId || "").trim() || null;
    const currentBucket = this.getFreshBtc5mWallClockBucket(nowTs);
    const selectedInCurrentOrNext =
      selectedSlug === null ||
      selectedSlug === currentBucket.currentSlug ||
      selectedSlug === currentBucket.nextSlug;
    const openTradeMarketIds = this.getAwaitingResolutionMarketIds();
    const hasOpenTradeForSelectedMarket =
      selectedMarketId !== null && openTradeMarketIds.has(selectedMarketId);
    if (!selectedInCurrentOrNext && !hasOpenTradeForSelectedMarket) {
      this.logger.error(
        {
          selectedSlug,
          currentSlug: currentBucket.currentSlug,
          nextSlug: currentBucket.nextSlug,
          prevSlug: currentBucket.prevSlug,
          selectionSource: this.liveCommittedSelection.selectionSource ?? null,
          selectionCommitTs: this.liveCommittedSelection.selectionCommitTs ?? null,
          remainingSec: snapshot.remainingSec ?? null
        },
        "POLY_BUCKET_SELECTION_INVARIANT_BROKEN"
      );
      this.clearLiveCommittedSelection(nowTs, "NON_CURRENT_CADENCE_BUCKET");
      return null;
    }
    return {
      ...this.liveCommittedSelection,
      selectedSlug,
      selectedMarketId,
      windowStartTs: snapshot.windowStartTs,
      windowEndTs: snapshot.windowEndTs,
      remainingSec: snapshot.remainingSec ?? 0
    };
  }

  private getStartupHoldReason(): string {
    return this.runtimeStartupStateReason === "STARTUP_INCOMPLETE_NO_USABLE_WINDOW"
      ? "STARTUP_INCOMPLETE_NO_USABLE_WINDOW"
      : "NO_ACTIVE_BTC5M_MARKET";
  }

  private clearPersistedPolymarketSelection(): void {
    this.persistedPolymarketSnapshot = {
      ...this.persistedPolymarketSnapshot,
      selectedSlug: null,
      selectedMarketId: null,
      selectedEpoch: null,
      windowStartTs: null,
      windowEndTs: null,
      remainingSec: null,
      discoveredAtTs: null,
      marketExpiresAtTs: null,
      chosenSide: null,
      chosenDirection: null,
      selectedTokenId: null,
      selectedBookable: false,
      selectedTradable: false,
      discoveredCurrent: false,
      discoveredNext: false,
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
      executionBlockedReason: null
    };
  }

  private markPersistedPolymarketSelectionPendingRollover(
    nowTs: number,
    status: "ROLLOVER_PENDING" | "EXPIRED_PENDING_DISCOVERY"
  ): void {
    if (this.config.polymarket.mode !== "live") {
      this.clearPersistedPolymarketSelection();
      return;
    }
    const selectedSlug = this.persistedPolymarketSnapshot.selectedSlug;
    const selectedMarketId = this.persistedPolymarketSnapshot.selectedMarketId;
    if (!selectedSlug && !selectedMarketId) {
      return;
    }
    const marketExpiresAtTs =
      Number(this.persistedPolymarketSnapshot.marketExpiresAtTs || 0) > 0
        ? Number(this.persistedPolymarketSnapshot.marketExpiresAtTs)
        : Number(this.persistedPolymarketSnapshot.windowEndTs || 0) > 0
          ? Number(this.persistedPolymarketSnapshot.windowEndTs)
          : nowTs;
    this.persistedPolymarketSnapshot = {
      ...this.persistedPolymarketSnapshot,
      status,
      remainingSec: 0,
      windowEndTs: marketExpiresAtTs,
      marketExpiresAtTs,
      selectedBookable: false,
      selectedTradable: false,
      discoveredCurrent: this.persistedPolymarketSnapshot.discoveredCurrent,
      discoveredNext: this.persistedPolymarketSnapshot.discoveredNext,
      liveValidationReason: "AWAITING_NEXT_MARKET_DISCOVERY",
      holdReason: "AWAITING_NEXT_MARKET_DISCOVERY",
      lastDecisionTs: nowTs,
      statusLine: null
    };
  }

  private syncPersistedPolymarketSelectionState(nowTs: number): void {
    const liveSelection =
      this.config.polymarket.mode === "live" ? this.getActiveLiveCommittedSelection(nowTs) : null;
    const currentBucket = this.getFreshBtc5mWallClockBucket(nowTs);
    const baseSelection =
      liveSelection ??
      this.getActiveSelectionSnapshot(
        {
          finalCandidatesCount: this.truthSelection.finalCandidatesCount,
          selectedSlug: this.truthSelection.selectedSlug,
          selectedMarketId: this.truthSelection.selectedMarketId,
          windowStartTs: this.truthSelection.windowStartTs,
          windowEndTs: this.truthSelection.windowEndTs,
          remainingSec: this.truthSelection.remainingSec
        },
        nowTs
      );
    if (!baseSelection.selectedSlug && !baseSelection.selectedMarketId) {
      return;
    }
    this.persistedPolymarketSnapshot = {
      ...this.persistedPolymarketSnapshot,
      selectedSlug: baseSelection.selectedSlug,
      selectedMarketId: baseSelection.selectedMarketId,
      selectedEpoch:
        liveSelection
          ? liveSelection.selectedEpoch
          : this.persistedPolymarketSnapshot.selectedEpoch,
      windowStartTs: baseSelection.windowStartTs,
      windowEndTs: baseSelection.windowEndTs,
      remainingSec: baseSelection.remainingSec,
      chosenSide:
        (liveSelection ? liveSelection.chosenSide : null) ??
        this.truthChosenSide ??
        this.persistedPolymarketSnapshot.chosenSide,
      chosenDirection:
        (liveSelection ? liveSelection.chosenDirection : null) ??
        this.truthChosenDirection ??
        this.persistedPolymarketSnapshot.chosenDirection,
      holdReason:
        normalizeHoldReason(
          (liveSelection ? liveSelection.holdReason : null) ||
            this.persistedPolymarketSnapshot.holdReason ||
            this.truthHoldReason
        ) ?? null,
      executionBlockedReason:
        (liveSelection ? liveSelection.executionBlockedReason : null) ??
        this.persistedPolymarketSnapshot.executionBlockedReason,
      warningState:
        (liveSelection ? liveSelection.warningState : null) ??
        this.runtimeWarningState ??
        this.persistedPolymarketSnapshot.warningState,
      discoveredAtTs:
        this.persistedPolymarketSnapshot.selectedSlug !== baseSelection.selectedSlug ||
        this.persistedPolymarketSnapshot.selectedMarketId !== baseSelection.selectedMarketId
          ? nowTs
          : this.persistedPolymarketSnapshot.discoveredAtTs ?? nowTs,
      marketExpiresAtTs: baseSelection.windowEndTs,
      lastDecisionTs: nowTs,
      lastDiscoverySuccessTs: nowTs,
      lastSelectedMarketTs: nowTs,
      currentBtcMid:
        Number.isFinite(Number(this.latestPolymarketSnapshot?.fastMid)) && Number(this.latestPolymarketSnapshot?.fastMid) > 0
          ? Number(this.latestPolymarketSnapshot?.fastMid)
          : this.persistedPolymarketSnapshot.currentBtcMid,
      selectedTokenId:
        (liveSelection ? liveSelection.selectedTokenId : null) ??
        this.persistedPolymarketSnapshot.selectedTokenId,
      selectedBookable:
        liveSelection ? Boolean(liveSelection.selectedBookable) : this.persistedPolymarketSnapshot.selectedBookable,
      selectedTradable:
        liveSelection ? Boolean(liveSelection.selectedTradable) : this.persistedPolymarketSnapshot.selectedTradable,
      discoveredCurrent:
        liveSelection ? Boolean(liveSelection.discoveredCurrent) : this.persistedPolymarketSnapshot.discoveredCurrent,
      discoveredNext:
        liveSelection ? Boolean(liveSelection.discoveredNext) : this.persistedPolymarketSnapshot.discoveredNext,
      selectionSource:
        (liveSelection ? liveSelection.selectionSource : null) ??
        this.persistedPolymarketSnapshot.selectionSource,
      selectedFrom:
        (liveSelection ? liveSelection.selectedFrom : null) ??
        (liveSelection ? liveSelection.selectionSource : null) ??
        this.persistedPolymarketSnapshot.selectedFrom ??
        this.persistedPolymarketSnapshot.selectionSource,
      selectionCommitTs:
        (liveSelection ? liveSelection.selectionCommitTs : null) ??
        this.persistedPolymarketSnapshot.selectionCommitTs,
      liveValidationReason:
        (liveSelection ? liveSelection.liveValidationReason : null) ??
        this.persistedPolymarketSnapshot.liveValidationReason,
      lastBookTs: (liveSelection ? liveSelection.lastBookTs : null) ?? this.persistedPolymarketSnapshot.lastBookTs,
      lastQuoteTs:
        (liveSelection ? liveSelection.lastQuoteTs : null) ?? this.persistedPolymarketSnapshot.lastQuoteTs,
      currentBucketSlug: currentBucket.currentSlug,
      nextBucketSlug: currentBucket.nextSlug,
      currentBucketStartSec: currentBucket.currentBucketStartSec,
      selectedWindowStartSec:
        liveSelection?.selectedWindowStartSec ??
        (baseSelection.windowStartTs !== null ? Math.floor(baseSelection.windowStartTs / 1000) : null),
      selectedWindowEndSec:
        liveSelection?.selectedWindowEndSec ??
        (baseSelection.windowEndTs !== null ? Math.floor(baseSelection.windowEndTs / 1000) : null),
      candidateRefreshed:
        liveSelection?.candidateRefreshed ?? this.persistedPolymarketSnapshot.candidateRefreshed
    };
  }

  private buildPersistedPolymarketStatusLine(snapshot: PersistedPolymarketSnapshot): string {
    const selected = snapshot.selectedSlug || snapshot.selectedMarketId || "-";
    const side = snapshot.chosenSide || "-";
    const direction = snapshot.chosenDirection || "-";
    const pollMode = snapshot.pollMode || "NORMAL";
    const remainingSec =
      Number.isFinite(Number(snapshot.remainingSec)) && Number(snapshot.remainingSec) >= 0
        ? `${Math.floor(Number(snapshot.remainingSec))}s left`
        : "-";
    const action = snapshot.action || "HOLD";
    const holdReason = snapshot.holdReason || "-";
    const holdCategory = snapshot.holdCategory || "-";
    const warning = snapshot.warningState || "none";
    const tradable = snapshot.selectedTradable ? "tradable" : "not-tradable";
    const btcMid =
      Number.isFinite(Number(snapshot.currentBtcMid)) && Number(snapshot.currentBtcMid) > 0
        ? Number(snapshot.currentBtcMid).toFixed(2)
        : "-";
    return `BTC 5m | ${selected} | ${side} ${direction} | ${remainingSec} | ${action} ${holdReason} (${holdCategory}) | ${tradable} | poll ${pollMode} | btc ${btcMid} | warn ${warning}`;
  }

  private getPersistedPolymarketSnapshot(nowTs: number): PersistedPolymarketSnapshot {
    const tickBucket = this.getFreshBtc5mWallClockBucket(nowTs);
    const trackedSelection = {
      selectedSlug: this.persistedPolymarketSnapshot.selectedSlug,
      selectedMarketId: this.persistedPolymarketSnapshot.selectedMarketId,
      windowStartTs: this.persistedPolymarketSnapshot.windowStartTs,
      windowEndTs: this.persistedPolymarketSnapshot.windowEndTs,
      marketExpiresAtTs:
        Number(this.persistedPolymarketSnapshot.marketExpiresAtTs || 0) > 0
          ? Number(this.persistedPolymarketSnapshot.marketExpiresAtTs)
          : Number(this.persistedPolymarketSnapshot.windowEndTs || 0) > 0
            ? Number(this.persistedPolymarketSnapshot.windowEndTs)
            : Number(this.persistedPolymarketSnapshot.discoveredAtTs || 0) > 0 &&
                Number.isFinite(Number(this.persistedPolymarketSnapshot.remainingSec))
              ? Number(this.persistedPolymarketSnapshot.discoveredAtTs) +
                Math.max(0, Math.floor(Number(this.persistedPolymarketSnapshot.remainingSec))) * 1000
              : null
    };
    const selectionSnapshot = this.getActiveSelectionSnapshot(
      {
        finalCandidatesCount: this.persistedPolymarketSnapshot.finalCandidatesCount,
        selectedSlug: trackedSelection.selectedSlug,
        selectedMarketId: trackedSelection.selectedMarketId,
        windowStartTs: trackedSelection.windowStartTs,
        windowEndTs: trackedSelection.marketExpiresAtTs ?? trackedSelection.windowEndTs,
        remainingSec:
          Number((trackedSelection.marketExpiresAtTs ?? trackedSelection.windowEndTs) || 0) > 0
            ? null
            : this.persistedPolymarketSnapshot.remainingSec
      },
      nowTs
    );
    const hasActiveSelection = Boolean(selectionSnapshot.selectedSlug || selectionSnapshot.selectedMarketId);
    const hasTrackedSelection = Boolean(trackedSelection.selectedSlug || trackedSelection.selectedMarketId);
    const awaitingResolutionMarketIds = this.getAwaitingResolutionMarketIds();
    const trackedHasAwaitingResolution =
      Boolean(trackedSelection.selectedMarketId) &&
      awaitingResolutionMarketIds.has(String(trackedSelection.selectedMarketId || "").trim());
    const trackedRemainingSec =
      trackedSelection.marketExpiresAtTs !== null
        ? Math.max(0, Math.floor((trackedSelection.marketExpiresAtTs - nowTs) / 1000))
        : Number.isFinite(Number(this.persistedPolymarketSnapshot.remainingSec))
          ? Math.max(0, Math.floor(Number(this.persistedPolymarketSnapshot.remainingSec)))
          : null;
    const preserveExpiredSelection =
      this.config.polymarket.mode === "live" &&
      hasTrackedSelection &&
      !hasActiveSelection &&
      trackedRemainingSec !== null &&
      trackedHasAwaitingResolution;
    const hasRenderableSelection = hasActiveSelection || preserveExpiredSelection;
    const lastDiscoverySuccessTs = Math.max(
      0,
      Number(this.persistedPolymarketSnapshot.lastDiscoverySuccessTs || 0),
      Number(this.polyState.lastFetchOkTs || 0),
      Number(this.polyState.lastUpdateTs || 0)
    );
    const freshnessStaleState = this.getSelectionFreshnessWarning(nowTs, lastDiscoverySuccessTs, hasRenderableSelection);
    const explicitExecutionStaleState =
      this.persistedPolymarketSnapshot.staleState === "ACTIVE_MARKET_REFRESH_FAILED" ||
      this.persistedPolymarketSnapshot.staleState === "ACTIVE_MARKET_PRICE_STALE"
        ? this.persistedPolymarketSnapshot.staleState
        : null;
    const staleState = explicitExecutionStaleState ?? freshnessStaleState;
    const warningState = this.combineWarningStates(
      this.persistedPolymarketSnapshot.warningState ?? this.runtimeWarningState,
      staleState ? "DISCOVERY_STALE" : null
    );
    const expiredPendingStatus =
      preserveExpiredSelection && trackedRemainingSec === 0
        ? warningState
          ? "EXPIRED_PENDING_DISCOVERY"
          : "ROLLOVER_PENDING"
        : null;
    const status =
      expiredPendingStatus ??
      this.persistedPolymarketSnapshot.status ??
      (this.runtimeStartupState === "STARTING"
        ? "STARTING"
        : this.runtimeStartupState === "HOLD_NO_ACTIVE_BTC5M_MARKET" && !hasRenderableSelection
          ? "NO_ACTIVE_BTC5M_MARKET"
          : warningState
            ? "DEGRADED"
            : "RUNNING");
    const snapshot: PersistedPolymarketSnapshot = {
      ...this.persistedPolymarketSnapshot,
      status,
      staleState,
      pollMode: null,
      selectedSlug: hasActiveSelection
        ? selectionSnapshot.selectedSlug
        : preserveExpiredSelection
          ? trackedSelection.selectedSlug
          : null,
      selectedMarketId: hasActiveSelection
        ? selectionSnapshot.selectedMarketId
        : preserveExpiredSelection
          ? trackedSelection.selectedMarketId
          : null,
      windowStartTs: hasActiveSelection
        ? selectionSnapshot.windowStartTs
        : preserveExpiredSelection
          ? trackedSelection.windowStartTs
          : null,
      windowEndTs: hasActiveSelection
        ? selectionSnapshot.windowEndTs
        : preserveExpiredSelection
          ? trackedSelection.marketExpiresAtTs ?? trackedSelection.windowEndTs
          : null,
      marketExpiresAtTs: hasActiveSelection
        ? selectionSnapshot.windowEndTs
        : preserveExpiredSelection
          ? trackedSelection.marketExpiresAtTs ?? trackedSelection.windowEndTs
          : this.persistedPolymarketSnapshot.marketExpiresAtTs,
      remainingSec: hasActiveSelection
        ? selectionSnapshot.remainingSec
        : preserveExpiredSelection
          ? trackedRemainingSec
          : null,
      chosenSide: hasRenderableSelection ? this.persistedPolymarketSnapshot.chosenSide : null,
      chosenDirection: hasRenderableSelection ? this.persistedPolymarketSnapshot.chosenDirection : null,
      holdReason: normalizeHoldReason(
        expiredPendingStatus ? "AWAITING_NEXT_MARKET_DISCOVERY" : this.persistedPolymarketSnapshot.holdReason ?? this.truthHoldReason
      ),
      holdCategory: hasRenderableSelection ? this.persistedPolymarketSnapshot.holdCategory : null,
      strategyAction: this.persistedPolymarketSnapshot.strategyAction,
      selectedTokenId: hasRenderableSelection ? this.persistedPolymarketSnapshot.selectedTokenId : null,
      selectedBookable: hasRenderableSelection ? this.persistedPolymarketSnapshot.selectedBookable : false,
      selectedTradable: hasRenderableSelection ? this.persistedPolymarketSnapshot.selectedTradable : false,
      selectionSource: hasRenderableSelection ? this.persistedPolymarketSnapshot.selectionSource : null,
      liveValidationReason: this.persistedPolymarketSnapshot.liveValidationReason,
      lastBookTs: this.persistedPolymarketSnapshot.lastBookTs,
      lastQuoteTs: this.persistedPolymarketSnapshot.lastQuoteTs,
      currentBucketSlug: tickBucket.currentSlug,
      nextBucketSlug: tickBucket.nextSlug,
      currentBucketStartSec: tickBucket.currentBucketStartSec,
      selectedWindowStartSec:
        hasRenderableSelection ? this.persistedPolymarketSnapshot.selectedWindowStartSec : null,
      selectedWindowEndSec:
        hasRenderableSelection ? this.persistedPolymarketSnapshot.selectedWindowEndSec : null,
      candidateRefreshed: this.persistedPolymarketSnapshot.candidateRefreshed,
      lastPreorderValidationReason: this.persistedPolymarketSnapshot.lastPreorderValidationReason,
      warningState,
      discoveredAtTs:
        hasRenderableSelection
          ? this.persistedPolymarketSnapshot.discoveredAtTs ?? this.persistedPolymarketSnapshot.lastSelectedMarketTs ?? nowTs
          : this.persistedPolymarketSnapshot.discoveredAtTs,
      lastDiscoverySuccessTs: lastDiscoverySuccessTs > 0 ? lastDiscoverySuccessTs : null,
      lastSelectedMarketTs:
        hasRenderableSelection
          ? this.persistedPolymarketSnapshot.lastSelectedMarketTs ?? nowTs
          : this.persistedPolymarketSnapshot.lastSelectedMarketTs,
      currentBtcMid:
        Number.isFinite(Number(this.latestPolymarketSnapshot?.fastMid)) && Number(this.latestPolymarketSnapshot?.fastMid) > 0
          ? Number(this.latestPolymarketSnapshot?.fastMid)
          : this.persistedPolymarketSnapshot.currentBtcMid,
      statusLine: null
    };
    snapshot.pollMode = this.getLivePollMode(snapshot, nowTs);
    snapshot.statusLine = this.buildPersistedPolymarketStatusLine(snapshot);
    return snapshot;
  }

  private updatePersistedPolymarketSnapshotFromTick(line: TickLogLine, tickTs: number): void {
    const tickBucket = this.getFreshBtc5mWallClockBucket(tickTs);
    if (
      this.checkTickBucketContextMismatch({
        tickContext: {
          tickNowMs: tickTs,
          tickNowSec: tickBucket.nowSec,
          currentBucketStartSec: tickBucket.currentBucketStartSec,
          prevBucketStartSec: tickBucket.currentBucketStartSec - FIVE_MIN_SEC,
          nextBucketStartSec: tickBucket.currentBucketStartSec + FIVE_MIN_SEC,
          currentBucketSlug: tickBucket.currentSlug,
          prevBucketSlug: tickBucket.prevSlug,
          nextBucketSlug: tickBucket.nextSlug,
          remainingSec: tickBucket.remainingSec,
          bucket: tickBucket
        },
        observedCurrentBucketSlug: line.currentBucketSlug,
        observedNextBucketSlug: line.nextBucketSlug,
        phase: "persisted_snapshot_from_tick",
        selectionCommitTs: this.persistedPolymarketSnapshot.selectionCommitTs,
        selectedSlug: line.selectedSlug ?? null,
        remainingSec:
          Number.isFinite(Number(line.tauSec)) && Number(line.tauSec) >= 0 ? Math.floor(Number(line.tauSec)) : null
      })
    ) {
      line.selectedSlug = null;
      line.currentMarketId = null;
      line.selectedTokenId = null;
      line.selectedBookable = false;
      line.selectedTradable = false;
      line.selectionSource = null;
      line.selectedFrom = null;
      line.liveValidationReason = "BUCKET_CONTEXT_MISMATCH";
    }
    const action = this.getTickActionRoot(line.action) as "OPEN" | "CLOSE" | "RESOLVE" | "HOLD";
    const explicitSelectedSlug = line.selectedSlug || line.currentMarketId || null;
    const explicitWindowEndTs =
      Number.isFinite(Number(line.windowEnd)) && Number(line.windowEnd) > 0 ? Number(line.windowEnd) : null;
    const explicitWindowStartTs =
      Number.isFinite(Number(line.windowStart)) && Number(line.windowStart) > 0
        ? Number(line.windowStart)
        : explicitSelectedSlug && parseBtc5mWindowStartSec(explicitSelectedSlug) !== null
          ? Number(parseBtc5mWindowStartSec(explicitSelectedSlug)) * 1000
          : null;
    const explicitRemainingSec =
      Number.isFinite(Number(line.tauSec)) && Number(line.tauSec) >= 0 ? Math.floor(Number(line.tauSec)) : null;
    const holdReason = normalizeHoldReason(this.deriveCanonicalHoldReason(line) ?? line.holdReason);
    const warningState = String(line.warningState || "").trim().toUpperCase() || null;
    const staleStateFromLine = String(line.staleState || "").trim().toUpperCase();
    const shouldClearSelection =
      !explicitSelectedSlug &&
      !line.currentMarketId &&
      (holdReason === "STARTUP_INCOMPLETE_NO_USABLE_WINDOW" ||
        holdReason === "NO_ACTIVE_BTC5M_MARKET" ||
        (holdReason === "EXPIRED_WINDOW" && this.config.polymarket.mode !== "live"));
    if (shouldClearSelection) {
      this.clearPersistedPolymarketSelection();
    }
    const nextSelectedSlug = explicitSelectedSlug ?? this.persistedPolymarketSnapshot.selectedSlug;
    const nextSelectedMarketId = line.currentMarketId ?? this.persistedPolymarketSnapshot.selectedMarketId;
    const activeSelection = this.getActiveSelectionSnapshot(
      {
        finalCandidatesCount:
          line.finalCandidatesCount ?? this.persistedPolymarketSnapshot.finalCandidatesCount,
        selectedSlug: nextSelectedSlug,
        selectedMarketId: nextSelectedMarketId,
        windowStartTs: explicitWindowStartTs ?? this.persistedPolymarketSnapshot.windowStartTs,
        windowEndTs: explicitWindowEndTs ?? this.persistedPolymarketSnapshot.windowEndTs,
        remainingSec: explicitRemainingSec ?? this.persistedPolymarketSnapshot.remainingSec
      },
      tickTs
    );
    const fallbackSelection = shouldClearSelection
      ? null
      : this.getActiveSelectionSnapshot(
          {
            finalCandidatesCount: this.persistedPolymarketSnapshot.finalCandidatesCount,
            selectedSlug: this.persistedPolymarketSnapshot.selectedSlug,
            selectedMarketId: this.persistedPolymarketSnapshot.selectedMarketId,
            windowStartTs: this.persistedPolymarketSnapshot.windowStartTs,
            windowEndTs: this.persistedPolymarketSnapshot.windowEndTs,
            remainingSec:
              Number(this.persistedPolymarketSnapshot.windowEndTs || 0) > 0
                ? null
                : this.persistedPolymarketSnapshot.remainingSec
          },
          tickTs
        );
    const resolvedSelection =
      activeSelection.selectedSlug || activeSelection.selectedMarketId
        ? activeSelection
        : fallbackSelection && (fallbackSelection.selectedSlug || fallbackSelection.selectedMarketId)
          ? fallbackSelection
          : activeSelection;
    const hasActiveSelection = Boolean(resolvedSelection.selectedSlug || resolvedSelection.selectedMarketId);
    const keepExpiredPendingSelection =
      this.config.polymarket.mode === "live" &&
      !hasActiveSelection &&
      Boolean(this.persistedPolymarketSnapshot.selectedSlug || this.persistedPolymarketSnapshot.selectedMarketId) &&
      !explicitSelectedSlug &&
      !line.currentMarketId &&
      (holdReason === "EXPIRED_WINDOW" ||
        this.persistedPolymarketSnapshot.status === "ROLLOVER_PENDING" ||
        this.persistedPolymarketSnapshot.status === "EXPIRED_PENDING_DISCOVERY");
    const nextDiscoveredAtTs =
      hasActiveSelection &&
      (resolvedSelection.selectedSlug !== this.persistedPolymarketSnapshot.selectedSlug ||
        resolvedSelection.selectedMarketId !== this.persistedPolymarketSnapshot.selectedMarketId)
        ? tickTs
        : this.persistedPolymarketSnapshot.discoveredAtTs;
    const nextMarketExpiresAtTs =
      hasActiveSelection
        ? resolvedSelection.windowEndTs ??
          (resolvedSelection.remainingSec !== null ? tickTs + resolvedSelection.remainingSec * 1000 : null)
        : this.persistedPolymarketSnapshot.marketExpiresAtTs;
    const status =
      this.runtimeStartupState === "STARTING"
        ? "STARTING"
        : holdReason === "SELECTION_NOT_COMMITTED"
          ? "SELECTION_NOT_COMMITTED"
          : holdReason === "NO_ACTIVE_WINDOWS"
            ? "NO_ACTIVE_WINDOWS"
            : holdReason === "EXPIRED_WINDOW"
              ? "EXPIRED_WINDOW"
        : this.runtimeStartupState === "HOLD_NO_ACTIVE_BTC5M_MARKET" && !hasActiveSelection
          ? "NO_ACTIVE_BTC5M_MARKET"
          : warningState
            ? "DEGRADED"
            : "RUNNING";
    this.persistedPolymarketSnapshot = {
      ...this.persistedPolymarketSnapshot,
      status,
      action,
      selectedSlug: hasActiveSelection
        ? resolvedSelection.selectedSlug
        : keepExpiredPendingSelection
          ? this.persistedPolymarketSnapshot.selectedSlug
          : null,
      selectedMarketId: hasActiveSelection
        ? resolvedSelection.selectedMarketId
        : keepExpiredPendingSelection
          ? this.persistedPolymarketSnapshot.selectedMarketId
          : null,
      selectedEpoch:
        hasActiveSelection && resolvedSelection.windowStartTs
          ? Math.floor(resolvedSelection.windowStartTs / 1000)
          : this.persistedPolymarketSnapshot.selectedEpoch,
      windowStartTs: hasActiveSelection
        ? resolvedSelection.windowStartTs
        : keepExpiredPendingSelection
          ? this.persistedPolymarketSnapshot.windowStartTs
          : null,
      windowEndTs: hasActiveSelection
        ? resolvedSelection.windowEndTs
        : keepExpiredPendingSelection
          ? this.persistedPolymarketSnapshot.windowEndTs
          : null,
      remainingSec: hasActiveSelection ? resolvedSelection.remainingSec : keepExpiredPendingSelection ? 0 : null,
      chosenSide:
        line.chosenSide !== undefined
          ? line.chosenSide ?? null
          : hasActiveSelection || keepExpiredPendingSelection
            ? this.persistedPolymarketSnapshot.chosenSide
            : null,
      chosenDirection:
        line.chosenDirection !== undefined
          ? line.chosenDirection ?? null
          : hasActiveSelection || keepExpiredPendingSelection
            ? this.persistedPolymarketSnapshot.chosenDirection
            : null,
      holdCategory:
        action === "HOLD"
          ? line.blockedCategory ??
            (holdReason ? classifyHoldCategory(holdReason) : this.persistedPolymarketSnapshot.holdCategory) ??
            null
          : null,
      strategyAction: this.getTickActionRoot(line.action) || this.persistedPolymarketSnapshot.strategyAction,
      selectedTokenId:
        line.selectedTokenId !== undefined
          ? line.selectedTokenId ?? null
          : hasActiveSelection || keepExpiredPendingSelection
            ? this.persistedPolymarketSnapshot.selectedTokenId
            : null,
      selectedBookable:
        line.selectedBookable !== undefined
          ? Boolean(line.selectedBookable)
          : hasActiveSelection || keepExpiredPendingSelection
            ? Boolean(this.persistedPolymarketSnapshot.selectedBookable)
            : false,
      selectedTradable:
        line.selectedTradable !== undefined
          ? Boolean(line.selectedTradable)
          : hasActiveSelection || keepExpiredPendingSelection
            ? Boolean(this.persistedPolymarketSnapshot.selectedTradable)
            : false,
      discoveredCurrent:
        line.discoveredCurrent !== undefined
          ? Boolean(line.discoveredCurrent)
          : this.persistedPolymarketSnapshot.discoveredCurrent,
      discoveredNext:
        line.discoveredNext !== undefined
          ? Boolean(line.discoveredNext)
          : this.persistedPolymarketSnapshot.discoveredNext,
      selectionSource:
        line.selectionSource !== undefined
          ? line.selectionSource
          : hasActiveSelection || keepExpiredPendingSelection
            ? this.persistedPolymarketSnapshot.selectionSource
            : null,
      selectedFrom:
        line.selectedFrom !== undefined
          ? line.selectedFrom
          : this.persistedPolymarketSnapshot.selectedFrom ??
            (line.selectionSource !== undefined ? line.selectionSource : this.persistedPolymarketSnapshot.selectionSource),
      selectionCommitTs:
        line.selectionCommitTs !== undefined
          ? line.selectionCommitTs
          : this.persistedPolymarketSnapshot.selectionCommitTs,
      liveValidationReason:
        line.liveValidationReason !== undefined
          ? line.liveValidationReason
          : hasActiveSelection || keepExpiredPendingSelection
            ? this.persistedPolymarketSnapshot.liveValidationReason
            : this.persistedPolymarketSnapshot.liveValidationReason,
      lastBookTs:
        line.lastBookTs !== undefined
          ? line.lastBookTs
          : this.persistedPolymarketSnapshot.lastBookTs,
      lastQuoteTs:
        line.lastQuoteTs !== undefined
          ? line.lastQuoteTs
          : this.persistedPolymarketSnapshot.lastQuoteTs,
      currentBucketSlug:
        line.currentBucketSlug !== undefined ? line.currentBucketSlug : tickBucket.currentSlug,
      nextBucketSlug:
        line.nextBucketSlug !== undefined ? line.nextBucketSlug : tickBucket.nextSlug,
      currentBucketStartSec:
        line.currentBucketStartSec !== undefined ? line.currentBucketStartSec : tickBucket.currentBucketStartSec,
      selectedWindowStartSec:
        hasActiveSelection
          ? resolvedSelection.windowStartTs !== null
            ? Math.floor(Number(resolvedSelection.windowStartTs) / 1000)
            : this.persistedPolymarketSnapshot.selectedWindowStartSec
          : keepExpiredPendingSelection
            ? this.persistedPolymarketSnapshot.selectedWindowStartSec
            : null,
      selectedWindowEndSec:
        hasActiveSelection
          ? resolvedSelection.windowEndTs !== null
            ? Math.floor(Number(resolvedSelection.windowEndTs) / 1000)
            : this.persistedPolymarketSnapshot.selectedWindowEndSec
          : keepExpiredPendingSelection
            ? this.persistedPolymarketSnapshot.selectedWindowEndSec
            : null,
      candidateRefreshed:
        line.candidateRefreshed !== undefined
          ? Boolean(line.candidateRefreshed)
          : this.persistedPolymarketSnapshot.candidateRefreshed,
      lastPreorderValidationReason:
        line.holdDetailReason !== undefined &&
        String(line.holdDetailReason || "").trim().toUpperCase().startsWith("PREORDER_")
          ? String(line.holdDetailReason || "").trim().toUpperCase()
          : this.persistedPolymarketSnapshot.lastPreorderValidationReason,
      holdReason:
        action === "HOLD"
          ? keepExpiredPendingSelection
            ? "AWAITING_NEXT_MARKET_DISCOVERY"
            : holdReason
          : null,
      executionBlockedReason:
        action === "HOLD"
          ? normalizeHoldReason(
              line.blockedBy ||
                line.holdDetailReason ||
                this.persistedPolymarketSnapshot.executionBlockedReason
            )
          : null,
      warningState,
      dynamicThresholdMetric:
        line.threshold !== undefined && Number.isFinite(Number(line.threshold))
          ? Number(line.threshold)
          : this.persistedPolymarketSnapshot.dynamicThresholdMetric,
      finalCandidatesCount:
        line.finalCandidatesCount !== undefined
          ? Math.max(0, Math.floor(Number(line.finalCandidatesCount || 0)))
          : this.persistedPolymarketSnapshot.finalCandidatesCount,
      discoveredCandidatesCount:
        line.fetchedCount !== undefined
          ? Math.max(0, Math.floor(Number(line.fetchedCount || 0)))
          : this.persistedPolymarketSnapshot.discoveredCandidatesCount,
      windowsCount:
        line.afterWindowCount !== undefined
          ? Math.max(0, Math.floor(Number(line.afterWindowCount || 0)))
          : this.persistedPolymarketSnapshot.windowsCount,
      discoveredAtTs:
        hasActiveSelection
          ? nextDiscoveredAtTs ?? tickTs
          : this.persistedPolymarketSnapshot.discoveredAtTs,
      marketExpiresAtTs:
        hasActiveSelection
          ? nextMarketExpiresAtTs
          : keepExpiredPendingSelection
            ? this.persistedPolymarketSnapshot.marketExpiresAtTs ?? this.persistedPolymarketSnapshot.windowEndTs
            : this.persistedPolymarketSnapshot.marketExpiresAtTs,
      lastDiscoverySuccessTs:
        (Number(line.afterWindowCount || 0) > 0 || hasActiveSelection)
          ? tickTs
          : this.persistedPolymarketSnapshot.lastDiscoverySuccessTs,
      lastDecisionTs:
        hasActiveSelection || action === "HOLD"
          ? tickTs
          : this.persistedPolymarketSnapshot.lastDecisionTs,
      lastSelectedMarketTs:
        hasActiveSelection
          ? tickTs
          : this.persistedPolymarketSnapshot.lastSelectedMarketTs,
      currentBtcMid:
        Number.isFinite(Number(this.latestPolymarketSnapshot?.fastMid)) && Number(this.latestPolymarketSnapshot?.fastMid) > 0
          ? Number(this.latestPolymarketSnapshot?.fastMid)
          : Number.isFinite(Number(line.oracleEst)) && Number(line.oracleEst) > 0
            ? Number(line.oracleEst)
            : this.persistedPolymarketSnapshot.currentBtcMid,
      staleState:
        staleStateFromLine === "ACTIVE_MARKET_REFRESH_FAILED" || staleStateFromLine === "ACTIVE_MARKET_PRICE_STALE"
          ? (staleStateFromLine as PersistedPolymarketSnapshot["staleState"])
          : null,
      statusLine: null
    };
    this.persistedPolymarketSnapshot = this.getPersistedPolymarketSnapshot(tickTs);
  }

  private logStartupWatchdog(params: {
    tickTs: number;
    line: TickLogLine;
    warningState: string;
    blockers: string[];
    fetchedCount: number;
    afterWindowCount: number;
    finalCandidatesCount: number;
    priorDiscoverySucceededRecently: boolean;
    cachedUsableSelection: { selectedSlug: string | null; remainingSec: number | null } | null;
  }): void {
    if (this.config.polymarket.mode !== "live" || this.runtimeStartupState !== "STARTING") {
      return;
    }
    const signature = JSON.stringify({
      blockers: params.blockers,
      selectedSlug: params.line.selectedSlug ?? null,
      tauSec: params.line.tauSec ?? null,
      fetchedCount: params.fetchedCount,
      afterWindowCount: params.afterWindowCount,
      finalCandidatesCount: params.finalCandidatesCount,
      warningState: params.warningState || null,
      holdReason: params.line.holdReason ?? null,
      holdDetailReason: params.line.holdDetailReason ?? null,
      priorDiscoverySucceededRecently: params.priorDiscoverySucceededRecently,
      cachedSelectedSlug: params.cachedUsableSelection?.selectedSlug ?? null
    });
    if (
      signature === this.runtimeStartupWatchdogLastSignature &&
      params.tickTs - this.runtimeStartupWatchdogLastLogTs < 15_000
    ) {
      return;
    }
    this.runtimeStartupWatchdogLastLogTs = params.tickTs;
    this.runtimeStartupWatchdogLastSignature = signature;
    this.logger.warn(
      {
        blockers: params.blockers,
        selectedSlug: params.line.selectedSlug ?? null,
        tauSec: params.line.tauSec ?? null,
        warningState: params.warningState || null,
        fetchedCount: params.fetchedCount,
        afterWindowCount: params.afterWindowCount,
        finalCandidatesCount: params.finalCandidatesCount,
        lastFetchAttemptTs: params.line.lastFetchAttemptTs ?? this.polyState.lastFetchAttemptTs,
        lastFetchOkTs: params.line.lastFetchOkTs ?? this.polyState.lastFetchOkTs,
        holdReason: params.line.holdReason ?? null,
        holdDetailReason: params.line.holdDetailReason ?? null,
        dominantReject: params.line.dominantReject ?? null,
        priorDiscoverySucceededRecently: params.priorDiscoverySucceededRecently,
        cachedSelectedSlug: params.cachedUsableSelection?.selectedSlug ?? null,
        cachedRemainingSec: params.cachedUsableSelection?.remainingSec ?? null
      },
      "POLY_STARTUP_WATCHDOG"
    );
  }

  private updateRuntimeStartupStateFromTick(line: TickLogLine, tickTs: number): void {
    const hasSelection = Boolean(line.selectedSlug || line.currentMarketId);
    const usableSelection =
      hasSelection && Number.isFinite(Number(line.tauSec)) && Number(line.tauSec) > 0;
    const cachedUsableSelection = this.getCachedUsableLiveSelection(tickTs);
    const fetchedCount = Number(line.fetchedCount ?? this.polyState.fetchedCount ?? 0);
    const afterWindowCount = Number(line.afterWindowCount ?? this.polyState.afterWindowCount ?? 0);
    const finalCandidatesCount = Number(line.finalCandidatesCount ?? this.polyState.finalCandidatesCount ?? 0);
    const partialDiscovery = fetchedCount > 0 || afterWindowCount > 0 || finalCandidatesCount > 0;
    const lastFetchOkTs = Number(line.lastFetchOkTs ?? this.polyState.lastFetchOkTs ?? 0);
    const priorDiscoverySucceededRecently = lastFetchOkTs > 0 && tickTs - lastFetchOkTs <= 60_000;
    const discoveryAttempted = Number(line.lastFetchAttemptTs ?? this.polyState.lastFetchAttemptTs ?? 0) > 0;
    const warningState = String(line.warningState ?? this.runtimeWarningState ?? "").trim().toUpperCase();
    const holdReason = normalizeHoldReason(line.holdReason || "");
    const holdDetailReason = normalizeHoldReason(line.holdDetailReason || line.dominantReject || "");
    const degraded =
      warningState === "NETWORK_ERROR" ||
      partialDiscovery ||
      priorDiscoverySucceededRecently ||
      Boolean(cachedUsableSelection);

    if (!usableSelection) {
      const blockers: string[] = [];
      if (!hasSelection) blockers.push("NO_SELECTED_WINDOW");
      if (!(Number(line.tauSec ?? 0) > 0)) blockers.push("NO_POSITIVE_REMAINING_SEC");
      if (fetchedCount <= 0) blockers.push("NO_DISCOVERED_CANDIDATES");
      if (afterWindowCount <= 0) blockers.push("NO_ACTIVE_WINDOWS");
      if (finalCandidatesCount <= 0) blockers.push("NO_FINAL_CANDIDATES");
      if (!priorDiscoverySucceededRecently) blockers.push("NO_RECENT_DISCOVERY_SUCCESS");
      if (!cachedUsableSelection) blockers.push("NO_CACHED_USABLE_SELECTION");
      this.logStartupWatchdog({
        tickTs,
        line,
        warningState,
        blockers,
        fetchedCount,
        afterWindowCount,
        finalCandidatesCount,
        priorDiscoverySucceededRecently,
        cachedUsableSelection
      });
    }

    if (usableSelection) {
      this.transitionRuntimeStartupState(
        degraded ? "RUNNING_DEGRADED" : "RUNNING",
        degraded ? "USABLE_SELECTION_DEGRADED" : "USABLE_SELECTION",
        tickTs,
        {
          selectedSlug: line.selectedSlug ?? null,
          tauSec: line.tauSec ?? null,
          warningState: warningState || null,
          fetchedCount,
          afterWindowCount,
          finalCandidatesCount
        }
      );
      return;
    }

    if (partialDiscovery || priorDiscoverySucceededRecently || cachedUsableSelection) {
      this.transitionRuntimeStartupState(
        "RUNNING_DEGRADED",
        cachedUsableSelection
          ? "CACHED_USABLE_SELECTION"
          : priorDiscoverySucceededRecently
            ? "RECENT_DISCOVERY_SUCCESS"
            : "PARTIAL_DISCOVERY_SUCCESS",
        tickTs,
        {
          warningState: warningState || null,
          fetchedCount,
          afterWindowCount,
          finalCandidatesCount,
          cachedSelectedSlug: cachedUsableSelection?.selectedSlug ?? null
        }
      );
      return;
    }

    if (
      holdReason === "NO_ACTIVE_BTC5M_MARKET" ||
      holdReason === "STARTUP_INCOMPLETE_NO_USABLE_WINDOW" ||
      holdReason === "NO_WINDOWS" ||
      holdReason === "NO_ACTIVE_WINDOWS" ||
      holdReason === "SELECTION_NOT_COMMITTED" ||
      holdReason === "NO_CANDIDATES" ||
      holdReason === "NO_DATA" ||
      holdDetailReason === "BTC5M_NOT_FOUND" ||
      holdDetailReason === "MISSING_YES_ORDERBOOK" ||
      holdDetailReason === "MISSING_NO_ORDERBOOK"
    ) {
      this.transitionRuntimeStartupState(
        "HOLD_NO_ACTIVE_BTC5M_MARKET",
        "STARTUP_INCOMPLETE_NO_USABLE_WINDOW",
        tickTs,
        {
          warningState: warningState || null,
          fetchedCount,
          afterWindowCount,
          finalCandidatesCount,
          dominantReject: line.dominantReject ?? null
        }
      );
      return;
    }

    if (discoveryAttempted) {
      this.transitionRuntimeStartupState(
        "HOLD_NO_ACTIVE_BTC5M_MARKET",
        holdReason === "STARTUP_INCOMPLETE_NO_USABLE_WINDOW"
          ? "STARTUP_INCOMPLETE_NO_USABLE_WINDOW"
          : "NO_ACTIVE_BTC5M_MARKET",
        tickTs,
        {
          warningState: warningState || null,
          fetchedCount,
          afterWindowCount,
          finalCandidatesCount,
          dominantReject: line.dominantReject ?? null,
          holdReason: holdReason || null,
          holdDetailReason: holdDetailReason || null
        }
      );
      return;
    }

    if (this.runtimeStartupState !== "STARTING" && !line.tradingPaused) {
      this.transitionRuntimeStartupState("RUNNING", "POST_STARTUP_HEALTHY_TICK", tickTs, {
        warningState: warningState || null
      });
    }
  }

  private getTruthSelectionSnapshot(nowTs: number): {
    finalCandidatesCount: number | null;
    selectedSlug: string | null;
    selectedMarketId: string | null;
    windowStartTs: number | null;
    windowEndTs: number | null;
    remainingSec: number | null;
  } {
    const snapshot = this.getPersistedPolymarketSnapshot(nowTs);
    const hasActiveSelection = Boolean(snapshot.selectedSlug || snapshot.selectedMarketId);
    if (!hasActiveSelection) {
      const fallbackSelection = this.getActiveSelectionSnapshot(
        {
          finalCandidatesCount:
            snapshot.finalCandidatesCount ?? this.truthSelection.finalCandidatesCount ?? null,
          selectedSlug: this.truthSelection.selectedSlug,
          selectedMarketId: this.truthSelection.selectedMarketId,
          windowStartTs: this.truthSelection.windowStartTs,
          windowEndTs: this.truthSelection.windowEndTs,
          remainingSec: this.truthSelection.remainingSec
        },
        nowTs
      );
      if (fallbackSelection.selectedSlug || fallbackSelection.selectedMarketId) {
        return {
          finalCandidatesCount:
            snapshot.finalCandidatesCount ?? this.truthSelection.finalCandidatesCount ?? null,
          selectedSlug: fallbackSelection.selectedSlug,
          selectedMarketId: fallbackSelection.selectedMarketId,
          windowStartTs: fallbackSelection.windowStartTs,
          windowEndTs: fallbackSelection.windowEndTs,
          remainingSec: fallbackSelection.remainingSec
        };
      }
    }
    return {
      finalCandidatesCount: snapshot.finalCandidatesCount,
      selectedSlug: hasActiveSelection ? snapshot.selectedSlug : null,
      selectedMarketId: hasActiveSelection ? snapshot.selectedMarketId : null,
      windowStartTs: hasActiveSelection ? snapshot.windowStartTs : null,
      windowEndTs: hasActiveSelection ? snapshot.windowEndTs : null,
      remainingSec: hasActiveSelection ? snapshot.remainingSec : null
    };
  }

  private getLiveSelectionDirectionHint(selectionSnapshot: {
    selectedSlug: string | null;
    selectedMarketId: string | null;
  }, nowTs: number): string | null {
    if (this.config.polymarket.mode !== "live") return null;
    const committedSelection = this.getActiveLiveCommittedSelection(nowTs);
    if (committedSelection) {
      const matchesCommitted =
        (selectionSnapshot.selectedMarketId &&
          selectionSnapshot.selectedMarketId === committedSelection.selectedMarketId) ||
        (selectionSnapshot.selectedSlug &&
          selectionSnapshot.selectedSlug === committedSelection.selectedSlug);
      if (matchesCommitted && committedSelection.chosenDirection) {
        return committedSelection.chosenDirection;
      }
    }
    const cached = this.lastUsableLiveSelectedMarket;
    if (cached) {
      const matchesSelection =
        (selectionSnapshot.selectedMarketId &&
          selectionSnapshot.selectedMarketId === (cached.marketId || null)) ||
        (selectionSnapshot.selectedSlug &&
          selectionSnapshot.selectedSlug === (cached.eventSlug || cached.slug || null));
      if (matchesSelection) {
        return normalizeDirectionalDisplayLabel(cached.yesDisplayLabel, cached.question, "YES");
      }
    }
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(nowTs);
    if (
      persistedSnapshot.selectedSlug &&
      persistedSnapshot.selectedSlug === selectionSnapshot.selectedSlug &&
      persistedSnapshot.chosenDirection
    ) {
      return persistedSnapshot.chosenDirection;
    }
    return parseBtc5mWindowStartSec(selectionSnapshot.selectedSlug) !== null ? "UP" : null;
  }

  private getLiveSelectionSideHint(selectionSnapshot: {
    selectedSlug: string | null;
    selectedMarketId: string | null;
  }, nowTs: number): "YES" | "NO" | null {
    if (this.config.polymarket.mode !== "live") return null;
    const committedSelection = this.getActiveLiveCommittedSelection(nowTs);
    if (committedSelection) {
      const matchesCommitted =
        (selectionSnapshot.selectedMarketId &&
          selectionSnapshot.selectedMarketId === committedSelection.selectedMarketId) ||
        (selectionSnapshot.selectedSlug &&
          selectionSnapshot.selectedSlug === committedSelection.selectedSlug);
      if (matchesCommitted) {
        return committedSelection.chosenSide;
      }
    }
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(nowTs);
    if (
      persistedSnapshot.selectedSlug &&
      persistedSnapshot.selectedSlug === selectionSnapshot.selectedSlug
    ) {
      return persistedSnapshot.chosenSide;
    }
    return null;
  }

  private getActiveSelectionSnapshot(
    input: {
      finalCandidatesCount: number | null;
      selectedSlug: string | null;
      selectedMarketId: string | null;
      windowStartTs: number | null;
      windowEndTs: number | null;
      remainingSec?: number | null;
    },
    nowTs: number
  ): {
    finalCandidatesCount: number | null;
    selectedSlug: string | null;
    selectedMarketId: string | null;
    windowStartTs: number | null;
    windowEndTs: number | null;
    remainingSec: number | null;
  } {
    const selectedSlug = input.selectedSlug ?? null;
    const selectedMarketId = input.selectedMarketId ?? null;
    const slugStartSec = this.isDeterministicBtc5mMode()
      ? parseBtc5mWindowStartSec(selectedSlug)
      : null;
    const explicitRemainingSec =
      input.remainingSec !== null &&
      input.remainingSec !== undefined &&
      Number.isFinite(Number(input.remainingSec)) &&
      Number(input.remainingSec) >= 0
        ? Math.floor(Number(input.remainingSec))
        : null;
    const windowEndTs =
      slugStartSec !== null
        ? (slugStartSec + FIVE_MIN_SEC) * 1000
        : Number(input.windowEndTs || 0) > 0
          ? Number(input.windowEndTs)
          : explicitRemainingSec !== null
            ? nowTs + explicitRemainingSec * 1000
            : null;
    const windowStartTs =
      slugStartSec !== null
        ? slugStartSec * 1000
        : Number(input.windowStartTs || 0) > 0
          ? Number(input.windowStartTs)
          : windowEndTs !== null
            ? Math.max(0, windowEndTs - FIVE_MIN_SEC * 1000)
            : null;
    const hasTrackedSelection = Boolean(selectedSlug || selectedMarketId);
    const remainingSec =
      explicitRemainingSec !== null
        ? explicitRemainingSec
        : hasTrackedSelection && windowEndTs !== null
          ? Math.max(0, Math.floor((windowEndTs - nowTs) / 1000))
          : null;
    if (!hasTrackedSelection || windowEndTs === null || remainingSec === null || remainingSec <= 0) {
      return {
        finalCandidatesCount: input.finalCandidatesCount,
        selectedSlug: null,
        selectedMarketId: null,
        windowStartTs: null,
        windowEndTs: null,
        remainingSec: null
      };
    }
    if (this.isDeterministicBtc5mMode()) {
      const selectionStartSec =
        (windowStartTs !== null ? Math.floor(windowStartTs / 1000) : null) ??
        parseBtc5mWindowStartSec(selectedSlug);
      const activeCadenceStartSec =
        this.config.polymarket.mode === "live"
          ? this.getFreshBtc5mWallClockBucket(nowTs).bucketStartSec
          : windowTs(nowTs);
      // Selection validation is candidate-based; in live mode allow current or next cadence.
      const allowedCadenceStarts =
        this.config.polymarket.mode === "live"
          ? new Set([activeCadenceStartSec, activeCadenceStartSec + FIVE_MIN_SEC])
          : new Set([activeCadenceStartSec]);
      if (selectionStartSec !== null && !allowedCadenceStarts.has(selectionStartSec)) {
        return {
          finalCandidatesCount: input.finalCandidatesCount,
          selectedSlug: null,
          selectedMarketId: null,
          windowStartTs: null,
          windowEndTs: null,
          remainingSec: null
        };
      }
    }
    return {
      finalCandidatesCount: input.finalCandidatesCount,
      selectedSlug,
      selectedMarketId,
      windowStartTs,
      windowEndTs,
      remainingSec
    };
  }

  private clearInactiveSelectionState(): void {
    if (this.config.polymarket.mode === "live") {
      this.getActiveLiveCommittedSelection(Date.now());
    }
    this.polyState.selectedSlug = null;
    this.polyState.selectedMarketId = null;
    this.truthSelection = {
      ...this.truthSelection,
      selectedSlug: null,
      selectedMarketId: null,
      windowStartTs: null,
      windowEndTs: null,
      remainingSec: null
    };
    this.truthChosenSide = null;
    this.truthChosenDirection = null;
    this.truthEntriesInWindow = null;
    this.truthWindowRealizedPnlUsd = null;
    this.truthResolutionSource = null;
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

  // Shared paper/live parity notes:
  // - Paper selected side from net edge after costs, with a pUpModel tiebreaker.
  // - Live had drifted by re-choosing side differently and hard-blocking on NON_EXTREME_PRICE / MODEL_NOT_EXTREME
  //   before the paper edge model could act.
  // - This helper restores one shared decision result; live only adds execution/infrastructure blockers afterwards.
  private evaluateSharedPolymarketDecision(params: {
    market: BtcWindowMarket;
    decision: StrategyDecision;
    pUpModel: number;
    pBoosted: number;
    tauSec: number;
    oracleEst: number;
    oracleState: string;
    allowOracleStale: boolean;
    yesEntryPrice: number;
    noEntryPrice: number;
    strategyThreshold: number;
    minEdgeThreshold: number;
    minNetEdgeThreshold: number;
    decisionFeeBps: number;
    decisionSlippageBps: number;
    forceTrade: boolean;
  }): SharedDecisionEvaluation {
    const costPenaltyProb =
      Math.max(0, params.decisionFeeBps + params.decisionSlippageBps) / 10_000 +
      Math.max(0, params.decision.spread) / 2;
    const edgeYes = params.pUpModel - params.yesEntryPrice;
    const edgeNo = (1 - params.pUpModel) - params.noEntryPrice;
    const netEdgeYes = edgeYes - costPenaltyProb;
    const netEdgeNo = edgeNo - costPenaltyProb;
    const sideChoice = this.choosePaperEntrySide({
      netEdgeYes,
      netEdgeNo,
      pUpModel: params.pUpModel
    });
    const chosenSide = sideChoice.chosenSide;
    const chosenDirection =
      chosenSide === null
        ? null
        : normalizeDirectionalDisplayLabel(params.market.yesDisplayLabel, params.market.question, chosenSide);
    const chosenEdge = chosenSide === "YES" ? edgeYes : chosenSide === "NO" ? edgeNo : 0;
    const signedEdge = chosenSide === "YES" ? edgeYes : chosenSide === "NO" ? -edgeNo : 0;
    const netEdgeAfterCosts =
      chosenSide === "YES" ? netEdgeYes : chosenSide === "NO" ? netEdgeNo : Number.NEGATIVE_INFINITY;
    const chosenAsk =
      chosenSide === "YES" ? params.yesEntryPrice : chosenSide === "NO" ? params.noEntryPrice : 0;
    const stalenessEdge = this.computeStalenessEdge(
      params.market.marketId,
      params.decision.yesMid,
      params.oracleEst,
      Date.now()
    );
    const conviction = clamp(Math.abs(params.pUpModel - params.decision.yesMid) + stalenessEdge, 0, 0.9999);
    const isExtremePrice =
      chosenSide !== null &&
      (chosenAsk <= this.config.polymarket.paper.extremeLowPrice ||
        chosenAsk >= this.config.polymarket.paper.extremeHighPrice);
    const hasExtremeModel =
      chosenSide === "YES"
        ? params.pBoosted >= this.config.polymarket.paper.probExtreme
        : chosenSide === "NO"
          ? params.pBoosted <= 1 - this.config.polymarket.paper.probExtreme
          : false;
    const requiredNetEdge = params.forceTrade
      ? Number.NEGATIVE_INFINITY
      : Math.max(
          params.minNetEdgeThreshold,
          params.minEdgeThreshold,
          params.strategyThreshold
        );

    let dataHealthBlock: string | null = null;
    if (
      params.oracleState !== "OK" &&
      !(params.oracleState === "ORACLE_STALE" && params.allowOracleStale)
    ) {
      dataHealthBlock = normalizeHoldReason(params.oracleState) || "ORACLE_UNAVAILABLE";
    }

    let strategyBlock: string | null = null;
    let strategyBlockDetail: string | null = null;
    if (params.tauSec <= 0) {
      strategyBlock = "EXPIRED_WINDOW";
      strategyBlockDetail = strategyBlock;
    } else if (
      params.tauSec < this.config.polymarket.paper.entryMinRemainingSec ||
      params.tauSec > this.config.polymarket.paper.entryMaxRemainingSec ||
      params.tauSec < this.config.polymarket.risk.noNewOrdersInLastSec
    ) {
      strategyBlock = "TOO_LATE_FOR_ENTRY";
      strategyBlockDetail = strategyBlock;
    } else if (!chosenSide) {
      strategyBlock = "EDGE_BELOW_THRESHOLD";
      strategyBlockDetail = sideChoice.chooserReason;
    } else if (
      this.config.polymarket.paper.requireExtremeGuardrail &&
      !isExtremePrice
    ) {
      strategyBlock = "NON_EXTREME_PRICE";
      strategyBlockDetail = strategyBlock;
    } else if (
      this.config.polymarket.paper.requireExtremeGuardrail &&
      !hasExtremeModel
    ) {
      strategyBlock = "MODEL_NOT_EXTREME";
      strategyBlockDetail = strategyBlock;
    } else if (!(netEdgeAfterCosts > requiredNetEdge)) {
      strategyBlock = "EDGE_BELOW_THRESHOLD";
      strategyBlockDetail = strategyBlock;
    }

    const blockedCategory =
      dataHealthBlock !== null ? "DATA_HEALTH" : strategyBlock !== null ? "STRATEGY" : null;
    const blockedBy = dataHealthBlock ?? strategyBlock ?? null;
    const paperWouldTrade = chosenSide !== null && blockedBy === null;

    return {
      chooserReason: sideChoice.chooserReason,
      chosenSide,
      chosenDirection,
      chosenEdge,
      signedEdge,
      chosenAsk,
      score: netEdgeAfterCosts,
      costPenaltyProb,
      edgeYes,
      edgeNo,
      netEdgeYes,
      netEdgeNo,
      netEdgeAfterCosts,
      stalenessEdge,
      conviction,
      isExtremePrice,
      hasExtremeModel,
      requiredNetEdge,
      strategyBlock,
      strategyBlockDetail,
      dataHealthBlock,
      holdReason: blockedBy,
      blockedBy,
      blockedCategory,
      paperWouldTrade,
      action: paperWouldTrade && chosenSide === "NO" ? "BUY_NO" : paperWouldTrade ? "BUY_YES" : "HOLD"
    };
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
      const waitMs = Math.max(25, this.getLoopWaitMs() - elapsed);
      await sleep(waitMs);
    }
  }

  private getLoopWaitMs(nowTs = Date.now()): number {
    const configuredLoopMs = Math.max(25, this.config.polymarket.loopMs);
    const liveDeterministic = this.config.polymarket.mode === "live" && this.isDeterministicBtc5mMode();
    const baseLoopMs = liveDeterministic ? Math.min(configuredLoopMs, 2_000) : configuredLoopMs;
    if (!liveDeterministic) {
      return baseLoopMs;
    }
    const snapshot = this.getPersistedPolymarketSnapshot(nowTs);
    const remainingSec =
      Number.isFinite(Number(snapshot.remainingSec)) && Number(snapshot.remainingSec) >= 0
        ? Math.floor(Number(snapshot.remainingSec))
        : null;
    if (snapshot.status === "ROLLOVER_PENDING" || snapshot.status === "EXPIRED_PENDING_DISCOVERY") {
      return Math.min(baseLoopMs, this.config.polymarket.live.veryFastPollMs);
    }
    if (remainingSec !== null && remainingSec <= 5) {
      return Math.min(baseLoopMs, this.config.polymarket.live.veryFastPollMs);
    }
    switch (snapshot.pollMode) {
      case "VERY_FAST":
      case "FAST_DISCOVERY_NEXT":
        return Math.min(baseLoopMs, this.config.polymarket.live.veryFastPollMs);
      case "FAST":
      case "EXPIRING":
      case "DISCOVERY_STALE":
        return Math.min(baseLoopMs, this.config.polymarket.live.fastPollMs);
      case "LOCKED_ON_WINDOW":
        return Math.min(baseLoopMs, this.config.polymarket.live.fastPollMs);
      default:
        return baseLoopMs;
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
        const lookup = await this.directSlugResolver.lookupBySlugs([slug]);
        raw = lookup.rows.find((candidate) => rowMatchesBtc5mSlug(candidate.row, slug))?.row ?? null;
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

  private getDeterministicBtc5mSlugCandidates(
    currentBucket: Btc5mWallClockBucket = this.getFreshBtc5mWallClockBucket()
  ): string[] {
    return Array.from(new Set([currentBucket.currentSlug, currentBucket.nextSlug, currentBucket.prevSlug]));
  }

  private async resolveDeterministicBtc5mLiveMarket(nowTs: number, tickContext: Btc5mTickContext): Promise<{
    selectedMarket: BtcWindowMarket | null;
    selectedSlug: string | null;
    selectedWindowStart: number | null;
    selectedWindowEnd: number | null;
    selectedAcceptingOrders: boolean | null;
    selectedEnableOrderBook: boolean | null;
    selectedTokenId: string | null;
    chosenSide: "YES" | "NO" | null;
    chosenDirection: string | null;
    selectedBookable: boolean;
    selectedTradable: boolean;
    discoveredCurrent: boolean;
    discoveredNext: boolean;
    selectionSource: Btc5mSelectionSource | null;
    liveValidationReason: string | null;
    lastBookTs: number | null;
    lastQuoteTs: number | null;
    currentBucketSlug: string;
    nextBucketSlug: string;
    currentBucketStartSec: number;
    selectedReason: string | null;
    dominantReject: string | null;
    stageCounts: {
      fetchedCount: number;
      afterActiveCount: number;
      afterSearchCount: number;
      afterWindowCount: number;
      afterPatternCount: number;
      finalCandidatesCount: number;
    };
    attemptedSlugs: string[];
    fallbackUsed: "none" | "window" | "patterns" | "topActive";
  }> {
    const currentBucket = tickContext.bucket;
    const rolloverDemotion = this.demotePreviousCadenceLiveSelection(nowTs, currentBucket);
    this.logExpectedCurrentBtc5mSlug(rolloverDemotion.previousSelectedSlug, currentBucket);
    const attemptedSlugs = this.getDeterministicBtc5mSlugCandidates(currentBucket);
    if (this.debugPoly) {
      this.logger.info(
        {
          buckets: deriveBtc5mBuckets(nowTs),
          nowSec: currentBucket.nowSec,
          currentBucketStartSec: currentBucket.currentBucketStartSec,
          currentBucketSlug: currentBucket.currentSlug,
          nextBucketSlug: currentBucket.nextSlug,
          prevBucketSlug: currentBucket.prevSlug,
          attemptedSlugs
        },
        "POLY_BTC5M_DISCOVERY_TICK"
      );
    }
    const activeStartSec = currentBucket.currentBucketStartSec;
    const nextStartSec = currentBucket.currentBucketStartSec + FIVE_MIN_SEC;
    let activeRefreshedSelection:
      | {
          selectedMarket: BtcWindowMarket;
          selectedSlug: string | null;
          selectedReason: string;
          chosenSide: "YES" | "NO";
          chosenDirection: string;
          selectedTokenId: string | null;
          selectedBookable: boolean;
          selectedTradable: boolean;
          selectionSource: Btc5mSelectionSource;
          liveValidationReason: string;
          lastBookTs: number | null;
          lastQuoteTs: number | null;
          prioritizedWindowCount: number;
        }
      | null = null;
    const discoveredRows: Record<string, unknown>[] = [];
    const candidateRows: Array<{ row: Record<string, unknown>; resolvedSlug: string | null; source: string }> = [];
    const seenKeys = new Set<string>();
    let dominantReject: string | null = "BTC5M_NOT_FOUND";
    const cycleUnbookableTokenIds = new Set<string>();
    let discoveredCurrent = false;
    let discoveredNext = false;
    const addCandidateRow = (
      row: Record<string, unknown> | null | undefined,
      source: string,
      resolvedSlug?: string | null
    ): void => {
      if (!row || typeof row !== "object") return;
      const marketId = pickRawString(row, ["id", "market_id", "conditionId", "condition_id"]);
      const slug = pickRawString(row, ["slug", "market_slug", "eventSlug", "event_slug"]);
      const key = `${marketId}::${slug}`.trim();
      if (!key || seenKeys.has(key)) return;
      seenKeys.add(key);
      discoveredRows.push(row);
      candidateRows.push({ row, resolvedSlug: resolvedSlug ?? slug ?? null, source });
    };
    const safeListMarketsPage = async (
      input: Parameters<PolymarketClient["listMarketsPage"]>[0],
      warningSource: string
    ): Promise<Record<string, unknown>[]> => {
      try {
        const page = await this.client.listMarketsPage(input);
        return Array.isArray(page.rows) ? (page.rows as Record<string, unknown>[]) : [];
      } catch (error) {
        this.markReadPathWarning("NETWORK_ERROR");
        this.maybeLogDeterministicDiscoveryDegraded({
          warningSource,
          error,
          details:
            warningSource === "slug_lookup"
              ? { slug: String(input.slug || "") || null }
              : warningSource === "search_lookup"
                ? { search: String(input.search || "") || null }
                : { active: Boolean(input.active) }
        });
        return [];
      }
    };
    const parseCandidates = (
      rows: Array<{ row: Record<string, unknown>; resolvedSlug: string | null; source: string }>
    ): Array<{ market: BtcWindowMarket; source: string; slug: string | null; startSec: number | null }> =>
      rows
        .map(({ row, resolvedSlug, source }) => {
          const rowSlugText = String(
            resolvedSlug || pickRawString(row, ["slug", "market_slug", "eventSlug", "event_slug"]) || ""
          ).trim();
          const windowStartSec = parseBtc5mWindowStartSec(rowSlugText);
          const fallbackWindowEndMs =
            windowStartSec !== null ? (windowStartSec + FIVE_MIN_SEC) * 1000 : nowTs + FIVE_MIN_SEC * 1000;
          const parsed = parseRawMarketToBtcWindow(
            row,
            nowTs,
            fallbackWindowEndMs,
            this.lastOracleSnapshot?.price ?? null
          );
          if (!parsed || !looksLikeBtc5mMarket(parsed)) return null;
          const market = this.applyWindowState(parsed, nowTs);
          const candidateSlug = this.pickDeterministicBtc5mSlug(rowSlugText, market.slug, market.eventSlug);
          const startSec =
            parseBtc5mWindowStartSec(candidateSlug) ??
            (Number.isFinite(Number(market.startTs)) && Number(market.startTs) > 0
              ? Math.floor(Number(market.startTs) / 1000)
              : null);
          return {
            market,
            source,
            slug: candidateSlug,
            startSec
          };
        })
        .filter(
          (
            row
          ): row is { market: BtcWindowMarket; source: string; slug: string | null; startSec: number | null } =>
            row !== null
        );

    const filterEligibleCandidates = (
      parsed: Array<{ market: BtcWindowMarket; source: string; slug: string | null; startSec: number | null }>
    ): {
      eligible: Array<{ market: BtcWindowMarket; source: string; slug: string | null; startSec: number | null }>;
      rejectReasons: string[];
    } => {
      const eligible: Array<{ market: BtcWindowMarket; source: string; slug: string | null; startSec: number | null }> = [];
      const rejectReasons: string[] = [];
      for (const candidate of parsed) {
        const eligibility = this.evaluateDeterministicCandidateEligibility(candidate.market, nowTs);
        if (eligibility.ok) {
          eligible.push(candidate);
        } else {
          rejectReasons.push(eligibility.reason);
        }
      }
      return { eligible, rejectReasons };
    };

    const pickDominantReject = (reasons: string[]): string => {
      if (reasons.includes("EXPIRED_WINDOW")) return "EXPIRED_WINDOW";
      if (reasons.includes("NETWORK_ERROR")) return "NETWORK_ERROR";
      if (reasons.length > 0) return "DIRECT_SLUG_FAILURE";
      return "DIRECT_SLUG_FAILURE";
    };

    const mapDiscoverySelectionSource = (source: Btc5mSelectionSource): Btc5mSelectionSource =>
      source === "fallback_discovery" || source === "FALLBACK_SCAN" ? "FALLBACK_SCAN" : "DIRECT_SLUG";

    const updateDiscoveredBucketFlags = (
      parsed: Array<{ startSec: number | null; slug: string | null }>
    ): void => {
      for (const candidate of parsed) {
        const bucketClass = this.classifyDeterministicWindowFromSlugOrStart(
          candidate.slug,
          candidate.startSec,
          currentBucket
        );
        if (bucketClass === "current") discoveredCurrent = true;
        if (bucketClass === "next") discoveredNext = true;
      }
    };

    const sortCandidatesByRank = (
      rows: Array<{ market: BtcWindowMarket; source: string; slug: string | null; startSec: number | null }>
    ): Array<{ market: BtcWindowMarket; source: string; slug: string | null; startSec: number | null }> =>
      rows
        .slice()
        .sort((a, b) => {
          const aRank = rankDeterministicBtc5mMarket(a.market, activeStartSec, nowTs);
          const bRank = rankDeterministicBtc5mMarket(b.market, activeStartSec, nowTs);
          if (aRank !== bRank) return aRank - bRank;
          return String(a.market.marketId).localeCompare(String(b.market.marketId));
        });

    const getCandidateRemainingSec = (candidate: {
      market: BtcWindowMarket;
      slug: string | null;
      startSec: number | null;
    }): number => {
      const canonicalTiming = this.getCanonicalBtc5mTimingFromSlugOrRow({
        slug: candidate.slug,
        rowStartTs: candidate.market.startTs ?? null,
        rowEndTs: candidate.market.endTs ?? null
      });
      const endTs = canonicalTiming.endTs;
      if (!(endTs && endTs > nowTs)) return 0;
      return Math.max(0, Math.floor((endTs - nowTs) / 1000));
    };

    const buildPrioritizedCandidates = (
      parsed: Array<{ market: BtcWindowMarket; source: string; slug: string | null; startSec: number | null }>
    ): Array<{ market: BtcWindowMarket; source: string; slug: string | null; startSec: number | null }> => {
      const currentCandidates = sortCandidatesByRank(
        parsed.filter(
          (row) =>
            this.classifyDeterministicWindowFromSlugOrStart(row.slug, row.startSec, currentBucket) === "current"
        )
      );
      const nextCandidates = sortCandidatesByRank(
        parsed.filter(
          (row) =>
            this.classifyDeterministicWindowFromSlugOrStart(row.slug, row.startSec, currentBucket) === "next"
        )
      );

      // Prefer current when still inside entry threshold, otherwise promote next.
      const hasCurrentAboveThreshold = currentCandidates.some(
        (row) => getCandidateRemainingSec(row) >= this.getLiveEntryMinRemainingSec()
      );
      return hasCurrentAboveThreshold
        ? [...currentCandidates, ...nextCandidates]
        : [...nextCandidates, ...currentCandidates];
    };

    const pickTradableCandidate = async (
      parsed: Array<{ market: BtcWindowMarket; source: string; slug: string | null; startSec: number | null }>,
      sourceLabel: "current_slug" | "next_slug" | "fallback_discovery"
    ): Promise<{
      selectedMarket: BtcWindowMarket;
      selectedSlug: string | null;
      selectedReason: string;
      chosenSide: "YES" | "NO";
      chosenDirection: string;
      selectedTokenId: string | null;
      selectedBookable: boolean;
      selectedTradable: boolean;
      selectionSource: Btc5mSelectionSource;
      liveValidationReason: string;
      lastBookTs: number | null;
      lastQuoteTs: number | null;
      prioritizedWindowCount: number;
    } | null> => {
      const prioritized = buildPrioritizedCandidates(parsed);
      const prioritizedWindowCount = prioritized.length > 0 ? 1 : 0;
      if (prioritized.length <= 0) {
        return null;
      }
      for (const candidate of prioritized) {
        const chosenSideHint =
          this.liveCommittedSelection?.chosenSide ??
          this.persistedPolymarketSnapshot.chosenSide ??
          "YES";
        const alternateSide: "YES" | "NO" = chosenSideHint === "YES" ? "NO" : "YES";
        const sideOrder: Array<"YES" | "NO"> = [chosenSideHint, alternateSide];
        const bucketClass = this.classifyDeterministicWindowFromSlugOrStart(
          candidate.slug,
          candidate.startSec,
          currentBucket
        );
        const selectionSource =
          bucketClass === "current" ? "current_slug" : bucketClass === "next" ? "next_slug" : "fallback_discovery";
        for (const side of sideOrder) {
          const candidateTokenId =
            side === "YES"
              ? String(candidate.market.yesTokenId || "").trim() || null
              : String(candidate.market.noTokenId || "").trim() || null;
          if (candidateTokenId && cycleUnbookableTokenIds.has(candidateTokenId)) {
            dominantReject = "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN";
            continue;
          }
          const tradability = await this.validateLiveMarketTradability({
            market: candidate.market,
            chosenSide: side,
            nowTs,
            selectionSource
          });
          if (!tradability.tradable || !tradability.tokenId || !tradability.bookable) {
            dominantReject = tradability.reason;
            if (tradability.reason === "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN") {
              if (tradability.tokenId) {
                cycleUnbookableTokenIds.add(tradability.tokenId);
              }
              this.markReadPathWarning("MISSING_ORDERBOOK_FOR_SELECTED_TOKEN");
            }
            continue;
          }
          return {
            selectedMarket: candidate.market,
            selectedSlug: candidate.slug,
            selectedReason:
              bucketClass === "current"
                ? `btc5m_current_bucket_${candidate.source}`
                : bucketClass === "next"
                  ? `btc5m_next_bucket_${candidate.source}`
                  : `btc5m_previous_bucket_${candidate.source}`,
            chosenSide: side,
            chosenDirection: normalizeDirectionalDisplayLabel(null, null, side),
            selectedTokenId: tradability.tokenId,
            selectedBookable: tradability.bookable,
            selectedTradable: tradability.tradable,
            selectionSource,
            liveValidationReason: tradability.reason,
            lastBookTs: tradability.lastBookTs,
            lastQuoteTs: tradability.lastQuoteTs,
            prioritizedWindowCount
          };
        }
      }
      return null;
    };

    const activeCommittedSelection = this.getActiveLiveCommittedSelection(nowTs);
    if (
      activeCommittedSelection &&
      activeCommittedSelection.selectedSlug &&
      activeCommittedSelection.remainingSec > this.getLiveEntryMinRemainingSec()
    ) {
      const committedSlug = activeCommittedSelection.selectedSlug;
      try {
        const refreshLookup = await this.directSlugResolver.lookupBySlugs([committedSlug]);
        if (refreshLookup.hadNetworkError) {
          this.markReadPathWarning("NETWORK_ERROR");
        }
        const row =
          refreshLookup.rows.find((candidate) => rowMatchesBtc5mSlug(candidate.row, committedSlug))?.row ?? null;
        if (row && rowMatchesBtc5mSlug(row, committedSlug)) {
          addCandidateRow(row as Record<string, unknown>, "active_selected_refresh", committedSlug);
          const parsedActiveCandidates = parseCandidates(
            candidateRows.filter((candidate) => candidate.source === "active_selected_refresh")
          ).filter((candidate) => candidate.startSec === activeStartSec || candidate.startSec === nextStartSec);
          updateDiscoveredBucketFlags(parsedActiveCandidates);
          if (parsedActiveCandidates.length > 0) {
            const activeSelection = await pickTradableCandidate(parsedActiveCandidates, "current_slug");
            if (
              activeSelection &&
              activeSelection.selectionSource !== "fallback_discovery" &&
              activeSelection.selectedSlug
            ) {
              if (activeSelection.selectedTradable) {
                this.lastUsableLiveSelectedMarket = { ...activeSelection.selectedMarket };
                this.persistedPolymarketSnapshot = {
                  ...this.persistedPolymarketSnapshot,
                  staleState: null
                };
              } else if (
                activeSelection.liveValidationReason === "transient_quote_failure" ||
                activeSelection.liveValidationReason === "quote_failure" ||
                activeSelection.liveValidationReason === "empty_live_quote"
              ) {
                this.persistedPolymarketSnapshot = {
                  ...this.persistedPolymarketSnapshot,
                  staleState: "ACTIVE_MARKET_PRICE_STALE",
                  liveValidationReason: "PRICE_REFRESH_FAILED_ACTIVE_MARKET"
                };
              } else {
                this.persistedPolymarketSnapshot = {
                  ...this.persistedPolymarketSnapshot,
                  staleState: null
                };
              }
              activeRefreshedSelection = activeSelection;
            }
          }
          dominantReject = "REFRESH_FAILED_ACTIVE_MARKET";
          this.persistedPolymarketSnapshot = {
            ...this.persistedPolymarketSnapshot,
            staleState: "ACTIVE_MARKET_REFRESH_FAILED",
            liveValidationReason: "REFRESH_FAILED_ACTIVE_MARKET"
          };
        } else {
          dominantReject = "REFRESH_FAILED_ACTIVE_MARKET";
          this.persistedPolymarketSnapshot = {
            ...this.persistedPolymarketSnapshot,
            staleState: "ACTIVE_MARKET_REFRESH_FAILED",
            liveValidationReason: "REFRESH_FAILED_ACTIVE_MARKET"
          };
        }
      } catch (error) {
        this.markReadPathWarning("NETWORK_ERROR");
        this.maybeLogDeterministicDiscoveryDegraded({
          warningSource: "active_selected_refresh",
          error,
          details: { selectedSlug: committedSlug }
        });
        dominantReject = "REFRESH_FAILED_ACTIVE_MARKET";
        this.persistedPolymarketSnapshot = {
          ...this.persistedPolymarketSnapshot,
          staleState: "ACTIVE_MARKET_REFRESH_FAILED",
          liveValidationReason: "REFRESH_FAILED_ACTIVE_MARKET"
        };
      }
    }

    const directLookup = await this.directSlugResolver.lookupBySlugs(attemptedSlugs);
    if (directLookup.hadNetworkError) {
      this.markReadPathWarning("NETWORK_ERROR");
      return {
        selectedMarket: null,
        selectedSlug: null,
        selectedWindowStart: null,
        selectedWindowEnd: null,
        selectedAcceptingOrders: null,
        selectedEnableOrderBook: null,
        selectedTokenId: null,
        chosenSide: null,
        chosenDirection: null,
        selectedBookable: false,
        selectedTradable: false,
        discoveredCurrent,
        discoveredNext,
        selectionSource: null,
        liveValidationReason: "NETWORK_ERROR",
        lastBookTs: null,
        lastQuoteTs: null,
        currentBucketSlug: currentBucket.currentSlug,
        nextBucketSlug: currentBucket.nextSlug,
        currentBucketStartSec: currentBucket.currentBucketStartSec,
        selectedReason: "btc5m_network_error",
        dominantReject: "NETWORK_ERROR",
        stageCounts: {
          fetchedCount: discoveredRows.length,
          afterActiveCount: discoveredRows.length,
          afterSearchCount: discoveredRows.length,
          afterWindowCount: 0,
          afterPatternCount: 0,
          finalCandidatesCount: 0
        },
        attemptedSlugs,
        fallbackUsed: "none"
      };
    }
    for (const candidate of directLookup.rows) {
      addCandidateRow(candidate.row, `direct_${candidate.source}`, candidate.slug);
    }

    const parsedDirectCandidates = parseCandidates(candidateRows);
    const directEligibility = filterEligibleCandidates(parsedDirectCandidates);
    const eligibleDirectCandidates = directEligibility.eligible;
    updateDiscoveredBucketFlags(eligibleDirectCandidates);
    const finalCandidates = buildPrioritizedCandidates(eligibleDirectCandidates);
    let directSelection: Awaited<ReturnType<typeof pickTradableCandidate>> | null = null;

    if (finalCandidates.length === 1) {
      const singleCandidate = finalCandidates[0];
      const promotedSingle = await pickTradableCandidate([singleCandidate], "current_slug");
      if (promotedSingle) {
        const promotedSlug =
          promotedSingle.selectedSlug ||
          singleCandidate.slug ||
          this.getMarketDeterministicSlug(singleCandidate.market);
        const promotedTokenId =
          promotedSingle.selectedTokenId ??
          (promotedSingle.chosenSide === "NO"
            ? String(singleCandidate.market.noTokenId || "").trim() || null
            : String(singleCandidate.market.yesTokenId || "").trim() || null);
        if (promotedSlug) {
          if (promotedSingle.selectedTradable) {
            this.lastUsableLiveSelectedMarket = { ...promotedSingle.selectedMarket };
          }
          return {
            selectedMarket: promotedSingle.selectedMarket,
            selectedSlug: promotedSlug,
            selectedWindowStart: promotedSingle.selectedMarket.startTs ?? null,
            selectedWindowEnd: promotedSingle.selectedMarket.endTs ?? null,
            selectedAcceptingOrders: promotedSingle.selectedMarket.acceptingOrders ?? null,
            selectedEnableOrderBook: promotedSingle.selectedMarket.enableOrderBook ?? null,
            selectedTokenId: promotedTokenId,
            chosenSide: promotedSingle.chosenSide,
            chosenDirection: promotedSingle.chosenDirection,
            selectedBookable: promotedSingle.selectedBookable,
            selectedTradable: promotedSingle.selectedTradable,
            discoveredCurrent,
            discoveredNext,
            selectionSource: "DIRECT_SLUG",
            liveValidationReason: promotedSingle.liveValidationReason,
            lastBookTs: promotedSingle.lastBookTs,
            lastQuoteTs: promotedSingle.lastQuoteTs,
            currentBucketSlug: currentBucket.currentSlug,
            nextBucketSlug: currentBucket.nextSlug,
            currentBucketStartSec: currentBucket.currentBucketStartSec,
            selectedReason: promotedSingle.selectedReason,
            dominantReject: promotedSingle.selectedTradable ? "OK" : promotedSingle.liveValidationReason,
            stageCounts: {
              fetchedCount: discoveredRows.length,
              afterActiveCount: discoveredRows.length,
              afterSearchCount: discoveredRows.length,
              afterWindowCount: 1,
              afterPatternCount: 1,
              finalCandidatesCount: 1
            },
            attemptedSlugs,
            fallbackUsed: "none"
          };
        }
      }
      this.logger.error(
        {
          nowTs,
          attemptedSlugs,
          candidateCount: finalCandidates.length,
          candidate: {
            marketId: singleCandidate.market.marketId,
            slug: singleCandidate.slug || this.getMarketDeterministicSlug(singleCandidate.market),
            source: singleCandidate.source,
            startSec: singleCandidate.startSec,
            endTs: singleCandidate.market.endTs,
            remainingSec: getCandidateRemainingSec(singleCandidate)
          }
        },
        "POLY_BTC5M_SELECTION_INVARIANT_SINGLE_CANDIDATE_WITHOUT_SLUG"
      );
      directSelection = promotedSingle;
    }

    if (!directSelection) {
      directSelection = await pickTradableCandidate(finalCandidates, "current_slug");
    }
    if (directSelection && directSelection.selectedTradable && directSelection.selectedSlug) {
      this.lastUsableLiveSelectedMarket = { ...directSelection.selectedMarket };
      return {
        selectedMarket: directSelection.selectedMarket,
        selectedSlug: directSelection.selectedSlug,
        selectedWindowStart: directSelection.selectedMarket.startTs ?? null,
        selectedWindowEnd: directSelection.selectedMarket.endTs ?? null,
        selectedAcceptingOrders: directSelection.selectedMarket.acceptingOrders ?? null,
        selectedEnableOrderBook: directSelection.selectedMarket.enableOrderBook ?? null,
        selectedTokenId: directSelection.selectedTokenId,
        chosenSide: directSelection.chosenSide,
        chosenDirection: directSelection.chosenDirection,
        selectedBookable: directSelection.selectedBookable,
        selectedTradable: directSelection.selectedTradable,
        discoveredCurrent,
        discoveredNext,
        selectionSource: "DIRECT_SLUG",
        liveValidationReason: directSelection.liveValidationReason,
        lastBookTs: directSelection.lastBookTs,
        lastQuoteTs: directSelection.lastQuoteTs,
        currentBucketSlug: currentBucket.currentSlug,
        nextBucketSlug: currentBucket.nextSlug,
        currentBucketStartSec: currentBucket.currentBucketStartSec,
        selectedReason: directSelection.selectedReason,
        dominantReject: "OK",
        stageCounts: {
          fetchedCount: discoveredRows.length,
          afterActiveCount: discoveredRows.length,
          afterSearchCount: discoveredRows.length,
          afterWindowCount: 1,
          afterPatternCount: 1,
          finalCandidatesCount: 1
        },
        attemptedSlugs,
        fallbackUsed: "none"
      };
    }

    if (rolloverDemotion.demoted) {
      this.demoteLiveSelection("ROLLOVER_DEMOTED_PREVIOUS_BUCKET", nowTs);
    }

    const shouldFallbackToBroadDiscovery = finalCandidates.length === 0 && !directLookup.hadData;
    if (shouldFallbackToBroadDiscovery) {
      const broadRows = await safeListMarketsPage(
        {
          limit: 200,
          active: true,
          closed: false,
          archived: false
        },
        "active_scan"
      );
      for (const row of broadRows) {
        addCandidateRow(row, "active_scan");
      }
      const parsedFallbackCandidates = parseCandidates(candidateRows);
      const fallbackEligibility = filterEligibleCandidates(parsedFallbackCandidates);
      const eligibleFallbackCandidates = fallbackEligibility.eligible;
      updateDiscoveredBucketFlags(eligibleFallbackCandidates);
      const fallbackReason =
        fallbackEligibility.rejectReasons.length > 0
          ? pickDominantReject(fallbackEligibility.rejectReasons)
          : directLookup.hadNetworkError
            ? "NETWORK_ERROR"
            : "NO_DIRECT_MARKET";
      dominantReject =
        fallbackReason === "EXPIRED_WINDOW" || fallbackReason === "NETWORK_ERROR" || fallbackReason === "NO_DIRECT_MARKET"
          ? fallbackReason
          : "NO_DIRECT_MARKET";
    } else if (finalCandidates.length === 0) {
      dominantReject =
        directLookup.hadNetworkError
          ? "NETWORK_ERROR"
          : directEligibility.rejectReasons.includes("EXPIRED_WINDOW")
            ? "EXPIRED_WINDOW"
            : "NO_DIRECT_MARKET";
    }

    if (activeRefreshedSelection) {
      const hasSelectedSlug = Boolean(String(activeRefreshedSelection.selectedSlug || "").trim());
      const activeAttemptedSlugs = Array.from(new Set([activeCommittedSelection?.selectedSlug, ...attemptedSlugs].filter(Boolean) as string[]));
      return {
        selectedMarket: activeRefreshedSelection.selectedMarket,
        selectedSlug: activeRefreshedSelection.selectedSlug,
        selectedWindowStart: activeRefreshedSelection.selectedMarket.startTs ?? null,
        selectedWindowEnd: activeRefreshedSelection.selectedMarket.endTs ?? null,
        selectedAcceptingOrders: activeRefreshedSelection.selectedMarket.acceptingOrders ?? null,
        selectedEnableOrderBook: activeRefreshedSelection.selectedMarket.enableOrderBook ?? null,
        selectedTokenId: activeRefreshedSelection.selectedTokenId,
        chosenSide: activeRefreshedSelection.chosenSide,
        chosenDirection: activeRefreshedSelection.chosenDirection,
        selectedBookable: activeRefreshedSelection.selectedBookable,
        selectedTradable: activeRefreshedSelection.selectedTradable,
        discoveredCurrent,
        discoveredNext,
        selectionSource: mapDiscoverySelectionSource(activeRefreshedSelection.selectionSource),
        liveValidationReason: activeRefreshedSelection.liveValidationReason,
        lastBookTs: activeRefreshedSelection.lastBookTs,
        lastQuoteTs: activeRefreshedSelection.lastQuoteTs,
        currentBucketSlug: currentBucket.currentSlug,
        nextBucketSlug: currentBucket.nextSlug,
        currentBucketStartSec: currentBucket.currentBucketStartSec,
        selectedReason: "btc5m_active_selected_refresh",
        dominantReject: activeRefreshedSelection.selectedTradable ? "OK" : activeRefreshedSelection.liveValidationReason,
        stageCounts: {
          fetchedCount: discoveredRows.length,
          afterActiveCount: discoveredRows.length,
          afterSearchCount: discoveredRows.length,
          afterWindowCount: hasSelectedSlug ? activeRefreshedSelection.prioritizedWindowCount : 0,
          afterPatternCount: hasSelectedSlug ? activeRefreshedSelection.prioritizedWindowCount : 0,
          finalCandidatesCount: hasSelectedSlug ? activeRefreshedSelection.prioritizedWindowCount : 0
        },
        attemptedSlugs: activeAttemptedSlugs,
        fallbackUsed: "window"
      };
    }

    return {
      selectedMarket: null,
      selectedSlug: null,
      selectedWindowStart: null,
      selectedWindowEnd: null,
      selectedAcceptingOrders: null,
      selectedEnableOrderBook: null,
      selectedTokenId: null,
      chosenSide: null,
      chosenDirection: null,
      selectedBookable: false,
      selectedTradable: false,
      discoveredCurrent,
      discoveredNext,
      selectionSource: null,
      liveValidationReason: dominantReject,
      lastBookTs: null,
      lastQuoteTs: null,
      currentBucketSlug: currentBucket.currentSlug,
      nextBucketSlug: currentBucket.nextSlug,
      currentBucketStartSec: currentBucket.currentBucketStartSec,
      selectedReason: "btc5m_not_found",
      dominantReject,
      stageCounts: {
        fetchedCount: discoveredRows.length,
        afterActiveCount: discoveredRows.length,
        afterSearchCount: discoveredRows.length,
        afterWindowCount: 0,
        afterPatternCount: 0,
        finalCandidatesCount: 0
      },
      attemptedSlugs,
      fallbackUsed: shouldFallbackToBroadDiscovery ? "topActive" : "none"
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
    const sharedDecision = this.evaluateSharedPolymarketDecision({
      market,
      decision,
      pUpModel: prob.pUpModel,
      pBoosted: calibrated.pBoosted,
      tauSec,
      oracleEst,
      oracleState,
      allowOracleStale: paperSoftOracleStaleAllowed,
      yesEntryPrice,
      noEntryPrice,
      strategyThreshold: decision.threshold,
      minEdgeThreshold: this.config.polymarket.paper.minEdgeThreshold,
      minNetEdgeThreshold: this.config.polymarket.paper.minNetEdge,
      decisionFeeBps: this.config.polymarket.paper.feeBps,
      decisionSlippageBps: this.config.polymarket.paper.slippageBps,
      forceTrade: false
    });
    const chosenSide = sharedDecision.chosenSide;
    const chosenDirection = sharedDecision.chosenDirection;
    const chosenEdge = sharedDecision.chosenEdge;
    const signedEdge = sharedDecision.signedEdge;
    const netEdgeAfterCosts = sharedDecision.netEdgeAfterCosts;
    const edgeYes = sharedDecision.edgeYes;
    const edgeNo = sharedDecision.edgeNo;
    const netEdgeYes = sharedDecision.netEdgeYes;
    const netEdgeNo = sharedDecision.netEdgeNo;
    const conviction = sharedDecision.conviction;
    const stalenessEdge = sharedDecision.stalenessEdge;

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

    let action = "HOLD";
    let holdReason: string | null = null;
    let holdDetailReason: string | null = null;
    let executedSize: number | null = null;

    if (openWindowTrade) {
      holdReason = "OPEN_POSITION_IN_WINDOW";
      holdDetailReason = holdReason;
    } else if (cooldownActive) {
      holdReason = "REENTRY_COOLDOWN";
      holdDetailReason = holdReason;
    } else if (sharedDecision.dataHealthBlock || sharedDecision.strategyBlock) {
      holdReason = sharedDecision.holdReason;
      holdDetailReason = sharedDecision.strategyBlockDetail ?? sharedDecision.holdReason;
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
      if (!(size.notionalUsd > 0)) {
        holdReason = "EDGE_BELOW_THRESHOLD";
        holdDetailReason = "SIZE_BELOW_MIN_NOTIONAL";
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
            side: chosenSide!,
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
              side: chosenSide!,
              direction: chosenDirection,
              chooserReason: sharedDecision.chooserReason,
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
          chooserReason: sharedDecision.chooserReason,
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
    const tickContext = this.createBtc5mTickContext(Date.now());
    const nowTs = tickContext.tickNowMs;
    this.tickWarningState = null;
    this.runtimeWarningState = null;
    this.syncPaperLedgerFromDisk();
    await this.execution.refreshLiveState();
    this.markReadPathWarning((this.execution as unknown as { getLiveReadWarningState?: () => string | null }).getLiveReadWarningState?.());
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
    if (!paperMode && deterministicBtc5mMode) {
      this.maybeInvalidateLiveSelectionNearRollover(nowTs);
    }
    const tickBucket = tickContext.bucket;
    if (!paperMode && deterministicBtc5mMode && this.debugPoly) {
      this.logger.info(
        {
          tickNowSec: tickContext.tickNowSec,
          bucketStartSec: tickContext.currentBucketStartSec,
          currentBucketSlug: tickContext.currentBucketSlug,
          nextBucketSlug: tickContext.nextBucketSlug,
          prevBucketSlug: tickContext.prevBucketSlug,
          remainingSec: tickContext.remainingSec
        },
        "POLY_TICK_CLOCK"
      );
    }
    const attemptedSlugs = Array.from(
      new Set([tickContext.currentBucketSlug, tickContext.nextBucketSlug, tickContext.prevBucketSlug])
    );
    const previousTickBucketSlug = String(this.persistedPolymarketSnapshot.currentBucketSlug || "").trim() || null;
    const bucketChangedThisTick =
      previousTickBucketSlug !== null && previousTickBucketSlug !== tickBucket.currentSlug;
    const openTradeMarketIds = deterministicBtc5mMode ? this.getAwaitingResolutionMarketIds() : new Set<string>();
    const sniperMinRemainingSec = Math.max(1, this.config.polymarket.paper.entryMinRemainingSec);
    const sniperMaxRemainingSec = Math.max(
      sniperMinRemainingSec,
      this.config.polymarket.paper.entryMaxRemainingSec
    );
    let markets: BtcWindowMarket[] = [];
    let selectedMarket: BtcWindowMarket | null = null;
    let selectedSlug: string | null = null;
    let selectedWindowStart: number | null = null;
    let selectedWindowEnd: number | null = null;
    let selectedAcceptingOrders: boolean | null = null;
    let selectedEnableOrderBook: boolean | null = null;
    let selectedCommittedTokenId: string | null = null;
    let selectedBookable = false;
    let selectedTradable = false;
    let discoveredCurrent = false;
    let discoveredNext = false;
    let selectionSource: SelectionSource | null = null;
    let selectedFrom: SelectionSource | null = null;
    let selectionCommitTs: number | null = null;
    let liveValidationReason: string | null = null;
    let lastBookTs: number | null = null;
    let lastQuoteTs: number | null = null;
    let currentBucketSlug: string | null = null;
    let nextBucketSlug: string | null = null;
    let currentBucketStartSec: number | null = null;
    let selectedReason: string | null = "btc5m_slug_event";
    let selectedScore: number | null = null;
    let selectedChosenSide: "YES" | "NO" | null = null;
    let selectedChosenDirection: string | null = null;
    let selectedExecutionBlockedReason: string | null = null;
    let validatedLiveMarket: BtcWindowMarket | null = null;
    let validatedLiveTokenId: string | null = null;
    let validatedLiveChosenSide: "YES" | "NO" | null = null;
    let validatedLiveChosenDirection: string | null = null;
    let validatedLiveValidationReason: string | null = null;
    if (deterministicBtc5mMode) {
      currentBucketSlug = tickContext.currentBucketSlug;
      nextBucketSlug = tickContext.nextBucketSlug;
      currentBucketStartSec = tickContext.currentBucketStartSec;
    }
    const getSelectedRemainingSec = (): number | null =>
      Number(selectedWindowEnd || 0) > nowTs ? Math.max(0, Math.floor((Number(selectedWindowEnd) - nowTs) / 1000)) : null;
    let dominantReject: string | null = deterministicBtc5mMode ? "BTC5M_NOT_FOUND" : "OK";
    let stageCounts = {
      fetchedCount: 0,
      afterActiveCount: 0,
      afterSearchCount: 0,
      afterWindowCount: 0,
      afterPatternCount: 0,
      finalCandidatesCount: 0
    };
    let deterministicAttemptedSlugs = attemptedSlugs;
    let fallbackUsed: "none" | "window" | "patterns" | "topActive" = "none";
    if (deterministicBtc5mMode) {
      const deterministicSelection = await this.resolveDeterministicBtc5mLiveMarket(nowTs, tickContext);
      deterministicAttemptedSlugs = deterministicSelection.attemptedSlugs;
      fallbackUsed = deterministicSelection.fallbackUsed;
      selectedMarket = deterministicSelection.selectedMarket;
      selectedSlug = deterministicSelection.selectedSlug;
      selectedWindowStart = deterministicSelection.selectedWindowStart;
      selectedWindowEnd = deterministicSelection.selectedWindowEnd;
      selectedAcceptingOrders = deterministicSelection.selectedAcceptingOrders;
      selectedEnableOrderBook = deterministicSelection.selectedEnableOrderBook;
      selectedCommittedTokenId = deterministicSelection.selectedTokenId;
      selectedChosenSide = deterministicSelection.chosenSide;
      selectedChosenDirection = deterministicSelection.chosenDirection;
      selectedBookable = deterministicSelection.selectedBookable;
      selectedTradable = deterministicSelection.selectedTradable;
      discoveredCurrent = deterministicSelection.discoveredCurrent;
      discoveredNext = deterministicSelection.discoveredNext;
      selectionSource = deterministicSelection.selectionSource;
      selectedFrom = deterministicSelection.selectionSource;
      liveValidationReason = deterministicSelection.liveValidationReason;
      lastBookTs = deterministicSelection.lastBookTs;
      lastQuoteTs = deterministicSelection.lastQuoteTs;
      if (
        this.checkTickBucketContextMismatch({
          tickContext,
          observedCurrentBucketSlug: deterministicSelection.currentBucketSlug,
          observedNextBucketSlug: deterministicSelection.nextBucketSlug,
          phase: "deterministic_selection",
          selectionCommitTs: this.persistedPolymarketSnapshot.selectionCommitTs,
          selectedSlug: deterministicSelection.selectedSlug,
          remainingSec: deterministicSelection.selectedWindowEnd
            ? Math.max(0, Math.floor((deterministicSelection.selectedWindowEnd - nowTs) / 1000))
            : null
        })
      ) {
        this.clearLiveCommittedSelection(nowTs, "BUCKET_CONTEXT_MISMATCH");
        this.maybeEmitTickLog({
          marketsSeen: 0,
          activeWindows: 0,
          now: new Date(nowTs).toISOString(),
          currentMarketId: null,
          tauSec: tickContext.remainingSec,
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
          holdReason: "BUCKET_CONTEXT_MISMATCH",
          holdDetailReason: "BUCKET_CONTEXT_MISMATCH",
          dominantReject: "BUCKET_CONTEXT_MISMATCH",
          size: null,
          openTrades: this.paperLedger.getOpenTrades().length,
          resolvedTrades: this.paperLedger.getResolvedTrades().length,
          selectedSlug: null,
          windowStart: null,
          windowEnd: null,
          acceptingOrders: null,
          enableOrderBook: null,
          currentBucketSlug: tickContext.currentBucketSlug,
          nextBucketSlug: tickContext.nextBucketSlug,
          currentBucketStartSec: tickContext.currentBucketStartSec
        });
        return;
      }
      currentBucketSlug = tickContext.currentBucketSlug;
      nextBucketSlug = tickContext.nextBucketSlug;
      currentBucketStartSec = tickContext.currentBucketStartSec;
      selectedReason = deterministicSelection.selectedReason;
      dominantReject = deterministicSelection.dominantReject;
      stageCounts = deterministicSelection.stageCounts;
      const activeCommittedBeforeReconcile = this.getActiveLiveCommittedSelection(nowTs);
      const selectedSlugForReconcile =
        activeCommittedBeforeReconcile?.selectedSlug ?? selectedSlug ?? this.persistedPolymarketSnapshot.selectedSlug ?? null;
      const selectedMarketIdForReconcile =
        activeCommittedBeforeReconcile?.selectedMarketId ??
        selectedMarket?.marketId ??
        this.persistedPolymarketSnapshot.selectedMarketId ??
        null;
      const remainingSecForReconcile =
        activeCommittedBeforeReconcile?.remainingSec ??
        getSelectedRemainingSec() ??
        this.getSelectionRemainingSecFromSnapshot(this.persistedPolymarketSnapshot, nowTs);
      const selectedTradableForReconcile =
        activeCommittedBeforeReconcile?.selectedTradable ??
        selectedTradable ??
        this.persistedPolymarketSnapshot.selectedTradable;
      const hasCurrentTradableCandidate = Boolean(
        selectedMarket &&
          this.getMarketDeterministicSlug(selectedMarket) === tickBucket.currentSlug &&
          selectedBookable &&
          selectedTradable
      );
      const hasCurrentBookableCandidate = Boolean(
        selectedMarket &&
          this.getMarketDeterministicSlug(selectedMarket) === tickBucket.currentSlug &&
          selectedBookable
      );
      const reconcileDecision = this.reconcileSelectionWithCurrentBucket({
        nowTs,
        selectedSlug: selectedSlugForReconcile,
        selectedMarketId: selectedMarketIdForReconcile,
        currentBucketSlug: tickBucket.currentSlug,
        nextBucketSlug: tickBucket.nextSlug,
        remainingSec: remainingSecForReconcile,
        selectionCommitTs:
          activeCommittedBeforeReconcile?.selectionCommitTs ??
          selectionCommitTs ??
          this.persistedPolymarketSnapshot.selectionCommitTs,
        holdReason: activeCommittedBeforeReconcile?.holdReason ?? this.persistedPolymarketSnapshot.holdReason,
        selectedTradable: selectedTradableForReconcile,
        bucketChanged: bucketChangedThisTick,
        hasCurrentTradableCandidate,
        hasCurrentBookableCandidate,
        openTradeMarketIds
      });
      if (reconcileDecision.action === "CLEAR_STALE_SELECTION") {
        this.clearStaleSelectionForRollover(nowTs, "ROLLOVER_STALE_SELECTION_CLEARED");
        selectedMarket = hasCurrentTradableCandidate ? selectedMarket : null;
        selectedSlug = hasCurrentTradableCandidate && selectedMarket ? this.getMarketDeterministicSlug(selectedMarket) : null;
        selectedWindowStart =
          hasCurrentTradableCandidate && selectedMarket
            ? selectedMarket.startTs ?? selectedWindowStart
            : null;
        selectedWindowEnd =
          hasCurrentTradableCandidate && selectedMarket
            ? selectedMarket.endTs ?? selectedWindowEnd
            : null;
        selectedAcceptingOrders =
          hasCurrentTradableCandidate && selectedMarket ? selectedMarket.acceptingOrders ?? null : null;
        selectedEnableOrderBook =
          hasCurrentTradableCandidate && selectedMarket ? selectedMarket.enableOrderBook ?? null : null;
        selectedCommittedTokenId =
          hasCurrentTradableCandidate && selectedMarket
            ? selectedCommittedTokenId ??
              (selectedChosenSide === "NO"
                ? String(selectedMarket.noTokenId || "").trim() || null
                : String(selectedMarket.yesTokenId || "").trim() || null)
            : null;
        selectedBookable = hasCurrentTradableCandidate ? selectedBookable : false;
        selectedTradable = hasCurrentTradableCandidate ? selectedTradable : false;
        selectionSource = hasCurrentTradableCandidate ? "DIRECT_SLUG" : null;
        selectedFrom = hasCurrentTradableCandidate ? "DIRECT_SLUG" : null;
        selectionCommitTs = hasCurrentTradableCandidate ? nowTs : null;
        liveValidationReason = hasCurrentTradableCandidate
          ? liveValidationReason
          : "ROLLOVER_STALE_SELECTION_CLEARED";
      } else if (
        reconcileDecision.action === "PROMOTE_CURRENT_BUCKET" &&
        hasCurrentTradableCandidate &&
        selectedMarket
      ) {
        selectedSlug = this.getMarketDeterministicSlug(selectedMarket) ?? tickBucket.currentSlug;
        selectedWindowStart = selectedMarket.startTs ?? selectedWindowStart;
        selectedWindowEnd = selectedMarket.endTs ?? selectedWindowEnd;
        selectedAcceptingOrders = selectedMarket.acceptingOrders ?? selectedAcceptingOrders;
        selectedEnableOrderBook = selectedMarket.enableOrderBook ?? selectedEnableOrderBook;
        selectionSource = "DIRECT_SLUG";
        selectedFrom = "DIRECT_SLUG";
        selectionCommitTs = nowTs;
      }
      const validationReasonUpper = String(liveValidationReason || "").trim().toUpperCase();
      if (selectedTradable && validationReasonUpper.startsWith("TRADABLE_")) {
        this.persistedPolymarketSnapshot = {
          ...this.persistedPolymarketSnapshot,
          staleState: null
        };
      } else if (validationReasonUpper === "REFRESH_FAILED_ACTIVE_MARKET") {
        this.persistedPolymarketSnapshot = {
          ...this.persistedPolymarketSnapshot,
          staleState: "ACTIVE_MARKET_REFRESH_FAILED"
        };
      } else if (
        validationReasonUpper === "PRICE_REFRESH_FAILED_ACTIVE_MARKET" ||
        validationReasonUpper === "TRANSIENT_QUOTE_FAILURE" ||
        validationReasonUpper === "QUOTE_FAILURE" ||
        validationReasonUpper === "EMPTY_LIVE_QUOTE"
      ) {
        this.persistedPolymarketSnapshot = {
          ...this.persistedPolymarketSnapshot,
          staleState: "ACTIVE_MARKET_PRICE_STALE"
        };
      }
      markets = selectedMarket ? [selectedMarket] : [];
      this.selectedTokenIds = selectedMarket
        ? [selectedMarket.yesTokenId, selectedMarket.noTokenId].filter(Boolean) as string[]
        : [];
      if (selectedMarket) {
        const currentBucket = this.getFreshBtc5mWallClockBucket(nowTs);
        const selectedBucketStartSec =
          parseBtc5mWindowStartSec(selectedSlug) ??
          (Number.isFinite(Number(selectedMarket.startTs)) && Number(selectedMarket.startTs) > 0
            ? Math.floor(Number(selectedMarket.startTs) / 1000)
            : null);
        this.commitLiveSelectedMarket(selectedMarket, nowTs, {
          selectedReason,
          chosenSide: selectedChosenSide,
          chosenDirection: selectedChosenDirection,
          selectedTokenId: selectedCommittedTokenId,
          selectedBookable,
          selectedTradable,
          discoveredCurrent,
          discoveredNext,
          selectionSource: selectionSource ?? "current_slug",
          selectedFrom: selectedFrom ?? selectionSource ?? "current_slug",
          selectionCommitTs: nowTs,
          candidateRefreshed: true,
          liveValidationReason,
          lastBookTs,
          lastQuoteTs,
          currentBucketSlug,
          nextBucketSlug,
          currentBucketStartSec
        });
        this.maybeLogSelectorDiagnostic("info", "POLY_BTC5M_SELECTED", {
          nowSec: currentBucket.nowSec,
          currentBucketStartSec: currentBucket.currentBucketStartSec,
          currentSlug: currentBucket.currentSlug,
          prevSlug: currentBucket.prevSlug,
          nextSlug: currentBucket.nextSlug,
          candidateSlugs: deterministicAttemptedSlugs,
          triedSlugs: deterministicAttemptedSlugs,
          slug: selectedSlug,
          selectedSlug,
          selectedBucketStartSec,
          remainingSec:
            Number.isFinite(Number(selectedWindowEnd)) && Number(selectedWindowEnd) > nowTs
              ? Math.max(0, Math.floor((Number(selectedWindowEnd) - nowTs) / 1000))
              : null,
          bucketLagSec:
            selectedBucketStartSec === null ? null : selectedBucketStartSec - currentBucket.currentBucketStartSec,
          marketId: selectedMarket.marketId,
          selectedReason
        });
        this.persistedPolymarketSnapshot = {
          ...this.persistedPolymarketSnapshot,
          selectedTokenId: selectedCommittedTokenId,
          selectedBookable,
          selectedTradable,
          discoveredCurrent,
          discoveredNext,
          selectionSource,
          selectedFrom: selectedFrom ?? selectionSource,
          selectionCommitTs: nowTs,
          liveValidationReason,
          lastBookTs,
          lastQuoteTs,
          currentBucketSlug,
          nextBucketSlug,
          currentBucketStartSec,
          selectedWindowStartSec:
            Number.isFinite(Number(selectedWindowStart)) && Number(selectedWindowStart) > 0
              ? Math.floor(Number(selectedWindowStart) / 1000)
              : null,
          selectedWindowEndSec:
            Number.isFinite(Number(selectedWindowEnd)) && Number(selectedWindowEnd) > 0
              ? Math.floor(Number(selectedWindowEnd) / 1000)
              : null
        };
      } else {
        const currentBucket = this.getFreshBtc5mWallClockBucket(nowTs);
        let activeCommittedSelection = this.getActiveLiveCommittedSelection(nowTs);
        const activeSelectionBucketStartSec = this.getLiveSelectionCadenceStartSec(activeCommittedSelection);
        const liveValidationReasonText = String(liveValidationReason || "").trim().toUpperCase();
        if (
          activeCommittedSelection &&
          (activeSelectionBucketStartSec !== null &&
            activeSelectionBucketStartSec < currentBucket.currentBucketStartSec)
        ) {
          this.clearLiveCommittedSelection(nowTs, "NON_CURRENT_CADENCE_BUCKET");
          activeCommittedSelection = this.getActiveLiveCommittedSelection(nowTs);
        }
        if (
          activeCommittedSelection &&
          (liveValidationReasonText === "EXPIRED_WINDOW" ||
            liveValidationReasonText === "REMAINING_BELOW_THRESHOLD")
        ) {
          this.demoteLiveSelection(liveValidationReasonText, nowTs);
          activeCommittedSelection = this.getActiveLiveCommittedSelection(nowTs);
        }
        this.persistedPolymarketSnapshot = {
          ...this.persistedPolymarketSnapshot,
          selectedBookable: false,
          selectedTradable: false,
          discoveredCurrent,
          discoveredNext,
          selectionSource,
          selectedFrom: selectedFrom ?? selectionSource,
          liveValidationReason,
          lastBookTs,
          lastQuoteTs,
          currentBucketSlug,
          nextBucketSlug,
          currentBucketStartSec
        };
        if (!activeCommittedSelection) {
          this.selectedTokenIds = [];
        }
        const selectedBucketStartSec = this.getLiveSelectionCadenceStartSec(activeCommittedSelection);
        this.maybeLogSelectorDiagnostic("warn", "POLY_BTC5M_NOT_FOUND", {
          nowSec: currentBucket.nowSec,
          currentBucketStartSec: currentBucket.currentBucketStartSec,
          currentSlug: currentBucket.currentSlug,
          prevSlug: currentBucket.prevSlug,
          nextSlug: currentBucket.nextSlug,
          candidateSlugs: deterministicAttemptedSlugs,
          triedSlugs: deterministicAttemptedSlugs,
          selectedSlug: activeCommittedSelection?.selectedSlug ?? null,
          selectedBucketStartSec,
          remainingSec: activeCommittedSelection?.remainingSec ?? null,
          bucketLagSec:
            selectedBucketStartSec === null ? null : selectedBucketStartSec - currentBucket.currentBucketStartSec,
          dominantReject
        });
      }
    }
    const forceSlug = "";
    if (!deterministicBtc5mMode) {
      stageCounts = {
        fetchedCount: selectedMarket ? 1 : 0,
        afterActiveCount: selectedMarket ? 1 : 0,
        afterSearchCount: selectedMarket ? 1 : 0,
        afterWindowCount: selectedMarket ? 1 : 0,
        afterPatternCount: selectedMarket ? 1 : 0,
        finalCandidatesCount: selectedMarket ? 1 : 0
      };
    }
    const discoveredCandidates = stageCounts.fetchedCount;
    if (
      deterministicBtc5mMode &&
      stageCounts.afterWindowCount <= 0 &&
      (dominantReject === null || dominantReject === "BTC5M_NOT_FOUND")
    ) {
      dominantReject = "NO_ACTIVE_WINDOWS";
    }
    const effectiveMinWindowSec = sniperMinRemainingSec;
    const effectiveMaxWindowSec = sniperMaxRemainingSec;
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
            slug: this.getMarketDeterministicSlug(selectedMarket) || selectedMarket.marketId,
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
    if (
      deterministicBtc5mMode &&
      (dominantReject === "NO_DIRECT_MARKET" || dominantReject === "NETWORK_ERROR")
    ) {
      this.clearLiveCommittedSelection(nowTs, dominantReject);
    }
    let activeCommittedSelection = this.getActiveLiveCommittedSelection(nowTs);
    if (activeCommittedSelection) {
      selectedSlug = activeCommittedSelection.selectedSlug;
      selectedWindowStart = activeCommittedSelection.windowStartTs;
      selectedWindowEnd = activeCommittedSelection.windowEndTs;
      selectedAcceptingOrders = activeCommittedSelection.acceptingOrders;
      selectedEnableOrderBook = activeCommittedSelection.enableOrderBook;
      selectedCommittedTokenId = activeCommittedSelection.selectedTokenId;
      selectedBookable = activeCommittedSelection.selectedBookable;
      selectedTradable = activeCommittedSelection.selectedTradable;
      discoveredCurrent = activeCommittedSelection.discoveredCurrent;
      discoveredNext = activeCommittedSelection.discoveredNext;
      selectionSource = activeCommittedSelection.selectionSource;
      selectedFrom = activeCommittedSelection.selectedFrom;
      selectionCommitTs = activeCommittedSelection.selectionCommitTs;
      liveValidationReason = activeCommittedSelection.liveValidationReason;
      lastBookTs = activeCommittedSelection.lastBookTs;
      lastQuoteTs = activeCommittedSelection.lastQuoteTs;
      currentBucketSlug = tickContext.currentBucketSlug;
      nextBucketSlug = tickContext.nextBucketSlug;
      currentBucketStartSec = tickContext.currentBucketStartSec;
      selectedChosenSide = activeCommittedSelection.chosenSide;
      selectedChosenDirection = activeCommittedSelection.chosenDirection;
      selectedExecutionBlockedReason = activeCommittedSelection.executionBlockedReason;
    }
    let selectionCommitInvariantBroken =
      this.config.polymarket.mode === "live" &&
      (stageCounts.afterWindowCount > 0 || stageCounts.finalCandidatesCount > 0) &&
      !(activeCommittedSelection && (activeCommittedSelection.selectedSlug || activeCommittedSelection.selectedMarketId));
    if (selectionCommitInvariantBroken) {
      const recoverMarket = selectedMarket ?? validatedLiveMarket;
      const recoverTokenId = selectedCommittedTokenId ?? validatedLiveTokenId;
      const recoverChosenSide = selectedChosenSide ?? validatedLiveChosenSide;
      const recoverChosenDirection = selectedChosenDirection ?? validatedLiveChosenDirection;
      const recoverLiveValidationReason = liveValidationReason ?? validatedLiveValidationReason;
      const recoverReasonUpper = String(recoverLiveValidationReason || "").trim().toUpperCase();
      const recoverableValidation =
        recoverReasonUpper.startsWith("TRADABLE_") ||
        recoverReasonUpper === "PREORDER_VALIDATED" ||
        recoverReasonUpper === "TRADABLE_CURRENT_SLUG";
      const recoverMarketSlug = recoverMarket ? this.getMarketDeterministicSlug(recoverMarket) : null;
      const recoverBucketClass = recoverMarket
        ? this.classifyDeterministicWindowFromSlugOrStart(
            recoverMarketSlug,
            this.getCanonicalBtc5mTimingFromSlugOrRow({
              slug: recoverMarketSlug,
              rowStartTs: recoverMarket.startTs ?? null,
              rowEndTs: recoverMarket.endTs ?? null
            }).startSec,
            tickBucket
          )
        : "other";
      const recoverIsCurrentOrNext = recoverBucketClass === "current" || recoverBucketClass === "next";
      const derivedRecoverTokenId =
        recoverTokenId ??
        (recoverChosenSide === "NO"
          ? String(recoverMarket?.noTokenId || "").trim() || null
          : String(recoverMarket?.yesTokenId || "").trim() || null);
      const hasOpenTradeForRecoverMarket =
        Boolean(recoverMarket?.marketId) && openTradeMarketIds.has(String(recoverMarket?.marketId || "").trim());
      if (
        recoverMarket &&
        derivedRecoverTokenId &&
        (recoverIsCurrentOrNext || hasOpenTradeForRecoverMarket) &&
        (selectedTradable || recoverableValidation || recoverIsCurrentOrNext || hasOpenTradeForRecoverMarket)
      ) {
        const recoveredSelection = this.recoverLiveSelectionFromValidatedMarket({
          nowTs,
          tickContext,
          market: recoverMarket,
          selectedTokenId: derivedRecoverTokenId,
          chosenSide: recoverChosenSide,
          chosenDirection: recoverChosenDirection,
          selectionSource:
            selectionSource && selectionSource !== "committed"
              ? selectionSource
              : this.inferSelectionSourceFromStartSec(
                  this.getCanonicalBtc5mTimingFromSlugOrRow({
                    slug: this.getMarketDeterministicSlug(recoverMarket),
                    rowStartTs: recoverMarket.startTs ?? null,
                    rowEndTs: recoverMarket.endTs ?? null
                  }).startSec,
                  tickBucket
                ),
          liveValidationReason: recoverLiveValidationReason || "tradable_current_slug",
          logRecovery: true
        });
        if (recoveredSelection) {
          activeCommittedSelection = recoveredSelection;
          selectedSlug = recoveredSelection.selectedSlug;
          selectedWindowStart = recoveredSelection.windowStartTs;
          selectedWindowEnd = recoveredSelection.windowEndTs;
          selectedAcceptingOrders = recoveredSelection.acceptingOrders;
          selectedEnableOrderBook = recoveredSelection.enableOrderBook;
          selectedCommittedTokenId = recoveredSelection.selectedTokenId;
          selectedBookable = recoveredSelection.selectedBookable;
          selectedTradable = recoveredSelection.selectedTradable;
          discoveredCurrent = recoveredSelection.discoveredCurrent;
          discoveredNext = recoveredSelection.discoveredNext;
          selectionSource = recoveredSelection.selectionSource;
          selectedFrom = recoveredSelection.selectedFrom;
          selectionCommitTs = recoveredSelection.selectionCommitTs;
          liveValidationReason = recoveredSelection.liveValidationReason;
          lastBookTs = recoveredSelection.lastBookTs;
          lastQuoteTs = recoveredSelection.lastQuoteTs;
          currentBucketSlug = tickContext.currentBucketSlug;
          nextBucketSlug = tickContext.nextBucketSlug;
          currentBucketStartSec = tickContext.currentBucketStartSec;
          selectedChosenSide = recoveredSelection.chosenSide;
          selectedChosenDirection = recoveredSelection.chosenDirection;
          selectedExecutionBlockedReason = recoveredSelection.executionBlockedReason;
          selectionCommitInvariantBroken = false;
        }
      }
    }
    if (selectionCommitInvariantBroken) {
      const selectorInvariantReason = "SELECTION_NOT_COMMITTED";
      const priorLiveValidationReason = liveValidationReason;
      dominantReject = selectorInvariantReason;
      liveValidationReason = priorLiveValidationReason || selectorInvariantReason;
      selectedExecutionBlockedReason = selectorInvariantReason;
      selectedMarket = null;
      markets = [];
      selectedSlug = null;
      selectedWindowStart = null;
      selectedWindowEnd = null;
      selectedAcceptingOrders = null;
      selectedEnableOrderBook = null;
      selectedCommittedTokenId = null;
      selectedChosenSide = null;
      selectedChosenDirection = null;
      selectedBookable = false;
      selectedTradable = false;
      this.selectedTokenIds = [];
      this.persistedPolymarketSnapshot = {
        ...this.persistedPolymarketSnapshot,
        status: selectorInvariantReason,
        holdReason: selectorInvariantReason,
        executionBlockedReason: selectorInvariantReason,
        liveValidationReason,
        selectedSlug: null,
        selectedMarketId: null,
        selectedTokenId: null,
        selectedBookable: false,
        selectedTradable: false,
        discoveredCurrent: false,
        discoveredNext: false,
        selectedFrom: null,
        selectionCommitTs: null,
        pollMode: "VERY_FAST",
        lastDecisionTs: nowTs
      };
      this.emitSelectionBugLine({
        currentBucketSlug,
        nextBucketSlug,
        fetchedCount: stageCounts.fetchedCount,
        afterWindowCount: stageCounts.afterWindowCount,
        finalCandidatesCount: stageCounts.finalCandidatesCount,
        selectedSlug: activeCommittedSelection?.selectedSlug ?? null,
        selectedTokenId: activeCommittedSelection?.selectedTokenId ?? null,
        liveValidationReason: priorLiveValidationReason || liveValidationReason,
        attemptedSlugs: deterministicAttemptedSlugs
      });
      activeCommittedSelection = null;
    }
    this.syncSelectedMarketFeed(activeCommittedSelection, selectedMarket);
    this.polyState.selectedSlug = selectedSlug ?? null;
    this.polyState.selectedMarketId =
      activeCommittedSelection?.selectedMarketId ?? selectedMarket?.marketId ?? null;
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
              : getSelectedRemainingSec(),
          priceToBeat: hydratedMarkets[0]?.priceToBeat ?? null,
          oracleEst: oracleEst > 0 ? oracleEst : null,
          sigma: sigmaPricePerSqrtSec > 0 ? sigmaPricePerSqrtSec : null,
          yesBid: null,
          yesAsk: null,
          yesMid: null,
          pUpModel: null,
          edge: null,
          chosenSide: selectedChosenSide,
          chosenDirection: selectedChosenDirection,
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
            : getSelectedRemainingSec(),
        priceToBeat: selectedMarket && selectedMarket.priceToBeat > 0 ? selectedMarket.priceToBeat : null,
        oracleEst: oracleEst > 0 ? oracleEst : null,
        sigma: sigmaPricePerSqrtSec > 0 ? sigmaPricePerSqrtSec : null,
        yesBid: null,
        yesAsk: null,
        yesMid: null,
        pUpModel: null,
        edge: null,
        chosenSide: selectedChosenSide,
        chosenDirection: selectedChosenDirection,
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
            : selectedSlug && Number(selectedWindowEnd || 0) > nowTs
              ? normalizeHoldReason(selectedExecutionBlockedReason || dominantReject || "FETCH_STALE")
              : hydratedMarkets.length === 0
              ? this.paperLedger.getOpenTrades().length > 0
                ? "AWAITING_RESOLUTION"
                : dominantReject === "SELECTION_NOT_COMMITTED"
                  ? "SELECTION_NOT_COMMITTED"
                  : dominantReject === "NO_ACTIVE_WINDOWS"
                    ? "NO_ACTIVE_WINDOWS"
                : dominantReject === "EXPIRED_WINDOW"
                  ? "EXPIRED_WINDOW"
                  : dominantReject === "NETWORK_ERROR"
                    ? "NETWORK_ERROR"
                    : dominantReject === "DIRECT_SLUG_FAILURE"
                      ? "DIRECT_SLUG_FAILURE"
                      : dominantReject === "FALLBACK_SCAN_FAILURE"
                        ? "FALLBACK_SCAN_FAILURE"
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
            : getSelectedRemainingSec(),
        priceToBeat: hydratedMarkets[0]?.priceToBeat ?? null,
        oracleEst: null,
        sigma: null,
        yesBid: null,
        yesAsk: null,
        yesMid: null,
        pUpModel: null,
        edge: null,
        chosenSide: selectedChosenSide,
        chosenDirection: selectedChosenDirection,
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
          : getSelectedRemainingSec(),
      priceToBeat: hydratedMarkets[0]?.priceToBeat ?? null,
      oracleEst: oracleEst > 0 ? oracleEst : null,
      sigma: sigmaPricePerSqrtSec > 0 ? sigmaPricePerSqrtSec : null,
      yesBid: null,
      yesAsk: null,
      yesMid: null,
      pUpModel: null,
      edge: null,
      chosenSide: selectedChosenSide,
      chosenDirection: selectedChosenDirection,
      threshold: null,
      action: "HOLD",
      holdReason: null,
      holdDetailReason: selectedExecutionBlockedReason ?? dominantReject,
      forceTradeFired,
      forceTradeMode,
      selectedTokenId: this.persistedPolymarketSnapshot.selectedTokenId,
      candidateRefreshed: this.persistedPolymarketSnapshot.candidateRefreshed,
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
    let processedEvaluatedMarket = false;
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

      const implied = paperMode
        ? await this.getImpliedYesBook(market, {
            isSelectedMarket: selectedMarket?.marketId === market.marketId,
            remainingSec
          })
        : await this.getDecisionYesPrice(market);
      this.polyState.lastBookTsMs = Math.max(
        this.polyState.lastBookTsMs,
        Math.floor(("bookTs" in implied ? implied.bookTs : implied.ts) || nowTs)
      );
      this.polyState.lastYesBid = Number.isFinite("yesBid" in implied ? implied.yesBid : implied.bid)
        ? ("yesBid" in implied ? implied.yesBid : implied.bid)
        : null;
      this.polyState.lastYesAsk = Number.isFinite("yesAsk" in implied ? implied.yesAsk : implied.ask)
        ? ("yesAsk" in implied ? implied.yesAsk : implied.ask)
        : null;
      this.polyState.lastYesMid = Number.isFinite("yesMid" in implied ? implied.yesMid : implied.mid)
        ? ("yesMid" in implied ? implied.yesMid : implied.mid)
        : null;
      this.polyState.latestPolymarketTs = Math.max(
        Number(this.polyState.latestPolymarketTs || 0),
        Math.floor((("bookTs" in implied ? implied.bookTs : implied.ts) || nowTs))
      );
      const impliedYesBid = "yesBid" in implied ? implied.yesBid : implied.bid;
      const impliedYesAsk = "yesAsk" in implied ? implied.yesAsk : implied.ask;
      const impliedYesMid = "yesMid" in implied ? implied.yesMid : implied.mid;
      if (
        !Number.isFinite(impliedYesBid) ||
        !Number.isFinite(impliedYesAsk) ||
        !Number.isFinite(impliedYesMid)
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
        yesBid: impliedYesBid,
        yesAsk: impliedYesAsk,
        yesMid: impliedYesMid,
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
          yesBid: impliedYesBid,
          yesAsk: impliedYesAsk,
          yesMid: impliedYesMid,
          impliedProbMid: impliedYesMid
        });
        continue;
      }
      const impliedTs = "bookTs" in implied ? implied.bookTs : implied.ts;
      const yesPriceFetchFailed = "priceFetchFailed" in implied ? Boolean(implied.priceFetchFailed) : false;
      const polyUpdateAgeMs = impliedTs > 0 ? Math.max(0, nowTs - impliedTs) : 0;
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

      const decision = this.strategy.decide({
        pUpModel: prob.pUpModel,
        orderBook,
        sigmaPerSqrtSec,
        tauSec
      });
      let noAsk = estimateNoAskFromYesBook(decision.yesBid);
      let noTopAskSize = 0;
      let noPriceFetchFailed = false;
      if (paperMode) {
        if (market.noTokenId) {
          const noQuote = await this.getNoAskAndDepthFromTokenId(market.noTokenId, noAsk);
          noAsk = noQuote.noAsk;
          noTopAskSize = noQuote.topAskSize;
        }
      } else {
        const noQuote = await this.getDecisionNoPrice(market.eventSlug || market.slug || null, market.noTokenId || null, noAsk);
        noAsk = noQuote.noAsk;
        noTopAskSize = noQuote.topAskSize;
        noPriceFetchFailed = noQuote.priceFetchFailed;
      }
      const yesEntryPrice = decision.yesAsk > 0 ? decision.yesAsk : decision.yesMid;
      const noEntryPrice = noAsk > 0 ? noAsk : estimateNoAskFromYesBook(decision.yesBid);
      const forceTrade = paperMode && this.config.polymarket.paper.forceTrade;
      const minEdgeThreshold = paperMode
        ? this.config.polymarket.paper.minEdgeThreshold
        : this.config.polymarket.live.minEdgeThreshold;
      const minNetEdgeThreshold = paperMode
        ? this.config.polymarket.paper.minNetEdge
        : Math.min(this.config.polymarket.paper.minNetEdge, this.config.polymarket.live.minEdgeThreshold);
      const maxAllowedSpread = paperMode
        ? this.config.polymarket.threshold.maxSpread
        : this.config.polymarket.live.maxSpread;
      const yesMidMin = paperMode ? 0.001 : this.config.polymarket.live.yesMidMin;
      const yesMidMax = paperMode ? 0.999 : this.config.polymarket.live.yesMidMax;
      const liveNoSideEnabled = paperMode ? true : this.config.polymarket.live.enableNoSide;
      const paperSoftOracleStaleAllowed =
        paperMode &&
        oracleState === "ORACLE_STALE" &&
        polyUpdateAgeMs <= this.config.polymarket.risk.staleMs;
      const sharedDecision = this.evaluateSharedPolymarketDecision({
        market,
        decision,
        pUpModel: prob.pUpModel,
        pBoosted: calibrated.pBoosted,
        tauSec: remainingSec,
        oracleEst,
        oracleState,
        allowOracleStale: paperSoftOracleStaleAllowed,
        yesEntryPrice,
        noEntryPrice,
        strategyThreshold: paperMode ? decision.threshold : minEdgeThreshold,
        minEdgeThreshold,
        minNetEdgeThreshold,
        decisionFeeBps: this.config.polymarket.paper.feeBps,
        decisionSlippageBps: this.config.polymarket.paper.slippageBps,
        forceTrade
      });
      const chosenSide = sharedDecision.chosenSide;
      const chosenDirection = sharedDecision.chosenDirection;
      let selectedTokenId =
        chosenSide === "YES"
          ? String(market.yesTokenId || "").trim() || null
          : chosenSide === "NO"
            ? String(market.noTokenId || "").trim() || null
            : null;
      let candidateRefreshed: boolean | null = null;
      if (this.config.polymarket.mode === "live" && selectedMarket?.marketId === market.marketId) {
        selectedChosenSide = chosenSide;
        selectedChosenDirection = chosenDirection;
        selectedExecutionBlockedReason = null;
        this.updateLiveCommittedSelectionDecision(market, nowTs, chosenSide, chosenDirection);
      }
      const edgeYes = sharedDecision.edgeYes;
      const edgeNo = sharedDecision.edgeNo;
      const netEdgeYes = sharedDecision.netEdgeYes;
      const netEdgeNo = sharedDecision.netEdgeNo;
      const costPenaltyProb = sharedDecision.costPenaltyProb;
      const chosenEdge = sharedDecision.chosenEdge;
      const netEdgeAfterCosts = sharedDecision.netEdgeAfterCosts;
      const liveExecutionPenaltyProb =
        !paperMode && this.config.polymarket.mode === "live"
          ? Math.max(0, Number(this.config.polymarket.execution.takerPriceBuffer || 0)) / 10_000
          : 0;
      const netEdgeAfterExecutionBuffer = netEdgeAfterCosts - liveExecutionPenaltyProb;
      const strategyWouldTradeAfterExecutionBuffer =
        paperMode || this.config.polymarket.mode !== "live"
          ? sharedDecision.paperWouldTrade
          : sharedDecision.paperWouldTrade &&
            netEdgeAfterExecutionBuffer > Math.max(0, Number(minNetEdgeThreshold || 0));
      const signedEdge = sharedDecision.signedEdge;
      const stalenessEdge = sharedDecision.stalenessEdge;
      const conviction = sharedDecision.conviction;
      const decisionAction = sharedDecision.action;
      const noBidTelemetry =
        Number.isFinite(Number(decision.yesAsk)) && Number(decision.yesAsk) > 0
          ? estimateNoBidFromYesBook(Number(decision.yesAsk))
          : null;
      const yesSpreadTelemetry =
        Number.isFinite(Number(decision.yesAsk)) &&
        Number.isFinite(Number(decision.yesBid)) &&
        Number(decision.yesAsk) >= Number(decision.yesBid)
          ? Math.max(0, Number(decision.yesAsk) - Number(decision.yesBid))
          : null;
      const noSpreadTelemetry =
        Number.isFinite(Number(noAsk)) &&
        Number(noAsk) > 0 &&
        Number.isFinite(Number(noBidTelemetry)) &&
        Number(noBidTelemetry) >= 0 &&
        Number(noAsk) >= Number(noBidTelemetry)
          ? Math.max(0, Number(noAsk) - Number(noBidTelemetry))
          : null;
      const chosenSidePriceUsedTelemetry =
        chosenSide === "YES"
          ? Number.isFinite(Number(decision.yesAsk))
            ? Number(decision.yesAsk)
            : null
          : chosenSide === "NO"
            ? Number.isFinite(Number(noAsk))
              ? Number(noAsk)
              : null
            : null;
      const minDislocationConfigTelemetry = getLiveMinDislocationConfigFromEnv();
      const extremePriceMinConfigTelemetry = getLiveExtremePriceMinConfigFromEnv();
      const extremePriceMaxConfigTelemetry = getLiveExtremePriceMaxConfigFromEnv(extremePriceMinConfigTelemetry);
      const fairYesTelemetry = Number.isFinite(Number(prob.pUpModel)) ? clamp(Number(prob.pUpModel), 0.0005, 0.9995) : null;
      const fairPriceSourceTelemetry: "MODEL" | "OUTCOME_HINT" | "NONE" =
        fairYesTelemetry !== null
          ? "MODEL"
          : Array.isArray(market.outcomePricesHint) && Number.isFinite(Number(market.outcomePricesHint[0]))
            ? "OUTCOME_HINT"
            : "NONE";
      const fairPriceModelOriginTelemetry = fairPriceSourceTelemetry === "MODEL" ? "prob.pUpModel" : null;
      const fairSideTelemetry =
        fairYesTelemetry === null
          ? null
          : chosenSide === "NO"
            ? clamp(1 - fairYesTelemetry, 0.0005, 0.9995)
            : fairYesTelemetry;
      const dislocationAbsTelemetry =
        fairSideTelemetry !== null &&
        chosenSidePriceUsedTelemetry !== null &&
        Number.isFinite(Number(chosenSidePriceUsedTelemetry))
          ? Math.abs(fairSideTelemetry - Number(chosenSidePriceUsedTelemetry))
          : null;
      const extremePriceFilterHitCandidate =
        chosenSidePriceUsedTelemetry !== null &&
        (chosenSidePriceUsedTelemetry > extremePriceMaxConfigTelemetry ||
          chosenSidePriceUsedTelemetry < extremePriceMinConfigTelemetry);
      const feeBpsUsedTelemetry = Number.isFinite(Number(this.config.polymarket.paper.feeBps))
        ? Number(this.config.polymarket.paper.feeBps)
        : null;
      const slippageBpsUsedTelemetry = Number.isFinite(Number(this.config.polymarket.paper.slippageBps))
        ? Number(this.config.polymarket.paper.slippageBps)
        : null;
      const safetyBpsUsedTelemetry = Number.isFinite(Number(this.config.edgeSafetyBps))
        ? Number(this.config.edgeSafetyBps)
        : null;
      const chosenEdgeBeforeClampTelemetry = Number.isFinite(Number(chosenEdge)) ? Number(chosenEdge) : null;
      const chosenEdgeAfterClampTelemetry =
        chosenEdgeBeforeClampTelemetry !== null ? Math.max(0, chosenEdgeBeforeClampTelemetry) : null;

      this.lagProfiler.record({
        tsMs: nowTs,
        windowSlug: market.eventSlug || market.slug || market.marketId,
        tauSec,
        priceToBeat: market.priceToBeat,
        fastMid: fastMidNow > 0 ? fastMidNow : null,
        oraclePrice: oracleEst > 0 ? oracleEst : null,
        oracleUpdatedAtMs: oracleTs ?? null,
        yesBid: impliedYesBid,
        yesAsk: impliedYesAsk,
        yesMid: impliedYesMid,
        impliedProbMid: impliedYesMid,
        pModel: prob.pUpModel,
        absProbGap: Math.abs(prob.pUpModel - impliedYesMid)
      });

      this.latestPolymarketSnapshot = {
        ts: nowTs,
        windowSlug: market.eventSlug || market.slug || market.marketId,
        tauSec,
        priceToBeat: market.priceToBeat,
        fastMid: fastMidNow > 0 ? fastMidNow : null,
        yesMid: impliedYesMid,
        impliedProbMid: impliedYesMid
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
        const paperImplied = implied as YesBookLookup;
        await this.managePaperOpenPositions({
          nowTs,
          market,
          implied: paperImplied,
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
      const sidePrice = desiredSide === "NO" ? noAsk : decision.yesAsk;
      const sideProb = desiredSide === "NO" ? 1 - prob.pUpModel : prob.pUpModel;
      const topAskDepthShares = desiredSide === "NO" ? noTopAskSize : implied.topAskSize;
      const depthCapNotionalUsd =
        desiredSide && topAskDepthShares > 0
          ? topAskDepthShares * Math.max(0.0001, sidePrice) * 0.35
          : 0;
      const size = desiredSide
        ? this.sizing.compute({
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
          })
        : { notionalUsd: 0, shares: 0, kellyFraction: 0 };
      const sizingCheck = this.evaluateOrderSizingCheck({
        selectedSlug: market.eventSlug || market.slug || null,
        selectedTokenId,
        chosenSide: desiredSide,
        orderPrice: desiredSide ? sidePrice : null,
        requestedBudget: size.notionalUsd,
        computedShares: size.shares
      });
      const minSharesRequiredConfig = sizingCheck.minVenueShares;
      const minSharesFeasibility = evaluateMinSharesConfigFeasibility({
        maxNotionalPerWindow: sizingCheck.maxNotionalPerWindow,
        chosenSidePriceUsed:
          desiredSide && chosenSidePriceUsedTelemetry !== null && chosenSidePriceUsedTelemetry > 0
            ? chosenSidePriceUsedTelemetry
            : null,
        minSharesRequiredConfig
      });
      const maxAchievableShares = minSharesFeasibility.maxAchievableShares;
      const configFeasible = minSharesFeasibility.configFeasible;
      const finalOrderNotionalUsd = sizingCheck.finalNotional;
      const finalOrderShares = sizingCheck.finalShares;
      if (!paperMode) {
        this.persistedPolymarketSnapshot = {
          ...this.persistedPolymarketSnapshot,
          minVenueShares: sizingCheck.minVenueShares,
          desiredShares: sizingCheck.desiredShares,
          finalShares: sizingCheck.finalShares,
          desiredNotional: sizingCheck.desiredNotional,
          finalNotional: sizingCheck.finalNotional,
          sizeBumped: sizingCheck.sizeBumped
        };
      }

      let action = decisionAction;
      let executedSize = finalOrderNotionalUsd;
      let canAttemptTrade =
        strategyWouldTradeAfterExecutionBuffer &&
        sizingCheck.passes &&
        finalOrderNotionalUsd > 0 &&
        finalOrderShares > 0;
      let blockReason = sharedDecision.blockedBy || "";
      let riskBlockReasonInternal: string | null = null;
      let strategyBlock = sharedDecision.strategyBlock;
      let dataHealthBlock = sharedDecision.dataHealthBlock;
      let blockedCategory = sharedDecision.blockedCategory;
      let selectedSideBookable: boolean | null = null;
      let selectedSideBookabilityReason: string | null = null;
      const setBlocked = (reason: string, category: HoldCategory): void => {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = reason;
        blockedCategory = category;
        if (category === "DATA_HEALTH") {
          dataHealthBlock = reason;
        } else {
          strategyBlock = reason;
        }
        if (!paperMode) {
          this.logger.info(
            {
              reason,
              category,
              edgeValue: netEdgeAfterCosts,
              edgeThreshold: minEdgeThreshold,
              netEdgeThreshold: minNetEdgeThreshold,
              spread: decision.spread,
              spreadThreshold: maxAllowedSpread,
              yesMid: decision.yesMid,
              yesMidMin,
              yesMidMax,
              chosenSide: desiredSide,
              noSideEnabled: liveNoSideEnabled,
              selectedTokenId,
              selectedSideBookable,
              selectedSideBookabilityReason
            },
            "POLY_LIVE_STRATEGY_BLOCK"
          );
        }
      };
      const applyResultBlockReason = (reason: string): void => {
        riskBlockReasonInternal = String(reason || "").trim() || null;
        const normalizedReason = this.normalizeLiveBlockReason(reason);
        setBlocked(normalizedReason, classifyHoldCategory(normalizedReason));
        if (!paperMode) {
          this.persistedPolymarketSnapshot = {
            ...this.persistedPolymarketSnapshot,
            lastNormalizedError: normalizedReason
          };
        }
      };
      const sizingRejectBlockReason =
        !configFeasible
          ? "CONFIG_INFEASIBLE_MIN_SHARES"
          : sizingCheck.sizingRejectReason === "BELOW_MIN_SHARES"
          ? "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED"
          : sizingCheck.sizingRejectReason === "BELOW_MIN_NOTIONAL"
            ? "SIZE_BELOW_MIN_NOTIONAL"
            : null;

      if (!paperMode && selectedMarket?.marketId === market.marketId && desiredSide) {
        const precheckSource =
          selectionSource === "FALLBACK_SCAN"
            ? "fallback_discovery"
            : selectionSource === "next_slug"
              ? "next_slug"
              : "current_slug";
        const precheck = await this.validateLiveMarketTradability({
          market,
          chosenSide: desiredSide,
          nowTs,
          selectionSource: precheckSource
        });
        selectedSideBookable = precheck.bookable;
        selectedSideBookabilityReason = precheck.reason;
        if (!precheck.tradable || !precheck.tokenId || !precheck.bookable) {
          const precheckReason =
            precheck.reason === "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN"
              ? "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN"
              : "SIDE_NOT_BOOKABLE";
          setBlocked(precheckReason, "DATA_HEALTH");
          selectedExecutionBlockedReason = precheckReason;
          selectedTokenId = null;
          selectedBookable = false;
          selectedTradable = false;
          if (precheck.reason === "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN") {
            this.markReadPathWarning("MISSING_ORDERBOOK_FOR_SELECTED_TOKEN");
          }
        } else {
          selectedTokenId = precheck.tokenId;
          selectedBookable = true;
          selectedTradable = true;
        }
      }

      if (!paperMode && sharedDecision.paperWouldTrade && !strategyWouldTradeAfterExecutionBuffer) {
        setBlocked("EDGE_BELOW_THRESHOLD_EXECUTION_BUFFER", "STRATEGY");
      }

      if (
        !paperMode &&
        sharedDecision.paperWouldTrade &&
        ((sizingRejectBlockReason === "CONFIG_INFEASIBLE_MIN_SHARES" && !configFeasible) ||
          (!sizingCheck.passes && sizingRejectBlockReason))
      ) {
        applyResultBlockReason(sizingRejectBlockReason);
      }

      if (paperMode && sharedDecision.paperWouldTrade && !sizingCheck.passes) {
        const notionalText = Number(finalOrderNotionalUsd || 0).toFixed(4);
        const minNotionalText = Number(sizingCheck.minOrderNotional || 0).toFixed(4);
        setBlocked(
          `SIZE_BELOW_MIN_NOTIONAL effectiveNotionalUsd=${notionalText} minNotionalUsd=${minNotionalText} side=${String(
            desiredSide || "-"
          )} orderPrice=${sizingCheck.orderPrice > 0 ? sizingCheck.orderPrice.toFixed(4) : "-"} shares=${sizingCheck.finalShares.toFixed(
            6
          )}`,
          "RISK"
        );
      }
      if (!(decision.yesBid > 0) || !(decision.yesAsk > 0)) {
        setBlocked("MISSING_BBO", "DATA_HEALTH");
      }
      if (decision.yesAsk < decision.yesBid) {
        setBlocked("CROSSED_BBO", "DATA_HEALTH");
      }
      if (!forceTrade && decision.spread > maxAllowedSpread) {
        setBlocked("SPREAD_TOO_WIDE", "STRATEGY");
      }
      if (decision.yesMid < yesMidMin || decision.yesMid > yesMidMax) {
        setBlocked("YES_MID_OUT_OF_RANGE", "DATA_HEALTH");
      }
      if (paperMode && !this.config.polymarket.paper.allowMultipleTradesPerWindow) {
        const windowTrades = this.paperLedger.getTradesForWindow(
          market.marketId,
          windowStartTs,
          toMs(market.endTs)
        );
        const openWindowTrade = windowTrades.find((row) => !row.resolvedAt);
        if (openWindowTrade) {
          setBlocked("WINDOW_ALREADY_OPEN", "STRATEGY");
        } else if (windowTrades.length > 0) {
          setBlocked("WINDOW_ALREADY_TRADED", "STRATEGY");
        }
      }
      if (this.tradingPaused) {
        const pauseBlock = this.pauseReason ? `TRADING_PAUSED_${this.pauseReason}` : "TRADING_PAUSED";
        applyResultBlockReason(pauseBlock);
      }
      if (!paperMode) {
        if (yesPriceFetchFailed || noPriceFetchFailed) {
          const activeSelectionForMarket =
            Boolean(selectedMarket?.marketId === market.marketId) &&
            Boolean(this.getActiveLiveCommittedSelection(nowTs));
          const livePriceRefreshReason = activeSelectionForMarket
            ? "PRICE_REFRESH_FAILED_ACTIVE_MARKET"
            : "PRICE_FETCH_FAILED";
          setBlocked(livePriceRefreshReason, "DATA_HEALTH");
          selectedExecutionBlockedReason = livePriceRefreshReason;
          this.persistedPolymarketSnapshot = {
            ...this.persistedPolymarketSnapshot,
            staleState: activeSelectionForMarket ? "ACTIVE_MARKET_PRICE_STALE" : this.persistedPolymarketSnapshot.staleState,
            liveValidationReason: activeSelectionForMarket
              ? "PRICE_REFRESH_FAILED_ACTIVE_MARKET"
              : this.persistedPolymarketSnapshot.liveValidationReason
          };
          if (selectedMarket?.marketId === market.marketId) {
            this.markReadPathWarning("NETWORK_ERROR");
            this.persistLiveCommittedSelectionStatus(nowTs, {
              chosenSide,
              chosenDirection,
              holdReason: livePriceRefreshReason,
              warningState: "NETWORK_ERROR"
            });
          }
        }
      }

      if (canAttemptTrade) {
        if (!paperMode) {
          if (chosenSide === "YES") {
            const liveBookability = await this.getImpliedYesBook(market, {
              isSelectedMarket: selectedMarket?.marketId === market.marketId,
              remainingSec
            });
            if (!liveBookability.bookable) {
              blockReason = liveBookability.source === "missing" ? "MISSING_ORDERBOOK" : "SIDE_NOT_BOOKABLE";
              setBlocked(blockReason, "DATA_HEALTH");
              if (selectedMarket?.marketId === market.marketId) {
                selectedExecutionBlockedReason = blockReason;
                this.markLiveSelectedMarketExecutionBlocked({
                  market,
                  nowTs,
                  side: "YES",
                  reason: blockReason as "MISSING_ORDERBOOK" | "SIDE_NOT_BOOKABLE",
                  source: liveBookability.source,
                  tokenId: market.yesTokenId || null
                });
              }
            }
          } else if (!market.noTokenId) {
            blockReason = "MISSING_ORDERBOOK";
            setBlocked(blockReason, "DATA_HEALTH");
            if (selectedMarket?.marketId === market.marketId) {
              selectedExecutionBlockedReason = blockReason;
              this.markLiveSelectedMarketExecutionBlocked({
                market,
                nowTs,
                side: "NO",
                reason: "MISSING_ORDERBOOK",
                source: "missing",
                tokenId: null
              });
            }
          } else {
            const liveNoQuote = await this.getNoAskAndDepthFromTokenId(market.noTokenId, noAsk);
            if (!liveNoQuote.bookable) {
              blockReason = liveNoQuote.source === "missing" ? "MISSING_ORDERBOOK" : "SIDE_NOT_BOOKABLE";
              setBlocked(blockReason, "DATA_HEALTH");
              if (selectedMarket?.marketId === market.marketId) {
                selectedExecutionBlockedReason = blockReason;
                this.markLiveSelectedMarketExecutionBlocked({
                  market,
                  nowTs,
                  side: "NO",
                  reason: blockReason as "MISSING_ORDERBOOK" | "SIDE_NOT_BOOKABLE",
                  source: liveNoQuote.source,
                  tokenId: market.noTokenId
                });
              }
            }
          }
        }
        if (!canAttemptTrade) {
          action = "HOLD";
          executedSize = 0;
        } else if (this.config.polymarket.killSwitch) {
          setBlocked("KILL_SWITCH", "RISK");
        } else {
          if (paperSoftOracleStaleAllowed) {
            this.logger.warn(
              {
                marketId: market.marketId,
                slug: this.getMarketDeterministicSlug(market),
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
            projectedOrderNotionalUsd: finalOrderNotionalUsd,
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
            applyResultBlockReason(check.reason || "RISK_BLOCKED");
          } else if (paperMode) {
            const accepted = this.executePaperTrade({
              marketId: market.marketId,
              marketSlug: market.eventSlug || market.slug,
              windowStartTs,
              windowEndTs: market.endTs,
              priceToBeat: market.priceToBeat,
              side: desiredSide!,
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
              requestedNotionalUsd: finalOrderNotionalUsd,
              ts: nowTs
            });
            action = accepted ? (decisionAction === "BUY_NO" ? "BUY_NO" : "BUY_YES") : "HOLD";
            executedSize = accepted ? finalOrderNotionalUsd : 0;
            if (!accepted) {
              applyResultBlockReason("PAPER_TRADE_REJECTED");
            }
        } else if (chosenSide === "NO" && !liveNoSideEnabled) {
          setBlocked("LIVE_NO_SIDE_DISABLED", "STRATEGY");
        } else {
            const executionSide: "YES" | "NO" = chosenSide === "NO" ? "NO" : "YES";
            const preorder = await this.validateLiveExecutionCandidate({
              nowTs,
              tickContext,
              market,
              chosenSide: executionSide
            });
            selectedTokenId = preorder.selectedTokenId ?? selectedTokenId;
            candidateRefreshed = preorder.candidateRefreshed;
            if (!preorder.valid || !preorder.refreshedMarket || !preorder.selectedTokenId) {
              let preorderReasonKey = preorder.reason;
              const committedValidationReason = String(liveValidationReason || "").trim().toUpperCase();
              const committedAsTradableThisTick =
                committedValidationReason === "TRADABLE_CURRENT_SLUG" ||
                committedValidationReason === "TRADABLE_NEXT_SLUG";
              if (
                preorderReasonKey === "expired_window" &&
                committedAsTradableThisTick &&
                tickContext.remainingSec > 0
              ) {
                this.logger.error(
                  {
                    tickNowSec: tickContext.tickNowSec,
                    currentBucketSlug: tickContext.currentBucketSlug,
                    nextBucketSlug: tickContext.nextBucketSlug,
                    selectedSlug,
                    liveValidationReason,
                    preorderReason: preorder.reason,
                    remainingSec: tickContext.remainingSec
                  },
                  "POLY_BUCKET_CONTEXT_MISMATCH"
                );
                preorderReasonKey = "stale_market_selection";
              }
              const preorderReason =
                preorderReasonKey === "token_not_bookable" &&
                this.persistedPolymarketSnapshot.liveValidationReason === "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN"
                  ? "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN"
                  : preorderReasonKey === "discovery_failed"
                    ? "REFRESH_FAILED_ACTIVE_MARKET"
                  : `PREORDER_${String(preorderReasonKey || "discovery_failed").toUpperCase()}`;
              setBlocked(preorderReason, classifyHoldCategory(preorderReason));
              selectedExecutionBlockedReason = preorderReason;
              if (preorderReason === "REFRESH_FAILED_ACTIVE_MARKET") {
                this.persistedPolymarketSnapshot = {
                  ...this.persistedPolymarketSnapshot,
                  staleState: "ACTIVE_MARKET_REFRESH_FAILED",
                  liveValidationReason: "REFRESH_FAILED_ACTIVE_MARKET"
                };
              }
              if (
                preorderReasonKey === "stale_market_selection" ||
                preorderReasonKey === "stale_token_ids" ||
                preorderReasonKey === "token_mismatch" ||
                preorderReasonKey === "discovery_failed"
              ) {
                this.markReadPathWarning("DISCOVERY_STALE");
              }
              if (selectedMarket?.marketId === market.marketId) {
                this.persistLiveCommittedSelectionStatus(nowTs, {
                  chosenSide,
                  chosenDirection,
                  holdReason: preorderReason,
                  warningState: this.runtimeWarningState ?? null
                });
              }
              if (preorderReasonKey === "token_not_bookable") {
                if (this.liveCommittedSelection) {
                  this.liveCommittedSelection = {
                    ...this.liveCommittedSelection,
                    selectedTokenId: null,
                    selectedBookable: false,
                    selectedTradable: false,
                    liveValidationReason: this.persistedPolymarketSnapshot.liveValidationReason || preorderReason,
                    holdReason: normalizeHoldReason("SIDE_NOT_BOOKABLE"),
                    executionBlockedReason: "SIDE_NOT_BOOKABLE",
                    executionBlockedSide: executionSide
                  };
                  this.syncPersistedLiveSelectionState(nowTs);
                }
              } else if (
                preorderReasonKey === "stale_market_selection" ||
                preorderReasonKey === "expired_window" ||
                preorderReasonKey === "market_closed" ||
                preorderReasonKey === "market_archived"
              ) {
                this.demoteLiveSelection(preorderReasonKey, nowTs);
              } else {
                this.clearLiveCommittedSelection(nowTs, preorderReason);
              }
            } else {
              const freshMarket = preorder.refreshedMarket;
              this.selectedTokenIds = [freshMarket.yesTokenId, freshMarket.noTokenId].filter(Boolean) as string[];
              validatedLiveMarket = freshMarket;
              validatedLiveTokenId = preorder.selectedTokenId;
              validatedLiveChosenSide = executionSide;
              validatedLiveChosenDirection = chosenDirection;
              validatedLiveValidationReason = "preorder_validated";
              const recoveredSelection = this.recoverLiveSelectionFromValidatedMarket({
                nowTs,
                tickContext,
                market: freshMarket,
                selectedTokenId: preorder.selectedTokenId,
                chosenSide: executionSide,
                chosenDirection,
                selectionSource:
                  selectionSource && selectionSource !== "committed"
                    ? selectionSource
                    : this.inferSelectionSourceFromStartSec(
                        this.getCanonicalBtc5mTimingFromSlugOrRow({
                          slug: this.getMarketDeterministicSlug(freshMarket),
                          rowStartTs: freshMarket.startTs ?? null,
                          rowEndTs: freshMarket.endTs ?? null
                        }).startSec,
                        tickBucket
                      ),
                liveValidationReason: "preorder_validated",
                logRecovery: !this.getActiveLiveCommittedSelection(nowTs)
              });
              if (recoveredSelection) {
                selectedSlug = recoveredSelection.selectedSlug;
                selectedWindowStart = recoveredSelection.windowStartTs;
                selectedWindowEnd = recoveredSelection.windowEndTs;
                selectedCommittedTokenId = recoveredSelection.selectedTokenId;
                selectedBookable = recoveredSelection.selectedBookable;
                selectedTradable = recoveredSelection.selectedTradable;
                selectionSource = recoveredSelection.selectionSource;
                liveValidationReason = recoveredSelection.liveValidationReason;
                selectedChosenSide = recoveredSelection.chosenSide;
                selectedChosenDirection = recoveredSelection.chosenDirection;
              }
              if (executionSide === "YES") {
                const executionYesBook = await this.getImpliedYesBook(freshMarket, {
                  isSelectedMarket: true,
                  remainingSec: preorder.remainingSec ?? remainingSec
                });
                const executableYesAsk =
                  executionYesBook.bookable && Number.isFinite(Number(executionYesBook.yesAsk)) && Number(executionYesBook.yesAsk) > 0
                    ? clamp(Number(executionYesBook.yesAsk), 0.0001, 0.9999)
                    : null;
                if (executableYesAsk === null) {
                  setBlocked("SIDE_NOT_BOOKABLE", "DATA_HEALTH");
                  selectedExecutionBlockedReason = "SIDE_NOT_BOOKABLE";
                  this.markLiveSelectedMarketExecutionBlocked({
                    market: freshMarket,
                    nowTs,
                    side: "YES",
                    reason: executionYesBook.source === "missing" ? "MISSING_ORDERBOOK" : "SIDE_NOT_BOOKABLE",
                    source: executionYesBook.source,
                    tokenId: preorder.selectedTokenId
                  });
                  action = "HOLD";
                  executedSize = 0;
                } else {
                  const result = await this.execution.executeBuyYes({
                    marketId: freshMarket.marketId,
                    tokenId: preorder.selectedTokenId,
                    yesAsk: executableYesAsk,
                    notionalUsd: finalOrderNotionalUsd,
                    tickSize: freshMarket.tickSize,
                    negRisk: freshMarket.negRisk
                  });
                  action = result.accepted ? "BUY_YES" : "HOLD";
                  executedSize = result.accepted ? finalOrderNotionalUsd : 0;
                  if (!result.accepted) {
                    applyResultBlockReason(result.reason || "LIVE_REJECTED");
                  }
                }
              } else {
                const executionNoBook = await this.getNoAskAndDepthFromTokenId(
                  preorder.selectedTokenId,
                  noAsk
                );
                const executableNoAsk =
                  executionNoBook.bookable && Number.isFinite(Number(executionNoBook.noAsk)) && Number(executionNoBook.noAsk) > 0
                    ? clamp(Number(executionNoBook.noAsk), 0.0001, 0.9999)
                    : null;
                if (executableNoAsk === null) {
                  setBlocked("SIDE_NOT_BOOKABLE", "DATA_HEALTH");
                  selectedExecutionBlockedReason = "SIDE_NOT_BOOKABLE";
                  this.markLiveSelectedMarketExecutionBlocked({
                    market: freshMarket,
                    nowTs,
                    side: "NO",
                    reason: executionNoBook.source === "missing" ? "MISSING_ORDERBOOK" : "SIDE_NOT_BOOKABLE",
                    source: executionNoBook.source,
                    tokenId: preorder.selectedTokenId
                  });
                  action = "HOLD";
                  executedSize = 0;
                } else {
                  const result = await this.execution.executeBuyNo({
                    marketId: freshMarket.marketId,
                    tokenId: preorder.selectedTokenId,
                    noAsk: executableNoAsk,
                    notionalUsd: finalOrderNotionalUsd,
                    tickSize: freshMarket.tickSize,
                    negRisk: freshMarket.negRisk
                  });
                  action = result.accepted ? "BUY_NO" : "HOLD";
                  executedSize = result.accepted ? finalOrderNotionalUsd : 0;
                  if (!result.accepted) {
                    applyResultBlockReason(result.reason || "LIVE_REJECTED");
                  }
                }
              }
            }
          }
        }
      } else {
        action = "HOLD";
        executedSize = 0;
      }
      if (action === "HOLD" && !blockReason) {
        if (strategyBlock || dataHealthBlock) {
          blockReason = dataHealthBlock || strategyBlock || "EDGE_BELOW_THRESHOLD";
        } else if (!paperMode && !sizingCheck.passes && sizingRejectBlockReason) {
          blockReason = sizingRejectBlockReason;
          blockedCategory = "RISK";
          strategyBlock = sizingRejectBlockReason;
        } else if (paperMode && !sizingCheck.passes) {
          const notionalText = Number(finalOrderNotionalUsd || 0).toFixed(4);
          const minNotionalText = Number(sizingCheck.minOrderNotional || 0).toFixed(4);
          blockReason = `SIZE_BELOW_MIN_NOTIONAL effectiveNotionalUsd=${notionalText} minNotionalUsd=${minNotionalText}`;
          strategyBlock = blockReason;
          blockedCategory = "RISK";
        } else {
          const liveValidationUpper = String(liveValidationReason || "").trim().toUpperCase();
          const normalizedSelectedBlock =
            normalizeHoldReason(selectedExecutionBlockedReason || this.persistedPolymarketSnapshot.executionBlockedReason || "") || null;
          if (
            !paperMode &&
            (liveValidationUpper === "PRICE_REFRESH_FAILED_ACTIVE_MARKET" ||
              liveValidationUpper === "QUOTE_FAILURE" ||
              liveValidationUpper === "TRANSIENT_QUOTE_FAILURE" ||
              liveValidationUpper === "EMPTY_LIVE_QUOTE" ||
              this.persistedPolymarketSnapshot.staleState === "ACTIVE_MARKET_PRICE_STALE")
          ) {
            blockReason = "PRICE_FETCH_FAILED";
          } else if (
            !paperMode &&
            (liveValidationUpper === "REFRESH_FAILED_ACTIVE_MARKET" ||
              this.persistedPolymarketSnapshot.staleState === "ACTIVE_MARKET_REFRESH_FAILED")
          ) {
            blockReason = "ACTIVE_MARKET_REFRESH_FAILED";
          } else if (normalizedSelectedBlock) {
            blockReason = normalizedSelectedBlock;
          } else if (!paperMode && remainingSec <= this.getLiveEntryMinRemainingSec()) {
            blockReason = "TOO_LATE_FOR_ENTRY";
          } else if (!paperMode && (!selectedTokenId || !selectedBookable || !selectedTradable)) {
            blockReason = "SIDE_NOT_BOOKABLE";
          } else if (!paperMode && this.execution.getPositions().some((position) => position.marketId === market.marketId)) {
            blockReason = "EXIT_NOT_TRIGGERED";
          } else {
            blockReason = "EDGE_BELOW_THRESHOLD";
          }
          const normalizedBlockReason = normalizeHoldReason(blockReason) || "EDGE_BELOW_THRESHOLD";
          blockReason = normalizedBlockReason;
          blockedCategory =
            normalizedBlockReason === "SIDE_NOT_BOOKABLE" ||
            normalizedBlockReason === "ACTIVE_MARKET_REFRESH_FAILED" ||
            normalizedBlockReason === "PRICE_FETCH_FAILED"
              ? "DATA_HEALTH"
              : normalizedBlockReason === "SIZE_BELOW_MIN_NOTIONAL" ||
                  normalizedBlockReason === "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED"
                ? "RISK"
                : "STRATEGY";
          if (blockedCategory === "DATA_HEALTH") {
            dataHealthBlock = normalizedBlockReason;
          } else {
            strategyBlock = normalizedBlockReason;
          }
        }
      }
      if (action === "HOLD") {
        const prioritizedBlockReason = resolvePriorityBlockedReason({
          currentReason: blockReason,
          fairPriceSource: fairPriceSourceTelemetry,
          extremePriceFilterHit: extremePriceFilterHitCandidate,
          dislocationAbs: dislocationAbsTelemetry,
          minDislocationConfig: minDislocationConfigTelemetry,
          sizingRejectReason: sizingRejectBlockReason,
          configFeasible
        });
        if (prioritizedBlockReason) {
          blockReason = prioritizedBlockReason;
          riskBlockReasonInternal = prioritizedBlockReason;
          blockedCategory = classifyHoldCategory(prioritizedBlockReason);
          if (blockedCategory === "DATA_HEALTH") {
            dataHealthBlock = prioritizedBlockReason;
          } else {
            strategyBlock = prioritizedBlockReason;
          }
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
      const bookabilityFailReasonTelemetry = deriveBookabilityFailReason({
        blockedReason: blockReason,
        selectedTokenId,
        selectedBookable:
          selectedMarket?.marketId === market.marketId
            ? this.persistedPolymarketSnapshot.selectedBookable
            : selectedBookable,
        selectedSideBookabilityReason,
        liveValidationReason
      });
      const tradabilityFailReasonTelemetry = deriveTradabilityFailReason({
        blockedReason: blockReason,
        selectedTradable:
          selectedMarket?.marketId === market.marketId
            ? this.persistedPolymarketSnapshot.selectedTradable
            : selectedTradable,
        liveValidationReason,
        acceptingOrders: selectedAcceptingOrders
      });
      const blockerSourceTelemetry = deriveBlockerSourceTelemetry({
        blockedCategory,
        blockedReason: blockReason,
        bookabilityFailReason: bookabilityFailReasonTelemetry,
        tradabilityFailReason: tradabilityFailReasonTelemetry
      });
      const extremePriceFilterHitTelemetry =
        extremePriceFilterHitCandidate ||
        normalizeHoldReason(blockReason || "") === "EXTREME_PRICE_FILTER";
      const blockerPriorityAppliedTelemetry = isPriorityBlockerReason(normalizeHoldReason(blockReason || ""));
      processedEvaluatedMarket = true;
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
        noBid: noBidTelemetry,
        noAsk,
        yesMid: decision.yesMid,
        yesSpread: yesSpreadTelemetry,
        noSpread: noSpreadTelemetry,
        outcomePricesHint: Array.isArray(market.outcomePricesHint) ? market.outcomePricesHint : null,
        fairYes: fairYesTelemetry,
        fairPriceSource: fairPriceSourceTelemetry,
        fairPriceModelOrigin: fairPriceModelOriginTelemetry,
        chosenSidePriceUsed: chosenSidePriceUsedTelemetry,
        dislocationAbs: dislocationAbsTelemetry,
        minDislocationConfig: minDislocationConfigTelemetry,
        extremePriceFilterHit: extremePriceFilterHitTelemetry,
        blockerPriorityApplied: blockerPriorityAppliedTelemetry,
        feeBpsUsed: feeBpsUsedTelemetry,
        slippageBpsUsed: slippageBpsUsedTelemetry,
        safetyBpsUsed: safetyBpsUsedTelemetry,
        baseTargetNotional: sizingCheck.baseTargetNotional,
        cappedNotional: sizingCheck.cappedNotional,
        computedOrderNotional: finalOrderNotionalUsd,
        computedShares: finalOrderShares,
        maxAchievableShares,
        configFeasible,
        minOrderNotionalConfig: sizingCheck.minOrderNotional,
        minSharesRequired: sizingCheck.minVenueShares,
        minSharesRequiredConfig,
        maxNotionalPerWindowConfig: sizingCheck.maxNotionalPerWindow,
        sizingCapApplied: sizingCheck.sizingCapApplied,
        sizingRejectReason:
          blockReason === "CONFIG_INFEASIBLE_MIN_SHARES" ? "CONFIG_INFEASIBLE_MIN_SHARES" : sizingCheck.sizingRejectReason,
        blockerSource: blockerSourceTelemetry,
        riskBlockReasonInternal: riskBlockReasonInternal || (blockReason || null),
        bookabilityFailReason: bookabilityFailReasonTelemetry,
        tradabilityFailReason: tradabilityFailReasonTelemetry,
        tokenLiquiditySnapshot: {
          yesBid: Number.isFinite(Number(decision.yesBid)) ? Number(decision.yesBid) : null,
          yesAsk: Number.isFinite(Number(decision.yesAsk)) ? Number(decision.yesAsk) : null,
          noBid: Number.isFinite(Number(noBidTelemetry)) ? Number(noBidTelemetry) : null,
          noAsk: Number.isFinite(Number(noAsk)) ? Number(noAsk) : null,
          yesSpread: Number.isFinite(Number(yesSpreadTelemetry)) ? Number(yesSpreadTelemetry) : null,
          noSpread: Number.isFinite(Number(noSpreadTelemetry)) ? Number(noSpreadTelemetry) : null
        },
        rawYesEdgeBeforeCosts: edgeYes,
        rawNoEdgeBeforeCosts: edgeNo,
        yesEdgeAfterCosts: netEdgeYes,
        noEdgeAfterCosts: netEdgeNo,
        chosenEdgeBeforeClamp: chosenEdgeBeforeClampTelemetry,
        chosenEdgeAfterClamp: chosenEdgeAfterClampTelemetry,
        edgeClampReason: deriveEdgeClampReason({
          chosenEdgeBeforeClamp: chosenEdgeBeforeClampTelemetry,
          blockReason
        }),
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
        chosenSide: chosenSide ?? undefined,
        chosenDirection,
        chosenEdge,
        conviction,
        stalenessEdge,
        netEdgeAfterCosts,
        score: sharedDecision.score,
        threshold: decision.threshold,
        action,
        holdReason: action === "HOLD" ? blockReason || null : null,
        holdDetailReason: action === "HOLD" ? blockReason || dominantReject : null,
        paperWouldTrade: sharedDecision.paperWouldTrade,
        liveWouldTrade: action === "BUY_YES" || action === "BUY_NO",
        blockedBy: action === "HOLD" ? blockReason || null : null,
        blockedCategory: action === "HOLD" ? blockedCategory : null,
        strategyBlock: action === "HOLD" ? strategyBlock : null,
        dataHealthBlock: action === "HOLD" ? dataHealthBlock : null,
        staleState:
          action === "HOLD" &&
          (blockReason === "REFRESH_FAILED_ACTIVE_MARKET" ||
            String(liveValidationReason || "").trim().toUpperCase() === "REFRESH_FAILED_ACTIVE_MARKET")
            ? "ACTIVE_MARKET_REFRESH_FAILED"
            : action === "HOLD" &&
                (blockReason === "PRICE_REFRESH_FAILED_ACTIVE_MARKET" ||
                  blockReason === "PRICE_FETCH_FAILED_ACTIVE_MARKET" ||
                  String(liveValidationReason || "").trim().toUpperCase() === "PRICE_REFRESH_FAILED_ACTIVE_MARKET")
              ? "ACTIVE_MARKET_PRICE_STALE"
              : null,
        selectedTokenId,
        selectedBookable:
          selectedMarket?.marketId === market.marketId
            ? this.persistedPolymarketSnapshot.selectedBookable
            : selectedBookable,
        selectedTradable:
          selectedMarket?.marketId === market.marketId
            ? this.persistedPolymarketSnapshot.selectedTradable
            : selectedTradable,
        discoveredCurrent:
          selectedMarket?.marketId === market.marketId
            ? this.persistedPolymarketSnapshot.discoveredCurrent
            : discoveredCurrent,
        discoveredNext:
          selectedMarket?.marketId === market.marketId
            ? this.persistedPolymarketSnapshot.discoveredNext
            : discoveredNext,
        selectionSource:
          selectedMarket?.marketId === market.marketId
            ? this.persistedPolymarketSnapshot.selectionSource
            : selectionSource,
        selectedFrom:
          selectedMarket?.marketId === market.marketId
            ? this.persistedPolymarketSnapshot.selectedFrom
            : selectedFrom,
        selectionCommitTs:
          selectedMarket?.marketId === market.marketId
            ? this.persistedPolymarketSnapshot.selectionCommitTs
            : selectionCommitTs,
        liveValidationReason:
          selectedMarket?.marketId === market.marketId
            ? this.persistedPolymarketSnapshot.liveValidationReason
            : liveValidationReason,
        lastBookTs:
          selectedMarket?.marketId === market.marketId
            ? this.persistedPolymarketSnapshot.lastBookTs
            : lastBookTs,
        lastQuoteTs:
          selectedMarket?.marketId === market.marketId
            ? this.persistedPolymarketSnapshot.lastQuoteTs
            : lastQuoteTs,
        currentBucketSlug,
        nextBucketSlug,
        currentBucketStartSec,
        candidateRefreshed,
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
        slug: this.getMarketDeterministicSlug(market) || selectedSlug || undefined,
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
        chosenSide: chosenSide ?? undefined,
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
    let finalCommittedSelection = this.getActiveLiveCommittedSelection(nowTs);
    if (this.config.polymarket.mode === "live") {
      if (finalCommittedSelection) {
        tickLog.currentMarketId = finalCommittedSelection.selectedMarketId;
        tickLog.tauSec = finalCommittedSelection.remainingSec;
        tickLog.selectedSlug = finalCommittedSelection.selectedSlug;
        tickLog.windowStart = finalCommittedSelection.windowStartTs;
        tickLog.windowEnd = finalCommittedSelection.windowEndTs;
        tickLog.acceptingOrders = finalCommittedSelection.acceptingOrders;
        tickLog.enableOrderBook = finalCommittedSelection.enableOrderBook;
        tickLog.chosenSide = finalCommittedSelection.chosenSide;
        tickLog.chosenDirection = finalCommittedSelection.chosenDirection;
        tickLog.selectedTokenId = finalCommittedSelection.selectedTokenId;
        tickLog.discoveredCurrent = finalCommittedSelection.discoveredCurrent;
        tickLog.discoveredNext = finalCommittedSelection.discoveredNext;
        tickLog.selectionSource = finalCommittedSelection.selectionSource;
        tickLog.selectedFrom = finalCommittedSelection.selectedFrom;
        tickLog.selectionCommitTs = finalCommittedSelection.selectionCommitTs;
      } else if (
        !this.persistedPolymarketSnapshot.selectedSlug &&
        !this.persistedPolymarketSnapshot.selectedMarketId
      ) {
        tickLog.currentMarketId = null;
        tickLog.tauSec = null;
        tickLog.selectedSlug = null;
        tickLog.windowStart = null;
        tickLog.windowEnd = null;
        tickLog.acceptingOrders = null;
        tickLog.enableOrderBook = null;
        tickLog.chosenSide = null;
        tickLog.chosenDirection = null;
        tickLog.selectedTokenId = null;
      }
    }
    if (!processedEvaluatedMarket) {
      tickLog.rejectCountsByStage = cloneRejectCountsByStage(rejectCountsByStage);
      tickLog.dominantReject = dominantReject;
      tickLog.sampleRejected = sampleRejected.slice(0, 5);
      tickLog.holdDetailReason = selectedExecutionBlockedReason ?? dominantReject;
      tickLog.selectedTokenId = this.persistedPolymarketSnapshot.selectedTokenId;
      tickLog.candidateRefreshed = this.persistedPolymarketSnapshot.candidateRefreshed;
      tickLog.discoveredCurrent = this.persistedPolymarketSnapshot.discoveredCurrent;
      tickLog.discoveredNext = this.persistedPolymarketSnapshot.discoveredNext;
      tickLog.selectionSource = this.persistedPolymarketSnapshot.selectionSource;
      tickLog.selectedFrom = this.persistedPolymarketSnapshot.selectedFrom;
      tickLog.selectionCommitTs = this.persistedPolymarketSnapshot.selectionCommitTs;
      if (finalCommittedSelection) {
        tickLog.currentMarketId = finalCommittedSelection.selectedMarketId;
        tickLog.tauSec = finalCommittedSelection.remainingSec;
        tickLog.selectedSlug = finalCommittedSelection.selectedSlug;
        tickLog.windowStart = finalCommittedSelection.windowStartTs;
        tickLog.windowEnd = finalCommittedSelection.windowEndTs;
        tickLog.acceptingOrders = finalCommittedSelection.acceptingOrders;
        tickLog.enableOrderBook = finalCommittedSelection.enableOrderBook;
        tickLog.chosenSide = finalCommittedSelection.chosenSide;
        tickLog.chosenDirection = finalCommittedSelection.chosenDirection;
        tickLog.selectedTokenId =
          finalCommittedSelection.chosenSide === "NO"
            ? finalCommittedSelection.noTokenId
            : finalCommittedSelection.yesTokenId;
      }
      tickLog.holdReason = this.deriveCanonicalHoldReason(tickLog);
      const unresolvedHoldReason = String(tickLog.holdDetailReason || tickLog.holdReason || "").trim().toUpperCase();
      if (unresolvedHoldReason.includes("REFRESH_FAILED_ACTIVE_MARKET")) {
        tickLog.staleState = "ACTIVE_MARKET_REFRESH_FAILED";
      } else if (
        unresolvedHoldReason.includes("PRICE_REFRESH_FAILED_ACTIVE_MARKET") ||
        unresolvedHoldReason.includes("PRICE_FETCH_FAILED_ACTIVE_MARKET")
      ) {
        tickLog.staleState = "ACTIVE_MARKET_PRICE_STALE";
      }
    }
    if (
      this.config.polymarket.mode === "live" &&
      (Number(tickLog.afterWindowCount || 0) > 0 || Number(tickLog.finalCandidatesCount || 0) > 0) &&
      !tickLog.selectedSlug &&
      !tickLog.currentMarketId
    ) {
      const recoveryValidationReason =
        liveValidationReason ?? validatedLiveValidationReason ?? this.persistedPolymarketSnapshot.liveValidationReason;
      const recoveryValidationUpper = String(recoveryValidationReason || "").trim().toUpperCase();
      const canRecoverFromValidation =
        recoveryValidationUpper.startsWith("TRADABLE_") || recoveryValidationUpper === "PREORDER_VALIDATED";
      if (!finalCommittedSelection && canRecoverFromValidation) {
        const recoverMarket = validatedLiveMarket ?? selectedMarket;
        const recoverChosenSide = validatedLiveChosenSide ?? selectedChosenSide;
        const recoverTokenId =
          validatedLiveTokenId ??
          selectedCommittedTokenId ??
          (recoverChosenSide === "NO"
            ? String(recoverMarket?.noTokenId || "").trim() || null
            : String(recoverMarket?.yesTokenId || "").trim() || null);
        const recoverChosenDirection = validatedLiveChosenDirection ?? selectedChosenDirection;
        if (recoverMarket && recoverTokenId) {
          finalCommittedSelection = this.recoverLiveSelectionFromValidatedMarket({
            nowTs,
            tickContext,
            market: recoverMarket,
            selectedTokenId: recoverTokenId,
            chosenSide: recoverChosenSide,
            chosenDirection: recoverChosenDirection,
            selectionSource:
              selectionSource && selectionSource !== "committed"
                ? selectionSource
                : this.inferSelectionSourceFromStartSec(
                    this.getCanonicalBtc5mTimingFromSlugOrRow({
                      slug: this.getMarketDeterministicSlug(recoverMarket),
                      rowStartTs: recoverMarket.startTs ?? null,
                      rowEndTs: recoverMarket.endTs ?? null
                    }).startSec,
                    tickBucket
                  ),
            liveValidationReason: recoveryValidationReason || "preorder_validated",
            logRecovery: true
          });
          if (finalCommittedSelection) {
            tickLog.currentMarketId = finalCommittedSelection.selectedMarketId;
            tickLog.tauSec = finalCommittedSelection.remainingSec;
            tickLog.selectedSlug = finalCommittedSelection.selectedSlug;
            tickLog.windowStart = finalCommittedSelection.windowStartTs;
            tickLog.windowEnd = finalCommittedSelection.windowEndTs;
            tickLog.acceptingOrders = finalCommittedSelection.acceptingOrders;
            tickLog.enableOrderBook = finalCommittedSelection.enableOrderBook;
            tickLog.chosenSide = finalCommittedSelection.chosenSide;
            tickLog.chosenDirection = finalCommittedSelection.chosenDirection;
            tickLog.selectedTokenId = finalCommittedSelection.selectedTokenId;
            liveValidationReason = finalCommittedSelection.liveValidationReason ?? liveValidationReason;
          }
        }
      }
      if (!tickLog.selectedSlug && !tickLog.currentMarketId) {
        tickLog.action = "HOLD";
        tickLog.holdDetailReason = "SELECTION_NOT_COMMITTED";
        tickLog.dominantReject = "SELECTION_NOT_COMMITTED";
        tickLog.holdReason = "SELECTION_NOT_COMMITTED";
        tickLog.blockedBy = "SELECTION_NOT_COMMITTED";
        tickLog.blockedCategory = "EXECUTION";
        tickLog.strategyBlock = "SELECTION_NOT_COMMITTED";
        tickLog.dataHealthBlock = null;
        this.logger.error(
          {
            fetchedCount: Number(tickLog.fetchedCount ?? stageCounts.fetchedCount ?? 0),
            afterWindowCount: Number(tickLog.afterWindowCount ?? stageCounts.afterWindowCount ?? 0),
            finalCandidatesCount: Number(tickLog.finalCandidatesCount ?? stageCounts.finalCandidatesCount ?? 0),
            attemptedSlugs: deterministicAttemptedSlugs,
            selectedMarketId: selectedMarket?.marketId ?? validatedLiveMarket?.marketId ?? null,
            selectedMarketSlug:
              (selectedMarket ? this.getMarketDeterministicSlug(selectedMarket) : null) ||
              (validatedLiveMarket ? this.getMarketDeterministicSlug(validatedLiveMarket) : null),
            selectedTokenId: tickLog.selectedTokenId ?? this.persistedPolymarketSnapshot.selectedTokenId,
            liveValidationReason: liveValidationReason ?? this.persistedPolymarketSnapshot.liveValidationReason,
            dominantReject
          },
          "POLY_BTC5M_SELECTION_INVARIANT_FINAL_CANDIDATE_WITHOUT_COMMIT"
        );
        this.emitSelectionBugLine({
          currentBucketSlug: currentBucketSlug ?? this.persistedPolymarketSnapshot.currentBucketSlug,
          nextBucketSlug: nextBucketSlug ?? this.persistedPolymarketSnapshot.nextBucketSlug,
          fetchedCount: Number(tickLog.fetchedCount ?? stageCounts.fetchedCount ?? 0),
          afterWindowCount: Number(tickLog.afterWindowCount ?? stageCounts.afterWindowCount ?? 0),
          finalCandidatesCount: Number(tickLog.finalCandidatesCount ?? stageCounts.finalCandidatesCount ?? 0),
          selectedSlug: null,
          selectedTokenId: tickLog.selectedTokenId ?? this.persistedPolymarketSnapshot.selectedTokenId,
          liveValidationReason: liveValidationReason ?? this.persistedPolymarketSnapshot.liveValidationReason,
          attemptedSlugs: deterministicAttemptedSlugs
        });
      }
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

  private normalizeLiveBlockReason(reason: string | null | undefined): string {
    const raw = String(reason || "").trim();
    const upper = raw.toUpperCase();
    if (!upper) {
      return "HOLD_UNSPECIFIED";
    }
    if (upper.includes("SIZE (") && upper.includes("LOWER THAN THE MINIMUM: 5")) {
      return "ORDER_SIZE_BELOW_MIN_SHARES";
    }
    if (upper.includes("ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED")) {
      return "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED";
    }
    if (upper.includes("ORDER_SIZE_BELOW_MIN_SHARES")) {
      return "ORDER_SIZE_BELOW_MIN_SHARES";
    }
    if (
      upper.includes("PRICE_FETCH_FAILED") ||
      upper.includes("PRICE_REFRESH_FAILED_ACTIVE_MARKET") ||
      upper.includes("QUOTE_FAILURE") ||
      upper.includes("TRANSIENT_QUOTE_FAILURE") ||
      upper.includes("EMPTY_LIVE_QUOTE")
    ) {
      return "PRICE_UNAVAILABLE";
    }
    if (upper.includes("NO ORDERBOOK EXISTS") || upper.includes("MISSING_ORDERBOOK")) {
      return "SIDE_NOT_BOOKABLE";
    }
    if (upper.includes("INVALID_SIGNATURE")) {
      return "ORDER_POST_REJECTED";
    }
    if (upper.includes("ORDER_FAILED") || upper.includes("LIVE_REJECTED")) {
      return "ORDER_POST_REJECTED";
    }
    const normalized = normalizeHoldReason(raw);
    if (!normalized) {
      return "HOLD_UNSPECIFIED";
    }
    if (
      normalized === "PRICE_FETCH_FAILED" ||
      normalized === "PRICE_REFRESH_FAILED_ACTIVE_MARKET" ||
      normalized === "ACTIVE_MARKET_PRICE_STALE"
    ) {
      return "PRICE_UNAVAILABLE";
    }
    if (normalized === "LIVE_REJECTED" || normalized === "ORDER_FAILED") {
      return "ORDER_POST_REJECTED";
    }
    return normalized;
  }

  private normalizeTransientErrorSignature(error: unknown): string {
    const normalized = this.shortErrorText(error).trim().toUpperCase();
    if (!normalized) return "ERROR";
    if (normalized.includes("ECONNRESET")) return "ECONNRESET";
    if (normalized.includes("EPIPE")) return "EPIPE";
    if (normalized.includes("ETIMEDOUT") || normalized.includes("TIMEOUT")) return "TIMEOUT";
    if (normalized.includes("ENOTFOUND")) return "ENOTFOUND";
    if (normalized.includes("HTTP 429")) return "HTTP_429";
    return normalized.replace(/\bbtc-updown-5m-\d+\b/g, "BTC5M_SLUG");
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

  private syncSelectedMarketFeed(
    activeSelection: (LiveCommittedSelection & { remainingSec: number }) | null,
    selectedMarket: BtcWindowMarket | null
  ): void {
    const marketId = String(activeSelection?.selectedMarketId || selectedMarket?.marketId || "").trim();
    const tokenIds = Array.from(
      new Set(
        [
          String(activeSelection?.yesTokenId || "").trim(),
          String(activeSelection?.noTokenId || "").trim(),
          String(selectedMarket?.yesTokenId || "").trim(),
          String(selectedMarket?.noTokenId || "").trim()
        ].filter((value) => value.length > 0)
      )
    );
    if (!marketId || tokenIds.length === 0) {
      this.selectedMarketFeed.setSelectedMarket(null);
      return;
    }
    this.selectedMarketFeed.setSelectedMarket({
      marketId,
      slug: String(activeSelection?.selectedSlug || this.getMarketDeterministicSlug(selectedMarket) || "").trim() || null,
      tokenIds
    });
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

  private isBookableYesSnapshot(snapshot: YesBookSnapshot | null): boolean {
    return Boolean(
      snapshot &&
        Number.isFinite(snapshot.yesBid) &&
        Number.isFinite(snapshot.yesAsk) &&
        Number.isFinite(snapshot.yesMid) &&
        snapshot.yesBid >= 0 &&
        snapshot.yesAsk > 0 &&
        snapshot.yesAsk >= snapshot.yesBid
    );
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

  private isBookableNoSnapshot(snapshot: TokenBookSnapshot | null): boolean {
    return Boolean(snapshot && Number.isFinite(snapshot.bestAsk) && Number(snapshot.bestAsk) > 0);
  }

  private logLiveCandidateOrderbookRejection(params: {
    marketId: string;
    slug: string | null;
    side: "YES" | "NO";
    tokenId: string | null;
    source: BookLookupSource;
    reason: string;
  }): void {
    this.logger.warn(
      {
        marketId: params.marketId,
        slug: params.slug,
        side: params.side,
        tokenId: params.tokenId,
        source: params.source,
        reason: params.reason
      },
      "Rejecting live candidate due to missing or non-bookable orderbook"
    );
  }

  private async getImpliedYesBook(market: {
    marketId: string;
    yesTokenId: string;
    yesDisplayLabel?: string;
    question?: string;
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
  ): Promise<YesBookLookup> {
    const nowTs = Date.now();
    const remainingSec = Number(options.remainingSec);
    const shouldPreferCachedSnapshot =
      Boolean(options.isSelectedMarket) &&
      ((this.config.polymarket.mode === "live" && (!Number.isFinite(remainingSec) || remainingSec > 0)) ||
        this.isInsidePaperEntryWindow(remainingSec));
    const cachedSnapshot = shouldPreferCachedSnapshot
      ? this.getCachedYesBookSnapshot(market.marketId, nowTs)
      : null;
    const wsTokenTop = options.isSelectedMarket
      ? this.selectedMarketFeed.getTokenTopOfBook(
          market.yesTokenId,
          nowTs,
          Math.max(3_000, this.config.polymarket.loopMs * 4)
        )
      : null;
    if (
      wsTokenTop &&
      Number.isFinite(Number(wsTokenTop.bestBid)) &&
      Number.isFinite(Number(wsTokenTop.bestAsk)) &&
      Number(wsTokenTop.bestBid) >= 0 &&
      Number(wsTokenTop.bestAsk) > 0 &&
      Number(wsTokenTop.bestAsk) >= Number(wsTokenTop.bestBid)
    ) {
      const snapshot = {
        yesBid: clamp(Number(wsTokenTop.bestBid), 0, 1),
        yesAsk: clamp(Number(wsTokenTop.bestAsk), Math.max(0, Number(wsTokenTop.bestBid)), 1),
        yesMid: clamp((Number(wsTokenTop.bestBid) + Number(wsTokenTop.bestAsk)) / 2, 0, 1),
        spread: Math.max(0, Number(wsTokenTop.bestAsk) - Number(wsTokenTop.bestBid)),
        topBidSize: Math.max(0, Number(wsTokenTop.topBidSize || 0)),
        topAskSize: Math.max(0, Number(wsTokenTop.topAskSize || 0)),
        bookTs: toMs(wsTokenTop.ts || nowTs)
      } satisfies YesBookSnapshot;
      this.cacheYesBookSnapshot(market.marketId, snapshot);
      this.cacheTokenBookSnapshot(market.yesTokenId, {
        bestBid: snapshot.yesBid,
        bestAsk: snapshot.yesAsk,
        bookTs: snapshot.bookTs,
        markSource: "WS_MID"
      });
      return { ...snapshot, source: "live", bookable: true };
    }
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
        return { ...snapshot, source: "live", bookable: true };
      }
      return {
        yesBid: Number.NaN,
        yesAsk: Number.NaN,
        yesMid: Number.NaN,
        spread: Number.NaN,
        topBidSize: 0,
        topAskSize: 0,
        bookTs: toMs(orderBook.ts || nowTs),
        source: "live",
        bookable: false
      };
    } catch (error) {
      const transient = isTransientPolymarketError(error);
      const missingOrderbook = isMissingOrderbookError(error);
      if (transient) {
        this.markReadPathWarning("NETWORK_ERROR");
      }
      this.maybeLogBookFallbackWarning(
        "Failed to fetch YES orderbook; using fallback implied prices",
        {
          side: "YES",
          marketId: market.marketId,
          tokenId: market.yesTokenId,
          remainingSec: Number.isFinite(remainingSec) ? remainingSec : null,
          selectedMarket: Boolean(options.isSelectedMarket),
          usedCachedSnapshot: Boolean(cachedSnapshot) && !missingOrderbook,
          transient,
          missingOrderbook,
          error
        }
      );
      if (cachedSnapshot && !missingOrderbook) {
        return {
          ...cachedSnapshot,
          source: "cached",
          bookable: this.isBookableYesSnapshot(cachedSnapshot)
        };
      }
      if (missingOrderbook) {
        return {
          yesBid: Number.NaN,
          yesAsk: Number.NaN,
          yesMid: Number.NaN,
          spread: Number.NaN,
          topBidSize: 0,
          topAskSize: 0,
          bookTs: toMs(nowTs),
          source: "missing",
          bookable: false
        };
      }
    }

    if (cachedSnapshot) {
      return {
        ...cachedSnapshot,
        source: "cached",
        bookable: this.isBookableYesSnapshot(cachedSnapshot)
      };
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
      bookTs: toMs(nowTs),
      source: "inferred",
      bookable: false
    };
  }

  private async getDecisionYesPrice(market: {
    marketId: string;
    slug?: string | null;
    eventSlug?: string | null;
    yesTokenId: string;
    yesBidHint?: number;
    yesAskHint?: number;
    yesMidHint?: number;
    yesLastTradeHint?: number;
    outcomePricesHint?: number[];
  }): Promise<DecisionPriceLookup> {
    const nowTs = Date.now();
    const cachedYesSnapshot = this.getCachedYesBookSnapshot(market.marketId, nowTs);
    const cachedTokenSnapshot = this.getCachedTokenBookSnapshot(market.yesTokenId, nowTs);
    const wsTokenTop = this.selectedTokenIds.includes(String(market.yesTokenId || "").trim())
      ? this.selectedMarketFeed.getTokenTopOfBook(
          market.yesTokenId,
          nowTs,
          Math.max(3_000, this.config.polymarket.loopMs * 4)
        )
      : null;
    if (
      wsTokenTop &&
      Number.isFinite(Number(wsTokenTop.bestBid)) &&
      Number.isFinite(Number(wsTokenTop.bestAsk)) &&
      Number(wsTokenTop.bestBid) > 0 &&
      Number(wsTokenTop.bestAsk) > 0
    ) {
      const bid = clamp(Number(wsTokenTop.bestBid), 0.0001, 0.9999);
      const ask = clamp(Number(wsTokenTop.bestAsk), bid, 0.9999);
      const mid = clamp((bid + ask) / 2, bid, ask);
      this.cacheTokenBookSnapshot(market.yesTokenId, {
        bestBid: bid,
        bestAsk: ask,
        bookTs: toMs(wsTokenTop.ts || nowTs),
        markSource: "WS_MID"
      });
      return {
        bid,
        ask,
        mid,
        price: mid,
        spread: Math.max(0, ask - bid),
        topBidSize: Math.max(0, Number(wsTokenTop.topBidSize || 0)),
        topAskSize: Math.max(0, Number(wsTokenTop.topAskSize || 0)),
        ts: toMs(wsTokenTop.ts || nowTs),
        source: "live",
        priceFetchFailed: false
      };
    }
    try {
      const quote = await this.client.getTokenPriceQuote(market.yesTokenId, {
        slug: this.getMarketDeterministicSlug(market)
      });
      const bid =
        Number.isFinite(Number(quote.bestBid)) && Number(quote.bestBid) > 0
          ? clamp(Number(quote.bestBid), 0.0001, 0.9999)
          : clamp(Number(quote.mid), 0.0001, 0.9999);
      const ask =
        Number.isFinite(Number(quote.bestAsk)) && Number(quote.bestAsk) > 0
          ? clamp(Number(quote.bestAsk), bid, 0.9999)
          : clamp(Number(quote.mid), bid, 0.9999);
      const mid = clamp(Number(quote.mid), Math.min(bid, ask), Math.max(bid, ask));
      this.cacheTokenBookSnapshot(market.yesTokenId, {
        bestBid: bid,
        bestAsk: ask,
        bookTs: toMs(quote.ts || nowTs),
        markSource: quote.source.toUpperCase()
      });
      return {
        bid,
        ask,
        mid,
        price: clamp(Number(quote.price), 0.0001, 0.9999),
        spread: Math.max(0, ask - bid),
        topBidSize: cachedYesSnapshot?.topBidSize ?? 1_000_000,
        topAskSize: cachedYesSnapshot?.topAskSize ?? 1_000_000,
        ts: toMs(quote.ts || nowTs),
        source: "live",
        priceFetchFailed: quote.fetchFailed
      };
    } catch (error) {
      if (isTransientPolymarketError(error)) {
        this.markReadPathWarning("NETWORK_ERROR");
      }
      if (cachedYesSnapshot) {
        return {
          bid: cachedYesSnapshot.yesBid,
          ask: cachedYesSnapshot.yesAsk,
          mid: cachedYesSnapshot.yesMid,
          price: cachedYesSnapshot.yesMid,
          spread: cachedYesSnapshot.spread,
          topBidSize: cachedYesSnapshot.topBidSize,
          topAskSize: cachedYesSnapshot.topAskSize,
          ts: cachedYesSnapshot.bookTs,
          source: "cached",
          priceFetchFailed: true
        };
      }
      const hintedMid =
        (Number.isFinite(Number(market.yesMidHint)) ? Number(market.yesMidHint) : 0) ||
        (Number.isFinite(Number(market.yesLastTradeHint)) ? Number(market.yesLastTradeHint) : 0) ||
        (Array.isArray(market.outcomePricesHint) && market.outcomePricesHint.length > 0
          ? Number(market.outcomePricesHint[0] || 0)
          : 0) ||
        cachedTokenSnapshot?.mark ||
        0.5;
      const hintedBid =
        (Number.isFinite(Number(market.yesBidHint)) ? Number(market.yesBidHint) : 0) ||
        cachedTokenSnapshot?.bestBid ||
        hintedMid;
      const hintedAsk =
        (Number.isFinite(Number(market.yesAskHint)) ? Number(market.yesAskHint) : 0) ||
        cachedTokenSnapshot?.bestAsk ||
        hintedMid;
      const bid = clamp(hintedBid, 0.0001, 0.9999);
      const ask = clamp(hintedAsk, bid, 0.9999);
      return {
        bid,
        ask,
        mid: clamp(hintedMid, bid, ask),
        price: clamp(hintedMid, 0.0001, 0.9999),
        spread: Math.max(0, ask - bid),
        topBidSize: 1_000_000,
        topAskSize: 1_000_000,
        ts: nowTs,
        source: cachedTokenSnapshot ? "cached" : "inferred",
        priceFetchFailed: true
      };
    }
  }

  private async getNoBookFromTokenId(tokenId: string): Promise<TokenBookLookup | null> {
    const nowTs = Date.now();
    const cachedSnapshot = this.getCachedTokenBookSnapshot(tokenId, nowTs);
    const wsTokenTop = this.selectedTokenIds.includes(String(tokenId || "").trim())
      ? this.selectedMarketFeed.getTokenTopOfBook(
          tokenId,
          nowTs,
          Math.max(3_000, this.config.polymarket.loopMs * 4)
        )
      : null;
    if (
      wsTokenTop &&
      ((Number.isFinite(Number(wsTokenTop.bestBid)) && Number(wsTokenTop.bestBid) > 0) ||
        (Number.isFinite(Number(wsTokenTop.bestAsk)) && Number(wsTokenTop.bestAsk) > 0))
    ) {
      const bestBid =
        Number.isFinite(Number(wsTokenTop.bestBid)) && Number(wsTokenTop.bestBid) > 0
          ? clamp(Number(wsTokenTop.bestBid), 0.0001, 0.9999)
          : null;
      const bestAsk =
        Number.isFinite(Number(wsTokenTop.bestAsk)) && Number(wsTokenTop.bestAsk) > 0
          ? clamp(Number(wsTokenTop.bestAsk), 0.0001, 0.9999)
          : null;
      const bookTs = toMs(wsTokenTop.ts || nowTs);
      this.cacheTokenBookSnapshot(tokenId, {
        bestBid,
        bestAsk,
        bookTs,
        markSource: "WS_MID"
      });
      return {
        bestBid,
        bestAsk,
        topBidSize: Math.max(0, Number(wsTokenTop.topBidSize || 0)),
        topAskSize: Math.max(0, Number(wsTokenTop.topAskSize || 0)),
        bookTs,
        source: "live",
        bookable: bestAsk !== null && bestAsk > 0
      };
    }
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
        bookTs,
        source: "live",
        bookable: bestAsk !== null && bestAsk > 0
      };
    } catch (error) {
      const transient = isTransientPolymarketError(error);
      const missingOrderbook = isMissingOrderbookError(error);
      if (transient) {
        this.markReadPathWarning("NETWORK_ERROR");
      }
      this.maybeLogBookFallbackWarning(
        "Failed to fetch NO orderbook; using inferred NO prices",
        {
          side: "NO",
          tokenId,
          transient,
          missingOrderbook,
          error
        }
      );
      if (cachedSnapshot && !missingOrderbook) {
        return {
          bestBid: cachedSnapshot.bestBid,
          bestAsk: cachedSnapshot.bestAsk,
          topBidSize: 0,
          topAskSize: 0,
          bookTs: cachedSnapshot.bookTs,
          source: "cached",
          bookable: this.isBookableNoSnapshot(cachedSnapshot)
        };
      }
      if (missingOrderbook) {
        return {
          bestBid: null,
          bestAsk: null,
          topBidSize: 0,
          topAskSize: 0,
          bookTs: toMs(nowTs),
          source: "missing",
          bookable: false
        };
      }
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
  ): Promise<{ noAsk: number; topAskSize: number; source: BookLookupSource; bookable: boolean }> {
    const noBook = await this.getNoBookFromTokenId(tokenId);
    if (!noBook) {
      return {
        noAsk: clamp(fallbackNoAsk, 0.0001, 0.9999),
        topAskSize: 0,
        source: "inferred",
        bookable: false
      };
    }
    return {
      noAsk: clamp(noBook.bestAsk !== null && noBook.bestAsk > 0 ? noBook.bestAsk : fallbackNoAsk, 0.0001, 0.9999),
      topAskSize: Math.max(0, noBook.topAskSize),
      source: noBook.source,
      bookable: noBook.bookable
    };
  }

  private async getDecisionNoPrice(
    marketSlug: string | null,
    tokenId: string | null,
    fallbackNoAsk: number
  ): Promise<{ noAsk: number; topAskSize: number; source: BookLookupSource; priceFetchFailed: boolean }> {
    if (!tokenId) {
      return {
        noAsk: clamp(fallbackNoAsk, 0.0001, 0.9999),
        topAskSize: 1_000_000,
        source: "missing",
        priceFetchFailed: false
      };
    }
    const nowTs = Date.now();
    const cachedSnapshot = this.getCachedTokenBookSnapshot(tokenId, nowTs);
    const wsTokenTop = this.selectedTokenIds.includes(String(tokenId || "").trim())
      ? this.selectedMarketFeed.getTokenTopOfBook(
          tokenId,
          nowTs,
          Math.max(3_000, this.config.polymarket.loopMs * 4)
        )
      : null;
    if (
      wsTokenTop &&
      Number.isFinite(Number(wsTokenTop.bestAsk)) &&
      Number(wsTokenTop.bestAsk) > 0
    ) {
      const noAsk = clamp(Number(wsTokenTop.bestAsk), 0.0001, 0.9999);
      this.cacheTokenBookSnapshot(tokenId, {
        bestBid:
          Number.isFinite(Number(wsTokenTop.bestBid)) && Number(wsTokenTop.bestBid) > 0
            ? clamp(Number(wsTokenTop.bestBid), 0.0001, 0.9999)
            : null,
        bestAsk: noAsk,
        bookTs: toMs(wsTokenTop.ts || nowTs),
        markSource: "WS_MID"
      });
      return {
        noAsk,
        topAskSize: Math.max(0, Number(wsTokenTop.topAskSize || 0)),
        source: "live",
        priceFetchFailed: false
      };
    }
    try {
      const quote = await this.client.getTokenPriceQuote(tokenId, { slug: marketSlug });
      const noAsk =
        Number.isFinite(Number(quote.bestAsk)) && Number(quote.bestAsk) > 0
          ? clamp(Number(quote.bestAsk), 0.0001, 0.9999)
          : clamp(Number(quote.mid), 0.0001, 0.9999);
      this.cacheTokenBookSnapshot(tokenId, {
        bestBid:
          Number.isFinite(Number(quote.bestBid)) && Number(quote.bestBid) > 0
            ? clamp(Number(quote.bestBid), 0.0001, 0.9999)
            : null,
        bestAsk: noAsk,
        bookTs: toMs(quote.ts || nowTs),
        markSource: quote.source.toUpperCase()
      });
      return {
        noAsk,
        topAskSize: 1_000_000,
        source: "live",
        priceFetchFailed: quote.fetchFailed
      };
    } catch (error) {
      const transient = isTransientPolymarketError(error);
      const missingOrderbook = isMissingOrderbookError(error);
      if (transient) {
        this.markReadPathWarning("NETWORK_ERROR");
      }
      const inferredNoAsk =
        Number.isFinite(Number(fallbackNoAsk)) && Number(fallbackNoAsk) > 0
          ? clamp(Number(fallbackNoAsk), 0.0001, 0.9999)
          : Number.NaN;
      const cachedNoAsk =
        cachedSnapshot && Number.isFinite(Number(cachedSnapshot.bestAsk)) && Number(cachedSnapshot.bestAsk) > 0
          ? clamp(Number(cachedSnapshot.bestAsk), 0.0001, 0.9999)
          : null;
      const resolvedNoAsk = cachedNoAsk ?? (Number.isFinite(inferredNoAsk) ? inferredNoAsk : null);
      const canUseFallback = resolvedNoAsk !== null && resolvedNoAsk > 0;
      return {
        noAsk: resolvedNoAsk !== null ? resolvedNoAsk : clamp(fallbackNoAsk, 0.0001, 0.9999),
        topAskSize: 1_000_000,
        source: cachedNoAsk !== null ? "cached" : missingOrderbook ? "missing" : "inferred",
        priceFetchFailed: !canUseFallback
      };
    }
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
      this.polyEngineRunning =
        this.running || this.polyState.lastFetchAttemptTs > 0 || this.runtimeStartupState !== "STARTING";
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

  private maybeLogClockDriftBug(emittedTs: number, input: TickLogLine): void {
    const emittedSec = Math.floor(emittedTs / 1000);
    const internalBucket = deriveBtc5mBuckets(Date.now());
    const driftSec = Math.abs(internalBucket.nowSec - emittedSec);
    if (driftSec <= 5) {
      return;
    }
    const emittedBucket = deriveBtc5mBuckets(emittedTs);
    const snapshot = this.getPersistedPolymarketSnapshot(emittedTs);
    const remainingSec =
      Number.isFinite(Number(input.tauSec)) && Number(input.tauSec) >= 0
        ? Math.floor(Number(input.tauSec))
        : Number.isFinite(Number(snapshot.remainingSec))
          ? Math.floor(Number(snapshot.remainingSec))
          : null;
    this.logger.error(
      {
        emittedTs,
        tickNowSec: internalBucket.nowSec,
        currentBucketSlug: emittedBucket.currentSlug,
        nextBucketSlug: emittedBucket.nextSlug,
        selectionCommitTs: snapshot.selectionCommitTs ?? null,
        remainingSec
      },
      "POLY_CLOCK_DRIFT_BUG"
    );
  }

  private maybeEmitTickLog(input: TickLogLine): void {
    const tickTs = this.getTickTimestamp(input.now);
    this.maybeLogClockDriftBug(tickTs, input);
    this.polyState.lastUpdateTs = Math.max(this.polyState.lastUpdateTs, tickTs);
    this.polyEngineRunning =
      this.running || this.polyState.lastFetchAttemptTs > 0 || this.runtimeStartupState !== "STARTING";
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
      line.warningState =
        pausePresentation.warningState ??
        line.warningState ??
        (line.tradingPaused ? null : this.tickWarningState);
      const actionRoot = this.getTickActionRoot(line.action);
      if (actionRoot === "HOLD") {
        line.holdReason = this.deriveCanonicalHoldReason(line) ?? line.holdReason ?? null;
        if (
          this.runtimeStartupState === "HOLD_NO_ACTIVE_BTC5M_MARKET" &&
          (!line.selectedSlug || Number(line.tauSec || 0) <= 0)
        ) {
          line.holdReason = this.getStartupHoldReason();
        }
        if ((line.holdReason === "NO_CANDIDATES" || line.holdReason === "NO_WINDOWS") && !line.holdDetailReason) {
          line.holdDetailReason = line.dominantReject ?? this.polyState.dominantReject;
        }
      } else {
        line.holdReason = null;
        line.holdDetailReason = null;
      }
      this.emitPolyPollLine(line, tickTs);
      this.emitRolloverTraceLine(line, tickTs);
      this.updateRuntimeStartupStateFromTick(line, tickTs);
      if (
        actionRoot === "HOLD" &&
        this.runtimeStartupState === "HOLD_NO_ACTIVE_BTC5M_MARKET" &&
        (!line.selectedSlug || Number(line.tauSec || 0) <= 0)
      ) {
        line.holdReason = this.getStartupHoldReason();
      }
      this.maybeWarnNoData(line.holdReason, tickTs);
      this.captureTruthStateFromTick(line);
      this.runtimeWarningState = line.tradingPaused ? null : line.warningState ?? null;
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
    line.warningState =
      pausePresentation.warningState ??
      line.warningState ??
      (line.tradingPaused ? null : this.tickWarningState);
    const actionRoot = this.getTickActionRoot(line.action);
    if (actionRoot === "HOLD") {
      line.holdReason = this.deriveCanonicalHoldReason(line) ?? line.holdReason ?? null;
      if (
        this.runtimeStartupState === "HOLD_NO_ACTIVE_BTC5M_MARKET" &&
        (!line.selectedSlug || Number(line.tauSec || 0) <= 0)
      ) {
        line.holdReason = this.getStartupHoldReason();
      }
      if ((line.holdReason === "NO_CANDIDATES" || line.holdReason === "NO_WINDOWS") && !line.holdDetailReason) {
        line.holdDetailReason = line.dominantReject ?? this.polyState.dominantReject;
      }
    } else {
      line.holdReason = null;
      line.holdDetailReason = null;
    }
    this.emitPolyPollLine(line, tickTs);
    this.emitRolloverTraceLine(line, tickTs);
    this.updateRuntimeStartupStateFromTick(line, tickTs);
    if (
      actionRoot === "HOLD" &&
      this.runtimeStartupState === "HOLD_NO_ACTIVE_BTC5M_MARKET" &&
      (!line.selectedSlug || Number(line.tauSec || 0) <= 0)
    ) {
      line.holdReason = this.getStartupHoldReason();
    }
    this.maybeWarnNoData(line.holdReason, tickTs);
    this.captureTruthStateFromTick(line);
    this.runtimeWarningState = line.tradingPaused ? null : line.warningState ?? null;
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
    if (explicitHoldReason === "STARTUP_INCOMPLETE_NO_USABLE_WINDOW") {
      return "STARTUP_INCOMPLETE_NO_USABLE_WINDOW";
    }
    if (explicitHoldReason === "NO_ACTIVE_BTC5M_MARKET" || explicitHoldReason === "BTC5M_NOT_FOUND") {
      return "NO_ACTIVE_BTC5M_MARKET";
    }
    if (explicitHoldReason === "NO_NEW_ORDERS_FINAL_SECONDS") {
      return "NO_NEW_ORDERS_FINAL_SECONDS";
    }
    if (explicitHoldReason === "OPEN_POSITION_IN_WINDOW") return "OPEN_POSITION_IN_WINDOW";
    if (explicitHoldReason === "REENTRY_COOLDOWN") return "REENTRY_COOLDOWN";
    if (explicitHoldReason === "TOO_LATE_FOR_ENTRY") return "TOO_LATE_FOR_ENTRY";
    if (
      explicitHoldReason === "PRICE_UNAVAILABLE" ||
      explicitHoldReason === "ORDER_POST_REJECTED" ||
      explicitHoldReason === "ORDER_SIZE_BELOW_MIN_SHARES" ||
      explicitHoldReason === "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED" ||
      explicitHoldReason === "CONFIG_INFEASIBLE_MIN_SHARES" ||
      explicitHoldReason === "FAIR_PRICE_UNAVAILABLE" ||
      explicitHoldReason === "EXTREME_PRICE_FILTER" ||
      explicitHoldReason === "INSUFFICIENT_DISLOCATION" ||
      explicitHoldReason === "NON_CURRENT_OR_NEXT_WINDOW" ||
      explicitHoldReason === "AWAITING_NEXT_MARKET_DISCOVERY"
    ) {
      return explicitHoldReason;
    }
    if (explicitHoldReason === "NON_EXTREME_PRICE" || explicitHoldReason === "MODEL_NOT_EXTREME") {
      return "NON_EXTREME_PRICE";
    }
    if (explicitHoldReason === "SIDE_NOT_BOOKABLE" || explicitHoldReason === "MISSING_ORDERBOOK") {
      return "SIDE_NOT_BOOKABLE";
    }
    if (explicitHoldReason === "EXPIRED_WINDOW") {
      return "EXPIRED_WINDOW";
    }
    if (explicitHoldReason === "AWAITING_RESOLUTION") {
      return "AWAITING_RESOLUTION";
    }
    const detailReason = String(line.holdDetailReason || line.dominantReject || "")
      .trim()
      .toUpperCase();
    if (detailReason === "STARTUP_INCOMPLETE_NO_USABLE_WINDOW") {
      return "STARTUP_INCOMPLETE_NO_USABLE_WINDOW";
    }
    if (detailReason === "BTC5M_NOT_FOUND") {
      return "NO_ACTIVE_BTC5M_MARKET";
    }
    if (detailReason === "NO_ACTIVE_WINDOWS") {
      return "NO_ACTIVE_WINDOWS";
    }
    if (detailReason === "SELECTION_NOT_COMMITTED") {
      return "SELECTION_NOT_COMMITTED";
    }
    if (detailReason === "NO_NEW_ORDERS_FINAL_SECONDS") {
      return "NO_NEW_ORDERS_FINAL_SECONDS";
    }
    if (detailReason === "OPEN_POSITION_IN_WINDOW") return "OPEN_POSITION_IN_WINDOW";
    if (detailReason === "REENTRY_COOLDOWN") return "REENTRY_COOLDOWN";
    if (detailReason === "TOO_LATE_FOR_ENTRY") return "TOO_LATE_FOR_ENTRY";
    if (
      detailReason === "PRICE_UNAVAILABLE" ||
      detailReason === "ORDER_POST_REJECTED" ||
      detailReason === "ORDER_SIZE_BELOW_MIN_SHARES" ||
      detailReason === "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED" ||
      detailReason === "CONFIG_INFEASIBLE_MIN_SHARES" ||
      detailReason === "FAIR_PRICE_UNAVAILABLE" ||
      detailReason === "EXTREME_PRICE_FILTER" ||
      detailReason === "INSUFFICIENT_DISLOCATION" ||
      detailReason === "NON_CURRENT_OR_NEXT_WINDOW" ||
      detailReason === "AWAITING_NEXT_MARKET_DISCOVERY"
    ) {
      return detailReason;
    }
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
    if (normalizedDetail === "NO_ACTIVE_WINDOWS") {
      return "NO_ACTIVE_WINDOWS";
    }
    if (normalizedDetail === "SELECTION_NOT_COMMITTED") {
      return "SELECTION_NOT_COMMITTED";
    }
    if (normalizedDetail === "NO_NEW_ORDERS_FINAL_SECONDS") {
      return "NO_NEW_ORDERS_FINAL_SECONDS";
    }
    if (normalizedDetail === "OPEN_POSITION_IN_WINDOW") return "OPEN_POSITION_IN_WINDOW";
    if (normalizedDetail === "REENTRY_COOLDOWN") return "REENTRY_COOLDOWN";
    if (normalizedDetail === "TOO_LATE_FOR_ENTRY") return "TOO_LATE_FOR_ENTRY";
    if (normalizedDetail === "NON_EXTREME_PRICE" || normalizedDetail === "MODEL_NOT_EXTREME") {
      return "NON_EXTREME_PRICE";
    }
    if (normalizedDetail === "SIDE_NOT_BOOKABLE" || normalizedDetail === "MISSING_ORDERBOOK") {
      return "SIDE_NOT_BOOKABLE";
    }
    if (normalizedDetail === "SIZE_BELOW_MIN_NOTIONAL") {
      return "SIZE_BELOW_MIN_NOTIONAL";
    }
    if (
      normalizedDetail === "INVALID_SIGNATURE" ||
      normalizedDetail === "LIVE_REJECTED" ||
      normalizedDetail === "ORDER_FAILED" ||
      (normalizedDetail !== null && normalizedDetail.startsWith("PREORDER_"))
    ) {
      return normalizedDetail;
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

    if (
      this.runtimeStartupState === "HOLD_NO_ACTIVE_BTC5M_MARKET" &&
      !(Number(line.activeWindows || 0) > 0)
    ) {
      return this.getStartupHoldReason();
    }
    if (!(lastFetchOkTs > 0) || fetchedCount <= 0) {
      return "NO_DATA";
    }
    if (nowTsFromLine - lastFetchOkTs >= fetchStaleAfterMs) {
      return "FETCH_STALE";
    }

    const afterWindowCount = Number(line.afterWindowCount ?? this.polyState.afterWindowCount ?? 0);
    if (afterWindowCount <= 0) {
      return "NO_ACTIVE_WINDOWS";
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

    if (normalizedDetail && normalizedDetail !== "HOLD_UNSPECIFIED") {
      return normalizedDetail;
    }

    if (oracleRequired && (oracleState === "ORACLE_STALE" || oracleState === "ORACLE_UNAVAILABLE")) {
      return oracleState;
    }

    return "HOLD_UNSPECIFIED";
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

  private getLogRemainingSecBucket(value: unknown): number | null {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    return Math.floor(seconds / 15);
  }

  private maybeLogBookFallbackWarning(
    message: string,
    payload: {
      side: "YES" | "NO";
      marketId?: string;
      tokenId: string | null;
      remainingSec?: number | null;
      selectedMarket?: boolean;
      usedCachedSnapshot?: boolean;
      transient: boolean;
      missingOrderbook: boolean;
      error: unknown;
    }
  ): void {
    if (!(this.debugPoly || this.config.debugHttp)) {
      return;
    }
    const nowTs = Date.now();
    const errorSummary = this.shortErrorText(payload.error);
    const signature = JSON.stringify({
      side: payload.side,
      marketId: payload.marketId ?? null,
      tokenId: payload.tokenId ?? null,
      transient: payload.transient,
      missingOrderbook: payload.missingOrderbook,
      errorSummary
    });
    if (
      signature === this.lastBookFallbackWarningSignature &&
      nowTs - this.lastBookFallbackWarningLogTs < 15_000
    ) {
      return;
    }
    this.lastBookFallbackWarningSignature = signature;
    this.lastBookFallbackWarningLogTs = nowTs;
    const loggerPayload: Record<string, unknown> = {
      side: payload.side,
      marketId: payload.marketId ?? null,
      tokenId: payload.tokenId ?? null,
      remainingSec: Number.isFinite(Number(payload.remainingSec)) ? Number(payload.remainingSec) : null,
      selectedMarket: Boolean(payload.selectedMarket),
      usedCachedSnapshot: Boolean(payload.usedCachedSnapshot) && !payload.missingOrderbook,
      transient: payload.transient,
      missingOrderbook: payload.missingOrderbook,
      errorSummary
    };
    if (this.debugPoly || this.config.debugHttp) {
      loggerPayload.error = errorSummary;
    }
    this.logger.warn(loggerPayload, message);
  }

  private pushTraceRow(buffer: Array<Record<string, unknown>>, row: Record<string, unknown>, maxRows = 20): void {
    buffer.unshift(row);
    if (buffer.length > maxRows) {
      buffer.length = maxRows;
    }
  }

  private emitPolyPollLine(line: TickLogLine, nowTs: number): void {
    if (this.config.polymarket.mode !== "live") {
      return;
    }
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(nowTs);
    const currentBucket = this.getFreshBtc5mWallClockBucket(nowTs);
    const remainingSec =
      Number.isFinite(Number(line.tauSec)) && Number(line.tauSec) >= 0
        ? Math.floor(Number(line.tauSec))
        : Number.isFinite(Number(persistedSnapshot.remainingSec))
          ? Math.floor(Number(persistedSnapshot.remainingSec))
          : null;
    const selectedSlug =
      line.selectedSlug || line.currentMarketId || persistedSnapshot.selectedSlug || persistedSnapshot.selectedMarketId || null;
    const fromCachedSelection =
      Boolean(selectedSlug) &&
      Number(line.fetchedCount ?? 0) <= 0 &&
      Number(line.afterWindowCount ?? 0) <= 0 &&
      Number(line.finalCandidatesCount ?? 0) <= 0;
    const fetchOk =
      this.polyState.lastFetchOkTs > 0 &&
      this.polyState.lastHttpStatus === 200 &&
      nowTs - this.polyState.lastFetchOkTs <= Math.max(5_000, this.config.polymarket.live.discoveryStaleMs);
    const candidateSlugs = this.getDeterministicBtc5mSlugCandidates(currentBucket).slice(0, 4);
    const row: Record<string, unknown> = {
      nowIso: new Date(nowTs).toISOString(),
      pollMode: persistedSnapshot.pollMode || "-",
      currentBucketSlug: persistedSnapshot.currentBucketSlug || currentBucket.currentSlug,
      nextBucketSlug: persistedSnapshot.nextBucketSlug || currentBucket.nextSlug,
      selectedSlug: selectedSlug || "-",
      selectedTokenId: line.selectedTokenId || persistedSnapshot.selectedTokenId || "-",
      remainingSec,
      fetchedCount: Number(line.fetchedCount ?? this.polyState.fetchedCount ?? 0),
      afterWindowCount: Number(line.afterWindowCount ?? this.polyState.afterWindowCount ?? 0),
      finalCandidatesCount: Number(line.finalCandidatesCount ?? this.polyState.finalCandidatesCount ?? 0),
      candidateSlugs,
      discoveredCurrent: Boolean(persistedSnapshot.discoveredCurrent),
      discoveredNext: Boolean(persistedSnapshot.discoveredNext),
      selectionSource: persistedSnapshot.selectionSource || "-",
      selectedFrom: persistedSnapshot.selectedFrom || persistedSnapshot.selectionSource || "-",
      selectionCommitTs: persistedSnapshot.selectionCommitTs || 0,
      liveValidationReason: persistedSnapshot.liveValidationReason || "-",
      selectedBookable: persistedSnapshot.selectedBookable,
      selectedTradable: persistedSnapshot.selectedTradable,
      fromCachedSelection,
      fetchOk,
      lastFetchOkTs: this.polyState.lastFetchOkTs || 0,
      warningState: persistedSnapshot.warningState || "-",
      holdReason: line.holdReason || persistedSnapshot.holdReason || "-"
    };
    this.pushTraceRow(this.polyPollTrace, row);
    this.logger.info(
      `POLY_POLL nowIso=${String(row.nowIso)} pollMode=${String(row.pollMode)} currentBucketSlug=${String(
        row.currentBucketSlug
      )} nextBucketSlug=${String(row.nextBucketSlug)} selectedSlug=${String(
        row.selectedSlug
      )} selectedTokenId=${String(row.selectedTokenId)} remainingSec=${String(
        row.remainingSec ?? "-"
      )} fetchedCount=${String(row.fetchedCount)} afterWindowCount=${String(
        row.afterWindowCount
      )} finalCandidatesCount=${String(row.finalCandidatesCount)} candidateSlugs=${candidateSlugs.join(",")} selectionSource=${String(
        row.selectionSource
      )} selectedFrom=${String(row.selectedFrom)} discoveredCurrent=${String(
        row.discoveredCurrent
      )} discoveredNext=${String(row.discoveredNext)} selectionCommitTs=${String(
        row.selectionCommitTs
      )} liveValidationReason=${String(row.liveValidationReason)} selectedBookable=${String(
        row.selectedBookable
      )} selectedTradable=${String(row.selectedTradable)} fromCachedSelection=${String(
        row.fromCachedSelection
      )} fetchOk=${String(row.fetchOk)} lastFetchOkTs=${String(row.lastFetchOkTs)} warningState=${String(
        row.warningState
      )} holdReason=${String(row.holdReason)}`
    );
  }

  private emitRolloverTraceLine(line: TickLogLine, nowTs: number): void {
    if (this.config.polymarket.mode !== "live" || !this.isDeterministicBtc5mMode()) {
      return;
    }
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(nowTs);
    const currentBucket = this.getFreshBtc5mWallClockBucket(nowTs);
    const remainingSec =
      Number.isFinite(Number(line.tauSec)) && Number(line.tauSec) >= 0
        ? Math.floor(Number(line.tauSec))
        : Number.isFinite(Number(persistedSnapshot.remainingSec))
          ? Math.floor(Number(persistedSnapshot.remainingSec))
          : null;
    const selectedSlug =
      line.selectedSlug || line.currentMarketId || persistedSnapshot.selectedSlug || persistedSnapshot.selectedMarketId || null;
    const nextDiscovered =
      selectedSlug === currentBucket.nextSlug ||
      persistedSnapshot.nextBucketSlug === currentBucket.nextSlug ||
      this.getDeterministicBtc5mSlugCandidates(currentBucket).includes(currentBucket.nextSlug);
    const nextTradable =
      nextDiscovered &&
      ((persistedSnapshot.selectionSource === "next_slug" ||
        (persistedSnapshot.selectionSource === "DIRECT_SLUG" && persistedSnapshot.discoveredNext)) &&
        persistedSnapshot.selectedTradable === true);
    const changedBucketSignature = `${currentBucket.currentSlug}|${currentBucket.nextSlug}`;
    const withinRolloverWindow = remainingSec !== null && remainingSec <= 90;
    if (!withinRolloverWindow && changedBucketSignature === this.lastRolloverPlanBucketSignature) {
      return;
    }
    this.lastRolloverPlanBucketSignature = changedBucketSignature;
    const row: Record<string, unknown> = {
      nowIso: new Date(nowTs).toISOString(),
      pollMode: persistedSnapshot.pollMode || "-",
      currentBucketSlug: currentBucket.currentSlug,
      nextBucketSlug: currentBucket.nextSlug,
      selectedSlug: selectedSlug || "-",
      remainingSec,
      nextDiscovered,
      nextTradable,
      discoveredCurrent: persistedSnapshot.discoveredCurrent,
      discoveredNext: persistedSnapshot.discoveredNext,
      selectedFrom: persistedSnapshot.selectedFrom || persistedSnapshot.selectionSource || "-",
      liveValidationReason: persistedSnapshot.liveValidationReason || "-",
      selectionSource: persistedSnapshot.selectionSource || "-"
    };
    this.pushTraceRow(this.polyRolloverTrace, row);
    this.logger.info(
      `POLY_ROLLOVER_TRACE nowIso=${String(row.nowIso)} pollMode=${String(row.pollMode)} currentBucketSlug=${String(
        row.currentBucketSlug
      )} nextBucketSlug=${String(row.nextBucketSlug)} selectedSlug=${String(
        row.selectedSlug
      )} remainingSec=${String(row.remainingSec ?? "-")} nextDiscovered=${String(
        row.nextDiscovered
      )} nextTradable=${String(row.nextTradable)} selectionSource=${String(
        row.selectionSource
      )} selectedFrom=${String(row.selectedFrom)} discoveredCurrent=${String(
        row.discoveredCurrent
      )} discoveredNext=${String(row.discoveredNext)} liveValidationReason=${String(row.liveValidationReason)}`
    );
  }

  private emitRolloverLine(line: TickLogLine, nowTs: number): void {
    if (this.config.polymarket.mode !== "live" || !this.isDeterministicBtc5mMode()) {
      return;
    }
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(nowTs);
    const currentBucket = this.getFreshBtc5mWallClockBucket(nowTs);
    const candidateSlugs = this.getDeterministicBtc5mSlugCandidates(currentBucket);
    const selectedSlug =
      line.selectedSlug || line.currentMarketId || persistedSnapshot.selectedSlug || persistedSnapshot.selectedMarketId || null;
    const selectedBucketStartSec =
      parseBtc5mWindowStartSec(line.selectedSlug) ??
      (Number.isFinite(Number(line.windowStart)) && Number(line.windowStart) > 0
        ? Math.floor(Number(line.windowStart) / 1000)
        : parseBtc5mWindowStartSec(persistedSnapshot.selectedSlug));
    const remainingSec =
      Number.isFinite(Number(line.tauSec)) && Number(line.tauSec) >= 0
        ? Math.floor(Number(line.tauSec))
        : Number.isFinite(Number(persistedSnapshot.remainingSec))
          ? Math.floor(Number(persistedSnapshot.remainingSec))
          : null;
    const signature = JSON.stringify({
      currentBucketStartSec: currentBucket.currentBucketStartSec,
      selectedSlug,
      remainingBucket: this.getLogRemainingSecBucket(remainingSec),
      selectedTokenId: persistedSnapshot.selectedTokenId ?? null,
      candidateRefreshed: persistedSnapshot.candidateRefreshed ?? null,
      lastPreorderValidationReason: persistedSnapshot.lastPreorderValidationReason ?? null,
      holdReason: line.holdReason ?? persistedSnapshot.holdReason ?? null,
      warningState: persistedSnapshot.warningState ?? null,
      pollMode: persistedSnapshot.pollMode ?? null
    });
    if (signature === this.lastPolyRolloverSignature) {
      return;
    }
    this.lastPolyRolloverSignature = signature;
    this.logger.info(
      `DISCOVERY_ROLLOVER nowSec=${currentBucket.nowSec} currentBucketStartSec=${currentBucket.currentBucketStartSec} currentSlug=${currentBucket.currentSlug} prevSlug=${currentBucket.prevSlug} nextSlug=${currentBucket.nextSlug} candidateSlugs=${candidateSlugs.join(",")} selectedSlug=${selectedSlug || "-"} selectedBucketStartSec=${selectedBucketStartSec ?? "-"} remainingSec=${remainingSec ?? "-"} pollMode=${persistedSnapshot.pollMode || "-"} selectedTokenId=${String(
        persistedSnapshot.selectedTokenId || "-"
      )} selectedBookable=${String(persistedSnapshot.selectedBookable)} selectedTradable=${String(
        persistedSnapshot.selectedTradable
      )} selectionSource=${String(persistedSnapshot.selectionSource || "-")} liveValidationReason=${String(
        persistedSnapshot.liveValidationReason || "-"
      )} candidateRefreshed=${String(
        persistedSnapshot.candidateRefreshed
      )} lastPreorderValidationReason=${String(
        persistedSnapshot.lastPreorderValidationReason || "-"
      )} holdReason=${String(line.holdReason || persistedSnapshot.holdReason || "-")} warningState=${String(
        persistedSnapshot.warningState || "-"
      )} reasonSelected=${String(line.selectedReason || line.dominantReject || "-")}`
    );
  }

  private emitUiStatusLine(line: TickLogLine, nowTs: number): void {
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(nowTs);
    const currentMarketSlug = persistedSnapshot.selectedSlug || "-";
    const selectedMarketId = persistedSnapshot.selectedMarketId || "-";
    const selectedSlug = currentMarketSlug !== "-" ? currentMarketSlug : selectedMarketId;
    const blockedBy =
      normalizeHoldReason(
        persistedSnapshot.executionBlockedReason ||
          line.blockedBy ||
          line.dataHealthBlock ||
          line.strategyBlock ||
          persistedSnapshot.holdReason
      ) || "-";
    const remainingSec =
      Number.isFinite(Number(persistedSnapshot.remainingSec))
        ? Math.floor(Number(persistedSnapshot.remainingSec))
        : "-";
    const signature = JSON.stringify({
      selectedSlug,
      selectedMarketId,
      selectedTokenId: persistedSnapshot.selectedTokenId ?? null,
      selectedBookable: persistedSnapshot.selectedBookable,
      selectedTradable: persistedSnapshot.selectedTradable,
      discoveredCurrent: persistedSnapshot.discoveredCurrent,
      discoveredNext: persistedSnapshot.discoveredNext,
      selectionSource: persistedSnapshot.selectionSource,
      selectedFrom: persistedSnapshot.selectedFrom,
      selectionCommitTs: persistedSnapshot.selectionCommitTs,
      liveValidationReason: persistedSnapshot.liveValidationReason,
      lastBookTs: persistedSnapshot.lastBookTs,
      lastQuoteTs: persistedSnapshot.lastQuoteTs,
      currentBucketSlug: persistedSnapshot.currentBucketSlug,
      nextBucketSlug: persistedSnapshot.nextBucketSlug,
      currentBucketStartSec: persistedSnapshot.currentBucketStartSec,
      selectedWindowStartSec: persistedSnapshot.selectedWindowStartSec,
      selectedWindowEndSec: persistedSnapshot.selectedWindowEndSec,
      remainingBucket: this.getLogRemainingSecBucket(persistedSnapshot.remainingSec),
      chosenSide: persistedSnapshot.chosenSide,
      chosenDirection: persistedSnapshot.chosenDirection,
      holdReason: persistedSnapshot.holdReason,
      blockedBy,
      holdCategory: persistedSnapshot.holdCategory ?? null,
      warningState: persistedSnapshot.warningState,
      staleState: persistedSnapshot.staleState,
      pollMode: persistedSnapshot.pollMode,
      status: persistedSnapshot.status,
      candidateRefreshed: persistedSnapshot.candidateRefreshed ?? null,
      lastPreorderValidationReason: persistedSnapshot.lastPreorderValidationReason ?? null,
      dynamicThresholdMetric: persistedSnapshot.dynamicThresholdMetric ?? null
    });
    if (signature === this.lastUiStatusSignature) {
      return;
    }
    this.lastUiStatusSignature = signature;
    this.logger.info(
      `UI_STATE_PUSH currentMarketSlug=${currentMarketSlug} selectedSlug=${selectedSlug} selectedMarketId=${selectedMarketId} remainingSec=${remainingSec} side=${String(
        persistedSnapshot.chosenSide || "-"
      )} direction=${String(persistedSnapshot.chosenDirection || "-")} action=${String(
        persistedSnapshot.action || this.getTickActionRoot(line.action)
      )} holdReason=${String(persistedSnapshot.holdReason || "-")} blockedBy=${blockedBy} holdCategory=${String(
        persistedSnapshot.holdCategory || "-"
      )} pollMode=${String(persistedSnapshot.pollMode || "-")} staleState=${String(
        persistedSnapshot.staleState || "-"
      )} selectedTokenId=${String(persistedSnapshot.selectedTokenId || "-")} selectedBookable=${String(
        persistedSnapshot.selectedBookable
      )} selectedTradable=${String(persistedSnapshot.selectedTradable)} selectionSource=${String(
        persistedSnapshot.selectionSource || "-"
      )} selectedFrom=${String(persistedSnapshot.selectedFrom || persistedSnapshot.selectionSource || "-")} selectionCommitTs=${String(
        persistedSnapshot.selectionCommitTs || "-"
      )} discoveredCurrent=${String(persistedSnapshot.discoveredCurrent)} discoveredNext=${String(
        persistedSnapshot.discoveredNext
      )} liveValidationReason=${String(persistedSnapshot.liveValidationReason || "-")} lastBookTs=${String(
        persistedSnapshot.lastBookTs ?? "-"
      )} lastQuoteTs=${String(persistedSnapshot.lastQuoteTs ?? "-")} currentBucketSlug=${String(
        persistedSnapshot.currentBucketSlug || "-"
      )} nextBucketSlug=${String(persistedSnapshot.nextBucketSlug || "-")} candidateRefreshed=${String(
        persistedSnapshot.candidateRefreshed
      )} lastPreorderValidationReason=${String(
        persistedSnapshot.lastPreorderValidationReason || "-"
      )} status=${String(persistedSnapshot.status || "-")} warningState=${String(
        persistedSnapshot.warningState || "-"
      )} minEdgeThresholdConfig=${Number(this.config.polymarket.live.minEdgeThreshold).toFixed(4)} dynamicThresholdMetric=${
        Number.isFinite(Number(persistedSnapshot.dynamicThresholdMetric))
          ? Number(persistedSnapshot.dynamicThresholdMetric).toFixed(4)
          : "-"
      } pUpModel=${Number.isFinite(Number(line.pUpModel)) ? Number(line.pUpModel).toFixed(4) : "-"} bestEdge=${
        Number.isFinite(Number(line.chosenEdge))
          ? Number(line.chosenEdge).toFixed(4)
          : Number.isFinite(Number(line.edge))
            ? Number(line.edge).toFixed(4)
            : "-"
      } btcMid=${
        Number.isFinite(Number(persistedSnapshot.currentBtcMid)) && Number(persistedSnapshot.currentBtcMid) > 0
          ? Number(persistedSnapshot.currentBtcMid).toFixed(2)
          : "-"
      }`
    );
  }

  private emitDecisionParityLine(line: TickLogLine, nowTs: number): void {
    if (this.config.polymarket.mode !== "live" || !this.debugPoly) {
      return;
    }
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(nowTs);
    const selectedSlug = line.selectedSlug || line.currentMarketId || persistedSnapshot.selectedSlug || null;
    if (!selectedSlug) {
      return;
    }
    const paperWouldTrade = Boolean(line.paperWouldTrade);
    const liveWouldTrade = Boolean(line.liveWouldTrade);
    const score =
      Number.isFinite(Number(line.score))
        ? Number(line.score)
        : Number.isFinite(Number(line.netEdgeAfterCosts))
          ? Number(line.netEdgeAfterCosts)
          : null;
    const dynamicThresholdMetric =
      Number.isFinite(Number(line.threshold)) ? Number(line.threshold) : persistedSnapshot.dynamicThresholdMetric;
    const modelEdge =
      Number.isFinite(Number(line.chosenEdge))
        ? Number(line.chosenEdge)
        : Number.isFinite(Number(line.edge))
          ? Number(line.edge)
          : null;
    const remainingSec =
      Number.isFinite(Number(line.tauSec)) && Number(line.tauSec) >= 0
        ? Math.floor(Number(line.tauSec))
        : Number.isFinite(Number(persistedSnapshot.remainingSec))
          ? Math.floor(Number(persistedSnapshot.remainingSec))
          : null;
    const selectedTokenId = line.selectedTokenId || persistedSnapshot.selectedTokenId || null;
    const currentBtcMid =
      Number.isFinite(Number(persistedSnapshot.currentBtcMid)) && Number(persistedSnapshot.currentBtcMid) > 0
        ? Number(persistedSnapshot.currentBtcMid)
        : null;
    const blockedBy =
      normalizeHoldReason(line.blockedBy || line.dataHealthBlock || line.strategyBlock || line.holdReason || "") ||
      null;
    const dataHealthBlock =
      normalizeHoldReason(line.dataHealthBlock || (isDataHealthBlockReason(line.holdReason) ? line.holdReason : "")) ||
      null;
    const strategyBlock =
      normalizeHoldReason(line.strategyBlock || (!dataHealthBlock ? line.holdReason : "")) || null;
    this.logger.info(
      `POLY_PARITY paperWouldTrade=${paperWouldTrade} liveWouldTrade=${liveWouldTrade} selectedSlug=${selectedSlug} chosenSide=${String(
        line.chosenSide || persistedSnapshot.chosenSide || "-"
      )} chosenDirection=${String(line.chosenDirection || persistedSnapshot.chosenDirection || "-")} selectedTokenId=${String(
        selectedTokenId || "-"
      )} remainingSec=${remainingSec ?? "-"} currentBtcMid=${
        currentBtcMid !== null ? currentBtcMid.toFixed(2) : "-"
      } score=${
        score !== null ? score.toFixed(4) : "-"
      } minEdgeThresholdConfig=${Number(this.config.polymarket.live.minEdgeThreshold).toFixed(4)} dynamicThresholdMetric=${
        Number.isFinite(Number(dynamicThresholdMetric)) ? Number(dynamicThresholdMetric).toFixed(4) : "-"
      } modelEdge=${modelEdge !== null ? modelEdge.toFixed(4) : "-"} pUpModel=${
        Number.isFinite(Number(line.pUpModel)) ? Number(line.pUpModel).toFixed(4) : "-"
      } blockedBy=${blockedBy || "-"} dataHealthBlock=${
        dataHealthBlock || "-"
      } strategyBlock=${strategyBlock || "-"}`
    );
    if (paperWouldTrade && !liveWouldTrade) {
      this.logger.warn(
        `POLY_PARITY_MISMATCH selectedSlug=${selectedSlug} selectedTokenId=${String(
          selectedTokenId || "-"
        )} remainingSec=${remainingSec ?? "-"} currentBtcMid=${
          currentBtcMid !== null ? currentBtcMid.toFixed(2) : "-"
        } blockedBy=${blockedBy || "-"}`
      );
    }
  }

  private emitIntentionalHoldDecisionLine(line: TickLogLine, nowTs: number): void {
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(nowTs);
    const actionRoot = this.getTickActionRoot(line.action);
    const selectedSlug = line.selectedSlug || line.currentMarketId || persistedSnapshot.selectedSlug || persistedSnapshot.selectedMarketId || null;
    if (actionRoot !== "HOLD" || !selectedSlug) {
      return;
    }
    const holdReason = String(
      line.holdReason || line.holdDetailReason || line.dominantReject || persistedSnapshot.holdReason || ""
    )
      .trim()
      .toUpperCase();
    if (!holdReason) {
      return;
    }
    const signature = JSON.stringify({
      selectedSlug,
      holdReason,
      chosenSide: line.chosenSide ?? null,
      chosenDirection: line.chosenDirection ?? null,
      dynamicThresholdMetric:
        Number.isFinite(Number(line.threshold)) ? Number(line.threshold).toFixed(4) : null,
      observedPrice:
        Number.isFinite(Number(line.yesAsk)) ? Number(line.yesAsk).toFixed(4) : Number.isFinite(Number(line.yesMid)) ? Number(line.yesMid).toFixed(4) : null,
      modelEdge:
        Number.isFinite(Number(line.chosenEdge)) ? Number(line.chosenEdge).toFixed(4) : Number.isFinite(Number(line.edge)) ? Number(line.edge).toFixed(4) : null
    });
    if (
      signature === this.lastIntentionalHoldSignature &&
      nowTs - this.lastIntentionalHoldLogTs < 15_000
    ) {
      return;
    }
    this.lastIntentionalHoldSignature = signature;
    this.lastIntentionalHoldLogTs = nowTs;
    const remainingText =
      Number.isFinite(Number(line.tauSec)) && Number(line.tauSec) >= 0
        ? String(Math.floor(Number(line.tauSec)))
        : Number.isFinite(Number(persistedSnapshot.remainingSec))
          ? String(Math.floor(Number(persistedSnapshot.remainingSec)))
          : "-";
    const dynamicThresholdMetricText =
      Number.isFinite(Number(line.threshold)) ? Number(line.threshold).toFixed(4) : "-";
    const observedPriceText =
      Number.isFinite(Number(line.yesAsk))
        ? Number(line.yesAsk).toFixed(4)
        : Number.isFinite(Number(line.yesMid))
          ? Number(line.yesMid).toFixed(4)
          : "-";
    const modelEdgeText =
      Number.isFinite(Number(line.chosenEdge))
        ? Number(line.chosenEdge).toFixed(4)
        : Number.isFinite(Number(line.edge))
          ? Number(line.edge).toFixed(4)
          : "-";
    this.logger.info(
      `POLY_DECISION selectedSlug=${selectedSlug} remainingSec=${remainingText} side=${String(
        line.chosenSide || persistedSnapshot.chosenSide || "-"
      )} direction=${String(
        line.chosenDirection || persistedSnapshot.chosenDirection || "-"
      )} action=HOLD reason=${holdReason} minEdgeThresholdConfig=${Number(
        this.config.polymarket.live.minEdgeThreshold
      ).toFixed(4)} dynamicThresholdMetric=${dynamicThresholdMetricText} modelEdge=${modelEdgeText} pUpModel=${
        Number.isFinite(Number(line.pUpModel)) ? Number(line.pUpModel).toFixed(4) : "-"
      } observedPrice=${observedPriceText}`
    );
  }

  private emitPolyDebugLine(line: TickLogLine, nowTs: number): void {
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(nowTs);
    const selectedSlug = line.selectedSlug || persistedSnapshot.selectedSlug || persistedSnapshot.selectedMarketId || "-";
    const selectedMarketId = line.currentMarketId || persistedSnapshot.selectedMarketId || "-";
    const selectedTokenId = line.selectedTokenId || persistedSnapshot.selectedTokenId || "-";
    const chosenSide = line.chosenSide || persistedSnapshot.chosenSide || "-";
    const chosenDirection = line.chosenDirection || persistedSnapshot.chosenDirection || "-";
    const remainingSec =
      Number.isFinite(Number(line.tauSec)) && Number(line.tauSec) >= 0
        ? Math.floor(Number(line.tauSec))
        : Number.isFinite(Number(persistedSnapshot.remainingSec))
          ? Math.floor(Number(persistedSnapshot.remainingSec))
          : null;
    const holdReason = normalizeHoldReason(line.holdReason || persistedSnapshot.holdReason || "") || "-";
    const blockedBy =
      normalizeHoldReason(
        line.blockedBy ||
          line.dataHealthBlock ||
          line.strategyBlock ||
          persistedSnapshot.executionBlockedReason ||
          persistedSnapshot.holdReason ||
          ""
      ) || "-";
    const pollMode = persistedSnapshot.pollMode || "-";
    const candidateRefreshed = persistedSnapshot.candidateRefreshed;
    const lastPreorderValidationReason = persistedSnapshot.lastPreorderValidationReason || "-";
    const signature = JSON.stringify({
      selectedSlug,
      selectedTokenId,
      chosenSide,
      holdReason,
      blockedBy,
      pollMode,
      selectedBookable: persistedSnapshot.selectedBookable,
      selectedTradable: persistedSnapshot.selectedTradable,
      selectionSource: persistedSnapshot.selectionSource,
      liveValidationReason: persistedSnapshot.liveValidationReason,
      remainingBucket: this.getLogRemainingSecBucket(remainingSec),
      candidateRefreshed: candidateRefreshed ?? null,
      lastPreorderValidationReason
    });
    if (signature === this.lastPolyDebugSignature) {
      return;
    }
    this.lastPolyDebugSignature = signature;
    this.logger.info(
      `POLY_DEBUG selectedSlug=${selectedSlug} selectedMarketId=${selectedMarketId} selectedTokenId=${selectedTokenId} chosenSide=${chosenSide} chosenDirection=${String(
        chosenDirection
      )} remainingSec=${remainingSec ?? "-"} currentBtcMid=${
        Number.isFinite(Number(persistedSnapshot.currentBtcMid)) && Number(persistedSnapshot.currentBtcMid) > 0
          ? Number(persistedSnapshot.currentBtcMid).toFixed(2)
          : "-"
      } minEdgeThresholdConfig=${Number(this.config.polymarket.live.minEdgeThreshold).toFixed(4)} dynamicThresholdMetric=${
        Number.isFinite(Number(persistedSnapshot.dynamicThresholdMetric))
          ? Number(persistedSnapshot.dynamicThresholdMetric).toFixed(4)
          : "-"
      } holdReason=${holdReason} blockedBy=${blockedBy} holdCategory=${String(
        persistedSnapshot.holdCategory || "-"
      )} dataHealthBlock=${String(
        normalizeHoldReason(line.dataHealthBlock || "") || "-"
      )} strategyBlock=${String(
        normalizeHoldReason(line.strategyBlock || "") || "-"
      )} pollMode=${pollMode} selectedBookable=${String(
        persistedSnapshot.selectedBookable
      )} selectedTradable=${String(persistedSnapshot.selectedTradable)} selectionSource=${String(
        persistedSnapshot.selectionSource || "-"
      )} liveValidationReason=${String(persistedSnapshot.liveValidationReason || "-")} candidateRefreshed=${String(
        candidateRefreshed
      )} lastPreorderValidationReason=${lastPreorderValidationReason} action=${String(
        this.getTickActionRoot(line.action)
      )}`
    );
  }

  private emitPolyStatusLine(line: TickLogLine, nowTs: number): void {
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(nowTs);
    this.emitRolloverLine(line, nowTs);
    this.emitDecisionParityLine(line, nowTs);
    this.emitIntentionalHoldDecisionLine(line, nowTs);
    this.emitPolyDebugLine(line, nowTs);
    this.emitUiStatusLine(line, nowTs);
    const actionRoot = this.getTickActionRoot(line.action);
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
    const selected = line.selectedSlug || line.currentMarketId || persistedSnapshot.selectedSlug || persistedSnapshot.selectedMarketId || "-";
    const selectedTokenId = line.selectedTokenId || persistedSnapshot.selectedTokenId || "-";
    const remainingSecValue =
      Number.isFinite(Number(line.tauSec))
        ? Math.floor(Number(line.tauSec))
        : Number.isFinite(Number(persistedSnapshot.remainingSec))
          ? Math.floor(Number(persistedSnapshot.remainingSec))
          : null;
    const remaining = remainingSecValue !== null ? String(remainingSecValue) : "-";
    const minRemainingSec =
      Number.isFinite(Number(line.minWindowSec)) && Number(line.minWindowSec) > 0
        ? Math.floor(Number(line.minWindowSec))
        : this.scanner.getPrimaryWindowConfig().minWindowSec;
    const maxRemainingSec =
      Number.isFinite(Number(line.maxWindowSec)) && Number(line.maxWindowSec) > 0
        ? Math.floor(Number(line.maxWindowSec))
        : this.scanner.getPrimaryWindowConfig().maxWindowSec;
    const dynamicThresholdMetricText = Number.isFinite(Number(line.threshold))
      ? Number(line.threshold).toFixed(4)
      : Number.isFinite(Number(persistedSnapshot.dynamicThresholdMetric))
        ? Number(persistedSnapshot.dynamicThresholdMetric).toFixed(4)
        : "-";
    const formatOrDash = (value: unknown, decimals = 4): string =>
      Number.isFinite(Number(value)) ? Number(value).toFixed(decimals) : "-";
    const roundOrNull = (value: unknown, decimals = 4): number | null =>
      Number.isFinite(Number(value)) ? Number(Number(value).toFixed(decimals)) : null;
    const bestEdgeText =
      Number.isFinite(Number(line.chosenEdge))
        ? Number(line.chosenEdge).toFixed(4)
        : Number.isFinite(Number(line.edge))
          ? Number(line.edge).toFixed(4)
          : "-";
    const pUpModelText = Number.isFinite(Number(line.pUpModel)) ? Number(line.pUpModel).toFixed(4) : "-";
    const yesBidText = formatOrDash(line.yesBid);
    const yesAskText = formatOrDash(line.yesAsk);
    const noBidText = formatOrDash(line.noBid);
    const noAskText = formatOrDash(line.noAsk);
    const yesSpreadText = formatOrDash(line.yesSpread);
    const noSpreadText = formatOrDash(line.noSpread);
    const chosenSidePriceUsedText = formatOrDash(line.chosenSidePriceUsed);
    const feeBpsUsedText = formatOrDash(line.feeBpsUsed, 2);
    const slippageBpsUsedText = formatOrDash(line.slippageBpsUsed, 2);
    const safetyBpsUsedText = formatOrDash(line.safetyBpsUsed, 2);
    const rawYesEdgeBeforeCostsText = formatOrDash(line.rawYesEdgeBeforeCosts);
    const rawNoEdgeBeforeCostsText = formatOrDash(line.rawNoEdgeBeforeCosts);
    const yesEdgeAfterCostsText = formatOrDash(line.yesEdgeAfterCosts);
    const noEdgeAfterCostsText = formatOrDash(line.noEdgeAfterCosts);
    const chosenEdgeBeforeClampText = formatOrDash(line.chosenEdgeBeforeClamp);
    const chosenEdgeAfterClampText = formatOrDash(line.chosenEdgeAfterClamp);
    const edgeClampReasonText = String(line.edgeClampReason || "-");
    const baseTargetNotionalText = formatOrDash(line.baseTargetNotional);
    const cappedNotionalText = formatOrDash(line.cappedNotional);
    const computedOrderNotionalText = formatOrDash(line.computedOrderNotional);
    const computedSharesText = formatOrDash(line.computedShares, 6);
    const maxAchievableSharesText = formatOrDash(line.maxAchievableShares, 6);
    const configFeasibleText = typeof line.configFeasible === "boolean" ? String(line.configFeasible) : "-";
    const minOrderNotionalConfigText = formatOrDash(line.minOrderNotionalConfig);
    const minSharesRequiredText = formatOrDash(line.minSharesRequired, 6);
    const minSharesRequiredConfigText = formatOrDash(line.minSharesRequiredConfig ?? line.minSharesRequired, 6);
    const maxNotionalPerWindowConfigText = formatOrDash(line.maxNotionalPerWindowConfig);
    const sizingCapAppliedText = String(Boolean(line.sizingCapApplied));
    const sizingRejectReasonText = String(line.sizingRejectReason || "NONE");
    const bookabilityFailReasonText = String(line.bookabilityFailReason || "NONE");
    const tradabilityFailReasonText = String(line.tradabilityFailReason || "NONE");
    const blockerSourceText = String(
      line.blockerSource ||
        deriveBlockerSourceTelemetry({
          blockedCategory: line.blockedCategory || null,
          blockedReason: line.blockedBy || line.holdReason || null,
          bookabilityFailReason: line.bookabilityFailReason || "NONE",
          tradabilityFailReason: line.tradabilityFailReason || "NONE"
        })
    );
    const riskBlockReasonInternalText = String(line.riskBlockReasonInternal || "-");
    const tokenLiquiditySnapshotText = JSON.stringify({
      yesBid: roundOrNull(line.tokenLiquiditySnapshot?.yesBid ?? line.yesBid),
      yesAsk: roundOrNull(line.tokenLiquiditySnapshot?.yesAsk ?? line.yesAsk),
      noBid: roundOrNull(line.tokenLiquiditySnapshot?.noBid ?? line.noBid),
      noAsk: roundOrNull(line.tokenLiquiditySnapshot?.noAsk ?? line.noAsk),
      yesSpread: roundOrNull(line.tokenLiquiditySnapshot?.yesSpread ?? line.yesSpread),
      noSpread: roundOrNull(line.tokenLiquiditySnapshot?.noSpread ?? line.noSpread)
    });
    const outcomePricesHintText =
      Array.isArray(line.outcomePricesHint) && line.outcomePricesHint.length > 0
        ? line.outcomePricesHint
            .map((value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(4) : "null"))
            .join(",")
        : "-";
    const fairYesValue =
      Number.isFinite(Number(line.fairYes))
        ? clamp(Number(line.fairYes), 0.0005, 0.9995)
        : Array.isArray(line.outcomePricesHint) && Number.isFinite(Number(line.outcomePricesHint[0]))
          ? clamp(Number(line.outcomePricesHint[0]), 0.0005, 0.9995)
          : Number.isFinite(Number(line.pUpModel))
            ? clamp(Number(line.pUpModel), 0.0005, 0.9995)
            : null;
    const fairYesText = fairYesValue !== null ? fairYesValue.toFixed(4) : "-";
    const fairPriceSourceValue: "MODEL" | "OUTCOME_HINT" | "NONE" =
      line.fairPriceSource === "MODEL" || line.fairPriceSource === "OUTCOME_HINT" || line.fairPriceSource === "NONE"
        ? line.fairPriceSource
        : Number.isFinite(Number(line.fairYes))
          ? "MODEL"
          : Array.isArray(line.outcomePricesHint) && Number.isFinite(Number(line.outcomePricesHint[0]))
            ? "OUTCOME_HINT"
            : Number.isFinite(Number(line.pUpModel))
              ? "MODEL"
              : "NONE";
    const fairPriceSourceText = fairPriceSourceValue;
    const fairPriceModelOriginText = String(line.fairPriceModelOrigin || "-");
    const minDislocationConfigValue =
      Number.isFinite(Number(line.minDislocationConfig))
        ? Math.max(0, Number(line.minDislocationConfig))
        : getLiveMinDislocationConfigFromEnv();
    const minDislocationConfigText = minDislocationConfigValue.toFixed(4);
    const dislocationAbsValue =
      Number.isFinite(Number(line.dislocationAbs))
        ? Math.max(0, Number(line.dislocationAbs))
        : fairYesValue !== null && Number.isFinite(Number(line.chosenSidePriceUsed))
          ? Math.abs(
              (line.chosenSide === "NO" ? clamp(1 - fairYesValue, 0.0005, 0.9995) : fairYesValue) -
                Number(line.chosenSidePriceUsed)
            )
          : null;
    const dislocationAbsText = dislocationAbsValue !== null ? dislocationAbsValue.toFixed(4) : "-";
    const extremePriceMinConfig = getLiveExtremePriceMinConfigFromEnv();
    const extremePriceMaxConfig = getLiveExtremePriceMaxConfigFromEnv(extremePriceMinConfig);
    const extremePriceFilterHitValue =
      typeof line.extremePriceFilterHit === "boolean"
        ? line.extremePriceFilterHit
        : (Number.isFinite(Number(line.chosenSidePriceUsed)) &&
            (Number(line.chosenSidePriceUsed) > extremePriceMaxConfig ||
              Number(line.chosenSidePriceUsed) < extremePriceMinConfig)) ||
          normalizeHoldReason(line.blockedBy || line.holdReason || "") === "EXTREME_PRICE_FILTER";
    const extremePriceFilterHitText = String(Boolean(extremePriceFilterHitValue));
    const blockerPriorityAppliedValue =
      typeof line.blockerPriorityApplied === "boolean"
        ? line.blockerPriorityApplied
        : isPriorityBlockerReason(normalizeHoldReason(line.blockedBy || line.holdReason || ""));
    const blockerPriorityAppliedText = String(blockerPriorityAppliedValue);
    const selectedActive =
      selected !== "-" &&
      ((Number.isFinite(Number(line.tauSec)) && Number(line.tauSec) > 0) ||
        (Number.isFinite(Number(persistedSnapshot.remainingSec)) &&
          Number(persistedSnapshot.remainingSec) > 0));
    const effectiveLastUpdateTs = Math.max(
      0,
      Number(line.lastFetchOkTs ?? 0),
      Number(this.polyState.lastUpdateTs || 0),
      Number(this.polyState.lastFetchOkTs || 0)
    );
    const staleState = this.getSelectionFreshnessWarning(nowTs, effectiveLastUpdateTs, selectedActive);
    const warningStateText = String(this.combineWarningStates(line.warningState ?? persistedSnapshot.warningState ?? null, staleState ? "DISCOVERY_STALE" : null) || "-");
    const staleStateText = String(persistedSnapshot.staleState || staleState || "-");
    const pollModeText = String(persistedSnapshot.pollMode || "-");
    const chosenSideText = String(line.chosenSide || persistedSnapshot.chosenSide || "-");
    const chosenDirectionText = String(line.chosenDirection || persistedSnapshot.chosenDirection || "-");
    const openTradesText = Number.isFinite(Number(line.openTrades))
      ? String(Math.max(0, Math.floor(Number(line.openTrades))))
      : "-";
    const holdReasonText = String(line.holdReason || persistedSnapshot.holdReason || "-");
    const dataHealthBlockText = String(
      normalizeHoldReason(line.dataHealthBlock || (isDataHealthBlockReason(line.holdReason) ? line.holdReason : "")) || "-"
    );
    const strategyBlockText = String(
      normalizeHoldReason(line.strategyBlock || (!isDataHealthBlockReason(line.holdReason) ? line.holdReason : "")) || "-"
    );
    const blockedByText = String(
      normalizeHoldReason(line.blockedBy || line.dataHealthBlock || line.strategyBlock || line.holdReason || "") || "-"
    );
    const holdCategoryText = String(line.blockedCategory || (dataHealthBlockText !== "-" ? "DATA_HEALTH" : strategyBlockText !== "-" ? "STRATEGY" : "-"));
    const statusText =
      persistedSnapshot.status && persistedSnapshot.status !== "RUNNING"
        ? persistedSnapshot.status
        : this.runtimeStartupState === "STARTING"
        ? "STARTING"
        : this.runtimeStartupState === "HOLD_NO_ACTIVE_BTC5M_MARKET" && !selectedActive
          ? "NO_ACTIVE_BTC5M_MARKET"
          : warningStateText !== "-"
            ? "DEGRADED"
            : "RUNNING";
    const signature = JSON.stringify({
      status: statusText,
      selected,
      selectedTokenId,
      selectedBookable: persistedSnapshot.selectedBookable,
      selectedTradable: persistedSnapshot.selectedTradable,
      discoveredCurrent: persistedSnapshot.discoveredCurrent,
      discoveredNext: persistedSnapshot.discoveredNext,
      selectionSource: persistedSnapshot.selectionSource,
      selectedFrom: persistedSnapshot.selectedFrom,
      selectionCommitTs: persistedSnapshot.selectionCommitTs,
      liveValidationReason: persistedSnapshot.liveValidationReason,
      currentBucketSlug: persistedSnapshot.currentBucketSlug,
      nextBucketSlug: persistedSnapshot.nextBucketSlug,
      remainingBucket: this.getLogRemainingSecBucket(remainingSecValue),
      chosenSide: chosenSideText,
      chosenDirection: chosenDirectionText,
      action: actionRoot,
      holdReason: holdReasonText,
      blockedBy: blockedByText,
      dataHealthBlock: dataHealthBlockText,
      strategyBlock: strategyBlockText,
      warningState: warningStateText,
      staleState: staleStateText,
      pollMode: pollModeText,
      openTrades: openTradesText,
      yesBid: yesBidText,
      yesAsk: yesAskText,
      noBid: noBidText,
      noAsk: noAskText,
      yesSpread: yesSpreadText,
      noSpread: noSpreadText,
      outcomePricesHint: outcomePricesHintText,
      fairYes: fairYesText,
      fairPriceSource: fairPriceSourceText,
      fairPriceModelOrigin: fairPriceModelOriginText,
      chosenSidePriceUsed: chosenSidePriceUsedText,
      dislocationAbs: dislocationAbsText,
      minDislocationConfig: minDislocationConfigText,
      extremePriceFilterHit: extremePriceFilterHitText,
      blockerPriorityApplied: blockerPriorityAppliedText,
      feeBpsUsed: feeBpsUsedText,
      slippageBpsUsed: slippageBpsUsedText,
      safetyBpsUsed: safetyBpsUsedText,
      rawYesEdgeBeforeCosts: rawYesEdgeBeforeCostsText,
      rawNoEdgeBeforeCosts: rawNoEdgeBeforeCostsText,
      yesEdgeAfterCosts: yesEdgeAfterCostsText,
      noEdgeAfterCosts: noEdgeAfterCostsText,
      chosenEdgeBeforeClamp: chosenEdgeBeforeClampText,
      chosenEdgeAfterClamp: chosenEdgeAfterClampText,
      edgeClampReason: edgeClampReasonText,
      blockerSource: blockerSourceText,
      riskBlockReasonInternal: riskBlockReasonInternalText,
      baseTargetNotional: baseTargetNotionalText,
      cappedNotional: cappedNotionalText,
      computedOrderNotional: computedOrderNotionalText,
      computedShares: computedSharesText,
      maxAchievableShares: maxAchievableSharesText,
      configFeasible: configFeasibleText,
      minOrderNotionalConfig: minOrderNotionalConfigText,
      minSharesRequired: minSharesRequiredText,
      minSharesRequiredConfig: minSharesRequiredConfigText,
      maxNotionalPerWindowConfig: maxNotionalPerWindowConfigText,
      sizingCapApplied: sizingCapAppliedText,
      sizingRejectReason: sizingRejectReasonText,
      bookabilityFailReason: bookabilityFailReasonText,
      tradabilityFailReason: tradabilityFailReasonText,
      tokenLiquiditySnapshot: tokenLiquiditySnapshotText
    });
    if (signature === this.lastPolyStatusSignature) {
      return;
    }
    this.lastPolyStatusSignature = signature;
    this.logger.info(
      `POLY_STATUS status=${statusText} selectedSlug=${selected} selectedTokenId=${selectedTokenId} selectedBookable=${String(
        persistedSnapshot.selectedBookable
      )} selectedTradable=${String(persistedSnapshot.selectedTradable)} discoveredCurrent=${String(
        persistedSnapshot.discoveredCurrent
      )} discoveredNext=${String(persistedSnapshot.discoveredNext)} selectionSource=${String(
        persistedSnapshot.selectionSource || "-"
      )} selectedFrom=${String(persistedSnapshot.selectedFrom || persistedSnapshot.selectionSource || "-")} selectionCommitTs=${String(
        persistedSnapshot.selectionCommitTs || "-"
      )} liveValidationReason=${String(persistedSnapshot.liveValidationReason || "-")} remainingSec=${remaining} chosenSide=${chosenSideText} chosenDirection=${chosenDirectionText} action=${actionRoot} holdReason=${holdReasonText} blockedBy=${blockedByText} holdCategory=${holdCategoryText} dataHealthBlock=${dataHealthBlockText} strategyBlock=${strategyBlockText} warningState=${warningStateText} staleState=${staleStateText} pollMode=${pollModeText} openTradesCount=${openTradesText} candidatesCount=${Math.max(candidatesCount, Number(persistedSnapshot.discoveredCandidatesCount || 0))} windowsCount=${Math.max(Number(line.afterWindowCount ?? 0), Number(persistedSnapshot.windowsCount || 0))} minEdgeThresholdConfig=${Number(
        this.config.polymarket.live.minEdgeThreshold
      ).toFixed(4)} dynamicThresholdMetric=${dynamicThresholdMetricText} bestEdge=${bestEdgeText} modelEdge=${bestEdgeText} pUpModel=${pUpModelText} yesBid=${yesBidText} yesAsk=${yesAskText} noBid=${noBidText} noAsk=${noAskText} yesSpread=${yesSpreadText} noSpread=${noSpreadText} outcomePricesHint=${outcomePricesHintText} fairYes=${fairYesText} fairPriceSource=${fairPriceSourceText} fairPriceModelOrigin=${fairPriceModelOriginText} chosenSidePriceUsed=${chosenSidePriceUsedText} dislocationAbs=${dislocationAbsText} minDislocationConfig=${minDislocationConfigText} extremePriceFilterHit=${extremePriceFilterHitText} blockerPriorityApplied=${blockerPriorityAppliedText} feeBpsUsed=${feeBpsUsedText} slippageBpsUsed=${slippageBpsUsedText} safetyBpsUsed=${safetyBpsUsedText} rawYesEdgeBeforeCosts=${rawYesEdgeBeforeCostsText} rawNoEdgeBeforeCosts=${rawNoEdgeBeforeCostsText} yesEdgeAfterCosts=${yesEdgeAfterCostsText} noEdgeAfterCosts=${noEdgeAfterCostsText} chosenEdgeBeforeClamp=${chosenEdgeBeforeClampText} chosenEdgeAfterClamp=${chosenEdgeAfterClampText} edgeClampReason=${edgeClampReasonText} blockerSource=${blockerSourceText} riskBlockReasonInternal=${riskBlockReasonInternalText} baseTargetNotional=${baseTargetNotionalText} cappedNotional=${cappedNotionalText} computedOrderNotional=${computedOrderNotionalText} computedShares=${computedSharesText} maxAchievableShares=${maxAchievableSharesText} configFeasible=${configFeasibleText} minOrderNotionalConfig=${minOrderNotionalConfigText} minSharesRequired=${minSharesRequiredText} minSharesRequiredConfig=${minSharesRequiredConfigText} maxNotionalPerWindowConfig=${maxNotionalPerWindowConfigText} sizingCapApplied=${sizingCapAppliedText} sizingRejectReason=${sizingRejectReasonText} bookabilityFailReason=${bookabilityFailReasonText} tradabilityFailReason=${tradabilityFailReasonText} tokenLiquiditySnapshot=${tokenLiquiditySnapshotText} btcMid=${
        Number.isFinite(Number(persistedSnapshot.currentBtcMid)) && Number(persistedSnapshot.currentBtcMid) > 0
          ? Number(persistedSnapshot.currentBtcMid).toFixed(2)
          : "-"
      } currentBucketSlug=${String(persistedSnapshot.currentBucketSlug || "-")} nextBucketSlug=${String(
        persistedSnapshot.nextBucketSlug || "-"
      )} minRemainingSec=${minRemainingSec} maxRemainingSec=${maxRemainingSec}`
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
      if (line.selectedSlug !== null || !this.persistedPolymarketSnapshot.selectedSlug) {
        this.polyState.selectedSlug = line.selectedSlug;
      }
    }
    if (line.currentMarketId !== undefined) {
      if (line.currentMarketId !== null || !this.persistedPolymarketSnapshot.selectedMarketId) {
        this.polyState.selectedMarketId = line.currentMarketId;
      }
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
    this.updatePersistedPolymarketSnapshotFromTick(line, tickTs);
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(tickTs);
    const hasActiveSelection = Boolean(
      persistedSnapshot.selectedSlug || persistedSnapshot.selectedMarketId
    );
    if (!hasActiveSelection) {
      this.clearInactiveSelectionState();
    } else {
      this.truthSelection = {
        finalCandidatesCount: persistedSnapshot.finalCandidatesCount,
        selectedSlug: persistedSnapshot.selectedSlug,
        selectedMarketId: persistedSnapshot.selectedMarketId,
        windowStartTs: persistedSnapshot.windowStartTs,
        windowEndTs: persistedSnapshot.windowEndTs,
        remainingSec: persistedSnapshot.remainingSec
      };
    }
    const projectedChosenDirection =
      line.chosenDirection !== undefined
        ? line.chosenDirection
        : line.chosenSide !== undefined
          ? line.chosenSide
            ? normalizeDirectionalDisplayLabel(null, null, line.chosenSide)
            : null
          : persistedSnapshot.chosenDirection;
    if (projectedChosenDirection !== undefined) {
      this.truthChosenDirection = projectedChosenDirection;
    }
    if (line.chosenSide !== undefined) {
      this.truthChosenSide = line.chosenSide ?? null;
    } else if (persistedSnapshot.chosenSide !== undefined) {
      this.truthChosenSide = persistedSnapshot.chosenSide ?? null;
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
    if (!hasActiveSelection) {
      this.truthChosenSide = null;
      this.truthChosenDirection = null;
      this.truthEntriesInWindow = null;
      this.truthWindowRealizedPnlUsd = null;
      this.truthResolutionSource = null;
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
    this.polyEngineRunning =
      this.running || this.polyState.lastFetchAttemptTs > 0 || this.runtimeStartupState !== "STARTING";
    const actionRoot = this.getTickActionRoot(line.action);
    if (actionRoot === "HOLD") {
      this.truthHoldReason = normalizeHoldReason(line.holdReason || persistedSnapshot.holdReason || line.action);
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
    const persistedSnapshot = this.getPersistedPolymarketSnapshot(params.ts);
    const selectionSnapshot = this.getTruthSelectionSnapshot(params.ts);
    const hasActiveSelection = Boolean(
      selectionSnapshot.selectedSlug || selectionSnapshot.selectedMarketId
    );
    this.truthReporter.updatePolymarket({
      ts: params.ts,
      force: params.force ?? false,
      mode: this.config.polymarket.mode === "paper" ? "PAPER" : "LIVE",
      liveConfirmed: this.config.polymarket.liveConfirmed,
      liveExecutionEnabled: this.config.polymarket.liveExecutionEnabled,
      killSwitch: this.config.polymarket.killSwitch,
      enabled: this.config.polymarket.enabled,
      polyEngineRunning:
        this.running ||
        this.polyEngineRunning ||
        this.polyState.lastFetchAttemptTs > 0 ||
        this.runtimeStartupState !== "STARTING",
      fetchOk: this.polyState.lastFetchOkTs > 0 && this.polyState.lastHttpStatus === 200,
      threshold: this.config.polymarket.live.minEdgeThreshold,
      discoveredAtTs: persistedSnapshot.discoveredAtTs,
      marketExpiresAtTs: persistedSnapshot.marketExpiresAtTs,
      warningState: persistedSnapshot.warningState,
      pollMode: persistedSnapshot.pollMode,
      staleState: persistedSnapshot.staleState,
      currentMarketStatus: persistedSnapshot.status,
      currentMarketSlug: persistedSnapshot.selectedSlug ?? persistedSnapshot.selectedMarketId,
      currentMarketRemainingSec: persistedSnapshot.remainingSec,
      currentMarketExpiresAt: persistedSnapshot.marketExpiresAtTs ?? persistedSnapshot.windowEndTs,
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
      holdReason: persistedSnapshot.holdReason ?? this.truthHoldReason,
      blockedBy:
        normalizeHoldReason(
          persistedSnapshot.executionBlockedReason ||
            persistedSnapshot.holdReason ||
            this.truthHoldReason
        ) ?? null,
      currentWindowHoldReason: hasActiveSelection ? (persistedSnapshot.holdReason ?? this.truthHoldReason) : null,
      holdCategory: persistedSnapshot.holdCategory,
      strategyAction: persistedSnapshot.strategyAction,
      selectedTokenId: persistedSnapshot.selectedTokenId,
      selectedBookable: persistedSnapshot.selectedBookable,
      selectedTradable: persistedSnapshot.selectedTradable,
      discoveredCurrent: persistedSnapshot.discoveredCurrent,
      discoveredNext: persistedSnapshot.discoveredNext,
      selectionSource: persistedSnapshot.selectionSource,
      selectedFrom: persistedSnapshot.selectedFrom ?? persistedSnapshot.selectionSource,
      selectionCommitTs: persistedSnapshot.selectionCommitTs,
      liveValidationReason: persistedSnapshot.liveValidationReason,
      lastBookTs: persistedSnapshot.lastBookTs,
      lastQuoteTs: persistedSnapshot.lastQuoteTs,
      currentBucketSlug: persistedSnapshot.currentBucketSlug,
      nextBucketSlug: persistedSnapshot.nextBucketSlug,
      currentBucketStartSec: persistedSnapshot.currentBucketStartSec,
      selectedWindowStartSec: persistedSnapshot.selectedWindowStartSec,
      selectedWindowEndSec: persistedSnapshot.selectedWindowEndSec,
      candidateRefreshed: persistedSnapshot.candidateRefreshed,
      lastPreorderValidationReason: persistedSnapshot.lastPreorderValidationReason,
      chosenSide: hasActiveSelection
        ? persistedSnapshot.chosenSide ?? this.truthChosenSide ?? this.getLiveSelectionSideHint(selectionSnapshot, params.ts)
        : null,
      chosenDirection: hasActiveSelection
        ? persistedSnapshot.chosenDirection ?? this.truthChosenDirection ?? this.getLiveSelectionDirectionHint(selectionSnapshot, params.ts)
        : null,
      entriesInWindow: hasActiveSelection ? this.truthEntriesInWindow : null,
      windowRealizedPnlUsd: hasActiveSelection ? this.truthWindowRealizedPnlUsd : null,
      resolutionSource: hasActiveSelection ? this.truthResolutionSource : null,
      finalCandidatesCount: persistedSnapshot.finalCandidatesCount,
      discoveredCandidatesCount: persistedSnapshot.discoveredCandidatesCount,
      windowsCount: persistedSnapshot.windowsCount,
      selectedSlug: selectionSnapshot.selectedSlug,
      selectedMarketId: selectionSnapshot.selectedMarketId,
      windowStartTs: selectionSnapshot.windowStartTs,
      windowEndTs: selectionSnapshot.windowEndTs,
      remainingSec: selectionSnapshot.remainingSec,
      lastDiscoverySuccessTs: persistedSnapshot.lastDiscoverySuccessTs,
      lastDecisionTs: persistedSnapshot.lastDecisionTs,
      lastSelectedMarketTs: persistedSnapshot.lastSelectedMarketTs,
      currentBtcMid: persistedSnapshot.currentBtcMid,
      statusLine: persistedSnapshot.statusLine,
      whyNotTrading: persistedSnapshot.holdReason ?? this.truthHoldReason,
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
    this.polyEngineRunning = false;
    this.runtimeStartupState = "STARTING";
    this.runtimeStartupStateReason = reason;
    this.runtimeStartupWatchdogLastLogTs = 0;
    this.runtimeStartupWatchdogLastSignature = "";
    this.liveCommittedSelection = null;
    this.lastExpectedCurrentBtc5mSlugLogged = null;
    this.lastDelayedBookConfirmationSignature = "";
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
  noBid?: number | null;
  noAsk?: number | null;
  yesMid?: number | null;
  yesSpread?: number | null;
  noSpread?: number | null;
  outcomePricesHint?: number[] | null;
  fairYes?: number | null;
  fairPriceSource?: "MODEL" | "OUTCOME_HINT" | "NONE";
  fairPriceModelOrigin?: string | null;
  chosenSidePriceUsed?: number | null;
  dislocationAbs?: number | null;
  minDislocationConfig?: number | null;
  extremePriceFilterHit?: boolean | null;
  blockerPriorityApplied?: boolean | null;
  feeBpsUsed?: number | null;
  slippageBpsUsed?: number | null;
  safetyBpsUsed?: number | null;
  baseTargetNotional?: number | null;
  cappedNotional?: number | null;
  computedOrderNotional?: number | null;
  computedShares?: number | null;
  maxAchievableShares?: number | null;
  configFeasible?: boolean | null;
  minOrderNotionalConfig?: number | null;
  minSharesRequired?: number | null;
  minSharesRequiredConfig?: number | null;
  maxNotionalPerWindowConfig?: number | null;
  sizingCapApplied?: boolean | null;
  sizingRejectReason?:
    | "NONE"
    | "BELOW_MIN_NOTIONAL"
    | "BELOW_MIN_SHARES"
    | "OVER_CAP_ADJUSTED"
    | "CONFIG_INFEASIBLE_MIN_SHARES"
    | null;
  blockerSource?: "RISK" | "BOOKABILITY" | "TRADABILITY" | "STRATEGY" | null;
  riskBlockReasonInternal?: string | null;
  bookabilityFailReason?: "NONE" | "NO_BOOK" | "MISSING_TOKEN" | "STALE_BOOK" | "INVALID_PRICE" | "OTHER";
  tradabilityFailReason?: "NONE" | "NOT_ACCEPTING" | "WINDOW_CLOSED" | "MARKET_CLOSED" | "OTHER";
  tokenLiquiditySnapshot?: {
    yesBid: number | null;
    yesAsk: number | null;
    noBid: number | null;
    noAsk: number | null;
    yesSpread: number | null;
    noSpread: number | null;
  } | null;
  rawYesEdgeBeforeCosts?: number | null;
  rawNoEdgeBeforeCosts?: number | null;
  yesEdgeAfterCosts?: number | null;
  noEdgeAfterCosts?: number | null;
  chosenEdgeBeforeClamp?: number | null;
  chosenEdgeAfterClamp?: number | null;
  edgeClampReason?: "NONE" | "NEGATIVE" | "NO_BOOK" | "INVALID_PRICE" | "SPREAD_GUARD" | "OTHER";
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
  score?: number | null;
  threshold: number | null;
  action: string;
  paperWouldTrade?: boolean | null;
  liveWouldTrade?: boolean | null;
  blockedBy?: string | null;
  blockedCategory?: HoldCategory | null;
  strategyBlock?: string | null;
  dataHealthBlock?: string | null;
  staleState?: "ACTIVE_MARKET_REFRESH_FAILED" | "ACTIVE_MARKET_PRICE_STALE" | "DISCOVERY_STALE" | null;
  selectedTokenId?: string | null;
  selectedBookable?: boolean | null;
  selectedTradable?: boolean | null;
  discoveredCurrent?: boolean | null;
  discoveredNext?: boolean | null;
  selectionSource?: SelectionSource | null;
  selectedFrom?: SelectionSource | null;
  selectionCommitTs?: number | null;
  liveValidationReason?: string | null;
  lastBookTs?: number | null;
  lastQuoteTs?: number | null;
  currentBucketSlug?: string | null;
  nextBucketSlug?: string | null;
  currentBucketStartSec?: number | null;
  candidateRefreshed?: boolean | null;
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
    normalized.includes("network") ||
    normalized.includes("price_fetch") ||
    normalized.includes("orderbook") ||
    normalized.includes("bookable") ||
    normalized.includes("invalid_signature")
  ) {
    return { stage: "dataHealth", reason: normalized };
  }
  if (
    normalized.includes("preorder") ||
    normalized.includes("order_failed") ||
    normalized.includes("live_rejected") ||
    normalized.includes("non_positive_size")
  ) {
    return { stage: "dataHealth", reason: normalized };
  }
  if (normalized.includes("spread")) {
    return { stage: "pattern", reason: normalized };
  }
  return { stage: "scoring", reason: normalized };
}

function deriveEdgeClampReason(input: {
  chosenEdgeBeforeClamp: number | null;
  blockReason: string | null;
}): "NONE" | "NEGATIVE" | "NO_BOOK" | "INVALID_PRICE" | "SPREAD_GUARD" | "OTHER" {
  const normalized = normalizeHoldReason(String(input.blockReason || "").trim()) || null;
  if (normalized === "SPREAD_TOO_WIDE") return "SPREAD_GUARD";
  if (
    normalized === "SIDE_NOT_BOOKABLE" ||
    normalized === "MISSING_ORDERBOOK" ||
    normalized === "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN" ||
    normalized === "TOKEN_NOT_BOOKABLE"
  ) {
    return "NO_BOOK";
  }
  if (
    normalized === "MISSING_BBO" ||
    normalized === "CROSSED_BBO" ||
    normalized === "PRICE_UNAVAILABLE" ||
    normalized === "PRICE_FETCH_FAILED" ||
    normalized === "PRICE_REFRESH_FAILED_ACTIVE_MARKET"
  ) {
    return "INVALID_PRICE";
  }
  if (
    input.chosenEdgeBeforeClamp !== null &&
    Number.isFinite(input.chosenEdgeBeforeClamp) &&
    input.chosenEdgeBeforeClamp <= 0
  ) {
    return "NEGATIVE";
  }
  if (!normalized) {
    return "NONE";
  }
  return "OTHER";
}

function deriveBookabilityFailReason(input: {
  blockedReason: string | null;
  selectedTokenId: string | null;
  selectedBookable: boolean;
  selectedSideBookabilityReason: string | null;
  liveValidationReason: string | null;
}): "NONE" | "NO_BOOK" | "MISSING_TOKEN" | "STALE_BOOK" | "INVALID_PRICE" | "OTHER" {
  if (input.selectedBookable) {
    return "NONE";
  }
  if (!String(input.selectedTokenId || "").trim()) {
    return "MISSING_TOKEN";
  }
  const reason = `${String(input.selectedSideBookabilityReason || "")} ${String(input.liveValidationReason || "")} ${String(input.blockedReason || "")}`
    .trim()
    .toUpperCase();
  if (!reason) {
    return "OTHER";
  }
  if (
    reason.includes("MISSING_ORDERBOOK") ||
    reason.includes("SIDE_NOT_BOOKABLE") ||
    reason.includes("TOKEN_NOT_BOOKABLE") ||
    reason.includes("NO_ORDERBOOK")
  ) {
    return "NO_BOOK";
  }
  if (reason.includes("STALE")) {
    return "STALE_BOOK";
  }
  if (
    reason.includes("MISSING_BBO") ||
    reason.includes("CROSSED_BBO") ||
    reason.includes("PRICE_FETCH_FAILED") ||
    reason.includes("PRICE_UNAVAILABLE")
  ) {
    return "INVALID_PRICE";
  }
  return "OTHER";
}

function deriveTradabilityFailReason(input: {
  blockedReason: string | null;
  selectedTradable: boolean;
  liveValidationReason: string | null;
  acceptingOrders: boolean | null;
}): "NONE" | "NOT_ACCEPTING" | "WINDOW_CLOSED" | "MARKET_CLOSED" | "OTHER" {
  if (input.selectedTradable) {
    return "NONE";
  }
  const reason = `${String(input.liveValidationReason || "")} ${String(input.blockedReason || "")}`
    .trim()
    .toUpperCase();
  if (input.acceptingOrders === false || reason.includes("NOT_ACCEPTING")) {
    return "NOT_ACCEPTING";
  }
  if (
    reason.includes("EXPIRED_WINDOW") ||
    reason.includes("TOO_LATE_FOR_ENTRY") ||
    reason.includes("NO_NEW_ORDERS_FINAL_SECONDS") ||
    reason.includes("NON_CURRENT_OR_NEXT_WINDOW") ||
    reason.includes("WINDOW")
  ) {
    return "WINDOW_CLOSED";
  }
  if (reason.includes("MARKET_CLOSED") || reason.includes("MARKET_ARCHIVED") || reason.includes("AWAITING_RESOLUTION")) {
    return "MARKET_CLOSED";
  }
  return reason ? "OTHER" : "NONE";
}

function deriveBlockerSourceTelemetry(input: {
  blockedCategory: HoldCategory | null;
  blockedReason: string | null;
  bookabilityFailReason: "NONE" | "NO_BOOK" | "MISSING_TOKEN" | "STALE_BOOK" | "INVALID_PRICE" | "OTHER";
  tradabilityFailReason: "NONE" | "NOT_ACCEPTING" | "WINDOW_CLOSED" | "MARKET_CLOSED" | "OTHER";
}): "RISK" | "BOOKABILITY" | "TRADABILITY" | "STRATEGY" {
  if (input.blockedCategory === "RISK") {
    return "RISK";
  }
  if (input.bookabilityFailReason !== "NONE") {
    return "BOOKABILITY";
  }
  if (input.tradabilityFailReason !== "NONE") {
    return "TRADABILITY";
  }
  const normalized = normalizeHoldReason(input.blockedReason || "");
  if (
    normalized === "SIDE_NOT_BOOKABLE" ||
    normalized === "MISSING_ORDERBOOK" ||
    normalized === "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN"
  ) {
    return "BOOKABILITY";
  }
  if (
    normalized === "EXPIRED_WINDOW" ||
    normalized === "MARKET_CLOSED_AWAITING_OUTCOME" ||
    normalized === "NO_ACTIVE_BTC5M_MARKET" ||
    normalized === "NO_ACTIVE_WINDOWS"
  ) {
    return "TRADABILITY";
  }
  return "STRATEGY";
}

function getLiveMinDislocationConfigFromEnv(): number {
  const raw = Number(process.env.POLYMARKET_LIVE_MIN_DISLOCATION || 0.03);
  if (!Number.isFinite(raw)) return 0.03;
  return clamp(raw, 0, 1);
}

function getLiveExtremePriceMinConfigFromEnv(): number {
  const raw = Number(process.env.POLYMARKET_LIVE_EXTREME_PRICE_MIN || 0.05);
  if (!Number.isFinite(raw)) return 0.05;
  return clamp(raw, 0.0001, 0.99);
}

function getLiveExtremePriceMaxConfigFromEnv(minValue: number): number {
  const raw = Number(process.env.POLYMARKET_LIVE_EXTREME_PRICE_MAX || 0.95);
  if (!Number.isFinite(raw)) return clamp(0.95, minValue, 0.9999);
  return clamp(raw, minValue, 0.9999);
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
  const slugStartSec = parseBtc5mWindowStartSec(slug);
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
  const archived = pickRawBoolean(row, ["archived", "is_archived"], false);
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
  const normalizedEndTs =
    endTs > 0
      ? endTs
      : slugStartSec !== null
        ? (slugStartSec + FIVE_MIN_SEC) * 1000
        : fallbackWindowEndMs;
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
  const normalizedStartTs = startTs > 0 ? startTs : slugStartSec !== null ? slugStartSec * 1000 : undefined;
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
    startTs: normalizedStartTs,
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
    archived,
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
    message.includes("epipe") ||
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

function isMissingOrderbookError(error: unknown): boolean {
  const message = String(
    error && typeof error === "object" && "message" in error
      ? (error as { message?: unknown }).message
      : error
  )
    .toLowerCase()
    .trim();

  return (
    message.includes("no orderbook exists") ||
    message.includes("requested token id") ||
    message.includes("orderbook not found")
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
  if (upper === "OK") return null;
  if (upper.startsWith("HOLD:")) {
    return normalizeHoldReason(raw.slice(5));
  }
  if (upper === "HOLD") return "HOLD_UNSPECIFIED";
  if (upper.includes("HOLD_UNSPECIFIED")) return "HOLD_UNSPECIFIED";
  if (upper.includes("HOLD_GENERIC")) return "HOLD_UNSPECIFIED";
  if (upper.includes("MODEL_NOT_EXTREME") || upper.includes("NON_EXTREME_PRICE")) return "NON_EXTREME_PRICE";
  if (upper.includes("AWAITING_NEXT_MARKET_DISCOVERY")) return "AWAITING_NEXT_MARKET_DISCOVERY";
  if (upper.includes("PRICE_UNAVAILABLE")) return "PRICE_UNAVAILABLE";
  if (upper.includes("PRICE_FETCH_FAILED") || upper.includes("QUOTE_FAILURE") || upper.includes("EMPTY_LIVE_QUOTE")) {
    return "PRICE_UNAVAILABLE";
  }
  if (upper.includes("SIDE_NOT_BOOKABLE") || upper.includes("MISSING_ORDERBOOK")) return "SIDE_NOT_BOOKABLE";
  if (upper.includes("ORDER_POST_REJECTED")) return "ORDER_POST_REJECTED";
  if (upper.includes("ORDER_FAILED") || upper.includes("LIVE_REJECTED")) return "ORDER_POST_REJECTED";
  if (upper.includes("SIZE (") && upper.includes("LOWER THAN THE MINIMUM: 5")) return "ORDER_SIZE_BELOW_MIN_SHARES";
  if (upper.includes("ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED")) return "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED";
  if (upper.includes("ORDER_SIZE_BELOW_MIN_SHARES")) return "ORDER_SIZE_BELOW_MIN_SHARES";
  if (upper.includes("STARTUP_INCOMPLETE_NO_USABLE_WINDOW")) return "STARTUP_INCOMPLETE_NO_USABLE_WINDOW";
  if (upper.includes("NO_ACTIVE_BTC5M_MARKET") || upper.includes("BTC5M_NOT_FOUND")) return "NO_ACTIVE_BTC5M_MARKET";
  if (upper.includes("NO_ACTIVE_WINDOWS")) return "NO_ACTIVE_WINDOWS";
  if (upper.includes("SELECTION_NOT_COMMITTED")) return "SELECTION_NOT_COMMITTED";
  if (upper.includes("NON_CURRENT_OR_NEXT_WINDOW")) return "NON_CURRENT_OR_NEXT_WINDOW";
  if (upper.includes("EXPIRED_WINDOW")) return "EXPIRED_WINDOW";
  if (upper.includes("AWAITING_RESOLUTION") || upper.includes("MARKET_CLOSED_AWAITING_OUTCOME")) {
    return "AWAITING_RESOLUTION";
  }
  if (upper.includes("NO_NEW_ORDERS_FINAL_SECONDS")) return "NO_NEW_ORDERS_FINAL_SECONDS";
  if (upper.includes("OPEN_POSITION_IN_WINDOW")) return "OPEN_POSITION_IN_WINDOW";
  if (upper.includes("REENTRY_COOLDOWN")) return "REENTRY_COOLDOWN";
  if (upper.includes("TOO_LATE_FOR_ENTRY")) return "TOO_LATE_FOR_ENTRY";
  if (upper.includes("REFRESH_FAILED_ACTIVE_MARKET")) return "REFRESH_FAILED_ACTIVE_MARKET";
  if (upper.includes("ACTIVE_MARKET_REFRESH_FAILED")) return "ACTIVE_MARKET_REFRESH_FAILED";
  if (upper.includes("PRICE_REFRESH_FAILED_ACTIVE_MARKET")) return "PRICE_REFRESH_FAILED_ACTIVE_MARKET";
  if (upper.includes("ACTIVE_MARKET_PRICE_STALE")) return "ACTIVE_MARKET_PRICE_STALE";
  if (upper.includes("SIZE_BELOW_MIN_NOTIONAL")) return "SIZE_BELOW_MIN_NOTIONAL";
  if (upper.includes("CONFIG_INFEASIBLE_MIN_SHARES")) return "CONFIG_INFEASIBLE_MIN_SHARES";
  if (upper.includes("FAIR_PRICE_UNAVAILABLE")) return "FAIR_PRICE_UNAVAILABLE";
  if (upper.includes("EXTREME_PRICE_FILTER")) return "EXTREME_PRICE_FILTER";
  if (upper.includes("INSUFFICIENT_DISLOCATION")) return "INSUFFICIENT_DISLOCATION";
  if (upper.includes("EDGE_BELOW_THRESHOLD_EXECUTION_BUFFER")) return "EDGE_BELOW_THRESHOLD";
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

function isPriorityBlockerReason(reason: string | null | undefined): boolean {
  const normalized = normalizeHoldReason(reason);
  return (
    normalized === "FAIR_PRICE_UNAVAILABLE" ||
    normalized === "EXTREME_PRICE_FILTER" ||
    normalized === "INSUFFICIENT_DISLOCATION" ||
    normalized === "CONFIG_INFEASIBLE_MIN_SHARES" ||
    normalized === "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED" ||
    normalized === "EDGE_BELOW_THRESHOLD"
  );
}

export function evaluateMinSharesConfigFeasibility(input: {
  maxNotionalPerWindow: number;
  chosenSidePriceUsed: number | null;
  minSharesRequiredConfig: number;
}): { maxAchievableShares: number | null; configFeasible: boolean } {
  if (
    !Number.isFinite(Number(input.maxNotionalPerWindow)) ||
    Number(input.maxNotionalPerWindow) <= 0 ||
    !Number.isFinite(Number(input.chosenSidePriceUsed)) ||
    Number(input.chosenSidePriceUsed) <= 0
  ) {
    return { maxAchievableShares: null, configFeasible: true };
  }
  const maxAchievableShares = Number(input.maxNotionalPerWindow) / Math.max(Number(input.chosenSidePriceUsed), 0.0001);
  const configFeasible =
    Number.isFinite(Number(input.minSharesRequiredConfig)) &&
    Number(input.minSharesRequiredConfig) > 0
      ? maxAchievableShares + 1e-9 >= Number(input.minSharesRequiredConfig)
      : true;
  return { maxAchievableShares, configFeasible };
}

export function resolvePriorityBlockedReason(input: {
  currentReason: string | null | undefined;
  fairPriceSource: "MODEL" | "OUTCOME_HINT" | "NONE";
  extremePriceFilterHit: boolean;
  dislocationAbs: number | null;
  minDislocationConfig: number | null;
  sizingRejectReason: string | null;
  configFeasible: boolean;
}): string | null {
  const normalizedCurrent = normalizeHoldReason(input.currentReason);
  const gateComparable =
    normalizedCurrent === null ||
    normalizedCurrent === "EDGE_BELOW_THRESHOLD" ||
    normalizedCurrent === "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED" ||
    normalizedCurrent === "SIZE_BELOW_MIN_NOTIONAL" ||
    normalizedCurrent === "FAIR_PRICE_UNAVAILABLE" ||
    normalizedCurrent === "EXTREME_PRICE_FILTER" ||
    normalizedCurrent === "INSUFFICIENT_DISLOCATION" ||
    normalizedCurrent === "CONFIG_INFEASIBLE_MIN_SHARES";
  if (!gateComparable) {
    return normalizedCurrent;
  }

  if (input.fairPriceSource === "NONE") return "FAIR_PRICE_UNAVAILABLE";
  if (input.extremePriceFilterHit) return "EXTREME_PRICE_FILTER";
  if (
    input.dislocationAbs !== null &&
    Number.isFinite(input.dislocationAbs) &&
    input.minDislocationConfig !== null &&
    Number.isFinite(input.minDislocationConfig) &&
    input.dislocationAbs < input.minDislocationConfig
  ) {
    return "INSUFFICIENT_DISLOCATION";
  }
  if (!input.configFeasible) return "CONFIG_INFEASIBLE_MIN_SHARES";
  if (
    input.sizingRejectReason === "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED" ||
    normalizedCurrent === "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED"
  ) {
    return "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED";
  }
  if (
    input.sizingRejectReason === "EDGE_BELOW_THRESHOLD" ||
    normalizedCurrent === "EDGE_BELOW_THRESHOLD"
  ) {
    return "EDGE_BELOW_THRESHOLD";
  }
  return normalizedCurrent;
}

function isDataHealthBlockReason(reason: string | null | undefined): boolean {
  const raw = String(reason || "").trim().toUpperCase();
  if (
    raw.includes("NETWORK") ||
    raw.includes("PRICE_FETCH") ||
    raw.includes("REFRESH_FAILED_ACTIVE_MARKET") ||
    raw.includes("ACTIVE_MARKET_REFRESH_FAILED") ||
    raw.includes("ACTIVE_MARKET_PRICE_STALE")
  ) {
    return true;
  }
  if (raw.includes("ORDERBOOK") || raw.includes("BOOKABLE") || raw.includes("ORACLE")) {
    return true;
  }
  const normalized = normalizeHoldReason(reason);
  if (!normalized) return false;
  return [
    "NETWORK_ERROR",
    "DISCOVERY_STALE",
    "FETCH_STALE",
    "REFRESH_FAILED_ACTIVE_MARKET",
    "ACTIVE_MARKET_REFRESH_FAILED",
    "ACTIVE_MARKET_PRICE_STALE",
    "PRICE_REFRESH_FAILED_ACTIVE_MARKET",
    "NO_DATA",
    "PRICE_FETCH_FAILED",
    "PRICE_UNAVAILABLE",
    "MISSING_ORDERBOOK",
    "SIDE_NOT_BOOKABLE",
    "ORACLE_STALE",
    "ORACLE_STALE_BOOK_STALE",
    "ORACLE_UNAVAILABLE",
    "ORACLE_IDLE",
    "MISSING_BBO",
    "CROSSED_BBO",
    "YES_MID_OUT_OF_RANGE",
    "LIVE_REJECTED"
  ].includes(normalized);
}

function classifyHoldCategory(reason: string | null | undefined): HoldCategory {
  const raw = String(reason || "").trim().toUpperCase();
  if (!raw) return "STRATEGY";
  if (
    raw.includes("KILL_SWITCH") ||
    raw.includes("RISK_") ||
    raw.includes("MAX_EXPOSURE") ||
    raw.includes("DAILY_LOSS") ||
    raw.includes("SIZE_BELOW_MIN_NOTIONAL") ||
    raw.includes("ORDER_SIZE_BELOW_MIN_SHARES") ||
    raw.includes("CONFIG_INFEASIBLE_MIN_SHARES")
  ) {
    return "RISK";
  }
  if (
    raw.includes("INVALID_SIGNATURE") ||
    raw.includes("UNAUTHORIZED") ||
    raw.includes("FORBIDDEN") ||
    raw.includes("AUTH_") ||
    raw.includes("SIGNATURE")
  ) {
    return "AUTH";
  }
  if (
    raw.includes("PREORDER_") ||
    raw.includes("SELECTION_NOT_COMMITTED") ||
    raw.includes("NON_CURRENT_OR_NEXT_WINDOW") ||
    raw.includes("ORDER_ABORT") ||
    raw.includes("LIVE_REJECTED") ||
    raw.includes("OPEN_ORDER_ALREADY_EXISTS") ||
    raw.includes("REMOTE_OPEN_ORDER_ALREADY_EXISTS") ||
    raw.includes("NON_POSITIVE_SIZE") ||
    raw.includes("ORDER_FAILED") ||
    raw.includes("ORDER_POST_REJECTED")
  ) {
    return "EXECUTION";
  }
  if (isDataHealthBlockReason(raw)) {
    return "DATA_HEALTH";
  }
  return "STRATEGY";
}

function resolvePolymarketMarketWsUrl(clobBaseUrl: string): string {
  const envOverride = String(process.env.POLYMARKET_CLOB_WS_URL || "").trim();
  if (envOverride.length > 0) {
    return envOverride;
  }
  const normalized = String(clobBaseUrl || "").trim().replace(/\/+$/, "");
  if (normalized.toLowerCase().includes("clob.polymarket.com")) {
    return "wss://ws-subscriptions-clob.polymarket.com/ws/market";
  }
  return `${normalized.replace(/^http/i, "ws")}/ws/market`;
}

function parseBtc5mWindowStartSec(slug: string | null | undefined): number | null {
  const text = String(slug || "").trim();
  const match = text.match(/btc-updown-5m-(\d{9,12})/i);
  if (!match) return null;
  const startSec = Number(match[1]);
  if (!Number.isFinite(startSec) || startSec <= 0) return null;
  return Math.floor(startSec);
}

function pickDeterministicBtc5mSlugFromMarketLike(market: {
  slug?: string | null;
  eventSlug?: string | null;
  marketId?: string | null;
}): string | null {
  const slug = String(market.slug || "").trim();
  const eventSlug = String(market.eventSlug || "").trim();
  if (parseBtc5mWindowStartSec(slug) !== null) return slug;
  if (parseBtc5mWindowStartSec(eventSlug) !== null) return eventSlug;
  if (slug) return slug;
  if (eventSlug) return eventSlug;
  const marketId = String(market.marketId || "").trim();
  return marketId || null;
}

function rowMatchesBtc5mSlug(row: Record<string, unknown>, slug: string): boolean {
  const normalizedTarget = String(slug || "").trim().toLowerCase();
  if (!normalizedTarget) return false;
  const candidates = [
    pickRawString(row, ["slug", "market_slug"]),
    pickRawString(row, ["eventSlug", "event_slug"])
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => value.length > 0);
  return candidates.includes(normalizedTarget);
}

function looksLikeBtc5mMarket(
  market: Pick<BtcWindowMarket, "slug" | "eventSlug" | "question" | "marketId">
): boolean {
  const texts = [
    String(market.eventSlug || "").trim().toLowerCase(),
    String(market.slug || "").trim().toLowerCase(),
    String(market.question || "").trim().toLowerCase(),
    String(market.marketId || "").trim().toLowerCase()
  ];
  const combined = texts.join(" ");
  const hasBtc = combined.includes("btc") || combined.includes("bitcoin");
  const hasCadence =
    combined.includes("5m") ||
    combined.includes("5 minute") ||
    combined.includes("5-minute") ||
    combined.includes("next 5 minutes");
  const hasDirection =
    combined.includes("updown") ||
    combined.includes("up down") ||
    combined.includes("above") ||
    combined.includes("below") ||
    combined.includes("higher") ||
    combined.includes("lower");
  return hasBtc && hasCadence && hasDirection;
}

function isDeterministicBtc5mMarketUsableNow(
  market: Pick<BtcWindowMarket, "slug" | "eventSlug" | "startTs" | "endTs">,
  activeStartSec: number,
  nowTs: number
): boolean {
  const startSec =
    parseBtc5mWindowStartSec(pickDeterministicBtc5mSlugFromMarketLike(market)) ??
    (Number.isFinite(Number(market.startTs)) && Number(market.startTs) > 0
      ? Math.floor(Number(market.startTs) / 1000)
      : null);
  const endTs = Number(market.endTs);
  if (startSec === null || startSec !== activeStartSec) return false;
  if (!Number.isFinite(endTs) || endTs <= nowTs) return false;
  return true;
}

function rankDeterministicBtc5mMarket(
  market: Pick<BtcWindowMarket, "slug" | "eventSlug" | "startTs" | "endTs" | "acceptingOrders" | "enableOrderBook">,
  activeStartSec: number,
  nowTs: number
): number {
  const startSec =
    parseBtc5mWindowStartSec(pickDeterministicBtc5mSlugFromMarketLike(market)) ??
    (Number.isFinite(Number(market.startTs)) && Number(market.startTs) > 0
      ? Math.floor(Number(market.startTs) / 1000)
      : null);
  const offsetWindows =
    startSec !== null ? Math.floor((startSec - activeStartSec) / FIVE_MIN_SEC) : Number.MAX_SAFE_INTEGER;
  const remainingSec =
    Number.isFinite(Number(market.endTs)) && Number(market.endTs) > 0
      ? Math.max(0, Math.floor((Number(market.endTs) - nowTs) / 1000))
      : 0;
  const absOffset = Math.abs(offsetWindows);
  const offsetPenalty =
    offsetWindows === 0
      ? 0
      : offsetWindows > 0
        ? absOffset * 2
        : absOffset * 2 + 1;
  const acceptingPenalty = market.acceptingOrders === false ? 50 : 0;
  const bookPenalty = market.enableOrderBook === false ? 10 : 0;
  const expiryPenalty = remainingSec <= 0 ? 1_000 : 0;
  return expiryPenalty + offsetPenalty + acceptingPenalty + bookPenalty;
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
