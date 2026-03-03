import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { PolymarketClient } from "../polymarket/PolymarketClient";
import { MarketScanner } from "../polymarket/MarketScanner";

async function run(): Promise<void> {
  if (String(process.env.POLYMARKET_INTEGRATION_TEST || "").toLowerCase() !== "true") {
    // eslint-disable-next-line no-console
    console.log("Polymarket integration test: SKIP (set POLYMARKET_INTEGRATION_TEST=true)");
    return;
  }

  const config = loadConfig();
  const effectiveConfig = {
    ...config,
    polymarket: {
      ...config.polymarket,
      enabled: true,
      mode: "paper" as const
    }
  };
  const logger = buildLogger(effectiveConfig);
  const client = new PolymarketClient(effectiveConfig, logger);
  const scanner = new MarketScanner(effectiveConfig, logger, client);

  const ping = await client.ping();
  const markets = await scanner.scanActiveBtc5m();

  if (markets.length > 0) {
    await client.getYesOrderBook(markets[0].marketId, markets[0].yesTokenId);
  }

  // eslint-disable-next-line no-console
  console.log(
    `Polymarket integration test: PASS (mode=${ping.mode} markets=${markets.length} serverTime=${ping.serverTime})`
  );
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Polymarket integration test: FAIL", error);
  process.exit(1);
});
