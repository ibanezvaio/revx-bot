import { deriveBtc5mTickContext } from "../btc5m";
import { Btc5mSelector, BTC5M_SELECTOR_REASONS } from "../live/Btc5mSelector";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

type MockClient = {
  getMarketsBySlugPathFirst: (slug: string) => Promise<Array<Record<string, unknown>>>;
  getMarketContext: (marketId: string) => Promise<any>;
  getTokenPriceQuote: (tokenId: string, options?: { slug?: string | null }) => Promise<any>;
  getTokenOrderBook: (tokenId: string) => Promise<any>;
};

function makeSelector(client: MockClient): Btc5mSelector {
  const config = {
    polymarket: {
      live: {
        minEntryRemainingSec: 60
      }
    }
  } as any;
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined
  } as any;
  return new Btc5mSelector(config, logger, client as any);
}

function makeTick(nowMs: number): ReturnType<typeof deriveBtc5mTickContext> {
  return deriveBtc5mTickContext(nowMs);
}

function makeBaseRow(slug: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "market-1",
    slug,
    question: "BTC up/down",
    active: true,
    closed: false,
    archived: false,
    accepting_orders: true,
    enable_order_book: true,
    clobTokenIds: ["yes-token", "no-token"],
    ...overrides
  };
}

export async function runBtc5mSelectorV2Tests(): Promise<void> {
  const tick = makeTick(1_773_147_060_000); // deterministic UTC sample

  // success path
  {
    const row = makeBaseRow(tick.currentSlug);
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => (slug === tick.currentSlug ? [row] : []),
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async (tokenId) => ({
        tokenId,
        bestBid: 0.48,
        bestAsk: 0.49,
        mid: 0.485,
        ts: Date.now()
      }),
      getTokenOrderBook: async () => ({
        bestBid: 0.48,
        bestAsk: 0.49,
        ts: Date.now()
      })
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.OK, `expected OK, got ${result.reason}`);
    assert(Boolean(result.selected), "expected selected market");
  }

  // NO_CANDIDATE_MARKETS
  {
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async () => [],
      getMarketContext: async () => null,
      getTokenPriceQuote: async () => ({ bestBid: null, bestAsk: null, mid: null, ts: Date.now() }),
      getTokenOrderBook: async () => ({ bestBid: null, bestAsk: null, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(
      result.reason === BTC5M_SELECTOR_REASONS.NO_CANDIDATE_MARKETS,
      `expected NO_CANDIDATE_MARKETS, got ${result.reason}`
    );
  }

  // NETWORK_ERROR (discovery)
  {
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async () => {
        throw new Error("network timeout");
      },
      getMarketContext: async () => null,
      getTokenPriceQuote: async () => ({ bestBid: null, bestAsk: null, mid: null, ts: Date.now() }),
      getTokenOrderBook: async () => ({ bestBid: null, bestAsk: null, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.NETWORK_ERROR, `expected NETWORK_ERROR, got ${result.reason}`);
  }

  // discovery cache fallback on transient empty lookup
  {
    const row = makeBaseRow(tick.currentSlug);
    let lookupCount = 0;
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => {
        if (slug !== tick.currentSlug) return [];
        lookupCount += 1;
        return lookupCount === 1 ? [row] : [];
      },
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async (tokenId) => ({
        tokenId,
        bestBid: 0.48,
        bestAsk: 0.49,
        mid: 0.485,
        ts: Date.now()
      }),
      getTokenOrderBook: async () => ({
        bestBid: 0.48,
        bestAsk: 0.49,
        ts: Date.now()
      })
    });
    const first = await selector.select({ tick });
    const second = await selector.select({ tick });
    assert(first.reason === BTC5M_SELECTOR_REASONS.OK, `expected initial OK, got ${first.reason}`);
    assert(second.reason === BTC5M_SELECTOR_REASONS.OK, `expected cached OK, got ${second.reason}`);
    assert(second.selected?.slug === tick.currentSlug, "expected cached selector result to retain current slug");
  }

  // fresh discovery cache should be preferred before repeating the same network lookup
  {
    const row = makeBaseRow(tick.currentSlug);
    let lookupCount = 0;
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => {
        if (slug !== tick.currentSlug) return [];
        lookupCount += 1;
        return [row];
      },
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async (tokenId) => ({
        tokenId,
        bestBid: 0.48,
        bestAsk: 0.49,
        mid: 0.485,
        ts: Date.now()
      }),
      getTokenOrderBook: async () => ({
        bestBid: 0.48,
        bestAsk: 0.49,
        ts: Date.now()
      })
    });
    const first = await selector.select({ tick });
    const second = await selector.select({ tick });
    assert(first.reason === BTC5M_SELECTOR_REASONS.OK, `expected initial OK, got ${first.reason}`);
    assert(second.reason === BTC5M_SELECTOR_REASONS.OK, `expected preferred-cache OK, got ${second.reason}`);
    assert(lookupCount === 1, `expected one network lookup with fresh cache, got ${lookupCount}`);
  }

  // market meta cache fallback should preserve token ids across transient context failures
  {
    const row = makeBaseRow(tick.currentSlug, { clobTokenIds: [] });
    let contextCalls = 0;
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => (slug === tick.currentSlug ? [row] : []),
      getMarketContext: async () => {
        contextCalls += 1;
        if (contextCalls === 1) {
          return {
            active: true,
            closed: false,
            archived: false,
            acceptingOrders: true,
            enableOrderBook: true,
            resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
          };
        }
        throw new Error("market context timeout");
      },
      getTokenPriceQuote: async (tokenId) => ({
        tokenId,
        bestBid: 0.48,
        bestAsk: 0.49,
        mid: 0.485,
        ts: Date.now()
      }),
      getTokenOrderBook: async () => ({
        bestBid: 0.48,
        bestAsk: 0.49,
        ts: Date.now()
      })
    });
    const first = await selector.select({ tick });
    const second = await selector.select({ tick });
    assert(first.reason === BTC5M_SELECTOR_REASONS.OK, `expected initial OK, got ${first.reason}`);
    assert(second.reason === BTC5M_SELECTOR_REASONS.OK, `expected cached-token OK, got ${second.reason}`);
    assert(second.selected?.yesTokenId === "yes-token", `expected cached yes token, got ${String(second.selected?.yesTokenId)}`);
    assert(second.selected?.noTokenId === "no-token", `expected cached no token, got ${String(second.selected?.noTokenId)}`);
  }

  // CANDIDATE_NOT_TRADABLE
  {
    const row = makeBaseRow(tick.currentSlug, { active: false });
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async () => [row],
      getMarketContext: async () => ({
        active: false,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async () => ({ bestBid: 0.48, bestAsk: 0.49, mid: 0.485, ts: Date.now() }),
      getTokenOrderBook: async () => ({ bestBid: 0.48, bestAsk: 0.49, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(
      result.reason === BTC5M_SELECTOR_REASONS.CANDIDATE_NOT_TRADABLE,
      `expected CANDIDATE_NOT_TRADABLE, got ${result.reason}`
    );
  }

  // TOKEN_ID_MISSING
  {
    const row = makeBaseRow(tick.currentSlug, { clobTokenIds: [] });
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async () => [row],
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: null, noTokenId: null }
      }),
      getTokenPriceQuote: async () => ({ bestBid: 0.48, bestAsk: 0.49, mid: 0.485, ts: Date.now() }),
      getTokenOrderBook: async () => ({ bestBid: 0.48, bestAsk: 0.49, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.TOKEN_ID_MISSING, `expected TOKEN_ID_MISSING, got ${result.reason}`);
  }

  // token ids should be recoverable from row.tokens when market context lookup fails
  {
    const row = makeBaseRow(tick.currentSlug, {
      clobTokenIds: [],
      outcomes: ["Yes", "No"],
      tokens: [
        { token_id: "yes-token", outcome: "Yes" },
        { token_id: "no-token", outcome: "No" }
      ]
    });
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async () => [row],
      getMarketContext: async () => {
        throw new Error("market context timeout");
      },
      getTokenPriceQuote: async () => ({ bestBid: 0.48, bestAsk: 0.49, mid: 0.485, ts: Date.now() }),
      getTokenOrderBook: async () => ({ bestBid: 0.48, bestAsk: 0.49, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.OK, `expected OK, got ${result.reason}`);
    assert(result.selected?.yesTokenId === "yes-token", `expected parsed yes token, got ${String(result.selected?.yesTokenId)}`);
    assert(result.selected?.noTokenId === "no-token", `expected parsed no token, got ${String(result.selected?.noTokenId)}`);
  }

  // single-sided market should still be selectable when YES has no orderbook
  {
    const row = makeBaseRow(tick.currentSlug);
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async () => [row],
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async (tokenId) => {
        if (tokenId === "yes-token") {
          throw new Error("No orderbook exists for the requested token id");
        }
        return { bestBid: 0.48, bestAsk: 0.49, mid: 0.485, ts: Date.now() };
      },
      getTokenOrderBook: async () => {
        throw new Error("No orderbook exists for the requested token id");
      }
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.OK, `expected OK, got ${result.reason}`);
    assert(Boolean(result.selected), "expected selected market");
    assert(result.selected?.yesBook.bookable === false, "expected YES book to be marked unavailable");
    assert(result.selected?.noBook.bookable === true, "expected NO book to remain tradable");
  }

  // quote timeout should fall back to the token order book instead of returning NETWORK_ERROR
  {
    const row = makeBaseRow(tick.currentSlug, { id: "market-quote-timeout-fallback" });
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async () => [row],
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async () => {
        throw new Error("Polymarket CLOB call timeout (getPrice:buy)");
      },
      getTokenOrderBook: async (tokenId) => ({
        bestBid: tokenId === "yes-token" ? 0.48 : 0.5,
        bestAsk: tokenId === "yes-token" ? 0.49 : 0.51,
        ts: Date.now()
      })
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.OK, `expected OK after orderbook fallback, got ${result.reason}`);
    assert(Boolean(result.selected), "expected selected market after quote-timeout fallback");
    assert(result.selected?.yesBook.bookable === true, "expected YES side to remain tradable via orderbook fallback");
    assert(result.selected?.noBook.bookable === true, "expected NO side to remain tradable via orderbook fallback");
  }

  // single-sided market should still be selectable when NO has no orderbook
  {
    const row = makeBaseRow(tick.currentSlug);
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async () => [row],
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async (tokenId) => {
        if (tokenId === "no-token") {
          throw new Error("No orderbook exists for the requested token id");
        }
        return { bestBid: 0.48, bestAsk: 0.49, mid: 0.485, ts: Date.now() };
      },
      getTokenOrderBook: async () => {
        throw new Error("No orderbook exists for the requested token id");
      }
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.OK, `expected OK, got ${result.reason}`);
    assert(Boolean(result.selected), "expected selected market");
    assert(result.selected?.yesBook.bookable === true, "expected YES book to remain tradable");
    assert(result.selected?.noBook.bookable === false, "expected NO book to be marked unavailable");
  }

  // side-level unavailable cache should skip repeated probes after hard no-orderbook failure
  {
    const row = makeBaseRow(tick.currentSlug, { id: "market-no-book-cache" });
    let yesPriceQuoteCalls = 0;
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => (slug === tick.currentSlug ? [row] : []),
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async (tokenId) => {
        if (tokenId === "yes-token") {
          yesPriceQuoteCalls += 1;
          throw new Error("No orderbook exists for the requested token id");
        }
        return { bestBid: 0.48, bestAsk: 0.49, mid: 0.485, ts: Date.now() };
      },
      getTokenOrderBook: async () => {
        throw new Error("No orderbook exists for the requested token id");
      }
    });
    const first = await selector.select({ tick });
    const second = await selector.select({ tick });
    assert(first.reason === BTC5M_SELECTOR_REASONS.OK, `expected first OK, got ${first.reason}`);
    assert(second.reason === BTC5M_SELECTOR_REASONS.OK, `expected second OK, got ${second.reason}`);
    assert(first.selected?.yesBook.bookable === false, "expected first YES book to be unavailable");
    assert(second.selected?.yesBook.bookable === false, "expected cached YES unavailability to persist");
    assert(yesPriceQuoteCalls === 1, `expected missing YES quote to be probed once, got ${yesPriceQuoteCalls}`);
  }

  // slug drift tolerance: row slug differs but contains same bucket timestamp
  {
    const driftSlug = `${tick.currentSlug}-drift-v2`;
    const row = makeBaseRow(driftSlug, { id: "market-drift" });
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => (slug === tick.currentSlug ? [row] : []),
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async () => ({ bestBid: 0.48, bestAsk: 0.49, mid: 0.485, ts: Date.now() }),
      getTokenOrderBook: async () => ({ bestBid: 0.48, bestAsk: 0.49, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.OK, `expected OK for slug drift, got ${result.reason}`);
    assert(Boolean(result.selected), "expected selected market for slug drift");
    assert(result.selected?.slug === driftSlug, "expected drift slug to be preserved");
  }

  // extreme-price on one side should still preserve the tradable opposite side
  {
    const row = makeBaseRow(tick.currentSlug, { id: "market-extreme-yes" });
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => (slug === tick.currentSlug ? [row] : []),
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async (tokenId) =>
        tokenId === "yes-token"
          ? { bestBid: 0.98, bestAsk: 0.99, mid: 0.985, ts: Date.now() }
          : { bestBid: 0.48, bestAsk: 0.49, mid: 0.485, ts: Date.now() },
      getTokenOrderBook: async () => ({ bestBid: 0.48, bestAsk: 0.49, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.OK, `expected OK for one-sided extreme book, got ${result.reason}`);
    assert(Boolean(result.selected), "expected selected market for one-sided extreme-book candidate");
    assert(result.selected?.yesBook.bookable === false, "expected YES side to be filtered as extreme");
    assert(result.selected?.noBook.bookable === true, "expected NO side to remain tradable");
  }

  // extreme current candidate should be skipped so next candidate can be selected
  {
    const currentRow = makeBaseRow(tick.currentSlug, { id: "market-current-extreme" });
    const nextRow = makeBaseRow(tick.nextSlug, { id: "market-next-valid" });
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => {
        if (slug === tick.currentSlug) return [currentRow];
        if (slug === tick.nextSlug) return [nextRow];
        return [];
      },
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async (_tokenId, options) => {
        if (options?.slug === tick.currentSlug) {
          return { bestBid: 0.98, bestAsk: 0.99, mid: 0.985, ts: Date.now() };
        }
        return { bestBid: 0.48, bestAsk: 0.49, mid: 0.485, ts: Date.now() };
      },
      getTokenOrderBook: async () => ({ bestBid: 0.48, bestAsk: 0.49, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.OK, `expected OK, got ${result.reason}`);
    assert(result.selected?.slug === tick.nextSlug, `expected next slug selected, got ${String(result.selected?.slug)}`);
    assert(result.droppedExtreme === 1, `expected droppedExtreme=1, got ${result.droppedExtreme}`);
    assert(
      result.candidatesAfterFilter === 1,
      `expected candidatesAfterFilter=1, got ${result.candidatesAfterFilter}`
    );
  }

  // once a viable candidate is found, later candidates should not incur side-book fetches
  {
    const currentRow = makeBaseRow(tick.currentSlug, { id: "market-current-valid-early-exit" });
    const nextRow = makeBaseRow(tick.nextSlug, { id: "market-next-should-not-probe" });
    let nextSlugQuoteCalls = 0;
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => {
        if (slug === tick.currentSlug) return [currentRow];
        if (slug === tick.nextSlug) return [nextRow];
        return [];
      },
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async (_tokenId, options) => {
        if (options?.slug === tick.nextSlug) {
          nextSlugQuoteCalls += 1;
          throw new Error("next candidate should not be probed after first viable selection");
        }
        return { bestBid: 0.48, bestAsk: 0.49, mid: 0.485, ts: Date.now() };
      },
      getTokenOrderBook: async () => ({ bestBid: 0.48, bestAsk: 0.49, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.OK, `expected OK, got ${result.reason}`);
    assert(result.selected?.slug === tick.currentSlug, `expected current slug selected, got ${String(result.selected?.slug)}`);
    assert(nextSlugQuoteCalls === 0, `expected next slug side-book probes skipped after first viable candidate, got ${nextSlugQuoteCalls}`);
  }

  // wide-spread pre-filter should drop candidates when both sides are too wide
  {
    const row = makeBaseRow(tick.currentSlug, { id: "market-wide-spread" });
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => (slug === tick.currentSlug ? [row] : []),
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async (tokenId) =>
        tokenId === "yes-token"
          ? { bestBid: 0.2, bestAsk: 0.45, mid: 0.325, ts: Date.now() }
          : { bestBid: 0.25, bestAsk: 0.5, mid: 0.375, ts: Date.now() },
      getTokenOrderBook: async () => ({ bestBid: 0.2, bestAsk: 0.45, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(
      result.reason === BTC5M_SELECTOR_REASONS.NO_VIABLE_CANDIDATE_AFTER_FILTER,
      `expected NO_VIABLE_CANDIDATE_AFTER_FILTER for wide spread, got ${result.reason}`
    );
    assert(result.droppedWideSpread === 1, `expected droppedWideSpread=1, got ${result.droppedWideSpread}`);
    assert(
      result.candidatesAfterFilter === 0,
      `expected candidatesAfterFilter=0, got ${result.candidatesAfterFilter}`
    );
  }

  // one-sided wide-spread should still preserve the tradable opposite side
  {
    const row = makeBaseRow(tick.currentSlug, { id: "market-wide-spread-one-side" });
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => (slug === tick.currentSlug ? [row] : []),
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async (tokenId) =>
        tokenId === "yes-token"
          ? { bestBid: 0.2, bestAsk: 0.45, mid: 0.325, ts: Date.now() } // spread 0.25
          : { bestBid: 0.47, bestAsk: 0.49, mid: 0.48, ts: Date.now() }, // spread 0.02
      getTokenOrderBook: async () => ({ bestBid: 0.2, bestAsk: 0.45, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.OK, `expected OK for one-sided wide spread, got ${result.reason}`);
    assert(Boolean(result.selected), "expected selected market for one-sided wide-spread candidate");
    assert(result.selected?.yesBook.bookable === false, "expected YES side to be filtered for wide spread");
    assert(result.selected?.noBook.bookable === true, "expected NO side to remain tradable");
  }

  // one non-extreme + two extreme should select the non-extreme candidate from filtered set
  {
    const currentExtremeRow = makeBaseRow(tick.currentSlug, { id: "market-current-extreme" });
    const currentValidRow = makeBaseRow(tick.currentSlug, { id: "market-current-valid" });
    const nextExtremeRow = makeBaseRow(tick.nextSlug, { id: "market-next-extreme" });
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => {
        if (slug === tick.currentSlug) return [currentExtremeRow, currentValidRow];
        if (slug === tick.nextSlug) return [nextExtremeRow];
        return [];
      },
      getMarketContext: async (marketId) => {
        if (marketId === "market-current-valid") {
          return {
            active: true,
            closed: false,
            archived: false,
            acceptingOrders: true,
            enableOrderBook: true,
            resolution: { yesTokenId: "yes-token-valid", noTokenId: "no-token-valid" }
          };
        }
        return {
          active: true,
          closed: false,
          archived: false,
          acceptingOrders: true,
          enableOrderBook: true,
          resolution: { yesTokenId: "yes-token-extreme", noTokenId: "no-token-extreme" }
        };
      },
      getTokenPriceQuote: async (tokenId) => {
        if (String(tokenId).includes("extreme")) {
          return { bestBid: 0.98, bestAsk: 0.99, mid: 0.985, ts: Date.now() };
        }
        return { bestBid: 0.48, bestAsk: 0.49, mid: 0.485, ts: Date.now() };
      },
      getTokenOrderBook: async () => ({ bestBid: 0.48, bestAsk: 0.49, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(result.reason === BTC5M_SELECTOR_REASONS.OK, `expected OK, got ${result.reason}`);
    assert(result.selected?.slug === tick.currentSlug, `expected current valid slug selected, got ${String(result.selected?.slug)}`);
    assert(result.candidatesBeforeFilter === 3, `expected candidatesBeforeFilter=3, got ${result.candidatesBeforeFilter}`);
    assert(result.candidatesAfterFilter === 1, `expected candidatesAfterFilter=1, got ${result.candidatesAfterFilter}`);
    assert(result.droppedExtreme === 2, `expected droppedExtreme=2, got ${result.droppedExtreme}`);
  }

  // all extreme candidates should yield NO_VIABLE_CANDIDATE_AFTER_FILTER
  {
    const currentRow = makeBaseRow(tick.currentSlug, { id: "market-current-extreme-all" });
    const nextRow = makeBaseRow(tick.nextSlug, { id: "market-next-extreme-all" });
    const selector = makeSelector({
      getMarketsBySlugPathFirst: async (slug) => {
        if (slug === tick.currentSlug) return [currentRow];
        if (slug === tick.nextSlug) return [nextRow];
        return [];
      },
      getMarketContext: async () => ({
        active: true,
        closed: false,
        archived: false,
        acceptingOrders: true,
        enableOrderBook: true,
        resolution: { yesTokenId: "yes-token", noTokenId: "no-token" }
      }),
      getTokenPriceQuote: async () => ({ bestBid: 0.98, bestAsk: 0.99, mid: 0.985, ts: Date.now() }),
      getTokenOrderBook: async () => ({ bestBid: 0.98, bestAsk: 0.99, ts: Date.now() })
    });
    const result = await selector.select({ tick });
    assert(
      result.reason === BTC5M_SELECTOR_REASONS.NO_VIABLE_CANDIDATE_AFTER_FILTER,
      `expected NO_VIABLE_CANDIDATE_AFTER_FILTER, got ${result.reason}`
    );
    assert(!result.selected, "expected no selected market when all candidates are extreme");
    assert(result.candidatesBeforeFilter === 2, `expected candidatesBeforeFilter=2, got ${result.candidatesBeforeFilter}`);
    assert(result.candidatesAfterFilter === 0, `expected candidatesAfterFilter=0, got ${result.candidatesAfterFilter}`);
    assert(result.droppedExtreme === 2, `expected droppedExtreme=2, got ${result.droppedExtreme}`);
  }

  // eslint-disable-next-line no-console
  console.log("Btc5mSelectorV2 tests: PASS");
}

if (require.main === module) {
  void runBtc5mSelectorV2Tests();
}
