import { ExternalVenueSnapshot, VenueHealth } from "./types";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function safeBpsDiff(current: number, anchor: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(anchor) || anchor <= 0) return 0;
  return ((current - anchor) / anchor) * 10_000;
}

export function computeSpreadBps(bid: number, ask: number): number | null {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask <= bid) {
    return null;
  }
  const mid = (bid + ask) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return null;
  return ((ask - bid) / mid) * 10_000;
}

export function weightedMedian(values: Array<{ value: number; weight: number }>): number | null {
  const rows = values
    .filter((row) => Number.isFinite(row.value) && Number.isFinite(row.weight) && row.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (rows.length === 0) return null;
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) return null;
  const half = totalWeight / 2;
  let acc = 0;
  for (const row of rows) {
    acc += row.weight;
    if (acc >= half) return row.value;
  }
  return rows[rows.length - 1].value;
}

export function trimmedWeightedMean(
  values: Array<{ value: number; weight: number }>,
  trimFraction = 0.15
): number | null {
  const rows = values
    .filter((row) => Number.isFinite(row.value) && Number.isFinite(row.weight) && row.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (rows.length === 0) return null;
  if (rows.length <= 2) {
    const sw = rows.reduce((sum, row) => sum + row.weight, 0);
    if (sw <= 0) return null;
    return rows.reduce((sum, row) => sum + row.value * row.weight, 0) / sw;
  }
  const trimEachSide = Math.floor(rows.length * trimFraction);
  const sliced = rows.slice(trimEachSide, rows.length - trimEachSide);
  if (sliced.length === 0) return null;
  const sw = sliced.reduce((sum, row) => sum + row.weight, 0);
  if (sw <= 0) return null;
  return sliced.reduce((sum, row) => sum + row.value * row.weight, 0) / sw;
}

export function robustGlobalMid(
  healthyVenues: VenueHealth[]
): { globalMid: number | null; method: "weighted_median" | "trimmed_mean" | "fallback_mean" } {
  const values = healthyVenues
    .filter((venue) => Number.isFinite(venue.mid) && (venue.mid as number) > 0 && venue.weight > 0)
    .map((venue) => ({
      value: venue.mid as number,
      weight: venue.weight
    }));
  if (values.length === 0) return { globalMid: null, method: "fallback_mean" };

  const median = weightedMedian(values);
  const trimmed = trimmedWeightedMean(values);
  if (median !== null && trimmed !== null) {
    return {
      globalMid: median * 0.7 + trimmed * 0.3,
      method: "weighted_median"
    };
  }
  if (median !== null) return { globalMid: median, method: "weighted_median" };
  if (trimmed !== null) return { globalMid: trimmed, method: "trimmed_mean" };

  const mean = values.reduce((sum, row) => sum + row.value, 0) / values.length;
  return { globalMid: Number.isFinite(mean) ? mean : null, method: "fallback_mean" };
}

export function computeDispersionBps(
  globalMid: number,
  snapshots: Array<Pick<ExternalVenueSnapshot, "mid" | "ok">>
): number {
  if (!Number.isFinite(globalMid) || globalMid <= 0) return 0;
  let maxDispersion = 0;
  for (const row of snapshots) {
    if (!row.ok || !Number.isFinite(row.mid) || (row.mid as number) <= 0) continue;
    const diff = Math.abs(((row.mid as number) - globalMid) / globalMid) * 10_000;
    if (diff > maxDispersion) {
      maxDispersion = diff;
    }
  }
  return maxDispersion;
}

export function computeDriftBpsFromSeries(
  series: Array<{ ts: number; value: number }>,
  windowMs: number
): number {
  if (series.length < 2) return 0;
  const latest = series[series.length - 1];
  const cutoff = latest.ts - windowMs;
  let anchor = series[0];
  for (const point of series) {
    anchor = point;
    if (point.ts >= cutoff) break;
  }
  return safeBpsDiff(latest.value, anchor.value);
}

export function computeReturnsStdevBps(
  series: Array<{ ts: number; value: number }>,
  windowMs: number
): number {
  if (series.length < 2) return 0;
  const latestTs = series[series.length - 1].ts;
  const cutoff = latestTs - windowMs;
  const window = series.filter((point) => point.ts >= cutoff);
  if (window.length < 3) return 0;
  const returns: number[] = [];
  for (let i = 1; i < window.length; i += 1) {
    const prev = window[i - 1].value;
    const curr = window[i].value;
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0 || curr <= 0) continue;
    returns.push(((curr - prev) / prev) * 10_000);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, returns.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

export function emaUpdate(current: number | null, nextValue: number, alpha: number): number {
  if (!Number.isFinite(nextValue)) return current ?? 0;
  if (current === null || !Number.isFinite(current)) return nextValue;
  const a = clamp(alpha, 0, 1);
  return a * nextValue + (1 - a) * current;
}

