import { BotConfig } from "../../config";
import { Btc5mDecision, Btc5mSelectedMarket, Btc5mTick } from "./Btc5mTypes";

type ExecutionGateInput = {
  tick: Btc5mTick;
  selected: Btc5mSelectedMarket;
  referencePrice: number | null;
  oracleAgeMs: number | null;
};

export class Btc5mExecutionGate {
  constructor(private readonly config: BotConfig) {}

  evaluate(input: ExecutionGateInput): Btc5mDecision {
    const selected = input.selected;
    const sideBook = selected.chosenSide === "YES" ? selected.yesBook : selected.noBook;
    const sideEnabled = selected.chosenSide === "YES" ? true : this.config.polymarket.live.enableNoSide;
    const sideAsk = sideBook.bestAsk;
    const spread = Number.isFinite(Number(sideBook.spread)) ? Math.max(0, Number(sideBook.spread)) : Number.POSITIVE_INFINITY;
    const threshold = Math.max(0, Number(this.config.polymarket.live.minEdgeThreshold || 0));
    const maxSpread = Math.max(0, Number(this.config.polymarket.live.maxSpread || 0));
    const minEntryRemainingSec = Math.max(1, Number(this.config.polymarket.live.minEntryRemainingSec || 1));
    const oracleWarnMs = Math.max(0, Number(this.config.polymarket.live.oracleWarnMs || 0));
    const oracleHardBlockMs = Math.max(oracleWarnMs + 1, Number(this.config.polymarket.live.oracleHardBlockMs || 0));
    const warning = this.resolveWarning({
      sideEnabled,
      oracleAgeMs: input.oracleAgeMs,
      oracleWarnMs,
      oracleHardBlockMs
    });

    const pUpModel = inferProbability({
      referencePrice: input.referencePrice,
      priceToBeat: selected.priceToBeat,
      fallbackMid: selected.yesBook.mid
    });
    const expectedProb = selected.chosenSide === "YES" ? pUpModel : 1 - pUpModel;
    const edge = sideAsk !== null ? expectedProb - sideAsk : Number.NEGATIVE_INFINITY;

    if (!sideBook.bookable || !selected.orderbookOk || !selected.selectedTokenId || sideAsk === null) {
      return holdDecision({
        blocker: "TOKEN_NOT_BOOKABLE",
        selected,
        threshold,
        spread,
        maxSpread,
        sideEnabled,
        orderbookOk: false,
        sideAsk,
        edge,
        pUpModel,
        remainingSec: input.tick.remainingSec,
        minEntryRemainingSec,
        oracleAgeMs: input.oracleAgeMs,
        oracleWarnMs,
        oracleHardBlockMs,
        warning
      });
    }
    if (input.tick.remainingSec <= minEntryRemainingSec) {
      return holdDecision({
        blocker: "TOO_LATE_FOR_ENTRY",
        selected,
        threshold,
        spread,
        maxSpread,
        sideEnabled,
        orderbookOk: true,
        sideAsk,
        edge,
        pUpModel,
        remainingSec: input.tick.remainingSec,
        minEntryRemainingSec,
        oracleAgeMs: input.oracleAgeMs,
        oracleWarnMs,
        oracleHardBlockMs,
        warning
      });
    }
    if (!(spread <= maxSpread)) {
      return holdDecision({
        blocker: "SPREAD_TOO_WIDE",
        selected,
        threshold,
        spread,
        maxSpread,
        sideEnabled,
        orderbookOk: true,
        sideAsk,
        edge,
        pUpModel,
        remainingSec: input.tick.remainingSec,
        minEntryRemainingSec,
        oracleAgeMs: input.oracleAgeMs,
        oracleWarnMs,
        oracleHardBlockMs,
        warning
      });
    }
    if (!(edge > threshold)) {
      return holdDecision({
        blocker: "EDGE_BELOW_THRESHOLD",
        selected,
        threshold,
        spread,
        maxSpread,
        sideEnabled,
        orderbookOk: true,
        sideAsk,
        edge,
        pUpModel,
        remainingSec: input.tick.remainingSec,
        minEntryRemainingSec,
        oracleAgeMs: input.oracleAgeMs,
        oracleWarnMs,
        oracleHardBlockMs,
        warning
      });
    }

    return {
      action: selected.chosenSide === "YES" ? "BUY_YES" : "BUY_NO",
      blocker: null,
      blockerSeverity: warning ? "warning-only" : null,
      warning,
      chosenSide: selected.chosenSide,
      edge,
      threshold,
      spread,
      maxSpread,
      remainingSec: input.tick.remainingSec,
      minEntryRemainingSec,
      oracleAgeMs: input.oracleAgeMs,
      oracleWarnMs,
      oracleHardBlockMs,
      sideEnabled,
      orderbookOk: true,
      sideAsk,
      pUpModel
    };
  }

  private resolveWarning(input: {
    sideEnabled: boolean;
    oracleAgeMs: number | null;
    oracleWarnMs: number;
    oracleHardBlockMs: number;
  }): string | null {
    if (!input.sideEnabled) {
      return "LIVE_NO_SIDE_DISABLED";
    }
    if (
      input.oracleAgeMs !== null &&
      Number.isFinite(input.oracleAgeMs) &&
      input.oracleAgeMs > input.oracleWarnMs &&
      input.oracleAgeMs <= input.oracleHardBlockMs
    ) {
      return "STALE_ORACLE_WARN";
    }
    return null;
  }
}

function holdDecision(
  input: {
    blocker: string;
    selected: Btc5mSelectedMarket;
    threshold: number;
    spread: number;
    maxSpread: number;
    sideEnabled: boolean;
    orderbookOk: boolean;
    sideAsk: number | null;
    edge: number;
    pUpModel: number | null;
    remainingSec: number;
    minEntryRemainingSec: number;
    oracleAgeMs: number | null;
    oracleWarnMs: number;
    oracleHardBlockMs: number;
    warning: string | null;
  }
): Btc5mDecision {
  return {
    action: "HOLD",
    blocker: input.blocker,
    blockerSeverity: "hard",
    warning: input.warning,
    chosenSide: input.selected.chosenSide,
    edge: input.edge,
    threshold: input.threshold,
    spread: input.spread,
    maxSpread: input.maxSpread,
    remainingSec: input.remainingSec,
    minEntryRemainingSec: input.minEntryRemainingSec,
    oracleAgeMs: input.oracleAgeMs,
    oracleWarnMs: input.oracleWarnMs,
    oracleHardBlockMs: input.oracleHardBlockMs,
    sideEnabled: input.sideEnabled,
    orderbookOk: input.orderbookOk,
    sideAsk: input.sideAsk,
    pUpModel: input.pUpModel
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
