import { BotConfig } from "../../config";
import { Logger } from "../../logger";
import { PolymarketClient, RawPolymarketMarket } from "../PolymarketClient";
import {
  Btc5mSelectionResult,
  Btc5mSelectedMarket,
  Btc5mSide,
  Btc5mSideBook,
  Btc5mTick
} from "./Btc5mTypes";

type SelectInput = {
  tick: Btc5mTick;
};

export const BTC5M_SELECTOR_REASONS = {
  NO_CANDIDATE_MARKETS: "NO_CANDIDATE_MARKETS",
  NO_VIABLE_CANDIDATE_AFTER_FILTER: "NO_VIABLE_CANDIDATE_AFTER_FILTER",
  CANDIDATE_NOT_TRADABLE: "CANDIDATE_NOT_TRADABLE",
  TOKEN_ID_MISSING: "TOKEN_ID_MISSING",
  ORDERBOOK_MISSING_YES: "ORDERBOOK_MISSING_YES",
  ORDERBOOK_MISSING_NO: "ORDERBOOK_MISSING_NO",
  NETWORK_ERROR: "NETWORK_ERROR",
  OK: "OK"
} as const;

export type Btc5mSelectorReason = (typeof BTC5M_SELECTOR_REASONS)[keyof typeof BTC5M_SELECTOR_REASONS];

type CandidateSeed = {
  row: Record<string, unknown>;
  expectedSlug: string;
  source: "current_slug" | "next_slug" | "prev_slug";
  alignmentRank: number;
  tradabilityHintScore: number;
};

type CandidateOutcome =
  | {
      selected: Btc5mSelectedMarket;
      reason: "OK";
      filteredOut: null;
    }
  | {
      selected: null;
      reason: Exclude<Btc5mSelectorReason, "OK">;
      filteredOut: "EXTREME" | "WIDE_SPREAD" | "INVALID" | null;
    };

export class Btc5mSelector {
  private readonly unavailableTokenIdsBySlug = new Map<string, Set<string>>();
  private readonly unavailableMarketIdsBySlug = new Map<string, Set<string>>();
  private readonly recentDiscoveredRowsBySlug = new Map<string, { rows: Record<string, unknown>[]; cachedAtTs: number }>();
  private readonly recentMarketMetaById = new Map<
    string,
    {
      active: boolean;
      closed: boolean;
      archived: boolean;
      acceptingOrders: boolean;
      enableOrderBook: boolean;
      yesTokenId: string | null;
      noTokenId: string | null;
      cachedAtTs: number;
    }
  >();

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly client: PolymarketClient
  ) {}

  async select(input: SelectInput): Promise<Btc5mSelectionResult> {
    const tick = input.tick;
    const attemptedSlugs = [tick.currentSlug, tick.nextSlug, tick.prevSlug];
    this.pruneUnavailableSlugs(new Set(attemptedSlugs));

    const discovery = await this.discoverCandidates(tick, attemptedSlugs);
    let droppedExtreme = 0;
    let droppedWideSpread = 0;
    let droppedInvalid = 0;
    let candidatesAfterFilter = 0;
    const candidatesBeforeFilter = discovery.candidates.length;
    if (discovery.candidates.length === 0) {
      return {
        tick,
        attemptedSlugs,
        candidatesBeforeFilter,
        candidatesAfterFilter,
        droppedExtreme,
        droppedWideSpread,
        droppedInvalid,
        selected: null,
        reason: discovery.networkError
          ? BTC5M_SELECTOR_REASONS.NETWORK_ERROR
          : BTC5M_SELECTOR_REASONS.NO_CANDIDATE_MARKETS
      };
    }

    const ranked = discovery.candidates.sort((a, b) => {
      if (a.alignmentRank !== b.alignmentRank) return a.alignmentRank - b.alignmentRank;
      return b.tradabilityHintScore - a.tradabilityHintScore;
    });

    let firstFailureReason: Exclude<Btc5mSelectorReason, "OK"> | null = null;
    const filteredCandidates: Btc5mSelectedMarket[] = [];
    for (const seed of ranked) {
      const outcome = await this.evaluateCandidate(seed, tick);
      if (outcome.selected) {
        filteredCandidates.push(outcome.selected);
        candidatesAfterFilter += 1;
        break;
      } else if (outcome.filteredOut === "EXTREME") {
        droppedExtreme += 1;
      } else if (outcome.filteredOut === "WIDE_SPREAD") {
        droppedWideSpread += 1;
      } else if (outcome.filteredOut === "INVALID") {
        droppedInvalid += 1;
      }
      if (!outcome.selected && !firstFailureReason) {
        firstFailureReason = outcome.reason;
      }
    }

    if (filteredCandidates.length > 0) {
      return {
        tick,
        attemptedSlugs,
        candidatesBeforeFilter,
        candidatesAfterFilter,
        droppedExtreme,
        droppedWideSpread,
        droppedInvalid,
        selected: filteredCandidates[0],
        reason: BTC5M_SELECTOR_REASONS.OK
      };
    }

    const filterDroppedAll =
      candidatesBeforeFilter > 0 &&
      candidatesAfterFilter === 0 &&
      (droppedExtreme > 0 || droppedWideSpread > 0 || droppedInvalid > 0);

    return {
      tick,
      attemptedSlugs,
      candidatesBeforeFilter,
      candidatesAfterFilter,
      droppedExtreme,
      droppedWideSpread,
      droppedInvalid,
      selected: null,
      reason: filterDroppedAll
        ? BTC5M_SELECTOR_REASONS.NO_VIABLE_CANDIDATE_AFTER_FILTER
        : firstFailureReason ?? BTC5M_SELECTOR_REASONS.NO_CANDIDATE_MARKETS
    };
  }

  isSideBookUnavailable(slug: string, tokenId: string): boolean {
    const normalizedSlug = String(slug || "").trim();
    const normalizedTokenId = String(tokenId || "").trim();
    if (!normalizedSlug || !normalizedTokenId) return false;
    const tokenSet = this.unavailableTokenIdsBySlug.get(normalizedSlug);
    return Boolean(tokenSet?.has(normalizedTokenId));
  }

  isMarketUnavailable(slug: string, marketId: string): boolean {
    const normalizedSlug = String(slug || "").trim();
    const normalizedMarketId = String(marketId || "").trim();
    if (!normalizedSlug || !normalizedMarketId) return false;
    const marketSet = this.unavailableMarketIdsBySlug.get(normalizedSlug);
    return Boolean(marketSet?.has(normalizedMarketId));
  }

  markMarketUnavailable(slug: string, marketId: string, reason: string): void {
    const normalizedSlug = String(slug || "").trim();
    const normalizedMarketId = String(marketId || "").trim();
    if (!normalizedSlug || !normalizedMarketId) return;
    let marketSet = this.unavailableMarketIdsBySlug.get(normalizedSlug);
    if (!marketSet) {
      marketSet = new Set<string>();
      this.unavailableMarketIdsBySlug.set(normalizedSlug, marketSet);
    }
    if (marketSet.has(normalizedMarketId)) {
      return;
    }
    marketSet.add(normalizedMarketId);
    this.logger.warn({ slug: normalizedSlug, marketId: normalizedMarketId, reason }, "POLY_V2_MARKET_UNAVAILABLE");
  }

  markSideBookUnavailable(slug: string, tokenId: string, reason: string): void {
    const normalizedSlug = String(slug || "").trim();
    const normalizedTokenId = String(tokenId || "").trim();
    if (!normalizedSlug || !normalizedTokenId) return;
    let tokenSet = this.unavailableTokenIdsBySlug.get(normalizedSlug);
    if (!tokenSet) {
      tokenSet = new Set<string>();
      this.unavailableTokenIdsBySlug.set(normalizedSlug, tokenSet);
    }
    if (tokenSet.has(normalizedTokenId)) {
      this.logger.warn(
        { slug: normalizedSlug, tokenId: normalizedTokenId, reason },
        "POLY_V2_SIDE_BOOK_UNAVAILABLE_ALREADY_MARKED"
      );
      return;
    }
    tokenSet.add(normalizedTokenId);
    this.logger.warn({ slug: normalizedSlug, tokenId: normalizedTokenId, reason }, "POLY_V2_SIDE_BOOK_UNAVAILABLE");
  }

  private async discoverCandidates(
    tick: Btc5mTick,
    attemptedSlugs: string[]
  ): Promise<{ candidates: CandidateSeed[]; networkError: boolean }> {
    const candidates: CandidateSeed[] = [];
    let networkError = false;
    const nowTs = Date.now();
    this.pruneDiscoveryCache(nowTs, new Set(attemptedSlugs));
    const sources: Array<"current_slug" | "next_slug" | "prev_slug"> = ["current_slug", "next_slug", "prev_slug"];

    for (let index = 0; index < attemptedSlugs.length; index += 1) {
      const slug = attemptedSlugs[index];
      const source = sources[index] || "prev_slug";
      let rows: Array<Record<string, unknown>> = [];
      const cachedRows = this.getCachedDiscoveryRows(slug, nowTs);
      const cacheAgeMs = nowTs - this.getCachedDiscoveryTs(slug);
      if (cachedRows.length > 0 && cacheAgeMs <= this.getDiscoveryCachePreferMs()) {
        rows = cachedRows;
      } else {
        try {
          rows = (await this.client.getMarketsBySlugPathFirst(slug)) as Array<Record<string, unknown>>;
          if (rows.length > 0) {
            this.recentDiscoveredRowsBySlug.set(slug, {
              rows: rows.map((row) => ({ ...row })),
              cachedAtTs: nowTs
            });
          } else {
            rows = cachedRows;
            if (rows.length > 0) {
              this.logger.warn(
                { slug, cachedRowCount: rows.length, cacheAgeMs: nowTs - this.getCachedDiscoveryTs(slug) },
                "POLY_V2_SELECTOR_DISCOVERY_CACHE_FALLBACK"
              );
            }
          }
        } catch {
          networkError = true;
          rows = cachedRows;
          if (rows.length > 0) {
            this.logger.warn(
              { slug, cachedRowCount: rows.length, cacheAgeMs: nowTs - this.getCachedDiscoveryTs(slug) },
              "POLY_V2_SELECTOR_DISCOVERY_CACHE_FALLBACK"
            );
          }
        }
      }
      for (const row of rows) {
        const hintScore = this.computeTradabilityHint(row as Record<string, unknown>);
        candidates.push({
          row: row as Record<string, unknown>,
          expectedSlug: slug,
          source,
          alignmentRank: source === "current_slug" ? 0 : source === "next_slug" ? 1 : 2,
          tradabilityHintScore: hintScore
        });
      }
    }

    return { candidates, networkError };
  }

  private getCachedDiscoveryRows(slug: string, nowTs: number): Array<Record<string, unknown>> {
    const cached = this.recentDiscoveredRowsBySlug.get(slug);
    if (!cached) return [];
    if (nowTs - cached.cachedAtTs > this.getDiscoveryCacheTtlMs()) {
      this.recentDiscoveredRowsBySlug.delete(slug);
      return [];
    }
    return cached.rows.map((row) => ({ ...row }));
  }

  private getCachedDiscoveryTs(slug: string): number {
    return this.recentDiscoveredRowsBySlug.get(slug)?.cachedAtTs ?? 0;
  }

  private getCachedMarketMeta(
    marketId: string,
    nowTs: number
  ): {
    active: boolean;
    closed: boolean;
    archived: boolean;
    acceptingOrders: boolean;
    enableOrderBook: boolean;
    yesTokenId: string | null;
    noTokenId: string | null;
    cachedAtTs: number;
  } | null {
    const cached = this.recentMarketMetaById.get(marketId);
    if (!cached) return null;
    if (nowTs - cached.cachedAtTs > this.getDiscoveryCacheTtlMs()) {
      this.recentMarketMetaById.delete(marketId);
      return null;
    }
    return cached;
  }

  private cacheMarketMeta(
    marketId: string,
    meta: {
      active: boolean;
      closed: boolean;
      archived: boolean;
      acceptingOrders: boolean;
      enableOrderBook: boolean;
      yesTokenId: string | null;
      noTokenId: string | null;
      cachedAtTs: number;
    }
  ): void {
    if (!meta.yesTokenId && !meta.noTokenId) {
      return;
    }
    this.recentMarketMetaById.set(marketId, meta);
  }

  private getDiscoveryCacheTtlMs(): number {
    const raw = Number(process.env.POLY_V2_DISCOVERY_CACHE_TTL_MS || 600_000);
    if (!Number.isFinite(raw)) return 600_000;
    return Math.max(1_000, Math.min(3_600_000, Math.floor(raw)));
  }

  private getDiscoveryCachePreferMs(): number {
    const raw = Number(process.env.POLY_V2_DISCOVERY_CACHE_PREFER_MS || 120_000);
    if (!Number.isFinite(raw)) return 120_000;
    return Math.max(1_000, Math.min(this.getDiscoveryCacheTtlMs(), Math.floor(raw)));
  }

  private async evaluateCandidate(seed: CandidateSeed, tick: Btc5mTick): Promise<CandidateOutcome> {
    const candidate = await this.normalizeCandidate(seed, tick);
    if (!candidate) {
      return {
        selected: null,
        reason: BTC5M_SELECTOR_REASONS.CANDIDATE_NOT_TRADABLE,
        filteredOut: null
      };
    }
    if (this.isMarketUnavailable(candidate.slug, candidate.marketId)) {
      return {
        selected: null,
        reason: BTC5M_SELECTOR_REASONS.CANDIDATE_NOT_TRADABLE,
        filteredOut: "INVALID"
      };
    }

    if (!candidate.yesTokenId || !candidate.noTokenId || candidate.yesTokenId === candidate.noTokenId) {
      return {
        selected: null,
        reason: BTC5M_SELECTOR_REASONS.TOKEN_ID_MISSING,
        filteredOut: null
      };
    }
    const extremeMin = this.getExtremePriceMinConfig();
    const extremeMax = this.getExtremePriceMaxConfig(extremeMin);
    const wideSpreadThreshold = this.getWideSpreadThresholdConfig();

    const [yesBook, noBook] = await Promise.all([
      this.fetchSideBook(candidate.slug, "YES", candidate.yesTokenId),
      this.fetchSideBook(candidate.slug, "NO", candidate.noTokenId)
    ]);
    const yesAsk = sanitizePrice(yesBook.book.bestAsk);
    const noAsk = sanitizePrice(noBook.book.bestAsk);
    const yesSpread = sanitizeSpread(yesBook.book.spread);
    const noSpread = sanitizeSpread(noBook.book.spread);

    const yesQuoteValid =
      yesBook.bookable &&
      yesAsk !== null &&
      yesSpread !== null &&
      Number.isFinite(yesAsk) &&
      Number.isFinite(yesSpread);
    const noQuoteValid =
      noBook.bookable &&
      noAsk !== null &&
      noSpread !== null &&
      Number.isFinite(noAsk) &&
      Number.isFinite(noSpread);

    if (!yesQuoteValid && !noQuoteValid) {
      const networkFailure =
        yesBook.reasonCode === BTC5M_SELECTOR_REASONS.NETWORK_ERROR ||
        noBook.reasonCode === BTC5M_SELECTOR_REASONS.NETWORK_ERROR;
      this.logCandidateSkip({
        candidate,
        skipReason: "INVALID_QUOTE",
        extremeMin,
        extremeMax,
        yesAsk,
        noAsk,
        yesSpread,
        noSpread,
        wideSpreadThreshold
      });
      return {
        selected: null,
        reason: networkFailure ? BTC5M_SELECTOR_REASONS.NETWORK_ERROR : BTC5M_SELECTOR_REASONS.CANDIDATE_NOT_TRADABLE,
        filteredOut: "INVALID"
      };
    }

    const yesTradable =
      yesQuoteValid && yesAsk !== null && yesSpread !== null && yesAsk < extremeMax && yesAsk > extremeMin && yesSpread < wideSpreadThreshold;
    const noTradable =
      noQuoteValid && noAsk !== null && noSpread !== null && noAsk < extremeMax && noAsk > extremeMin && noSpread < wideSpreadThreshold;

    if (!yesTradable && !noTradable) {
      const extremeHit =
        (yesQuoteValid && yesAsk !== null && (yesAsk >= extremeMax || yesAsk <= extremeMin)) ||
        (noQuoteValid && noAsk !== null && (noAsk >= extremeMax || noAsk <= extremeMin));
      const wideSpreadHit =
        (yesQuoteValid && yesSpread !== null && yesSpread >= wideSpreadThreshold) ||
        (noQuoteValid && noSpread !== null && noSpread >= wideSpreadThreshold);
      this.logCandidateSkip({
        candidate,
        skipReason: extremeHit ? "EXTREME_BOOK" : wideSpreadHit ? "WIDE_SPREAD" : "INVALID_QUOTE",
        extremeMin,
        extremeMax,
        yesAsk,
        noAsk,
        yesSpread,
        noSpread,
        wideSpreadThreshold
      });
      return {
        selected: null,
        reason: BTC5M_SELECTOR_REASONS.CANDIDATE_NOT_TRADABLE,
        filteredOut: extremeHit ? "EXTREME" : wideSpreadHit ? "WIDE_SPREAD" : "INVALID"
      };
    }

    return {
      selected: {
        ...candidate,
        chosenSide: null,
        selectedTokenId: null,
        yesBook: yesTradable
          ? yesBook.book
          : {
              ...yesBook.book,
              bookable: false,
              reason:
                yesBook.book.reason ||
                (yesQuoteValid
                  ? yesAsk !== null && (yesAsk >= extremeMax || yesAsk <= extremeMin)
                    ? "EXTREME_BOOK"
                    : yesSpread !== null && yesSpread >= wideSpreadThreshold
                      ? "WIDE_SPREAD"
                      : "INVALID_QUOTE"
                  : "UNAVAILABLE")
            },
        noBook: noTradable
          ? noBook.book
          : {
              ...noBook.book,
              bookable: false,
              reason:
                noBook.book.reason ||
                (noQuoteValid
                  ? noAsk !== null && (noAsk >= extremeMax || noAsk <= extremeMin)
                    ? "EXTREME_BOOK"
                    : noSpread !== null && noSpread >= wideSpreadThreshold
                      ? "WIDE_SPREAD"
                      : "INVALID_QUOTE"
                  : "UNAVAILABLE")
            },
        orderbookOk: yesTradable || noTradable
      },
      reason: "OK",
      filteredOut: null
    };
  }

  private logCandidateSkip(
    input: {
      candidate: Omit<Btc5mSelectedMarket, "chosenSide" | "selectedTokenId" | "orderbookOk">;
      skipReason: "EXTREME_BOOK" | "WIDE_SPREAD" | "INVALID_QUOTE";
      extremeMin: number;
      extremeMax: number;
      yesAsk: number | null;
      noAsk: number | null;
      yesSpread: number | null;
      noSpread: number | null;
      wideSpreadThreshold: number;
    }
  ): void {
    this.logger.warn(
      {
        marketId: input.candidate.marketId,
        slug: input.candidate.slug,
        skipReason: input.skipReason,
        extremePriceMin: input.extremeMin,
        extremePriceMax: input.extremeMax,
        yesAsk: input.yesAsk,
        noAsk: input.noAsk,
        yesSpread: input.yesSpread,
        noSpread: input.noSpread,
        wideSpreadThreshold: input.wideSpreadThreshold
      },
      "POLY_V2_SELECTOR_SKIP"
    );
  }

  private getExtremePriceMinConfig(): number {
    const raw = Number(process.env.POLYMARKET_LIVE_EXTREME_PRICE_MIN || 0.05);
    if (!Number.isFinite(raw)) return 0.05;
    return clamp(raw, 0.0001, 0.99);
  }

  private getExtremePriceMaxConfig(extremeMin: number): number {
    const raw = Number(process.env.POLYMARKET_LIVE_EXTREME_PRICE_MAX || 0.95);
    if (!Number.isFinite(raw)) return clamp(0.95, extremeMin, 0.9999);
    return clamp(raw, extremeMin, 0.9999);
  }

  private getWideSpreadThresholdConfig(): number {
    const raw = Number(process.env.POLYMARKET_LIVE_SELECTOR_WIDE_SPREAD_MAX || 0.2);
    if (!Number.isFinite(raw)) return 0.2;
    return clamp(raw, 0.001, 1);
  }

  private async normalizeCandidate(
    seed: CandidateSeed,
    tick: Btc5mTick
  ): Promise<Omit<Btc5mSelectedMarket, "chosenSide" | "selectedTokenId" | "orderbookOk"> | null> {
    const row = seed.row;
    const marketId = pickString(row, ["id", "market_id", "conditionId", "condition_id"]);
    if (!marketId) return null;
    const nowTs = Date.now();

    const rowSlug = pickString(row, ["slug", "market_slug", "eventSlug", "event_slug"]) || seed.expectedSlug;
    const expectedBucketStartSec = parseBucketStartSec(seed.expectedSlug);
    const rowBucketStartSec = parseBucketStartSec(rowSlug);
    const inferredBucketStartSec = inferBucketStartSec(row);
    const startSec = rowBucketStartSec ?? expectedBucketStartSec ?? inferredBucketStartSec;
    if (startSec === null) return null;
    if (expectedBucketStartSec !== null && rowBucketStartSec !== null && expectedBucketStartSec !== rowBucketStartSec) {
      return null;
    }

    const cachedMeta = this.getCachedMarketMeta(marketId, nowTs);
    const context = cachedMeta ? null : await this.client.getMarketContext(marketId).catch(() => null);
    const active = context?.active ?? cachedMeta?.active ?? pickBoolean(row, ["active", "is_active"], true);
    const closed = context?.closed ?? cachedMeta?.closed ?? pickBoolean(row, ["closed", "is_closed", "resolved"], false);
    const archived = context?.archived ?? cachedMeta?.archived ?? pickBoolean(row, ["archived", "is_archived"], false);
    const acceptingOrders =
      context?.acceptingOrders ??
      cachedMeta?.acceptingOrders ??
      pickBoolean(row, ["accepting_orders", "acceptingOrders", "tradable"], true);
    const enableOrderBook =
      context?.enableOrderBook ??
      cachedMeta?.enableOrderBook ??
      pickBoolean(row, ["enable_order_book", "enableOrderBook"], true);
    if (!active || closed || archived || !acceptingOrders || !enableOrderBook) {
      return null;
    }

    const endSec = startSec + 300;
    const remainingSec = Math.max(0, endSec - tick.tickNowSec);
    const minRemaining = Math.max(1, this.config.polymarket.live.minEntryRemainingSec);
    if (!(remainingSec > minRemaining && remainingSec <= 600)) {
      return null;
    }

    const yesTokenId = context?.resolution.yesTokenId ?? cachedMeta?.yesTokenId ?? extractTokenId(row, "YES");
    const noTokenId = context?.resolution.noTokenId ?? cachedMeta?.noTokenId ?? extractTokenId(row, "NO");
    this.cacheMarketMeta(marketId, {
      active,
      closed,
      archived,
      acceptingOrders,
      enableOrderBook,
      yesTokenId,
      noTokenId,
      cachedAtTs: nowTs
    });

    return {
      marketId,
      slug: rowSlug,
      question: pickString(row, ["question", "title", "description", "subtitle"]) || rowSlug,
      priceToBeat: pickNumber(row, ["price_to_beat", "priceToBeat", "target_price", "strike", "threshold"]),
      startTs: startSec * 1000,
      endTs: endSec * 1000,
      remainingSec,
      tickSize: normalizeTickSize(pickString(row, ["minimum_tick_size", "tickSize", "tick_size"])),
      negRisk: pickBoolean(row, ["negRisk", "neg_risk"], false),
      yesTokenId,
      noTokenId,
      yesBook: emptySideBook("YES", yesTokenId),
      noBook: emptySideBook("NO", noTokenId),
      selectionSource: seed.source
    };
  }

  private async fetchSideBook(
    slug: string,
    side: Btc5mSide,
    tokenId: string
  ): Promise<{ book: Btc5mSideBook; bookable: boolean; reasonCode: Exclude<Btc5mSelectorReason, "OK"> | null }> {
    if (this.isSideBookUnavailable(slug, tokenId)) {
      this.logger.warn(
        { slug, side, tokenId, reason: "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN" },
        "POLY_V2_SIDE_BOOK_UNAVAILABLE_ALREADY_MARKED"
      );
      return {
        book: emptySideBook(side, tokenId),
        bookable: false,
        reasonCode: side === "YES" ? BTC5M_SELECTOR_REASONS.ORDERBOOK_MISSING_YES : BTC5M_SELECTOR_REASONS.ORDERBOOK_MISSING_NO
      };
    }

    let quoteFailedWithNetworkError = false;
    try {
      const quote = await this.client.getTokenPriceQuote(tokenId, { slug });
      const bestBid = sanitizePrice(quote.bestBid);
      const bestAsk = sanitizePrice(quote.bestAsk);
      if (bestBid !== null || bestAsk !== null) {
        return {
          book: {
            side,
            tokenId,
            bestBid,
            bestAsk,
            mid: sanitizePrice(quote.mid),
            spread: bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : null,
            quoteTs: Number.isFinite(quote.ts) ? quote.ts : null,
            bookable: true,
            reason: null
          },
          bookable: true,
          reasonCode: null
        };
      }
    } catch (error) {
      const reason = normalizeErrorReason(error);
      if (isNoOrderbookReason(reason)) {
        this.markSideBookUnavailable(slug, tokenId, reason);
        return {
          book: emptySideBook(side, tokenId),
          bookable: false,
          reasonCode: side === "YES" ? BTC5M_SELECTOR_REASONS.ORDERBOOK_MISSING_YES : BTC5M_SELECTOR_REASONS.ORDERBOOK_MISSING_NO
        };
      }
      quoteFailedWithNetworkError = true;
    }

    try {
      const book = await this.client.getTokenOrderBook(tokenId);
      const bestBid = sanitizePrice(book.bestBid);
      const bestAsk = sanitizePrice(book.bestAsk);
      if (bestBid !== null || bestAsk !== null) {
        return {
          book: {
            side,
            tokenId,
            bestBid,
            bestAsk,
            mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
            spread: bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : null,
            quoteTs: Number.isFinite(book.ts) ? book.ts : null,
            bookable: true,
            reason: null
          },
          bookable: true,
          reasonCode: null
        };
      }
      return {
        book: emptySideBook(side, tokenId),
        bookable: false,
        reasonCode: side === "YES" ? BTC5M_SELECTOR_REASONS.ORDERBOOK_MISSING_YES : BTC5M_SELECTOR_REASONS.ORDERBOOK_MISSING_NO
      };
    } catch (error) {
      const reason = normalizeErrorReason(error);
      if (isNoOrderbookReason(reason)) {
        this.markSideBookUnavailable(slug, tokenId, reason);
        return {
          book: emptySideBook(side, tokenId),
          bookable: false,
          reasonCode: side === "YES" ? BTC5M_SELECTOR_REASONS.ORDERBOOK_MISSING_YES : BTC5M_SELECTOR_REASONS.ORDERBOOK_MISSING_NO
        };
      }
      return {
        book: emptySideBook(side, tokenId),
        bookable: false,
        reasonCode: quoteFailedWithNetworkError
          ? BTC5M_SELECTOR_REASONS.NETWORK_ERROR
          : BTC5M_SELECTOR_REASONS.NETWORK_ERROR
      };
    }
  }

  private computeTradabilityHint(row: Record<string, unknown>): number {
    const active = pickBoolean(row, ["active", "is_active"], true);
    const closed = pickBoolean(row, ["closed", "is_closed", "resolved"], false);
    const archived = pickBoolean(row, ["archived", "is_archived"], false);
    const acceptingOrders = pickBoolean(row, ["accepting_orders", "acceptingOrders", "tradable"], true);
    const enableOrderBook = pickBoolean(row, ["enable_order_book", "enableOrderBook"], true);
    let score = 0;
    if (active) score += 3;
    if (!closed) score += 2;
    if (!archived) score += 2;
    if (acceptingOrders) score += 2;
    if (enableOrderBook) score += 1;
    return score;
  }

  private pruneUnavailableSlugs(activeSlugs: Set<string>): void {
    for (const slug of this.unavailableTokenIdsBySlug.keys()) {
      if (!activeSlugs.has(slug)) {
        this.unavailableTokenIdsBySlug.delete(slug);
      }
    }
    for (const slug of this.unavailableMarketIdsBySlug.keys()) {
      if (!activeSlugs.has(slug)) {
        this.unavailableMarketIdsBySlug.delete(slug);
      }
    }
  }

  private pruneDiscoveryCache(nowTs: number, activeSlugs: Set<string>): void {
    const ttlMs = this.getDiscoveryCacheTtlMs();
    for (const [slug, cached] of this.recentDiscoveredRowsBySlug.entries()) {
      if (!activeSlugs.has(slug) || nowTs - cached.cachedAtTs > ttlMs) {
        this.recentDiscoveredRowsBySlug.delete(slug);
      }
    }
    for (const [marketId, cached] of this.recentMarketMetaById.entries()) {
      if (nowTs - cached.cachedAtTs > ttlMs) {
        this.recentMarketMetaById.delete(marketId);
      }
    }
  }
}

function emptySideBook(side: Btc5mSide, tokenId: string | null): Btc5mSideBook {
  return {
    side,
    tokenId,
    bestBid: null,
    bestAsk: null,
    mid: null,
    spread: null,
    quoteTs: null,
    bookable: false,
    reason: null
  };
}

function parseBucketStartSec(slug: string): number | null {
  const normalized = String(slug || "").trim();
  if (!normalized) return null;
  const matches = normalized.match(/\d{9,}/g);
  if (!matches || matches.length === 0) return null;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const parsed = Number(matches[index]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function inferBucketStartSec(row: Record<string, unknown>): number | null {
  const ts =
    pickNumber(row, ["window_start", "windowStart", "start", "start_ts", "startTs", "start_time", "startTime"]) ??
    null;
  if (ts === null) return null;
  const sec = ts > 1_000_000_000_000 ? Math.floor(ts / 1000) : Math.floor(ts);
  if (!(sec > 0)) return null;
  return Math.floor(sec / 300) * 300;
}

function isNoOrderbookReason(reason: string): boolean {
  return reason.toLowerCase().includes("no orderbook exists for the requested token id");
}

function extractTokenId(row: Record<string, unknown>, side: Btc5mSide): string | null {
  const directYes = pickString(row, ["yesTokenId", "yes_token_id"]);
  const directNo = pickString(row, ["noTokenId", "no_token_id"]);
  if (side === "YES" && directYes) return directYes;
  if (side === "NO" && directNo) return directNo;

  const clobTokenIds = parseStringArray(row.clobTokenIds);
  if (clobTokenIds.length >= 2) {
    return side === "YES" ? clobTokenIds[0] : clobTokenIds[1];
  }

   const parsedTokens = parseTokens(row);
   const preferredToken = parsedTokens.find((token) => token.outcome === (side === "YES" ? "yes" : "no"));
   if (preferredToken?.tokenId) {
     return preferredToken.tokenId;
   }
   const fallbackToken = parsedTokens.find((token) => token.outcome !== "other");
   if (fallbackToken?.tokenId) {
     return fallbackToken.tokenId;
   }
  return null;
}

function normalizeTickSize(value: string): "0.1" | "0.01" | "0.001" | "0.0001" | undefined {
  const normalized = String(value || "").trim();
  if (normalized === "0.1" || normalized === "0.01" || normalized === "0.001" || normalized === "0.0001") {
    return normalized;
  }
  return undefined;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((row) => String(row || "").trim()).filter((row) => row.length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((row) => String(row || "").trim()).filter((row) => row.length > 0);
      }
    } catch {
      return value
        .split(",")
        .map((row) => String(row || "").trim())
        .filter((row) => row.length > 0);
    }
  }
  return [];
}

function parseTokens(row: Record<string, unknown>): Array<{ outcome: "yes" | "no" | "other"; tokenId: string }> {
  const raw = row.tokens;
  const outcomeNames = parseOutcomeNames(row);
  const clobTokenIds = parseStringArray(row.clobTokenIds);

  if (Array.isArray(raw) && raw.some((item) => item && typeof item === "object")) {
    const out: Array<{ outcome: "yes" | "no" | "other"; tokenId: string }> = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const tokenId = pickString(obj, ["token_id", "tokenId", "id", "clob_token_id"]);
      if (!tokenId) continue;
      out.push({
        outcome: normalizeOutcomeName(pickString(obj, ["outcome", "name", "label"])),
        tokenId
      });
    }
    if (out.length > 0) return out;
  }

  if (Array.isArray(raw) && raw.every((item) => typeof item === "string" || typeof item === "number")) {
    return raw
      .map((item, idx) => {
        const tokenId = String(item || "").trim();
        if (!tokenId) return null;
        return {
          outcome: normalizeOutcomeName(String(outcomeNames[idx] || "")),
          tokenId
        };
      })
      .filter((row): row is { outcome: "yes" | "no" | "other"; tokenId: string } => row !== null);
  }

  if (clobTokenIds.length > 0) {
    return clobTokenIds.map((tokenId, idx) => ({
      outcome: normalizeOutcomeName(String(outcomeNames[idx] || "")),
      tokenId
    }));
  }

  return [];
}

function parseOutcomeNames(row: Record<string, unknown>): string[] {
  if (Array.isArray(row.outcomes)) {
    return row.outcomes.map((value) => String(value || "").trim()).filter((value) => value.length > 0);
  }
  if (typeof row.outcomes === "string" && row.outcomes.trim().length > 0) {
    try {
      const parsed = JSON.parse(row.outcomes);
      if (Array.isArray(parsed)) {
        return parsed.map((value) => String(value || "").trim()).filter((value) => value.length > 0);
      }
    } catch {
      return row.outcomes
        .split(",")
        .map((value) => String(value || "").trim())
        .filter((value) => value.length > 0);
    }
  }
  return [];
}

function normalizeOutcomeName(value: string): "yes" | "no" | "other" {
  const outcomeRaw = String(value || "").trim().toLowerCase();
  if (
    outcomeRaw === "yes" ||
    outcomeRaw.includes("up") ||
    outcomeRaw.includes("higher") ||
    outcomeRaw.includes("above")
  ) {
    return "yes";
  }
  if (
    outcomeRaw === "no" ||
    outcomeRaw.includes("down") ||
    outcomeRaw.includes("lower") ||
    outcomeRaw.includes("below")
  ) {
    return "no";
  }
  return "other";
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
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

function sanitizePrice(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function sanitizeSpread(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeErrorReason(error: unknown): string {
  if (error instanceof Error) return error.message || "UNKNOWN_ERROR";
  return String(error || "UNKNOWN_ERROR");
}
