export type ExchangeStatusSignal = {
  ts: number;
  provider: string;
  source: string;
  kind: "SYSTEM";
  category: "SYSTEM" | "EXCHANGE";
  title: string;
  summary: string;
  url?: string;
  direction: "DOWN" | "NEUTRAL";
  impact: number;
  confidence: number;
  reasonCodes: string[];
  tags: string[];
};

export type ExchangeStatusHealth = {
  provider: string;
  ok: boolean;
  error: string;
  fetchedAtTs: number;
};

const DEFAULT_TIMEOUT_MS = 2_500;

export async function fetchExchangeStatusSignals(nowTs: number): Promise<{
  items: ExchangeStatusSignal[];
  health: ExchangeStatusHealth[];
}> {
  const providers = [
    fetchCoinbaseStatus(nowTs),
    fetchBinanceStatus(nowTs),
    fetchKrakenStatus(nowTs),
    fetchCloudflareStatus(nowTs)
  ];
  const settled = await Promise.all(providers);
  const items: ExchangeStatusSignal[] = [];
  const health: ExchangeStatusHealth[] = [];
  for (const row of settled) {
    health.push(row.health);
    items.push(...row.items);
  }
  return { items, health };
}

async function fetchCoinbaseStatus(nowTs: number): Promise<{ items: ExchangeStatusSignal[]; health: ExchangeStatusHealth }> {
  const provider = "coinbase-status";
  const url = "https://cdpstatus.coinbase.com/api/v2/status.json";
  try {
    const payload = await fetchJsonWithRetry(url, 1);
    const indicator = String(payload?.status?.indicator || "unknown").toLowerCase();
    const description = String(payload?.status?.description || "").trim();
    const ok = indicator === "none" || indicator === "operational";
    const items = ok
      ? []
      : [
          buildDegradedSignal({
            nowTs,
            provider,
            title: "Coinbase status degraded",
            summary: description || `Coinbase indicator=${indicator}`,
            url,
            reasonCodes: ["EXCHANGE_STATUS_DEGRADED", "COINBASE_STATUS"]
          })
        ];
    return { items, health: { provider, ok, error: "", fetchedAtTs: nowTs } };
  } catch (error) {
    return { items: [], health: { provider, ok: false, error: asError(error), fetchedAtTs: nowTs } };
  }
}

async function fetchBinanceStatus(nowTs: number): Promise<{ items: ExchangeStatusSignal[]; health: ExchangeStatusHealth }> {
  const provider = "binance-status";
  const url = "https://www.binance.com/bapi/composite/v1/public/system/getSystemStatus";
  try {
    const payload = await fetchJsonWithRetry(url, 1);
    const status = Number(payload?.data?.status);
    const msg = String(payload?.data?.msg || payload?.msg || "").trim();
    const ok = Number.isFinite(status) ? status === 0 : true;
    const items = ok
      ? []
      : [
          buildDegradedSignal({
            nowTs,
            provider,
            title: "Binance system status degraded",
            summary: msg || `Binance status=${String(status)}`,
            url,
            reasonCodes: ["EXCHANGE_STATUS_DEGRADED", "BINANCE_STATUS"]
          })
        ];
    return { items, health: { provider, ok, error: "", fetchedAtTs: nowTs } };
  } catch (error) {
    return { items: [], health: { provider, ok: false, error: asError(error), fetchedAtTs: nowTs } };
  }
}

async function fetchKrakenStatus(nowTs: number): Promise<{ items: ExchangeStatusSignal[]; health: ExchangeStatusHealth }> {
  const provider = "kraken-status";
  const url = "https://status.kraken.com/api/v2/status.json";
  try {
    const payload = await fetchJsonWithRetry(url, 1);
    const indicator = String(payload?.status?.indicator || "unknown").toLowerCase();
    const description = String(payload?.status?.description || "").trim();
    const ok = indicator === "none" || indicator === "operational";
    const items = ok
      ? []
      : [
          buildDegradedSignal({
            nowTs,
            provider,
            title: "Kraken status degraded",
            summary: description || `Kraken indicator=${indicator}`,
            url,
            reasonCodes: ["EXCHANGE_STATUS_DEGRADED", "KRAKEN_STATUS"]
          })
        ];
    return { items, health: { provider, ok, error: "", fetchedAtTs: nowTs } };
  } catch (error) {
    return { items: [], health: { provider, ok: false, error: asError(error), fetchedAtTs: nowTs } };
  }
}

async function fetchCloudflareStatus(nowTs: number): Promise<{ items: ExchangeStatusSignal[]; health: ExchangeStatusHealth }> {
  const provider = "cloudflare-status";
  const url = "https://www.cloudflarestatus.com/api/v2/status.json";
  try {
    const payload = await fetchJsonWithRetry(url, 1);
    const indicator = String(payload?.status?.indicator || "unknown").toLowerCase();
    const description = String(payload?.status?.description || "").trim();
    const ok = indicator === "none" || indicator === "operational";
    const items = ok
      ? []
      : [
          buildDegradedSignal({
            nowTs,
            provider,
            title: "Cloudflare status degraded",
            summary: description || `Cloudflare indicator=${indicator}`,
            url,
            reasonCodes: ["INFRA_STATUS_DEGRADED", "CLOUDFLARE_STATUS"]
          })
        ];
    return { items, health: { provider, ok, error: "", fetchedAtTs: nowTs } };
  } catch (error) {
    return { items: [], health: { provider, ok: false, error: asError(error), fetchedAtTs: nowTs } };
  }
}

function buildDegradedSignal(args: {
  nowTs: number;
  provider: string;
  title: string;
  summary: string;
  url: string;
  reasonCodes: string[];
}): ExchangeStatusSignal {
  return {
    ts: args.nowTs,
    provider: args.provider,
    source: args.provider,
    kind: "SYSTEM",
    category: "EXCHANGE",
    title: args.title,
    summary: args.summary,
    url: args.url,
    direction: "DOWN",
    impact: 0.62,
    confidence: 0.85,
    reasonCodes: args.reasonCodes,
    tags: ["exchange-status", "diagnostic", "degraded"]
  };
}

async function fetchJsonWithRetry(url: string, retries: number): Promise<any> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchJsonWithTimeout(url, DEFAULT_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "request failed"));
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<any> {
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
      throw new Error(`HTTP ${response.status} ${url}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function asError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
