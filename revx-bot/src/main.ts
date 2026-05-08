import { loadConfig } from "./config";
import { buildLogger } from "./logger";
import { getTradingTruthReporter } from "./logging/truth";
import { initNetworkTransport } from "./http/networkTransport";
import { TradingCoordinator } from "./runtime/TradingCoordinator";

async function main(): Promise<void> {
  initNetworkTransport();
  const config = loadConfig();
  const logger = buildLogger(config);
  const truthLogger = logger.child({ module: "truth" });
  getTradingTruthReporter(config, truthLogger);
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

  const coordinator = new TradingCoordinator(config, logger);
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ signal }, "Shutdown requested");
    await coordinator.stop("SHUTDOWN");
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    await coordinator.start();
  } finally {
    if (!shuttingDown) {
      await coordinator.stop("UNEXPECTED_EXIT");
    }
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
