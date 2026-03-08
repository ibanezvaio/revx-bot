import { BotConfig } from "../config";
import { StrategyDecision, YesOrderBook } from "./types";

export class Strategy {
  constructor(private readonly config: BotConfig) {}

  decide(input: {
    pUpModel: number;
    orderBook: YesOrderBook;
    sigmaPerSqrtSec: number;
    tauSec: number;
  }): StrategyDecision {
    const yesBid = clamp(input.orderBook.yesBid, 0, 1);
    const yesAsk = clamp(input.orderBook.yesAsk, yesBid, 1);
    const yesMid = (yesBid + yesAsk) / 2;
    const spread = Math.max(0, yesAsk - yesBid);

    const edge = input.pUpModel - yesMid;
    const edgeYes = edge;
    const edgeNo = yesMid - input.pUpModel;
    const edgeAbs = Math.abs(edge);
    const chosenSide: "YES" | "NO" = edgeYes >= edgeNo ? "YES" : "NO";
    const chosenEdge = Math.max(edgeYes, edgeNo);
    const costPenaltyProb = this.computeCostPenaltyProb();
    const netEdgeAfterCosts = chosenEdge - costPenaltyProb;
    const minEdgeThreshold = this.computeMinEdgeThreshold();
    const threshold = this.computeThreshold({
      spread,
      sigmaPerSqrtSec: input.sigmaPerSqrtSec,
      tauSec: input.tauSec
    });

    if (input.tauSec <= this.config.polymarket.risk.noNewOrdersInLastSec) {
      return {
        action: "HOLD",
        reason: "NO_NEW_ORDERS_NEAR_EXPIRY",
        edge,
        edgeAbs,
        edgeYes,
        edgeNo,
        chosenSide,
        chosenEdge,
        netEdgeAfterCosts,
        costPenaltyProb,
        minEdgeThreshold,
        threshold,
        yesBid,
        yesAsk,
        yesMid,
        spread
      };
    }

    if (chosenEdge <= threshold) {
      return {
        action: "HOLD",
        reason: "EDGE_BELOW_THRESHOLD",
        edge,
        edgeAbs,
        edgeYes,
        edgeNo,
        chosenSide,
        chosenEdge,
        netEdgeAfterCosts,
        costPenaltyProb,
        minEdgeThreshold,
        threshold,
        yesBid,
        yesAsk,
        yesMid,
        spread
      };
    }

    if (netEdgeAfterCosts < minEdgeThreshold) {
      return {
        action: "HOLD",
        reason: "NET_EDGE_BELOW_MIN_THRESHOLD",
        edge,
        edgeAbs,
        edgeYes,
        edgeNo,
        chosenSide,
        chosenEdge,
        netEdgeAfterCosts,
        costPenaltyProb,
        minEdgeThreshold,
        threshold,
        yesBid,
        yesAsk,
        yesMid,
        spread
      };
    }

    return {
      action: chosenSide === "YES" ? "BUY_YES" : "BUY_NO",
      reason: chosenSide === "YES" ? "EDGE_YES_NET_GT_THRESHOLD" : "EDGE_NO_NET_GT_THRESHOLD",
      edge,
      edgeAbs,
      edgeYes,
      edgeNo,
      chosenSide,
      chosenEdge,
      netEdgeAfterCosts,
      costPenaltyProb,
      minEdgeThreshold,
      threshold,
      yesBid,
      yesAsk,
      yesMid,
      spread
    };
  }

  private computeThreshold(input: {
    spread: number;
    sigmaPerSqrtSec: number;
    tauSec: number;
  }): number {
    const closePenaltyScale = this.config.polymarket.threshold.closePenalty;
    const closeWeight = Math.max(0, 1 - input.tauSec / (this.config.polymarket.marketQuery.cadenceMinutes * 60));
    const closePenalty = closePenaltyScale * closeWeight ** 2;
    const volPenalty = this.config.polymarket.threshold.volK * input.sigmaPerSqrtSec;
    const spreadPenalty = input.spread / 2;

    return this.config.polymarket.threshold.baseEdge + spreadPenalty + volPenalty + closePenalty;
  }

  private computeCostPenaltyProb(): number {
    const feeBps = Math.max(0, this.config.polymarket.paper.feeBps);
    const slippageBps = Math.max(0, this.config.polymarket.paper.slippageBps);
    return Math.max(0, (feeBps + slippageBps) / 10_000);
  }

  private computeMinEdgeThreshold(): number {
    return this.config.polymarket.paper.minEdgeThreshold;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
