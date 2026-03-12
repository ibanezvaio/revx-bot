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
    const sources: Array<"current_slug" | "next_slug" | "prev_slug"> = ["current_slug", "next_slug", "prev_slug"];

    for (let index = 0; index < attemptedSlugs.length; index += 1) {
      const slug = attemptedSlugs[index];
      const source = sources[index] || "prev_slug";
      try {
        const rows = await this.client.getMarketsBySlugPathFirst(slug);
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
      } catch {
        networkError = true;
      }
    }

    return { candidates, networkError };
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

    const yesBook = await this.fetchSideBook(candidate.slug, "YES", candidate.yesTokenId);
    if (!yesBook.bookable) {
      return {
        selected: null,
        reason:
          yesBook.reasonCode === BTC5M_SELECTOR_REASONS.NETWORK_ERROR
            ? BTC5M_SELECTOR_REASONS.NETWORK_ERROR
            : BTC5M_SELECTOR_REASONS.ORDERBOOK_MISSING_YES,
        filteredOut: null
      };
    }
    const yesAsk = sanitizePrice(yesBook.book.bestAsk);

    const noBook = await this.fetchSideBook(candidate.slug, "NO", candidate.noTokenId);
    if (!noBook.bookable) {
      return {
        selected: null,
        reason:
          noBook.reasonCode === BTC5M_SELECTOR_REASONS.NETWORK_ERROR
            ? BTC5M_SELECTOR_REASONS.NETWORK_ERROR
            : BTC5M_SELECTOR_REASONS.ORDERBOOK_MISSING_NO,
        filteredOut: null
      };
    }
    const noAsk = sanitizePrice(noBook.book.bestAsk);
    const yesSpread = sanitizeSpread(yesBook.book.spread);
    const noSpread = sanitizeSpread(noBook.book.spread);

    const invalidQuoteHit =
      yesAsk === null ||
      noAsk === null ||
      yesSpread === null ||
      noSpread === null ||
      !Number.isFinite(yesAsk) ||
      !Number.isFinite(noAsk) ||
      !Number.isFinite(yesSpread) ||
      !Number.isFinite(noSpread);
    if (invalidQuoteHit) {
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
        reason: BTC5M_SELECTOR_REASONS.CANDIDATE_NOT_TRADABLE,
        filteredOut: "INVALID"
      };
    }

    const extremeHit =
      yesAsk >= extremeMax || yesAsk <= extremeMin || noAsk >= extremeMax || noAsk <= extremeMin;
    if (extremeHit) {
      this.logCandidateSkip({
        candidate,
        skipReason: "EXTREME_BOOK",
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
        filteredOut: "EXTREME"
      };
    }

    const wideSpreadHit =
      (yesSpread !== null && Number.isFinite(yesSpread) && yesSpread >= wideSpreadThreshold) ||
      (noSpread !== null && Number.isFinite(noSpread) && noSpread >= wideSpreadThreshold);
    if (wideSpreadHit) {
      this.logCandidateSkip({
        candidate,
        skipReason: "WIDE_SPREAD",
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
        filteredOut: "WIDE_SPREAD"
      };
    }

    return {
      selected: {
        ...candidate,
        chosenSide: null,
        selectedTokenId: null,
        yesBook: yesBook.book,
        noBook: noBook.book,
        orderbookOk: true
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

    const rowSlug = pickString(row, ["slug", "market_slug", "eventSlug", "event_slug"]) || seed.expectedSlug;
    const expectedBucketStartSec = parseBucketStartSec(seed.expectedSlug);
    const rowBucketStartSec = parseBucketStartSec(rowSlug);
    const inferredBucketStartSec = inferBucketStartSec(row);
    const startSec = rowBucketStartSec ?? expectedBucketStartSec ?? inferredBucketStartSec;
    if (startSec === null) return null;
    if (expectedBucketStartSec !== null && rowBucketStartSec !== null && expectedBucketStartSec !== rowBucketStartSec) {
      return null;
    }

    const context = await this.client.getMarketContext(marketId).catch(() => null);
    const active = context?.active ?? pickBoolean(row, ["active", "is_active"], true);
    const closed = context?.closed ?? pickBoolean(row, ["closed", "is_closed", "resolved"], false);
    const archived = context?.archived ?? pickBoolean(row, ["archived", "is_archived"], false);
    const acceptingOrders =
      context?.acceptingOrders ?? pickBoolean(row, ["accepting_orders", "acceptingOrders", "tradable"], true);
    const enableOrderBook =
      context?.enableOrderBook ?? pickBoolean(row, ["enable_order_book", "enableOrderBook"], true);
    if (!active || closed || archived || !acceptingOrders || !enableOrderBook) {
      return null;
    }

    const endSec = startSec + 300;
    const remainingSec = Math.max(0, endSec - tick.tickNowSec);
    const minRemaining = Math.max(1, this.config.polymarket.live.minEntryRemainingSec);
    if (!(remainingSec > minRemaining && remainingSec <= 600)) {
      return null;
    }

    const yesTokenId = context?.resolution.yesTokenId ?? extractTokenId(row, "YES");
    const noTokenId = context?.resolution.noTokenId ?? extractTokenId(row, "NO");

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
      return {
        book: emptySideBook(side, tokenId),
        bookable: false,
        reasonCode: BTC5M_SELECTOR_REASONS.NETWORK_ERROR
      };
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
        reasonCode: BTC5M_SELECTOR_REASONS.NETWORK_ERROR
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
  if (!Array.isArray(value)) return [];
  return value.map((row) => String(row || "").trim()).filter((row) => row.length > 0);
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
