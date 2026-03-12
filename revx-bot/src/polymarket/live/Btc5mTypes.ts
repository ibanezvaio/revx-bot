import { Btc5mTickContext } from "../btc5m";

export type Btc5mTick = Btc5mTickContext;

export type Btc5mSide = "YES" | "NO";

export type Btc5mSideBook = {
  side: Btc5mSide;
  tokenId: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  quoteTs: number | null;
  bookable: boolean;
  reason: string | null;
};

export type Btc5mSelectedMarket = {
  marketId: string;
  slug: string;
  question: string;
  priceToBeat: number | null;
  startTs: number | null;
  endTs: number | null;
  remainingSec: number;
  tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
  chosenSide: Btc5mSide | null;
  selectedTokenId: string | null;
  yesTokenId: string | null;
  noTokenId: string | null;
  yesBook: Btc5mSideBook;
  noBook: Btc5mSideBook;
  selectionSource: "current_slug" | "next_slug" | "prev_slug";
  orderbookOk: boolean;
};

export type Btc5mSelectionResult = {
  tick: Btc5mTick;
  attemptedSlugs: string[];
  candidatesBeforeFilter: number;
  candidatesAfterFilter: number;
  droppedExtreme: number;
  droppedWideSpread: number;
  droppedInvalid: number;
  selected: Btc5mSelectedMarket | null;
  reason: string;
};

export type Btc5mDecisionAction = "BUY_YES" | "BUY_NO" | "HOLD";

export type Btc5mIntelligence = {
  source: string;
  posture: string | null;
  score: number | null;
  pUpModel: number;
  fallbackUsed: boolean;
  rawSignalScore?: number | null;
  intelScore?: number | null;
  crossVenueBiasScore?: number | null;
  baseProbability?: number | null;
};

export type Btc5mDecision = {
  action: Btc5mDecisionAction;
  blocker: string | null;
  blockerSeverity: "hard" | "warning-only" | null;
  warning: string | null;
  chosenSide: Btc5mSide | null;
  edge: number;
  yesEdge: number;
  noEdge: number;
  threshold: number;
  spread: number;
  yesSpread: number;
  noSpread: number;
  maxSpread: number;
  remainingSec: number;
  minEntryRemainingSec: number;
  oracleAgeMs: number | null;
  oracleWarnMs: number;
  oracleHardBlockMs: number;
  intelligenceSource: string;
  intelligencePosture: string | null;
  intelligenceScore: number | null;
  sideEnabled: boolean;
  orderbookOk: boolean;
  sideAsk: number | null;
  fairYes?: number | null;
  chosenSidePriceUsed?: number | null;
  dislocationAbs?: number | null;
  minDislocationConfig?: number;
  extremePriceFilterHit?: boolean;
  pUpModel: number | null;
  pDownModel: number | null;
  edgeMath?: {
    selectedSlug: string | null;
    sideConsidered: "YES" | "NO" | "BOTH";
    pUpModel: number | null;
    yesAsk: number | null;
    noAsk: number | null;
    yesSpread: number | null;
    noSpread: number | null;
    maxSpreadConfig: number | null;
    minEdgeThresholdConfig: number | null;
    takerFeeBps: number | null;
    takerSlipBps: number | null;
    safetyBps: number | null;
    edgeSafetyBps: number | null;
    computedYesEdgeRaw: number | null;
    computedNoEdgeRaw: number | null;
    computedYesEdgeNet: number | null;
    computedNoEdgeNet: number | null;
    chosenEdgeBeforeClamp: number | null;
    chosenEdgeAfterClamp: number | null;
    fairYes: number | null;
    fairNo: number | null;
    yesDislocationAbs: number | null;
    noDislocationAbs: number | null;
    minDislocationConfig: number | null;
    yesExtremePriceHit: boolean;
    noExtremePriceHit: boolean;
    extremePriceMinConfig: number | null;
    extremePriceMaxConfig: number | null;
    clampReason: "NONE" | "NEGATIVE" | "SPREAD_BLOCK" | "ORACLE_BLOCK" | "NO_BOOK" | "OTHER";
    chosenBlocker: string | null;
    gateDecision: "ALLOW" | "HOLD";
  };
};
