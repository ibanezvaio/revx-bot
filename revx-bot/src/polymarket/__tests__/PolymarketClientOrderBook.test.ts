import { loadConfig } from "../../config";
import { buildLogger } from "../../logger";
import { PolymarketClient } from "../PolymarketClient";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export async function runPolymarketClientOrderBookTests(): Promise<void> {
  const config = loadConfig();
  const logger = buildLogger(config);
  const client = new PolymarketClient(config, logger) as unknown as {
    parseOrderBookPayload: (payload: unknown, tokenId: string) => {
      bestBid: number;
      bestAsk: number;
      bids: Array<{ price: number; size: number }>;
      asks: Array<{ price: number; size: number }>;
    };
    getTokenOrderBook: (tokenId: string) => Promise<{
      bestBid: number;
      bestAsk: number;
      bids: Array<{ price: number; size: number }>;
      asks: Array<{ price: number; size: number }>;
      ts: number;
    }>;
    getYesOrderBook: (marketId: string, tokenId: string) => Promise<{
      yesBid: number;
      yesAsk: number;
    }>;
  };

  const parsedNoAsk = client.parseOrderBookPayload(
    {
      bids: [{ price: "0.55", size: "10" }],
      asks: []
    },
    "token-yes"
  );
  assert(Number.isNaN(parsedNoAsk.bestAsk), "missing asks should keep bestAsk as NaN (no silent 1.0 fallback)");

  client.getTokenOrderBook = async () => ({
    bestBid: parsedNoAsk.bestBid,
    bestAsk: parsedNoAsk.bestAsk,
    bids: parsedNoAsk.bids,
    asks: parsedNoAsk.asks,
    ts: Date.now()
  });
  const yesBookNoAsk = await client.getYesOrderBook("market-1", "token-yes");
  assert(Number.isNaN(yesBookNoAsk.yesAsk), "YES book should remain non-bookable when asks are missing");

  const parsedWithAsk = client.parseOrderBookPayload(
    {
      bids: [{ price: "0.55", size: "10" }],
      asks: [{ price: "0.56", size: "8" }]
    },
    "token-yes"
  );
  assert(parsedWithAsk.bestAsk === 0.56, `expected bestAsk=0.56, got ${String(parsedWithAsk.bestAsk)}`);
  assert(parsedWithAsk.bestBid === 0.55, `expected bestBid=0.55, got ${String(parsedWithAsk.bestBid)}`);

  // eslint-disable-next-line no-console
  console.log("PolymarketClient orderbook tests: PASS");
}

if (require.main === module) {
  void runPolymarketClientOrderBookTests().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
