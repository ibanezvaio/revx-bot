import { BotConfig } from "../config";
import { NewsDirection, NewsSnapshot } from "../news/types";

export type NewsState = "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE";

export type NewsGuardInput = {
  ts: number;
  snapshot: NewsSnapshot | null;
  regime: "CALM" | "TREND" | "VOLATILE" | "CRISIS";
  adverseState: "NORMAL" | "WIDEN" | "REDUCE" | "PAUSE" | "HEDGE";
  inventoryRatio: number;
};

export type NewsGuardDecision = {
  ts: number;
  state: NewsState;
  impact: number;
  direction: NewsDirection;
  confidence: number;
  spreadMult: number;
  sizeMult: number;
  allowBuy: boolean | null;
  allowSell: boolean | null;
  pauseMakers: boolean;
  allowTakerFlattenOnly: boolean;
  reasons: string[];
  cooldownRemainingSeconds: number;
  lastHeadlineTs: number;
};

export class NewsGuard {
  private pauseUntilTs = 0;
  private pauseCandidateSinceTs = 0;

  constructor(private readonly config: BotConfig) {}

  evaluate(input: NewsGuardInput): NewsGuardDecision {
    const nowTs = Math.max(0, Number(input.ts) || Date.now());
    const aggregate = input.snapshot?.aggregate;
    const impact = clamp(Number(aggregate?.impact) || 0, 0, 1);
    const confidence = clamp(Number(aggregate?.confidence) || 0, 0, 1);
    const direction = normalizeDirection(aggregate?.direction);
    const reasons: string[] = [];
    const lastHeadlineTs = input.snapshot?.items?.[0]?.ts ?? 0;
    let state: NewsState = "NORMAL";
    let allowBuy: boolean | null = null;
    let allowSell: boolean | null = null;
    let pauseMakers = false;
    let allowTakerFlattenOnly = false;
    let spreadMult = 1;
    let sizeMult = 1;

    if (!this.config.newsEnabled) {
      return {
        ts: nowTs,
        state,
        impact,
        direction,
        confidence,
        spreadMult,
        sizeMult,
        allowBuy,
        allowSell,
        pauseMakers,
        allowTakerFlattenOnly,
        reasons,
        cooldownRemainingSeconds: 0,
        lastHeadlineTs
      };
    }

    const pauseImpactThreshold = this.config.intelPauseImpactThreshold;
    const pauseConfidenceThreshold = this.config.intelPauseConfidenceThreshold;
    const pausePersistenceMs = this.config.intelPausePersistenceSeconds * 1000;
    const pauseSignal =
      impact >= pauseImpactThreshold && confidence >= pauseConfidenceThreshold;
    if (pauseSignal) {
      if (this.pauseCandidateSinceTs <= 0) {
        this.pauseCandidateSinceTs = nowTs;
      }
      const persistedMs = nowTs - this.pauseCandidateSinceTs;
      if (persistedMs >= pausePersistenceMs) {
        this.pauseUntilTs = nowTs + this.config.newsPauseSeconds * 1000;
        state = "PAUSE";
        pauseMakers = true;
        allowTakerFlattenOnly = true;
        reasons.push(
          `NEWS_SUPER_CAUTION (impact=${impact.toFixed(2)} >= ${pauseImpactThreshold.toFixed(
            2
          )}, conf=${confidence.toFixed(2)} >= ${pauseConfidenceThreshold.toFixed(
            2
          )}, persisted=${Math.floor(persistedMs / 1000)}s >= ${this.config.intelPausePersistenceSeconds}s)`
        );
      } else {
        reasons.push(
          `NEWS_SUPER_CAUTION_PENDING (${Math.floor(persistedMs / 1000)}s < ${this.config.intelPausePersistenceSeconds}s)`
        );
      }
    } else if (nowTs < this.pauseUntilTs) {
      state = "PAUSE";
      pauseMakers = true;
      allowTakerFlattenOnly = true;
      reasons.push(
        `NEWS_SUPER_CAUTION_COOLDOWN (remaining=${Math.ceil((this.pauseUntilTs - nowTs) / 1000)}s)`
      );
    } else {
      this.pauseCandidateSinceTs = 0;
      if (impact >= 0.32) state = "CAUTION";
      spreadMult = 1 + this.config.newsSpreadMult * impact;
      sizeMult = clamp(1 - this.config.newsSizeCutMult * impact, 0.25, 1);
    }
    const uncappedState = state;
    if (stateRank(state) > stateRank(this.config.intelNewsMaxPosture)) {
      state = this.config.intelNewsMaxPosture;
      pauseMakers = false;
      allowTakerFlattenOnly = false;
      reasons.push(
        `NEWS_CAUTION_CAP_APPLIED (from=${uncappedState} max=${this.config.intelNewsMaxPosture})`
      );
    }
    if (state !== "NORMAL") {
      reasons.push(
        `NEWS_POSTURE_${state} (impact=${impact.toFixed(2)} dir=${direction} conf=${confidence.toFixed(2)})`
      );
    }

    if (!pauseSignal && nowTs >= this.pauseUntilTs) {
      this.pauseCandidateSinceTs = 0;
    }

    if (input.regime === "CRISIS" || input.adverseState === "HEDGE") {
      spreadMult = Math.max(spreadMult, 1.25);
      sizeMult = Math.min(sizeMult, 0.6);
      reasons.push(`NEWS_DEFENSIVE_BLEND (regime=${input.regime} adverse=${input.adverseState})`);
    }

    if (!this.config.intelNewsAllowSideBlocks) {
      allowBuy = null;
      allowSell = null;
    }

    return {
      ts: nowTs,
      state,
      impact,
      direction,
      confidence,
      spreadMult: clamp(spreadMult, 1, this.config.intelNewsMaxSpreadMult),
      sizeMult: clamp(sizeMult, this.config.intelNewsMinSizeMult, 1),
      allowBuy,
      allowSell,
      pauseMakers,
      allowTakerFlattenOnly,
      reasons,
      cooldownRemainingSeconds: Math.max(0, Math.ceil((this.pauseUntilTs - nowTs) / 1000)),
      lastHeadlineTs
    };
  }
}

function normalizeDirection(value: unknown): NewsDirection {
  if (value === "UP" || value === "DOWN" || value === "NEUTRAL") return value;
  return "NEUTRAL";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stateRank(state: NewsState): number {
  switch (state) {
    case "PAUSE":
      return 4;
    case "RISK_OFF":
      return 3;
    case "RISK_ON":
      return 2;
    case "CAUTION":
      return 1;
    case "NORMAL":
    default:
      return 0;
  }
}
