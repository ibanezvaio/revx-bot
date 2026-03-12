import { BotConfig } from "../../config";
import { Btc5mDecision, Btc5mIntelligence, Btc5mSelectedMarket, Btc5mTick } from "./Btc5mTypes";

type ExecutionGateInput = {
  tick: Btc5mTick;
  selected: Btc5mSelectedMarket;
  intelligence: Btc5mIntelligence;
  oracleAgeMs: number | null;
};

type GateLogger = {
  info: (payload: Record<string, unknown>, msg: string) => void;
};

export class Btc5mExecutionGate {
  constructor(
    private readonly config: BotConfig,
    private readonly logger?: GateLogger
  ) {}

  evaluate(input: ExecutionGateInput): Btc5mDecision {
    const selected = input.selected;
    const yesBook = selected.yesBook;
    const noBook = selected.noBook;
    const yesAsk = yesBook.bestAsk;
    const noAsk = noBook.bestAsk;
    const yesSpread = sanitizeSpread(yesBook.spread);
    const noSpread = sanitizeSpread(noBook.spread);
    const sideEnabled = this.config.polymarket.live.enableNoSide;
    const configuredThreshold = Number(this.config.polymarket.live.minEdgeThreshold);
    const threshold = Number.isFinite(configuredThreshold) ? Math.max(0, configuredThreshold) : 0;
    const takerFeeBps = finiteOrNull(this.config.takerFeeBps);
    const takerSlipBps = finiteOrNull(this.config.takerSlipBps);
    const edgeSafetyBps = finiteOrNull(this.config.edgeSafetyBps);
    const safetyBps = edgeSafetyBps;
    const edgeCostBps = Math.max(0, (takerFeeBps ?? 0) + (takerSlipBps ?? 0) + (edgeSafetyBps ?? 0));
    const edgeCost = edgeCostBps / 10_000;
    const maxSpread = Math.max(0, Number(this.config.polymarket.live.maxSpread || 0));
    const minEntryRemainingSec = Math.max(1, Number(this.config.polymarket.live.minEntryRemainingSec || 1));
    const minDislocation = this.getMinDislocationConfig();
    const extremePriceMin = this.getExtremePriceMinConfig();
    const extremePriceMax = this.getExtremePriceMaxConfig(extremePriceMin);
    const oracleWarnMs = Math.max(0, Number(this.config.polymarket.live.oracleWarnMs || 0));
    const oracleHardBlockMs = Math.max(oracleWarnMs + 1, Number(this.config.polymarket.live.oracleHardBlockMs || 0));
    const warning = this.resolveWarning({
      sideEnabled,
      oracleAgeMs: input.oracleAgeMs,
      oracleWarnMs,
      oracleHardBlockMs
    });

    const fair = this.resolveFairYes({ intelligence: input.intelligence, selected });
    const fairYes = fair.fairYes;
    const fairPriceSource = fair.fairPriceSource;
    const fairPriceModelOrigin = fairPriceSource === "MODEL" ? "intelligence.pUpModel" : null;
    const pUpModel = fairYes;
    const pDownModel = fairYes !== null ? clamp(1 - fairYes, 0.0005, 0.9995) : null;

    const yesBookable = Boolean(selected.yesTokenId && yesBook.bookable && selected.orderbookOk && yesAsk !== null);
    const noBookable = Boolean(selected.noTokenId && noBook.bookable && selected.orderbookOk && noAsk !== null && sideEnabled);
    const yesExtremePriceHit = Boolean(
      yesBookable &&
        yesAsk !== null &&
        (yesAsk > extremePriceMax || yesAsk < extremePriceMin)
    );
    const noExtremePriceHit = Boolean(
      noBookable &&
        noAsk !== null &&
        (noAsk > extremePriceMax || noAsk < extremePriceMin)
    );
    const yesDislocationAbs = yesBookable && yesAsk !== null && fairYes !== null ? Math.abs(fairYes - yesAsk) : null;
    const noDislocationAbs = noBookable && noAsk !== null && fairYes !== null ? Math.abs(fairYes - noAsk) : null;
    const sideConsidered: "YES" | "NO" | "BOTH" = yesBookable && noBookable ? "BOTH" : yesBookable ? "YES" : noBookable ? "NO" : "BOTH";
    const computedYesEdgeRaw =
      yesBookable && yesAsk !== null && pUpModel !== null ? pUpModel - yesAsk : null;
    const computedNoEdgeRaw =
      noBookable && noAsk !== null && pDownModel !== null ? pDownModel - noAsk : null;
    const computedYesEdgeNet =
      computedYesEdgeRaw !== null && Number.isFinite(computedYesEdgeRaw) ? computedYesEdgeRaw - edgeCost : null;
    const computedNoEdgeNet =
      computedNoEdgeRaw !== null && Number.isFinite(computedNoEdgeRaw) ? computedNoEdgeRaw - edgeCost : null;
    const chosenEdgeBeforeClamp = chooseBestEdge(computedYesEdgeRaw, computedNoEdgeRaw);
    const chosenEdgeAfterClamp =
      chosenEdgeBeforeClamp !== null && Number.isFinite(chosenEdgeBeforeClamp)
        ? Math.max(0, chosenEdgeBeforeClamp)
        : null;

    const attachEdgeMath = (decision: Btc5mDecision): Btc5mDecision => {
      const blocker = decision.blocker;
      const clampReason = this.resolveClampReason(blocker, chosenEdgeBeforeClamp);
      const edgeMath = {
        selectedSlug: selected.slug ?? null,
        sideConsidered,
        pUpModel: finiteOrNull(pUpModel),
        yesAsk: finiteOrNull(yesAsk),
        noAsk: finiteOrNull(noAsk),
        yesSpread: finiteOrNull(yesSpread),
        noSpread: finiteOrNull(noSpread),
        maxSpreadConfig: finiteOrNull(maxSpread),
        minEdgeThresholdConfig: finiteOrNull(threshold),
        takerFeeBps,
        takerSlipBps,
        safetyBps,
        edgeSafetyBps,
        computedYesEdgeRaw: finiteOrNull(computedYesEdgeRaw),
        computedNoEdgeRaw: finiteOrNull(computedNoEdgeRaw),
        computedYesEdgeNet: finiteOrNull(computedYesEdgeNet),
        computedNoEdgeNet: finiteOrNull(computedNoEdgeNet),
        chosenEdgeBeforeClamp: finiteOrNull(chosenEdgeBeforeClamp),
        chosenEdgeAfterClamp: finiteOrNull(chosenEdgeAfterClamp),
        fairYes: finiteOrNull(fairYes),
        fairNo: fairYes !== null ? finiteOrNull(1 - fairYes) : null,
        fairPriceSource,
        fairPriceModelOrigin,
        yesDislocationAbs: finiteOrNull(yesDislocationAbs),
        noDislocationAbs: finiteOrNull(noDislocationAbs),
        minDislocationConfig: finiteOrNull(minDislocation),
        yesExtremePriceHit,
        noExtremePriceHit,
        extremePriceMinConfig: finiteOrNull(extremePriceMin),
        extremePriceMaxConfig: finiteOrNull(extremePriceMax),
        clampReason,
        chosenBlocker: blocker || null,
        gateDecision: decision.action === "HOLD" ? ("HOLD" as const) : ("ALLOW" as const)
      };
      if (this.logger && this.config.polymarket.mode === "live") {
        this.logger.info(edgeMath, "POLY_V2_EDGE_MATH");
      }
      return {
        ...decision,
        edgeMath
      };
    };

    if (fairYes === null) {
      const blocker = "FAIR_PRICE_UNAVAILABLE";
      return attachEdgeMath(
        holdDecision({
          blocker,
          selected,
          threshold,
          yesSpread,
          noSpread,
          maxSpread,
          sideEnabled,
          orderbookOk: Boolean(selected.orderbookOk),
          sideAsk: null,
          fairYes: null,
          fairPriceSource,
          chosenSidePriceUsed: null,
          dislocationAbs: null,
          minDislocation,
          extremePriceFilterHit: yesExtremePriceHit || noExtremePriceHit,
          pUpModel: null,
          pDownModel: null,
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
          blockerPriorityApplied: isPriorityBlocker(blocker),
          intelligence: input.intelligence
        })
      );
    }

    if (!yesBookable && !noBookable) {
      const blocker = "TOKEN_NOT_BOOKABLE";
      return attachEdgeMath(
        holdDecision({
        blocker,
        selected,
        threshold,
        yesSpread,
        noSpread,
        maxSpread,
        sideEnabled,
        orderbookOk: false,
        sideAsk: null,
        fairYes,
        fairPriceSource,
        chosenSidePriceUsed: null,
        dislocationAbs: null,
        minDislocation,
        extremePriceFilterHit: yesExtremePriceHit || noExtremePriceHit,
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
        blockerPriorityApplied: isPriorityBlocker(blocker),
        intelligence: input.intelligence
      })
      );
    }

    if (input.tick.remainingSec <= minEntryRemainingSec) {
      const blocker = "TOO_LATE_FOR_ENTRY";
      return attachEdgeMath(
        holdDecision({
        blocker,
        selected,
        threshold,
        yesSpread,
        noSpread,
        maxSpread,
        sideEnabled,
        orderbookOk: true,
        sideAsk: null,
        fairYes,
        fairPriceSource,
        chosenSidePriceUsed: null,
        dislocationAbs: null,
        minDislocation,
        extremePriceFilterHit: yesExtremePriceHit || noExtremePriceHit,
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
        blockerPriorityApplied: isPriorityBlocker(blocker),
        intelligence: input.intelligence
      })
      );
    }

    const yesSpreadOk = yesBookable && yesSpread <= maxSpread;
    const noSpreadOk = noBookable && noSpread <= maxSpread;
    if (!yesSpreadOk && !noSpreadOk) {
      const blocker = "SPREAD_TOO_WIDE";
      return attachEdgeMath(
        holdDecision({
        blocker,
        selected,
        threshold,
        yesSpread,
        noSpread,
        maxSpread,
        sideEnabled,
        orderbookOk: true,
        sideAsk: null,
        fairYes,
        fairPriceSource,
        chosenSidePriceUsed: null,
        dislocationAbs: null,
        minDislocation,
        extremePriceFilterHit: yesExtremePriceHit || noExtremePriceHit,
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
        blockerPriorityApplied: isPriorityBlocker(blocker),
        intelligence: input.intelligence
      })
      );
    }

    const yesEdge = yesSpreadOk && yesAsk !== null && pUpModel !== null ? pUpModel - yesAsk : Number.NEGATIVE_INFINITY;
    const noEdge = noSpreadOk && noAsk !== null && pDownModel !== null ? pDownModel - noAsk : Number.NEGATIVE_INFINITY;

    const yesWins = yesEdge >= noEdge;
    const bestSide = yesWins ? "YES" : "NO";
    const bestEdge = yesWins ? yesEdge : noEdge;
    const bestSpread = yesWins ? yesSpread : noSpread;
    const bestAsk = yesWins ? yesAsk : noAsk;
    const chosenSidePriceUsed = bestAsk !== null && Number.isFinite(bestAsk) ? bestAsk : null;
    const dislocationAbs = chosenSidePriceUsed !== null ? Math.abs(fairYes - chosenSidePriceUsed) : null;
    const extremePriceFilterHit =
      chosenSidePriceUsed !== null &&
      (chosenSidePriceUsed > extremePriceMax || chosenSidePriceUsed < extremePriceMin);
    if (extremePriceFilterHit) {
      const blocker = "EXTREME_PRICE_FILTER";
      return attachEdgeMath(
        holdDecision({
          blocker,
          selected,
          threshold,
          yesSpread,
          noSpread,
          maxSpread,
          sideEnabled,
          orderbookOk: true,
          sideAsk: chosenSidePriceUsed,
          fairYes,
          fairPriceSource,
          chosenSidePriceUsed,
          dislocationAbs,
          minDislocation,
          extremePriceFilterHit: true,
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
          chosenSide: bestSide,
          blockerPriorityApplied: isPriorityBlocker(blocker),
          intelligence: input.intelligence
        })
      );
    }

    if (dislocationAbs === null || !Number.isFinite(dislocationAbs) || dislocationAbs < minDislocation) {
      const blocker = "INSUFFICIENT_DISLOCATION";
      return attachEdgeMath(
        holdDecision({
          blocker,
          selected,
          threshold,
          yesSpread,
          noSpread,
          maxSpread,
          sideEnabled,
          orderbookOk: true,
          sideAsk: chosenSidePriceUsed,
          fairYes,
          fairPriceSource,
          chosenSidePriceUsed,
          dislocationAbs,
          minDislocation,
          extremePriceFilterHit: false,
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
          chosenSide: bestSide,
          blockerPriorityApplied: isPriorityBlocker(blocker),
          intelligence: input.intelligence
        })
      );
    }

    if (!(bestEdge > threshold)) {
      const blocker = "EDGE_BELOW_THRESHOLD";
      return attachEdgeMath(
        holdDecision({
        blocker,
        selected,
        threshold,
        yesSpread,
        noSpread,
        maxSpread,
        sideEnabled,
        orderbookOk: true,
        sideAsk: bestAsk,
        fairYes,
        fairPriceSource,
        chosenSidePriceUsed,
        dislocationAbs,
        minDislocation,
        extremePriceFilterHit: false,
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
        blockerPriorityApplied: isPriorityBlocker(blocker),
        intelligence: input.intelligence
      })
      );
    }

    return attachEdgeMath({
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
      fairYes,
      chosenSidePriceUsed,
      dislocationAbs,
      minDislocationConfig: minDislocation,
      extremePriceFilterHit: false,
      pUpModel,
      pDownModel
    });
  }

  private getMinDislocationConfig(): number {
    return clamp(readEnvNumber("POLYMARKET_LIVE_MIN_DISLOCATION", 0.03), 0, 1);
  }

  private getExtremePriceMaxConfig(extremePriceMin: number): number {
    return clamp(readEnvNumber("POLYMARKET_LIVE_EXTREME_PRICE_MAX", 0.95), extremePriceMin, 0.9999);
  }

  private getExtremePriceMinConfig(): number {
    return clamp(readEnvNumber("POLYMARKET_LIVE_EXTREME_PRICE_MIN", 0.05), 0.0001, 0.99);
  }

  private resolveFairYes(input: {
    intelligence: Btc5mIntelligence;
    selected: Btc5mSelectedMarket;
  }): { fairYes: number | null; fairPriceSource: "MODEL" | "OUTCOME_HINT" | "NONE" } {
    const modelFair = Number(input.intelligence.pUpModel);
    if (Number.isFinite(modelFair) && modelFair > 0 && modelFair < 1) {
      return {
        fairYes: clamp(modelFair, 0.0005, 0.9995),
        fairPriceSource: "MODEL"
      };
    }
    const anySelected = input.selected as Record<string, unknown>;
    const hint = parseOutcomePricesHint(anySelected.outcomePricesHint);
    if (hint !== null) {
      return {
        fairYes: clamp(hint, 0.0005, 0.9995),
        fairPriceSource: "OUTCOME_HINT"
      };
    }
    return { fairYes: null, fairPriceSource: "NONE" };
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

  private resolveClampReason(
    blocker: string | null,
    chosenEdgeBeforeClamp: number | null
  ): "NONE" | "NEGATIVE" | "SPREAD_BLOCK" | "ORACLE_BLOCK" | "NO_BOOK" | "OTHER" {
    const normalized = String(blocker || "")
      .trim()
      .toUpperCase();
    if (!normalized) return "NONE";
    if (normalized === "SPREAD_TOO_WIDE") return "SPREAD_BLOCK";
    if (normalized === "EXTREME_PRICE_FILTER") return "SPREAD_BLOCK";
    if (normalized === "TOKEN_NOT_BOOKABLE" || normalized === "NO_ORDERBOOK" || normalized === "SIDE_BOOK_UNAVAILABLE") {
      return "NO_BOOK";
    }
    if (normalized.includes("ORACLE")) return "ORACLE_BLOCK";
    if (
      chosenEdgeBeforeClamp !== null &&
      Number.isFinite(chosenEdgeBeforeClamp) &&
      chosenEdgeBeforeClamp <= 0
    ) {
      return "NEGATIVE";
    }
    if (normalized === "EDGE_BELOW_THRESHOLD") {
      return "NEGATIVE";
    }
    return "OTHER";
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
    fairYes: number | null;
    fairPriceSource: "MODEL" | "OUTCOME_HINT" | "NONE";
    chosenSidePriceUsed: number | null;
    dislocationAbs: number | null;
    minDislocation: number;
    extremePriceFilterHit: boolean;
    blockerPriorityApplied: boolean;
    pUpModel: number | null;
    pDownModel: number | null;
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
    fairYes: input.fairYes,
    chosenSidePriceUsed: input.chosenSidePriceUsed,
    dislocationAbs: input.dislocationAbs,
    minDislocationConfig: input.minDislocation,
    extremePriceFilterHit: input.extremePriceFilterHit,
    pUpModel: input.pUpModel,
    pDownModel: input.pDownModel
  };
}

function isPriorityBlocker(blocker: string): boolean {
  return (
    blocker === "FAIR_PRICE_UNAVAILABLE" ||
    blocker === "EXTREME_PRICE_FILTER" ||
    blocker === "INSUFFICIENT_DISLOCATION" ||
    blocker === "ORDER_SIZE_BELOW_MIN_SHARES_RISK_BLOCKED" ||
    blocker === "CONFIG_INFEASIBLE_MIN_SHARES" ||
    blocker === "EDGE_BELOW_THRESHOLD"
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeSpread(value: number | null): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : Number.POSITIVE_INFINITY;
}

function finiteOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function chooseBestEdge(yesEdge: number | null, noEdge: number | null): number | null {
  const yes = finiteOrNull(yesEdge);
  const no = finiteOrNull(noEdge);
  if (yes === null && no === null) return null;
  if (yes === null) return no;
  if (no === null) return yes;
  return yes >= no ? yes : no;
}

function readEnvNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name] || "");
  return Number.isFinite(raw) ? raw : fallback;
}

function parseOutcomePricesHint(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const numbers = value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0 && entry < 1);
  if (numbers.length === 0) return null;
  return numbers[0];
}
