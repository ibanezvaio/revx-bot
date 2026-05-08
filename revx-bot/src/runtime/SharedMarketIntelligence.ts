import { IntelEngine, IntelPosture } from "../intel/IntelEngine";
import { SignalsEngine } from "../signals/SignalsEngine";
import { SignalAggregate } from "../signals/types";
import { BotStatus, Store } from "../store/Store";

export type SharedReferencePrice = {
  price: number | null;
  ageMs: number | null;
  ts: number | null;
  source: string;
};

export type SharedVenueBias = {
  bias: "LONG" | "SHORT" | "NEUTRAL" | null;
  confidence: number;
  ts: number | null;
  source: string;
};

export type SharedDirectionalInputs = {
  aggregate: SignalAggregate | null;
  intelPosture: IntelPosture | null;
  venueBias: SharedVenueBias;
};

type SharedMarketIntelligenceDeps = {
  store?: Store;
  signalsEngine?: SignalsEngine;
  intelEngine?: IntelEngine;
};

export class SharedMarketIntelligence {
  private latestVenueBias: SharedVenueBias = {
    bias: null,
    confidence: 0,
    ts: null,
    source: "NONE"
  };

  constructor(private readonly deps: SharedMarketIntelligenceDeps = {}) {}

  getReferencePrice(symbol: string, nowMs: number): SharedReferencePrice {
    if (!this.deps.store) {
      return { price: null, ageMs: null, ts: null, source: "NONE" };
    }
    let venueReference: SharedReferencePrice | null = null;
    const quotes = this.deps.store
      .getLatestVenueQuotes(symbol)
      .filter((row) => Number.isFinite(row.mid) && row.mid !== null && Number(row.mid) > 0);
    if (quotes.length > 0) {
      const latestTs = Math.max(...quotes.map((row) => Number(row.ts || 0)));
      const mids = quotes
        .filter((row) => Number(row.ts || 0) >= latestTs - 5_000)
        .map((row) => Number(row.mid))
        .filter((row) => Number.isFinite(row) && row > 0)
        .sort((a, b) => a - b);
      const mid = mids.length > 0 ? mids[Math.floor(mids.length / 2)] : null;
      const sourceVenues = quotes
        .filter((row) => Number(row.ts || 0) >= latestTs - 5_000)
        .map((row) => String(row.venue || "").trim())
        .filter((row) => row.length > 0)
        .sort()
        .join(",");
      venueReference = {
        price: mid,
        ageMs: latestTs > 0 ? Math.max(0, nowMs - latestTs) : null,
        ts: latestTs > 0 ? latestTs : null,
        source: sourceVenues ? `EXTERNAL_VENUES:${sourceVenues}` : "EXTERNAL_VENUES"
      };
    }

    const latestTicker = this.deps.store.getRecentTickerSnapshots(symbol, 1)[0] ?? null;
    const tickerMid = latestTicker && Number.isFinite(latestTicker.mid) && latestTicker.mid > 0 ? latestTicker.mid : null;
    const tickerTs = latestTicker && Number.isFinite(latestTicker.ts) && latestTicker.ts > 0 ? latestTicker.ts : null;
    let tickerReference: SharedReferencePrice | null = null;
    if (tickerMid !== null && tickerTs !== null) {
      tickerReference = {
        price: tickerMid,
        ageMs: Math.max(0, nowMs - tickerTs),
        ts: tickerTs,
        source: "TICKER_SNAPSHOT"
      };
    }

    if (venueReference && tickerReference) {
      return (venueReference.ts ?? 0) >= (tickerReference.ts ?? 0) ? venueReference : tickerReference;
    }
    if (venueReference) {
      return venueReference;
    }
    if (tickerReference) {
      return tickerReference;
    }

    return {
      price: null,
      ageMs: null,
      ts: null,
      source: "NONE"
    };
  }

  getDirectionalInputs(nowMs: number): SharedDirectionalInputs {
    const aggregate = this.deps.signalsEngine?.getLatestAggregate() ?? null;
    const intelPosture = this.deps.intelEngine?.getPosture(nowMs) ?? null;
    return {
      aggregate,
      intelPosture,
      venueBias: this.latestVenueBias
    };
  }

  publishVenueBias(snapshot: SharedVenueBias | null): void {
    this.latestVenueBias = snapshot ?? {
      bias: null,
      confidence: 0,
      ts: null,
      source: "NONE"
    };
  }
}

export function deriveSharedVenueBias(status: BotStatus | null): SharedVenueBias {
  const quotingBias =
    status?.quoting?.bias === "LONG" || status?.quoting?.bias === "SHORT" || status?.quoting?.bias === "NEUTRAL"
      ? status.quoting.bias
      : null;
  const topLevelBias =
    status?.signal_bias === "LONG" || status?.signal_bias === "SHORT" || status?.signal_bias === "NEUTRAL"
      ? status.signal_bias
      : null;
  const bias = quotingBias ?? topLevelBias ?? null;
  const confidence =
    Number.isFinite(Number(status?.quoting?.biasConfidence))
      ? Math.max(0, Math.min(1, Number(status?.quoting?.biasConfidence)))
      : Number.isFinite(Number(status?.signal_bias_confidence))
        ? Math.max(0, Math.min(1, Number(status?.signal_bias_confidence)))
        : 0;
  return {
    bias,
    confidence,
    ts: Number.isFinite(Number(status?.ts)) && Number(status?.ts) > 0 ? Number(status?.ts) : null,
    source: bias ? "REVX_SHARED_BIAS_SNAPSHOT" : "NONE"
  };
}
