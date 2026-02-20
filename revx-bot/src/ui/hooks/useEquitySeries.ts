export type EquityPoint = {
  ts: number;
  mid: number;
  equityUsd: number;
  equityBtc: number;
  usd_total: number;
  btc_total: number;
  usd_free: number;
  btc_free: number;
  btcNotionalUsd: number;
  usdNotionalBtc: number;
};

export type EquitySeriesConfig = {
  maxPoints: number;
  sampleMs: number;
};

function normalizeMaxPoints(maxPoints: number): number {
  if (!Number.isFinite(maxPoints)) return 5000;
  return Math.max(200, Math.min(50_000, Math.floor(maxPoints)));
}

function normalizeSampleMs(sampleMs: number): number {
  if (!Number.isFinite(sampleMs)) return 2000;
  return Math.max(250, Math.min(60_000, Math.floor(sampleMs)));
}

function bucketTs(ts: number, sampleMs: number): number {
  const interval = normalizeSampleMs(sampleMs);
  return Math.floor(ts / interval) * interval;
}

export function appendEquityPoint(
  points: EquityPoint[],
  point: EquityPoint,
  config: EquitySeriesConfig
): EquityPoint[] {
  const next = Array.isArray(points) ? points.slice() : [];
  const cappedPoint = { ...point, ts: bucketTs(point.ts, config.sampleMs) };

  if (next.length === 0 || cappedPoint.ts > next[next.length - 1].ts) {
    next.push(cappedPoint);
  } else if (cappedPoint.ts === next[next.length - 1].ts) {
    next[next.length - 1] = cappedPoint;
  } else {
    return next;
  }

  const maxPoints = normalizeMaxPoints(config.maxPoints);
  if (next.length > maxPoints) {
    return next.slice(next.length - maxPoints);
  }

  return next;
}

export function renderUseEquitySeriesScript(options: {
  maxEquityPointsDefault: number;
  equitySampleMsDefault: number;
  persistDefault: boolean;
  symbol: string;
}): string {
  const maxPoints = normalizeMaxPoints(options.maxEquityPointsDefault);
  const sampleMs = normalizeSampleMs(options.equitySampleMsDefault);
  const persist = options.persistDefault ? "true" : "false";
  const storageKey = `revx_equity_series_${String(options.symbol || "BTC-USD").replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  return [
    `const DEFAULT_MAX_EQUITY_POINTS = ${maxPoints};`,
    `const DEFAULT_EQUITY_SAMPLE_MS = ${sampleMs};`,
    `const DEFAULT_PERSIST_EQUITY_SERIES = ${persist};`,
    `const DEFAULT_EQUITY_STORAGE_KEY = ${JSON.stringify(storageKey)};`,
    "",
    "function eqNumber(value, fallback) {",
    "  const parsed = Number(value);",
    "  if (Number.isFinite(parsed)) return parsed;",
    "  return Number.isFinite(fallback) ? fallback : 0;",
    "}",
    "",
    "function eqNormalizeMaxPoints(value) {",
    "  const parsed = Number(value);",
    "  if (!Number.isFinite(parsed)) return DEFAULT_MAX_EQUITY_POINTS;",
    "  return Math.max(200, Math.min(50000, Math.floor(parsed)));",
    "}",
    "",
    "function eqNormalizeSampleMs(value) {",
    "  const parsed = Number(value);",
    "  if (!Number.isFinite(parsed)) return DEFAULT_EQUITY_SAMPLE_MS;",
    "  return Math.max(250, Math.min(60000, Math.floor(parsed)));",
    "}",
    "",
    "function eqBucketTs(ts, sampleMs) {",
    "  return Math.floor(eqNumber(ts, Date.now()) / eqNormalizeSampleMs(sampleMs)) * eqNormalizeSampleMs(sampleMs);",
    "}",
    "",
    "function eqAssetCode(row) {",
    "  if (!row || typeof row !== 'object') return '';",
    "  const direct = [row.asset, row.currency, row.code, row.ccy, row.symbol];",
    "  for (const val of direct) {",
    "    if (typeof val === 'string' && val.trim().length > 0) return val.trim().toUpperCase();",
    "  }",
    "  const nested = [row.asset, row.currency];",
    "  for (const value of nested) {",
    "    if (!value || typeof value !== 'object') continue;",
    "    const nestedCode = value.code || value.symbol || value.currency || value.asset;",
    "    if (typeof nestedCode === 'string' && nestedCode.trim().length > 0) return nestedCode.trim().toUpperCase();",
    "  }",
    "  return '';",
    "}",
    "",
    "function eqFindAsset(rows, aliases) {",
    "  const wanted = new Set((aliases || []).map((x) => String(x).toUpperCase()));",
    "  const list = Array.isArray(rows) ? rows : [];",
    "  for (const row of list) {",
    "    const code = eqAssetCode(row);",
    "    if (wanted.has(code)) return row;",
    "  }",
    "  return null;",
    "}",
    "",
    "function eqBalancesFromState(statePayload) {",
    "  const balancesRows = Array.isArray(statePayload && statePayload.balances) ? statePayload.balances : [];",
    "  const usdAsset = eqFindAsset(balancesRows, ['USD', 'USDC']);",
    "  const btcAsset = eqFindAsset(balancesRows, ['BTC', 'XBT']);",
    "",
    "  const usd_total = eqNumber((usdAsset && usdAsset.total) ?? statePayload?.balances?.usd_total, 0);",
    "  const usd_free = eqNumber((usdAsset && usdAsset.free) ?? statePayload?.balances?.usd_free, 0);",
    "  const btc_total = eqNumber((btcAsset && btcAsset.total) ?? statePayload?.balances?.btc_total, 0);",
    "  const btc_free = eqNumber((btcAsset && btcAsset.free) ?? statePayload?.balances?.btc_free, 0);",
    "",
    "  return { usd_total, usd_free, btc_total, btc_free };",
    "}",
    "",
    "function eqComputeSnapshot(statePayload) {",
    "  const mid = eqNumber(statePayload?.ticker?.mid, 0);",
    "  if (!(mid > 0)) return null;",
    "  const balances = eqBalancesFromState(statePayload || {});",
    "  const ts = eqNumber(statePayload?.ts, Date.now());",
    "",
    "  const equityUsd = balances.usd_total + balances.btc_total * mid;",
    "  const equityBtc = balances.btc_total + balances.usd_total / mid;",
    "  const btcNotionalUsd = balances.btc_total * mid;",
    "  const usdNotionalBtc = balances.usd_total / mid;",
    "",
    "  return {",
    "    ts,",
    "    mid,",
    "    equityUsd,",
    "    equityBtc,",
    "    usd_total: balances.usd_total,",
    "    btc_total: balances.btc_total,",
    "    usd_free: balances.usd_free,",
    "    btc_free: balances.btc_free,",
    "    btcNotionalUsd,",
    "    usdNotionalBtc",
    "  };",
    "}",
    "",
    "function eqAppendPoint(existing, point, options) {",
    "  const next = Array.isArray(existing) ? existing.slice() : [];",
    "  const sampleMs = eqNormalizeSampleMs(options?.sampleMs ?? DEFAULT_EQUITY_SAMPLE_MS);",
    "  const maxPoints = eqNormalizeMaxPoints(options?.maxPoints ?? DEFAULT_MAX_EQUITY_POINTS);",
    "  const normalizedPoint = { ...point, ts: eqBucketTs(point.ts, sampleMs) };",
    "  const last = next.length > 0 ? next[next.length - 1] : null;",
    "",
    "  if (!last || normalizedPoint.ts > last.ts) {",
    "    next.push(normalizedPoint);",
    "  } else if (normalizedPoint.ts === last.ts) {",
    "    next[next.length - 1] = normalizedPoint;",
    "  } else {",
    "    return next;",
    "  }",
    "",
    "  if (next.length > maxPoints) {",
    "    return next.slice(next.length - maxPoints);",
    "  }",
    "",
    "  return next;",
    "}",
    "",
    "function eqFilterByWindow(points, windowKey) {",
    "  const list = Array.isArray(points) ? points : [];",
    "  const now = Date.now();",
    "  const windows = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000, '4h': 4 * 60 * 60 * 1000, '12h': 12 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 };",
    "  const span = windows[windowKey] || windows['24h'];",
    "  const cutoff = now - span;",
    "  return list.filter((point) => eqNumber(point.ts, 0) >= cutoff);",
    "}",
    "",
    "function eqReadPersistedSeries(storageKey) {",
    "  try {",
    "    if (typeof localStorage === 'undefined') return [];",
    "    const raw = localStorage.getItem(storageKey);",
    "    if (!raw) return [];",
    "    const parsed = JSON.parse(raw);",
    "    if (!Array.isArray(parsed)) return [];",
    "    return parsed",
    "      .filter((row) => row && Number.isFinite(Number(row.ts)) && Number.isFinite(Number(row.equityUsd)) && Number.isFinite(Number(row.equityBtc)))",
    "      .slice(-DEFAULT_MAX_EQUITY_POINTS);",
    "  } catch {",
    "    return [];",
    "  }",
    "}",
    "",
    "function eqPersistSeries(storageKey, points) {",
    "  try {",
    "    if (typeof localStorage === 'undefined') return;",
    "    localStorage.setItem(storageKey, JSON.stringify((Array.isArray(points) ? points : []).slice(-DEFAULT_MAX_EQUITY_POINTS)));",
    "  } catch {",
    "    // ignore quota/storage errors",
    "  }",
    "}",
    "",
    "function eqClearPersistedSeries(storageKey) {",
    "  try {",
    "    if (typeof localStorage === 'undefined') return;",
    "    localStorage.removeItem(storageKey);",
    "  } catch {",
    "    // ignore storage errors",
    "  }",
    "}",
    "",
    "function useEquitySeries(statePayload, existingPoints, options) {",
    "  const snapshot = eqComputeSnapshot(statePayload);",
    "  if (!snapshot) return Array.isArray(existingPoints) ? existingPoints : [];",
    "  const next = eqAppendPoint(existingPoints, snapshot, options);",
    "  if (options && options.persist) {",
    "    eqPersistSeries(options.storageKey || DEFAULT_EQUITY_STORAGE_KEY, next);",
    "  }",
    "  return next;",
    "}",
    ""
  ].join("\n");
}
