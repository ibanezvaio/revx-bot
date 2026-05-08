import { BotConfig } from "../config";
import { Logger } from "../logger";
import { RevxPortfolioQuotePolicy, PortfolioVenueEntryPolicy } from "../risk/PortfolioRiskCoordinator";
import { Store } from "../store/Store";
import { buildAttributionSamples, summarizeAttributionSamples } from "./AttributionAnalytics";

export type AttributionVenueFeedback = {
  sampleCount: number;
  avgMarkoutBps: number | null;
  multiplier: number;
  allowNewRisk: boolean;
  reason: string | null;
};

export type AttributionRuntimeFeedback = {
  revx: AttributionVenueFeedback;
  polymarket: AttributionVenueFeedback;
  notes: string[];
};

export class AttributionPolicyEngine {
  private readonly enabled = envBool("ATTRIBUTION_POLICY_ENABLED", true);
  private readonly lookbackMs = envNumber("ATTRIBUTION_POLICY_LOOKBACK_MINUTES", 240) * 60_000;
  private readonly horizonSec = envNumber("ATTRIBUTION_POLICY_HORIZON_SEC", 300);
  private readonly minSamples = envNumber("ATTRIBUTION_POLICY_MIN_SAMPLES", 12);
  private readonly startupGraceMs = Math.max(0, envNumber("ATTRIBUTION_POLICY_STARTUP_GRACE_MINUTES", 15) * 60_000);
  private readonly revxSoftThresholdBps = envNumber("ATTRIBUTION_POLICY_REVX_SOFT_BPS", 0);
  private readonly revxHardThresholdBps = envNumber("ATTRIBUTION_POLICY_REVX_HARD_BPS", -3);
  private readonly revxMinMultiplier = clamp(envNumber("ATTRIBUTION_POLICY_REVX_MIN_MULTIPLIER", 0.35), 0, 1);
  private readonly polySoftThresholdBps = envNumber("ATTRIBUTION_POLICY_POLY_SOFT_BPS", 0);
  private readonly polyHardThresholdBps = envNumber("ATTRIBUTION_POLICY_POLY_HARD_BPS", -6);
  private readonly polyMinMultiplier = clamp(envNumber("ATTRIBUTION_POLICY_POLY_MIN_MULTIPLIER", 0.25), 0, 1);
  private readonly startedAtTs = Date.now();

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly store: Store
  ) {}

  evaluate(nowTs = Date.now()): AttributionRuntimeFeedback {
    if (!this.enabled) {
      return {
        revx: neutralFeedback(),
        polymarket: neutralFeedback(),
        notes: ["Attribution policy disabled by environment"]
      };
    }
    if (nowTs - this.startedAtTs < this.startupGraceMs) {
      return {
        revx: neutralFeedback(),
        polymarket: neutralFeedback(),
        notes: [
          `Attribution startup grace active for ${Math.round(this.startupGraceMs / 60_000)} minutes`,
          "Historical markout feedback is ignored during initial boot stabilization"
        ]
      };
    }
    const recordLimit = Math.max(200, Math.floor((this.lookbackMs / 60_000) * 40));
    const tickerLimit = Math.max(20_000, Math.floor((this.lookbackMs / 1_000) * 3));
    const records = this.store
      .getRecentDecisionAttributions(recordLimit)
      .filter((row) => row.symbol === this.config.symbol && row.ts >= nowTs - this.lookbackMs);
    const tickerSnapshots = this.store.getRecentTickerSnapshots(this.config.symbol, tickerLimit);

    const revxSamples = buildAttributionSamples({
      records,
      tickerSnapshots,
      horizonSec: this.horizonSec,
      venue: "REVX",
      actions: ["QUOTE_BUY", "QUOTE_BOTH"],
      includeBlocked: false
    });
    const polymarketSamples = buildAttributionSamples({
      records,
      tickerSnapshots,
      horizonSec: this.horizonSec,
      venue: "POLYMARKET",
      actions: ["BUY_YES", "BUY_NO"],
      includeBlocked: false
    });
    const revxSummary = summarizeAttributionSamples(revxSamples);
    const polymarketSummary = summarizeAttributionSamples(polymarketSamples);

    return {
      revx: buildFeedback({
        summary: revxSummary,
        minSamples: this.minSamples,
        softThresholdBps: this.revxSoftThresholdBps,
        hardThresholdBps: this.revxHardThresholdBps,
        minMultiplier: this.revxMinMultiplier,
        softReason: "ATTRIBUTION_REVX_SOFT_THROTTLE",
        hardReason: "ATTRIBUTION_REVX_NEGATIVE_MARKOUT",
        hardBlocksRisk: true
      }),
      polymarket: buildFeedback({
        summary: polymarketSummary,
        minSamples: this.minSamples,
        softThresholdBps: this.polySoftThresholdBps,
        hardThresholdBps: this.polyHardThresholdBps,
        minMultiplier: this.polyMinMultiplier,
        softReason: "ATTRIBUTION_POLY_SOFT_THROTTLE",
        hardReason: "ATTRIBUTION_POLY_SOFT_THROTTLE",
        hardBlocksRisk: false
      }),
      notes: [
        `Empirical policy horizon=${this.horizonSec}s lookbackMin=${Math.round(this.lookbackMs / 60_000)} minSamples=${this.minSamples}`,
        "Policy only reacts once enough directional attribution samples exist"
      ]
    };
  }

  mergeRevxPolicy(
    base: RevxPortfolioQuotePolicy,
    feedback: AttributionVenueFeedback
  ): RevxPortfolioQuotePolicy {
    if (!feedback.allowNewRisk) {
      return {
        ...base,
        allowNewBuyRisk: false,
        buySizeMultiplier: 0,
        reason: base.reason || feedback.reason
      };
    }
    return {
      ...base,
      buySizeMultiplier: clamp(base.buySizeMultiplier * feedback.multiplier, 0, 1),
      reason: base.reason || (feedback.multiplier < 0.999 ? feedback.reason : null)
    };
  }

  mergePolymarketPolicy(
    base: PortfolioVenueEntryPolicy
    ,
    feedback: AttributionVenueFeedback
  ): PortfolioVenueEntryPolicy {
    if (!feedback.allowNewRisk) {
      return {
        allowNewEntries: false,
        additionalBudgetUsd: 0,
        reason: base.reason || feedback.reason
      };
    }
    return {
      allowNewEntries: base.allowNewEntries,
      additionalBudgetUsd: clampNonNegative(base.additionalBudgetUsd * feedback.multiplier),
      reason: base.reason || (feedback.multiplier < 0.999 ? feedback.reason : null)
    };
  }
}

function buildFeedback(input: {
  summary: { sampleCount: number; avgMarkoutBps: number | null };
  minSamples: number;
  softThresholdBps: number;
  hardThresholdBps: number;
  minMultiplier: number;
  softReason: string;
  hardReason: string;
  hardBlocksRisk: boolean;
}): AttributionVenueFeedback {
  if (input.summary.sampleCount < input.minSamples || input.summary.avgMarkoutBps === null) {
    return neutralFeedback(input.summary.sampleCount, input.summary.avgMarkoutBps);
  }
  const avg = input.summary.avgMarkoutBps;
  if (avg <= input.hardThresholdBps) {
    return {
      sampleCount: input.summary.sampleCount,
      avgMarkoutBps: avg,
      multiplier: input.hardBlocksRisk ? 0 : input.minMultiplier,
      allowNewRisk: !input.hardBlocksRisk,
      reason: input.hardReason
    };
  }
  if (avg <= input.softThresholdBps) {
    const span = Math.max(0.0001, input.softThresholdBps - input.hardThresholdBps);
    const relative = clamp((avg - input.hardThresholdBps) / span, 0, 1);
    return {
      sampleCount: input.summary.sampleCount,
      avgMarkoutBps: avg,
      multiplier: input.minMultiplier + (1 - input.minMultiplier) * relative,
      allowNewRisk: true,
      reason: input.softReason
    };
  }
  return {
    sampleCount: input.summary.sampleCount,
    avgMarkoutBps: avg,
    multiplier: 1,
    allowNewRisk: true,
    reason: null
  };
}

function neutralFeedback(sampleCount = 0, avgMarkoutBps: number | null = null): AttributionVenueFeedback {
  return {
    sampleCount,
    avgMarkoutBps,
    multiplier: 1,
    allowNewRisk: true,
    reason: null
  };
}

function envNumber(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
