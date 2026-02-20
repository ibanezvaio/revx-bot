import { readFileSync } from "node:fs";
import { createPrivateKey, KeyObject, sign as cryptoSign } from "node:crypto";
import nacl from "tweetnacl";
import { fetch } from "undici";
import { BotConfig } from "../config";
import { Logger } from "../logger";
import { canonicalJsonStringify } from "../util/canonicalJson";
import { sleep } from "../util/time";
import { endpointCandidates, withId, withSymbol } from "./endpoints";

type HttpMethod = "GET" | "POST" | "DELETE";

type QueryValue = string | number | boolean | undefined;

export type PlaceOrderPayload = {
  client_order_id: string;
  symbol: string;
  side: "buy" | "sell";
  type: "limit";
  order_configuration: {
    limit: {
      price: string;
      quote_size?: string;
      base_size?: string;
      execution_instructions: string[];
    };
  };
};

export type RevXOrder = {
  client_order_id?: string;
  venue_order_id?: string;
  order_id?: string;
  id?: string;
  symbol?: string;
  pair?: string;
  side?: string;
  status?: string;
  state?: string;
  price?: string | number;
  limit_price?: string | number;
  quote_size?: string | number;
  quote_amount?: string | number;
  created_at?: string | number;
  updated_at?: string | number;
  [key: string]: unknown;
};

export type RevXFill = {
  venue_order_id?: string;
  order_id?: string;
  trade_id?: string;
  id?: string;
  quantity?: string | number;
  qty?: string | number;
  size?: string | number;
  price?: string | number;
  fee?: string | number;
  timestamp?: string | number;
  created_at?: string | number;
  [key: string]: unknown;
};

class RevXHttpError extends Error {
  status: number;
  responseBody: unknown;
  retryAfterMs?: number;

  constructor(message: string, status: number, responseBody: unknown, retryAfterMs?: number) {
    super(message);
    this.name = "RevXHttpError";
    this.status = status;
    this.responseBody = responseBody;
    this.retryAfterMs = retryAfterMs;
  }
}

class RequestScheduler {
  private queue: Promise<void> = Promise.resolve();
  private nextAtMs = 0;

  constructor(private readonly minIntervalMs: number) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const waitMs = Math.max(0, this.nextAtMs - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      this.nextAtMs = Date.now() + this.minIntervalMs;
      return fn();
    };

    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

type SignerFn = (message: string) => string;

export class RevXClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly signer: SignerFn;
  private readonly scheduler: RequestScheduler;
  private readonly mockMode: boolean;
  private readonly maxRetries = 4;
  private mockMid = 50_000;
  private readonly mockOrders: RevXOrder[] = [];

  constructor(private readonly config: BotConfig, private readonly logger: Logger) {
    this.baseUrl = config.revxBaseUrl.replace(/\/+$/, "");
    this.apiKey = config.revxApiKey;
    this.mockMode = config.mockMode;
    this.signer = this.mockMode ? () => "" : buildSigner(config);

    const minIntervalMs = Math.ceil((60_000 / Math.max(config.requestsPerMinute, 1)) * 1.05);
    this.scheduler = new RequestScheduler(minIntervalMs);
  }

  async getAllTickers(): Promise<unknown[]> {
    if (this.mockMode) {
      this.mockMid *= 1 + (Math.random() - 0.5) * 0.0005;
      const bid = this.mockMid * (1 - 0.0001);
      const ask = this.mockMid * (1 + 0.0001);
      return [
        {
          symbol: this.config.symbol,
          best_bid: bid.toFixed(2),
          best_ask: ask.toFixed(2),
          mid_price: this.mockMid.toFixed(2),
          last_price: this.mockMid.toFixed(2)
        }
      ];
    }

    const payload = await this.requestWithCandidates<unknown>({
      method: "GET",
      pathCandidates: endpointCandidates.tickers
    });
    return coerceArray(payload);
  }

  async getOrderBookSnapshot(symbol: string, depth = 25): Promise<unknown> {
    if (this.mockMode) {
      return {
        symbol,
        depth,
        bids: [[(this.mockMid * 0.999).toFixed(2), "0.05"]],
        asks: [[(this.mockMid * 1.001).toFixed(2), "0.05"]]
      };
    }

    const paths = endpointCandidates.orderBook.map((p) => withSymbol(p, symbol));
    return this.requestWithCandidates<unknown>({
      method: "GET",
      pathCandidates: paths,
      query: { depth }
    });
  }

  async getBalances(): Promise<unknown[]> {
    if (this.mockMode) {
      return [
        { asset: "USD", free: 160, total: 160, timestamp: Date.now() },
        { asset: "BTC", free: 0, total: 0, timestamp: Date.now() }
      ];
    }

    const payload = await this.requestWithCandidates<unknown>({
      method: "GET",
      pathCandidates: endpointCandidates.balances
    });
    return coerceArray(payload);
  }

  async getActiveOrders(symbol?: string): Promise<RevXOrder[]> {
    if (this.mockMode) {
      const active = this.mockOrders.filter((o) => {
        const state = String(o.state ?? o.status ?? "NEW").toUpperCase();
        const isActive = isActiveOrderState(state);
        const symbolMatches = symbol
          ? normalizeSymbol(String(o.symbol ?? o.pair ?? "")) === normalizeSymbol(symbol)
          : true;
        return isActive && symbolMatches;
      });
      return active.map((o) => ({ ...o }));
    }

    const payload = await this.requestWithCandidates<unknown>({
      method: "GET",
      pathCandidates: endpointCandidates.activeOrders,
      query: symbol ? { symbol } : undefined
    });

    const orders = coerceArray(payload) as RevXOrder[];
    return orders.filter((order) => {
      const state = String(order.state ?? order.status ?? "").toUpperCase();
      const symbolMatches = symbol
        ? normalizeSymbol(String(order.symbol ?? order.pair ?? "")) === normalizeSymbol(symbol)
        : true;
      if (!symbolMatches) return false;
      return state.length === 0 || isActiveOrderState(state);
    });
  }

  async placeOrder(payload: PlaceOrderPayload): Promise<unknown> {
    if (this.mockMode) {
      const now = Date.now();
      const venueOrderId = `mock-${now}-${Math.floor(Math.random() * 100_000)}`;
      const order: RevXOrder = {
        client_order_id: payload.client_order_id,
        venue_order_id: venueOrderId,
        symbol: payload.symbol,
        side: payload.side.toUpperCase(),
        status: "NEW",
        price: payload.order_configuration.limit.price,
        quote_size: payload.order_configuration.limit.quote_size,
        created_at: now,
        updated_at: now
      };
      this.mockOrders.push(order);
      return { ...order };
    }

    return this.requestWithCandidates<unknown>({
      method: "POST",
      pathCandidates: endpointCandidates.placeOrder,
      body: payload
    });
  }

  async cancelOrderById(venueOrderId: string): Promise<unknown> {
    if (this.mockMode) {
      const idx = this.mockOrders.findIndex(
        (o) =>
          o.venue_order_id === venueOrderId || o.order_id === venueOrderId || o.id === venueOrderId
      );
      if (idx >= 0) {
        this.mockOrders[idx] = {
          ...this.mockOrders[idx],
          status: "CANCELLED",
          updated_at: Date.now()
        };
      }
      return { venue_order_id: venueOrderId, status: "CANCELLED" };
    }

    const paths = endpointCandidates.orderById.map((p) => withId(p, venueOrderId));
    return this.requestWithCandidates<unknown>({
      method: "DELETE",
      pathCandidates: paths
    });
  }

  async getOrderById(venueOrderId: string): Promise<unknown> {
    if (this.mockMode) {
      const order = this.mockOrders.find(
        (o) =>
          o.venue_order_id === venueOrderId || o.order_id === venueOrderId || o.id === venueOrderId
      );
      if (!order) {
        throw new RevXHttpError("Mock order not found", 404, { venueOrderId });
      }
      return { ...order };
    }

    const paths = endpointCandidates.orderById.map((p) => withId(p, venueOrderId));
    return this.requestWithCandidates<unknown>({
      method: "GET",
      pathCandidates: paths
    });
  }

  async getOrderFills(venueOrderId: string): Promise<RevXFill[]> {
    if (this.mockMode) {
      return [];
    }

    const paths = endpointCandidates.orderFills.map((p) => withId(p, venueOrderId));
    try {
      const payload = await this.requestWithCandidates<unknown>({
        method: "GET",
        pathCandidates: paths
      });
      return coerceArray(payload) as RevXFill[];
    } catch (error) {
      if (
        error instanceof RevXHttpError &&
        (error.status === 404 || error.status === 405)
      ) {
        const trades = await this.getPrivateTrades();
        return trades.filter((t) => {
          const orderId = pickFirstString(t, ["venue_order_id", "order_id", "id"]);
          return orderId === venueOrderId;
        });
      }
      throw error;
    }
  }

  async getPrivateTrades(): Promise<RevXFill[]> {
    if (this.mockMode) {
      return [];
    }

    const payload = await this.requestWithCandidates<unknown>({
      method: "GET",
      pathCandidates: endpointCandidates.privateTrades
    });
    return coerceArray(payload) as RevXFill[];
  }

  private async requestWithCandidates<T>(params: {
    method: HttpMethod;
    pathCandidates: string[];
    query?: Record<string, QueryValue>;
    body?: unknown;
  }): Promise<T> {
    let lastError: unknown;

    for (const path of params.pathCandidates) {
      try {
        return await this.requestWithRetry<T>({
          method: params.method,
          path,
          query: params.query,
          body: params.body
        });
      } catch (error) {
        lastError = error;
        if (error instanceof RevXHttpError && (error.status === 404 || error.status === 405)) {
          this.logger.debug({ path, status: error.status }, "Endpoint candidate rejected, trying next");
          continue;
        }
        throw error;
      }
    }

    throw lastError ?? new Error("No endpoint candidates configured");
  }

  private async requestWithRetry<T>(params: {
    method: HttpMethod;
    path: string;
    query?: Record<string, QueryValue>;
    body?: unknown;
  }): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.scheduler.schedule(() => this.requestOnce<T>(params));
      } catch (error) {
        if (!(error instanceof RevXHttpError)) {
          throw error;
        }

        if (!isRetryableStatus(error.status) || attempt === this.maxRetries) {
          throw error;
        }

        const backoffMs = error.retryAfterMs ?? Math.min(500 * 2 ** attempt + jitter(200), 8_000);
        this.logger.warn(
          {
            status: error.status,
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            backoffMs,
            path: params.path
          },
          "RevX request retry"
        );
        await sleep(backoffMs);
      }
    }

    throw new Error("Unreachable retry loop");
  }

  private async requestOnce<T>(params: {
    method: HttpMethod;
    path: string;
    query?: Record<string, QueryValue>;
    body?: unknown;
  }): Promise<T> {
    const path = ensureLeadingSlash(params.path);
    const queryString = buildQueryString(params.query);
    const bodyString = params.body === undefined ? "" : canonicalJsonStringify(params.body);
    const timestamp = Date.now().toString();
    const signaturePayload = `${timestamp}${params.method}${path}${queryString}${bodyString}`;
    const signature = this.signer(signaturePayload);

    const url = new URL(path, this.baseUrl);
    if (queryString.length > 0) {
      url.search = queryString;
    }

    const headers: Record<string, string> = {
      "X-Revx-API-Key": this.apiKey,
      "X-Revx-Timestamp": timestamp,
      "X-Revx-Signature": signature
    };

    if (params.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url.toString(), {
      method: params.method,
      headers,
      body: params.body === undefined ? undefined : bodyString
    });

    const rawBody = await response.text();
    const parsedBody = tryParseJson(rawBody);

    if (!response.ok) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader
        ? Number.isFinite(Number(retryAfterHeader))
          ? Number(retryAfterHeader) * 1000
          : undefined
        : undefined;

      throw new RevXHttpError(
        `RevX ${params.method} ${path} failed: ${response.status}`,
        response.status,
        parsedBody,
        retryAfterMs
      );
    }

    return unwrapPayload<T>(parsedBody);
  }
}

function buildSigner(config: BotConfig): SignerFn {
  const keyMaterial = readKeyMaterial(config);

  if (isPem(keyMaterial)) {
    const keyObject = createPrivateKey(keyMaterial.toString("utf8"));
    return buildNodeSigner(keyObject);
  }

  if (keyMaterial.length === 32) {
    const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(keyMaterial));
    return (message: string) => {
      const signature = nacl.sign.detached(Buffer.from(message), keyPair.secretKey);
      return Buffer.from(signature).toString("base64");
    };
  }

  if (keyMaterial.length === 64) {
    return (message: string) => {
      const signature = nacl.sign.detached(Buffer.from(message), new Uint8Array(keyMaterial));
      return Buffer.from(signature).toString("base64");
    };
  }

  try {
    const keyObject = createPrivateKey({
      key: keyMaterial,
      format: "der",
      type: "pkcs8"
    });
    return buildNodeSigner(keyObject);
  } catch (error) {
    throw new Error(
      `Unable to parse Ed25519 private key material. Provide PEM via REVX_PRIVATE_KEY_PATH or a valid base64 key. ${(error as Error).message}`
    );
  }
}

function buildNodeSigner(privateKey: KeyObject): SignerFn {
  return (message: string) => {
    const signature = cryptoSign(null, Buffer.from(message), privateKey);
    return signature.toString("base64");
  };
}

function readKeyMaterial(config: BotConfig): Buffer {
  if (config.revxPrivateKeyPath) {
    return readFileSync(config.revxPrivateKeyPath);
  }

  if (!config.revxPrivateKeyBase64) {
    throw new Error("Missing REVX_PRIVATE_KEY_BASE64 and REVX_PRIVATE_KEY_PATH");
  }

  return Buffer.from(config.revxPrivateKeyBase64, "base64");
}

function isPem(buf: Buffer): boolean {
  const text = buf.toString("utf8").trim();
  return text.includes("BEGIN PRIVATE KEY") || text.includes("BEGIN ED25519 PRIVATE KEY");
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function buildQueryString(query?: Record<string, QueryValue>): string {
  if (!query) {
    return "";
  }

  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function unwrapPayload<T>(payload: unknown): T {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if ("data" in obj) {
      return obj.data as T;
    }
    if ("result" in obj) {
      return obj.result as T;
    }
  }
  return payload as T;
}

function coerceArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const candidates = [obj.items, obj.results, obj.orders, obj.trades, obj.balances, obj.tickers];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
  }
  return [];
}

function pickFirstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function isActiveOrderState(state: string): boolean {
  const normalized = state.trim().toUpperCase();
  return [
    "CREATED",
    "NEW",
    "OPEN",
    "PARTIALLY_FILLED",
    "PARTIAL_FILLED",
    "PENDING",
    "PENDING_NEW",
    "ACCEPTED"
  ].includes(normalized);
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase().replace("/", "-");
}

function tryParseJson(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function jitter(maxMs: number): number {
  return Math.floor(Math.random() * (maxMs + 1));
}

export { RevXHttpError };
