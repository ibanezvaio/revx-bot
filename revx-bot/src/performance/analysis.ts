import {
  AnalysisSummary,
  AnalysisWindowKey,
  EquityPoint,
  FillAnalysisRow,
  MidSnapshotRow,
  PersistedFillRow
} from "./types";

const WINDOW_MS: Record<AnalysisWindowKey, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000
};

type Lot = {
  qty: number;
  price: number;
  ts: number;
};

type MatchedSegment = {
  qty: number;
  buyTs: number;
  sellTs: number;
};

export function windowToMs(window: AnalysisWindowKey): number {
  return WINDOW_MS[window];
}

export function computeEdgeBps(fill: PersistedFillRow): number | null {
  if (!(fill.price > 0) || !(fill.revx_mid_at_fill > 0)) return null;
  if (fill.side === "BUY") {
    return ((fill.revx_mid_at_fill - fill.price) / fill.revx_mid_at_fill) * 10_000;
  }
  return ((fill.price - fill.revx_mid_at_fill) / fill.revx_mid_at_fill) * 10_000;
}

export function computeToxBps(
  fill: PersistedFillRow,
  midAfter: number | null
): number | null {
  if (!(fill.revx_mid_at_fill > 0) || !midAfter || !(midAfter > 0)) return null;
  if (fill.side === "BUY") {
    return ((midAfter - fill.revx_mid_at_fill) / fill.revx_mid_at_fill) * 10_000;
  }
  return ((fill.revx_mid_at_fill - midAfter) / fill.revx_mid_at_fill) * 10_000;
}

export function analyzeFillsWindow(params: {
  fills: PersistedFillRow[];
  mids: MidSnapshotRow[];
  latestMid: number;
  nowTs: number;
  window: AnalysisWindowKey;
  inventoryToxicThresholdUsd?: number;
  cancelReplaceRatio?: number;
}): {
  summary: AnalysisSummary;
  rows: FillAnalysisRow[];
  curve: EquityPoint[];
} {
  const nowTs = Math.max(0, Math.floor(params.nowTs || Date.now()));
  const windowMs = windowToMs(params.window);
  const windowStart = nowTs - windowMs;
  const latestMid = Number.isFinite(params.latestMid) && params.latestMid > 0 ? params.latestMid : 0;
  const fillsSorted = [...params.fills].sort((a, b) => a.ts - b.ts);
  const midsSorted = [...params.mids].sort((a, b) => a.ts - b.ts);
  const inWindow = fillsSorted.filter((row) => row.ts >= windowStart);

  const rows: FillAnalysisRow[] = inWindow.map((fill) => {
    const tox30 = computeToxBps(fill, lookupMidAtOrAfter(midsSorted, fill.ts + 30_000));
    const tox2m = computeToxBps(fill, lookupMidAtOrAfter(midsSorted, fill.ts + 120_000));
    return {
      id: fill.id,
      ts: fill.ts,
      side: fill.side,
      price: fill.price,
      baseQty: fill.base_qty,
      quoteQty: fill.quote_qty,
      feeUsd: fill.fee_usd,
      orderId: fill.order_id,
      clientOrderId: fill.client_order_id,
      posture: fill.posture,
      revxMidAtFill: fill.revx_mid_at_fill,
      edgeBps: computeEdgeBps(fill),
      toxBps30s: tox30,
      toxBps2m: tox2m
    };
  });

  const edges = rows.map((row) => row.edgeBps).filter(isFiniteNumber);
  const buyEdges = rows
    .filter((row) => row.side === "BUY")
    .map((row) => row.edgeBps)
    .filter(isFiniteNumber);
  const sellEdges = rows
    .filter((row) => row.side === "SELL")
    .map((row) => row.edgeBps)
    .filter(isFiniteNumber);
  const tox30s = rows.map((row) => row.toxBps30s).filter(isFiniteNumber);
  const tox2m = rows.map((row) => row.toxBps2m).filter(isFiniteNumber);
  const toxicPct = tox30s.length > 0 ? tox30s.filter((value) => value < -2).length / tox30s.length : 0;

  const fifo = computeFifoPnl(inWindow);
  const inventoryBase = fifo.inventoryBase;
  const unrealizedPnlUsd =
    latestMid > 0
      ? inventoryBase > 0
        ? (latestMid - fifo.inventoryCostBasis) * inventoryBase
        : 0
      : 0;
  const netPnlUsd = fifo.realizedPnlUsd + unrealizedPnlUsd;

  const inventorySeries = computeInventoryNotionalSeries(inWindow);
  const inventoryThreshold = Math.max(10, Number(params.inventoryToxicThresholdUsd) || 50);
  const avgAbsInventoryNotional =
    inventorySeries.length > 0
      ? inventorySeries.reduce((sum, row) => sum + Math.abs(row.notionalUsd), 0) / inventorySeries.length
      : 0;
  const aboveThresholdPct =
    inventorySeries.length > 0
      ? inventorySeries.filter((row) => Math.abs(row.notionalUsd) >= inventoryThreshold).length /
        inventorySeries.length
      : 0;
  const terminalInventory = inventorySeries.length > 0 ? inventorySeries[inventorySeries.length - 1].notionalUsd : 0;
  const inventorySkewDirection =
    terminalInventory > 1 ? "LONG" : terminalInventory < -1 ? "SHORT" : "NEUTRAL";

  const fillsPerHour =
    windowMs > 0 ? (inWindow.length / windowMs) * 60 * 60 * 1000 : 0;
  const avgHoldSeconds =
    fifo.matched.length > 0
      ? fifo.matched.reduce((sum, row) => sum + (row.sellTs - row.buyTs) / 1000, 0) / fifo.matched.length
      : 0;

  const curve = buildEquityCurve(inWindow, midsSorted, latestMid, windowStart);

  const summary: AnalysisSummary = {
    window: params.window,
    ts: nowTs,
    fillsCount: inWindow.length,
    fillsPerHour,
    realizedPnlUsd: fifo.realizedPnlUsd,
    unrealizedPnlUsd,
    netPnlUsd,
    avgEdgeBps: mean(edges),
    medianEdgeBps: percentile(edges, 0.5),
    avgEdgeBpsBuy: mean(buyEdges),
    avgEdgeBpsSell: mean(sellEdges),
    avgToxBps30s: mean(tox30s),
    avgToxBps2m: mean(tox2m),
    toxicPct30s: toxicPct,
    toxP10Bps30s: percentile(tox30s, 0.1),
    avgInventoryNotionalUsdAbs: avgAbsInventoryNotional,
    inventoryAboveThresholdPct: aboveThresholdPct,
    inventorySkewDirection,
    avgHoldSeconds,
    cancelReplaceRatio: Number.isFinite(Number(params.cancelReplaceRatio))
      ? Number(params.cancelReplaceRatio)
      : 0,
    latestMid,
    computedAtTs: nowTs
  };
  return { summary, rows, curve };
}

function computeFifoPnl(fills: PersistedFillRow[]): {
  realizedPnlUsd: number;
  inventoryBase: number;
  inventoryCostBasis: number;
  matched: MatchedSegment[];
} {
  const buyLots: Lot[] = [];
  const matched: MatchedSegment[] = [];
  let realizedPnlUsd = 0;

  for (const fill of fills) {
    const qty = safePositive(fill.base_qty);
    const price = safePositive(fill.price);
    const fee = Number.isFinite(fill.fee_usd) ? fill.fee_usd : 0;
    if (!(qty > 0) || !(price > 0)) continue;

    realizedPnlUsd -= fee;
    if (fill.side === "BUY") {
      buyLots.push({ qty, price, ts: fill.ts });
      continue;
    }

    let remaining = qty;
    while (remaining > 1e-12 && buyLots.length > 0) {
      const lot = buyLots[0];
      const matchedQty = Math.min(remaining, lot.qty);
      realizedPnlUsd += (price - lot.price) * matchedQty;
      matched.push({ qty: matchedQty, buyTs: lot.ts, sellTs: fill.ts });
      lot.qty -= matchedQty;
      remaining -= matchedQty;
      if (lot.qty <= 1e-12) buyLots.shift();
    }
  }

  const inventoryBase = buyLots.reduce((sum, lot) => sum + lot.qty, 0);
  const inventoryCostBasis =
    inventoryBase > 0
      ? buyLots.reduce((sum, lot) => sum + lot.qty * lot.price, 0) / inventoryBase
      : 0;
  return { realizedPnlUsd, inventoryBase, inventoryCostBasis, matched };
}

function computeInventoryNotionalSeries(
  fills: PersistedFillRow[]
): Array<{ ts: number; notionalUsd: number }> {
  const series: Array<{ ts: number; notionalUsd: number }> = [];
  let base = 0;
  for (const fill of fills) {
    const qty = safePositive(fill.base_qty);
    if (!(qty > 0)) continue;
    base += fill.side === "BUY" ? qty : -qty;
    const mark = fill.revx_mid_at_fill > 0 ? fill.revx_mid_at_fill : fill.price;
    const notionalUsd = base * (mark > 0 ? mark : 0);
    series.push({ ts: fill.ts, notionalUsd });
  }
  return series;
}

function buildEquityCurve(
  fills: PersistedFillRow[],
  mids: MidSnapshotRow[],
  latestMid: number,
  windowStart: number
): EquityPoint[] {
  const points: EquityPoint[] = [];
  const buyLots: Lot[] = [];
  let realized = 0;

  for (const fill of fills.sort((a, b) => a.ts - b.ts)) {
    const qty = safePositive(fill.base_qty);
    const price = safePositive(fill.price);
    if (!(qty > 0) || !(price > 0)) continue;
    realized -= Number.isFinite(fill.fee_usd) ? fill.fee_usd : 0;
    if (fill.side === "BUY") {
      buyLots.push({ qty, price, ts: fill.ts });
    } else {
      let remaining = qty;
      while (remaining > 1e-12 && buyLots.length > 0) {
        const lot = buyLots[0];
        const matchedQty = Math.min(remaining, lot.qty);
        realized += (price - lot.price) * matchedQty;
        lot.qty -= matchedQty;
        remaining -= matchedQty;
        if (lot.qty <= 1e-12) buyLots.shift();
      }
    }
    const inventoryBase = buyLots.reduce((sum, lot) => sum + lot.qty, 0);
    const basis =
      inventoryBase > 0
        ? buyLots.reduce((sum, lot) => sum + lot.qty * lot.price, 0) / inventoryBase
        : 0;
    const midNow = lookupMidAtOrAfter(mids, fill.ts) ?? latestMid;
    const unrealized = inventoryBase > 0 && midNow > 0 ? (midNow - basis) * inventoryBase : 0;
    if (fill.ts >= windowStart) {
      points.push({
        ts: fill.ts,
        realizedPnlUsd: realized,
        unrealizedPnlUsd: unrealized,
        netPnlUsd: realized + unrealized,
        inventoryBase,
        mid: midNow > 0 ? midNow : 0
      });
    }
  }
  return points;
}

export function lookupMidAtOrAfter(
  mids: MidSnapshotRow[],
  targetTs: number
): number | null {
  if (mids.length <= 0) return null;
  let lo = 0;
  let hi = mids.length - 1;
  let answer = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (mids[mid].ts >= targetTs) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (answer >= 0) {
    const row = mids[answer];
    return row.revx_mid > 0 ? row.revx_mid : null;
  }
  const fallback = mids[mids.length - 1];
  return fallback.revx_mid > 0 ? fallback.revx_mid : null;
}

function safePositive(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value > 0 ? value : 0;
}

function isFiniteNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function mean(values: number[]): number {
  if (values.length <= 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length <= 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index];
}

