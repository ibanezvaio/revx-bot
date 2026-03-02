import { computeSpreadBps } from "../math";
import { ExternalVenueSnapshot } from "../types";
import { fetchJsonWithTimeout } from "./http";

export async function fetchCoinbaseTicker(
  symbol: string,
  timeoutMs: number
): Promise<ExternalVenueSnapshot> {
  const started = Date.now();
  const url = "https://api.exchange.coinbase.com/products/BTC-USD/ticker";
  try {
    const payload = (await fetchJsonWithTimeout(url, timeoutMs)) as Record<string, unknown>;
    const bid = parseNum(payload.bid);
    const ask = parseNum(payload.ask);
    const price = parseNum(payload.price);
    const mid =
      Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
        ? (bid + ask) / 2
        : Number.isFinite(price) && price > 0
          ? price
          : null;
    const spreadBps =
      mid && Number.isFinite(bid) && Number.isFinite(ask)
        ? computeSpreadBps(bid, ask)
        : null;
    const remoteTs = parseTimeMs(payload.time);
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

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

