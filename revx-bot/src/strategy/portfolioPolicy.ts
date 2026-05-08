import { RevxPortfolioQuotePolicy } from "../risk/PortfolioRiskCoordinator";

export type RevxPortfolioQuoteInputs = {
  workingCapUsd: number;
  targetBtcNotionalUsd: number;
  maxBtcNotionalUsd: number;
  buyQuoteSizeUsd: number;
  minQuoteSizeUsd: number;
};

export type RevxPortfolioQuoteAdjustment = {
  workingCapUsd: number;
  targetBtcNotionalUsd: number;
  maxBtcNotionalUsd: number;
  buyQuoteSizeUsd: number;
  blockedBuyReason: string | null;
  policyApplied: boolean;
};

export function applyRevxPortfolioQuotePolicy(
  inputs: RevxPortfolioQuoteInputs,
  policy: RevxPortfolioQuotePolicy | null
): RevxPortfolioQuoteAdjustment {
  if (!policy) {
    return {
      ...inputs,
      blockedBuyReason: null,
      policyApplied: false
    };
  }

  const workingCapUsd = clampNonNegative(Math.min(inputs.workingCapUsd, policy.effectiveWorkingCapUsd));
  const maxBtcNotionalUsd = clampNonNegative(Math.min(inputs.maxBtcNotionalUsd, policy.effectiveMaxBtcNotionalUsd));
  const targetBtcNotionalUsd = clampNonNegative(Math.min(inputs.targetBtcNotionalUsd, policy.effectiveTargetBtcNotionalUsd));
  const maxQuoteBeforeClamp = Math.max(0, inputs.buyQuoteSizeUsd);
  const scaledBuyQuoteSizeUsd = maxQuoteBeforeClamp * clamp(policy.buySizeMultiplier, 0, 1);
  const buyQuoteSizeUsd =
    scaledBuyQuoteSizeUsd > 0
      ? clamp(scaledBuyQuoteSizeUsd, inputs.minQuoteSizeUsd, maxQuoteBeforeClamp)
      : 0;
  const blockedBuyReason = policy.allowNewBuyRisk ? null : policy.reason || "REVX_PORTFOLIO_BUY_GATE";

  return {
    workingCapUsd,
    targetBtcNotionalUsd,
    maxBtcNotionalUsd: Math.max(targetBtcNotionalUsd, maxBtcNotionalUsd),
    buyQuoteSizeUsd,
    blockedBuyReason,
    policyApplied: true
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
