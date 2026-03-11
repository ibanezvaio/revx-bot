import { loadConfig } from "../config";
import { fetchBinanceTicker, resolveBinanceTickerUrl } from "../signal/venues/binance";
import { fetchCoinbaseTicker, resolveCoinbaseTickerUrl } from "../signal/venues/coinbase";
import { fetchKrakenTicker, resolveKrakenTickerUrl } from "../signal/venues/kraken";

type ProviderId = "coinbase" | "binance" | "kraken";

async function main(): Promise<void> {
  const config = loadConfig();
  const providers = resolveProviders(config.signalVenues);
  const symbol = String(config.symbol || "BTC-USD").trim().toUpperCase();
  const timeoutMs = Math.max(8_000, Number(config.venueTimeoutMs || 0));
  const startedAt = Date.now();

  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const startedTs = Date.now();
      if (provider === "coinbase") {
        const url = resolveCoinbaseTickerUrl(symbol);
        const snapshot = await fetchCoinbaseTicker(symbol, timeoutMs);
        return {
          provider,
          url,
          method: "GET",
          timeoutMs,
          startTs: startedTs,
          endTs: Date.now(),
          elapsedMs: Date.now() - startedTs,
          responseStatus: snapshot.ok ? "OK" : "FAILED",
          bid: snapshot.bid,
          ask: snapshot.ask,
          mid: snapshot.mid,
          error: snapshot.error ?? null
        };
      }
      if (provider === "binance") {
        const url = resolveBinanceTickerUrl(symbol);
        const snapshot = await fetchBinanceTicker(symbol, timeoutMs);
        return {
          provider,
          url,
          method: "GET",
          timeoutMs,
          startTs: startedTs,
          endTs: Date.now(),
          elapsedMs: Date.now() - startedTs,
          responseStatus: snapshot.ok ? "OK" : "FAILED",
          bid: snapshot.bid,
          ask: snapshot.ask,
          mid: snapshot.mid,
          error: snapshot.error ?? null
        };
      }
      const url = resolveKrakenTickerUrl(symbol);
      const snapshot = await fetchKrakenTicker(symbol, timeoutMs);
      return {
        provider,
        url,
        method: "GET",
        timeoutMs,
        startTs: startedTs,
        endTs: Date.now(),
        elapsedMs: Date.now() - startedTs,
        responseStatus: snapshot.ok ? "OK" : "FAILED",
        bid: snapshot.bid,
        ask: snapshot.ask,
        mid: snapshot.mid,
        error: snapshot.error ?? null
      };
    })
  );

  const rows = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return {
      provider: providers[index],
      url:
        providers[index] === "coinbase"
          ? resolveCoinbaseTickerUrl(symbol)
          : providers[index] === "binance"
            ? resolveBinanceTickerUrl(symbol)
            : resolveKrakenTickerUrl(symbol),
      method: "GET",
      timeoutMs,
      startTs: null,
      endTs: Date.now(),
      elapsedMs: null,
      responseStatus: "ERROR",
      bid: null,
      ask: null,
      mid: null,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason)
    };
  });

  // eslint-disable-next-line no-console
  console.log(`Venue probe started=${new Date(startedAt).toISOString()} symbol=${symbol} timeoutMs=${timeoutMs}`);
  // eslint-disable-next-line no-console
  console.table(rows);
}

function resolveProviders(raw: string[]): ProviderId[] {
  const parsed = (Array.isArray(raw) ? raw : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value): value is ProviderId => value === "coinbase" || value === "binance" || value === "kraken");
  if (parsed.length === 0) return ["coinbase", "binance", "kraken"];
  return Array.from(new Set(parsed));
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
