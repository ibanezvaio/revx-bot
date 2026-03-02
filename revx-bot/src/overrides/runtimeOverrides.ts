import { BotConfig } from "../config";

export type RuntimeOverridesInput = {
  enabled?: boolean;
  allowBuy?: boolean;
  allowSell?: boolean;
  levelsBuy?: number;
  levelsSell?: number;
  levelQuoteSizeUsd?: number;
  baseHalfSpreadBps?: number;
  levelStepBps?: number;
  minMarketSpreadBps?: number;
  repriceMoveBps?: number;
  queueRefreshSeconds?: number;
  tobEnabled?: boolean;
  tobQuoteSizeUsd?: number;
  targetBtcNotionalUsd?: number;
  maxBtcNotionalUsd?: number;
  skewMaxBps?: number;
  cashReserveUsd?: number;
  workingCapUsd?: number;
  maxActiveOrders?: number;
  maxActionsPerLoop?: number;
  ttlSeconds?: number;
};

export type RuntimeOverridesRecord = RuntimeOverridesInput & {
  symbol: string;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number | null;
  source: string;
  note: string;
};

export type RuntimeOverridesMeta = {
  source?: string;
  note?: string;
  nowMs?: number;
};

export type RuntimeOverrideContext = {
  usdTotal?: number;
};

export type RuntimeOverrideDefaults = {
  symbol: string;
  enabled: boolean;
  allowBuy: boolean;
  allowSell: boolean;
  levelsBuy: number;
  levelsSell: number;
  levelQuoteSizeUsd: number;
  baseHalfSpreadBps: number;
  levelStepBps: number;
  minMarketSpreadBps: number;
  repriceMoveBps: number;
  queueRefreshSeconds: number;
  tobEnabled: boolean;
  tobQuoteSizeUsd: number;
  targetBtcNotionalUsd: number;
  maxBtcNotionalUsd: number;
  skewMaxBps: number;
  cashReserveUsd: number;
  workingCapUsd: number;
  maxActiveOrders: number;
  maxActionsPerLoop: number;
};

export type EffectiveRuntimeConfig = RuntimeOverrideDefaults & {
  overridesActive: boolean;
  overrideCount: number;
  activeOverrideKeys: string[];
  overrideUpdatedAtMs: number | null;
  overrideCreatedAtMs: number | null;
  overrideExpiresAtMs: number | null;
  overrideSource: string | null;
  overrideNote: string;
};

export type RuntimeOverrideValidation = {
  patch: RuntimeOverridesInput;
  warnings: string[];
  unknownKeys: string[];
};

const OVERRIDE_KEYS: ReadonlyArray<keyof RuntimeOverridesInput> = [
  "enabled",
  "allowBuy",
  "allowSell",
  "levelsBuy",
  "levelsSell",
  "levelQuoteSizeUsd",
  "baseHalfSpreadBps",
  "levelStepBps",
  "minMarketSpreadBps",
  "repriceMoveBps",
  "queueRefreshSeconds",
  "tobEnabled",
  "tobQuoteSizeUsd",
  "targetBtcNotionalUsd",
  "maxBtcNotionalUsd",
  "skewMaxBps",
  "cashReserveUsd",
  "workingCapUsd",
  "maxActiveOrders",
  "maxActionsPerLoop",
  "ttlSeconds"
];

const BOOL_KEYS = new Set<keyof RuntimeOverridesInput>([
  "enabled",
  "allowBuy",
  "allowSell",
  "tobEnabled"
]);

const NUMERIC_LIMITS: Readonly<
  Record<
    Exclude<keyof RuntimeOverridesInput, "enabled" | "allowBuy" | "allowSell" | "tobEnabled">,
    { min: number; max: number; integer?: boolean }
  >
> = {
  levelsBuy: { min: 0, max: 10, integer: true },
  levelsSell: { min: 0, max: 10, integer: true },
  levelQuoteSizeUsd: { min: 1, max: 25 },
  baseHalfSpreadBps: { min: 1, max: 50 },
  levelStepBps: { min: 1, max: 50 },
  minMarketSpreadBps: { min: 0.1, max: 20 },
  repriceMoveBps: { min: 1, max: 50 },
  queueRefreshSeconds: { min: 10, max: 600, integer: true },
  tobQuoteSizeUsd: { min: 1, max: 10 },
  targetBtcNotionalUsd: { min: 0, max: 1000 },
  maxBtcNotionalUsd: { min: 0, max: 2000 },
  skewMaxBps: { min: 0, max: 100 },
  cashReserveUsd: { min: 0, max: 2000 },
  workingCapUsd: { min: 0, max: 5000 },
  maxActiveOrders: { min: 1, max: 25, integer: true },
  maxActionsPerLoop: { min: 1, max: 20, integer: true },
  ttlSeconds: { min: 1, max: 7 * 24 * 60 * 60, integer: true }
};

export function buildRuntimeOverrideDefaults(config: BotConfig): RuntimeOverrideDefaults {
  return {
    symbol: config.symbol,
    enabled: true,
    allowBuy: true,
    allowSell: true,
    levelsBuy: config.levels,
    levelsSell: config.levels,
    levelQuoteSizeUsd: config.levelQuoteSizeUsd,
    baseHalfSpreadBps: config.baseHalfSpreadBps,
    levelStepBps: config.levelStepBps,
    minMarketSpreadBps: config.minInsideSpreadBps,
    repriceMoveBps: config.repriceMoveBps,
    queueRefreshSeconds: config.queueRefreshSeconds,
    tobEnabled: config.enableTopOfBook,
    tobQuoteSizeUsd: config.tobQuoteSizeUsd,
    targetBtcNotionalUsd: config.targetBtcNotionalUsd,
    maxBtcNotionalUsd: config.maxBtcNotionalUsd,
    skewMaxBps: config.skewMaxBps,
    cashReserveUsd: config.cashReserveUsd,
    workingCapUsd: config.workingCapUsd,
    maxActiveOrders: config.maxActiveOrders,
    maxActionsPerLoop: config.maxActionsPerLoop
  };
}

export function sanitizeRuntimeOverridesInput(
  input: Partial<Record<string, unknown>>,
  defaults: RuntimeOverrideDefaults,
  context?: RuntimeOverrideContext
): RuntimeOverrideValidation {
  const patch: RuntimeOverridesInput = {};
  const warnings: string[] = [];
  const unknownKeys: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (!OVERRIDE_KEYS.includes(rawKey as keyof RuntimeOverridesInput)) {
      unknownKeys.push(rawKey);
      continue;
    }
    const key = rawKey as keyof RuntimeOverridesInput;
    if (rawValue === undefined || rawValue === null) continue;
    if (BOOL_KEYS.has(key)) {
      if (typeof rawValue !== "boolean") {
        warnings.push(`Ignored ${key}: expected boolean`);
        continue;
      }
      (patch as Record<string, unknown>)[key] = rawValue;
      continue;
    }
    const numericKey = key as Exclude<
      keyof RuntimeOverridesInput,
      "enabled" | "allowBuy" | "allowSell" | "tobEnabled"
    >;
    const limits = NUMERIC_LIMITS[numericKey];
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      warnings.push(`Ignored ${key}: expected number`);
      continue;
    }
    const rounded = limits.integer ? Math.round(value) : value;
    const clamped = clamp(rounded, limits.min, limits.max);
    if (clamped !== rounded) {
      warnings.push(`${key} clamped to ${limits.integer ? Math.round(clamped) : clamped}`);
    }
    (patch as Record<string, unknown>)[key] = clamped;
  }

  const workingCapUsd = patch.workingCapUsd ?? defaults.workingCapUsd;
  if (patch.cashReserveUsd !== undefined) {
    let next = patch.cashReserveUsd;
    if (next > workingCapUsd) {
      next = workingCapUsd;
      warnings.push(`cashReserveUsd clamped to workingCapUsd (${workingCapUsd.toFixed(2)})`);
    }
    if (Number.isFinite(context?.usdTotal ?? Number.NaN)) {
      const usdTotal = Number(context?.usdTotal ?? 0);
      if (next > usdTotal) {
        next = Math.max(0, usdTotal);
        warnings.push(`cashReserveUsd clamped to latest usd_total (${usdTotal.toFixed(2)})`);
      }
    }
    patch.cashReserveUsd = next;
  }

  const safeTargetCap = Math.max(0, workingCapUsd);
  if (patch.targetBtcNotionalUsd !== undefined && patch.targetBtcNotionalUsd > safeTargetCap) {
    patch.targetBtcNotionalUsd = safeTargetCap;
    warnings.push(
      `targetBtcNotionalUsd clamped by workingCapUsd (${safeTargetCap.toFixed(2)})`
    );
  }

  const target =
    patch.targetBtcNotionalUsd ??
    defaults.targetBtcNotionalUsd;
  const maxCapByWorkingCap = Math.max(target, Math.min(2000, Math.max(target, workingCapUsd * 2)));
  if (patch.maxBtcNotionalUsd !== undefined) {
    let next = patch.maxBtcNotionalUsd;
    if (next < target) {
      next = target;
      warnings.push(`maxBtcNotionalUsd clamped to targetBtcNotionalUsd (${target.toFixed(2)})`);
    }
    if (next > maxCapByWorkingCap) {
      next = maxCapByWorkingCap;
      warnings.push(`maxBtcNotionalUsd clamped by workingCapUsd (${maxCapByWorkingCap.toFixed(2)})`);
    }
    patch.maxBtcNotionalUsd = next;
  }

  return {
    patch,
    warnings,
    unknownKeys
  };
}

export function mergeRuntimeOverrides(
  symbol: string,
  existing: RuntimeOverridesRecord | null,
  patchInput: Partial<Record<string, unknown>>,
  defaults: RuntimeOverrideDefaults,
  meta?: RuntimeOverridesMeta,
  context?: RuntimeOverrideContext
): { overrides: RuntimeOverridesRecord; warnings: string[]; unknownKeys: string[] } {
  const mergedInput: Partial<Record<string, unknown>> = {};
  if (existing) {
    for (const key of OVERRIDE_KEYS) {
      const value = existing[key];
      if (value !== undefined && value !== null) {
        mergedInput[key] = value;
      }
    }
  }
  for (const [key, value] of Object.entries(patchInput)) {
    mergedInput[key] = value;
  }

  const sanitized = sanitizeRuntimeOverridesInput(mergedInput, defaults, context);
  const now = meta?.nowMs ?? Date.now();
  const ttlSeconds = sanitized.patch.ttlSeconds ?? null;
  const note = normalizeNote(meta?.note ?? existing?.note ?? "");
  const source = normalizeSource(meta?.source ?? existing?.source ?? "dashboard");
  const overrides: RuntimeOverridesRecord = {
    symbol: normalizeSymbol(symbol),
    ...sanitized.patch,
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
    expiresAtMs: ttlSeconds ? now + ttlSeconds * 1000 : null,
    source,
    note
  };

  return {
    overrides,
    warnings: sanitized.warnings,
    unknownKeys: sanitized.unknownKeys
  };
}

export function isRuntimeOverrideExpired(
  overrides: RuntimeOverridesRecord | null,
  nowMs = Date.now()
): boolean {
  if (!overrides || overrides.expiresAtMs === null || overrides.expiresAtMs === undefined) {
    return false;
  }
  return overrides.expiresAtMs <= nowMs;
}

export function computeEffectiveRuntimeConfig(
  defaults: RuntimeOverrideDefaults,
  overrides: RuntimeOverridesRecord | null
): EffectiveRuntimeConfig {
  const merged: EffectiveRuntimeConfig = {
    ...defaults,
    overridesActive: false,
    overrideCount: 0,
    activeOverrideKeys: [],
    overrideUpdatedAtMs: null,
    overrideCreatedAtMs: null,
    overrideExpiresAtMs: null,
    overrideSource: null,
    overrideNote: ""
  };
  if (!overrides) return merged;

  for (const key of OVERRIDE_KEYS) {
    const value = overrides[key];
    if (value === undefined || value === null) continue;
    (merged as Record<string, unknown>)[key] = value;
    merged.activeOverrideKeys.push(String(key));
  }
  merged.overrideCount = merged.activeOverrideKeys.length;
  merged.overridesActive = merged.overrideCount > 0;
  merged.overrideUpdatedAtMs = overrides.updatedAtMs;
  merged.overrideCreatedAtMs = overrides.createdAtMs;
  merged.overrideExpiresAtMs = overrides.expiresAtMs ?? null;
  merged.overrideSource = overrides.source;
  merged.overrideNote = overrides.note;

  if (merged.cashReserveUsd > merged.workingCapUsd) {
    merged.cashReserveUsd = merged.workingCapUsd;
  }
  if (merged.targetBtcNotionalUsd > merged.workingCapUsd) {
    merged.targetBtcNotionalUsd = merged.workingCapUsd;
  }
  if (merged.maxBtcNotionalUsd < merged.targetBtcNotionalUsd) {
    merged.maxBtcNotionalUsd = merged.targetBtcNotionalUsd;
  }
  const maxCapByWorkingCap = Math.max(
    merged.targetBtcNotionalUsd,
    Math.min(2000, Math.max(merged.targetBtcNotionalUsd, merged.workingCapUsd * 2))
  );
  if (merged.maxBtcNotionalUsd > maxCapByWorkingCap) {
    merged.maxBtcNotionalUsd = maxCapByWorkingCap;
  }

  return merged;
}

export function listActiveOverrideChips(overrides: RuntimeOverridesRecord | null): string[] {
  if (!overrides) return [];
  const chips: string[] = [];
  for (const key of OVERRIDE_KEYS) {
    const value = overrides[key];
    if (value === undefined || value === null) continue;
    chips.push(`OVR: ${key}=${formatChipValue(value)}`);
  }
  return chips;
}

function formatChipValue(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "-";
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace("/", "-");
}

function normalizeNote(note: string): string {
  const trimmed = String(note ?? "").trim();
  if (trimmed.length <= 160) return trimmed;
  return trimmed.slice(0, 160);
}

function normalizeSource(source: string): string {
  const trimmed = String(source ?? "").trim();
  if (trimmed.length === 0) return "dashboard";
  if (trimmed.length <= 40) return trimmed;
  return trimmed.slice(0, 40);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
