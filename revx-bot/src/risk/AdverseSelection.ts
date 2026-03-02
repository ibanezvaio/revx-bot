import {
  AdverseSelectionTracker,
  AdverseSelectionTrackerConfig,
  AdverseSelectionSummary,
  computeAsBps,
  rollingStats,
  toxicDecision,
  updateDefenseState
} from "../strategy/adverseSelection";

export type { AdverseSelectionSummary, AdverseSelectionTrackerConfig };
export { AdverseSelectionTracker, computeAsBps, rollingStats, toxicDecision, updateDefenseState };

export type AdverseState = "NORMAL" | "CAUTION" | "DEFENSIVE";

export type AdversePosture = {
  ts: number;
  state: AdverseState;
  widenBps: number;
  sizeCut: number;
  reasons: string[];
  stats: {
    avgMarkoutBpsBuy: number;
    avgMarkoutBpsSell: number;
    toxicScore: number;
    samples: number;
  };
};

export function summarizeAdversePosture(
  summary: AdverseSelectionSummary,
  cfg: {
    toxicThresholdBps: number;
    widenMaxBps: number;
    sizeCutMax: number;
  },
  nowTs = Date.now()
): AdversePosture {
  const avg = Number(summary.as_avg_bps) || 0;
  const toxicScore = clamp(Math.max(0, (-avg) / Math.max(0.0001, cfg.toxicThresholdBps)), 0, 1);
  const state: AdverseState =
    toxicScore >= 0.8 || summary.as_toxic
      ? "DEFENSIVE"
      : toxicScore >= 0.4
        ? "CAUTION"
        : "NORMAL";
  const widenBps = state === "NORMAL" ? 0 : clamp(toxicScore * cfg.widenMaxBps, 0, cfg.widenMaxBps);
  const sizeCut = state === "NORMAL" ? 0 : clamp(toxicScore * cfg.sizeCutMax, 0, cfg.sizeCutMax);
  return {
    ts: nowTs,
    state,
    widenBps,
    sizeCut,
    reasons: [summary.reason || "ADVERSE_OK"],
    stats: {
      avgMarkoutBpsBuy: avg,
      avgMarkoutBpsSell: avg,
      toxicScore,
      samples: Number(summary.as_samples) || 0
    }
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
