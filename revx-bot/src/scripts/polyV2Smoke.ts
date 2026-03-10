import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { createStore } from "../store/factory";
import { Btc5mLiveRunner } from "../polymarket/live/Btc5mLiveRunner";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = buildLogger(config).child({ module: "polymarket-v2-smoke" });
  const store = createStore(config, logger);
  store.init();

  try {
    const runner = new Btc5mLiveRunner(config, logger, { store });
    await runner.runSmoke(2);
    const snapshot = runner.getDashboardSnapshot();
    logger.warn(
      {
        selectedSlug: snapshot.selection && typeof snapshot.selection === "object"
          ? (snapshot.selection as Record<string, unknown>).selectedSlug ?? null
          : null,
        selectedTokenId: snapshot.selectedTokenId ?? null,
        action: snapshot.strategyAction ?? snapshot.lastAction ?? "HOLD",
        holdReason: snapshot.holdReason ?? null,
        currentBucketSlug: snapshot.currentBucketSlug ?? null,
        nextBucketSlug: snapshot.nextBucketSlug ?? null
      },
      "POLY_V2_SMOKE_FINAL"
    );
  } finally {
    store.close();
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
