import { computeSpreadBps } from "../math";
import { ExternalVenueSnapshot } from "../types";
import { fetchJsonWithNativeHttps } from "./nativeHttps";

export function resolveCoinbaseTickerUrl(_symbol: string): string {
  return "https://api.exchange.coinbase.com/products/BTC-USD/book?level=1";
}

export async function fetchCoinbaseTicker(
  symbol: string,
  timeoutMs: number,
  options: { signal?: AbortSignal } = {}
): Promise<ExternalVenueSnapshot> {
  const started = Date.now();
  const url = resolveCoinbaseTickerUrl(symbol);
  try {
    const payload = (await fetchJsonWithNativeHttps(url, timeoutMs, {
      parentSignal: options.signal
    })) as Record<string, unknown>;
    const bids = asTupleArray(payload.bids);
    const asks = asTupleArray(payload.asks);
    const bid = parseNum(bids[0]?.[0]);
    const ask = parseNum(asks[0]?.[0]);
    if (!(Number.isFinite(bid) && bid > 0) || !(Number.isFinite(ask) && ask > 0)) {
      throw new Error("COINBASE_MISSING_BID_ASK");
    }
    const mid = (bid + ask) / 2;
    const spreadBps =
      mid && Number.isFinite(bid) && Number.isFinite(ask)
        ? computeSpreadBps(bid, ask)
        : null;
    const remoteTs = parseTimeMs(payload.time) ?? parseTimeMs(payload.timestamp);
    return {
      symbol,
      venue: "coinbase",
      quote: "USD",
      ts: remoteTs ?? Date.now(),
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
      venue: "coinbase",
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

function parseNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

function asTupleArray(value: unknown): Array<[string | number, string | number]> {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is [string | number, string | number] => {
    return Array.isArray(row) && row.length >= 2;
  });
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}
