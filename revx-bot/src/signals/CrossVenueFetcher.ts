import { BotConfig } from "../config";
import { fetchBinanceTicker } from "../signal/venues/binance";
import { fetchCoinbaseTicker } from "../signal/venues/coinbase";
import { fetchKrakenTicker } from "../signal/venues/kraken";
import { QuoteVenue } from "./types";

type FetchVenue = "coinbase" | "kraken" | "binance";

const DEFAULT_VENUES: FetchVenue[] = ["coinbase", "kraken", "binance"];

export class CrossVenueFetcher {
  constructor(private readonly config: BotConfig) {}

  async fetch(symbol: string, nowTs = Date.now()): Promise<QuoteVenue[]> {
    const venues = this.resolveVenues();
    const settled = await Promise.allSettled(venues.map((venue) => this.fetchOne(venue, symbol, nowTs)));
    const rows = settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const venue = venues[index];
      return {
        venue,
        symbol,
        quote: venue === "binance" ? "USDT" : "USD",
        ts: nowTs,
        bid: null,
        ask: null,
        mid: null,
        spread_bps: null,
        latency_ms: 0,
        ok: false,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
      } satisfies QuoteVenue;
    });
    return rows.sort((a, b) => a.venue.localeCompare(b.venue));
  }

  private resolveVenues(): FetchVenue[] {
    const raw = Array.isArray(this.config.signalVenues) ? this.config.signalVenues : [];
    const parsed = raw
      .map((v) => String(v || "").trim().toLowerCase())
      .filter((v): v is FetchVenue => v === "coinbase" || v === "kraken" || v === "binance");
    if (parsed.length === 0) return DEFAULT_VENUES;
    return Array.from(new Set(parsed));
  }

  private async fetchOne(venue: FetchVenue, symbol: string, nowTs: number): Promise<QuoteVenue> {
    const timeoutMs = Math.max(8_000, this.config.venueTimeoutMs);
    let attempt = 0;
    let lastError = "";

    while (attempt <= 1) {
      try {
        const raw =
          venue === "coinbase"
            ? await fetchCoinbaseTicker(symbol, timeoutMs)
            : venue === "kraken"
              ? await fetchKrakenTicker(symbol, timeoutMs)
              : await fetchBinanceTicker(symbol, timeoutMs);
        return {
          venue: raw.venue,
          symbol,
          quote: raw.quote,
          ts: Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : nowTs,
          bid: asNumOrNull(raw.bid),
          ask: asNumOrNull(raw.ask),
          mid: asNumOrNull(raw.mid),
          spread_bps: asNumOrNull(raw.spread_bps),
          latency_ms: Math.max(0, Math.floor(Number(raw.latency_ms) || 0)),
          ok: Boolean(raw.ok),
          error: raw.error ? String(raw.error) : ""
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      attempt += 1;
    }

    return {
      venue,
      symbol,
      quote: venue === "binance" ? "USDT" : "USD",
      ts: nowTs,
      bid: null,
      ask: null,
      mid: null,
      spread_bps: null,
      latency_ms: timeoutMs,
      ok: false,
      error: lastError || "fetch failed"
    };
  }
}

function asNumOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
