import { readFileSync } from "node:fs";
import { createPrivateKey, KeyObject, sign as cryptoSign } from "node:crypto";
import nacl from "tweetnacl";
import { fetch } from "undici";
import { BotConfig } from "../config";
import { Logger } from "../logger";
import { BalanceState } from "../recon/BalanceState";
import { canonicalJsonStringify } from "../util/canonicalJson";
import { sleep } from "../util/time";
import { endpointCandidates, withId, withSymbol } from "./endpoints";

type HttpMethod = "GET" | "POST" | "DELETE";

type QueryValue = string | number | boolean | undefined;

type DegradedReadEndpoint = "orders-active" | "order-by-id";

type RevXReadHealth = {
  degraded: boolean;
  openEndpoints: DegradedReadEndpoint[];
  openUntilMs: number | null;
  lastDegradedTs: number | null;
};

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

class RevXDegradedError extends Error {
  endpoint: DegradedReadEndpoint;
  openUntilMs: number;

  constructor(endpoint: DegradedReadEndpoint, openUntilMs: number, message?: string) {
    super(message ?? `RevX degraded for ${endpoint} until ${new Date(openUntilMs).toISOString()}`);
    this.name = "RevXDegradedError";
    this.endpoint = endpoint;
    this.openUntilMs = openUntilMs;
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

type CircuitState = {
  failures: number[];
  openUntilMs: number;
  halfOpenLogged: boolean;
  lastDegradedTs: number | null;
};

class ReadCircuitBreaker {
  private readonly states: Record<DegradedReadEndpoint, CircuitState> = {
    "orders-active": {
      failures: [],
      openUntilMs: 0,
      halfOpenLogged: false,
      lastDegradedTs: null
    },
    "order-by-id": {
      failures: [],
      openUntilMs: 0,
      halfOpenLogged: false,
      lastDegradedTs: null
    }
  };

  constructor(
    private readonly logger: Logger,
    private readonly threshold: number,
    private readonly windowMs: number,
    private readonly openMs: number
  ) {}

  shouldBlock(endpoint: DegradedReadEndpoint, nowMs: number): boolean {
    const state = this.states[endpoint];
    if (nowMs < state.openUntilMs) {
      return true;
    }
    if (state.openUntilMs > 0 && !state.halfOpenLogged) {
      state.halfOpenLogged = true;
      this.logger.warn(
        { endpoint, openUntilMs: state.openUntilMs },
        "RevX read circuit breaker half-open"
      );
    }
    return false;
  }

  recordFailure(
    endpoint: DegradedReadEndpoint,
    nowMs: number,
    status: number,
    path: string
  ): void {
    const state = this.states[endpoint];
    state.failures = state.failures.filter((ts) => nowMs - ts <= this.windowMs);
    state.failures.push(nowMs);

    const isHalfOpenFailure = state.openUntilMs > 0 && nowMs >= state.openUntilMs && state.halfOpenLogged;
    if (isHalfOpenFailure || state.failures.length >= this.threshold) {
      state.openUntilMs = nowMs + this.openMs;
      state.halfOpenLogged = false;
      state.lastDegradedTs = nowMs;
      this.logger.error(
        {
          endpoint,
          status,
          path,
          failuresInWindow: state.failures.length,
          windowMs: this.windowMs,
          openMs: this.openMs
        },
        "RevX read circuit breaker opened"
      );
    }
  }

  recordSuccess(endpoint: DegradedReadEndpoint, nowMs: number, path: string): void {
    const state = this.states[endpoint];
    const wasOpen = state.openUntilMs > 0;
    state.failures = state.failures.filter((ts) => nowMs - ts <= this.windowMs);
    state.openUntilMs = 0;
    state.halfOpenLogged = false;
    if (wasOpen) {
      this.logger.info({ endpoint, path }, "RevX read circuit breaker closed");
    }
  }

  getOpenUntil(endpoint: DegradedReadEndpoint): number {
    return this.states[endpoint].openUntilMs;
  }

  getHealth(nowMs: number): RevXReadHealth {
    const openEndpoints = (Object.keys(this.states) as DegradedReadEndpoint[]).filter(
      (endpoint) => nowMs < this.states[endpoint].openUntilMs
    );
    let openUntilMs: number | null = null;
    let lastDegradedTs: number | null = null;

    for (const endpoint of Object.keys(this.states) as DegradedReadEndpoint[]) {
      const state = this.states[endpoint];
      if (state.openUntilMs > 0) {
        openUntilMs =
          openUntilMs === null ? state.openUntilMs : Math.max(openUntilMs, state.openUntilMs);
      }
      if (state.lastDegradedTs !== null) {
        lastDegradedTs =
          lastDegradedTs === null ? state.lastDegradedTs : Math.max(lastDegradedTs, state.lastDegradedTs);
      }
    }

    return {
      degraded: openEndpoints.length > 0,
      openEndpoints,
      openUntilMs,
      lastDegradedTs
    };
  }
}

type RequestCacheEntry<T> = {
  value?: T;
  expiresAtMs: number;
  inFlight?: Promise<T>;
  lastAccessMs: number;
};

type SignerFn = (message: string) => string;

const READ_BREAKER_WINDOW_MS = 30_000;
const READ_BREAKER_FAILURE_THRESHOLD = 6;
const READ_BREAKER_OPEN_MS = 60_000;
const ACTIVE_ORDERS_CACHE_TTL_MS = 1_000;
const ORDER_BY_ID_CACHE_TTL_MS = 1_500;
const MAX_ACTIVE_ORDERS_CACHE_ENTRIES = 16;
const MAX_ORDER_BY_ID_CACHE_ENTRIES = 800;

export class RevXClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly signer: SignerFn;
  private readonly scheduler: RequestScheduler;
  private readonly mockMode: boolean;
  private readonly maxRetries = 4;
  private readonly readCircuitBreaker: ReadCircuitBreaker;
  private readonly activeOrdersCache = new Map<string, RequestCacheEntry<RevXOrder[]>>();
  private readonly orderByIdCache = new Map<string, RequestCacheEntry<unknown>>();
  private mockMid = 50_000;
  private readonly mockOrders: RevXOrder[] = [];

  constructor(private readonly config: BotConfig, private readonly logger: Logger) {
    this.baseUrl = config.revxBaseUrl.replace(/\/+$/, "");
    this.apiKey = config.revxApiKey;
    this.mockMode = config.mockMode;
    this.signer = this.mockMode ? () => "" : buildSigner(config);

    const minIntervalMs = Math.ceil((60_000 / Math.max(config.requestsPerMinute, 1)) * 1.05);
    this.scheduler = new RequestScheduler(minIntervalMs);
    this.readCircuitBreaker = new ReadCircuitBreaker(
      logger,
      READ_BREAKER_FAILURE_THRESHOLD,
      READ_BREAKER_WINDOW_MS,
      READ_BREAKER_OPEN_MS
    );
  }

  getReadHealth(): RevXReadHealth {
    return this.readCircuitBreaker.getHealth(Date.now());
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
      const payload = [
        { asset: "USD", free: 160, total: 160, timestamp: Date.now() },
        { asset: "BTC", free: 0, total: 0, timestamp: Date.now() }
      ];
      BalanceState.markRawSuccess(payload, Date.now());
      return payload;
    }
    try {
      const payload = await this.requestWithCandidates<unknown>({
        method: "GET",
        pathCandidates: endpointCandidates.balances
      });
      BalanceState.markRawSuccess(payload, Date.now());
      return coerceArray(payload);
    } catch (error) {
      BalanceState.markRawError(error);
      throw error;
    }
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

    const symbolKey = symbol ? normalizeSymbol(symbol) : "*";
    const cached = this.getCachedValue(this.activeOrdersCache, symbolKey);
    if (cached) {
      return cached.map((order) => ({ ...order }));
    }

    try {
      const loaded = await this.getCachedOrLoad(
        this.activeOrdersCache,
        symbolKey,
        ACTIVE_ORDERS_CACHE_TTL_MS,
        MAX_ACTIVE_ORDERS_CACHE_ENTRIES,
        async () => {
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
      );
      return loaded.map((order) => ({ ...order }));
    } catch (error) {
      if (error instanceof RevXDegradedError) {
        const stale = this.getStaleValue(this.activeOrdersCache, symbolKey);
        if (stale) {
          return stale.map((order) => ({ ...order }));
        }
        return [];
      }
      throw error;
    }
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

    const key = venueOrderId.trim();
    const cached = this.getCachedValue(this.orderByIdCache, key);
    if (cached !== undefined) {
      return cloneUnknown(cached);
    }

    try {
      const loaded = await this.getCachedOrLoad(
        this.orderByIdCache,
        key,
        ORDER_BY_ID_CACHE_TTL_MS,
        MAX_ORDER_BY_ID_CACHE_ENTRIES,
        async () => {
          const paths = endpointCandidates.orderById.map((p) => withId(p, venueOrderId));
          return this.requestWithCandidates<unknown>({
            method: "GET",
            pathCandidates: paths
          });
        }
      );
      return cloneUnknown(loaded);
    } catch (error) {
      if (error instanceof RevXDegradedError) {
        const stale = this.getStaleValue(this.orderByIdCache, key);
        if (stale !== undefined) {
          return cloneUnknown(stale);
        }
      }
      throw error;
    }
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

  private getCachedValue<T>(
    cache: Map<string, RequestCacheEntry<T>>,
    key: string
  ): T | undefined {
    const entry = cache.get(key);
    if (!entry || entry.value === undefined) return undefined;
    if (entry.expiresAtMs <= Date.now()) return undefined;
    entry.lastAccessMs = Date.now();
    return entry.value;
  }

  private getStaleValue<T>(
    cache: Map<string, RequestCacheEntry<T>>,
    key: string
  ): T | undefined {
    const entry = cache.get(key);
    if (!entry || entry.value === undefined) return undefined;
    entry.lastAccessMs = Date.now();
    return entry.value;
  }

  private trimCache<T>(
    cache: Map<string, RequestCacheEntry<T>>,
    maxEntries: number
  ): void {
    if (cache.size <= maxEntries) return;
    const ordered = [...cache.entries()].sort(
      (a, b) => (a[1].lastAccessMs || 0) - (b[1].lastAccessMs || 0)
    );
    const toRemove = cache.size - maxEntries;
    for (let i = 0; i < toRemove; i += 1) {
      cache.delete(ordered[i][0]);
    }
  }

  private async getCachedOrLoad<T>(
    cache: Map<string, RequestCacheEntry<T>>,
    key: string,
    ttlMs: number,
    maxEntries: number,
    loader: () => Promise<T>
  ): Promise<T> {
    const now = Date.now();
    const existing = cache.get(key);
    if (existing?.inFlight) {
      return existing.inFlight;
    }

    const loadPromise = loader()
      .then((value) => {
        cache.set(key, {
          value,
          expiresAtMs: Date.now() + ttlMs,
          lastAccessMs: Date.now()
        });
        this.trimCache(cache, maxEntries);
        return value;
      })
      .catch((error) => {
        const entry = cache.get(key);
        if (entry?.inFlight === loadPromise) {
          if (entry.value === undefined) {
            cache.delete(key);
          } else {
            cache.set(key, {
              value: entry.value,
              expiresAtMs: entry.expiresAtMs,
              lastAccessMs: Date.now()
            });
          }
        }
        throw error;
      });

    cache.set(key, {
      value: existing?.value,
      expiresAtMs: existing?.expiresAtMs ?? now,
      inFlight: loadPromise,
      lastAccessMs: now
    });

    return loadPromise;
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
    const degradedEndpoint = classifyDegradedReadEndpoint(params.method, params.path);
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (
        degradedEndpoint &&
        this.readCircuitBreaker.shouldBlock(degradedEndpoint, Date.now())
      ) {
        throw new RevXDegradedError(
          degradedEndpoint,
          this.readCircuitBreaker.getOpenUntil(degradedEndpoint)
        );
      }
      try {
        const result = await this.scheduler.schedule(() => this.requestOnce<T>(params));
        if (degradedEndpoint) {
          this.readCircuitBreaker.recordSuccess(degradedEndpoint, Date.now(), params.path);
        }
        return result;
      } catch (error) {
        if (error instanceof RevXDegradedError) {
          throw error;
        }

        if (!(error instanceof RevXHttpError)) {
          throw error;
        }

        if (degradedEndpoint && error.status >= 500) {
          this.readCircuitBreaker.recordFailure(
            degradedEndpoint,
            Date.now(),
            error.status,
            params.path
          );
          if (this.readCircuitBreaker.shouldBlock(degradedEndpoint, Date.now())) {
            throw new RevXDegradedError(
              degradedEndpoint,
              this.readCircuitBreaker.getOpenUntil(degradedEndpoint)
            );
          }
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

function classifyDegradedReadEndpoint(
  method: HttpMethod,
  path: string
): DegradedReadEndpoint | null {
  if (method !== "GET") return null;
  const normalized = ensureLeadingSlash(path).replace(/\/+$/, "");
  if (/\/orders\/active$/i.test(normalized)) {
    return "orders-active";
  }
  if (/\/orders\/[^/]+$/i.test(normalized)) {
    return "order-by-id";
  }
  return null;
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

function cloneUnknown<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export { RevXHttpError, RevXDegradedError };
