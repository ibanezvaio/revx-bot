import { HybridSignalSnapshot } from "./SignalEngine";
import { QuoteVenue } from "./types";

export type SignalDebugSnapshot = {
  lastUpdatedTs: number;
  lastError: string | null;
  snapshot: HybridSignalSnapshot | null;
  venues: QuoteVenue[];
};

class SignalDebugState {
  private state: SignalDebugSnapshot = {
    lastUpdatedTs: 0,
    lastError: "signal not initialized",
    snapshot: null,
    venues: []
  };

  update(snapshot: HybridSignalSnapshot, venues: QuoteVenue[], error: string | null = null): void {
    this.state = {
      lastUpdatedTs: Math.max(0, Number(snapshot.ts) || Date.now()),
      lastError: error ? String(error) : null,
      snapshot: cloneSnapshot(snapshot),
      venues: venues.map((row) => ({ ...row }))
    };
  }

  setError(error: string): void {
    this.state = {
      ...this.state,
      lastError: String(error || "unknown error")
    };
  }

  getSnapshot(): SignalDebugSnapshot {
    return {
      lastUpdatedTs: this.state.lastUpdatedTs,
      lastError: this.state.lastError,
      snapshot: this.state.snapshot ? cloneSnapshot(this.state.snapshot) : null,
      venues: this.state.venues.map((row) => ({ ...row }))
    };
  }
}

export const signalDebugState = new SignalDebugState();

function cloneSnapshot(value: HybridSignalSnapshot): HybridSignalSnapshot {
  return {
    ...value,
    venues: value.venues.map((row) => ({ ...row }))
  };
}

