import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

dotenv.config();

const RUNTIME_BASE_DIR = resolveRuntimeBaseDir(process.env.REVX_RUNTIME_DIR);

export type BotConfig = {
  revxApiKey: string;
  revxPrivateKeyBase64?: string;
  revxPrivateKeyPath?: string;
  mockMode: boolean;
  revxBaseUrl: string;
  symbol: string;

  cashReserveUsd: number;
  workingCapUsd: number;
  quoteSizeUsd: number;
  halfSpreadBps: number;
  refreshSeconds: number;
  repriceMoveBps: number;
  maxInventoryUsd: number;
  pauseVolMoveBps: number;
  pauseVolWindowSeconds: number;
  maxConsecutiveErrors: number;
  pnlDailyStopUsd: number;

  levels: number;
  levelQuoteSizeUsd: number;
  baseHalfSpreadBps: number;
  levelStepBps: number;
  queueRefreshSeconds: number;
  minInsideSpreadBps: number;
  minVolMoveBpsToQuote: number;
  volProtectMode: "block" | "widen";
  volWidenMultMin: number;
  volWidenMultMax: number;
  volWidenInCalm: boolean;
  volWidenMultCalm: number;
  volWindowSeconds: number;
  volPauseBps: number;
  volSpreadMultMin: number;
  volSpreadMultMax: number;
  minHalfSpreadBps: number;
  maxHalfSpreadBps: number;
  calmVolBps: number;
  adaptiveSpread: boolean;
  adaptiveStepBps: number;
  targetFillsPerHour: number;
  targetFillsWindowMinutes: number;
  fillDroughtMinutes: number;
  edgeLookbackMinutes: number;
  edgeGoodBps: number;
  edgeBadBps: number;
  edgeAdjustBps: number;
  edgeMaxSideAdjustBps: number;
  enableTopOfBook: boolean;
  tobQuoteSizeUsd: number;
  tobMaxVolBps: number;
  tobQuoteSizeUsdNormal: number;
  seedMaxSeconds: number;
  seedMaxReposts: number;
  seedTakerUsd: number;
  seedTakerSlippageBps: number;
  seedForceTob: boolean;
  seedHalfSpreadBps: number;
  tobMaxInventoryRatioForBoth: number;
  tobMaxInventoryRatioForOneSided: number;
  sellThrottleBelowLowGate: boolean;
  minSellLevelsBelowLowGate: number;
  sellDisableBelowNotionalUsd: number;
  trackPostOnlyRejects: boolean;
  maxCancelsPerHour: number;
  signalEnabled: boolean;
  signalMaxSkewBps: number;
  signalZscoreToSkew: number;
  signalDriftToSkew: number;
  signalCalmTighten: number;
  signalHotWiden: number;
  signalHotRegimeMultiplier: number;
  signalTopOfBookOnlyInCalm: boolean;
  signalLevelsInHot: number;
  signalRefreshMs: number;
  signalMaxQuoteAgeMs: number;
  signalMinConf: number;
  signalUsdtDegrade: number;
  signalVenues: string[];
  enableCrossVenueSignals: boolean;
  venueRefreshMs: number;
  venueStaleMs: number;
  venueTimeoutMs: number;
  venueMaxBackoffMs: number;
  fairDriftMaxBps: number;
  fairBasisMaxBps: number;
  fairStaleMs: number;
  fairMinVenues: number;
  fairMaxDispersionBps: number;
  fairMaxBasisBps: number;
  toxicDriftBps: number;
  makerFeeBps: number;
  takerFeeBps: number;
  takerSlipBps: number;
  takerSafetyBps: number;
  minMakerEdgeBps: number;
  minRealizedEdgeBps: number;
  minTakerEdgeBps: number;
  enableAdverseSelectionLoop: boolean;
  asHorizonSeconds: number;
  asSampleFills: number;
  asBadAvgBps: number;
  asBadRate: number;
  asBadFillBps: number;
  asWidenStepBps: number;
  asMaxWidenBps: number;
  asDisableTobOnToxic: boolean;
  asCooldownSeconds: number;
  asReduceLevelsOnToxic: boolean;
  asLevelsFloor: number;
  asDecayBpsPerMin: number;
  adverseEnabled: boolean;
  adverseMarkoutWindowsMs: number[];
  adverseToxicMarkoutBps: number;
  adverseMinFills: number;
  adverseDecay: number;
  adverseStateThresholdsCsv: string;
  adverseMaxSpreadMult: number;
  edgeSafetyBps: number;
  hotVolBps: number;
  venueWeights: Record<"coinbase" | "binance" | "kraken", number>;
  seedEnabled: boolean;
  enableTakerSeed: boolean;
  seedTakerMaxUsd: number;
  seedTakerMaxSlippageBps: number;
  seedBuyUsd: number;
  maxSeedBuyUsd: number;
  seedTargetBtcNotionalUsd: number;
  hedgeEnabled: boolean;
  hedgeMaxUsdPerMin: number;
  hedgeMaxSlippageBps: number;
  hedgeOnlyWhenConfident: boolean;
  newsEnabled: boolean;
  newsRefreshMs: number;
  newsMaxItems: number;
  newsHalfLifeMs: number;
  newsMinConf: number;
  newsPauseImpact: number;
  newsPauseSeconds: number;
  newsSpreadMult: number;
  newsSizeCutMult: number;
  intelNewsMaxPosture: "NORMAL" | "CAUTION";
  intelNewsAllowSideBlocks: boolean;
  intelNewsMaxSpreadMult: number;
  intelNewsMinSizeMult: number;
  newsSourcesRss: string[];
  newsGdeltQuery: string;
  newsApiKey?: string;
  enableFairPrice: boolean;
  fairPriceMinVenues: number;
  fairPriceMaxStaleMs: number;
  fairPriceUsdtPenaltyBps: number;
  enableAdverse: boolean;
  enableIntel: boolean;
  intelHardHaltOnly: boolean;
  enableIntelTradeGuard: boolean;
  intelMaxAction: "soften" | "halt";
  intelCrossvenueAction: "soften" | "ignore" | "halt";
  intelProviderDegradedAction: "ignore" | "soften" | "halt";
  intelFastPollSeconds: number;
  intelSlowPollSeconds: number;
  intelMaxItems: number;
  intelDedupeWindowMin: number;
  intelDedupeWindowSeconds: number;
  intelItemTtlSeconds: number;
  intelStaleSeconds: number;
  intelProviderMinOk: number;
  intelSoftPauseImpact: number;
  intelSoftPauseConf: number;
  intelHardHaltImpact: number;
  intelPauseImpactThreshold: number;
  intelPauseConfidenceThreshold: number;
  intelPausePersistenceSeconds: number;
  intelAlwaysOn: boolean;
  intelMinQuoteLevels: number;
  intelMinSizeMult: number;
  intelMaxSpreadMult: number;
  quotingMinLevelsFloorEnabled: boolean;
  quotingMinLevelsFloorBuy: number;
  quotingMinLevelsFloorSell: number;
  quotingMinVolMoveBpsForExtraWidening: number;
  quotingLowVolMode: "KEEP_QUOTING";
  quotingForceBaselineWhenEnabled: boolean;
  quotingBaselineNotionalUsd: number;
  quotingMinNotionalUsd: number;
  shockEnterBps: number;
  shockSpreadBps: number;
  shockDispersionBps: number;
  shockPriceGapBps: number;
  shockAdverseToxicity: number;
  shockMinSeconds: number;
  shockCooldownVolBps: number;
  shockReentryPersistSeconds: number;
  reentryNoNewLowSeconds: number;
  recoveryDispersionBps: number;
  recoveryPersistSeconds: number;
  inventoryTargetBtcNotionalUsd: number;
  inventoryFloorBtcNotionalUsd: number;
  inventoryCapBtcNotionalUsd: number;
  phaseAwareMaxSellUsdPerHour: number;
  enableTakerReentry: boolean;
  maxTakerReentryUsdPerHour: number;
  reentryMinEdgeOverFeesBps: number;
  btcFloorNotionalUsd: number;
  reentryBtcTargetNotionalUsd: number;
  hardHaltStaleMarketDataSeconds: number;
  fatal5xxWindowMinutes: number;
  fatal5xxThreshold: number;
  intelHeadlineMaxAgeSeconds: number;
  intelAnomalyMaxAgeSeconds: number;
  intelEventCooldownSeconds: number;
  intelMaxHighImpactPerMinute: number;
  enableGdelt: boolean;
  enableRss: boolean;
  enableCryptopanic: boolean;
  enableNewsapi: boolean;
  enableX: boolean;
  gdeltQuery: string;
  gdeltMaxArticles: number;
  rssUrls: string[];
  cryptopanicToken?: string;
  xBearerToken?: string;
  xQuery: string;
  xMaxResultsPerPoll: number;
  intelMaxWidenBps: number;
  intelMaxSizeCut: number;
  intelMaxSkewBps: number;
  intelHaltImpact: number;
  intelHaltSeconds: number;
  intelDecayMinutes: number;
  uiShowDiagnosticsDrawer: boolean;
  uiDiagnosticsDefaultOpen: boolean;
  uiHeaderMaxRows: number;
  signalsEnabled: boolean;
  signalsNewsRefreshMs: number;
  signalsMacroEnabled: boolean;
  signalsMacroRefreshMs: number;
  signalsSystemRefreshMs: number;
  signalsMaxItems: number;
  signalsHalfLifeMs: number;
  signalsMinConf: number;
  signalsPauseImpact: number;
  signalsPauseSeconds: number;
  signalsSpreadMult: number;
  signalsSizeCutMult: number;
  signalsRssUrls: string[];
  signalsGdeltQuery: string;
  signalsMacroUrl?: string;
  signalsLlmEnabled: boolean;
  openAiApiKey?: string;
  trendWindowSeconds: number;
  trendPauseBps: number;
  trendSkewBps: number;
  trendProtectionMode: "spread" | "reduce_level";
  dynamicTargetBtc: boolean;
  dynamicTargetBufferUsd: number;
  targetBtcNotionalUsd: number;
  maxBtcNotionalUsd: number;
  skewMaxBps: number;
  minQuoteSizeUsd: number;
  maxDistanceFromTobBps: number;
  minOrderAgeSeconds: number;
  quoteRefreshSeconds: number;
  pauseSecondsOnVol: number;
  maxActiveOrders: number;
  cancelRetry: number;
  placeRetry: number;
  metricsLogEverySeconds: number;
  maxActionsPerLoop: number;
  pendingStaleSeconds: number;
  balanceRefreshSeconds: number;
  balanceReserveBtc: number;
  balanceDustBtc: number;
  performanceEnabled: boolean;
  adaptiveControllerEnabled: boolean;
  adaptiveControllerIntervalSeconds: number;
  adaptiveFillsPerHourMin: number;
  adaptiveToxicPctMax: number;
  adaptiveAvgToxBpsMin: number;
  adaptiveNetPnlStopLoss24h: number;

  runtimeBaseDir: string;
  dryRun: boolean;

  dbPath: string;
  storeBackend: "json" | "sqlite";
  debugBalances: boolean;
  logLevel: string;
  requestsPerMinute: number;
  reconcileSeconds: number;
  dashboardEnabled: boolean;
  dashboardPort: number;
  externalVenues: string[];
  externalQuotesRefreshSeconds: number;
  maxUiEvents: number;
  maxSignalPoints: number;
  maxEquityPoints: number;
  equitySampleMs: number;
  persistEquitySeries: boolean;
  maxApiEvents: number;
  eventDedupe: boolean;
  envFilePath: string;
};

let warnedEnvDuplicates = false;

export function loadConfig(): BotConfig {
  const envFilePath = withDefault("ENV_FILE_PATH", ".env");
  if (!warnedEnvDuplicates) {
    warnDuplicateEnvKeys(envFilePath);
    warnedEnvDuplicates = true;
  }

  const dryRun = boolWithDefault("DRY_RUN", true);
  const revxApiKey = optional("REVX_API_KEY");
  const revxPrivateKeyBase64 = optional("REVX_PRIVATE_KEY_BASE64");
  const revxPrivateKeyPath = optional("REVX_PRIVATE_KEY_PATH");
  const mockMode = dryRun && (!revxApiKey || (!revxPrivateKeyBase64 && !revxPrivateKeyPath));

  if (!mockMode) {
    if (!revxApiKey) {
      throw new Error("REVX_API_KEY is required");
    }
    if (!isValidRevxApiKey(revxApiKey)) {
      throw new Error(
        "REVX_API_KEY format invalid. Expected 64 alphanumeric characters or base64 token (no angle-bracket placeholders)."
      );
    }
    if (!revxPrivateKeyBase64 && !revxPrivateKeyPath) {
      throw new Error("Set REVX_PRIVATE_KEY_BASE64 or REVX_PRIVATE_KEY_PATH");
    }
  }

  const levels = clampInt(numberWithDefault("LEVELS", 2), 1, 3);
  const levelQuoteSizeUsd = clampNumber(
    numberWithFallback(["LEVEL_QUOTE_SIZE_USD", "QUOTE_SIZE_USD"], 8),
    1,
    200
  );
  const baseHalfSpreadBps = clampNumber(
    numberWithFallback(["BASE_HALF_SPREAD_BPS", "HALF_SPREAD_BPS"], 18),
    2,
    80
  );
  const levelStepBps = clampNumber(numberWithDefault("LEVEL_STEP_BPS", 10), 1, 80);
  const refreshSeconds = clampNumber(numberWithDefault("REFRESH_SECONDS", 2), 1, 15);
  const repriceMoveBps = clampNumber(numberWithDefault("REPRICE_MOVE_BPS", 10), 1, 50);
  const queueRefreshSeconds = clampNumber(numberWithDefault("QUEUE_REFRESH_SECONDS", 90), 5, 300);

  const minInsideSpreadBps = clampNumber(
    numberWithFallback(["MIN_INSIDE_SPREAD_BPS", "MIN_MARKET_SPREAD_BPS"], 0.5),
    0.1,
    40
  );
  const minVolMoveBpsToQuote = clampNumber(numberWithDefault("MIN_VOL_MOVE_BPS_TO_QUOTE", 5), 0, 200);
  const volProtectMode = parseVolProtectMode(optional("VOL_PROTECT_MODE"));
  const volWidenMultMin = clampNumber(numberWithDefault("VOL_WIDEN_MULT_MIN", 1.25), 1, 4);
  const volWidenMultMax = clampNumber(numberWithDefault("VOL_WIDEN_MULT_MAX", 1.75), 1, 6);
  const volWidenInCalm = boolWithDefault("VOL_WIDEN_IN_CALM", false);
  const volWidenMultCalm = clampNumber(numberWithDefault("VOL_WIDEN_MULT_CALM", 1.10), 1, 3);
  const volWindowSeconds = clampNumber(
    numberWithFallback(["VOL_WINDOW_SECONDS", "PAUSE_VOL_WINDOW_SECONDS"], 60),
    10,
    600
  );
  const volPauseBps = clampNumber(
    numberWithFallback(["VOL_PAUSE_BPS", "PAUSE_VOL_MOVE_BPS"], 70),
    10,
    500
  );
  const volSpreadMultMin = clampNumber(numberWithDefault("VOL_SPREAD_MULT_MIN", 1.0), 0.5, 2.5);
  const volSpreadMultMax = clampNumber(numberWithDefault("VOL_SPREAD_MULT_MAX", 2.2), 1, 4);
  const minHalfSpreadBps = clampNumber(numberWithDefault("MIN_HALF_SPREAD_BPS", 4), 2, 60);
  const maxHalfSpreadBps = clampNumber(numberWithDefault("MAX_HALF_SPREAD_BPS", 20), 2, 80);
  const calmVolBps = clampNumber(numberWithDefault("CALM_VOL_BPS", 8), 0, 200);
  const adaptiveSpread = boolWithDefault("ADAPTIVE_SPREAD", true);
  const adaptiveStepBps = clampNumber(numberWithDefault("ADAPTIVE_STEP_BPS", 1), 0, 10);
  const targetFillsPerHour = clampInt(numberWithDefault("TARGET_FILLS_PER_HOUR", 3), 0, 100);
  const targetFillsWindowMinutes = clampInt(numberWithDefault("TARGET_FILLS_WINDOW_MINUTES", 60), 5, 240);
  const fillDroughtMinutes = clampInt(numberWithDefault("FILL_DROUGHT_MINUTES", 30), 5, 180);
  const edgeLookbackMinutes = clampInt(numberWithDefault("EDGE_LOOKBACK_MINUTES", 60), 5, 240);
  const edgeGoodBps = clampNumber(numberWithDefault("EDGE_GOOD_BPS", 8), -100, 200);
  const edgeBadBps = clampNumber(numberWithDefault("EDGE_BAD_BPS", 0), -200, 100);
  const edgeAdjustBps = clampNumber(numberWithDefault("EDGE_ADJUST_BPS", 2), 0, 20);
  const edgeMaxSideAdjustBps = clampNumber(numberWithDefault("EDGE_MAX_SIDE_ADJUST_BPS", 6), 0, 30);
  const enableTopOfBook = boolWithDefault("ENABLE_TOPOFBOOK", false);
  const tobQuoteSizeUsd = clampNumber(numberWithDefault("TOB_QUOTE_SIZE_USD", 3), 1, 200);
  const tobMaxVolBps = clampNumber(numberWithDefault("TOB_MAX_VOL_BPS", 35), 1, 400);
  const tobQuoteSizeUsdNormal = clampNumber(numberWithDefault("TOB_QUOTE_SIZE_USD_NORMAL", 3), 1, 200);
  const seedMaxSeconds = clampInt(numberWithDefault("SEED_MAX_SECONDS", 120), 10, 3_600);
  const seedMaxReposts = clampInt(
    numberWithFallback(["SEED_MAX_REPOSTS", "SEED_MAX_TOB_REPOSTS"], 10),
    1,
    500
  );
  const seedTakerUsd = clampNumber(numberWithDefault("SEED_TAKER_USD", 12), 1, 500);
  const seedTakerSlippageBps = clampNumber(
    numberWithDefault("SEED_TAKER_SLIPPAGE_BPS", 5),
    0.1,
    100
  );
  const seedForceTob = boolWithDefault("SEED_FORCE_TOB", true);
  const seedHalfSpreadBps = clampNumber(numberWithDefault("SEED_HALF_SPREAD_BPS", 2.5), 0.1, 50);
  const tobMaxInventoryRatioForBoth = clampNumber(
    numberWithDefault("TOB_MAX_INVENTORY_RATIO_FOR_BOTH", 0.25),
    0,
    1
  );
  const tobMaxInventoryRatioForOneSided = clampNumber(
    numberWithDefault("TOB_MAX_INVENTORY_RATIO_FOR_ONE_SIDED", 0.6),
    0,
    1
  );
  const sellThrottleBelowLowGate = boolWithDefault("SELL_THROTTLE_BELOW_LOWGATE", true);
  const minSellLevelsBelowLowGate = clampInt(numberWithDefault("MIN_SELL_LEVELS_BELOW_LOWGATE", 1), 0, 3);
  const sellDisableBelowNotionalUsd = clampNumber(
    numberWithDefault("SELL_DISABLE_BELOW_NOTIONAL_USD", 10),
    0,
    10_000
  );
  const trackPostOnlyRejects = boolWithDefault("TRACK_POSTONLY_REJECTS", true);
  const maxCancelsPerHour = clampInt(numberWithDefault("MAX_CANCELS_PER_HOUR", 200), 10, 5_000);
  const signalEnabled = boolWithFallback(
    ["SIGNALS_ENABLED", "SIGNAL_ENABLED", "ENABLE_SIGNALS"],
    true
  );
  const signalMaxSkewBps = clampNumber(numberWithDefault("SIGNAL_MAX_SKEW_BPS", 10), 0, 50);
  const signalZscoreToSkew = clampNumber(numberWithDefault("SIGNAL_ZSCORE_TO_SKEW", 4), 0, 20);
  const signalDriftToSkew = clampNumber(numberWithDefault("SIGNAL_DRIFT_TO_SKEW", 0.25), 0, 5);
  const signalCalmTighten = clampNumber(numberWithDefault("SIGNAL_CALM_TIGHTEN", 0.9), 0.5, 1.2);
  const signalHotWiden = clampNumber(numberWithDefault("SIGNAL_HOT_WIDEN", 1.2), 1, 3);
  const signalHotRegimeMultiplier = clampNumber(
    numberWithDefault("SIGNAL_HOT_REGIME_MULTIPLIER", 2.5),
    1.1,
    8
  );
  const signalTopOfBookOnlyInCalm = boolWithDefault("SIGNAL_TOPOFBOOK_ONLY_IN_CALM", true);
  const signalLevelsInHot = clampInt(numberWithDefault("SIGNAL_LEVELS_IN_HOT", 1), 0, 3);
  const signalRefreshMs = clampInt(numberWithDefault("SIGNAL_REFRESH_MS", 1500), 250, 10_000);
  const signalMaxQuoteAgeMs = clampInt(numberWithDefault("SIGNAL_MAX_QUOTE_AGE_MS", 4500), 500, 60_000);
  const signalMinConf = clampNumber(numberWithDefault("SIGNAL_MIN_CONF", 0.55), 0, 1);
  const signalUsdtDegrade = clampNumber(numberWithDefault("SIGNAL_USDT_DEGRADE", 0.03), 0, 0.25);
  const signalVenues = parseCsvList(optional("SIGNAL_VENUES"));
  const enableCrossVenueSignals = boolWithDefault("ENABLE_CROSS_VENUE_SIGNALS", true);
  const venueRefreshMs = clampInt(numberWithFallback(["VENUE_REFRESH_MS", "SIGNAL_REFRESH_MS"], 1000), 250, 10_000);
  const venueStaleMs = clampInt(numberWithDefault("VENUE_STALE_MS", 5000), 500, 60_000);
  const venueTimeoutMs = clampInt(numberWithDefault("VENUE_TIMEOUT_MS", 1200), 200, 10_000);
  const venueMaxBackoffMs = clampInt(numberWithDefault("VENUE_MAX_BACKOFF_MS", 30_000), 1000, 300_000);
  const fairDriftMaxBps = clampNumber(numberWithDefault("FAIR_DRIFT_MAX_BPS", 8), 0, 100);
  const fairBasisMaxBps = clampNumber(numberWithDefault("FAIR_BASIS_MAX_BPS", 10), 0, 100);
  const fairStaleMs = clampInt(numberWithFallback(["FAIR_STALE_MS", "SIGNAL_MAX_QUOTE_AGE_MS"], 2500), 250, 60_000);
  const fairMinVenues = clampInt(numberWithDefault("FAIR_MIN_VENUES", 3), 1, 20);
  const fairMaxDispersionBps = clampNumber(numberWithDefault("FAIR_MAX_DISPERSION_BPS", 10), 0.1, 500);
  const fairMaxBasisBps = clampNumber(numberWithDefault("FAIR_MAX_BASIS_BPS", 12), 0.1, 500);
  const toxicDriftBps = clampNumber(numberWithDefault("TOXIC_DRIFT_BPS", 12), 0.1, 500);
  const makerFeeBps = clampNumber(numberWithFallback(["MAKER_FEE_BPS", "FEES_MAKER_BPS"], 0), 0, 50);
  const takerFeeBps = clampNumber(numberWithFallback(["TAKER_FEE_BPS", "FEES_TAKER_BPS"], 9), 0, 100);
  const takerSlipBps = clampNumber(numberWithDefault("TAKER_SLIP_BPS", 6), 0, 200);
  const takerSafetyBps = clampNumber(numberWithDefault("TAKER_SAFETY_BPS", 4), 0, 200);
  const minMakerEdgeBps = clampNumber(numberWithDefault("MIN_MAKER_EDGE_BPS", 0.2), 0, 100);
  const minRealizedEdgeBps = clampNumber(numberWithDefault("MIN_REALIZED_EDGE_BPS", 4), -500, 500);
  const minTakerEdgeBps = clampNumber(numberWithDefault("MIN_TAKER_EDGE_BPS", 14), -500, 500);
  const enableAdverseSelectionLoop = boolWithDefault("ENABLE_ADVERSE_SELECTION_LOOP", true);
  const asHorizonSeconds = clampInt(numberWithDefault("AS_HORIZON_SECONDS", 10), 1, 300);
  const asSampleFills = clampInt(numberWithDefault("AS_SAMPLE_FILLS", 60), 1, 2000);
  const asBadAvgBps = clampNumber(numberWithDefault("AS_BAD_AVG_BPS", 4), 0, 500);
  const asBadRate = clampNumber(numberWithDefault("AS_BAD_RATE", 0.55), 0, 1);
  const asBadFillBps = clampNumber(numberWithDefault("AS_BAD_FILL_BPS", -6), -1000, 1000);
  const asWidenStepBps = clampNumber(numberWithDefault("AS_WIDEN_STEP_BPS", 2), 0, 500);
  const asMaxWidenBps = clampNumber(numberWithDefault("AS_MAX_WIDEN_BPS", 10), 0, 500);
  const asDisableTobOnToxic = boolWithDefault("AS_DISABLE_TOB_ON_TOXIC", true);
  const asCooldownSeconds = clampInt(numberWithDefault("AS_COOLDOWN_SECONDS", 120), 1, 3600);
  const asReduceLevelsOnToxic = boolWithDefault("AS_REDUCE_LEVELS_ON_TOXIC", true);
  const asLevelsFloor = clampInt(numberWithDefault("AS_LEVELS_FLOOR", 1), 0, 10);
  const asDecayBpsPerMin = clampNumber(numberWithDefault("AS_DECAY_BPS_PER_MIN", 1), 0, 100);
  const adverseEnabled = boolWithDefault("ADVERSE_ENABLED", true);
  const adverseMarkoutWindowsMs = parseNumberCsv(
    optional("ADVERSE_MARKOUT_WINDOWS_MS"),
    [5000, 15000, 60000]
  )
    .map((value) => Math.max(1000, Math.floor(value)))
    .slice(0, 8);
  const adverseToxicMarkoutBps = clampNumber(numberWithDefault("ADVERSE_TOXIC_MARKOUT_BPS", -4), -100, 100);
  const adverseMinFills = clampInt(numberWithDefault("ADVERSE_MIN_FILLS", 3), 1, 100);
  const adverseDecay = clampNumber(numberWithDefault("ADVERSE_DECAY", 0.9), 0.5, 0.999);
  const adverseStateThresholdsCsv = withDefault("ADVERSE_STATE_THRESHOLDS", "0.35,0.55,0.75,0.90");
  const adverseMaxSpreadMult = clampNumber(numberWithDefault("ADVERSE_MAX_SPREAD_MULT", 2.25), 1, 5);
  const edgeSafetyBps = clampNumber(numberWithDefault("EDGE_SAFETY_BPS", 1.2), 0, 50);
  const hotVolBps = clampNumber(numberWithDefault("HOT_VOL_BPS", 35), calmVolBps, 500);
  const venueWeights = parseVenueWeights(optional("VENUE_WEIGHTS_JSON"));
  const seedEnabled = boolWithDefault("SEED_ENABLED", true);
  const enableTakerSeed = boolWithDefault("ENABLE_TAKER_SEED", false);
  const seedTakerMaxUsd = clampNumber(numberWithDefault("SEED_TAKER_MAX_USD", 15), 1, 1000);
  const seedTakerMaxSlippageBps = clampNumber(numberWithDefault("SEED_TAKER_MAX_SLIPPAGE_BPS", 6), 0.1, 100);
  const seedBuyUsd = clampNumber(numberWithDefault("SEED_BUY_USD", 10), 0.01, 10_000);
  const maxSeedBuyUsd = clampNumber(
    numberWithDefault("MAX_SEED_BUY_USD", Math.max(seedBuyUsd, 20)),
    Math.max(0.01, seedBuyUsd),
    10_000
  );
  const seedTargetBtcNotionalUsd = clampNumber(
    numberWithDefault("SEED_TARGET_BTC_NOTIONAL_USD", 75),
    0.01,
    1_000_000
  );
  const hedgeEnabled = boolWithDefault("HEDGE_ENABLED", true);
  const hedgeMaxUsdPerMin = clampNumber(numberWithDefault("HEDGE_MAX_USD_PER_MIN", 30), 0, 10_000);
  const hedgeMaxSlippageBps = clampNumber(numberWithDefault("HEDGE_MAX_SLIPPAGE_BPS", 8), 0.1, 200);
  const hedgeOnlyWhenConfident = boolWithDefault("HEDGE_ONLY_WHEN_CONFIDENT", true);
  const newsEnabled = boolWithDefault("NEWS_ENABLED", true);
  const newsRefreshMs = clampInt(numberWithDefault("NEWS_REFRESH_MS", 60_000), 15_000, 600_000);
  const newsMaxItems = clampInt(numberWithDefault("NEWS_MAX_ITEMS", 200), 20, 2000);
  const newsHalfLifeMs = clampInt(numberWithDefault("NEWS_HALF_LIFE_MS", 3_600_000), 60_000, 24 * 60 * 60 * 1000);
  const newsMinConf = clampNumber(numberWithDefault("NEWS_MIN_CONF", 0.6), 0, 1);
  const newsPauseImpact = clampNumber(numberWithDefault("NEWS_PAUSE_IMPACT", 0.85), 0, 1.5);
  const newsPauseSeconds = clampInt(numberWithDefault("NEWS_PAUSE_SECONDS", 180), 10, 3_600);
  const newsSpreadMult = clampNumber(numberWithDefault("NEWS_SPREAD_MULT", 0.8), 0, 3);
  const newsSizeCutMult = clampNumber(numberWithDefault("NEWS_SIZE_CUT_MULT", 0.6), 0, 1);
  const intelNewsMaxPosture = parseIntelNewsMaxPosture(
    optional("INTEL_NEWS_MAX_POSTURE") ?? optional("intel.news.maxPosture")
  );
  const intelNewsAllowSideBlocks = boolWithFallback(
    ["INTEL_NEWS_ALLOW_SIDE_BLOCKS", "intel.news.allowSideBlocks"],
    false
  );
  const intelNewsMaxSpreadMult = clampNumber(
    numberWithFallback(["INTEL_NEWS_MAX_SPREAD_MULT", "intel.news.maxSpreadMult"], 1.2),
    1,
    3
  );
  const intelNewsMinSizeMult = clampNumber(
    numberWithFallback(["INTEL_NEWS_MIN_SIZE_MULT", "intel.news.minSizeMult"], 0.6),
    0.1,
    1
  );
  const newsSourcesRss = parseCsvList(optional("NEWS_SOURCES_RSS") ?? optional("RSS_FEEDS"));
  const newsGdeltQuery = withDefault(
    "NEWS_GDELT_QUERY",
    '(BTC OR Bitcoin OR crypto OR "Fed" OR "interest rates" OR "rate cut" OR "rate hike" OR CPI OR inflation OR Iran OR strike OR sanctions)'
  );
  const newsApiKey = optional("NEWSAPI_KEY");
  const enableFairPrice = boolWithDefault("ENABLE_FAIR_PRICE", true);
  const fairPriceMinVenues = clampInt(numberWithDefault("FAIR_PRICE_MIN_VENUES", 2), 1, 20);
  const fairPriceMaxStaleMs = clampInt(numberWithDefault("FAIR_PRICE_MAX_STALE_MS", 15_000), 250, 120_000);
  const fairPriceUsdtPenaltyBps = clampNumber(numberWithDefault("FAIR_PRICE_USDT_PENALTY_BPS", 1.5), 0, 50);
  const enableAdverse = boolWithDefault("ENABLE_ADVERSE", true);
  const enableIntel = boolWithFallback(["ENABLE_INTEL", "INTEL_ENABLED"], false);
  const intelHardHaltOnly = boolWithDefault("INTEL_HARD_HALT_ONLY", true);
  const enableIntelTradeGuard = boolWithDefault("ENABLE_INTEL_TRADE_GUARD", false);
  const intelMaxAction = parseIntelMaxAction(optional("INTEL_MAX_ACTION"));
  const intelCrossvenueAction = parseIntelCrossvenueAction(optional("INTEL_CROSSVENUE_ACTION"));
  const intelProviderDegradedAction = parseIntelProviderDegradedAction(optional("INTEL_PROVIDER_DEGRADED_ACTION"));
  const intelFastPollSeconds = clampInt(
    numberWithFallback(["INTEL_FAST_POLL_SECONDS", "INTEL_POLL_SECONDS"], 10),
    2,
    600
  );
  const intelSlowPollSeconds = clampInt(numberWithDefault("INTEL_SLOW_POLL_SECONDS", 60), 5, 3_600);
  const intelMaxItems = clampInt(numberWithDefault("INTEL_MAX_ITEMS", 500), 50, 10_000);
  const intelDedupeWindowMin = clampInt(numberWithDefault("INTEL_DEDUPE_WINDOW_MIN", 180), 10, 24 * 60);
  const intelDedupeWindowSeconds = clampInt(
    numberWithFallback(["INTEL_DEDUPE_WINDOW_SECONDS", "INTEL_DEDUPE_TTL_SECONDS"], 120),
    5,
    24 * 60 * 60
  );
  const intelItemTtlSeconds = clampInt(numberWithDefault("INTEL_ITEM_TTL_SECONDS", 7200), 60, 7 * 24 * 60 * 60);
  const intelStaleSeconds = clampInt(numberWithDefault("INTEL_STALE_SECONDS", 900), 30, 24 * 60 * 60);
  const intelProviderMinOk = clampInt(numberWithDefault("INTEL_PROVIDER_MIN_OK", 2), 1, 20);
  const intelSoftPauseImpact = clampNumber(numberWithDefault("INTEL_SOFT_PAUSE_IMPACT", 0.92), 0, 1);
  const intelSoftPauseConf = clampNumber(numberWithDefault("INTEL_SOFT_PAUSE_CONF", 0.8), 0, 1);
  const intelHardHaltImpact = clampNumber(numberWithDefault("INTEL_HARD_HALT_IMPACT", 0.99), 0, 1);
  const intelPauseImpactThreshold = clampNumber(
    numberWithFallback(["INTEL_PAUSE_IMPACT_THRESHOLD", "intel.pauseImpactThreshold"], 0.97),
    0,
    1
  );
  const intelPauseConfidenceThreshold = clampNumber(
    numberWithFallback(["INTEL_PAUSE_CONFIDENCE_THRESHOLD", "intel.pauseConfidenceThreshold"], 0.75),
    0,
    1
  );
  const intelPausePersistenceSeconds = clampInt(
    numberWithFallback(["INTEL_PAUSE_PERSISTENCE_SECONDS", "intel.pausePersistenceSeconds"], 120),
    5,
    3600
  );
  const intelAlwaysOn = boolWithDefault("INTEL_ALWAYS_ON", true);
  const intelMinQuoteLevels = clampInt(numberWithDefault("INTEL_MIN_QUOTE_LEVELS", 1), 0, 5);
  const intelMinSizeMult = clampNumber(numberWithDefault("INTEL_MIN_SIZE_MULT", 0.3), 0.05, 1);
  const intelMaxSpreadMult = clampNumber(numberWithDefault("INTEL_MAX_SPREAD_MULT", 2.25), 1, 8);
  const quotingMinLevelsFloorEnabled = boolWithFallback(
    ["QUOTING_MIN_LEVELS_FLOOR_ENABLED", "quoting.minLevelsFloorEnabled"],
    true
  );
  const quotingMinLevelsFloorBuy = clampInt(
    numberWithFallback(
      [
        "QUOTING_MIN_LEVELS_FLOOR_BUY",
        "quoting.minLevelsFloor.buy",
        "quoting.minLevelsFloorBuy"
      ],
      1
    ),
    0,
    5
  );
  const quotingMinLevelsFloorSell = clampInt(
    numberWithFallback(
      [
        "QUOTING_MIN_LEVELS_FLOOR_SELL",
        "quoting.minLevelsFloor.sell",
        "quoting.minLevelsFloorSell"
      ],
      1
    ),
    0,
    5
  );
  const quotingMinVolMoveBpsForExtraWidening = clampNumber(
    numberWithFallback(
      [
        "QUOTING_MIN_VOL_MOVE_BPS_FOR_EXTRA_WIDENING",
        "quoting.minVolMoveBpsForExtraWidening"
      ],
      0
    ),
    0,
    500
  );
  const quotingLowVolMode = parseQuotingLowVolMode(
    optional("QUOTING_LOW_VOL_MODE") ?? optional("quoting.lowVolMode")
  );
  const quotingForceBaselineWhenEnabled = boolWithFallback(
    ["QUOTING_FORCE_BASELINE_WHEN_ENABLED", "quoting.forceBaselineWhenEnabled"],
    true
  );
  const quotingBaselineNotionalUsd = clampNumber(
    numberWithFallback(["QUOTING_BASELINE_NOTIONAL_USD", "quoting.baselineNotionalUsd"], 10),
    1,
    10_000
  );
  const quotingMinNotionalUsd = clampNumber(
    numberWithFallback(
      ["QUOTING_MIN_NOTIONAL_USD", "quoting.minNotionalUsd"],
      10
    ),
    0.01,
    10_000
  );
  const shockEnterBps = clampNumber(numberWithDefault("SHOCK_ENTER_BPS", Math.max(20, volPauseBps * 0.5)), 5, 500);
  const shockSpreadBps = clampNumber(
    numberWithDefault("SHOCK_SPREAD_BPS", Math.max(2, shockEnterBps * 0.2)),
    0.5,
    500
  );
  const shockDispersionBps = clampNumber(
    numberWithDefault("SHOCK_DISPERSION_BPS", Math.max(4, fairMaxDispersionBps * 1.2)),
    0.5,
    500
  );
  const shockPriceGapBps = clampNumber(numberWithDefault("SHOCK_PRICE_GAP_BPS", 12), 1, 500);
  const shockAdverseToxicity = clampNumber(numberWithDefault("SHOCK_ADVERSE_TOXICITY", 0.65), 0, 1);
  const shockMinSeconds = clampInt(numberWithDefault("SHOCK_MIN_SECONDS", 30), 5, 1_800);
  const shockCooldownVolBps = clampNumber(
    numberWithDefault("SHOCK_COOLDOWN_VOL_BPS", Math.max(calmVolBps * 1.25, 4)),
    1,
    500
  );
  const shockReentryPersistSeconds = clampInt(numberWithDefault("SHOCK_REENTRY_PERSIST_SECONDS", 90), 10, 3_600);
  const reentryNoNewLowSeconds = clampInt(
    numberWithDefault("REENTRY_NO_NEW_LOW_SECONDS", 90),
    10,
    3_600
  );
  const recoveryDispersionBps = clampNumber(
    numberWithDefault("RECOVERY_DISPERSION_BPS", Math.max(1, shockDispersionBps * 0.6)),
    0.1,
    500
  );
  const recoveryPersistSeconds = clampInt(
    numberWithDefault("RECOVERY_PERSIST_SECONDS", 120),
    10,
    3_600
  );
  const btcFloorNotionalUsd = clampNumber(numberWithDefault("BTC_FLOOR_NOTIONAL_USD", 10), 0.01, 100_000);
  const reentryBtcTargetNotionalUsd = clampNumber(
    numberWithDefault("REENTRY_BTC_TARGET_NOTIONAL_USD", 75),
    btcFloorNotionalUsd,
    1_000_000
  );
  const inventoryFloorBtcNotionalUsd = clampNumber(
    numberWithFallback(["INVENTORY_FLOOR_BTC_NOTIONAL_USD", "BTC_FLOOR_NOTIONAL_USD"], 20),
    0.01,
    1_000_000
  );
  const inventoryTargetBtcNotionalUsd = clampNumber(
    numberWithFallback(["INVENTORY_TARGET_BTC_NOTIONAL_USD", "REENTRY_BTC_TARGET_NOTIONAL_USD"], 80),
    inventoryFloorBtcNotionalUsd,
    1_000_000
  );
  const inventoryCapBtcNotionalUsd = clampNumber(
    numberWithDefault("INVENTORY_CAP_BTC_NOTIONAL_USD", 160),
    inventoryTargetBtcNotionalUsd,
    5_000_000
  );
  const phaseAwareMaxSellUsdPerHour = clampNumber(
    numberWithDefault("PHASE_MAX_SELL_USD_PER_HOUR", 30),
    0,
    100_000
  );
  const enableTakerReentry = boolWithDefault("ENABLE_TAKER_REENTRY", false);
  const maxTakerReentryUsdPerHour = clampNumber(
    numberWithDefault("MAX_TAKER_REENTRY_USD_PER_HOUR", 25),
    0,
    50_000
  );
  const reentryMinEdgeOverFeesBps = clampNumber(
    numberWithDefault("REENTRY_MIN_EDGE_OVER_FEES_BPS", 2),
    0,
    100
  );
  const hardHaltStaleMarketDataSeconds = clampInt(
    numberWithDefault("HARD_HALT_STALE_MARKET_DATA_SECONDS", 60),
    10,
    600
  );
  const fatal5xxWindowMinutes = clampInt(numberWithDefault("FATAL_5XX_WINDOW_MINUTES", 3), 1, 120);
  const fatal5xxThreshold = clampInt(numberWithDefault("FATAL_5XX_THRESHOLD", 8), 2, 10_000);
  const intelHeadlineMaxAgeSeconds = clampInt(
    numberWithDefault("INTEL_HEADLINE_MAX_AGE_SECONDS", 300),
    10,
    24 * 60 * 60
  );
  const intelAnomalyMaxAgeSeconds = clampInt(
    numberWithDefault("INTEL_ANOMALY_MAX_AGE_SECONDS", 120),
    10,
    24 * 60 * 60
  );
  const intelEventCooldownSeconds = clampInt(numberWithDefault("INTEL_EVENT_COOLDOWN_SECONDS", 30), 5, 600);
  const intelMaxHighImpactPerMinute = clampInt(numberWithDefault("INTEL_MAX_HIGH_IMPACT_PER_MINUTE", 2), 1, 100);
  const enableGdelt = boolWithDefault("ENABLE_GDELT", enableIntel);
  const enableRss = boolWithDefault("ENABLE_RSS", enableIntel);
  const enableCryptopanic = boolWithDefault("ENABLE_CRYPTOPANIC", Boolean(optional("CRYPTOPANIC_TOKEN")));
  const enableNewsapi = boolWithDefault("ENABLE_NEWSAPI", Boolean(optional("NEWSAPI_KEY")));
  const enableX = boolWithDefault("ENABLE_X", false);
  const gdeltQuery = withDefault(
    "GDELT_QUERY",
    "(BTC OR bitcoin OR crypto OR Iran OR oil OR FED OR rates OR inflation OR war OR strike OR sanctions)"
  );
  const gdeltMaxArticles = clampInt(numberWithDefault("GDELT_MAX_ARTICLES", 25), 1, 250);
  const rssUrls = parseCsvListRaw(optional("RSS_URLS") ?? optional("RSS_FEEDS"));
  const cryptopanicToken = optional("CRYPTOPANIC_TOKEN");
  const xBearerToken = optional("X_BEARER_TOKEN");
  const xQuery = withDefault(
    "X_QUERY",
    '(bitcoin OR BTC OR crypto OR "Iran" OR "oil" OR "Fed" OR "rate hike" OR "sanctions") lang:en -is:retweet'
  );
  const xMaxResultsPerPoll = clampInt(numberWithDefault("X_MAX_RESULTS_PER_POLL", 10), 1, 50);
  const intelMaxWidenBps = clampNumber(numberWithDefault("INTEL_MAX_WIDEN_BPS", 10), 0, 100);
  const intelMaxSizeCut = clampNumber(numberWithDefault("INTEL_MAX_SIZE_CUT", 0.7), 0, 0.95);
  const intelMaxSkewBps = clampNumber(numberWithDefault("INTEL_MAX_SKEW_BPS", 12), 0, 100);
  const intelHaltImpact = clampNumber(numberWithDefault("INTEL_HALT_IMPACT", 0.95), 0, 1);
  const intelHaltSeconds = clampInt(numberWithDefault("INTEL_HALT_SECONDS", 90), 5, 3_600);
  const intelDecayMinutes = clampInt(numberWithDefault("INTEL_DECAY_MINUTES", 30), 1, 24 * 60);
  const uiShowDiagnosticsDrawer = boolWithDefault("UI_SHOW_DIAGNOSTICS_DRAWER", true);
  const uiDiagnosticsDefaultOpen = boolWithDefault("UI_DIAGNOSTICS_DEFAULT_OPEN", false);
  const uiHeaderMaxRows = clampInt(numberWithDefault("UI_HEADER_MAX_ROWS", 2), 1, 4);
  const signalsEnabled = boolWithFallback(
    ["SIGNALS_ENABLED", "SIGNALS_ENGINE_ENABLED", "ENABLE_SIGNALS_ENGINE"],
    true
  );
  const signalsNewsRefreshMs = clampInt(numberWithDefault("SIGNALS_NEWS_REFRESH_MS", 60_000), 15_000, 600_000);
  const signalsMacroEnabled = boolWithDefault("SIGNALS_MACRO_ENABLED", true);
  const signalsMacroRefreshMs = clampInt(numberWithDefault("SIGNALS_MACRO_REFRESH_MS", 300_000), 30_000, 3_600_000);
  const signalsSystemRefreshMs = clampInt(numberWithDefault("SIGNALS_SYSTEM_REFRESH_MS", 5_000), 1_000, 60_000);
  const signalsMaxItems = clampInt(numberWithDefault("SIGNALS_MAX_ITEMS", 400), 50, 5_000);
  const signalsHalfLifeMs = clampInt(numberWithDefault("SIGNALS_HALF_LIFE_MS", 3_600_000), 60_000, 24 * 60 * 60 * 1000);
  const signalsMinConf = clampNumber(numberWithDefault("SIGNALS_MIN_CONF", 0.6), 0, 1);
  const signalsPauseImpact = clampNumber(numberWithDefault("SIGNALS_PAUSE_IMPACT", 0.9), 0, 1);
  const signalsPauseSeconds = clampInt(numberWithDefault("SIGNALS_PAUSE_SECONDS", 180), 10, 3_600);
  const signalsSpreadMult = clampNumber(numberWithDefault("SIGNALS_SPREAD_MULT", 0.8), 0, 3);
  const signalsSizeCutMult = clampNumber(numberWithDefault("SIGNALS_SIZE_CUT_MULT", 0.6), 0, 1);
  const signalsRssUrls = parseCsvListRaw(optional("SIGNALS_RSS_URLS"));
  const signalsGdeltQuery = withDefault(
    "SIGNALS_GDELT_QUERY",
    '("bitcoin" OR "btc" OR "crypto" OR "fed" OR "rate hike" OR "rate cut" OR "cpi" OR "inflation" OR "iran" OR "strike" OR "sanctions" OR "oil")'
  );
  const signalsMacroUrl = optional("SIGNALS_MACRO_URL");
  const signalsLlmEnabled = boolWithDefault("SIGNALS_LLM_ENABLED", false);
  const openAiApiKey = optional("OPENAI_API_KEY");
  const trendWindowSeconds = clampInt(numberWithDefault("TREND_WINDOW_SECONDS", 15), 5, 120);
  const trendPauseBps = clampNumber(numberWithDefault("TREND_PAUSE_BPS", 20), 5, 200);
  const trendSkewBps = clampNumber(numberWithDefault("TREND_SKEW_BPS", 10), 0, 40);
  const trendProtectionMode = parseTrendMode(optional("TREND_PROTECTION_MODE"));
  const dynamicTargetBtc = boolWithDefault("DYNAMIC_TARGET_BTC", true);
  const dynamicTargetBufferUsd = clampNumber(numberWithDefault("DYNAMIC_TARGET_BUFFER_USD", 40), 1, 5_000);

  const targetBtcNotionalUsd = clampNumber(
    numberWithDefault("TARGET_BTC_NOTIONAL_USD", 80),
    0,
    10_000
  );
  const maxBtcNotionalUsd = clampNumber(
    numberWithFallback(["MAX_BTC_NOTIONAL_USD", "MAX_INVENTORY_USD"], 120),
    targetBtcNotionalUsd + 1,
    25_000
  );
  const skewMaxBps = clampNumber(numberWithDefault("SKEW_MAX_BPS", 25), 0, 50);
  const minQuoteSizeUsd = clampNumber(numberWithDefault("MIN_QUOTE_SIZE_USD", 3), 1, 200);
  const maxDistanceFromTobBps = clampNumber(numberWithDefault("MAX_DISTANCE_FROM_TOB_BPS", 3), 0.1, 50);
  const minOrderAgeSeconds = clampNumber(numberWithDefault("MIN_ORDER_AGE_SECONDS", 7), 0, 60);
  const quoteRefreshSeconds = clampNumber(numberWithDefault("QUOTE_REFRESH_SECONDS", 2), 0.5, 30);

  const cashReserveUsd = clampNumber(numberWithDefault("CASH_RESERVE_USD", 60), 0, 100_000);
  const workingCapUsd = clampNumber(numberWithDefault("WORKING_CAP_USD", 100), 1, 100_000);
  const maxConsecutiveErrors = clampInt(numberWithDefault("MAX_CONSECUTIVE_ERRORS", 3), 1, 20);
  const pauseSecondsOnVol = clampInt(numberWithDefault("PAUSE_SECONDS_ON_VOL", 300), 30, 3600);
  const maxActiveOrders = clampInt(numberWithDefault("MAX_ACTIVE_ORDERS", 10), 2, 30);
  const cancelRetry = clampInt(numberWithDefault("CANCEL_RETRY", 2), 0, 10);
  const placeRetry = clampInt(numberWithDefault("PLACE_RETRY", 2), 0, 10);
  const metricsLogEverySeconds = clampInt(
    numberWithDefault("METRICS_LOG_EVERY_SECONDS", 30),
    5,
    600
  );
  const maxActionsPerLoop = clampInt(numberWithDefault("MAX_ACTIONS_PER_LOOP", 4), 1, 12);
  const pendingStaleSeconds = clampInt(numberWithDefault("PENDING_STALE_SECONDS", 30), 5, 600);
  const balanceRefreshSeconds = clampNumber(numberWithDefault("BALANCE_REFRESH_SECONDS", 5), 1, 60);
  const balanceReserveBtc = clampNumber(numberWithDefault("BALANCE_RESERVE_BTC", 0), 0, 10);
  const balanceDustBtc = clampNumber(numberWithDefault("BALANCE_DUST_BTC", 0.00000001), 0, 1);
  const performanceEnabled = boolWithDefault("PERFORMANCE_ENABLED", true);
  const adaptiveControllerEnabled = boolWithDefault("ADAPTIVE_ENABLED", false);
  const adaptiveControllerIntervalSeconds = clampInt(
    numberWithDefault("ADAPTIVE_INTERVAL_SECONDS", 60),
    15,
    600
  );
  const adaptiveFillsPerHourMin = clampNumber(numberWithDefault("ADAPTIVE_FILLS_PER_HOUR_MIN", 3), 0, 100);
  const adaptiveToxicPctMax = clampNumber(numberWithDefault("ADAPTIVE_TOXIC_PCT_MAX", 0.4), 0, 1);
  const adaptiveAvgToxBpsMin = clampNumber(numberWithDefault("ADAPTIVE_AVG_TOX_BPS_MIN", -3), -100, 100);
  const adaptiveNetPnlStopLoss24h = clampNumber(
    numberWithDefault("ADAPTIVE_NET_PNL_STOP_LOSS_24H", -15),
    -100_000,
    0
  );

  if (volSpreadMultMax < volSpreadMultMin) {
    throw new Error("VOL_SPREAD_MULT_MAX must be >= VOL_SPREAD_MULT_MIN");
  }
  if (volWidenMultMax < volWidenMultMin) {
    throw new Error("VOL_WIDEN_MULT_MAX must be >= VOL_WIDEN_MULT_MIN");
  }
  if (maxHalfSpreadBps < minHalfSpreadBps) {
    throw new Error("MAX_HALF_SPREAD_BPS must be >= MIN_HALF_SPREAD_BPS");
  }
  if (tobMaxInventoryRatioForOneSided < tobMaxInventoryRatioForBoth) {
    throw new Error(
      "TOB_MAX_INVENTORY_RATIO_FOR_ONE_SIDED must be >= TOB_MAX_INVENTORY_RATIO_FOR_BOTH"
    );
  }
  if (signalHotWiden < 1) {
    throw new Error("SIGNAL_HOT_WIDEN must be >= 1");
  }
  if (minQuoteSizeUsd > levelQuoteSizeUsd) {
    throw new Error("MIN_QUOTE_SIZE_USD must be <= LEVEL_QUOTE_SIZE_USD");
  }

  const externalVenues = parseCsvList(optional("EXTERNAL_VENUES"));
  const externalQuotesRefreshSeconds = clampNumber(
    numberWithDefault("EXTERNAL_QUOTES_REFRESH_SECONDS", 5),
    1,
    60
  );
  return {
    revxApiKey: revxApiKey ?? "MOCK-API-KEY",
    revxPrivateKeyBase64,
    revxPrivateKeyPath,
    mockMode,
    revxBaseUrl: withDefault("REVX_BASE_URL", "https://revx.revolut.com"),
    symbol: normalizeSymbol(withDefault("SYMBOL", "BTC-USD")),

    cashReserveUsd,
    workingCapUsd,
    quoteSizeUsd: levelQuoteSizeUsd,
    halfSpreadBps: baseHalfSpreadBps,
    refreshSeconds,
    repriceMoveBps,
    maxInventoryUsd: maxBtcNotionalUsd,
    pauseVolMoveBps: volPauseBps,
    pauseVolWindowSeconds: volWindowSeconds,
    maxConsecutiveErrors,
    pnlDailyStopUsd: numberWithDefault("PNL_DAILY_STOP_USD", -5),

    levels,
    levelQuoteSizeUsd,
    baseHalfSpreadBps,
    levelStepBps,
    queueRefreshSeconds,
    minInsideSpreadBps,
    minVolMoveBpsToQuote,
    volProtectMode,
    volWidenMultMin,
    volWidenMultMax,
    volWidenInCalm,
    volWidenMultCalm,
    volWindowSeconds,
    volPauseBps,
    volSpreadMultMin,
    volSpreadMultMax,
    minHalfSpreadBps,
    maxHalfSpreadBps,
    calmVolBps,
    targetFillsPerHour,
    enableTopOfBook,
    tobQuoteSizeUsd,
    tobMaxVolBps,
    tobQuoteSizeUsdNormal,
    seedMaxSeconds,
    seedMaxReposts,
    seedTakerUsd,
    seedTakerSlippageBps,
    seedForceTob,
    seedHalfSpreadBps,
    tobMaxInventoryRatioForBoth,
    tobMaxInventoryRatioForOneSided,
    sellThrottleBelowLowGate,
    minSellLevelsBelowLowGate,
    sellDisableBelowNotionalUsd,
    signalEnabled,
    signalMaxSkewBps,
    signalZscoreToSkew,
    signalDriftToSkew,
    signalCalmTighten,
    signalHotWiden,
    signalHotRegimeMultiplier,
    signalTopOfBookOnlyInCalm,
    signalLevelsInHot,
    signalRefreshMs,
    signalMaxQuoteAgeMs,
    signalMinConf,
    signalUsdtDegrade,
    signalVenues,
    enableCrossVenueSignals,
    venueRefreshMs,
    venueStaleMs,
    venueTimeoutMs,
    venueMaxBackoffMs,
    fairDriftMaxBps,
    fairBasisMaxBps,
    fairStaleMs,
    fairMinVenues,
    fairMaxDispersionBps,
    fairMaxBasisBps,
    toxicDriftBps,
    makerFeeBps,
    takerFeeBps,
    takerSlipBps,
    takerSafetyBps,
    minMakerEdgeBps,
    minRealizedEdgeBps,
    minTakerEdgeBps,
    enableAdverseSelectionLoop,
    asHorizonSeconds,
    asSampleFills,
    asBadAvgBps,
    asBadRate,
    asBadFillBps,
    asWidenStepBps,
    asMaxWidenBps,
    asDisableTobOnToxic,
    asCooldownSeconds,
    asReduceLevelsOnToxic,
    asLevelsFloor,
    asDecayBpsPerMin,
    adverseEnabled,
    adverseMarkoutWindowsMs,
    adverseToxicMarkoutBps,
    adverseMinFills,
    adverseDecay,
    adverseStateThresholdsCsv,
    adverseMaxSpreadMult,
    edgeSafetyBps,
    hotVolBps,
    venueWeights,
    seedEnabled,
    enableTakerSeed,
    seedTakerMaxUsd,
    seedTakerMaxSlippageBps,
    seedBuyUsd,
    maxSeedBuyUsd,
    seedTargetBtcNotionalUsd,
    hedgeEnabled,
    hedgeMaxUsdPerMin,
    hedgeMaxSlippageBps,
    hedgeOnlyWhenConfident,
    newsEnabled,
    newsRefreshMs,
    newsMaxItems,
    newsHalfLifeMs,
    newsMinConf,
    newsPauseImpact,
    newsPauseSeconds,
    newsSpreadMult,
    newsSizeCutMult,
    intelNewsMaxPosture,
    intelNewsAllowSideBlocks,
    intelNewsMaxSpreadMult,
    intelNewsMinSizeMult,
    newsSourcesRss,
    newsGdeltQuery,
    newsApiKey,
    enableFairPrice,
    fairPriceMinVenues,
    fairPriceMaxStaleMs,
    fairPriceUsdtPenaltyBps,
    enableAdverse,
    enableIntel,
    intelHardHaltOnly,
    enableIntelTradeGuard,
    intelMaxAction,
    intelCrossvenueAction,
    intelProviderDegradedAction,
    intelFastPollSeconds,
    intelSlowPollSeconds,
    intelMaxItems,
    intelDedupeWindowMin,
    intelDedupeWindowSeconds,
    intelItemTtlSeconds,
    intelStaleSeconds,
    intelProviderMinOk,
    intelSoftPauseImpact,
    intelSoftPauseConf,
    intelHardHaltImpact,
    intelPauseImpactThreshold,
    intelPauseConfidenceThreshold,
    intelPausePersistenceSeconds,
    intelAlwaysOn,
    intelMinQuoteLevels,
    intelMinSizeMult,
    intelMaxSpreadMult,
    quotingMinLevelsFloorEnabled,
    quotingMinLevelsFloorBuy,
    quotingMinLevelsFloorSell,
    quotingMinVolMoveBpsForExtraWidening,
    quotingLowVolMode,
    quotingForceBaselineWhenEnabled,
    quotingBaselineNotionalUsd,
    quotingMinNotionalUsd,
    shockEnterBps,
    shockSpreadBps,
    shockDispersionBps,
    shockPriceGapBps,
    shockAdverseToxicity,
    shockMinSeconds,
    shockCooldownVolBps,
    shockReentryPersistSeconds,
    reentryNoNewLowSeconds,
    recoveryDispersionBps,
    recoveryPersistSeconds,
    inventoryTargetBtcNotionalUsd,
    inventoryFloorBtcNotionalUsd,
    inventoryCapBtcNotionalUsd,
    phaseAwareMaxSellUsdPerHour,
    enableTakerReentry,
    maxTakerReentryUsdPerHour,
    reentryMinEdgeOverFeesBps,
    btcFloorNotionalUsd,
    reentryBtcTargetNotionalUsd,
    hardHaltStaleMarketDataSeconds,
    fatal5xxWindowMinutes,
    fatal5xxThreshold,
    intelHeadlineMaxAgeSeconds,
    intelAnomalyMaxAgeSeconds,
    intelEventCooldownSeconds,
    intelMaxHighImpactPerMinute,
    enableGdelt,
    enableRss,
    enableCryptopanic,
    enableNewsapi,
    enableX,
    gdeltQuery,
    gdeltMaxArticles,
    rssUrls,
    cryptopanicToken,
    xBearerToken,
    xQuery,
    xMaxResultsPerPoll,
    intelMaxWidenBps,
    intelMaxSizeCut,
    intelMaxSkewBps,
    intelHaltImpact,
    intelHaltSeconds,
    intelDecayMinutes,
    uiShowDiagnosticsDrawer,
    uiDiagnosticsDefaultOpen,
    uiHeaderMaxRows,
    signalsEnabled,
    signalsNewsRefreshMs,
    signalsMacroEnabled,
    signalsMacroRefreshMs,
    signalsSystemRefreshMs,
    signalsMaxItems,
    signalsHalfLifeMs,
    signalsMinConf,
    signalsPauseImpact,
    signalsPauseSeconds,
    signalsSpreadMult,
    signalsSizeCutMult,
    signalsRssUrls,
    signalsGdeltQuery,
    signalsMacroUrl,
    signalsLlmEnabled,
    openAiApiKey,
    adaptiveSpread,
    adaptiveStepBps,
    targetFillsWindowMinutes,
    fillDroughtMinutes,
    edgeLookbackMinutes,
    edgeGoodBps,
    edgeBadBps,
    edgeAdjustBps,
    edgeMaxSideAdjustBps,
    trackPostOnlyRejects,
    maxCancelsPerHour,
    trendWindowSeconds,
    trendPauseBps,
    trendSkewBps,
    trendProtectionMode,
    dynamicTargetBtc,
    dynamicTargetBufferUsd,
    targetBtcNotionalUsd,
    maxBtcNotionalUsd,
    skewMaxBps,
    minQuoteSizeUsd,
    maxDistanceFromTobBps,
    minOrderAgeSeconds,
    quoteRefreshSeconds,
    pauseSecondsOnVol,
    maxActiveOrders,
    cancelRetry,
    placeRetry,
    metricsLogEverySeconds,
    maxActionsPerLoop,
    pendingStaleSeconds,
    balanceRefreshSeconds,
    balanceReserveBtc,
    balanceDustBtc,
    performanceEnabled,
    adaptiveControllerEnabled,
    adaptiveControllerIntervalSeconds,
    adaptiveFillsPerHourMin,
    adaptiveToxicPctMax,
    adaptiveAvgToxBpsMin,
    adaptiveNetPnlStopLoss24h,

    runtimeBaseDir: RUNTIME_BASE_DIR,
    dryRun,

    dbPath: withDefault("DB_PATH", "./revx-bot.sqlite"),
    storeBackend: parseStoreBackend(optional("STORE_BACKEND")),
    debugBalances: boolWithDefault("DEBUG_BALANCES", false),
    logLevel: withDefault("LOG_LEVEL", "info"),
    requestsPerMinute: numberWithDefault("REQUESTS_PER_MINUTE", 800),
    reconcileSeconds: clampInt(numberWithDefault("RECONCILE_SECONDS", 5), 3, 60),
    dashboardEnabled: boolWithDefault("DASHBOARD_ENABLED", true),
    dashboardPort: numberWithDefault("DASHBOARD_PORT", 8787),
    externalVenues,
    externalQuotesRefreshSeconds,
    maxUiEvents: clampInt(numberWithDefault("MAX_UI_EVENTS", 500), 50, 5000),
    maxSignalPoints: clampInt(numberWithDefault("MAX_SIGNAL_POINTS", 2000), 200, 200_000),
    maxEquityPoints: clampInt(numberWithDefault("MAX_EQUITY_POINTS", 5000), 200, 50_000),
    equitySampleMs: clampInt(numberWithDefault("EQUITY_SAMPLE_MS", 2000), 250, 60_000),
    persistEquitySeries: boolWithDefault("PERSIST_EQUITY_SERIES", false),
    maxApiEvents: clampInt(numberWithDefault("MAX_API_EVENTS", 500), 50, 10_000),
    eventDedupe: boolWithDefault("EVENT_DEDUPE", true),
    envFilePath
  };
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.trim().length === 0) return undefined;
  return value.trim();
}

function withDefault(name: string, fallback: string): string {
  return optional(name) ?? fallback;
}

function numberWithDefault(name: string, fallback: number): number {
  const value = optional(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a valid number`);
  }
  return parsed;
}

function numberWithFallback(names: string[], fallback: number): number {
  for (const name of names) {
    const value = optional(name);
    if (value === undefined) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${name} must be a valid number`);
    }
    return parsed;
  }
  return fallback;
}

function boolWithDefault(name: string, fallback: boolean): boolean {
  const value = optional(name);
  if (value === undefined) return fallback;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function boolWithFallback(names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const value = optional(name);
    if (value === undefined) continue;
    const normalized = value.toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return fallback;
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase().replace("/", "-");
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseTrendMode(value: string | undefined): "spread" | "reduce_level" {
  if (!value) return "spread";
  const normalized = value.trim().toLowerCase();
  if (normalized === "reduce_level" || normalized === "reduce-level" || normalized === "level") {
    return "reduce_level";
  }
  return "spread";
}

function parseVolProtectMode(value: string | undefined): "block" | "widen" {
  if (!value) return "widen";
  const normalized = value.trim().toLowerCase();
  return normalized === "block" ? "block" : "widen";
}

function parseIntelNewsMaxPosture(value: string | undefined): "NORMAL" | "CAUTION" {
  const normalized = String(value ?? "CAUTION").trim().toUpperCase();
  return normalized === "NORMAL" ? "NORMAL" : "CAUTION";
}

function parseIntelMaxAction(value: string | undefined): "soften" | "halt" {
  const normalized = String(value ?? "soften").trim().toLowerCase();
  return normalized === "halt" ? "halt" : "soften";
}

function parseIntelCrossvenueAction(value: string | undefined): "soften" | "ignore" | "halt" {
  const normalized = String(value ?? "soften").trim().toLowerCase();
  if (normalized === "halt") return "halt";
  if (normalized === "ignore") return "ignore";
  return "soften";
}

function parseIntelProviderDegradedAction(value: string | undefined): "ignore" | "soften" | "halt" {
  const normalized = String(value ?? "ignore").trim().toLowerCase();
  if (normalized === "halt") return "halt";
  if (normalized === "soften") return "soften";
  return "ignore";
}

function parseQuotingLowVolMode(value: string | undefined): "KEEP_QUOTING" {
  const normalized = String(value ?? "KEEP_QUOTING").trim().toUpperCase();
  if (normalized === "KEEP_QUOTING") return "KEEP_QUOTING";
  return "KEEP_QUOTING";
}

function warnDuplicateEnvKeys(envFilePath: string): void {
  try {
    if (!existsSync(envFilePath)) return;
    const raw = readFileSync(envFilePath, "utf8");
    const seen = new Set<string>();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
      const idx = normalized.indexOf("=");
      if (idx <= 0) continue;
      const key = normalized.slice(0, idx).trim();
      if (!key) continue;
      if (seen.has(key)) {
        // eslint-disable-next-line no-console
        console.warn(`Duplicate env key detected: ${key} (last wins).`);
      }
      seen.add(key);
    }
  } catch {
    // ignore env diagnostics failure
  }
}

function parseStoreBackend(value: string | undefined): "json" | "sqlite" {
  if (!value) return "json";
  const normalized = value.trim().toLowerCase();
  if (normalized === "json" || normalized === "sqlite") return normalized;
  throw new Error("STORE_BACKEND must be either 'json' or 'sqlite'");
}

function resolveAbsolutePath(inputPath: string): string {
  const value = inputPath.trim();
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(process.cwd(), value);
}

function resolveRuntimeBaseDir(input: string | undefined): string {
  const value = (input ?? process.cwd()).trim();
  if (path.isAbsolute(value)) return value;
  return path.resolve(process.cwd(), value);
}

function isValidRevxApiKey(value: string): boolean {
  const key = String(value || "").trim();
  if (!key || key.includes("<") || key.includes(">")) return false;
  const alnum64 = /^[a-zA-Z0-9]{64}$/;
  const base64Like = /^(?:[a-zA-Z0-9+/]{4})*(?:(?:[a-zA-Z0-9+/]{3}=)|(?:[a-zA-Z0-9+/]{2}==)|(?:[a-zA-Z0-9+/]{1}===))?$/;
  return alnum64.test(key) || base64Like.test(key);
}

function parseVenueWeights(
  raw: string | undefined
): Record<"coinbase" | "binance" | "kraken", number> {
  const defaults: Record<"coinbase" | "binance" | "kraken", number> = {
    coinbase: 1,
    binance: 1,
    kraken: 0.8
  };
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return defaults;
    return {
      coinbase: clampNumber(toVenueWeight(parsed.coinbase, defaults.coinbase), 0.1, 5),
      binance: clampNumber(toVenueWeight(parsed.binance, defaults.binance), 0.1, 5),
      kraken: clampNumber(toVenueWeight(parsed.kraken, defaults.kraken), 0.1, 5)
    };
  } catch (error) {
    throw new Error(`VENUE_WEIGHTS_JSON must be valid JSON. ${(error as Error).message}`);
  }
}

function toVenueWeight(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  const unique = new Set<string>();
  for (const token of value.split(",")) {
    const normalized = token.trim().toLowerCase();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique.values());
}

function parseCsvListRaw(value: string | undefined): string[] {
  if (!value) return [];
  const unique = new Set<string>();
  for (const token of value.split(",")) {
    const normalized = token.trim();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique.values());
}

function parseNumberCsv(value: string | undefined, fallback: number[]): number[] {
  if (!value) return [...fallback];
  const out: number[] = [];
  for (const token of value.split(",")) {
    const parsed = Number(token.trim());
    if (!Number.isFinite(parsed)) continue;
    out.push(parsed);
  }
  return out.length > 0 ? out : [...fallback];
}
