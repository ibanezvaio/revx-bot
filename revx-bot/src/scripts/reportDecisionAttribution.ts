import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { createStore } from "../store/factory";
import { DecisionAttributionRecord, TickerSnapshot } from "../store/Store";

type ParsedAttribution = {
  action: string;
  blocker: string | null;
  edge: number | null;
  referencePrice: number | null;
  directionalSign: number;
};

function run(): void {
  const config = loadConfig();
  const logger = buildLogger(config);
  const store = createStore(config, logger);
  store.init();

  try {
    const limit = Math.max(10, Number(process.env.DECISION_ATTRIBUTION_LIMIT || 500));
    const venueEnv = String(process.env.DECISION_ATTRIBUTION_VENUE || "").trim().toUpperCase();
    const venue = venueEnv === "REVX" || venueEnv === "POLYMARKET" ? venueEnv : undefined;
    const records = store.getRecentDecisionAttributions(limit, venue);
    const tickerSnapshots = [...store.getRecentTickerSnapshots(config.symbol, Math.max(limit * 50, 20_000))].sort(
      (a, b) => a.ts - b.ts
    );
    const rows = summarize(records, tickerSnapshots);

    // eslint-disable-next-line no-console
    console.log(
      `Decision attribution summary for ${config.symbol} (${records.length} records${venue ? `, venue=${venue}` : ""})`
    );
    // eslint-disable-next-line no-console
    console.table(rows);
  } finally {
    store.close();
  }
}

function summarize(
  records: DecisionAttributionRecord[],
  tickerSnapshots: TickerSnapshot[]
): Array<Record<string, unknown>> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();

  for (const record of records) {
    const parsed = parseRecord(record);
    const key = `${record.venue}:${record.action}`;
    const bucket = grouped.get(key) ?? [];
    const markout60Bps = computeSignedMarkoutBps(record.ts, parsed.referencePrice, parsed.directionalSign, 60, tickerSnapshots);
    const markout300Bps = computeSignedMarkoutBps(record.ts, parsed.referencePrice, parsed.directionalSign, 300, tickerSnapshots);
    bucket.push({
      venue: record.venue,
      action: record.action,
      blocked: parsed.blocker ? 1 : 0,
      edge: parsed.edge,
      directional: parsed.directionalSign !== 0 ? 1 : 0,
      markout60Bps,
      markout300Bps
    });
    grouped.set(key, bucket);
  }

  return [...grouped.entries()]
    .map(([key, rows]) => {
      const [venue, action] = key.split(":");
      return {
        venue,
        action,
        count: rows.length,
        blocked_pct: pct(rows.reduce((sum, row) => sum + Number(row.blocked || 0), 0), rows.length),
        avg_edge: avg(rows.map((row) => Number(row.edge))),
        directional_count: rows.reduce((sum, row) => sum + Number(row.directional || 0), 0),
        avg_markout_60_bps: avg(rows.map((row) => Number(row.markout60Bps))),
        avg_markout_300_bps: avg(rows.map((row) => Number(row.markout300Bps)))
      };
    })
    .sort((a, b) => Number(b.count) - Number(a.count));
}

function parseRecord(record: DecisionAttributionRecord): ParsedAttribution {
  const details = parseJson(record.details_json);
  const decision = asObject(details.decision);
  const sharedDirectional = asObject(details.shared_directional);
  const venueBias = asObject(sharedDirectional.venue_bias);
  const bias = String(venueBias.bias ?? decision.signal_bias ?? "").toUpperCase();
  const referencePrice =
    finiteOrNull(asObject(details.reference_price).price) ??
    finiteOrNull(record.reference_price);
  const directionalSign = inferDirectionalSign(record.action, bias);
  return {
    action: record.action,
    blocker: typeof record.blocker === "string" && record.blocker.trim().length > 0 ? record.blocker : null,
    edge: finiteOrNull(record.edge),
    referencePrice,
    directionalSign
  };
}

function inferDirectionalSign(action: string, bias: string): number {
  if (action === "BUY_YES" || action === "QUOTE_BUY") return 1;
  if (action === "BUY_NO" || action === "QUOTE_SELL") return -1;
  if (bias === "LONG") return 1;
  if (bias === "SHORT") return -1;
  return 0;
}

function computeSignedMarkoutBps(
  ts: number,
  referencePrice: number | null,
  directionalSign: number,
  horizonSec: number,
  tickerSnapshots: TickerSnapshot[]
): number | null {
  if (!referencePrice || !Number.isFinite(referencePrice) || referencePrice <= 0 || directionalSign === 0) {
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

function finiteOrNull(value: unknown): number | null {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function avg(values: number[]): number | null {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function pct(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return (numerator / denominator) * 100;
}

if (require.main === module) {
  run();
}
