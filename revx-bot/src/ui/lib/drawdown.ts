export type DrawdownField = "equityUsd" | "equityBtc";

export type DrawdownInputPoint = {
  ts: number;
  equityUsd: number;
  equityBtc: number;
};

export type DrawdownPoint = {
  ts: number;
  value: number;
  peak: number;
  drawdownAbs: number;
  drawdownPct: number;
};

export type DrawdownSummary = {
  maxDrawdownAbs: number;
  maxDrawdownPct: number;
};

export type DrawdownResult = {
  series: DrawdownPoint[];
  summary: DrawdownSummary;
};

export function computeDrawdown(points: DrawdownInputPoint[], field: DrawdownField): DrawdownResult {
  const sorted = [...points]
    .filter((point) => point && Number.isFinite(point.ts) && Number.isFinite(point[field]))
    .sort((a, b) => a.ts - b.ts);

  if (sorted.length === 0) {
    return {
      series: [],
      summary: { maxDrawdownAbs: 0, maxDrawdownPct: 0 }
    };
  }

  let runningPeak = -Infinity;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;
  const series: DrawdownPoint[] = [];

  for (const point of sorted) {
    const value = Number(point[field]);
    if (value > runningPeak) {
      runningPeak = value;
    }

    const drawdownAbs = value - runningPeak;
    const drawdownPct = runningPeak > 0 ? (drawdownAbs / runningPeak) * 100 : 0;

    if (drawdownAbs < maxDrawdownAbs) {
      maxDrawdownAbs = drawdownAbs;
    }
    if (drawdownPct < maxDrawdownPct) {
      maxDrawdownPct = drawdownPct;
    }

    series.push({
      ts: point.ts,
      value,
      peak: runningPeak,
      drawdownAbs,
      drawdownPct
    });
  }

  return {
    series,
    summary: {
      maxDrawdownAbs,
      maxDrawdownPct
    }
  };
}
