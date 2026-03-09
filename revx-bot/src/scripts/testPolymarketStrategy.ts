import { BotConfig, loadConfig } from "../config";
import { Strategy } from "../polymarket/Strategy";
import { YesOrderBook } from "../polymarket/types";

process.env.DRY_RUN = "true";
process.env.POLYMARKET_MODE = "paper";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const base = loadConfig();
  return {
    ...base,
    polymarket: {
      ...base.polymarket,
      marketQuery: {
        ...base.polymarket.marketQuery,
        cadenceMinutes: 5
      },
      threshold: {
        ...base.polymarket.threshold,
        baseEdge: 0.01,
        volK: 2,
        closePenalty: 0.1
      },
      risk: {
        ...base.polymarket.risk,
        noNewOrdersInLastSec: 30
      }
    },
    ...overrides
  };
}

function makeBook(yesBid: number, yesAsk: number): YesOrderBook {
  return {
    marketId: "m1",
    tokenId: "t1",
    yesBid,
    yesAsk,
    yesMid: (yesBid + yesAsk) / 2,
    spread: yesAsk - yesBid,
    bids: [{ price: yesBid, size: 100 }],
    asks: [{ price: yesAsk, size: 100 }],
    ts: Date.now()
  };
}

function run(): void {
  const strategy = new Strategy(makeConfig());

  const blockedNearExpiry = strategy.decide({
    pUpModel: 0.9,
    orderBook: makeBook(0.5, 0.51),
    sigmaPerSqrtSec: 0.01,
    tauSec: 20
  });
  assert(
    blockedNearExpiry.action === "HOLD" && blockedNearExpiry.reason === "NO_NEW_ORDERS_NEAR_EXPIRY",
    `expected no-trade near expiry, got ${blockedNearExpiry.action}/${blockedNearExpiry.reason}`
  );

  const buy = strategy.decide({
    pUpModel: 0.7,
    orderBook: makeBook(0.54, 0.55),
    sigmaPerSqrtSec: 0.002,
    tauSec: 120
  });
  assert(buy.action === "BUY_YES", `expected BUY_YES, got ${buy.action}`);
  assert(buy.edgeYes > 0 && buy.edgeNo < 0, "expected edgeYes positive and edgeNo negative for BUY_YES case");
  assert(buy.chosenSide === "YES", `expected chosen side YES, got ${buy.chosenSide}`);

  const hold = strategy.decide({
    pUpModel: 0.1,
    orderBook: makeBook(0.51, 0.52),
    sigmaPerSqrtSec: 0.001,
    tauSec: 120
  });
  assert(hold.action === "BUY_NO", `expected BUY_NO for negative edge, got ${hold.action}`);
  assert(hold.chosenSide === "NO", `expected chosen side NO, got ${hold.chosenSide}`);
  assert(hold.edgeNo > hold.edgeYes, "expected NO edge to dominate when pUpModel is low");

  const flat = strategy.decide({
    pUpModel: 0.515,
    orderBook: makeBook(0.51, 0.52),
    sigmaPerSqrtSec: 0.02,
    tauSec: 120
  });
  assert(flat.action === "HOLD", `expected HOLD for weak edge, got ${flat.action}`);

  const highMinConfig = makeConfig();
  highMinConfig.polymarket.paper.minEdgeThreshold = 0.25;
  const highMinStrategy = new Strategy(highMinConfig);
  const netBlocked = highMinStrategy.decide({
    pUpModel: 0.72,
    orderBook: makeBook(0.54, 0.56),
    sigmaPerSqrtSec: 0.002,
    tauSec: 120
  });
  assert(
    netBlocked.action === "HOLD" && netBlocked.reason === "NET_EDGE_BELOW_MIN_THRESHOLD",
    `expected net-edge gate hold, got ${netBlocked.action}/${netBlocked.reason}`
  );

  // eslint-disable-next-line no-console
  console.log("Polymarket Strategy tests: PASS");
}

run();
