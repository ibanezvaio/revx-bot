import { DecisionAttributionRecord, DecisionAttributionVenue, TickerSnapshot } from "../store/Store";

export type AttributionSample = {
  record: DecisionAttributionRecord;
  venue: DecisionAttributionVenue;
  action: string;
  blocker: string | null;
  edge: number | null;
  directionalSign: number;
  referencePrice: number | null;
  markoutBps: number | null;
};

export type AttributionSampleSummary = {
  sampleCount: number;
  avgMarkoutBps: number | null;
  positiveRate: number | null;
};

export function buildAttributionSamples(input: {
  records: DecisionAttributionRecord[];
  tickerSnapshots: TickerSnapshot[];
  horizonSec: number;
  venue?: DecisionAttributionVenue;
  actions?: string[];
  includeBlocked?: boolean;
}): AttributionSample[] {
  const tickerSnapshots = [...input.tickerSnapshots]
    .filter((row) => Number.isFinite(row.mid) && row.mid > 0)
    .sort((a, b) => a.ts - b.ts);
  const allowedActions = input.actions ? new Set(input.actions) : null;
  const samples: AttributionSample[] = [];

  for (const record of input.records) {
    if (input.venue && record.venue !== input.venue) {
      continue;
    }
    if (allowedActions && !allowedActions.has(record.action)) {
      continue;
    }
    const blocker = normalizeString(record.blocker);
    if (blocker && !input.includeBlocked) {
      continue;
    }
    const details = parseJson(record.details_json);
    const directionalSign = inferDirectionalSign(record, details);
    const referencePrice =
      finiteOrNull(asObject(details.reference_price).price) ??
      finiteOrNull(record.reference_price);
    const markoutBps = computeSignedMarkoutBps(
      record.ts,
      referencePrice,
      directionalSign,
      input.horizonSec,
      tickerSnapshots
    );
    samples.push({
      record,
      venue: record.venue,
      action: record.action,
      blocker,
      edge: finiteOrNull(record.edge),
      directionalSign,
      referencePrice,
      markoutBps
    });
  }

  return samples.filter((row) => row.directionalSign !== 0 && row.markoutBps !== null);
}

export function summarizeAttributionSamples(samples: AttributionSample[]): AttributionSampleSummary {
  const markouts = samples
    .map((row) => row.markoutBps)
    .filter((value): value is number => Number.isFinite(Number(value)));
  return {
    sampleCount: markouts.length,
    avgMarkoutBps: average(markouts),
    positiveRate:
      markouts.length > 0
        ? (markouts.filter((value) => value > 0).length / markouts.length) * 100
        : null
  };
}

function inferDirectionalSign(record: DecisionAttributionRecord, details: Record<string, unknown>): number {
  const decision = asObject(details.decision);
  const sharedDirectional = asObject(details.shared_directional);
  const venueBias = asObject(sharedDirectional.venue_bias);
  const signalBias = normalizeString(decision.signal_bias) ?? normalizeString(venueBias.bias);

  if (record.venue === "POLYMARKET") {
    if (record.action === "BUY_YES") return 1;
    if (record.action === "BUY_NO") return -1;
    if (signalBias === "LONG") return 1;
    if (signalBias === "SHORT") return -1;
    return 0;
  }

  const buyLevels = finiteOrNull(decision.buy_levels) ?? 0;
  const sellLevels = finiteOrNull(decision.sell_levels) ?? 0;
  if (record.action === "QUOTE_BUY") return 1;
  if (record.action === "QUOTE_SELL") return -1;
  if (buyLevels > 0 && sellLevels <= 0) return 1;
  if (sellLevels > 0 && buyLevels <= 0) return -1;
  if (signalBias === "LONG") return 1;
  if (signalBias === "SHORT") return -1;
  return 0;
}

function computeSignedMarkoutBps(
  ts: number,
  referencePrice: number | null,
  directionalSign: number,
  horizonSec: number,
  tickerSnapshots: TickerSnapshot[]
): number | null {
  if (!(referencePrice && Number.isFinite(referencePrice) && referencePrice > 0) || directionalSign === 0) {
    return null;
  }
  const targetTs = ts + horizonSec * 1000;
  const future = tickerSnapshots.find((row) => row.ts >= targetTs && Number.isFinite(row.mid) && row.mid > 0);
  if (!future) {
    return null;
  }
  return ((future.mid - referencePrice) / referencePrice) * 10_000 * directionalSign;
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asObject(parsed);
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeString(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function finiteOrNull(value: unknown): number | null {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function average(values: number[]): number | null {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}
