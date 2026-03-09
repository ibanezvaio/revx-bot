import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { buildCreateOrderInput } from "../polymarket/auth/requestBuilder";
import { PolymarketClient } from "../polymarket/PolymarketClient";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const built = buildCreateOrderInput({
    tokenId: "1234567890",
    side: "BUY",
    price: 1.5,
    size: 10,
    expirationSec: nowSec - 100,
    feeRateBps: 12,
    tickSize: "0.01",
    negRisk: true
  });

  assert(built.userOrder.tokenID === "1234567890", "tokenID mismatch");
  assert(built.userOrder.side === "BUY", "side mismatch");
  assert(built.userOrder.price < 1 && built.userOrder.price > 0, "price clamp failed");
  assert(built.userOrder.price === 0.99, `expected clamped price 0.99, got ${built.userOrder.price}`);
  assert(built.userOrder.expiration === nowSec - 100, `expiration should preserve caller input, got ${String(built.userOrder.expiration)}`);
  assert(built.userOrder.feeRateBps === 12, `feeRateBps should be preserved, got ${String(built.userOrder.feeRateBps)}`);
  assert(built.options.tickSize === "0.01", "tickSize mismatch");
  assert(built.options.negRisk === true, "negRisk mismatch");

  const rounded = buildCreateOrderInput({
    tokenId: "1234567890",
    side: "BUY",
    price: 0.538,
    size: 10,
    expirationSec: nowSec + 5,
    tickSize: "0.01",
    negRisk: false
  });
  assert(rounded.userOrder.price === 0.53, `expected tick-rounded price 0.53, got ${rounded.userOrder.price}`);

  let threw = false;
  try {
    buildCreateOrderInput({
      tokenId: "",
      side: "BUY",
      price: 0.5,
      size: 1,
      expirationSec: nowSec + 10,
      tickSize: "0.01",
      negRisk: false
    });
  } catch {
    threw = true;
  }
  assert(threw, "expected invalid tokenId to throw");

  const config = loadConfig();
  const logger = buildLogger(config);
  const client = new PolymarketClient(config, logger);
  const clientAny = client as any;
  const priceCalls: Array<{ tokenId: string; side: string }> = [];
  clientAny.getPublicClient = async () => ({
    getPrice: async (tokenId: string, side: string) => {
      priceCalls.push({ tokenId, side });
      return side === "SELL" ? { p: 0.41, t: nowSec } : { p: 0.43, t: nowSec };
    }
  });
  clientAny.runClobCall = async (_label: string, fn: () => Promise<unknown>) => fn();
  clientAny.getTokenOrderBook = async () => {
    throw new Error("book fallback should not be used for successful /price requests");
  };
  const quote = await client.getTokenPriceQuote("1234567890", {
    slug: "btc-updown-5m-1234567800"
  });
  assert(priceCalls.length === 2, `expected two /price calls, got ${String(priceCalls.length)}`);
  assert(priceCalls[0]?.side === "SELL", `expected SELL /price probe first, got ${String(priceCalls[0]?.side)}`);
  assert(priceCalls[1]?.side === "BUY", `expected BUY /price probe second, got ${String(priceCalls[1]?.side)}`);
  assert(quote.bestBid === 0.41, `expected bestBid 0.41 from SELL /price probe, got ${String(quote.bestBid)}`);
  assert(quote.bestAsk === 0.43, `expected bestAsk 0.43 from BUY /price probe, got ${String(quote.bestAsk)}`);
  assert(quote.fetchFailed === false, `successful /price probes should not mark fetchFailed, got ${String(quote.fetchFailed)}`);

  // eslint-disable-next-line no-console
  console.log("Polymarket request-building tests: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Polymarket request-building tests: FAIL", error);
  process.exit(1);
});
