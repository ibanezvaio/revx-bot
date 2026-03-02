export type AnalysisWindowKey = "1h" | "24h" | "7d";

export type PersistedFillRow = {
  id: string;
  ts: number;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  base_qty: number;
  quote_qty: number;
  fee_usd: number;
  order_id: string;
  client_order_id: string;
  posture: string;
  revx_mid_at_fill: number;
  source_json: string;
};

export type MidSnapshotRow = {
  ts: number;
  symbol: string;
  revx_bid: number;
  revx_ask: number;
  revx_mid: number;
};

export type AnalysisSummary = {
  window: AnalysisWindowKey;
  ts: number;
  fillsCount: number;
  fillsPerHour: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  netPnlUsd: number;
  avgEdgeBps: number;
  medianEdgeBps: number;
  avgEdgeBpsBuy: number;
  avgEdgeBpsSell: number;
  avgToxBps30s: number;
  avgToxBps2m: number;
  toxicPct30s: number;
  toxP10Bps30s: number;
  avgInventoryNotionalUsdAbs: number;
  inventoryAboveThresholdPct: number;
  inventorySkewDirection: "LONG" | "SHORT" | "NEUTRAL";
  avgHoldSeconds: number;
  cancelReplaceRatio: number;
  latestMid: number;
  computedAtTs: number;
};

export type FillAnalysisRow = {
  id: string;
  ts: number;
  side: "BUY" | "SELL";
  price: number;
  baseQty: number;
  quoteQty: number;
  feeUsd: number;
  orderId: string;
  clientOrderId: string;
  posture: string;
  revxMidAtFill: number;
  edgeBps: number | null;
  toxBps30s: number | null;
  toxBps2m: number | null;
};

export type EquityPoint = {
  ts: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  netPnlUsd: number;
  inventoryBase: number;
  mid: number;
};

export type AdaptiveQuoteMode = "JOIN_TOB" | "STEP_BACK";

export type AdaptiveParams = {
  quoteMode: AdaptiveQuoteMode;
  baseSpreadTicks: number;
  sizeMultiplier: number;
  levels: number;
  minRestSeconds: number;
};

export type AdaptiveDecision = {
  ts: number;
  action: "NONE" | "DEFENSIVE" | "COMPETITIVE" | "STABILIZE";
  reason: string;
  before: AdaptiveParams;
  after: AdaptiveParams;
  metrics: {
    avgEdgeBps: number;
    avgToxBps30s: number;
    toxicPct30s: number;
    fillsPerHour: number;
    netPnlUsd24h: number;
    inventoryNotionalUsdAbs: number;
    posture: string;
  };
};

export type AdaptiveStatus = {
  enabled: boolean;
  ts: number;
  currentParams: AdaptiveParams;
  lastDecision: AdaptiveDecision | null;
  lastEventTs: number;
  lastEventReason: string;
  guardrails: {
    posture: string;
    hardLimited: boolean;
  };
};

