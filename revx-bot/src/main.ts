import { loadConfig } from "./config";
import { Execution } from "./exec/Execution";
import { buildLogger } from "./logger";
import { MarketData } from "./md/MarketData";
import { Reconciler } from "./recon/Reconciler";
import { ExternalQuoteService } from "./quotes/ExternalQuoteService";
import { RevXClient } from "./revx/RevXClient";
import { RiskManager } from "./risk/RiskManager";
import { CrossVenueSignalEngine } from "./signal/CrossVenueSignalEngine";
import { NewsEngine } from "./news/NewsEngine";
import { IntelEngine } from "./intel/IntelEngine";
import { PerformanceEngine } from "./performance/PerformanceEngine";
import { SignalEngine } from "./signals/SignalEngine";
import { SignalsEngine } from "./signals/SignalsEngine";
import { createStore } from "./store/factory";
import { MakerStrategy } from "./strategy/MakerStrategy";
import { DashboardServer } from "./web/DashboardServer";
import { PolymarketEngine } from "./polymarket/PolymarketEngine";
import { Btc5mLiveRunner } from "./polymarket/live/Btc5mLiveRunner";
import { getTradingTruthReporter } from "./logging/truth";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = buildLogger(config);
  const truthLogger = logger.child({ module: "truth" });
  getTradingTruthReporter(config, truthLogger);
  const revxLogger = logger.child({ module: "revx" });
  const reconLogger = logger.child({ module: "recon" });
  const webLogger = logger.child({ module: "web" });
  const pmLogger =
    config.polymarket.enabled
      ? logger.child({ module: "polymarket" })
      : null;
  logger.info(
    {
      cwd: process.cwd(),
      runtimeBaseDir: config.runtimeBaseDir
    },
    "Resolved runtime paths"
  );
  const argvEntry = String(process.argv[1] || "");
  const runningFromDist =
    argvEntry.includes("/dist/") ||
    argvEntry.includes("\\dist\\") ||
    /[\\/]+dist[\\/]+/.test(argvEntry);
  logger.info(
    {
      runningFromDist,
      argvEntry,
      entryFilename: __filename,
      gitCommit:
        process.env.GIT_COMMIT ||
        process.env.GITHUB_SHA ||
        process.env.COMMIT_SHA ||
        null,
      polyStatusEmitter: "src/polymarket/PolymarketEngine.ts#emitPolyStatusLine"
    },
    "Build provenance"
  );

  logEffectiveConfig(logger, config);

  logger.info(
    { symbol: config.symbol, dryRun: config.dryRun, mockMode: config.mockMode },
    "Starting revx-bot"
  );

  const store = createStore(config, logger);
  store.init();

  const client = new RevXClient(config, revxLogger);
  const marketData = new MarketData(client, revxLogger);
  const externalQuoteService = new ExternalQuoteService(config, revxLogger);
  const risk = new RiskManager(config, revxLogger);
  const signalEngine = new SignalEngine(config);
  const crossVenueSignalEngine = new CrossVenueSignalEngine(config, logger);
  const newsEngine = new NewsEngine(config, logger, store);
  const signalsEngine = new SignalsEngine(config, logger, store);
  const intelEngine = new IntelEngine(config, logger, newsEngine, signalsEngine);
  const performanceEngine = config.performanceEnabled
    ? new PerformanceEngine(config, revxLogger, store, marketData)
    : undefined;
  const polyLiveRunnerMode = String(process.env.POLY_LIVE_RUNNER || "").trim().toLowerCase();
  const usePolymarketV2Runner =
    config.polymarket.enabled &&
    config.polymarket.mode === "live" &&
    polyLiveRunnerMode === "v2";
  const polymarketEngine =
    config.polymarket.enabled
      ? new PolymarketEngine(config, pmLogger ?? logger, { store })
      : undefined;
  const polymarketV2Runner =
    usePolymarketV2Runner
      ? new Btc5mLiveRunner(config, pmLogger ?? logger, { store, intelEngine, signalsEngine })
      : undefined;
  const polymarketRuntimeProvider = usePolymarketV2Runner ? polymarketV2Runner : polymarketEngine;
  const execution = new Execution(config, revxLogger, client, store, config.dryRun);
  const reconciler = new Reconciler(config, reconLogger, client, store, marketData, performanceEngine);
  const dashboard = new DashboardServer(config, webLogger, store, execution.getRunId(), {
    cancelAllBotOrders: async () => execution.cancelAllBotOrders(config.symbol)
  }, externalQuoteService, newsEngine, signalsEngine, intelEngine, performanceEngine, polymarketRuntimeProvider);
  const strategy = new MakerStrategy(
    config,
    revxLogger,
    client,
    store,
    marketData,
    execution,
    reconciler,
    risk,
    signalEngine,
    crossVenueSignalEngine,
    newsEngine,
    signalsEngine,
    intelEngine
  );
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ signal }, "Shutdown requested");

    strategy.stop();
    await polymarketV2Runner?.stop("SHUTDOWN");
    await polymarketEngine?.stop("SHUTDOWN");
    reconciler.stop();
    externalQuoteService.stop();
    newsEngine.stop();
    signalsEngine.stop();
    intelEngine.stop();
    performanceEngine?.stop();
    dashboard.stop();

    try {
      await execution.cancelAllBotOrders(config.symbol);
    } catch (error) {
      logger.error({ error }, "Failed cancelling bot orders during shutdown");
    }

    store.close();
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    dashboard.start();
    if (config.polymarket.enabled) {
      pmLogger?.warn(
        {
          enabled: config.polymarket.enabled,
          mode: config.polymarket.mode,
          fetchEnabled: config.polymarket.fetchEnabled,
          liveConfirmed: config.polymarket.liveConfirmed,
          liveExecutionEnabled: config.polymarket.liveExecutionEnabled,
          killSwitch: config.polymarket.killSwitch,
          seedSeriesPrefix: config.polymarket.marketQuery.seedSeriesPrefix || null,
          seedEventSlugs: config.polymarket.marketQuery.seedEventSlugs,
          sizing: config.polymarket.sizing,
          risk: config.polymarket.risk,
          cancelAllOnStart: config.polymarket.execution.cancelAllOnStart,
          paperForceTrade: config.polymarket.paper.forceTrade,
          paperForceIntervalSec: config.polymarket.paper.forceIntervalSec,
          paperForceNotional: config.polymarket.paper.forceNotional
        },
        "Polymarket enabled in combined runtime"
      );
    }
    if (config.polymarket.enabled) {
      // Start Polymarket on its own async loop; never block RevX strategy cycle startup.
      if (usePolymarketV2Runner) {
        pmLogger?.warn(
          { liveRunner: "v2", mode: config.polymarket.mode },
          "POLY_LIVE_RUNNER=v2 enabled; legacy PolymarketEngine live entry loop disabled"
        );
        void polymarketV2Runner?.start().catch((error) => {
          pmLogger?.error({ error }, "Polymarket v2 live runner failed to start");
          void shutdown("POLY_V2_STARTUP_FAILED", 1);
        });
      } else {
        void polymarketEngine?.start().catch((error) => {
          pmLogger?.error({ error }, "Polymarket engine failed to start in combined runtime");
        });
      }
    }
    externalQuoteService.start();
    newsEngine.start();
    signalsEngine.start();
    intelEngine.start();
    performanceEngine?.start();
    reconciler.start();
    await strategy.start();
  } finally {
    if (!shuttingDown) {
      logger.error("Main loop exited without SIGINT/SIGTERM; stopping Polymarket with UNEXPECTED_EXIT");
    }
    await polymarketV2Runner?.stop(shuttingDown ? "SHUTDOWN" : "UNEXPECTED_EXIT");
    await polymarketEngine?.stop(shuttingDown ? "SHUTDOWN" : "UNEXPECTED_EXIT");
    externalQuoteService.stop();
    newsEngine.stop();
    signalsEngine.stop();
    intelEngine.stop();
    performanceEngine?.stop();
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
        debugHttp: config.debugHttp,
        logLevel: config.logLevel,
        logVerbosity: config.logVerbosity,
        logModules: config.logModules,
        truthIntervalMs: config.truthIntervalMs,
        strictSanityCheck: config.strictSanityCheck,
        disableFillsReconcile: config.disableFillsReconcile,
        storeBackend: config.storeBackend,
        refreshSeconds: config.refreshSeconds,
        reconcileSeconds: config.reconcileSeconds,
        reconcileTimeoutMs: config.reconcileTimeoutMs,
        levels: config.levels,
        levelQuoteSizeUsd: config.levelQuoteSizeUsd,
        enableTopOfBook: config.enableTopOfBook,
        tobQuoteSizeUsd: config.tobQuoteSizeUsd,
        seedMaxSeconds: config.seedMaxSeconds,
        seedMaxReposts: config.seedMaxReposts,
        seedTakerUsd: config.seedTakerUsd,
        seedTakerSlippageBps: config.seedTakerSlippageBps,
        seedForceTob: config.seedForceTob,
        seedHalfSpreadBps: config.seedHalfSpreadBps,
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
        signalRefreshMs: config.signalRefreshMs,
        signalMaxQuoteAgeMs: config.signalMaxQuoteAgeMs,
        signalMinConf: config.signalMinConf,
        signalUsdtDegrade: config.signalUsdtDegrade,
        signalVenues: config.signalVenues,
        enableCrossVenueSignals: config.enableCrossVenueSignals,
        venueRefreshMs: config.venueRefreshMs,
        venueStaleMs: config.venueStaleMs,
        venueTimeoutMs: config.venueTimeoutMs,
        venueMaxBackoffMs: config.venueMaxBackoffMs,
        fairDriftMaxBps: config.fairDriftMaxBps,
        fairBasisMaxBps: config.fairBasisMaxBps,
        fairStaleMs: config.fairStaleMs,
        fairMinVenues: config.fairMinVenues,
        fairMaxDispersionBps: config.fairMaxDispersionBps,
        fairMaxBasisBps: config.fairMaxBasisBps,
        toxicDriftBps: config.toxicDriftBps,
        makerFeeBps: config.makerFeeBps,
        takerFeeBps: config.takerFeeBps,
        minMakerEdgeBps: config.minMakerEdgeBps,
        minRealizedEdgeBps: config.minRealizedEdgeBps,
        minTakerEdgeBps: config.minTakerEdgeBps,
        enableAdverseSelectionLoop: config.enableAdverseSelectionLoop,
        asHorizonSeconds: config.asHorizonSeconds,
        asSampleFills: config.asSampleFills,
        asBadAvgBps: config.asBadAvgBps,
        asBadRate: config.asBadRate,
        asBadFillBps: config.asBadFillBps,
        asWidenStepBps: config.asWidenStepBps,
        asMaxWidenBps: config.asMaxWidenBps,
        asDisableTobOnToxic: config.asDisableTobOnToxic,
        asCooldownSeconds: config.asCooldownSeconds,
        asReduceLevelsOnToxic: config.asReduceLevelsOnToxic,
        asLevelsFloor: config.asLevelsFloor,
        asDecayBpsPerMin: config.asDecayBpsPerMin,
        adverseEnabled: config.adverseEnabled,
        adverseMarkoutWindowsMs: config.adverseMarkoutWindowsMs,
        adverseToxicMarkoutBps: config.adverseToxicMarkoutBps,
        adverseMinFills: config.adverseMinFills,
        adverseDecay: config.adverseDecay,
        adverseStateThresholdsCsv: config.adverseStateThresholdsCsv,
        adverseMaxSpreadMult: config.adverseMaxSpreadMult,
        edgeSafetyBps: config.edgeSafetyBps,
        hotVolBps: config.hotVolBps,
        forceBaselineWhenOverCap: config.forceBaselineWhenOverCap,
        venueWeights: config.venueWeights,
        seedEnabled: config.seedEnabled,
        enableTakerSeed: config.enableTakerSeed,
        seedTakerMaxUsd: config.seedTakerMaxUsd,
        seedTakerMaxSlippageBps: config.seedTakerMaxSlippageBps,
        hedgeEnabled: config.hedgeEnabled,
        hedgeMaxUsdPerMin: config.hedgeMaxUsdPerMin,
        hedgeMaxSlippageBps: config.hedgeMaxSlippageBps,
        hedgeOnlyWhenConfident: config.hedgeOnlyWhenConfident,
        newsEnabled: config.newsEnabled,
        newsRefreshMs: config.newsRefreshMs,
        newsMaxItems: config.newsMaxItems,
        newsHalfLifeMs: config.newsHalfLifeMs,
        newsMinConf: config.newsMinConf,
        newsPauseImpact: config.newsPauseImpact,
        newsPauseSeconds: config.newsPauseSeconds,
        newsSpreadMult: config.newsSpreadMult,
        newsSizeCutMult: config.newsSizeCutMult,
        newsSourcesRss: config.newsSourcesRss,
        newsGdeltQuery: config.newsGdeltQuery,
        newsApiKey: config.newsApiKey ? "<configured>" : undefined,
        signalsEnabled: config.signalsEnabled,
        signalsNewsRefreshMs: config.signalsNewsRefreshMs,
        signalsMacroEnabled: config.signalsMacroEnabled,
        signalsMacroRefreshMs: config.signalsMacroRefreshMs,
        signalsSystemRefreshMs: config.signalsSystemRefreshMs,
        signalsMaxItems: config.signalsMaxItems,
        signalsHalfLifeMs: config.signalsHalfLifeMs,
        signalsMinConf: config.signalsMinConf,
        signalsPauseImpact: config.signalsPauseImpact,
        signalsPauseSeconds: config.signalsPauseSeconds,
        signalsSpreadMult: config.signalsSpreadMult,
        signalsSizeCutMult: config.signalsSizeCutMult,
        signalsRssUrls: config.signalsRssUrls,
        signalsGdeltQuery: config.signalsGdeltQuery,
        signalsMacroUrl: config.signalsMacroUrl,
        signalsLlmEnabled: config.signalsLlmEnabled,
        openAiApiKey: config.openAiApiKey ? "<configured>" : undefined,
        polymarket: {
          enabled: config.polymarket.enabled,
          mode: config.polymarket.mode,
          fetchEnabled: config.polymarket.fetchEnabled,
          liveConfirmed: config.polymarket.liveConfirmed,
          liveExecutionEnabled: config.polymarket.liveExecutionEnabled,
          killSwitch: config.polymarket.killSwitch,
          loopMs: config.polymarket.loopMs,
          marketQuery: config.polymarket.marketQuery,
          threshold: config.polymarket.threshold,
          sizing: config.polymarket.sizing,
          risk: config.polymarket.risk,
          http: config.polymarket.http,
          authEnv: {
            apiKeyEnv: config.polymarket.auth.apiKeyEnv,
            apiSecretEnv: config.polymarket.auth.apiSecretEnv,
            legacySecretEnv: config.polymarket.auth.legacySecretEnv,
            passphraseEnv: config.polymarket.auth.passphraseEnv,
            privateKeyEnv: config.polymarket.auth.privateKeyEnv,
            funderEnv: config.polymarket.auth.funderEnv,
            chainIdEnv: config.polymarket.auth.chainIdEnv,
            networkEnv: config.polymarket.auth.networkEnv
          },
          authConfigured: Boolean(config.polymarket.auth.apiKey),
          funderConfigured: Boolean(config.polymarket.auth.funder),
          privateKeyConfigured: Boolean(config.polymarket.auth.privateKey),
          autoDeriveApiKey: config.polymarket.auth.autoDeriveApiKey,
          signatureType: config.polymarket.auth.signatureType,
          chainId: config.polymarket.auth.chainId,
          network: config.polymarket.auth.network,
          baseUrls: config.polymarket.baseUrls,
          paper: config.polymarket.paper
        },
        maxUiEvents: config.maxUiEvents,
        maxSignalPoints: config.maxSignalPoints,
        maxEquityPoints: config.maxEquityPoints,
        equitySampleMs: config.equitySampleMs,
        persistEquitySeries: config.persistEquitySeries,
        maxApiEvents: config.maxApiEvents,
        eventDedupe: config.eventDedupe,
        externalVenues: config.externalVenues,
        externalQuotesRefreshSeconds: config.externalQuotesRefreshSeconds,
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
