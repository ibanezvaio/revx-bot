import { computeSpreadBps } from "../math";
import { ExternalVenueSnapshot } from "../types";
import { fetchJsonWithTimeout } from "./http";

export function resolveBinanceTickerUrl(_symbol: string): string {
  return "https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT";
}

export async function fetchBinanceTicker(
  symbol: string,
  timeoutMs: number,
  options: { signal?: AbortSignal } = {}
): Promise<ExternalVenueSnapshot> {
  const started = Date.now();
  const url = resolveBinanceTickerUrl(symbol);
  try {
    const payload = (await fetchJsonWithTimeout(url, timeoutMs, {
      parentSignal: options.signal
    })) as Record<string, unknown>;
    const bid = parseNum(payload.bidPrice);
    const ask = parseNum(payload.askPrice);
    if (!(Number.isFinite(bid) && bid > 0) || !(Number.isFinite(ask) && ask > 0)) {
      throw new Error("BINANCE_MISSING_BID_ASK");
    }
    const mid = (bid + ask) / 2;
    const spreadBps =
      mid && Number.isFinite(bid) && Number.isFinite(ask)
        ? computeSpreadBps(bid, ask)
        : null;
    return {
      symbol,
      venue: "binance",
      quote: "USDT",
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
      venue: "binance",
      quote: "USDT",
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
