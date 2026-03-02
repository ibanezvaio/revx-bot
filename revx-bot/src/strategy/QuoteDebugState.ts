import { NormalizedBalances } from "./balances/normalizeBalances";

export type QuotePlan = {
  quoteEnabled: boolean;
  hardHalt: boolean;
  hardHaltReasons: string[];
  blockedReasons: string[];
  buyLevels: number;
  sellLevels: number;
  tob: "OFF" | "BUY" | "SELL" | "BOTH";
  newsState?: "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE";
  newsImpact?: number;
  newsDirection?: "UP" | "DOWN" | "NEUTRAL";
  newsConfidence?: number;
  newsReasons?: string[];
  signalsState?: "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE";
  signalsImpact?: number;
  signalsDirection?: "UP" | "DOWN" | "NEUTRAL";
  signalsConfidence?: number;
  signalsReasons?: string[];
  adverseState?: "NORMAL" | "WIDEN" | "REDUCE" | "PAUSE" | "HEDGE";
  toxicityScore?: number;
  adverseReasons?: string[];
  seedMode?: "SEED_BUY" | "ACCUMULATE_BTC" | "TWO_SIDED" | "REBALANCE";
  seedReason?: string;
  seedProgress?: {
    btcNotionalUsd: number;
    lowGateUsd: number;
    targetUsd: number;
  };
  regime?: "CALM" | "TREND" | "VOLATILE" | "CRISIS";
  bias?: "LONG" | "SHORT" | "NEUTRAL";
  biasConfidence?: number;
  signalConfidence?: number;
  globalMid?: number;
  fairMid?: number;
  basisBps?: number;
  dispersionBps?: number;
  marketPhase?: "SHOCK" | "COOLDOWN" | "STABILIZING" | "RECOVERY";
  phaseReasons?: string[];
  phaseSinceTs?: number;
  shockVolPeakBps?: number;
  shockState?: "NORMAL" | "SHOCK" | "COOLDOWN" | "REENTRY";
  shockReasons?: string[];
  shockSinceTs?: number;
};

export type QuoteInputs = {
  ts: number;
  symbol: string;
  mid: number;
  bid: number;
  ask: number;
  marketSpreadBps: number;
  volMoveBps: number;
  trendMoveBps: number;
  usdFree: number;
  usdTotal: number;
  btcFree: number;
  btcTotal: number;
  btcNotionalUsd: number;
  inventoryRatio: number;
  signals?: {
    state: "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE";
    impact: number;
    direction: "UP" | "DOWN" | "NEUTRAL";
    confidence: number;
    reasons: string[];
    latestTs: number;
  };
  config: {
    levels: number;
    enableTopOfBook: boolean;
    minInsideSpreadBps: number;
    minVolMoveBpsToQuote: number;
    volProtectMode: string;
    cashReserveUsd: number;
    workingCapUsd: number;
    targetBtcNotionalUsd: number;
    lowBtcGateUsd: number;
    maxActionsPerLoop: number;
    maxBtcNotionalUsd?: number | null;
    seedForceTob?: boolean;
    seedEnabled?: boolean;
    minBtcNotionalUsd?: number;
    seedTargetBtcNotionalUsd?: number;
    allowBuy?: boolean;
    allowSell?: boolean;
    minLevelsFloorEnabled?: boolean;
    minLevelsFloorBuy?: number;
    minLevelsFloorSell?: number;
    pauseImpactThreshold?: number;
    pauseConfidenceThreshold?: number;
    pausePersistenceSeconds?: number;
  };
};

export type QuoteDebugSnapshot = {
  lastPlan: QuotePlan | null;
  lastInputs: QuoteInputs | null;
  normalizedBalancesUsed: NormalizedBalances | null;
  lastUpdatedTs: number;
  bootError: string | null;
};

class QuoteDebugState {
  private snapshot: QuoteDebugSnapshot = {
    lastPlan: null,
    lastInputs: null,
    normalizedBalancesUsed: null,
    lastUpdatedTs: 0,
    bootError: "Quote planner has not completed its first cycle yet."
  };

  update(
    plan: QuotePlan,
    inputs: QuoteInputs,
    updatedTs?: number,
    normalizedBalancesUsed?: NormalizedBalances | null
  ): void {
    const ts = Number.isFinite(updatedTs ?? Number.NaN) ? Number(updatedTs) : Date.now();
    this.snapshot = {
      lastPlan: clonePlan(plan),
      lastInputs: cloneInputs(inputs),
      normalizedBalancesUsed: cloneNormalizedBalances(normalizedBalancesUsed ?? null),
      lastUpdatedTs: Math.max(0, ts),
      bootError: this.snapshot.bootError
    };
  }

  setBootError(error: string | null): void {
    this.snapshot = {
      ...this.snapshot,
      bootError: error ? String(error) : null
    };
  }

  getSnapshot(): QuoteDebugSnapshot {
    return {
      lastPlan: this.snapshot.lastPlan ? clonePlan(this.snapshot.lastPlan) : null,
      lastInputs: this.snapshot.lastInputs ? cloneInputs(this.snapshot.lastInputs) : null,
      normalizedBalancesUsed: cloneNormalizedBalances(this.snapshot.normalizedBalancesUsed),
      lastUpdatedTs: this.snapshot.lastUpdatedTs,
      bootError: this.snapshot.bootError
    };
  }
}

export const quoteDebugState = new QuoteDebugState();

function clonePlan(plan: QuotePlan): QuotePlan {
  return {
    quoteEnabled: Boolean(plan.quoteEnabled),
    hardHalt: Boolean(plan.hardHalt),
    hardHaltReasons: Array.isArray(plan.hardHaltReasons)
      ? plan.hardHaltReasons.map((row) => String(row))
      : [],
    blockedReasons: Array.isArray(plan.blockedReasons)
      ? plan.blockedReasons.map((row) => String(row))
      : [],
    buyLevels: Math.max(0, Math.floor(Number(plan.buyLevels) || 0)),
    sellLevels: Math.max(0, Math.floor(Number(plan.sellLevels) || 0)),
    tob:
      plan.tob === "BUY" || plan.tob === "SELL" || plan.tob === "BOTH"
        ? plan.tob
        : "OFF",
    newsState:
      plan.newsState === "NORMAL" ||
      plan.newsState === "CAUTION" ||
      plan.newsState === "RISK_OFF" ||
      plan.newsState === "RISK_ON" ||
      plan.newsState === "PAUSE"
        ? plan.newsState
        : undefined,
    newsImpact: Number.isFinite(Number(plan.newsImpact)) ? Number(plan.newsImpact) : undefined,
    newsDirection:
      plan.newsDirection === "UP" ||
      plan.newsDirection === "DOWN" ||
      plan.newsDirection === "NEUTRAL"
        ? plan.newsDirection
        : undefined,
    newsConfidence: Number.isFinite(Number(plan.newsConfidence)) ? Number(plan.newsConfidence) : undefined,
    newsReasons: Array.isArray(plan.newsReasons)
      ? plan.newsReasons.map((row) => String(row))
      : undefined,
    signalsState:
      plan.signalsState === "NORMAL" ||
      plan.signalsState === "CAUTION" ||
      plan.signalsState === "RISK_OFF" ||
      plan.signalsState === "RISK_ON" ||
      plan.signalsState === "PAUSE"
        ? plan.signalsState
        : undefined,
    signalsImpact: Number.isFinite(Number(plan.signalsImpact)) ? Number(plan.signalsImpact) : undefined,
    signalsDirection:
      plan.signalsDirection === "UP" ||
      plan.signalsDirection === "DOWN" ||
      plan.signalsDirection === "NEUTRAL"
        ? plan.signalsDirection
        : undefined,
    signalsConfidence: Number.isFinite(Number(plan.signalsConfidence))
      ? Number(plan.signalsConfidence)
      : undefined,
    signalsReasons: Array.isArray(plan.signalsReasons)
      ? plan.signalsReasons.map((row) => String(row))
      : undefined,
    seedMode:
      plan.seedMode === "SEED_BUY" ||
      plan.seedMode === "ACCUMULATE_BTC" ||
      plan.seedMode === "REBALANCE" ||
      plan.seedMode === "TWO_SIDED"
        ? plan.seedMode
        : undefined,
    seedReason: typeof plan.seedReason === "string" ? plan.seedReason : undefined,
    seedProgress:
      plan.seedProgress &&
      Number.isFinite(Number(plan.seedProgress.btcNotionalUsd)) &&
      Number.isFinite(Number(plan.seedProgress.lowGateUsd)) &&
      Number.isFinite(Number(plan.seedProgress.targetUsd))
        ? {
            btcNotionalUsd: Number(plan.seedProgress.btcNotionalUsd),
            lowGateUsd: Number(plan.seedProgress.lowGateUsd),
            targetUsd: Number(plan.seedProgress.targetUsd)
          }
        : undefined,
    adverseState:
      plan.adverseState === "NORMAL" ||
      plan.adverseState === "WIDEN" ||
      plan.adverseState === "REDUCE" ||
      plan.adverseState === "PAUSE" ||
      plan.adverseState === "HEDGE"
        ? plan.adverseState
        : undefined,
    toxicityScore: Number.isFinite(Number(plan.toxicityScore)) ? Number(plan.toxicityScore) : undefined,
    adverseReasons: Array.isArray(plan.adverseReasons)
      ? plan.adverseReasons.map((row) => String(row))
      : undefined,
    regime:
      plan.regime === "CALM" ||
      plan.regime === "TREND" ||
      plan.regime === "VOLATILE" ||
      plan.regime === "CRISIS"
        ? plan.regime
        : undefined,
    bias:
      plan.bias === "LONG" || plan.bias === "SHORT" || plan.bias === "NEUTRAL"
        ? plan.bias
        : undefined,
    biasConfidence: Number.isFinite(Number(plan.biasConfidence)) ? Number(plan.biasConfidence) : undefined,
    signalConfidence: Number.isFinite(Number(plan.signalConfidence)) ? Number(plan.signalConfidence) : undefined,
    globalMid: Number.isFinite(Number(plan.globalMid)) ? Number(plan.globalMid) : undefined,
    fairMid: Number.isFinite(Number(plan.fairMid)) ? Number(plan.fairMid) : undefined,
    basisBps: Number.isFinite(Number(plan.basisBps)) ? Number(plan.basisBps) : undefined,
    dispersionBps: Number.isFinite(Number(plan.dispersionBps)) ? Number(plan.dispersionBps) : undefined,
    marketPhase:
      plan.marketPhase === "SHOCK" ||
      plan.marketPhase === "COOLDOWN" ||
      plan.marketPhase === "STABILIZING" ||
      plan.marketPhase === "RECOVERY"
        ? plan.marketPhase
        : undefined,
    phaseReasons: Array.isArray(plan.phaseReasons)
      ? plan.phaseReasons.map((row) => String(row))
      : undefined,
    phaseSinceTs: Number.isFinite(Number(plan.phaseSinceTs))
      ? Math.max(0, Number(plan.phaseSinceTs))
      : undefined,
    shockVolPeakBps: Number.isFinite(Number(plan.shockVolPeakBps))
      ? Math.max(0, Number(plan.shockVolPeakBps))
      : undefined,
    shockState:
      plan.shockState === "NORMAL" ||
      plan.shockState === "SHOCK" ||
      plan.shockState === "COOLDOWN" ||
      plan.shockState === "REENTRY"
        ? plan.shockState
        : undefined,
    shockReasons: Array.isArray(plan.shockReasons)
      ? plan.shockReasons.map((row) => String(row))
      : undefined,
    shockSinceTs: Number.isFinite(Number(plan.shockSinceTs))
      ? Math.max(0, Number(plan.shockSinceTs))
      : undefined
  };
}

function cloneInputs(inputs: QuoteInputs): QuoteInputs {
  return {
    ts: Number(inputs.ts) || 0,
    symbol: String(inputs.symbol || ""),
    mid: Number(inputs.mid) || 0,
    bid: Number(inputs.bid) || 0,
    ask: Number(inputs.ask) || 0,
    marketSpreadBps: Number(inputs.marketSpreadBps) || 0,
    volMoveBps: Number(inputs.volMoveBps) || 0,
    trendMoveBps: Number(inputs.trendMoveBps) || 0,
    usdFree: Number(inputs.usdFree) || 0,
    usdTotal: Number(inputs.usdTotal) || 0,
    btcFree: Number(inputs.btcFree) || 0,
    btcTotal: Number(inputs.btcTotal) || 0,
    btcNotionalUsd: Number(inputs.btcNotionalUsd) || 0,
    inventoryRatio: Number(inputs.inventoryRatio) || 0,
    signals:
      inputs.signals &&
      (inputs.signals.state === "NORMAL" ||
        inputs.signals.state === "CAUTION" ||
        inputs.signals.state === "RISK_OFF" ||
        inputs.signals.state === "RISK_ON" ||
        inputs.signals.state === "PAUSE")
        ? {
            state: inputs.signals.state,
            impact: Number(inputs.signals.impact) || 0,
            direction:
              inputs.signals.direction === "UP" ||
              inputs.signals.direction === "DOWN" ||
              inputs.signals.direction === "NEUTRAL"
                ? inputs.signals.direction
                : "NEUTRAL",
            confidence: Number(inputs.signals.confidence) || 0,
            reasons: Array.isArray(inputs.signals.reasons)
              ? inputs.signals.reasons.map((row) => String(row))
              : [],
            latestTs: Number(inputs.signals.latestTs) || 0
          }
        : undefined,
    config: {
      levels: Math.max(0, Math.floor(Number(inputs.config?.levels) || 0)),
      enableTopOfBook: Boolean(inputs.config?.enableTopOfBook),
      minInsideSpreadBps: Number(inputs.config?.minInsideSpreadBps) || 0,
      minVolMoveBpsToQuote: Number(inputs.config?.minVolMoveBpsToQuote) || 0,
      volProtectMode: String(inputs.config?.volProtectMode || "widen"),
      cashReserveUsd: Number(inputs.config?.cashReserveUsd) || 0,
      workingCapUsd: Number(inputs.config?.workingCapUsd) || 0,
      targetBtcNotionalUsd: Number(inputs.config?.targetBtcNotionalUsd) || 0,
      lowBtcGateUsd: Number(inputs.config?.lowBtcGateUsd) || 0,
      maxActionsPerLoop: Math.max(0, Math.floor(Number(inputs.config?.maxActionsPerLoop) || 0)),
      maxBtcNotionalUsd: Number.isFinite(Number(inputs.config?.maxBtcNotionalUsd))
        ? Number(inputs.config?.maxBtcNotionalUsd)
        : null,
      minBtcNotionalUsd: Number.isFinite(Number(inputs.config?.minBtcNotionalUsd))
        ? Math.max(0, Number(inputs.config?.minBtcNotionalUsd))
        : undefined,
      seedTargetBtcNotionalUsd: Number.isFinite(Number(inputs.config?.seedTargetBtcNotionalUsd))
        ? Math.max(0, Number(inputs.config?.seedTargetBtcNotionalUsd))
        : undefined,
      seedForceTob: Boolean(inputs.config?.seedForceTob),
      seedEnabled: typeof inputs.config?.seedEnabled === "boolean" ? inputs.config.seedEnabled : true,
      allowBuy: typeof inputs.config?.allowBuy === "boolean" ? inputs.config.allowBuy : true,
      allowSell: typeof inputs.config?.allowSell === "boolean" ? inputs.config.allowSell : true,
      minLevelsFloorEnabled:
        typeof inputs.config?.minLevelsFloorEnabled === "boolean"
          ? inputs.config.minLevelsFloorEnabled
          : true,
      minLevelsFloorBuy: Number.isFinite(Number(inputs.config?.minLevelsFloorBuy))
        ? Math.max(0, Math.floor(Number(inputs.config?.minLevelsFloorBuy)))
        : 1,
      minLevelsFloorSell: Number.isFinite(Number(inputs.config?.minLevelsFloorSell))
        ? Math.max(0, Math.floor(Number(inputs.config?.minLevelsFloorSell)))
        : 1,
      pauseImpactThreshold: Number.isFinite(Number(inputs.config?.pauseImpactThreshold))
        ? Number(inputs.config?.pauseImpactThreshold)
        : undefined,
      pauseConfidenceThreshold: Number.isFinite(Number(inputs.config?.pauseConfidenceThreshold))
        ? Number(inputs.config?.pauseConfidenceThreshold)
        : undefined,
      pausePersistenceSeconds: Number.isFinite(Number(inputs.config?.pausePersistenceSeconds))
        ? Math.max(0, Math.floor(Number(inputs.config?.pausePersistenceSeconds)))
        : undefined
    }
  };
}

function cloneNormalizedBalances(
  value: NormalizedBalances | null | undefined
): NormalizedBalances | null {
  if (!value) return null;
  return {
    ts: Number(value.ts) || 0,
    baseAsset: String(value.baseAsset || "BTC"),
    quoteAsset: String(value.quoteAsset || "USD"),
    usdFree: Number(value.usdFree) || 0,
    usdTotal: Number(value.usdTotal) || 0,
    btcFree: Number(value.btcFree) || 0,
    btcTotal: Number(value.btcTotal) || 0,
    btcNotionalUsd: Number(value.btcNotionalUsd) || 0,
    equityUsd: Number(value.equityUsd) || 0
  };
}
