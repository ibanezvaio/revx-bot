import { computeSpreadBps } from "../math";
import { ExternalVenueSnapshot } from "../types";
import { fetchJsonWithTimeout } from "./http";

export async function fetchBinanceTicker(
  symbol: string,
  timeoutMs: number
): Promise<ExternalVenueSnapshot> {
  const started = Date.now();
  const url = "https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT";
  try {
    const payload = (await fetchJsonWithTimeout(url, timeoutMs)) as Record<string, unknown>;
    const bid = parseNum(payload.bidPrice);
    const ask = parseNum(payload.askPrice);
    const mid =
      Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
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

