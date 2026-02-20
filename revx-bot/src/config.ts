import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";

dotenv.config();

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
  minOrderAgeSeconds: number;
  pauseSecondsOnVol: number;
  maxActiveOrders: number;
  cancelRetry: number;
  placeRetry: number;
  metricsLogEverySeconds: number;
  maxActionsPerLoop: number;

  killSwitchFile: string;
  pauseSwitchFile: string;
  dryRun: boolean;

  dbPath: string;
  storeBackend: "json" | "sqlite";
  debugBalances: boolean;
  logLevel: string;
  requestsPerMinute: number;
  reconcileSeconds: number;
  dashboardEnabled: boolean;
  dashboardPort: number;
  maxUiEvents: number;
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
  const signalEnabled = boolWithFallback(["SIGNALS_ENABLED", "SIGNAL_ENABLED"], true);
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
  const minOrderAgeSeconds = clampNumber(numberWithDefault("MIN_ORDER_AGE_SECONDS", 7), 0, 60);

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

  if (volSpreadMultMax < volSpreadMultMin) {
    throw new Error("VOL_SPREAD_MULT_MAX must be >= VOL_SPREAD_MULT_MIN");
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
    minOrderAgeSeconds,
    pauseSecondsOnVol,
    maxActiveOrders,
    cancelRetry,
    placeRetry,
    metricsLogEverySeconds,
    maxActionsPerLoop,

    killSwitchFile: withDefault("KILL_SWITCH_FILE", "./KILL"),
    pauseSwitchFile: withDefault("PAUSE_SWITCH_FILE", "./PAUSE"),
    dryRun,

    dbPath: withDefault("DB_PATH", "./revx-bot.sqlite"),
    storeBackend: parseStoreBackend(optional("STORE_BACKEND")),
    debugBalances: boolWithDefault("DEBUG_BALANCES", false),
    logLevel: withDefault("LOG_LEVEL", "info"),
    requestsPerMinute: numberWithDefault("REQUESTS_PER_MINUTE", 800),
    reconcileSeconds: clampInt(numberWithDefault("RECONCILE_SECONDS", 5), 3, 60),
    dashboardEnabled: boolWithDefault("DASHBOARD_ENABLED", true),
    dashboardPort: numberWithDefault("DASHBOARD_PORT", 8787),
    maxUiEvents: clampInt(numberWithDefault("MAX_UI_EVENTS", 500), 50, 5000),
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
