export type NormalizedVenueActiveOrder = {
  clientOrderId: string;
  venueOrderId: string | null;
  symbol: string;
  side: string;
  price: number;
  quoteSize: number;
  status: string;
  createdTs: number;
  updatedTs: number;
};

export type OrderReconcileDebugSnapshot = {
  ts: number;
  lastReconcileTs: number;
  lastError: string;
  reconcileLastError: string;
  venueFetchOk: boolean;
  venueActiveOrders: NormalizedVenueActiveOrder[];
  venueOpenKeys: string[];
  localCountBefore: number;
  localCountAfter: number;
  pendingPruned: number;
  dupesRemoved: number;
};

const EMPTY_SNAPSHOT: OrderReconcileDebugSnapshot = {
  ts: 0,
  lastReconcileTs: 0,
  lastError: "",
  reconcileLastError: "",
  venueFetchOk: false,
  venueActiveOrders: [],
  venueOpenKeys: [],
  localCountBefore: 0,
  localCountAfter: 0,
  pendingPruned: 0,
  dupesRemoved: 0
};

class OrderReconcileStateStore {
  private snapshot: OrderReconcileDebugSnapshot = { ...EMPTY_SNAPSHOT };

  markSuccess(input: {
    ts: number;
    venueFetchOk: boolean;
    venueActiveOrders: NormalizedVenueActiveOrder[];
    venueOpenKeys: string[];
    localCountBefore: number;
    localCountAfter: number;
    pendingPruned: number;
    dupesRemoved: number;
    error?: string;
  }): void {
    const nowTs = normalizeTs(input.ts);
    this.snapshot = {
      ts: nowTs,
      lastReconcileTs: nowTs,
      lastError: String(input.error || ""),
      reconcileLastError: String(input.error || ""),
      venueFetchOk: Boolean(input.venueFetchOk),
      venueActiveOrders: (Array.isArray(input.venueActiveOrders) ? input.venueActiveOrders : []).map((row) => ({ ...row })),
      venueOpenKeys: Array.from(new Set((Array.isArray(input.venueOpenKeys) ? input.venueOpenKeys : []).map((row) => String(row || "").trim()).filter((row) => row.length > 0))),
      localCountBefore: Math.max(0, Math.floor(Number(input.localCountBefore) || 0)),
      localCountAfter: Math.max(0, Math.floor(Number(input.localCountAfter) || 0)),
      pendingPruned: Math.max(0, Math.floor(Number(input.pendingPruned) || 0)),
      dupesRemoved: Math.max(0, Math.floor(Number(input.dupesRemoved) || 0))
    };
  }

  markError(error: unknown, ts: number): void {
    const message = error instanceof Error ? error.message : String(error || "reconcile_error");
    this.snapshot = {
      ...this.snapshot,
      ts: normalizeTs(ts),
      lastError: message,
      reconcileLastError: message,
      venueFetchOk: false
    };
  }

  markReconcileError(error: unknown, ts: number): void {
    const message = error instanceof Error ? error.message : String(error || "reconcile_error");
    this.snapshot = {
      ...this.snapshot,
      ts: normalizeTs(ts),
      lastError: message,
      reconcileLastError: message
    };
  }

  getSnapshot(): OrderReconcileDebugSnapshot {
    return {
      ...this.snapshot,
      venueActiveOrders: this.snapshot.venueActiveOrders.map((row) => ({ ...row })),
      venueOpenKeys: [...this.snapshot.venueOpenKeys]
    };
  }
}

function normalizeTs(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Date.now();
}

export const orderReconcileState = new OrderReconcileStateStore();
