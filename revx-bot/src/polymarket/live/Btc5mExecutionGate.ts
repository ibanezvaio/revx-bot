import { BotConfig } from "../../config";
import { Btc5mDecision, Btc5mSelectedMarket, Btc5mTick } from "./Btc5mTypes";

type ExecutionGateInput = {
  tick: Btc5mTick;
  selected: Btc5mSelectedMarket;
  referencePrice: number | null;
};

export class Btc5mExecutionGate {
  constructor(private readonly config: BotConfig) {}

  evaluate(input: ExecutionGateInput): Btc5mDecision {
    const selected = input.selected;
    const sideBook = selected.chosenSide === "YES" ? selected.yesBook : selected.noBook;
    const sideEnabled = selected.chosenSide === "YES" ? true : this.config.polymarket.live.enableNoSide;
    const sideAsk = sideBook.bestAsk;
    const sideMid = sideBook.mid;
    const spread = Number.isFinite(Number(sideBook.spread)) ? Math.max(0, Number(sideBook.spread)) : Number.POSITIVE_INFINITY;
    const threshold = Math.max(0, Number(this.config.polymarket.live.minEdgeThreshold || 0));
    const maxSpread = Math.max(0, Number(this.config.polymarket.live.maxSpread || 0));
    const midMin = Math.max(0, Number(this.config.polymarket.live.yesMidMin || 0.0005));
    const midMax = Math.min(0.9999, Number(this.config.polymarket.live.yesMidMax || 0.9995));

    const pUpModel = inferProbability({
      referencePrice: input.referencePrice,
      priceToBeat: selected.priceToBeat,
      fallbackMid: selected.yesBook.mid
    });
    const expectedProb = selected.chosenSide === "YES" ? pUpModel : 1 - pUpModel;
    const edge = sideAsk !== null ? expectedProb - sideAsk : Number.NEGATIVE_INFINITY;

    if (!sideEnabled) {
      return holdDecision("LIVE_NO_SIDE_DISABLED", selected, threshold, spread, sideEnabled, false, sideAsk, edge, pUpModel);
    }
    if (!sideBook.bookable || !selected.orderbookOk || !selected.selectedTokenId || sideAsk === null) {
      return holdDecision("SIDE_NOT_BOOKABLE", selected, threshold, spread, sideEnabled, false, sideAsk, edge, pUpModel);
    }
    if (input.tick.remainingSec <= this.config.polymarket.live.minEntryRemainingSec) {
      return holdDecision("TOO_LATE_FOR_ENTRY", selected, threshold, spread, sideEnabled, true, sideAsk, edge, pUpModel);
    }
    if (!(sideMid !== null && sideMid >= midMin && sideMid <= midMax)) {
      return holdDecision("YES_MID_OUT_OF_RANGE", selected, threshold, spread, sideEnabled, true, sideAsk, edge, pUpModel);
    }
    if (!(spread <= maxSpread)) {
      return holdDecision("SPREAD_TOO_WIDE", selected, threshold, spread, sideEnabled, true, sideAsk, edge, pUpModel);
    }
    if (!(edge > threshold)) {
      return holdDecision("EDGE_BELOW_THRESHOLD", selected, threshold, spread, sideEnabled, true, sideAsk, edge, pUpModel);
    }

    return {
      action: selected.chosenSide === "YES" ? "BUY_YES" : "BUY_NO",
      blocker: null,
      chosenSide: selected.chosenSide,
      edge,
      threshold,
      spread,
      sideEnabled,
      orderbookOk: true,
      sideAsk,
      pUpModel
    };
  }
}

function holdDecision(
  blocker: string,
  selected: Btc5mSelectedMarket,
  threshold: number,
  spread: number,
  sideEnabled: boolean,
  orderbookOk: boolean,
  sideAsk: number | null,
  edge: number,
  pUpModel: number | null
): Btc5mDecision {
  return {
    action: "HOLD",
    blocker,
    chosenSide: selected.chosenSide,
    edge,
    threshold,
    spread,
    sideEnabled,
    orderbookOk,
    sideAsk,
    pUpModel
  };
}

function inferProbability(input: {
  referencePrice: number | null;
  priceToBeat: number | null;
  fallbackMid: number | null;
}): number {
  if (
    input.referencePrice !== null &&
    input.referencePrice > 0 &&
    input.priceToBeat !== null &&
    input.priceToBeat > 0
  ) {
    const moveRatio = (input.referencePrice - input.priceToBeat) / input.priceToBeat;
    const sigmaRatio = 0.0015;
    const z = clamp(moveRatio / sigmaRatio, -8, 8);
    return clamp(normalCdf(z), 0.0005, 0.9995);
  }
  if (input.fallbackMid !== null && input.fallbackMid > 0) {
    return clamp(input.fallbackMid, 0.0005, 0.9995);
  }
  return 0.5;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.sqrt(2)));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return sign * y;
}

