import { DecisionAttributionRecord, DecisionAttributionVenue } from "../store/Store";
import { SharedDirectionalInputs, SharedReferencePrice } from "./SharedMarketIntelligence";

type DecisionAttributionInput = {
  decisionId: string;
  ts: number;
  venue: DecisionAttributionVenue;
  strategy: string;
  symbol: string;
  action: string;
  blocker?: string | null;
  edge?: number | null;
  referencePrice: SharedReferencePrice;
  directionalInputs: SharedDirectionalInputs;
  market?: Record<string, unknown>;
  decision?: Record<string, unknown>;
  portfolio?: Record<string, unknown>;
  outcomeTracking?: Record<string, unknown>;
};

export function buildDecisionAttributionRecord(input: DecisionAttributionInput): DecisionAttributionRecord {
  const referencePrice =
    Number.isFinite(Number(input.referencePrice.price)) && Number(input.referencePrice.price) > 0
      ? Number(input.referencePrice.price)
      : null;
  const edge = Number.isFinite(Number(input.edge)) ? Number(input.edge) : null;
  const blocker = typeof input.blocker === "string" && input.blocker.trim().length > 0 ? input.blocker : null;

  return {
    decision_id: input.decisionId,
    ts: input.ts,
    venue: input.venue,
    strategy: input.strategy,
    symbol: input.symbol,
    action: input.action,
    blocker,
    reference_price: referencePrice,
    edge,
    details_json: JSON.stringify({
      schema: "decision_attribution.v1",
      ts: input.ts,
      venue: input.venue,
      strategy: input.strategy,
      symbol: input.symbol,
      action: input.action,
      blocker,
      edge,
      reference_price: serializeReferencePrice(input.referencePrice),
      shared_directional: serializeDirectionalInputs(input.directionalInputs),
      market: input.market ?? {},
      decision: input.decision ?? {},
      portfolio: input.portfolio ?? {},
      outcome_tracking: input.outcomeTracking ?? {}
    })
  };
}

function serializeReferencePrice(input: SharedReferencePrice): Record<string, unknown> {
  return {
    price:
      Number.isFinite(Number(input.price)) && Number(input.price) > 0
        ? Number(input.price)
        : null,
    age_ms: Number.isFinite(Number(input.ageMs)) ? Number(input.ageMs) : null,
    ts: Number.isFinite(Number(input.ts)) ? Number(input.ts) : null,
    source: input.source
  };
}

function serializeDirectionalInputs(input: SharedDirectionalInputs): Record<string, unknown> {
  return {
    aggregate: input.aggregate
      ? {
          ts: Number.isFinite(Number(input.aggregate.ts)) ? Number(input.aggregate.ts) : null,
          latest_ts: Number.isFinite(Number(input.aggregate.latestTs)) ? Number(input.aggregate.latestTs) : null,
          state: input.aggregate.state,
          direction: input.aggregate.direction,
          impact: finiteOrNull(input.aggregate.impact),
          confidence: finiteOrNull(input.aggregate.confidence),
          reasons: Array.isArray(input.aggregate.reasons) ? input.aggregate.reasons.slice(0, 8) : []
        }
      : null,
    intel_posture: input.intelPosture
      ? {
          ts: Number.isFinite(Number(input.intelPosture.ts)) ? Number(input.intelPosture.ts) : null,
          state: input.intelPosture.state,
          direction: input.intelPosture.direction,
          impact: finiteOrNull(input.intelPosture.impact),
          confidence: finiteOrNull(input.intelPosture.confidence),
          skew_bps: finiteOrNull(input.intelPosture.skewBps),
          widen_bps: finiteOrNull(input.intelPosture.widenBps),
          size_cut: finiteOrNull(input.intelPosture.sizeCut),
          reasons: Array.isArray(input.intelPosture.reasons) ? input.intelPosture.reasons.slice(0, 8) : []
        }
      : null,
    venue_bias: {
      bias: input.venueBias.bias,
      confidence: finiteOrNull(input.venueBias.confidence),
      ts: Number.isFinite(Number(input.venueBias.ts)) ? Number(input.venueBias.ts) : null,
      source: input.venueBias.source
    }
  };
}

function finiteOrNull(value: unknown): number | null {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}
