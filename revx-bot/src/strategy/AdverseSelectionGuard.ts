import { BotConfig } from "../config";
import { SignalRegime } from "../signals/types";

export type AdverseState = "NORMAL" | "WIDEN" | "REDUCE" | "PAUSE" | "HEDGE";

export type AdverseMarkoutPoint = {
  ts: number;
  side: "BUY" | "SELL";
  fillMid: number;
  futureMid: number;
  windowMs: number;
  markoutBps: number;
};

export type AdverseSelectionInput = {
  ts: number;
  regime: SignalRegime;
  confidence: number;
  basisBps: number;
  driftBps: number;
  asAvgBps: number;
  asBadRate: number;
  asSamples: number;
  cancels1h: number;
  rejects1h: number;
  markouts: AdverseMarkoutPoint[];
};

export type AdverseSelectionDecision = {
  ts: number;
  toxicityScore: number;
  state: AdverseState;
  recommendedSpreadMult: number;
  recommendedSkewBps: number;
  allowBuy: boolean | null;
  allowSell: boolean | null;
  takerHedgeAllowed: boolean;
  reasons: string[];
  markoutAvgBps: number;
  markoutCount: number;
  adverseSpreadMult: number;
};

export class AdverseSelectionGuard {
  private toxicityScore = 0;
  private state: AdverseState = "NORMAL";
  private lastDecision: AdverseSelectionDecision = {
    ts: 0,
    toxicityScore: 0,
    state: "NORMAL",
    recommendedSpreadMult: 1,
    recommendedSkewBps: 0,
    allowBuy: null,
    allowSell: null,
    takerHedgeAllowed: false,
    reasons: ["AS_GUARD_NOT_INITIALIZED"],
    markoutAvgBps: 0,
    markoutCount: 0,
    adverseSpreadMult: 1
  };

  constructor(private readonly config: BotConfig) {}

  update(input: AdverseSelectionInput): AdverseSelectionDecision {
    const thresholds = parseThresholds(this.config.adverseStateThresholdsCsv);
    const relevantMarkouts = input.markouts.filter((row) => this.config.adverseMarkoutWindowsMs.includes(row.windowMs));
    const markoutCount = relevantMarkouts.length;
    const markoutAvgBps =
      markoutCount > 0
        ? relevantMarkouts.reduce((sum, row) => sum + row.markoutBps, 0) / markoutCount
        : 0;

    const toxicMarkout = this.config.adverseToxicMarkoutBps;
    const markoutPenalty =
      markoutCount >= Math.max(1, this.config.adverseMinFills)
        ? clamp((toxicMarkout - markoutAvgBps) / Math.max(0.5, Math.abs(toxicMarkout)), 0, 1)
        : 0;
    const asPenalty =
      input.asSamples >= this.config.adverseMinFills
        ? clamp((-input.asAvgBps - this.config.asBadAvgBps) / Math.max(1, this.config.asBadAvgBps), 0, 1)
        : 0;
    const badRatePenalty = clamp(input.asBadRate, 0, 1);
    const churnPenalty = clamp((input.rejects1h + input.cancels1h * 0.3) / 50, 0, 1);
    const basisPenalty = clamp(Math.abs(input.basisBps) / Math.max(0.1, this.config.fairMaxBasisBps), 0, 1);
    const driftPenalty = clamp(Math.abs(input.driftBps) / Math.max(0.1, this.config.toxicDriftBps), 0, 1);
    const regimePenalty =
      input.regime === "CRISIS"
        ? 1
        : input.regime === "VOLATILE"
          ? 0.45
          : input.regime === "TREND"
            ? 0.25
            : 0;

    const rawToxicity = clamp(
      0.36 * markoutPenalty +
        0.2 * asPenalty +
        0.18 * badRatePenalty +
        0.1 * churnPenalty +
        0.1 * basisPenalty +
        0.06 * driftPenalty +
        0.1 * regimePenalty,
      0,
      1
    );
    this.toxicityScore = clamp(this.toxicityScore * this.config.adverseDecay + rawToxicity * (1 - this.config.adverseDecay), 0, 1);

    const score = this.toxicityScore;
    let state: AdverseState = "NORMAL";
    if (score >= thresholds.hedge || input.regime === "CRISIS") {
      state = "HEDGE";
    } else if (score >= thresholds.pause) {
      state = "PAUSE";
    } else if (score >= thresholds.reduce) {
      state = "REDUCE";
    } else if (score >= thresholds.widen) {
      state = "WIDEN";
    }
    this.state = state;

    let recommendedSpreadMult = 1;
    if (state === "WIDEN") recommendedSpreadMult = 1 + Math.min(0.35, score * 0.45);
    if (state === "REDUCE") recommendedSpreadMult = 1 + Math.min(0.65, score * 0.75);
    if (state === "PAUSE") recommendedSpreadMult = 1 + Math.min(0.95, score * 1.0);
    if (state === "HEDGE") recommendedSpreadMult = this.config.adverseMaxSpreadMult;
    recommendedSpreadMult = clamp(recommendedSpreadMult, 1, this.config.adverseMaxSpreadMult);

    let recommendedSkewBps = 0;
    if (input.regime === "TREND" && input.confidence >= this.config.signalMinConf) {
      recommendedSkewBps = input.driftBps > 0 ? -2 : 2;
    }
    if (state === "HEDGE") {
      recommendedSkewBps += input.driftBps > 0 ? -3 : 3;
    }

    const reasons: string[] = [];
    if (state !== "NORMAL") {
      reasons.push(
        `AS_${state} (score=${score.toFixed(2)} markoutAvg=${markoutAvgBps.toFixed(2)}bps n=${markoutCount} asAvg=${input.asAvgBps.toFixed(2)} badRate=${(input.asBadRate * 100).toFixed(1)}%)`
      );
      if (markoutPenalty > 0) {
        reasons.push(
          `AS_MARKOUT_TOXIC (avg=${markoutAvgBps.toFixed(2)}bps <= threshold=${toxicMarkout.toFixed(2)}bps)`
        );
      }
    }

    const allowBuy: boolean | null = state === "PAUSE" || state === "HEDGE" ? false : null;
    const allowSell: boolean | null = state === "PAUSE" || state === "HEDGE" ? false : null;
    const takerHedgeAllowed = state === "HEDGE" || (state === "PAUSE" && input.regime === "TREND");

    const decision: AdverseSelectionDecision = {
      ts: input.ts,
      toxicityScore: score,
      state,
      recommendedSpreadMult,
      recommendedSkewBps,
      allowBuy,
      allowSell,
      takerHedgeAllowed,
      reasons,
      markoutAvgBps,
      markoutCount,
      adverseSpreadMult: recommendedSpreadMult
    };
    this.lastDecision = decision;
    return decision;
  }

  getSnapshot(): AdverseSelectionDecision {
    return {
      ...this.lastDecision,
      reasons: [...this.lastDecision.reasons]
    };
  }
}

function parseThresholds(csv: string): { widen: number; reduce: number; pause: number; hedge: number } {
  const parts = String(csv || "")
    .split(",")
    .map((row) => Number(row.trim()))
    .filter((row) => Number.isFinite(row));
  const widen = clamp(parts[0] ?? 0.35, 0, 1);
  const reduce = clamp(parts[1] ?? 0.55, widen, 1);
  const pause = clamp(parts[2] ?? 0.75, reduce, 1);
  const hedge = clamp(parts[3] ?? 0.9, pause, 1);
  return { widen, reduce, pause, hedge };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

