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

  // ORDERBOOK_MISSING_YES
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
    assert(
      result.reason === BTC5M_SELECTOR_REASONS.ORDERBOOK_MISSING_YES,
      `expected ORDERBOOK_MISSING_YES, got ${result.reason}`
    );
  }

  // ORDERBOOK_MISSING_NO
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
    assert(
      result.reason === BTC5M_SELECTOR_REASONS.ORDERBOOK_MISSING_NO,
      `expected ORDERBOOK_MISSING_NO, got ${result.reason}`
    );
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

  // extreme-price pre-filter should drop pathological books and emit explicit no-viable reason
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
    assert(
      result.reason === BTC5M_SELECTOR_REASONS.NO_VIABLE_CANDIDATE_AFTER_FILTER,
      `expected NO_VIABLE_CANDIDATE_AFTER_FILTER for extreme ask, got ${result.reason}`
    );
    assert(!result.selected, "expected no selected market for extreme-book candidate");
    assert(result.droppedExtreme === 1, `expected droppedExtreme=1, got ${result.droppedExtreme}`);
    assert(
      result.candidatesAfterFilter === 0,
      `expected candidatesAfterFilter=0, got ${result.candidatesAfterFilter}`
    );
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

  // wide-spread pre-filter should drop candidate when either side spread exceeds threshold
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
    assert(
      result.reason === BTC5M_SELECTOR_REASONS.NO_VIABLE_CANDIDATE_AFTER_FILTER,
      `expected NO_VIABLE_CANDIDATE_AFTER_FILTER for one-sided wide spread, got ${result.reason}`
    );
    assert(result.droppedWideSpread === 1, `expected droppedWideSpread=1, got ${result.droppedWideSpread}`);
    assert(result.candidatesAfterFilter === 0, `expected candidatesAfterFilter=0, got ${result.candidatesAfterFilter}`);
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
