import { Side } from "../store/Store";

export type BalanceView = {
  ts: number;
  freeUsd: number;
  totalUsd: number;
  freeBtc: number;
  totalBtc: number;
  reservedUsd: number;
  reservedBtc: number;
  spendableUsd: number;
  spendableBtc: number;
};

export type BalanceClampReason =
  | "INSUFFICIENT_BTC_CLAMPED"
  | "INSUFFICIENT_BTC_SKIPPED"
  | "INSUFFICIENT_USD_CLAMPED"
  | "INSUFFICIENT_USD_SKIPPED"
  | "BELOW_MIN_NOTIONAL_AFTER_CLAMP";

export type BalanceClampEvent = {
  ts: number;
  side: Side;
  tag: string;
  reason: BalanceClampReason;
  beforeQuoteUsd: number;
  afterQuoteUsd: number;
  beforeBaseQtyBtc: number;
  afterBaseQtyBtc: number;
  freeUsd: number;
  freeBtc: number;
  spendableUsd: number;
  spendableBtc: number;
  details: string;
};

export type BalanceManagedQuote<TTag = string, TLevel = number | string> = {
  tag: TTag;
  side: Side;
  level: TLevel;
  price: number;
  quoteSizeUsd: number;
};

export type BalancePreflightResult<T extends BalanceManagedQuote> = {
  desired: T[];
  events: BalanceClampEvent[];
  perSideBlockReasons: {
    BUY: string[];
    SELL: string[];
  };
};

const DEFAULT_RESERVE_BTC = 0;
const DEFAULT_DUST_BTC = 0.00000001;
const DEFAULT_DUST_USD = 0.01;
const MAX_EVENT_HISTORY = 20;

export class BalanceManager {
  private view: BalanceView = {
    ts: 0,
    freeUsd: 0,
    totalUsd: 0,
    freeBtc: 0,
    totalBtc: 0,
    reservedUsd: 0,
    reservedBtc: 0,
    spendableUsd: 0,
    spendableBtc: 0
  };
  private refreshIntervalMs = 5_000;
  private lastRefreshRequestTs = 0;
  private forceRefreshReason = "";
  private clampEvents: BalanceClampEvent[] = [];
  private clampCounters: Record<string, number> = {};

  setRefreshIntervalMs(valueMs: number): void {
    const parsed = Number(valueMs);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    this.refreshIntervalMs = Math.max(1_000, Math.floor(parsed));
  }

  update(params: {
    ts: number;
    freeUsd: number;
    totalUsd: number;
    freeBtc: number;
    totalBtc: number;
    reservedUsd: number;
    reservedBtc?: number;
  }): BalanceView {
    const reservedBtc = Number.isFinite(Number(params.reservedBtc))
      ? Math.max(0, Number(params.reservedBtc))
      : DEFAULT_RESERVE_BTC;
    this.view = {
      ts: normalizeNumber(params.ts, Date.now()),
      freeUsd: Math.max(0, normalizeNumber(params.freeUsd, 0)),
      totalUsd: Math.max(0, normalizeNumber(params.totalUsd, 0)),
      freeBtc: Math.max(0, normalizeNumber(params.freeBtc, 0)),
      totalBtc: Math.max(0, normalizeNumber(params.totalBtc, 0)),
      reservedUsd: Math.max(0, normalizeNumber(params.reservedUsd, 0)),
      reservedBtc,
      spendableUsd: Math.max(0, normalizeNumber(params.freeUsd, 0) - Math.max(0, normalizeNumber(params.reservedUsd, 0))),
      spendableBtc: Math.max(0, normalizeNumber(params.freeBtc, 0) - reservedBtc)
    };
    return this.getView();
  }

  getSpendableUsd(reserveUsd: number): number {
    return Math.max(0, this.view.freeUsd - Math.max(0, normalizeNumber(reserveUsd, this.view.reservedUsd)));
  }

  getSpendableBtc(reserveBtc = DEFAULT_RESERVE_BTC): number {
    return Math.max(0, this.view.freeBtc - Math.max(0, normalizeNumber(reserveBtc, this.view.reservedBtc)));
  }

  getView(): BalanceView {
    return {
      ...this.view
    };
  }

  requestRefresh(reason: string): void {
    this.lastRefreshRequestTs = Date.now();
    this.forceRefreshReason = String(reason || "manual");
  }

  consumeRefreshReason(): string {
    const reason = this.forceRefreshReason;
    this.forceRefreshReason = "";
    return reason;
  }

  shouldRefresh(nowTs: number): boolean {
    const now = normalizeNumber(nowTs, Date.now());
    if (this.lastRefreshRequestTs > 0 && now - this.lastRefreshRequestTs <= Math.max(5_000, this.refreshIntervalMs * 2)) {
      return true;
    }
    if (this.view.ts <= 0) return true;
    return now - this.view.ts >= this.refreshIntervalMs;
  }

  preflightQuotes<T extends BalanceManagedQuote>(params: {
    desired: T[];
    minNotionalUsd: number;
    reserveUsd: number;
    reserveBtc?: number;
    btcDustBuffer?: number;
    usdDustBuffer?: number;
    ts?: number;
  }): BalancePreflightResult<T> {
    const ts = normalizeNumber(params.ts, Date.now());
    const minNotionalUsd = Math.max(0.01, normalizeNumber(params.minNotionalUsd, 0.01));
    const reserveUsd = Math.max(0, normalizeNumber(params.reserveUsd, 0));
    const reserveBtc = Math.max(0, normalizeNumber(params.reserveBtc, this.view.reservedBtc));
    const btcDustBuffer = Math.max(0, normalizeNumber(params.btcDustBuffer, DEFAULT_DUST_BTC));
    const usdDustBuffer = Math.max(0, normalizeNumber(params.usdDustBuffer, DEFAULT_DUST_USD));

    let remainingUsd = this.getSpendableUsd(reserveUsd);
    let remainingBtc = this.getSpendableBtc(reserveBtc);

    const desired: T[] = [];
    const events: BalanceClampEvent[] = [];
    const perSideBlockReasons = {
      BUY: [] as string[],
      SELL: [] as string[]
    };

    for (const row of params.desired) {
      const side = row.side;
      const price = normalizeNumber(row.price, 0);
      const quoteSizeBefore = Math.max(0, normalizeNumber(row.quoteSizeUsd, 0));
      const baseQtyBefore = quoteSizeBefore > 0 && price > 0 ? quoteSizeBefore / price : 0;
      const tag = String(row.tag ?? "-");

      if (!(quoteSizeBefore > 0) || !(price > 0)) {
        const event = this.pushEvent({
          ts,
          side,
          tag,
          reason: side === "BUY" ? "INSUFFICIENT_USD_SKIPPED" : "INSUFFICIENT_BTC_SKIPPED",
          beforeQuoteUsd: quoteSizeBefore,
          afterQuoteUsd: 0,
          beforeBaseQtyBtc: baseQtyBefore,
          afterBaseQtyBtc: 0,
          details: "invalid_price_or_size"
        });
        events.push(event);
        perSideBlockReasons[side].push(event.reason + " (invalid_price_or_size)");
        continue;
      }

      if (side === "BUY") {
        const allowedUsd = Math.max(0, remainingUsd - usdDustBuffer);
        if (allowedUsd <= 0) {
          const event = this.pushEvent({
            ts,
            side,
            tag,
            reason: "INSUFFICIENT_USD_SKIPPED",
            beforeQuoteUsd: quoteSizeBefore,
            afterQuoteUsd: 0,
            beforeBaseQtyBtc: baseQtyBefore,
            afterBaseQtyBtc: 0,
            details: `spendableUsd=${remainingUsd.toFixed(2)} reserveUsd=${reserveUsd.toFixed(2)}`
          });
          events.push(event);
          perSideBlockReasons.BUY.push(`${event.reason} (${event.details})`);
          continue;
        }
        const quoteSizeAfter = Math.min(quoteSizeBefore, allowedUsd);
        if (quoteSizeAfter + 1e-9 < minNotionalUsd) {
          const event = this.pushEvent({
            ts,
            side,
            tag,
            reason: "BELOW_MIN_NOTIONAL_AFTER_CLAMP",
            beforeQuoteUsd: quoteSizeBefore,
            afterQuoteUsd: quoteSizeAfter,
            beforeBaseQtyBtc: baseQtyBefore,
            afterBaseQtyBtc: quoteSizeAfter / price,
            details: `minNotional=${minNotionalUsd.toFixed(2)} spendableUsd=${remainingUsd.toFixed(2)}`
          });
          events.push(event);
          perSideBlockReasons.BUY.push(`${event.reason} (${event.details})`);
          continue;
        }
        const clamped = quoteSizeAfter + 1e-9 < quoteSizeBefore;
        const quoteRounded = round2(quoteSizeAfter);
        desired.push({
          ...row,
          quoteSizeUsd: quoteRounded
        });
        remainingUsd = Math.max(0, remainingUsd - quoteRounded);
        if (clamped) {
          const event = this.pushEvent({
            ts,
            side,
            tag,
            reason: "INSUFFICIENT_USD_CLAMPED",
            beforeQuoteUsd: quoteSizeBefore,
            afterQuoteUsd: quoteRounded,
            beforeBaseQtyBtc: baseQtyBefore,
            afterBaseQtyBtc: quoteRounded / price,
            details: `spendableUsd=${(remainingUsd + quoteRounded).toFixed(2)} reserveUsd=${reserveUsd.toFixed(2)}`
          });
          events.push(event);
          perSideBlockReasons.BUY.push(`${event.reason} (${event.details})`);
        }
        continue;
      }

      const requiredBaseBtc = quoteSizeBefore / price;
      const allowedBaseBtc = Math.max(0, remainingBtc - btcDustBuffer);
      if (allowedBaseBtc <= 0) {
        const event = this.pushEvent({
          ts,
          side,
          tag,
          reason: "INSUFFICIENT_BTC_SKIPPED",
          beforeQuoteUsd: quoteSizeBefore,
          afterQuoteUsd: 0,
          beforeBaseQtyBtc: requiredBaseBtc,
          afterBaseQtyBtc: 0,
          details: `spendableBtc=${remainingBtc.toFixed(8)} reserveBtc=${reserveBtc.toFixed(8)}`
        });
        events.push(event);
        perSideBlockReasons.SELL.push(`${event.reason} (${event.details})`);
        continue;
      }
      const baseAfter = Math.min(requiredBaseBtc, allowedBaseBtc);
      const quoteAfter = round2(baseAfter * price);
      if (quoteAfter + 1e-9 < minNotionalUsd) {
        const event = this.pushEvent({
          ts,
          side,
          tag,
          reason: "BELOW_MIN_NOTIONAL_AFTER_CLAMP",
          beforeQuoteUsd: quoteSizeBefore,
          afterQuoteUsd: quoteAfter,
          beforeBaseQtyBtc: requiredBaseBtc,
          afterBaseQtyBtc: baseAfter,
          details: `minNotional=${minNotionalUsd.toFixed(2)} spendableBtc=${remainingBtc.toFixed(8)}`
        });
        events.push(event);
        perSideBlockReasons.SELL.push(`${event.reason} (${event.details})`);
        continue;
      }
      const clamped = baseAfter + 1e-12 < requiredBaseBtc;
      desired.push({
        ...row,
        quoteSizeUsd: quoteAfter
      });
      remainingBtc = Math.max(0, remainingBtc - baseAfter);
      if (clamped) {
        const event = this.pushEvent({
          ts,
          side,
          tag,
          reason: "INSUFFICIENT_BTC_CLAMPED",
          beforeQuoteUsd: quoteSizeBefore,
          afterQuoteUsd: quoteAfter,
          beforeBaseQtyBtc: requiredBaseBtc,
          afterBaseQtyBtc: baseAfter,
          details: `spendableBtc=${(remainingBtc + baseAfter).toFixed(8)} reserveBtc=${reserveBtc.toFixed(8)}`
        });
        events.push(event);
        perSideBlockReasons.SELL.push(`${event.reason} (${event.details})`);
      }
    }

    return {
      desired,
      events,
      perSideBlockReasons: {
        BUY: dedupe(perSideBlockReasons.BUY),
        SELL: dedupe(perSideBlockReasons.SELL)
      }
    };
  }

  getClampSnapshot(): {
    lastClampEvents: BalanceClampEvent[];
    clampCounters: Record<string, number>;
  } {
    return {
      lastClampEvents: this.clampEvents.map((row) => ({ ...row })),
      clampCounters: { ...this.clampCounters }
    };
  }

  private pushEvent(input: {
    ts: number;
    side: Side;
    tag: string;
    reason: BalanceClampReason;
    beforeQuoteUsd: number;
    afterQuoteUsd: number;
    beforeBaseQtyBtc: number;
    afterBaseQtyBtc: number;
    details: string;
  }): BalanceClampEvent {
    const event: BalanceClampEvent = {
      ts: Math.max(0, Math.floor(normalizeNumber(input.ts, Date.now()))),
      side: input.side,
      tag: String(input.tag || "-"),
      reason: input.reason,
      beforeQuoteUsd: Math.max(0, normalizeNumber(input.beforeQuoteUsd, 0)),
      afterQuoteUsd: Math.max(0, normalizeNumber(input.afterQuoteUsd, 0)),
      beforeBaseQtyBtc: Math.max(0, normalizeNumber(input.beforeBaseQtyBtc, 0)),
      afterBaseQtyBtc: Math.max(0, normalizeNumber(input.afterBaseQtyBtc, 0)),
      freeUsd: this.view.freeUsd,
      freeBtc: this.view.freeBtc,
      spendableUsd: this.view.spendableUsd,
      spendableBtc: this.view.spendableBtc,
      details: String(input.details || "")
    };
    this.clampEvents.push(event);
    if (this.clampEvents.length > MAX_EVENT_HISTORY) {
      this.clampEvents.splice(0, this.clampEvents.length - MAX_EVENT_HISTORY);
    }
    this.clampCounters[event.reason] = (this.clampCounters[event.reason] ?? 0) + 1;
    return event;
  }
}

function dedupe(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of input) {
    const value = String(row || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round2(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}
