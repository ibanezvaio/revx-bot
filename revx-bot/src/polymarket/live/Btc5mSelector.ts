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
    const cycleUnbookableTokenIds = new Set<string>();
    let lastReason = "NO_DIRECT_MARKET";

    for (const slug of attemptedSlugs) {
      const source =
        slug === tick.currentSlug ? "current_slug" : slug === tick.nextSlug ? "next_slug" : "prev_slug";

      let rows: RawPolymarketMarket[] = [];
      try {
        rows = await this.client.getMarketsBySlugPathFirst(slug);
      } catch (error) {
        lastReason = normalizeErrorReason(error);
        continue;
      }

      for (const row of rows) {
        const candidate = await this.normalizeCandidate(row as Record<string, unknown>, slug, tick, source);
        if (!candidate) {
          continue;
        }

        const sideOrder = this.getSideOrder();
        const sideBooks: Partial<Record<Btc5mSide, Btc5mSideBook>> = {};
        let candidateRejected = false;

        for (const side of sideOrder) {
          const tokenId = side === "YES" ? candidate.yesTokenId : candidate.noTokenId;
          if (!tokenId) {
            candidateRejected = true;
            lastReason = "TOKEN_ID_MISSING";
            continue;
          }
          if (cycleUnbookableTokenIds.has(tokenId) || this.isSideBookUnavailable(slug, tokenId)) {
            candidateRejected = true;
            lastReason = "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN";
            this.logger.warn(
              { slug, side, tokenId, reason: "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN" },
              "POLY_V2_SIDE_BOOK_UNAVAILABLE_ALREADY_MARKED"
            );
            continue;
          }

          const sideBook = await this.fetchSideBook(slug, side, tokenId);
          if (
            sideBook.reason &&
            sideBook.reason.toLowerCase().includes("no orderbook exists for the requested token id")
          ) {
            cycleUnbookableTokenIds.add(tokenId);
            this.markSideBookUnavailable(slug, tokenId, sideBook.reason);
            candidateRejected = true;
            lastReason = "MISSING_ORDERBOOK_FOR_SELECTED_TOKEN";
            continue;
          }
          if (!sideBook.bookable || !sideBook.tokenId) {
            candidateRejected = true;
            lastReason = sideBook.reason || "SIDE_NOT_BOOKABLE";
            continue;
          }

          sideBooks[side] = sideBook;
        }

        const yesBook = sideBooks.YES ?? candidate.yesBook;
        const noBook = sideBooks.NO ?? candidate.noBook;
        if (candidateRejected || !yesBook.bookable || !noBook.bookable || !yesBook.tokenId || !noBook.tokenId) {
          continue;
        }

        const selected: Btc5mSelectedMarket = {
          ...candidate,
          chosenSide: null,
          selectedTokenId: null,
          yesBook,
          noBook,
          orderbookOk: true
        };

        return {
          tick,
          attemptedSlugs,
          selected,
          reason: "OK"
        };
      }
    }

    return {
      tick,
      attemptedSlugs,
      selected: null,
      reason: lastReason
    };
  }

  private async normalizeCandidate(
    row: Record<string, unknown>,
    expectedSlug: string,
    tick: Btc5mTick,
    source: "current_slug" | "next_slug" | "prev_slug"
  ): Promise<Omit<Btc5mSelectedMarket, "chosenSide" | "selectedTokenId" | "orderbookOk"> | null> {
    const marketId = pickString(row, ["id", "market_id", "conditionId", "condition_id"]);
    if (!marketId) return null;

    const rowSlug = pickString(row, ["slug", "market_slug", "eventSlug", "event_slug"]) || expectedSlug;
    if (rowSlug !== expectedSlug) return null;

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

    const startSec = parseSlugStartSec(rowSlug);
    if (startSec === null) return null;
    const endSec = startSec + 300;
    const remainingSec = Math.max(0, endSec - tick.tickNowSec);
    const minRemaining = Math.max(1, this.config.polymarket.live.minEntryRemainingSec);
    const maxRemaining = Math.max(minRemaining, this.config.polymarket.paper.entryMaxRemainingSec);
    if (!(remainingSec > minRemaining && remainingSec <= maxRemaining)) {
      return null;
    }

    const yesTokenId = context?.resolution.yesTokenId ?? extractTokenId(row, "YES");
    const noTokenId = context?.resolution.noTokenId ?? extractTokenId(row, "NO");
    if (!yesTokenId || !noTokenId || yesTokenId === noTokenId) {
      return null;
    }

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
      selectionSource: source
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

  private pruneUnavailableSlugs(activeSlugs: Set<string>): void {
    for (const slug of this.unavailableTokenIdsBySlug.keys()) {
      if (!activeSlugs.has(slug)) {
        this.unavailableTokenIdsBySlug.delete(slug);
      }
    }
  }

  private getSideOrder(): Btc5mSide[] {
    const configuredOrder = String(process.env.POLY_V2_BOOK_CHECK_ORDER || "YES_NO").trim().toUpperCase();
    return configuredOrder === "NO_YES" ? ["NO", "YES"] : ["YES", "NO"];
  }

  private async fetchSideBook(slug: string, side: Btc5mSide, tokenId: string): Promise<Btc5mSideBook> {
    try {
      const quote = await this.client.getTokenPriceQuote(tokenId, { slug });
      const bestBid = sanitizePrice(quote.bestBid);
      const bestAsk = sanitizePrice(quote.bestAsk);
      const mid = sanitizePrice(quote.mid);
      if (bestBid !== null || bestAsk !== null) {
        return {
          side,
          tokenId,
          bestBid,
          bestAsk,
          mid,
          spread: bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : null,
          quoteTs: Number.isFinite(quote.ts) ? quote.ts : null,
          bookable: true,
          reason: null
        };
      }
      const book = await this.client.getTokenOrderBook(tokenId);
      const bookBid = sanitizePrice(book.bestBid);
      const bookAsk = sanitizePrice(book.bestAsk);
      if (bookBid !== null || bookAsk !== null) {
        return {
          side,
          tokenId,
          bestBid: bookBid,
          bestAsk: bookAsk,
          mid: bookBid !== null && bookAsk !== null ? (bookBid + bookAsk) / 2 : null,
          spread: bookBid !== null && bookAsk !== null ? Math.max(0, bookAsk - bookBid) : null,
          quoteTs: Number.isFinite(book.ts) ? book.ts : null,
          bookable: true,
          reason: null
        };
      }
      return {
        side,
        tokenId,
        bestBid: null,
        bestAsk: null,
        mid: null,
        spread: null,
        quoteTs: Number.isFinite(quote.ts) ? quote.ts : null,
        bookable: false,
        reason: "EMPTY_LIVE_QUOTE"
      };
    } catch (error) {
      const reason = normalizeErrorReason(error);
      if (reason.toLowerCase().includes("no orderbook exists for the requested token id")) {
        this.markSideBookUnavailable(slug, tokenId, reason);
      } else {
        this.logger.warn({ slug, side, tokenId, reason }, "POLY_V2_SIDE_BOOK_UNAVAILABLE");
      }
      return {
        side,
        tokenId,
        bestBid: null,
        bestAsk: null,
        mid: null,
        spread: null,
        quoteTs: null,
        bookable: false,
        reason
      };
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

function parseSlugStartSec(slug: string): number | null {
  const match = String(slug || "").trim().match(/btc-updown-5m-(\d{9,})$/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
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
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
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

function normalizeErrorReason(error: unknown): string {
  if (error instanceof Error) return error.message || "UNKNOWN_ERROR";
  return String(error || "UNKNOWN_ERROR");
}
