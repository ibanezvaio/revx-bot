import { FillRecord, Side } from "../store/Store";

export type FillWithSide = {
  fill: FillRecord;
  side: Side | null;
};

export type PnLSnapshot = {
  realizedPnlUsd: number;
  avgEdgeBpsBuy: number;
  avgEdgeBpsSell: number;
  fillCount: number;
};

type BuyLot = { qty: number; price: number };

export class FifoPnlEstimator {
  private realizedPnlUsdValue = 0;
  private fillCountValue = 0;
  private readonly buyLots: BuyLot[] = [];
  private buyEdgeWeighted = 0;
  private buyEdgeWeight = 0;
  private sellEdgeWeighted = 0;
  private sellEdgeWeight = 0;

  apply(entry: FillWithSide): void {
    const side = entry.side;
    if (!side) return;

    const qty = sanitizePositive(entry.fill.qty);
    const price = sanitizePositive(entry.fill.price);
    if (qty <= 0 || price <= 0) return;

    const fee = Number.isFinite(entry.fill.fee) ? entry.fill.fee : 0;
    this.realizedPnlUsdValue -= fee;
    this.fillCountValue += 1;

    const edgeBps = entry.fill.edge_bps;
    if (typeof edgeBps === "number" && Number.isFinite(edgeBps)) {
      if (side === "BUY") {
        this.buyEdgeWeighted += edgeBps * qty;
        this.buyEdgeWeight += qty;
      } else {
        this.sellEdgeWeighted += edgeBps * qty;
        this.sellEdgeWeight += qty;
      }
    }

    if (side === "BUY") {
      this.buyLots.push({ qty, price });
      return;
    }

    let remaining = qty;
    while (remaining > 1e-12 && this.buyLots.length > 0) {
      const lot = this.buyLots[0];
      const matchedQty = Math.min(remaining, lot.qty);
      this.realizedPnlUsdValue += (price - lot.price) * matchedQty;
      lot.qty -= matchedQty;
      remaining -= matchedQty;
      if (lot.qty <= 1e-12) {
        this.buyLots.shift();
      }
    }
  }

  snapshot(): PnLSnapshot {
    return {
      realizedPnlUsd: this.realizedPnlUsdValue,
      avgEdgeBpsBuy: this.buyEdgeWeight > 0 ? this.buyEdgeWeighted / this.buyEdgeWeight : 0,
      avgEdgeBpsSell: this.sellEdgeWeight > 0 ? this.sellEdgeWeighted / this.sellEdgeWeight : 0,
      fillCount: this.fillCountValue
    };
  }
}

export function computePnlFromFills(entries: FillWithSide[]): PnLSnapshot {
  const estimator = new FifoPnlEstimator();
  for (const entry of entries.sort((a, b) => a.fill.ts - b.fill.ts)) {
    estimator.apply(entry);
  }
  return estimator.snapshot();
}

export function localDayStartTs(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function sanitizePositive(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value > 0 ? value : 0;
}
