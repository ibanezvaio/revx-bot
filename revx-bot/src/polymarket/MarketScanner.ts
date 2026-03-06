import { BotConfig } from "../config";
import { Logger } from "../logger";
import { GammaSeedScanner } from "./GammaSeedScanner";
import { PolymarketClient, RawPolymarketEvent, RawPolymarketMarket } from "./PolymarketClient";
import { BtcWindowMarket } from "./types";

const MAX_CANDIDATE_PREVIEW = 200;
const MAX_REJECTION_PREVIEW = 10;

export type MarketScanCounters = {
  fetchedCount: number;
  afterActiveCount: number;
  // Legacy aliases kept for compatibility with existing consumers.
  fetchedTotal: number;
  afterSearchCount: number;
  afterWindowCount: number;
  afterPatternCount: number;
  finalCandidatesCount: number;
  pagesScanned: number;
  recentEventsCount: number;
  prefixMatchesCount: number;
  tradableTotal: number;
  btcTotal: number;
  cadenceTotal: number;
  directionTotal: number;
  btc5mCandidates: number;
  activeWindows: number;
};

export type MarketScanAttempt = {
  mode: "primary" | "fallback";
  fallback: "none" | "window" | "patterns" | "topActive";
  searchQuery: string | null;
  minWindowSec: number;
  maxWindowSec: number;
  fetchedCount: number;
  afterActiveCount: number;
  afterSearchCount: number;
  afterWindowCount: number;
  afterPatternCount: number;
  finalCandidatesCount: number;
};

export type MarketScanCandidatePreview = {
  marketId: string;
  question: string;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  closed: boolean;
  active: boolean;
};

export type MarketScanRejection = {
  marketId: string;
  question: string;
  reasons: string[];
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  closed: boolean;
  active: boolean;
};

export type MarketScanWindowRejection = {
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
  rejectReason: string;
};

export type MarketScanWindowSample = {
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
};

export type MarketScanWindowRejectCounters = {
  tooSoon: number;
  tooLate: number;
  invalidEndTs: number;
  invalidRemaining: number;
  unitSecondsDetected: number;
};

export type MarketScanDiagnostics = {
  ts: string;
  counters: MarketScanCounters;
  candidates: MarketScanCandidatePreview[];
  rejectedNotTradable: MarketScanRejection[];
  rejectedWindow: MarketScanWindowRejection[];
  windowSamples: MarketScanWindowSample[];
  activeMarkets: BtcWindowMarket[];
  selectedSlug: string | null;
  selectedWindowStart: number | null;
  selectedWindowEnd: number | null;
  selectedAcceptingOrders: boolean | null;
  selectedEnableOrderBook: boolean | null;
  selectedMarket: BtcWindowMarket | null;
  windowRejectCounters: MarketScanWindowRejectCounters;
  effectiveMinWindowSec: number;
  effectiveMaxWindowSec: number;
  attempts: MarketScanAttempt[];
  fallbackUsed: MarketScanAttempt["fallback"] | null;
};

type RankedMarket = {
  market: BtcWindowMarket;
  score: number;
  preview: MarketScanCandidatePreview;
};

type DiscoveryPassOptions = {
  nowTs: number;
  mode: "primary" | "fallback";
  search?: string;
  patternMode: "ALL" | "BTC_ONLY" | "NONE";
  enforceTauWindow: boolean;
  minWindowSec: number;
  maxWindowSec: number;
  candidateLimit: number;
  stopTarget: number;
  requireTradable: boolean;
  requireDefinedWindow: boolean;
  allowMissingPriceToBeat: boolean;
  sortByPriority: boolean;
  scoreMode: "market" | "relevance";
};

type DiscoveryPassResult = {
  counters: MarketScanCounters;
  candidates: MarketScanCandidatePreview[];
  rejectedNotTradable: MarketScanRejection[];
  rejectedWindow: MarketScanWindowRejection[];
  windowSamples: MarketScanWindowSample[];
  windowRejectCounters: MarketScanWindowRejectCounters;
  activeMarkets: BtcWindowMarket[];
};

const WINDOW_END_FIELDS = [
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
];

const WINDOW_START_FIELDS = [
  "windowStartTs",
  "window_start_ts",
  "startTs",
  "start_ts",
  "startDate",
  "start_date",
  "start_time",
  "startTime"
];

export class MarketScanner {
  private readonly btcPattern: RegExp;
  private readonly cadencePattern: RegExp;
  private readonly directionPattern: RegExp;
  private readonly seedScanner: GammaSeedScanner;
  private readonly primaryMinWindowSec: number;
  private readonly primaryMaxWindowSec: number;
  private lastDiagnostics: MarketScanDiagnostics = {
    ts: new Date(0).toISOString(),
    counters: {
      fetchedCount: 0,
      afterActiveCount: 0,
      fetchedTotal: 0,
      afterSearchCount: 0,
      afterWindowCount: 0,
      afterPatternCount: 0,
      finalCandidatesCount: 0,
      pagesScanned: 0,
      recentEventsCount: 0,
      prefixMatchesCount: 0,
      tradableTotal: 0,
      btcTotal: 0,
      cadenceTotal: 0,
      directionTotal: 0,
      btc5mCandidates: 0,
      activeWindows: 0
    },
    candidates: [],
    rejectedNotTradable: [],
    rejectedWindow: [],
    windowSamples: [],
    activeMarkets: [],
    selectedSlug: null,
    selectedWindowStart: null,
    selectedWindowEnd: null,
    selectedAcceptingOrders: null,
    selectedEnableOrderBook: null,
    selectedMarket: null,
    windowRejectCounters: createWindowRejectCounters(),
    effectiveMinWindowSec: 0,
    effectiveMaxWindowSec: 0,
    attempts: [],
    fallbackUsed: null
  };

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly client: PolymarketClient
  ) {
    const resolvedWindow = resolveWindowBoundsFromEnv(
      config.polymarket.paper.entryMinRemainingSec,
      config.polymarket.paper.entryMaxRemainingSec
    );
    this.primaryMinWindowSec = resolvedWindow.minWindowSec;
    this.primaryMaxWindowSec = resolvedWindow.maxWindowSec;
    this.seedScanner = new GammaSeedScanner(config, logger, client);
    this.btcPattern = safeCompileRegex(
      config.polymarket.marketQuery.patterns.btc,
      "(?:\\bbtc\\b|bitcoin|\\$btc)",
      logger,
      "POLYMARKET_PATTERN_BTC"
    );
    this.cadencePattern = safeCompileRegex(
      config.polymarket.marketQuery.patterns.cadence,
      "(?:\\b5m\\b|\\b5\\s*min(?:ute)?s?\\b|5-minute|5\\s*minute|minute market)",
      logger,
      "POLYMARKET_PATTERN_CADENCE"
    );
    this.directionPattern = safeCompileRegex(
      config.polymarket.marketQuery.patterns.direction,
      "(?:up\\s*/\\s*down|up\\s+down|direction|higher\\s*/\\s*lower|higher|lower|above\\s*/\\s*below|above|below)",
      logger,
      "POLYMARKET_PATTERN_DIRECTION"
    );
  }

  getLastDiagnostics(): MarketScanDiagnostics {
    return {
      ts: this.lastDiagnostics.ts,
      counters: { ...this.lastDiagnostics.counters },
      candidates: this.lastDiagnostics.candidates.map((row) => ({ ...row })),
      rejectedNotTradable: this.lastDiagnostics.rejectedNotTradable.map((row) => ({
        ...row,
        reasons: [...row.reasons]
      })),
      rejectedWindow: this.lastDiagnostics.rejectedWindow.map((row) => ({ ...row })),
      windowSamples: this.lastDiagnostics.windowSamples.map((row) => ({ ...row })),
      activeMarkets: this.lastDiagnostics.activeMarkets.map((row) => ({ ...row })),
      selectedSlug: this.lastDiagnostics.selectedSlug,
      selectedWindowStart: this.lastDiagnostics.selectedWindowStart,
      selectedWindowEnd: this.lastDiagnostics.selectedWindowEnd,
      selectedAcceptingOrders: this.lastDiagnostics.selectedAcceptingOrders,
      selectedEnableOrderBook: this.lastDiagnostics.selectedEnableOrderBook,
      selectedMarket: this.lastDiagnostics.selectedMarket ? { ...this.lastDiagnostics.selectedMarket } : null,
      windowRejectCounters: { ...this.lastDiagnostics.windowRejectCounters },
      effectiveMinWindowSec: this.lastDiagnostics.effectiveMinWindowSec,
      effectiveMaxWindowSec: this.lastDiagnostics.effectiveMaxWindowSec,
      attempts: this.lastDiagnostics.attempts.map((row) => ({ ...row })),
      fallbackUsed: this.lastDiagnostics.fallbackUsed
    };
  }

  getPrimaryWindowConfig(): { minWindowSec: number; maxWindowSec: number } {
    return {
      minWindowSec: this.primaryMinWindowSec,
      maxWindowSec: this.primaryMaxWindowSec
    };
  }

  async scanActiveBtc5m(nowTs = Date.now()): Promise<BtcWindowMarket[]> {
    const diagnostics = await this.scanBtc5m(nowTs);
    return diagnostics.activeMarkets;
  }

  async scanBtc5m(nowTs = Date.now(), options?: { debug?: boolean }): Promise<MarketScanDiagnostics> {
    if (this.seedScanner.hasSeedConfig()) {
      const seeded = await this.seedScanner.scan(nowTs);
      const diagnostics: MarketScanDiagnostics = {
        ts: new Date(nowTs).toISOString(),
        counters: {
          fetchedCount: seeded.fetchedTotal,
          afterActiveCount: seeded.activeMarkets.length,
          fetchedTotal: seeded.fetchedTotal,
          afterSearchCount: seeded.fetchedTotal,
          afterWindowCount: seeded.activeMarkets.length,
          afterPatternCount: seeded.seededTotal,
          finalCandidatesCount: seeded.activeMarkets.length,
          pagesScanned: seeded.pagesScanned,
          recentEventsCount: seeded.recentEventsCount,
          prefixMatchesCount: seeded.prefixMatchesCount,
          tradableTotal: seeded.candidates.filter(
            (row) => row.active && !row.closed && row.enableOrderBook && row.acceptingOrders
          ).length,
          btcTotal: seeded.seededTotal,
          cadenceTotal: seeded.seededTotal,
          directionTotal: seeded.seededTotal,
          btc5mCandidates: seeded.seededTotal,
          activeWindows: seeded.activeMarkets.length
        },
        candidates: seeded.candidates.slice(0, MAX_CANDIDATE_PREVIEW).map((row) => ({
          marketId: row.conditionId,
          question: row.question,
          acceptingOrders: row.acceptingOrders,
          enableOrderBook: row.enableOrderBook,
          closed: row.closed,
          active: row.active
        })),
        rejectedNotTradable: seeded.candidates
          .filter((row) => row.closed || !row.acceptingOrders || !row.enableOrderBook || !row.active)
          .slice(0, MAX_REJECTION_PREVIEW)
          .map((row) => ({
            marketId: row.conditionId,
            question: row.question,
            reasons: [
              ...(row.closed ? ["closed"] : []),
              ...(!row.acceptingOrders ? ["not accepting_orders"] : []),
              ...(!row.enableOrderBook ? ["enable_order_book false"] : []),
              ...(!row.active ? ["not active"] : [])
            ],
            acceptingOrders: row.acceptingOrders,
            enableOrderBook: row.enableOrderBook,
            closed: row.closed,
            active: row.active
          })),
        rejectedWindow: [],
        windowSamples: [],
        activeMarkets: seeded.activeMarkets,
        selectedSlug: seeded.selectedSlug,
        selectedWindowStart: seeded.selectedWindowStart,
        selectedWindowEnd: seeded.selectedWindowEnd,
        selectedAcceptingOrders: seeded.selectedAcceptingOrders,
        selectedEnableOrderBook: seeded.selectedEnableOrderBook,
        selectedMarket: seeded.selectedMarket ? { ...seeded.selectedMarket } : null,
        windowRejectCounters: createWindowRejectCounters(),
        effectiveMinWindowSec: this.primaryMinWindowSec,
        effectiveMaxWindowSec: this.primaryMaxWindowSec,
        attempts: [],
        fallbackUsed: null
      };
      this.lastDiagnostics = diagnostics;
      if (options?.debug) {
        this.logger.info(
          {
            counters: diagnostics.counters,
            candidates: diagnostics.candidates.slice(0, 20)
          },
          "Polymarket seed scan diagnostics"
        );
      }
      return this.getLastDiagnostics();
    }

    const query = this.config.polymarket.marketQuery;
    const primaryMinWindowSec = this.primaryMinWindowSec;
    const primaryMaxWindowSec = this.primaryMaxWindowSec;
    const searchQueries = normalizeSearchQueries(query.search);
    const attempts: MarketScanAttempt[] = [];
    let selectedAttempt: MarketScanAttempt | null = null;
    let selectedPass: DiscoveryPassResult | null = null;
    let fallbackUsed: MarketScanAttempt["fallback"] | null = null;

    for (const search of searchQueries) {
      const pass = await this.runDiscoveryPass({
        nowTs,
        mode: "primary",
        search,
        patternMode: "ALL",
        enforceTauWindow: true,
        minWindowSec: primaryMinWindowSec,
        maxWindowSec: primaryMaxWindowSec,
        candidateLimit: query.maxMarkets,
        stopTarget: query.scanTargetCandidates,
        requireTradable: true,
        requireDefinedWindow: false,
        allowMissingPriceToBeat: false,
        sortByPriority: false,
        scoreMode: "market"
      });
      const attempt: MarketScanAttempt = {
        mode: "primary",
        fallback: "none",
        searchQuery: search,
        minWindowSec: primaryMinWindowSec,
        maxWindowSec: primaryMaxWindowSec,
        fetchedCount: pass.counters.fetchedCount,
        afterActiveCount: pass.counters.afterActiveCount,
        afterSearchCount: pass.counters.afterSearchCount,
        afterWindowCount: pass.counters.afterWindowCount,
        afterPatternCount: pass.counters.afterPatternCount,
        finalCandidatesCount: pass.counters.finalCandidatesCount
      };
      attempts.push(attempt);
      if (pass.counters.finalCandidatesCount > 0) {
        selectedPass = pass;
        selectedAttempt = attempt;
        break;
      }
    }

    if (!selectedPass) {
      const fallbackMinWindowSec = 60;
      const fallbackMaxWindowSec = 1800;
      const windowFallback = await this.runDiscoveryPass({
        nowTs,
        mode: "fallback",
        search: undefined,
        patternMode: "ALL",
        enforceTauWindow: true,
        minWindowSec: fallbackMinWindowSec,
        maxWindowSec: fallbackMaxWindowSec,
        candidateLimit: query.maxMarkets,
        stopTarget: query.scanTargetCandidates,
        requireTradable: true,
        requireDefinedWindow: false,
        allowMissingPriceToBeat: false,
        sortByPriority: false,
        scoreMode: "market"
      });
      attempts.push({
        mode: "fallback",
        fallback: "window",
        searchQuery: null,
        minWindowSec: fallbackMinWindowSec,
        maxWindowSec: fallbackMaxWindowSec,
        fetchedCount: windowFallback.counters.fetchedCount,
        afterActiveCount: windowFallback.counters.afterActiveCount,
        afterSearchCount: windowFallback.counters.afterSearchCount,
        afterWindowCount: windowFallback.counters.afterWindowCount,
        afterPatternCount: windowFallback.counters.afterPatternCount,
        finalCandidatesCount: windowFallback.counters.finalCandidatesCount
      });
      if (windowFallback.counters.finalCandidatesCount > 0) {
        selectedPass = windowFallback;
        selectedAttempt = attempts[attempts.length - 1];
        fallbackUsed = "window";
      }

      if (!selectedPass) {
        const btcOnlyFallback = await this.runDiscoveryPass({
          nowTs,
          mode: "fallback",
          search: undefined,
          patternMode: "BTC_ONLY",
          enforceTauWindow: true,
          minWindowSec: fallbackMinWindowSec,
          maxWindowSec: fallbackMaxWindowSec,
          candidateLimit: query.maxMarkets,
          stopTarget: query.scanTargetCandidates,
          requireTradable: true,
          requireDefinedWindow: false,
          allowMissingPriceToBeat: false,
          sortByPriority: false,
          scoreMode: "market"
        });
        attempts.push({
          mode: "fallback",
          fallback: "patterns",
          searchQuery: null,
          minWindowSec: fallbackMinWindowSec,
          maxWindowSec: fallbackMaxWindowSec,
          fetchedCount: btcOnlyFallback.counters.fetchedCount,
          afterActiveCount: btcOnlyFallback.counters.afterActiveCount,
          afterSearchCount: btcOnlyFallback.counters.afterSearchCount,
          afterWindowCount: btcOnlyFallback.counters.afterWindowCount,
          afterPatternCount: btcOnlyFallback.counters.afterPatternCount,
          finalCandidatesCount: btcOnlyFallback.counters.finalCandidatesCount
        });
        if (btcOnlyFallback.counters.finalCandidatesCount > 0) {
          selectedPass = btcOnlyFallback;
          selectedAttempt = attempts[attempts.length - 1];
          fallbackUsed = "patterns";
        }
      }

      if (!selectedPass) {
        const topActiveFallback = await this.runDiscoveryPass({
          nowTs,
          mode: "fallback",
          search: undefined,
          patternMode: "NONE",
          enforceTauWindow: true,
          minWindowSec: fallbackMinWindowSec,
          maxWindowSec: fallbackMaxWindowSec,
          candidateLimit: 50,
          stopTarget: 50,
          requireTradable: false,
          requireDefinedWindow: false,
          allowMissingPriceToBeat: true,
          sortByPriority: true,
          scoreMode: "relevance"
        });
        attempts.push({
          mode: "fallback",
          fallback: "topActive",
          searchQuery: null,
          minWindowSec: fallbackMinWindowSec,
          maxWindowSec: fallbackMaxWindowSec,
          fetchedCount: topActiveFallback.counters.fetchedCount,
          afterActiveCount: topActiveFallback.counters.afterActiveCount,
          afterSearchCount: topActiveFallback.counters.afterSearchCount,
          afterWindowCount: topActiveFallback.counters.afterWindowCount,
          afterPatternCount: topActiveFallback.counters.afterPatternCount,
          finalCandidatesCount: topActiveFallback.counters.finalCandidatesCount
        });
        selectedPass = topActiveFallback;
        selectedAttempt = attempts[attempts.length - 1];
        fallbackUsed = "topActive";
      }
    }
    if (!selectedAttempt) {
      selectedAttempt = attempts[attempts.length - 1] || null;
    }

    const diagnostics: MarketScanDiagnostics = {
      ts: new Date(nowTs).toISOString(),
      counters: selectedPass.counters,
      candidates: selectedPass.candidates.slice(0, MAX_CANDIDATE_PREVIEW),
      rejectedNotTradable: selectedPass.rejectedNotTradable.slice(0, MAX_REJECTION_PREVIEW),
      rejectedWindow: selectedPass.rejectedWindow.slice(0, MAX_CANDIDATE_PREVIEW),
      windowSamples: selectedPass.windowSamples.slice(0, MAX_CANDIDATE_PREVIEW),
      activeMarkets: selectedPass.activeMarkets,
      selectedSlug: selectedPass.activeMarkets[0]?.eventSlug ?? null,
      selectedWindowStart: selectedPass.activeMarkets[0]?.startTs ?? null,
      selectedWindowEnd: selectedPass.activeMarkets[0]?.endTs ?? null,
      selectedAcceptingOrders: selectedPass.activeMarkets[0]?.acceptingOrders ?? null,
      selectedEnableOrderBook: selectedPass.activeMarkets[0]?.enableOrderBook ?? null,
      selectedMarket: selectedPass.activeMarkets[0] ? { ...selectedPass.activeMarkets[0] } : null,
      windowRejectCounters: { ...selectedPass.windowRejectCounters },
      effectiveMinWindowSec: selectedAttempt?.minWindowSec ?? primaryMinWindowSec,
      effectiveMaxWindowSec: selectedAttempt?.maxWindowSec ?? primaryMaxWindowSec,
      attempts,
      fallbackUsed
    };
    this.lastDiagnostics = diagnostics;
    if (options?.debug) {
      this.logger.info(
        {
          searchQueries,
          fallbackUsed,
          counters: diagnostics.counters,
          attempts: diagnostics.attempts,
          candidates: diagnostics.candidates.slice(0, 20),
          rejected: diagnostics.rejectedNotTradable.slice(0, 5)
        },
        "Polymarket scan diagnostics"
      );
    }

    return this.getLastDiagnostics();
  }

  private async runDiscoveryPass(options: DiscoveryPassOptions): Promise<DiscoveryPassResult> {
    const counters: MarketScanCounters = {
      fetchedCount: 0,
      afterActiveCount: 0,
      fetchedTotal: 0,
      afterSearchCount: 0,
      afterWindowCount: 0,
      afterPatternCount: 0,
      finalCandidatesCount: 0,
      pagesScanned: 0,
      recentEventsCount: 0,
      prefixMatchesCount: 0,
      tradableTotal: 0,
      btcTotal: 0,
      cadenceTotal: 0,
      directionTotal: 0,
      btc5mCandidates: 0,
      activeWindows: 0
    };
    const rejectedNotTradable: MarketScanRejection[] = [];
    const rejectedWindow: MarketScanWindowRejection[] = [];
    const windowSamples: MarketScanWindowSample[] = [];
    const windowRejectCounters = createWindowRejectCounters();
    const patternMarkets: RankedMarket[] = [];
    const windowMarkets: RankedMarket[] = [];
    const candidatePreviewByMarketId = new Map<string, MarketScanCandidatePreview>();
    const seenRows = new Set<string>();

    const processRows = (rows: RawPolymarketMarket[]): void => {
      for (const row of rows) {
        const nowMs = Date.now();
        const uniqueKey = scanUniqueKey(row);
        if (seenRows.has(uniqueKey)) continue;
        seenRows.add(uniqueKey);

        counters.fetchedCount += 1;
        counters.fetchedTotal = counters.fetchedCount;
        const marketId =
          pickString(row, ["id", "market_id", "conditionId", "condition_id"]) || `unknown:${counters.fetchedCount}`;
        const slug = pickString(row, ["slug", "market_slug"]);
        const question =
          pickString(row, ["question", "title", "description"]) ||
          pickString(row, ["description", "subtitle"]) ||
          slug ||
          marketId;
        const text = marketText(row, slug, question);

        const active = pickBoolean(row, ["active", "is_active"], true);
        const closed = pickBoolean(row, ["closed", "is_closed", "resolved"], false);
        const acceptingOrders = pickBoolean(row, ["accepting_orders", "acceptingOrders", "tradable"], true);
        const enableOrderBook = pickBoolean(row, ["enable_order_book", "enableOrderBook"], true);
        const isActiveOpen = active && !closed;
        if (!isActiveOpen) continue;
        counters.afterActiveCount += 1;
        const isTradable = isActiveOpen && acceptingOrders && enableOrderBook;
        if (isTradable) {
          counters.tradableTotal += 1;
        }

        const endTsCandidate = pickTimestampCandidate(row, WINDOW_END_FIELDS);
        const startTsCandidate = pickTimestampCandidate(row, WINDOW_START_FIELDS);
        const endTsRaw = endTsCandidate.raw;
        const startTsRaw = startTsCandidate.raw;
        const endTs = endTsCandidate.ms;
        const startTs = startTsCandidate.ms;
        if (looksLikeEpochSeconds(endTsRaw)) {
          windowRejectCounters.unitSecondsDetected += 1;
        }
        const slugOrQuestion = slug || question || marketId;
        const remainingSecForSample = Number.isFinite(endTs) ? Math.floor((endTs - nowMs) / 1000) : -1;
        const windowEndRaw = stringifyTimestampRaw(endTsRaw);
        const windowStartRaw = stringifyTimestampRaw(startTsRaw);
        if (!Number.isFinite(endTs) || endTs <= nowMs) {
          if (!Number.isFinite(endTs) || endTs <= 0) {
            windowRejectCounters.invalidEndTs += 1;
          } else {
            windowRejectCounters.tooLate += 1;
          }
          if (windowSamples.length < MAX_CANDIDATE_PREVIEW) {
            windowSamples.push({
              marketId,
              slug: slugOrQuestion,
              windowStartField: startTsCandidate.field,
              windowStartParseNote: startTsCandidate.parseNote,
              windowStartRaw,
              windowStartTsMs: Number.isFinite(startTs) ? startTs : 0,
              windowEndField: endTsCandidate.field,
              windowEndParseNote: endTsCandidate.parseNote,
              windowEndRaw,
              windowEndTsMs: Number.isFinite(endTs) ? endTs : 0,
              nowTsMs: nowMs,
              remainingSec: remainingSecForSample,
              passWindow: false,
              rejectReason: !Number.isFinite(endTs) || endTs <= 0 ? "invalid_end_ts" : "too_late"
            });
          }
          if (rejectedWindow.length < MAX_CANDIDATE_PREVIEW) {
            rejectedWindow.push({
              marketId,
              slug: slugOrQuestion,
              windowStartField: startTsCandidate.field,
              windowStartParseNote: startTsCandidate.parseNote,
              windowStartRaw,
              windowStartTsMs: Number.isFinite(startTs) ? startTs : 0,
              windowEndField: endTsCandidate.field,
              windowEndParseNote: endTsCandidate.parseNote,
              windowEndRaw,
              windowEndTsMs: Number.isFinite(endTs) ? endTs : 0,
              nowTsMs: nowMs,
              remainingSec: Number.isFinite(endTs) ? Math.floor((endTs - nowMs) / 1000) : -1,
              rejectReason: !Number.isFinite(endTs) || endTs <= 0 ? "invalid_end_ts" : "too_late"
            });
          }
          continue;
        }
        const remainingSecRaw = Math.floor((endTs - nowMs) / 1000);
        if (!Number.isFinite(remainingSecRaw)) {
          windowRejectCounters.invalidRemaining += 1;
          if (windowSamples.length < MAX_CANDIDATE_PREVIEW) {
            windowSamples.push({
              marketId,
              slug: slugOrQuestion,
              windowStartField: startTsCandidate.field,
              windowStartParseNote: startTsCandidate.parseNote,
              windowStartRaw,
              windowStartTsMs: Number.isFinite(startTs) ? startTs : 0,
              windowEndField: endTsCandidate.field,
              windowEndParseNote: endTsCandidate.parseNote,
              windowEndRaw,
              windowEndTsMs: endTs,
              nowTsMs: nowMs,
              remainingSec: -1,
              passWindow: false,
              rejectReason: "invalid_remaining"
            });
          }
          if (rejectedWindow.length < MAX_CANDIDATE_PREVIEW) {
            rejectedWindow.push({
              marketId,
              slug: slugOrQuestion,
              windowStartField: startTsCandidate.field,
              windowStartParseNote: startTsCandidate.parseNote,
              windowStartRaw,
              windowStartTsMs: Number.isFinite(startTs) ? startTs : 0,
              windowEndField: endTsCandidate.field,
              windowEndParseNote: endTsCandidate.parseNote,
              windowEndRaw,
              windowEndTsMs: endTs,
              nowTsMs: nowMs,
              remainingSec: -1,
              rejectReason: "invalid_remaining"
            });
          }
          continue;
        }
        if (remainingSecRaw <= 0) {
          windowRejectCounters.tooLate += 1;
          if (windowSamples.length < MAX_CANDIDATE_PREVIEW) {
            windowSamples.push({
              marketId,
              slug: slugOrQuestion,
              windowStartField: startTsCandidate.field,
              windowStartParseNote: startTsCandidate.parseNote,
              windowStartRaw,
              windowStartTsMs: Number.isFinite(startTs) ? startTs : 0,
              windowEndField: endTsCandidate.field,
              windowEndParseNote: endTsCandidate.parseNote,
              windowEndRaw,
              windowEndTsMs: endTs,
              nowTsMs: nowMs,
              remainingSec: remainingSecRaw,
              passWindow: false,
              rejectReason: "too_late"
            });
          }
          if (rejectedWindow.length < MAX_CANDIDATE_PREVIEW) {
            rejectedWindow.push({
              marketId,
              slug: slugOrQuestion,
              windowStartField: startTsCandidate.field,
              windowStartParseNote: startTsCandidate.parseNote,
              windowStartRaw,
              windowStartTsMs: Number.isFinite(startTs) ? startTs : 0,
              windowEndField: endTsCandidate.field,
              windowEndParseNote: endTsCandidate.parseNote,
              windowEndRaw,
              windowEndTsMs: endTs,
              nowTsMs: nowMs,
              remainingSec: remainingSecRaw,
              rejectReason: "too_late"
            });
          }
          continue;
        }
        const remainingSec = remainingSecRaw;
        if (remainingSec < options.minWindowSec || remainingSec > options.maxWindowSec) {
          const rejectReason = remainingSec < options.minWindowSec ? "too_late" : "too_soon";
          if (rejectReason === "too_late") {
            windowRejectCounters.tooLate += 1;
          } else {
            windowRejectCounters.tooSoon += 1;
          }
          if (windowSamples.length < MAX_CANDIDATE_PREVIEW) {
            windowSamples.push({
              marketId,
              slug: slugOrQuestion,
              windowStartField: startTsCandidate.field,
              windowStartParseNote: startTsCandidate.parseNote,
              windowStartRaw,
              windowStartTsMs: Number.isFinite(startTs) ? startTs : 0,
              windowEndField: endTsCandidate.field,
              windowEndParseNote: endTsCandidate.parseNote,
              windowEndRaw,
              windowEndTsMs: endTs,
              nowTsMs: nowMs,
              remainingSec,
              passWindow: false,
              rejectReason
            });
          }
          if (rejectedWindow.length < MAX_CANDIDATE_PREVIEW) {
            rejectedWindow.push({
              marketId,
              slug: slugOrQuestion,
              windowStartField: startTsCandidate.field,
              windowStartParseNote: startTsCandidate.parseNote,
              windowStartRaw,
              windowStartTsMs: Number.isFinite(startTs) ? startTs : 0,
              windowEndField: endTsCandidate.field,
              windowEndParseNote: endTsCandidate.parseNote,
              windowEndRaw,
              windowEndTsMs: endTs,
              nowTsMs: nowMs,
              remainingSec,
              rejectReason
            });
          }
          continue;
        }
        const hasStart = Number.isFinite(startTs) && startTs > 0;
        if (options.requireDefinedWindow && !hasStart) {
          windowRejectCounters.invalidRemaining += 1;
          if (windowSamples.length < MAX_CANDIDATE_PREVIEW) {
            windowSamples.push({
              marketId,
              slug: slugOrQuestion,
              windowStartField: startTsCandidate.field,
              windowStartParseNote: startTsCandidate.parseNote,
              windowStartRaw,
              windowStartTsMs: Number.isFinite(startTs) ? startTs : 0,
              windowEndField: endTsCandidate.field,
              windowEndParseNote: endTsCandidate.parseNote,
              windowEndRaw,
              windowEndTsMs: endTs,
              nowTsMs: nowMs,
              remainingSec,
              passWindow: false,
              rejectReason: "invalid_remaining"
            });
          }
          if (rejectedWindow.length < MAX_CANDIDATE_PREVIEW) {
            rejectedWindow.push({
              marketId,
              slug: slugOrQuestion,
              windowStartField: startTsCandidate.field,
              windowStartParseNote: startTsCandidate.parseNote,
              windowStartRaw,
              windowStartTsMs: Number.isFinite(startTs) ? startTs : 0,
              windowEndField: endTsCandidate.field,
              windowEndParseNote: endTsCandidate.parseNote,
              windowEndRaw,
              windowEndTsMs: endTs,
              nowTsMs: nowMs,
              remainingSec,
              rejectReason: "invalid_remaining"
            });
          }
          continue;
        }
        if (windowSamples.length < MAX_CANDIDATE_PREVIEW) {
          windowSamples.push({
            marketId,
            slug: slugOrQuestion,
            windowStartField: startTsCandidate.field,
            windowStartParseNote: startTsCandidate.parseNote,
            windowStartRaw,
            windowStartTsMs: Number.isFinite(startTs) ? startTs : 0,
            windowEndField: endTsCandidate.field,
            windowEndParseNote: endTsCandidate.parseNote,
            windowEndRaw,
            windowEndTsMs: endTs,
            nowTsMs: nowMs,
            remainingSec,
            passWindow: true
          });
        }
        counters.afterWindowCount += 1;
        if (options.search && options.search.trim().length > 0) {
          if (!matchesSearch(text, options.search)) {
            continue;
          }
        }
        counters.afterSearchCount += 1;
        const btcMatch = this.btcPattern.test(text);
        const cadenceMatch = this.cadencePattern.test(text);
        const directionMatch = this.directionPattern.test(text);
        if (btcMatch) counters.btcTotal += 1;
        if (cadenceMatch) counters.cadenceTotal += 1;
        if (directionMatch) counters.directionTotal += 1;
        const patternMatch =
          options.patternMode === "ALL"
            ? btcMatch && cadenceMatch && directionMatch
            : options.patternMode === "BTC_ONLY"
              ? btcMatch
              : true;
        if (patternMatch) {
          counters.afterPatternCount += 1;
        }
        if (!patternMatch) continue;

        const parsed = this.parseCandidateToActiveMarket(
          row,
          options.nowTs,
          {
            marketId,
            slug,
            question,
            acceptingOrders,
            enableOrderBook,
            closed,
            active
          },
          {
            minWindowSec: options.minWindowSec,
            maxWindowSec: options.maxWindowSec,
            requireDefinedWindow: options.requireDefinedWindow,
            allowMissingPriceToBeat: options.allowMissingPriceToBeat
          }
        );
        if (!parsed) continue;

        if (options.requireTradable && !isTradable) {
          const rejectionReasons: string[] = [];
          if (closed) rejectionReasons.push("closed");
          if (!acceptingOrders) rejectionReasons.push("not accepting_orders");
          if (!enableOrderBook) rejectionReasons.push("enable_order_book false");
          if (!active) rejectionReasons.push("not active");
          if (rejectionReasons.length > 0 && rejectedNotTradable.length < MAX_REJECTION_PREVIEW) {
            rejectedNotTradable.push({
              marketId,
              question,
              reasons: rejectionReasons,
              acceptingOrders,
              enableOrderBook,
              closed,
              active
            });
          }
          continue;
        }

        const preview: MarketScanCandidatePreview = {
          marketId,
          question,
          acceptingOrders,
          enableOrderBook,
          closed,
          active
        };
        if (!candidatePreviewByMarketId.has(marketId)) {
          candidatePreviewByMarketId.set(marketId, preview);
        }

        const ranked: RankedMarket = {
          market: parsed,
          score:
            options.scoreMode === "relevance"
              ? marketRelevanceScore(text)
              : marketPriorityScore(row, parsed.endTs),
          preview
        };
        windowMarkets.push(ranked);
        if (patternMatch) {
          patternMarkets.push(ranked);
        }
      }
    };

    const discoveredRows = await this.fetchMarketsForDiscovery({
      maxRows: 200,
      search: options.search,
      nowTs: options.nowTs,
      maxRemainingSec: options.maxWindowSec
    });
    processRows(discoveredRows.rows);
    counters.pagesScanned = Math.max(counters.pagesScanned, discoveredRows.pages);
    counters.recentEventsCount = Math.max(counters.recentEventsCount, discoveredRows.events);

    const selectedPool = options.patternMode === "ALL" ? patternMarkets : windowMarkets;

    const activeMarkets = this.selectRankedMarkets(selectedPool, options.candidateLimit, options.sortByPriority);
    const candidates = activeMarkets.slice(0, MAX_CANDIDATE_PREVIEW).map((market) => {
      const preview = candidatePreviewByMarketId.get(market.marketId);
      if (preview) return preview;
      return {
        marketId: market.marketId,
        question: market.question,
        acceptingOrders: market.acceptingOrders,
        enableOrderBook: market.enableOrderBook !== false,
        closed: Boolean(market.closed),
        active: market.active !== false
      };
    });

    counters.activeWindows = activeMarkets.length;
    counters.finalCandidatesCount = activeMarkets.length;
    counters.btc5mCandidates = counters.afterPatternCount;
    return {
      counters,
      candidates,
      rejectedNotTradable,
      rejectedWindow,
      windowSamples,
      windowRejectCounters,
      activeMarkets
    };
  }

  private async fetchMarketsForDiscovery(input: {
    maxRows: number;
    search?: string;
    nowTs: number;
    maxRemainingSec: number;
  }): Promise<{ rows: RawPolymarketMarket[]; pages: number; events: number }> {
    const rowsFromMarkets = await this.fetchMarketsFromMarketsEndpoint(input);
    if (rowsFromMarkets.rows.length >= input.maxRows) {
      return {
        rows: rowsFromMarkets.rows.slice(0, input.maxRows),
        pages: rowsFromMarkets.pages,
        events: 0
      };
    }
    const eventSupplement = await this.fetchMarketsFromActiveEvents({
      maxRows: input.maxRows - rowsFromMarkets.rows.length,
      search: input.search,
      nowTs: input.nowTs,
      maxRemainingSec: input.maxRemainingSec
    });
    return {
      rows: [...rowsFromMarkets.rows, ...eventSupplement.rows].slice(0, input.maxRows),
      pages: rowsFromMarkets.pages + eventSupplement.pages,
      events: eventSupplement.events
    };
  }

  private async fetchMarketsFromMarketsEndpoint(input: {
    maxRows: number;
    search?: string;
  }): Promise<{ rows: RawPolymarketMarket[]; pages: number }> {
    const out: RawPolymarketMarket[] = [];
    const seen = new Set<string>();
    const maxRows = Math.max(1, Math.floor(input.maxRows));
    const pageLimit = 200;
    const maxPages = Math.max(1, Math.min(8, Math.ceil(maxRows / pageLimit) + 1));
    let cursor: string | undefined;
    let pages = 0;

    while (out.length < maxRows && pages < maxPages) {
      const page = await this.client.listMarketsPage({
        limit: Math.min(pageLimit, maxRows - out.length),
        search: input.search,
        active: true,
        closed: false,
        archived: false,
        cursor
      });
      pages += 1;
      for (const market of page.rows) {
        const key = scanUniqueKey(market);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(market);
        if (out.length >= maxRows) break;
      }
      if (!page.nextCursor || page.rows.length === 0) break;
      cursor = page.nextCursor;
    }

    return { rows: out, pages };
  }

  private async fetchMarketsFromActiveEvents(input: {
    maxRows: number;
    search?: string;
    nowTs: number;
    maxRemainingSec: number;
  }): Promise<{ rows: RawPolymarketMarket[]; pages: number; events: number }> {
    const out: RawPolymarketMarket[] = [];
    const seen = new Set<string>();
    const maxRows = Math.max(1, Math.floor(input.maxRows));
    const maxPages = Math.max(1, Math.min(6, Math.ceil(maxRows / 30)));
    let cursor: string | undefined;
    let pages = 0;
    let events = 0;
    while (out.length < maxRows && pages < maxPages) {
      const page = await this.client.listEventsPage({
        limit: 100,
        active: true,
        closed: false,
        cursor
      });
      pages += 1;
      events += page.rows.length;
      for (const event of page.rows) {
        const markets = this.eventToCandidateMarkets(event, input.search);
        for (const market of markets) {
          const endTs = pickTimestampCandidate(market, WINDOW_END_FIELDS).ms;
          const remainingSec = Number.isFinite(endTs) ? Math.floor((endTs - input.nowTs) / 1000) : Number.NaN;
          if (
            !Number.isFinite(remainingSec) ||
            remainingSec > input.maxRemainingSec * 10 ||
            remainingSec < -60
          ) {
            continue;
          }
          const key = scanUniqueKey(market);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(market);
          if (out.length >= maxRows) break;
        }
        if (out.length >= maxRows) break;
      }
      if (!page.nextCursor || page.rows.length === 0) break;
      cursor = page.nextCursor;
    }
    return { rows: out, pages, events };
  }

  private eventToCandidateMarkets(event: RawPolymarketEvent, search?: string): RawPolymarketMarket[] {
    const eventObj = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
    const eventSlug = pickString(eventObj, ["slug", "event_slug"]);
    const eventTitle = pickString(eventObj, ["title", "name", "question", "description"]);
    const tags = parseStringArray(eventObj.tags);
    const topic = pickString(eventObj, ["category", "topic"]);
    const eventText = `${eventSlug} ${eventTitle} ${topic} ${tags.join(" ")}`.toLowerCase();
    const cryptoRelated =
      /(?:\bbtc\b|bitcoin|updown|\b5m\b|\bcrypto\b)/i.test(eventText) ||
      tags.some((tag) => /crypto|bitcoin|btc/i.test(tag));
    if (!cryptoRelated) return [];

    const marketsRaw = Array.isArray(eventObj.markets) ? eventObj.markets : [];
    const out: RawPolymarketMarket[] = [];
    for (const row of marketsRaw) {
      if (!row || typeof row !== "object") continue;
      const market = row as Record<string, unknown>;
      const merged: RawPolymarketMarket = {
        ...eventObj,
        ...market,
        slug: pickString(market, ["slug", "market_slug"]) || eventSlug,
        question:
          pickString(market, ["question", "title", "description"]) ||
          eventTitle ||
          eventSlug,
        endDate:
          market.endDate ??
          market.end_date ??
          market.endTime ??
          eventObj.endDate ??
          eventObj.end_date ??
          eventObj.endTime,
        startDate:
          market.startDate ??
          market.start_date ??
          market.startTime ??
          eventObj.startDate ??
          eventObj.start_date ??
          eventObj.startTime,
        eventSlug: eventSlug || pickString(market, ["eventSlug", "event_slug"]),
        tags
      };
      const text = marketText(
        merged,
        pickString(merged, ["slug", "market_slug"]),
        pickString(merged, ["question", "title", "description"])
      );
      if (search && search.trim().length > 0 && !matchesSearch(text, search)) {
        continue;
      }
      out.push(merged);
    }
    return out;
  }

  private selectRankedMarkets(
    rows: RankedMarket[],
    limit: number,
    sortByPriority: boolean
  ): BtcWindowMarket[] {
    const sorted = [...rows].sort((a, b) =>
      sortByPriority ? b.score - a.score || b.market.endTs - a.market.endTs : a.market.endTs - b.market.endTs
    );
    const bounded = Math.max(1, Math.floor(limit));
    const out: BtcWindowMarket[] = [];
    const seen = new Set<string>();
    for (const row of sorted) {
      if (seen.has(row.market.marketId)) continue;
      seen.add(row.market.marketId);
      out.push(row.market);
      if (out.length >= bounded) break;
    }
    return out;
  }

  private parseCandidateToActiveMarket(
    row: RawPolymarketMarket,
    nowTs: number,
    input: {
      marketId: string;
      slug: string;
      question: string;
      acceptingOrders: boolean;
      enableOrderBook: boolean;
      closed: boolean;
      active: boolean;
    },
    options?: {
      minWindowSec?: number;
      maxWindowSec?: number;
      requireDefinedWindow?: boolean;
      allowMissingPriceToBeat?: boolean;
    }
  ): BtcWindowMarket | null {
    const endTs = pickTimestamp(row, WINDOW_END_FIELDS);
    if (!Number.isFinite(endTs) || endTs <= nowTs) return null;

    const startTs = pickTimestamp(row, WINDOW_START_FIELDS);
    const requireDefinedWindow = Boolean(options?.requireDefinedWindow);
    if (requireDefinedWindow && !(Number.isFinite(startTs) && startTs > 0)) {
      return null;
    }
    if (!Number.isFinite(startTs) && requireDefinedWindow) {
      return null;
    }

    const priceToBeat =
      pickNumber(row, ["price_to_beat", "priceToBeat", "target_price", "strike", "threshold"]) ||
      parsePriceToBeat(input.question);
    if (!(priceToBeat > 0) && !options?.allowMissingPriceToBeat) return null;

    const tokens = parseTokens(row);
    const yesToken = tokens.find((t) => t.outcome === "yes");
    if (!yesToken?.tokenId) return null;

    const noToken = tokens.find((t) => t.outcome === "no");
    const tickSize = parseTickSize(
      pickString(row, ["minimum_tick_size", "minimumTickSize", "tick_size", "tickSize"])
    );
    const negRisk = pickBoolean(row, ["neg_risk", "negRisk"], false);

    return {
      marketId: input.marketId,
      slug: input.slug,
      question: input.question,
      priceToBeat: priceToBeat > 0 ? priceToBeat : 0,
      endTs,
      startTs: Number.isFinite(startTs) && startTs > 0 ? startTs : undefined,
      yesTokenId: yesToken.tokenId,
      noTokenId: noToken?.tokenId,
      tickSize: tickSize ?? undefined,
      negRisk,
      acceptingOrders: input.acceptingOrders,
      enableOrderBook: input.enableOrderBook,
      closed: input.closed,
      active: input.active
    };
  }
}

function parseTokens(row: RawPolymarketMarket): Array<{ outcome: "yes" | "no" | "other"; tokenId: string }> {
  const raw = row.tokens;
  const outcomeNames = parseOutcomeNames(row);
  const clobTokenIds = parseStringArray((row as Record<string, unknown>).clobTokenIds);
  if (clobTokenIds.length >= 2) {
    const mapped: Array<{ outcome: "yes" | "no" | "other"; tokenId: string }> = [
      { outcome: "yes", tokenId: clobTokenIds[0] },
      { outcome: "no", tokenId: clobTokenIds[1] }
    ];
    for (let idx = 2; idx < clobTokenIds.length; idx += 1) {
      mapped.push({ outcome: "other", tokenId: clobTokenIds[idx] });
    }
    return mapped;
  }
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string" || typeof item === "number")) {
    return raw
      .map((item, idx) => {
        const tokenId = String(item || "").trim();
        if (!tokenId) return null;
        const outcomeRaw = String(outcomeNames[idx] || "").trim().toLowerCase();
        const outcome: "yes" | "no" | "other" =
          outcomeRaw === "yes" || outcomeRaw.includes("up") || outcomeRaw.includes("higher") || outcomeRaw.includes("above")
            ? "yes"
            : outcomeRaw === "no" || outcomeRaw.includes("down") || outcomeRaw.includes("lower") || outcomeRaw.includes("below")
              ? "no"
              : "other";
        return { outcome, tokenId };
      })
      .filter((row): row is { outcome: "yes" | "no" | "other"; tokenId: string } => row !== null);
  }
  if (!Array.isArray(raw)) {
    if (clobTokenIds.length > 0) {
      return clobTokenIds.map((tokenId, idx) => {
        const outcomeRaw = String(outcomeNames[idx] || "").trim().toLowerCase();
        const outcome: "yes" | "no" | "other" =
          outcomeRaw === "yes" || outcomeRaw.includes("up") || outcomeRaw.includes("higher") || outcomeRaw.includes("above")
            ? "yes"
            : outcomeRaw === "no" || outcomeRaw.includes("down") || outcomeRaw.includes("lower") || outcomeRaw.includes("below")
              ? "no"
              : "other";
        return { outcome, tokenId };
      });
    }
    return [];
  }
  const out: Array<{ outcome: "yes" | "no" | "other"; tokenId: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const tokenId = pickString(obj, ["token_id", "tokenId", "id", "clob_token_id"]);
    if (!tokenId) continue;
    const outcomeRaw = pickString(obj, ["outcome", "name", "label"]).toLowerCase();
    const outcome: "yes" | "no" | "other" =
      outcomeRaw === "yes" ? "yes" : outcomeRaw === "no" ? "no" : "other";
    out.push({ outcome, tokenId });
  }
  return out;
}

function parseOutcomeNames(row: RawPolymarketMarket): string[] {
  const obj = row as Record<string, unknown>;
  if (Array.isArray(obj.outcomes)) {
    return obj.outcomes.map((value) => String(value || "").trim()).filter((value) => value.length > 0);
  }
  if (typeof obj.outcomes === "string" && obj.outcomes.trim().length > 0) {
    try {
      const parsed = JSON.parse(obj.outcomes);
      if (Array.isArray(parsed)) {
        return parsed.map((value) => String(value || "").trim()).filter((value) => value.length > 0);
      }
    } catch {
      return [];
    }
  }
  return [];
}

function parsePriceToBeat(text: string): number {
  const normalized = text.replace(/,/g, "");
  const matches = normalized.matchAll(/\$?([0-9]+(?:\.[0-9]+)?)\s*(?:usd)?/gi);
  let best = 0;
  for (const match of matches) {
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    if (parsed > best) {
      best = parsed;
    }
  }
  return best >= 1_000 ? best : 0;
}

function safeCompileRegex(source: string, fallback: string, logger: Logger, envName: string): RegExp {
  try {
    return new RegExp(source, "i");
  } catch (error) {
    logger.warn(
      {
        envName,
        source,
        fallback,
        error: error instanceof Error ? error.message : String(error)
      },
      "Invalid Polymarket pattern regex, falling back"
    );
    return new RegExp(fallback, "i");
  }
}

function marketText(row: RawPolymarketMarket, slug: string, question: string): string {
  const description = pickString(row, ["description", "subtitle", "details"]);
  const eventSlug = pickString(row, ["eventSlug", "event_slug"]);
  const tags = parseStringArray((row as Record<string, unknown>).tags);
  return `${slug} ${eventSlug} ${question} ${description} ${tags.join(" ")}`.toLowerCase();
}

function matchesSearch(text: string, search: string): boolean {
  const normalized = String(search || "").trim().toLowerCase();
  if (!normalized) return true;
  const terms = normalized.split(/\s+/g).filter((row) => row.length > 0);
  if (terms.length === 0) return true;
  return terms.every((term) => text.includes(term));
}

function normalizeSearchQueries(values: string[] | string): string[] {
  const tokens = Array.isArray(values) ? values : String(values || "").split(",");
  const deduped = new Set<string>();
  for (const value of tokens) {
    const normalized = String(value || "").trim();
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

function marketPriorityScore(row: RawPolymarketMarket, endTs: number): number {
  const volume = pickNumber(row, [
    "volume",
    "volumeNum",
    "volume24h",
    "volume24hr",
    "oneDayVolume",
    "oneDayVolumeClob",
    "volumeClob"
  ]);
  const liquidity = pickNumber(row, [
    "liquidity",
    "liquidityNum",
    "liquidityClob",
    "liquidityAmm",
    "openInterest",
    "openInterestClob"
  ]);
  const recencyScore = Number.isFinite(endTs) && endTs > 0 ? endTs / 1_000_000_000_000 : 0;
  return volume * 100 + liquidity * 10 + recencyScore;
}

function marketRelevanceScore(text: string): number {
  let score = 0;
  if (/(?:\bbtc\b|bitcoin|\$btc)/i.test(text)) score += 3;
  if (/(?:\b5m\b|\b5\s*min\b|\b5\s*minute\b|minute)/i.test(text)) score += 2;
  if (/(?:up|down|higher|lower|above|below)/i.test(text)) score += 1;
  return score;
}

function scanUniqueKey(row: RawPolymarketMarket): string {
  const id = pickString(row, ["id", "market_id", "conditionId", "condition_id"]);
  if (id) return id;
  const slug = pickString(row, ["slug", "market_slug"]);
  if (slug) return `slug:${slug.toLowerCase()}`;
  const question = pickString(row, ["question", "title", "description"]);
  if (question) return `q:${question.toLowerCase()}`;
  return `fallback:${JSON.stringify(row).slice(0, 120)}`;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const parsed = Number(obj[key]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function pickBoolean(obj: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
      if (normalized === "false" || normalized === "0" || normalized === "no") return false;
    }
  }
  return fallback;
}

function pickTimestamp(obj: Record<string, unknown>, keys: string[]): number {
  return pickTimestampCandidate(obj, keys).ms;
}

function pickTimestampCandidate(
  obj: Record<string, unknown>,
  keys: string[]
): { field: string | null; raw: unknown; ms: number; parseNote: string | null } {
  let firstSeen: { field: string; raw: unknown; parseNote: string | null } | null = null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const raw = obj[key];
    const parsed = parseTsToMsWithMeta(raw);
    if (!firstSeen && raw !== undefined && raw !== null && String(raw).trim().length > 0) {
      firstSeen = { field: key, raw, parseNote: parsed.parseNote };
    }
    const normalized = parsed.ms;
    if (normalized !== null && normalized > 0) {
      return {
        field: key,
        raw,
        ms: normalized,
        parseNote: parsed.parseNote
      };
    }
  }
  if (firstSeen) {
    return {
      field: firstSeen.field,
      raw: firstSeen.raw,
      ms: 0,
      parseNote: firstSeen.parseNote
    };
  }
  return {
    field: null,
    raw: undefined,
    ms: 0,
    parseNote: null
  };
}

function pickFirstDefined(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      if (value !== undefined && value !== null && String(value).trim().length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

function stringifyTimestampRaw(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text.length > 0 ? text : "";
}

function toMs(ts: unknown): number {
  return parseTsToMs(ts) ?? 0;
}

function parseTsToMs(ts: unknown): number | null {
  return parseTsToMsWithMeta(ts).ms;
}

function parseTsToMsWithMeta(
  ts: unknown
): { ms: number | null; parseNote: string | null } {
  if (ts === null || ts === undefined) return { ms: null, parseNote: null };
  const normalizeNumeric = (raw: number): number | null => {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    if (raw < 1e12) return Math.floor(raw * 1000);
    if (raw < 1e15) return Math.floor(raw);
    if (raw < 1e18) return Math.floor(raw / 1000);
    return null;
  };
  if (typeof ts === "number") {
    const ms = normalizeNumeric(ts);
    if (ms === null) return { ms: null, parseNote: "invalid" };
    if (ts < 1e12) return { ms, parseNote: "seconds_to_ms" };
    if (ts < 1e15) return { ms, parseNote: "milliseconds" };
    return { ms, parseNote: "microseconds_to_ms" };
  }
  if (typeof ts === "string") {
    const trimmed = ts.trim();
    if (!trimmed) return { ms: null, parseNote: "invalid" };
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      const ms = normalizeNumeric(numeric);
      if (ms === null) return { ms: null, parseNote: "invalid" };
      if (numeric < 1e12) return { ms, parseNote: "seconds_to_ms" };
      if (numeric < 1e15) return { ms, parseNote: "milliseconds" };
      return { ms, parseNote: "microseconds_to_ms" };
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { ms: Math.floor(parsed), parseNote: "iso" };
    }
  }
  return { ms: null, parseNote: "invalid" };
}

function createWindowRejectCounters(): MarketScanWindowRejectCounters {
  return {
    tooSoon: 0,
    tooLate: 0,
    invalidEndTs: 0,
    invalidRemaining: 0,
    unitSecondsDetected: 0
  };
}

function parseWindowEnvInt(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveWindowBoundsFromEnv(
  defaultMinWindowSec: number,
  defaultMaxWindowSec: number
): { minWindowSec: number; maxWindowSec: number } {
  const minOverride = parseWindowEnvInt("POLY_MIN_WINDOW_SEC");
  const maxOverride = parseWindowEnvInt("POLY_MAX_WINDOW_SEC");
  const minWindowSec = minOverride ?? defaultMinWindowSec;
  const maxWindowSec = maxOverride ?? defaultMaxWindowSec;
  if (!(Number.isFinite(minWindowSec) && Number.isFinite(maxWindowSec))) {
    return { minWindowSec: defaultMinWindowSec, maxWindowSec: defaultMaxWindowSec };
  }
  if (minWindowSec <= 0 || maxWindowSec <= 0 || maxWindowSec < minWindowSec) {
    return { minWindowSec: defaultMinWindowSec, maxWindowSec: defaultMaxWindowSec };
  }
  return { minWindowSec, maxWindowSec };
}

function looksLikeEpochSeconds(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  const numeric =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 1e9 && numeric < 1e12;
}

function parseStringArray(value: unknown): string[] {
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
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => String(row || "").trim())
    .filter((row) => row.length > 0);
}

function parseTickSize(value: string): "0.1" | "0.01" | "0.001" | "0.0001" | null {
  const normalized = String(value || "").trim();
  if (normalized === "0.1") return "0.1";
  if (normalized === "0.01") return "0.01";
  if (normalized === "0.001") return "0.001";
  if (normalized === "0.0001") return "0.0001";
  return null;
}
