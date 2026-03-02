export type SeedDebugSnapshot = {
  seedMode: "SEED_BUY" | "ACCUMULATE_BTC" | "TWO_SIDED" | "REBALANCE";
  seedStartTs: number;
  seedReposts: number;
  seedTakerFired: boolean;
  lastSeedOrderIds: {
    clientOrderId: string | null;
    venueOrderId: string | null;
  };
  btcNotionalUsd: number;
  lowGateUsd: number;
  targetUsd: number;
  blockedReasons: string[];
  lastUpdatedTs: number;
};

class SeedDebugState {
  private snapshot: SeedDebugSnapshot = {
    seedMode: "TWO_SIDED",
    seedStartTs: 0,
    seedReposts: 0,
    seedTakerFired: false,
    lastSeedOrderIds: {
      clientOrderId: null,
      venueOrderId: null
    },
    btcNotionalUsd: 0,
    lowGateUsd: 0,
    targetUsd: 0,
    blockedReasons: [],
    lastUpdatedTs: 0
  };

  update(next: Partial<SeedDebugSnapshot>): void {
    const ts = Number.isFinite(Number(next.lastUpdatedTs))
      ? Math.max(0, Number(next.lastUpdatedTs))
      : Date.now();
    this.snapshot = {
      ...this.snapshot,
      ...sanitize(next),
      lastUpdatedTs: ts
    };
  }

  getSnapshot(): SeedDebugSnapshot {
    return {
      ...this.snapshot,
      lastSeedOrderIds: {
        clientOrderId: this.snapshot.lastSeedOrderIds.clientOrderId,
        venueOrderId: this.snapshot.lastSeedOrderIds.venueOrderId
      },
      blockedReasons: [...this.snapshot.blockedReasons]
    };
  }
}

export const seedDebugState = new SeedDebugState();

function sanitize(next: Partial<SeedDebugSnapshot>): Partial<SeedDebugSnapshot> {
  const out: Partial<SeedDebugSnapshot> = {};
  if (
    next.seedMode === "SEED_BUY" ||
    next.seedMode === "ACCUMULATE_BTC" ||
    next.seedMode === "TWO_SIDED" ||
    next.seedMode === "REBALANCE"
  ) {
    out.seedMode = next.seedMode;
  }
  if (Number.isFinite(Number(next.seedStartTs))) out.seedStartTs = Math.max(0, Number(next.seedStartTs));
  if (Number.isFinite(Number(next.seedReposts))) out.seedReposts = Math.max(0, Math.floor(Number(next.seedReposts)));
  if (typeof next.seedTakerFired === "boolean") out.seedTakerFired = next.seedTakerFired;
  if (next.lastSeedOrderIds && typeof next.lastSeedOrderIds === "object") {
    out.lastSeedOrderIds = {
      clientOrderId:
        typeof next.lastSeedOrderIds.clientOrderId === "string"
          ? next.lastSeedOrderIds.clientOrderId
          : null,
      venueOrderId:
        typeof next.lastSeedOrderIds.venueOrderId === "string"
          ? next.lastSeedOrderIds.venueOrderId
          : null
    };
  }
  if (Number.isFinite(Number(next.btcNotionalUsd))) out.btcNotionalUsd = Number(next.btcNotionalUsd);
  if (Number.isFinite(Number(next.lowGateUsd))) out.lowGateUsd = Number(next.lowGateUsd);
  if (Number.isFinite(Number(next.targetUsd))) out.targetUsd = Number(next.targetUsd);
  if (Array.isArray(next.blockedReasons)) {
    out.blockedReasons = next.blockedReasons.map((r) => String(r)).filter((r) => r.trim().length > 0);
  }
  return out;
}
