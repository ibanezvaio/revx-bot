import { Logger } from "../logger";
import { RevXClient } from "../revx/RevXClient";

export type MarketTicker = {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  tickSize: number;
  ts: number;
};

export class MarketData {
  private readonly tickerCache = new Map<string, MarketTicker>();

  constructor(private readonly client: RevXClient, private readonly logger: Logger) {}

  async getTicker(symbol: string): Promise<MarketTicker> {
    const allTickers = await this.client.getAllTickers();
    const normalizedTarget = normalizeSymbol(symbol);

    const ticker = allTickers.find((row) => {
      if (!row || typeof row !== "object") return false;
      const obj = row as Record<string, unknown>;
      const rowSymbol = coerceString(obj.symbol ?? obj.pair ?? obj.instrument ?? obj.market);
      return normalizeSymbol(rowSymbol) === normalizedTarget;
    });

    if (!ticker || typeof ticker !== "object") {
      throw new Error(`Ticker not found for symbol ${symbol}`);
    }

    const obj = ticker as Record<string, unknown>;
    const bid = coerceNumber(obj.best_bid ?? obj.bid ?? obj.bid_price ?? obj.b);
    const ask = coerceNumber(obj.best_ask ?? obj.ask ?? obj.ask_price ?? obj.a);
    const midFromApi = coerceNumber(obj.mid_price ?? obj.mid ?? obj.m);
    const last = coerceNumber(obj.last_price ?? obj.last ?? obj.lp, midFromApi);
    const tickSize = coerceTickSize(
      obj.tick_size ??
        obj.price_increment ??
        obj.min_price_increment ??
        obj.quote_increment ??
        obj.price_tick
    );

    if (bid <= 0 || ask <= 0) {
      throw new Error(`Invalid ticker for ${symbol}: bid=${bid}, ask=${ask}`);
    }

    const mid = midFromApi > 0 ? midFromApi : (bid + ask) / 2;
    const ts = coerceTimestamp(
      obj.timestamp ?? obj.ts ?? obj.updated_at ?? obj.updatedAt ?? obj.time,
      Date.now()
    );

    const marketTicker: MarketTicker = {
      symbol: normalizedTarget,
      bid,
      ask,
      mid,
      last,
      tickSize,
      ts
    };

    this.tickerCache.set(normalizedTarget, marketTicker);
    this.logger.debug({ marketTicker }, "Market ticker");
    return marketTicker;
  }

  getCachedTicker(symbol: string): MarketTicker | null {
    return this.tickerCache.get(normalizeSymbol(symbol)) ?? null;
  }

  getCachedMid(symbol: string): number | null {
    const ticker = this.getCachedTicker(symbol);
    if (!ticker || ticker.mid <= 0) return null;
    return ticker.mid;
  }
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace("/", "-");
}

function coerceString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function coerceNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function coerceTickSize(value: unknown): number {
  const parsed = coerceNumber(value, 0);
  if (parsed > 0) return parsed;
  return 0.01;
}

function coerceTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n > 10_000_000_000 ? n : n * 1000;
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}
