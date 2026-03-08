import { PolymarketConfig } from "../config";

export type SpotVenueTick = {
  venue: string;
  ts: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  spreadBps: number | null;
  ok: boolean;
  error?: string;
};

export type SpotFeed = {
  fetch(symbol: string, nowTs?: number): Promise<SpotVenueTick[]>;
};

export type OrderBookLevel = {
  price: number;
  size: number;
};

export type YesOrderBook = {
  marketId: string;
  tokenId: string;
  yesBid: number;
  yesAsk: number;
  yesMid: number;
  spread: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  ts: number;
};

export type BtcWindowMarket = {
  marketId: string;
  slug: string;
  question: string;
  priceToBeat: number;
  endTs: number;
  startTs?: number;
  yesTokenId: string;
  noTokenId?: string;
  yesDisplayLabel?: string;
  noDisplayLabel?: string;
  tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
  acceptingOrders: boolean;
  active?: boolean;
  enableOrderBook?: boolean;
  closed?: boolean;
  eventSlug?: string;
  yesBidHint?: number;
  yesAskHint?: number;
  yesMidHint?: number;
  yesLastTradeHint?: number;
  outcomePricesHint?: number[];
};

export type OracleEstimate = {
  ts: number;
  oracleEst: number;
  oracleRaw: number;
  venueCount: number;
  staleRejected: number;
  outlierRejected: number;
  emaApplied: boolean;
};

export type VolEstimate = {
  sigmaPerSqrtSec: number;
  sigmaPricePerSqrtSec: number;
  sampleCount: number;
};

export type ProbInput = {
  oracleEst: number;
  priceToBeat: number;
  sigmaPricePerSqrtSec: number;
  tauSec: number;
};

export type ProbOutput = {
  pUpModel: number;
  zScore: number;
  sigmaEffPrice: number;
  tauEffSec: number;
};

export type StrategyDecision = {
  action: "BUY_YES" | "BUY_NO" | "HOLD";
  reason: string;
  edge: number;
  edgeAbs: number;
  edgeYes: number;
  edgeNo: number;
  chosenSide: "YES" | "NO";
  chosenEdge: number;
  netEdgeAfterCosts: number;
  costPenaltyProb: number;
  minEdgeThreshold: number;
  threshold: number;
  yesBid: number;
  yesAsk: number;
  yesMid: number;
  spread: number;
};

export type SizeInput = {
  edge: number;
  pUpModel: number;
  yesAsk: number;
  remainingWindowBudget: number;
  remainingExposureBudget: number;
  remainingDailyLossBudget: number;
  conviction?: number;
  remainingSec?: number;
  entryMaxRemainingSec?: number;
  depthCapNotionalUsd?: number;
};

export type SizeOutput = {
  notionalUsd: number;
  shares: number;
  kellyFraction: number;
};

export type PositionState = {
  key: string;
  marketId: string;
  tokenId: string;
  side: "YES" | "NO";
  shares: number;
  costUsd: number;
  avgPrice: number;
  updatedTs: number;
};

export type OpenOrderState = {
  localOrderId: string;
  venueOrderId?: string;
  marketId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  limitPrice: number;
  shares: number;
  notionalUsd: number;
  matchedShares?: number;
  createdTs: number;
  expiresTs: number;
  status: "NEW" | "CANCELLED" | "FILLED" | "REJECTED";
};

export type ExecutionResult = {
  action: "BUY_YES" | "BUY_NO" | "SELL_YES" | "SELL_NO" | "HOLD";
  accepted: boolean;
  filledShares: number;
  fillPrice?: number;
  orderId?: string;
  reason?: string;
};

export type RiskSnapshot = {
  killSwitch: boolean;
  openOrders: number;
  totalExposureUsd: number;
  concurrentWindows: number;
  dailyRealizedPnlUsd: number;
};

export type RiskCheckInput = {
  tauSec: number;
  oracleAgeMs: number;
  projectedOrderNotionalUsd: number;
  openOrders: number;
  totalExposureUsd: number;
  concurrentWindows: number;
};

export type RiskCheck = {
  ok: boolean;
  reason?: string;
};

export type DecisionLogLine = {
  ts: string;
  marketId: string;
  slug?: string;
  selectedSlug?: string | null;
  candidatesCount?: number;
  windowsCount?: number;
  tauSec: number;
  remainingSec?: number;
  priceToBeat: number;
  oracleEst: number;
  sigma: number;
  pUpModel: number;
  pBase?: number;
  pBoosted?: number;
  z?: number;
  d?: number;
  sigmaCalibrated?: number;
  polyUpdateAgeMs?: number;
  lagPolyP90Ms?: number;
  boostApplied?: boolean;
  boostReason?: string;
  yesBid: number;
  yesAsk: number;
  yesMid: number;
  edge: number;
  edgeYes?: number;
  edgeNo?: number;
  chosenSide?: "YES" | "NO";
  grossEdge?: number;
  chosenEdge?: number;
  conviction?: number;
  stalenessEdge?: number;
  netEdgeAfterCosts?: number;
  minEdgeThreshold?: number;
  minNetEdgeThreshold?: number;
  threshold: number;
  action: string;
  holdReason?: string;
  holdDetailReason?: string;
  size: number;
  mode: PolymarketConfig["mode"];
  openTrades?: number;
  resolvedTrades?: number;
  oracleSource?: string;
  oracleTs?: number;
  oracleStaleMs?: number;
  oracleState?: string;
  tradingPaused?: boolean;
  pauseReason?: string;
  pauseSinceTs?: number;
};
