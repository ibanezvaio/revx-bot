import { computeSpreadBps } from "../math";
import { ExternalVenueSnapshot } from "../types";
import { fetchJsonWithNativeHttps } from "./nativeHttps";

export function resolveKrakenTickerUrl(_symbol: string): string {
  return "https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=1";
}

export async function fetchKrakenTicker(
  symbol: string,
  timeoutMs: number,
  options: { signal?: AbortSignal } = {}
): Promise<ExternalVenueSnapshot> {
  const started = Date.now();
  const url = resolveKrakenTickerUrl(symbol);
  try {
    const payload = (await fetchJsonWithNativeHttps(url, timeoutMs, {
      parentSignal: options.signal
    })) as Record<string, unknown>;
    const result = payload.result as Record<string, unknown> | undefined;
    const first = result ? Object.values(result)[0] : undefined;
    const ticker = (first ?? {}) as Record<string, unknown>;
    const ask = parseNumFromDepthArray(ticker.asks);
    const bid = parseNumFromDepthArray(ticker.bids);
    if (!(Number.isFinite(bid) && bid > 0) || !(Number.isFinite(ask) && ask > 0)) {
      throw new Error("KRAKEN_MISSING_BID_ASK");
    }
    const mid = (bid + ask) / 2;
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

function parseNumFromDepthArray(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0 || !Array.isArray(value[0])) return Number.NaN;
  const n = Number(value[0][0]);
  return Number.isFinite(n) ? n : Number.NaN;
}
