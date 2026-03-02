export type VenueBalancesDebugSnapshot = {
  lastVenueBalancesRaw: unknown;
  lastVenueBalancesTs: number;
  lastVenueBalancesError: string;
};

class VenueBalancesDebugState {
  private snapshot: VenueBalancesDebugSnapshot = {
    lastVenueBalancesRaw: { status: "not_ready" },
    lastVenueBalancesTs: 0,
    lastVenueBalancesError: "not_ready"
  };

  markSuccess(raw: unknown, ts?: number): void {
    const now = Number.isFinite(ts ?? Number.NaN) ? Math.max(0, Number(ts)) : Date.now();
    this.snapshot = {
      lastVenueBalancesRaw: cloneUnknown(raw),
      lastVenueBalancesTs: now,
      lastVenueBalancesError: ""
    };
  }

  markError(error: unknown, ts?: number): void {
    const now = Number.isFinite(ts ?? Number.NaN) ? Math.max(0, Number(ts)) : Date.now();
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "balance_fetch_failed";
    this.snapshot = {
      ...this.snapshot,
      lastVenueBalancesTs: now,
      lastVenueBalancesError: message
    };
  }

  getSnapshot(): VenueBalancesDebugSnapshot {
    return {
      lastVenueBalancesRaw: cloneUnknown(this.snapshot.lastVenueBalancesRaw),
      lastVenueBalancesTs: this.snapshot.lastVenueBalancesTs,
      lastVenueBalancesError: this.snapshot.lastVenueBalancesError
    };
  }
}

export const venueBalancesDebugState = new VenueBalancesDebugState();

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
