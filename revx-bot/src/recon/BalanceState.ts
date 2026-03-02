import { BalanceSnapshot } from "../store/Store";
import { BalanceDiagnostic } from "./balanceParsing";

type MutableBalanceState = {
  raw: unknown;
  normalized: BalanceSnapshot[];
  lastFetchTs: number;
  lastError: string;
  lastVenueBalancesTs: number;
  lastVenueBalancesError: string;
  lastBalanceFetchTs: number;
  lastBalanceFetchError: string;
  lastDiagnostics: BalanceDiagnostic[];
  firstFetchAttemptCompleted: boolean;
};

export type BalanceStateSnapshot = {
  rawBalancesFromVenue: unknown;
  normalizedBalances: BalanceSnapshot[];
  lastFetchTs: number;
  lastError: string;
  lastVenueBalancesTs: number;
  lastVenueBalancesError: string;
  lastBalanceFetchTs: number;
  lastBalanceFetchError: string;
  lastDiagnostics: BalanceDiagnostic[];
  firstFetchAttemptCompleted: boolean;
};

const state: MutableBalanceState = {
  raw: { status: "not_ready" },
  normalized: [],
  lastFetchTs: 0,
  lastError: "not_ready",
  lastVenueBalancesTs: 0,
  lastVenueBalancesError: "not_ready",
  lastBalanceFetchTs: 0,
  lastBalanceFetchError: "not_ready",
  lastDiagnostics: [],
  firstFetchAttemptCompleted: false
};

let firstAttemptWaiters: Array<() => void> = [];

export const BalanceState = {
  get raw(): unknown {
    return cloneUnknown(state.raw);
  },

  get normalized(): BalanceSnapshot[] {
    return cloneBalances(state.normalized);
  },

  get lastFetchTs(): number {
    return state.lastFetchTs;
  },

  get lastError(): string {
    return state.lastError;
  },

  markRawSuccess(raw: unknown, ts?: number): void {
    const now = sanitizeTs(ts);
    state.raw = cloneUnknown(raw);
    state.lastVenueBalancesTs = now;
    state.lastVenueBalancesError = "";
  },

  markRawError(error: unknown): void {
    state.lastVenueBalancesError = toErrorMessage(error, "balance_fetch_failed");
  },

  markFetchSuccess(params: {
    normalizedBalances: BalanceSnapshot[];
    diagnostics: BalanceDiagnostic[];
    ts?: number;
  }): void {
    const now = sanitizeTs(params.ts);
    state.normalized = cloneBalances(params.normalizedBalances);
    state.lastDiagnostics = cloneDiagnostics(params.diagnostics);
    state.lastFetchTs = now;
    state.lastBalanceFetchTs = now;
    state.lastError = "";
    state.lastBalanceFetchError = "";
    markFirstAttemptComplete();
  },

  markFetchError(error: unknown, ts?: number): void {
    const now = sanitizeTs(ts);
    const message = toErrorMessage(error, "balance_fetch_failed");
    state.lastFetchTs = now;
    state.lastBalanceFetchTs = now;
    state.lastError = message;
    state.lastBalanceFetchError = message;
    markFirstAttemptComplete();
  },

  waitForFirstFetchAttempt(): Promise<void> {
    if (state.firstFetchAttemptCompleted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      firstAttemptWaiters.push(resolve);
    });
  },

  getSnapshot(): BalanceStateSnapshot {
    return {
      rawBalancesFromVenue: cloneUnknown(state.raw),
      normalizedBalances: cloneBalances(state.normalized),
      lastFetchTs: state.lastFetchTs,
      lastError: state.lastError,
      lastVenueBalancesTs: state.lastVenueBalancesTs,
      lastVenueBalancesError: state.lastVenueBalancesError,
      lastBalanceFetchTs: state.lastBalanceFetchTs,
      lastBalanceFetchError: state.lastBalanceFetchError,
      lastDiagnostics: cloneDiagnostics(state.lastDiagnostics),
      firstFetchAttemptCompleted: state.firstFetchAttemptCompleted
    };
  }
};

function markFirstAttemptComplete(): void {
  state.firstFetchAttemptCompleted = true;
  if (firstAttemptWaiters.length === 0) return;
  const waiters = firstAttemptWaiters;
  firstAttemptWaiters = [];
  for (const waiter of waiters) waiter();
}

function sanitizeTs(value?: number): number {
  const ts = Number(value);
  return Number.isFinite(ts) && ts > 0 ? ts : Date.now();
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return fallback;
}

function cloneBalances(rows: BalanceSnapshot[]): BalanceSnapshot[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    asset: String(row.asset || ""),
    free: Number(row.free) || 0,
    total: Number(row.total) || 0,
    ts: Number(row.ts) || 0
  }));
}

function cloneDiagnostics(rows: BalanceDiagnostic[]): BalanceDiagnostic[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    asset: String(row.asset || ""),
    rawAsset: String(row.rawAsset || ""),
    keys: Array.isArray(row.keys) ? row.keys.map((key) => String(key)) : [],
    availableRaw: String(row.availableRaw || ""),
    freeRaw: String(row.freeRaw || ""),
    tradableRaw: String(row.tradableRaw || ""),
    balanceRaw: String(row.balanceRaw || ""),
    totalRaw: String(row.totalRaw || ""),
    lockedRaw: String(row.lockedRaw || ""),
    parsedFree: Number(row.parsedFree) || 0,
    parsedTotal: Number(row.parsedTotal) || 0
  }));
}

function cloneUnknown<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // fall through
    }
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}
