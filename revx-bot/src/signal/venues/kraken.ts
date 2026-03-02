import { computeSpreadBps } from "../math";
import { ExternalVenueSnapshot } from "../types";
import { fetchJsonWithTimeout } from "./http";

export async function fetchKrakenTicker(
  symbol: string,
  timeoutMs: number
): Promise<ExternalVenueSnapshot> {
  const started = Date.now();
  const url = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD";
  try {
    const payload = (await fetchJsonWithTimeout(url, timeoutMs)) as Record<string, unknown>;
    const result = payload.result as Record<string, unknown> | undefined;
    const first = result ? Object.values(result)[0] : undefined;
    const ticker = (first ?? {}) as Record<string, unknown>;
    const ask = parseNumFromArray(ticker.a);
    const bid = parseNumFromArray(ticker.b);
    const last = parseNumFromArray(ticker.c);
    const mid =
      Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
        ? (bid + ask) / 2
        : Number.isFinite(last) && last > 0
          ? last
          : null;
    const spreadBps =
      mid && Number.isFinite(bid) && Number.isFinite(ask)
        ? computeSpreadBps(bid, ask)
        : null;
    return {
      symbol,
      venue: "kraken",
      quote: "USD",
      ts: Date.now(),
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      mid: mid && Number.isFinite(mid) ? mid : null,
      spread_bps: spreadBps,
      latency_ms: Date.now() - started,
      ok: mid !== null
    };
  } catch (error) {
    return {
      symbol,
      venue: "kraken",
      quote: "USD",
      ts: Date.now(),
      bid: null,
      ask: null,
      mid: null,
      spread_bps: null,
      latency_ms: Date.now() - started,
      ok: false,
      error: (error as Error).message
    };
  }
}

function parseNumFromArray(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0) return Number.NaN;
  const n = Number(value[0]);
  return Number.isFinite(n) ? n : Number.NaN;
}

