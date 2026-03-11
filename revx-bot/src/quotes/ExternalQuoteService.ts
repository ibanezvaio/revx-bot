import { BotConfig } from "../config";
import { Logger } from "../logger";
import { initNetworkTransport } from "../http/networkTransport";

export type VenueQuote = {
  venue: string;
  ts: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  error?: string | null;
};

type SupportedVenue = "coinbase" | "kraken";

const REQUEST_TIMEOUT_MS = 5_000;

export class ExternalQuoteService {
  private readonly venues: string[];
  private readonly refreshMs: number;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly latest = new Map<string, VenueQuote>();

  constructor(private readonly config: BotConfig, private readonly logger: Logger) {
    this.venues = config.externalVenues;
    this.refreshMs = Math.max(1_000, Math.round(config.externalQuotesRefreshSeconds * 1000));
  }

  start(): void {
    if (this.timer || this.venues.length === 0) return;
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.refreshMs);
    this.logger.info(
      { venues: this.venues, refreshMs: this.refreshMs },
      "External quote service started"
    );
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getLatest(): Record<string, VenueQuote> {
    const result: Record<string, VenueQuote> = {};
    for (const [venue, quote] of this.latest.entries()) {
      result[venue] = { ...quote };
    }
    return result;
  }

  private async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.allSettled(this.venues.map((venue) => this.fetchVenue(venue)));
    } finally {
      this.polling = false;
    }
  }

  private async fetchVenue(venue: string): Promise<void> {
    const normalizedVenue = venue.trim().toLowerCase();
    const previous = this.latest.get(normalizedVenue) ?? null;
    const now = Date.now();

    try {
      let next: VenueQuote;
      if (normalizedVenue === "coinbase") {
        next = await this.fetchCoinbaseQuote();
      } else if (normalizedVenue === "kraken") {
        next = await this.fetchKrakenQuote();
      } else {
        next = {
          venue: normalizedVenue,
          ts: previous?.ts ?? 0,
          bid: previous?.bid ?? null,
          ask: previous?.ask ?? null,
          mid: previous?.mid ?? null,
          error: `unsupported venue: ${normalizedVenue}`
        };
      }
      this.latest.set(normalizedVenue, next);
    } catch (error) {
      this.latest.set(normalizedVenue, {
        venue: normalizedVenue,
        ts: previous?.ts ?? 0,
        bid: previous?.bid ?? null,
        ask: previous?.ask ?? null,
        mid: previous?.mid ?? null,
        error: (error as Error).message
      });
      this.logger.debug(
        { venue: normalizedVenue, error: (error as Error).message, at: now },
        "External quote fetch failed"
      );
    }
  }

  private async fetchCoinbaseQuote(): Promise<VenueQuote> {
    const product = mapCoinbaseProduct(this.config.symbol);
    const payload = (await fetchJsonWithTimeout(
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/ticker`,
      REQUEST_TIMEOUT_MS
    )) as Record<string, unknown>;
    const bid = parseNumber(payload.bid);
    const ask = parseNumber(payload.ask);
    return toQuote("coinbase", Date.now(), bid, ask, null);
  }

  private async fetchKrakenQuote(): Promise<VenueQuote> {
    const pair = mapKrakenPair(this.config.symbol);
    const payload = (await fetchJsonWithTimeout(
      `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`,
      REQUEST_TIMEOUT_MS
    )) as Record<string, unknown>;
    const result = payload.result as Record<string, unknown> | undefined;
    const first = result ? Object.values(result)[0] : undefined;
    if (!first || typeof first !== "object") {
      throw new Error("kraken payload missing result");
    }
    const row = first as Record<string, unknown>;
    const bid = parseFirstArrayNumber(row.b);
    const ask = parseFirstArrayNumber(row.a);
    return toQuote("kraken", Date.now(), bid, ask, null);
  }
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  initNetworkTransport();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return text.length > 0 ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function toQuote(
  venue: SupportedVenue | string,
  ts: number,
  bid: number,
  ask: number,
  error: string | null
): VenueQuote {
  const hasBid = Number.isFinite(bid) && bid > 0;
  const hasAsk = Number.isFinite(ask) && ask > 0;
  const mid = hasBid && hasAsk ? (bid + ask) / 2 : null;
  return {
    venue,
    ts,
    bid: hasBid ? bid : null,
    ask: hasAsk ? ask : null,
    mid,
    error
  };
}

function parseNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseFirstArrayNumber(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0) return Number.NaN;
  return parseNumber(value[0]);
}

function mapCoinbaseProduct(symbol: string): string {
  const normalized = symbol.trim().toUpperCase().replace("/", "-");
  return normalized;
}

function mapKrakenPair(symbol: string): string {
  const normalized = symbol.trim().toUpperCase().replace("/", "-");
  const [baseRaw, quoteRaw] = normalized.split("-");
  const base = baseRaw === "BTC" ? "XBT" : baseRaw;
  const quote = quoteRaw ?? "USD";
  return `${base}${quote}`;
}
