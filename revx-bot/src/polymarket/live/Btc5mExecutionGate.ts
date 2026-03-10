import { BotConfig } from "../../config";
import { Btc5mDecision, Btc5mIntelligence, Btc5mSelectedMarket, Btc5mTick } from "./Btc5mTypes";

type ExecutionGateInput = {
  tick: Btc5mTick;
  selected: Btc5mSelectedMarket;
  intelligence: Btc5mIntelligence;
  oracleAgeMs: number | null;
};

export class Btc5mExecutionGate {
  constructor(private readonly config: BotConfig) {}

  evaluate(input: ExecutionGateInput): Btc5mDecision {
    const selected = input.selected;
    const yesBook = selected.yesBook;
    const noBook = selected.noBook;
    const yesAsk = yesBook.bestAsk;
    const noAsk = noBook.bestAsk;
    const yesSpread = sanitizeSpread(yesBook.spread);
    const noSpread = sanitizeSpread(noBook.spread);
    const sideEnabled = this.config.polymarket.live.enableNoSide;
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

    const pUpModel = clamp(input.intelligence.pUpModel, 0.0005, 0.9995);
    const pDownModel = clamp(1 - pUpModel, 0.0005, 0.9995);

    const yesBookable = Boolean(selected.yesTokenId && yesBook.bookable && selected.orderbookOk && yesAsk !== null);
    const noBookable = Boolean(selected.noTokenId && noBook.bookable && selected.orderbookOk && noAsk !== null && sideEnabled);

    if (!yesBookable && !noBookable) {
      return holdDecision({
        blocker: "TOKEN_NOT_BOOKABLE",
        selected,
        threshold,
        yesSpread,
        noSpread,
        maxSpread,
        sideEnabled,
        orderbookOk: false,
        sideAsk: null,
        pUpModel,
        pDownModel,
        yesEdge: Number.NEGATIVE_INFINITY,
        noEdge: Number.NEGATIVE_INFINITY,
        edge: Number.NEGATIVE_INFINITY,
        remainingSec: input.tick.remainingSec,
        minEntryRemainingSec,
        oracleAgeMs: input.oracleAgeMs,
        oracleWarnMs,
        oracleHardBlockMs,
        warning,
        chosenSide: null,
        intelligence: input.intelligence
      });
    }

    if (input.tick.remainingSec <= minEntryRemainingSec) {
      return holdDecision({
        blocker: "TOO_LATE_FOR_ENTRY",
        selected,
        threshold,
        yesSpread,
        noSpread,
        maxSpread,
        sideEnabled,
        orderbookOk: true,
        sideAsk: null,
        pUpModel,
        pDownModel,
        yesEdge: Number.NEGATIVE_INFINITY,
        noEdge: Number.NEGATIVE_INFINITY,
        edge: Number.NEGATIVE_INFINITY,
        remainingSec: input.tick.remainingSec,
        minEntryRemainingSec,
        oracleAgeMs: input.oracleAgeMs,
        oracleWarnMs,
        oracleHardBlockMs,
        warning,
        chosenSide: null,
        intelligence: input.intelligence
      });
    }

    const yesSpreadOk = yesBookable && yesSpread <= maxSpread;
    const noSpreadOk = noBookable && noSpread <= maxSpread;
    if (!yesSpreadOk && !noSpreadOk) {
      return holdDecision({
        blocker: "SPREAD_TOO_WIDE",
        selected,
        threshold,
        yesSpread,
        noSpread,
        maxSpread,
        sideEnabled,
        orderbookOk: true,
        sideAsk: null,
        pUpModel,
        pDownModel,
        yesEdge: Number.NEGATIVE_INFINITY,
        noEdge: Number.NEGATIVE_INFINITY,
        edge: Number.NEGATIVE_INFINITY,
        remainingSec: input.tick.remainingSec,
        minEntryRemainingSec,
        oracleAgeMs: input.oracleAgeMs,
        oracleWarnMs,
        oracleHardBlockMs,
        warning,
        chosenSide: null,
        intelligence: input.intelligence
      });
    }

    const yesEdge = yesSpreadOk && yesAsk !== null ? pUpModel - yesAsk : Number.NEGATIVE_INFINITY;
    const noEdge = noSpreadOk && noAsk !== null ? pDownModel - noAsk : Number.NEGATIVE_INFINITY;

    const yesWins = yesEdge >= noEdge;
    const bestSide = yesWins ? "YES" : "NO";
    const bestEdge = yesWins ? yesEdge : noEdge;
    const bestSpread = yesWins ? yesSpread : noSpread;
    const bestAsk = yesWins ? yesAsk : noAsk;

    if (!(bestEdge > threshold)) {
      return holdDecision({
        blocker: "EDGE_BELOW_THRESHOLD",
        selected,
        threshold,
        yesSpread,
        noSpread,
        maxSpread,
        sideEnabled,
        orderbookOk: true,
        sideAsk: bestAsk,
        pUpModel,
        pDownModel,
        yesEdge,
        noEdge,
        edge: bestEdge,
        remainingSec: input.tick.remainingSec,
        minEntryRemainingSec,
        oracleAgeMs: input.oracleAgeMs,
        oracleWarnMs,
        oracleHardBlockMs,
        warning,
        chosenSide: null,
        intelligence: input.intelligence
      });
    }

    return {
      action: bestSide === "YES" ? "BUY_YES" : "BUY_NO",
      blocker: null,
      blockerSeverity: warning ? "warning-only" : null,
      warning,
      chosenSide: bestSide,
      edge: bestEdge,
      yesEdge,
      noEdge,
      threshold,
      spread: bestSpread,
      yesSpread,
      noSpread,
      maxSpread,
      remainingSec: input.tick.remainingSec,
      minEntryRemainingSec,
      oracleAgeMs: input.oracleAgeMs,
      oracleWarnMs,
      oracleHardBlockMs,
      intelligenceSource: input.intelligence.source,
      intelligencePosture: input.intelligence.posture,
      intelligenceScore: input.intelligence.score,
      sideEnabled,
      orderbookOk: true,
      sideAsk: bestAsk,
      pUpModel,
      pDownModel
    };
  }

  private resolveWarning(input: {
    sideEnabled: boolean;
    oracleAgeMs: number | null;
    oracleWarnMs: number;
    oracleHardBlockMs: number;
  }): string | null {
    const warnings: string[] = [];
    if (!input.sideEnabled) {
      warnings.push("LIVE_NO_SIDE_DISABLED");
    }
    if (
      input.oracleAgeMs !== null &&
      Number.isFinite(input.oracleAgeMs) &&
      input.oracleAgeMs > input.oracleWarnMs &&
      input.oracleAgeMs <= input.oracleHardBlockMs
    ) {
      warnings.push("STALE_ORACLE_WARN");
    }
    return warnings.length > 0 ? warnings.join("|") : null;
  }
}

function holdDecision(
  input: {
    blocker: string;
    selected: Btc5mSelectedMarket;
    threshold: number;
    yesSpread: number;
    noSpread: number;
    maxSpread: number;
    sideEnabled: boolean;
    orderbookOk: boolean;
    sideAsk: number | null;
    pUpModel: number;
    pDownModel: number;
    yesEdge: number;
    noEdge: number;
    edge: number;
    remainingSec: number;
    minEntryRemainingSec: number;
    oracleAgeMs: number | null;
    oracleWarnMs: number;
    oracleHardBlockMs: number;
    warning: string | null;
    chosenSide: "YES" | "NO" | null;
    intelligence: Btc5mIntelligence;
  }
): Btc5mDecision {
  return {
    action: "HOLD",
    blocker: input.blocker,
    blockerSeverity: "hard",
    warning: input.warning,
    chosenSide: input.chosenSide,
    edge: input.edge,
    yesEdge: input.yesEdge,
    noEdge: input.noEdge,
    threshold: input.threshold,
    spread: Math.min(input.yesSpread, input.noSpread),
    yesSpread: input.yesSpread,
    noSpread: input.noSpread,
    maxSpread: input.maxSpread,
    remainingSec: input.remainingSec,
    minEntryRemainingSec: input.minEntryRemainingSec,
    oracleAgeMs: input.oracleAgeMs,
    oracleWarnMs: input.oracleWarnMs,
    oracleHardBlockMs: input.oracleHardBlockMs,
    intelligenceSource: input.intelligence.source,
    intelligencePosture: input.intelligence.posture,
    intelligenceScore: input.intelligence.score,
    sideEnabled: input.sideEnabled,
    orderbookOk: input.orderbookOk,
    sideAsk: input.sideAsk,
    pUpModel: input.pUpModel,
    pDownModel: input.pDownModel
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeSpread(value: number | null): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : Number.POSITIVE_INFINITY;
}
