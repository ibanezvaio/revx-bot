import { AdverseSelectionDecision } from "./AdverseSelectionGuard";

export type AdverseDebugSnapshot = {
  lastUpdatedTs: number;
  state: AdverseSelectionDecision;
  lastError: string | null;
};

const EMPTY_DECISION: AdverseSelectionDecision = {
  ts: 0,
  toxicityScore: 0,
  state: "NORMAL",
  recommendedSpreadMult: 1,
  recommendedSkewBps: 0,
  allowBuy: null,
  allowSell: null,
  takerHedgeAllowed: false,
  reasons: ["NOT_READY"],
  markoutAvgBps: 0,
  markoutCount: 0,
  adverseSpreadMult: 1
};

class AdverseDebugState {
  private snapshot: AdverseDebugSnapshot = {
    lastUpdatedTs: 0,
    state: { ...EMPTY_DECISION, reasons: [...EMPTY_DECISION.reasons] },
    lastError: "adverse guard not initialized"
  };

  update(decision: AdverseSelectionDecision): void {
    this.snapshot = {
      lastUpdatedTs: Math.max(0, Number(decision.ts) || Date.now()),
      state: {
        ...decision,
        reasons: Array.isArray(decision.reasons) ? [...decision.reasons] : []
      },
      lastError: null
    };
  }

  setError(message: string): void {
    this.snapshot = {
      ...this.snapshot,
      lastError: String(message || "unknown error")
    };
  }

  getSnapshot(): AdverseDebugSnapshot {
    return {
      lastUpdatedTs: this.snapshot.lastUpdatedTs,
      state: {
        ...this.snapshot.state,
        reasons: [...this.snapshot.state.reasons]
      },
      lastError: this.snapshot.lastError
    };
  }
}

export const adverseDebugState = new AdverseDebugState();

