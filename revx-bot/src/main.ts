import { loadConfig } from "./config";
import { Execution } from "./exec/Execution";
import { buildLogger } from "./logger";
import { MarketData } from "./md/MarketData";
import { Reconciler } from "./recon/Reconciler";
import { RevXClient } from "./revx/RevXClient";
import { RiskManager } from "./risk/RiskManager";
import { SignalEngine } from "./signals/SignalEngine";
import { createStore } from "./store/factory";
import { MakerStrategy } from "./strategy/MakerStrategy";
import { DashboardServer } from "./web/DashboardServer";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = buildLogger(config);

  logEffectiveConfig(logger, config);

  logger.info(
    { symbol: config.symbol, dryRun: config.dryRun, mockMode: config.mockMode },
    "Starting revx-bot"
  );

  const store = createStore(config, logger);
  store.init();

  const client = new RevXClient(config, logger);
  const marketData = new MarketData(client, logger);
  const risk = new RiskManager(config, logger);
  const signalEngine = new SignalEngine(config);
  const execution = new Execution(config, logger, client, store, config.dryRun);
  const reconciler = new Reconciler(config, logger, client, store, marketData);
  const dashboard = new DashboardServer(config, logger, store, execution.getRunId(), {
    cancelAllBotOrders: async () => execution.cancelAllBotOrders(config.symbol)
  });
  const strategy = new MakerStrategy(
    config,
    logger,
    client,
    store,
    marketData,
    execution,
    reconciler,
    risk,
    signalEngine
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ signal }, "Shutdown requested");

    strategy.stop();
    reconciler.stop();
    dashboard.stop();

    try {
      await execution.cancelAllBotOrders(config.symbol);
    } catch (error) {
      logger.error({ error }, "Failed cancelling bot orders during shutdown");
    }

    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    dashboard.start();
    reconciler.start();
    await strategy.start();
  } finally {
    dashboard.stop();
    reconciler.stop();
    store.close();
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});

function logEffectiveConfig(
  logger: ReturnType<typeof buildLogger>,
  config: ReturnType<typeof loadConfig>
): void {
  logger.info(
    {
      config: {
        symbol: config.symbol,
        revxBaseUrl: config.revxBaseUrl,
        dryRun: config.dryRun,
        mockMode: config.mockMode,
        storeBackend: config.storeBackend,
        refreshSeconds: config.refreshSeconds,
        reconcileSeconds: config.reconcileSeconds,
        levels: config.levels,
        levelQuoteSizeUsd: config.levelQuoteSizeUsd,
        enableTopOfBook: config.enableTopOfBook,
        tobQuoteSizeUsd: config.tobQuoteSizeUsd,
        baseHalfSpreadBps: config.baseHalfSpreadBps,
        minHalfSpreadBps: config.minHalfSpreadBps,
        maxHalfSpreadBps: config.maxHalfSpreadBps,
        repriceMoveBps: config.repriceMoveBps,
        queueRefreshSeconds: config.queueRefreshSeconds,
        minOrderAgeSeconds: config.minOrderAgeSeconds,
        adaptiveSpread: config.adaptiveSpread,
        adaptiveStepBps: config.adaptiveStepBps,
        targetFillsPerHour: config.targetFillsPerHour,
        targetFillsWindowMinutes: config.targetFillsWindowMinutes,
        fillDroughtMinutes: config.fillDroughtMinutes,
        edgeLookbackMinutes: config.edgeLookbackMinutes,
        edgeGoodBps: config.edgeGoodBps,
        edgeBadBps: config.edgeBadBps,
        edgeAdjustBps: config.edgeAdjustBps,
        edgeMaxSideAdjustBps: config.edgeMaxSideAdjustBps,
        maxCancelsPerHour: config.maxCancelsPerHour,
        trackPostOnlyRejects: config.trackPostOnlyRejects,
        maxUiEvents: config.maxUiEvents,
        maxEquityPoints: config.maxEquityPoints,
        equitySampleMs: config.equitySampleMs,
        persistEquitySeries: config.persistEquitySeries,
        maxApiEvents: config.maxApiEvents,
        eventDedupe: config.eventDedupe,
        requestsPerMinute: config.requestsPerMinute,
        revxApiKey: redact(config.revxApiKey),
        revxPrivateKeyBase64: config.revxPrivateKeyBase64 ? "<redacted>" : undefined,
        revxPrivateKeyPath: config.revxPrivateKeyPath ? "<configured>" : undefined
      }
    },
    "Effective config"
  );
}

function redact(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}
