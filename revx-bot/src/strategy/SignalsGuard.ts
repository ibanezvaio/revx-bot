import { BotConfig } from "../config";
import { SignalAggregate } from "../signals/types";

export type SignalsGuardInput = {
  ts: number;
  aggregate: SignalAggregate | null;
  inventoryRatio: number;
  allowTakerFlatten: boolean;
};

export type SignalsGuardDecision = {
  ts: number;
  state: "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE";
  impact: number;
  direction: "UP" | "DOWN" | "NEUTRAL";
  confidence: number;
  spreadMultExtra: number;
  sizeMultExtra: number;
  gateBuy: boolean | null;
  gateSell: boolean | null;
  pauseMakers: boolean;
  allowTakerFlattenOnly: boolean;
  reasons: string[];
  cooldownRemainingSeconds: number;
};

export class SignalsGuard {
  private pauseUntilTs = 0;
  private pauseCandidateSinceTs = 0;

  constructor(private readonly config: BotConfig) {}

  evaluate(input: SignalsGuardInput): SignalsGuardDecision {
    const nowTs = Math.max(0, Number(input.ts) || Date.now());
    const aggregate = input.aggregate;
    const impact = clamp(Number(aggregate?.impact) || 0, 0, 1);
    const confidence = clamp(Number(aggregate?.confidence) || 0, 0, 1);
    const direction = normalizeDirection(aggregate?.direction);
    const state = normalizeState(aggregate?.state);
    const reasons: string[] = [];
    let spreadMultExtra = 1;
    let sizeMultExtra = 1;
    let gateBuy: boolean | null = null;
    let gateSell: boolean | null = null;
    let pauseMakers = false;
    let allowTakerFlattenOnly = false;

    const pauseImpactThreshold = this.config.intelPauseImpactThreshold;
    const pauseConfidenceThreshold = this.config.intelPauseConfidenceThreshold;
    const pausePersistenceMs = this.config.intelPausePersistenceSeconds * 1000;
    const pauseSignal = impact >= pauseImpactThreshold && confidence >= pauseConfidenceThreshold;
    if (pauseSignal) {
      if (this.pauseCandidateSinceTs <= 0) {
        this.pauseCandidateSinceTs = nowTs;
      }
      const persistedMs = nowTs - this.pauseCandidateSinceTs;
      if (persistedMs >= pausePersistenceMs) {
        this.pauseUntilTs = Math.max(this.pauseUntilTs, nowTs + this.config.signalsPauseSeconds * 1000);
        pauseMakers = true;
        allowTakerFlattenOnly = input.allowTakerFlatten;
        reasons.push(
          `SIGNALS_SUPER_CAUTION (impact=${impact.toFixed(2)} >= ${pauseImpactThreshold.toFixed(
            2
          )}, conf=${confidence.toFixed(2)} >= ${pauseConfidenceThreshold.toFixed(
            2
          )}, persisted=${Math.floor(persistedMs / 1000)}s >= ${this.config.intelPausePersistenceSeconds}s, state=${state})`
        );
      } else {
        reasons.push(
          `SIGNALS_SUPER_CAUTION_PENDING (${Math.floor(persistedMs / 1000)}s < ${this.config.intelPausePersistenceSeconds}s)`
        );
      }
    } else if (nowTs < this.pauseUntilTs) {
      pauseMakers = true;
      allowTakerFlattenOnly = input.allowTakerFlatten;
      reasons.push(
        `SIGNALS_SUPER_CAUTION_COOLDOWN (${Math.ceil((this.pauseUntilTs - nowTs) / 1000)}s)`
      );
    } else if (state === "RISK_OFF") {
      this.pauseCandidateSinceTs = 0;
      spreadMultExtra *= 1 + this.config.signalsSpreadMult * impact * 0.9;
      sizeMultExtra *= 1 - this.config.signalsSizeCutMult * impact * 0.6;
      if (input.inventoryRatio > 0.12) gateBuy = true;
      reasons.push(
        `SIGNALS_RISK_OFF (impact=${impact.toFixed(2)} dir=${direction} conf=${confidence.toFixed(2)})`
      );
    } else if (state === "RISK_ON") {
      this.pauseCandidateSinceTs = 0;
      spreadMultExtra *= 1 + this.config.signalsSpreadMult * impact * 0.9;
      sizeMultExtra *= 1 - this.config.signalsSizeCutMult * impact * 0.6;
      if (input.inventoryRatio < -0.12) gateSell = true;
      reasons.push(
        `SIGNALS_RISK_ON (impact=${impact.toFixed(2)} dir=${direction} conf=${confidence.toFixed(2)})`
      );
    } else if (state === "CAUTION") {
      this.pauseCandidateSinceTs = 0;
      spreadMultExtra *= 1 + this.config.signalsSpreadMult * impact * 0.45;
      sizeMultExtra *= 1 - this.config.signalsSizeCutMult * impact * 0.45;
      reasons.push(`SIGNALS_CAUTION (impact=${impact.toFixed(2)} conf=${confidence.toFixed(2)})`);
    } else {
      this.pauseCandidateSinceTs = 0;
      reasons.push("SIGNALS_NORMAL");
    }

    return {
      ts: nowTs,
      state,
      impact,
      direction,
      confidence,
      spreadMultExtra: clamp(spreadMultExtra, 1, 3),
      sizeMultExtra: clamp(sizeMultExtra, 0.2, 1),
      gateBuy,
      gateSell,
      pauseMakers,
      allowTakerFlattenOnly,
      reasons,
      cooldownRemainingSeconds: Math.max(0, Math.ceil((this.pauseUntilTs - nowTs) / 1000))
    };
  }
}

function normalizeDirection(value: unknown): "UP" | "DOWN" | "NEUTRAL" {
  if (value === "UP" || value === "DOWN" || value === "NEUTRAL") return value;
  return "NEUTRAL";
}

function normalizeState(value: unknown): "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE" {
  if (value === "NORMAL" || value === "CAUTION" || value === "RISK_OFF" || value === "RISK_ON" || value === "PAUSE") return value;
  return "NORMAL";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
