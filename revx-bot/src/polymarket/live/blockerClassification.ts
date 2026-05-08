export type PolymarketBlockerCategory = "STRUCTURAL" | "SAFETY" | "PORTFOLIO" | "UNKNOWN";
export type PolymarketBlockerStage =
  | "DISCOVERY"
  | "SELECTION"
  | "GATE"
  | "DISPATCH"
  | "EXECUTION"
  | "PORTFOLIO"
  | "UNKNOWN";

export type PolymarketBlockerClassification = {
  reason: string | null;
  category: PolymarketBlockerCategory;
  stage: PolymarketBlockerStage;
};

export type PolymarketBlockerSummary = {
  countsByCategory: Record<string, number>;
  countsByStage: Record<string, number>;
  topReasons: Array<{
    reason: string;
    count: number;
    category: PolymarketBlockerCategory;
    stage: PolymarketBlockerStage;
  }>;
  positiveEdgeBlockedCount: number;
  samples: number;
};

const PORTFOLIO_PREFIXES = ["PORTFOLIO_", "ATTRIBUTION_", "CAPITAL_RESERVED_"];

const PORTFOLIO_REASONS = new Set([
  "PORTFOLIO_ENTRY_GATE"
]);

const STRUCTURAL_STAGE_REASONS = new Map<string, PolymarketBlockerStage>([
  ["NO_CANDIDATE_MARKETS", "DISCOVERY"],
  ["NETWORK_ERROR", "DISCOVERY"],
  ["DISCOVERY_STALE", "DISCOVERY"],
  ["NEXT_BUCKET_HANDOFF_WAIT", "SELECTION"],
  ["SELECTION_VERSION_MISMATCH", "SELECTION"],
  ["PREORDER_STALE_MARKET_SELECTION", "SELECTION"],
  ["EXPIRED_WINDOW", "SELECTION"],
  ["SELECTED_TOKEN_NOT_EXECUTABLE", "SELECTION"],
  ["EXECUTION_COOLDOWN", "DISPATCH"],
  ["ENTRY_ATTEMPT_COOLDOWN", "DISPATCH"],
  ["PROFIT_TAKE_IN_FLIGHT", "DISPATCH"],
  ["REENTRY_WAIT_CLEAR", "DISPATCH"],
  ["REENTRY_COOLDOWN", "DISPATCH"],
  ["MAX_ENTRIES_PER_WINDOW", "DISPATCH"],
  ["MAX_OPEN_ENTRY_ORDERS_PER_WINDOW", "DISPATCH"],
  ["POST_ROLLOVER_GRACE", "DISPATCH"],
  ["EXECUTION_IN_FLIGHT", "EXECUTION"],
  ["STALE_ATTEMPT_ABORTED", "EXECUTION"],
  ["LIVE_PLACED_NO_FILL", "EXECUTION"],
  ["LIVE_REJECTED", "EXECUTION"],
  ["ORDER_STATUS_UNKNOWN", "EXECUTION"]
]);

const SAFETY_STAGE_REASONS = new Map<string, PolymarketBlockerStage>([
  ["FAIR_PRICE_UNAVAILABLE", "GATE"],
  ["TOKEN_NOT_BOOKABLE", "GATE"],
  ["TOO_LATE_FOR_ENTRY", "GATE"],
  ["SPREAD_TOO_WIDE", "GATE"],
  ["EXTREME_PRICE_FILTER", "GATE"],
  ["INSUFFICIENT_DISLOCATION", "GATE"],
  ["EDGE_BELOW_THRESHOLD", "GATE"],
  ["SIZE_BELOW_MIN_NOTIONAL", "EXECUTION"],
  ["RISK_BLOCKED", "EXECUTION"],
  ["STALE_ORACLE_HARD_BLOCK", "EXECUTION"],
  ["LIVE_EXECUTION_DISABLED", "EXECUTION"]
]);

export function classifyPolymarketBlocker(reason: string | null | undefined): PolymarketBlockerClassification {
  const normalized = normalizeReason(reason);
  if (!normalized) {
    return {
      reason: null,
      category: "UNKNOWN",
      stage: "UNKNOWN"
    };
  }
  if (PORTFOLIO_REASONS.has(normalized) || PORTFOLIO_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return { reason: normalized, category: "PORTFOLIO", stage: "PORTFOLIO" };
  }
  const structuralStage = STRUCTURAL_STAGE_REASONS.get(normalized);
  if (structuralStage) {
    return { reason: normalized, category: "STRUCTURAL", stage: structuralStage };
  }
  const safetyStage = SAFETY_STAGE_REASONS.get(normalized);
  if (safetyStage) {
    return { reason: normalized, category: "SAFETY", stage: safetyStage };
  }
  return { reason: normalized, category: "UNKNOWN", stage: "UNKNOWN" };
}

export function summarizePolymarketBlockers(
  items: Array<{ blocker?: string | null; edge?: number | null }>
): PolymarketBlockerSummary {
  const countsByCategory: Record<string, number> = {};
  const countsByStage: Record<string, number> = {};
  const byReason = new Map<string, { count: number; category: PolymarketBlockerCategory; stage: PolymarketBlockerStage }>();
  let positiveEdgeBlockedCount = 0;
  let samples = 0;

  for (const item of items) {
    const classification = classifyPolymarketBlocker(item.blocker ?? null);
    if (!classification.reason) {
      continue;
    }
    samples += 1;
    countsByCategory[classification.category] = (countsByCategory[classification.category] || 0) + 1;
    countsByStage[classification.stage] = (countsByStage[classification.stage] || 0) + 1;
    const existing = byReason.get(classification.reason);
    if (existing) {
      existing.count += 1;
    } else {
      byReason.set(classification.reason, {
        count: 1,
        category: classification.category,
        stage: classification.stage
      });
    }
    if (Number.isFinite(Number(item.edge)) && Number(item.edge) > 0) {
      positiveEdgeBlockedCount += 1;
    }
  }

  return {
    countsByCategory,
    countsByStage,
    topReasons: [...byReason.entries()]
      .map(([reason, row]) => ({
        reason,
        count: row.count,
        category: row.category,
        stage: row.stage
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    positiveEdgeBlockedCount,
    samples
  };
}

function normalizeReason(reason: string | null | undefined): string | null {
  const normalized = String(reason ?? "").trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}
