import { BalanceDiagnostic } from "./balanceParsing";
import { BalanceSnapshot } from "../store/Store";

export type BalanceDebugSnapshot = {
  lastVenueBalancesRaw: unknown;
  lastNormalizedBalances: BalanceSnapshot[];
  lastDiagnostics: BalanceDiagnostic[];
  lastBalanceFetchTs: number | null;
  lastBalanceFetchError: string | null;
};

class BalanceDebugState {
  private snapshot: BalanceDebugSnapshot = {
    lastVenueBalancesRaw: null,
    lastNormalizedBalances: [],
    lastDiagnostics: [],
    lastBalanceFetchTs: null,
    lastBalanceFetchError: null
  };

  updateSuccess(params: {
    raw: unknown;
    normalizedBalances: BalanceSnapshot[];
    diagnostics: BalanceDiagnostic[];
    ts: number;
  }): void {
    this.snapshot = {
      lastVenueBalancesRaw: cloneUnknown(params.raw),
      lastNormalizedBalances: cloneBalances(params.normalizedBalances),
      lastDiagnostics: cloneDiagnostics(params.diagnostics),
      lastBalanceFetchTs: Number.isFinite(params.ts) ? Math.max(0, params.ts) : Date.now(),
      lastBalanceFetchError: null
    };
  }

  updateError(error: unknown, ts: number): void {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "balance fetch failed";
    this.snapshot = {
      ...this.snapshot,
      lastBalanceFetchTs: Number.isFinite(ts) ? Math.max(0, ts) : Date.now(),
      lastBalanceFetchError: message
    };
  }

  getSnapshot(): BalanceDebugSnapshot {
    return {
      lastVenueBalancesRaw: cloneUnknown(this.snapshot.lastVenueBalancesRaw),
      lastNormalizedBalances: cloneBalances(this.snapshot.lastNormalizedBalances),
      lastDiagnostics: cloneDiagnostics(this.snapshot.lastDiagnostics),
      lastBalanceFetchTs: this.snapshot.lastBalanceFetchTs,
      lastBalanceFetchError: this.snapshot.lastBalanceFetchError
    };
  }
}

export const balanceDebugState = new BalanceDebugState();

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
      // fallback to JSON clone
    }
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}
