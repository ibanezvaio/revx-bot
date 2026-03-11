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

  // eslint-disable-next-line no-console
  console.log("Btc5mSelectorV2 tests: PASS");
}

if (require.main === module) {
  void runBtc5mSelectorV2Tests();
}
