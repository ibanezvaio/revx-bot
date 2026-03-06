import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetch } from "undici";
import { BotConfig } from "../config";
import {
  assertServiceBaseUrl,
  beginHttpRequestTrace,
  HttpService
} from "../http/endpointGuard";
import { registerVenueServiceHosts } from "../http/venueGuard";
import { Logger } from "../logger";
import {
  createPolymarketClobClient,
  ApiCreds
} from "./auth/clobClientFactory";
import { buildCreateOrderInput, TickSize } from "./auth/requestBuilder";
import { withRetry } from "./auth/retry";
import { OrderBookLevel, YesOrderBook } from "./types";

type HttpMethod = "GET" | "POST" | "DELETE";

type ClobCreds = {
  key: string;
  secret: string;
  passphrase: string;
};

type CredsSource = "env" | "cache" | "derived";

export type RawPolymarketMarket = Record<string, unknown>;
export type RawPolymarketMarketPage = {
  rows: RawPolymarketMarket[];
  nextCursor?: string;
};
export type RawPolymarketEvent = Record<string, unknown>;
export type RawPolymarketEventPage = {
  rows: RawPolymarketEvent[];
  nextCursor?: string;
};

export type PaginatedMarketScanResult = {
  rows: RawPolymarketMarket[];
  pages: number;
  fetchedTotal: number;
};

export type TokenOrderBook = {
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  ts: number;
};

type OpenOrderRow = {
  id: string;
  status: string;
  assetId: string;
  market: string;
  side: "BUY" | "SELL";
  sizeMatched: number;
  originalSize: number;
  price: number;
};

type TradeRow = {
  id: string;
  takerOrderId: string;
  assetId: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  status: string;
  matchTime: string;
};

type CachedCredsRow = {
  host: string;
  chainId: number;
  signatureType: number;
  signerAddress: string;
  funder: string;
  key: string;
  secret: string;
  passphrase: string;
  derivedAt: string;
};

export type PolymarketWhoAmI = {
  mode: "paper" | "live";
  host: string;
  chainId: number;
  signerAddress: string;
  signatureType: number;
  funder: string;
  apiKeyPrefix: string;
  hasApiCreds: boolean;
  apiCredsSource: CredsSource | "none";
};

export type PolymarketIngestionTelemetry = {
  lastFetchAttemptTs: number;
  lastFetchOkTs: number;
  lastFetchErr: string | null;
  lastHttpStatus: number;
};

export type PolymarketMarketResolution = {
  yesTokenId: string | null;
  noTokenId: string | null;
  winningTokenId: string | null;
  winningSide: "YES" | "NO" | null;
  winningOutcome: "UP" | "DOWN" | null;
  winningOutcomeText: string | null;
  yesOutcomeMapped: "UP" | "DOWN" | null;
  noOutcomeMapped: "UP" | "DOWN" | null;
  resolved: boolean;
};

export class PolymarketClient {
  private readonly gammaBaseUrl: string;
  private readonly dataBaseUrl: string;
  private readonly clobBaseUrl: string;
  private readonly bridgeBaseUrl: string;
  private readonly credsCachePath: string;
  private readonly requestScheduler: RequestScheduler;
  private readonly tickSizeCache = new Map<string, TickSize>();
  private readonly negRiskCache = new Map<string, boolean>();
  private transientFailureCount = 0;
  private circuitOpenUntilTs = 0;
  private readonly circuitFailureThreshold = 5;
  private readonly circuitBaseOpenMs = 10_000;
  private readonly circuitMaxOpenMs = 60_000;
  private ingestionTelemetry: PolymarketIngestionTelemetry = {
    lastFetchAttemptTs: 0,
    lastFetchOkTs: 0,
    lastFetchErr: null,
    lastHttpStatus: 0
  };

  private clobModule: any | null = null;
  private publicClient: any | null = null;
  private authClient: any | null = null;
  private resolvedCredsSource: CredsSource | "none" = "none";

  constructor(private readonly config: BotConfig, private readonly logger: Logger) {
    this.gammaBaseUrl = config.polymarket.baseUrls.gamma.replace(/\/+$/, "");
    this.dataBaseUrl = config.polymarket.baseUrls.data.replace(/\/+$/, "");
    this.clobBaseUrl = config.polymarket.baseUrls.clob.replace(/\/+$/, "");
    this.bridgeBaseUrl = config.polymarket.baseUrls.bridge.replace(/\/+$/, "");
    registerVenueServiceHosts("POLY_GAMMA", [this.gammaBaseUrl, "https://gamma-api.polymarket.com"]);
    registerVenueServiceHosts("POLY_DATA", [this.dataBaseUrl, "https://data-api.polymarket.com"]);
    registerVenueServiceHosts("POLY_CLOB", [
      this.clobBaseUrl,
      this.bridgeBaseUrl,
      "https://clob.polymarket.com",
      "https://bridge.polymarket.com"
    ]);
    assertServiceBaseUrl("POLY_GAMMA", this.gammaBaseUrl);
    assertServiceBaseUrl("POLY_DATA", this.dataBaseUrl);
    assertServiceBaseUrl("POLY_CLOB", this.clobBaseUrl);
    assertServiceBaseUrl("POLY_CLOB", this.bridgeBaseUrl);
    this.credsCachePath = path.resolve(process.cwd(), ".polymarket-creds.json");
    this.requestScheduler = new RequestScheduler(
      Math.max(10, Math.floor(60_000 / Math.max(1, config.polymarket.http.requestsPerMinute)))
    );
  }

  async ping(): Promise<{
    ok: boolean;
    mode: "paper" | "live";
    clobBaseUrl: string;
    gammaBaseUrl: string;
    serverTime: number;
    auth: {
      hasPrivateKey: boolean;
      hasApiCreds: boolean;
      autoDeriveApiKey: boolean;
      funder: string;
      chainId: number;
      signatureType: number;
    };
  }> {
    const publicClient = await this.getPublicClient();
    const serverTime = await this.runClobCall("getServerTime", async () => publicClient.getServerTime());
    const ok = await this.runClobCall("getOk", async () => publicClient.getOk());

    if (!Number.isFinite(Number(serverTime))) {
      throw new Error(`Polymarket ping failed: invalid server time response (${String(serverTime)})`);
    }
    const okValue = String(ok ?? "").toLowerCase();
    if (okValue !== "ok" && okValue !== "true") {
      throw new Error(`Polymarket ping failed: /ok returned ${JSON.stringify(ok)}`);
    }

    if (this.config.polymarket.mode === "live") {
      const authClient = await this.getAuthClient();
      await this.runClobCall("getOpenOrders", async () => authClient.getOpenOrders(undefined, true));
    }

    return {
      ok: true,
      mode: this.config.polymarket.mode,
      clobBaseUrl: this.clobBaseUrl,
      gammaBaseUrl: this.gammaBaseUrl,
      serverTime: Number(serverTime),
      auth: {
        hasPrivateKey: Boolean(this.config.polymarket.auth.privateKey),
        hasApiCreds: this.hasApiCreds(),
        autoDeriveApiKey: this.config.polymarket.auth.autoDeriveApiKey,
        funder: this.config.polymarket.auth.funder || "",
        chainId: this.config.polymarket.auth.chainId,
        signatureType: this.config.polymarket.auth.signatureType
      }
    };
  }

  async runStartupSanityCheck(strict: boolean): Promise<{
    gamma: { ok: boolean; status: number | null; path: string; error?: string };
    clob: { ok: boolean; status: number | null; path: string; error?: string };
  }> {
    const gamma = await this.probePublicEndpoint("POLY_GAMMA", this.gammaBaseUrl, ["/time", "/"]);
    const clob = await this.probePublicEndpoint("POLY_CLOB", this.clobBaseUrl, ["/ok", "/"]);
    const payload = {
      strict,
      baseUrls: {
        gamma: this.gammaBaseUrl,
        data: this.dataBaseUrl,
        clob: this.clobBaseUrl,
        bridge: this.bridgeBaseUrl
      },
      results: { gamma, clob }
    };
    if (!gamma.ok || !clob.ok) {
      if (strict) {
        this.logger.error(payload, "Polymarket startup sanity check failed (strict)");
        throw new Error("Polymarket startup sanity check failed");
      }
      this.logger.warn(payload, "Polymarket startup sanity check failed (non-blocking)");
    } else {
      this.logger.info(payload, "Polymarket startup sanity check passed");
    }
    return { gamma, clob };
  }

  async whoAmI(): Promise<PolymarketWhoAmI> {
    const signerCtx = await this.requireSignerContext();
    let apiKeyPrefix = "";
    let source: CredsSource | "none" = "none";

    if (this.authClient && this.resolvedCredsSource !== "none") {
      source = this.resolvedCredsSource;
    }

    if (this.hasApiCreds()) {
      apiKeyPrefix = prefixApiKey(this.config.polymarket.auth.apiKey as string);
      source = source === "none" ? "env" : source;
    } else if (this.config.polymarket.auth.autoDeriveApiKey) {
      const cached = this.loadCachedCreds(signerCtx);
      if (cached) {
        apiKeyPrefix = prefixApiKey(cached.key);
        source = source === "none" ? "cache" : source;
      } else {
        apiKeyPrefix = "<derive-on-demand>";
      }
    }

    return {
      mode: this.config.polymarket.mode,
      host: this.clobBaseUrl,
      chainId: signerCtx.chainId,
      signerAddress: signerCtx.signerAddress,
      signatureType: signerCtx.signatureType,
      funder: signerCtx.funder,
      apiKeyPrefix,
      hasApiCreds: apiKeyPrefix.length > 0 && apiKeyPrefix !== "<derive-on-demand>",
      apiCredsSource: source
    };
  }

  getIngestionTelemetry(): PolymarketIngestionTelemetry {
    return {
      lastFetchAttemptTs: this.ingestionTelemetry.lastFetchAttemptTs,
      lastFetchOkTs: this.ingestionTelemetry.lastFetchOkTs,
      lastFetchErr: this.ingestionTelemetry.lastFetchErr,
      lastHttpStatus: this.ingestionTelemetry.lastHttpStatus
    };
  }

  recordFetchDisabled(reason: string): void {
    const normalizedReason = String(reason || "").trim() || "config_disabled";
    this.markIngestionAttempt();
    this.ingestionTelemetry.lastFetchErr = `FETCH_DISABLED:${truncate(normalizedReason, 240)}`;
    this.ingestionTelemetry.lastHttpStatus = 0;
  }

  async deriveCreds(options?: {
    printSecrets?: boolean;
    useCache?: boolean;
    saveCache?: boolean;
  }): Promise<Record<string, unknown>> {
    const printSecrets = Boolean(options?.printSecrets);
    const useCache = options?.useCache !== false;
    const saveCache = options?.saveCache !== false;
    const signerCtx = await this.requireSignerContext();

    let source: CredsSource = "derived";
    let creds: ClobCreds | null = null;

    if (useCache) {
      const cached = this.loadCachedCreds(signerCtx);
      if (cached) {
        source = "cache";
        creds = cached;
      }
    }

    if (!creds) {
      const module = await this.getClobModule();
      const bootstrap = new module.ClobClient(this.clobBaseUrl, signerCtx.chainId, signerCtx.signer);
      const derived = await this.runClobCall("createOrDeriveApiKey", async () => bootstrap.createOrDeriveApiKey());
      const normalized = normalizeClobCreds(derived);
      if (!normalized) {
        throw new Error("Failed to derive Polymarket API creds from signer");
      }
      creds = normalized;
      source = "derived";
      if (saveCache) {
        this.saveCachedCreds(signerCtx, creds);
      }
    }

    const response: Record<string, unknown> = {
      host: this.clobBaseUrl,
      chainId: signerCtx.chainId,
      signerAddress: signerCtx.signerAddress,
      signatureType: signerCtx.signatureType,
      funder: signerCtx.funder,
      apiKey: creds.key,
      apiKeyPrefix: prefixApiKey(creds.key),
      source
    };
    if (printSecrets) {
      response.apiSecret = creds.secret;
      response.passphrase = creds.passphrase;
    }
    return response;
  }

  async listMarkets(limit: number): Promise<RawPolymarketMarket[]> {
    const query = this.config.polymarket.marketQuery;
    const searchTokens = Array.isArray(query.search)
      ? query.search
      : String((query.search as unknown) || "").split(",");
    const search = searchTokens
      .map((row) => String(row || "").trim())
      .find((row) => row.length > 0);
    const page = await this.listMarketsPage({
      limit,
      search,
      active: true,
      closed: false,
      archived: false
    });
    return page.rows;
  }

  async listEventsPage(input: {
    limit: number;
    slug?: string;
    search?: string;
    query?: string;
    cursor?: string;
    offset?: number;
    page?: number;
    active?: boolean;
    closed?: boolean;
  }): Promise<RawPolymarketEventPage> {
    const params = new URLSearchParams({
      limit: String(Math.max(1, Math.floor(input.limit)))
    });
    if (input.slug && input.slug.trim().length > 0) {
      params.set("slug", input.slug.trim());
    }
    if (input.search && input.search.trim().length > 0) {
      params.set("search", input.search.trim());
    }
    if (input.query && input.query.trim().length > 0) {
      params.set("query", input.query.trim());
    }
    if (typeof input.active === "boolean") {
      params.set("active", String(input.active));
    }
    if (typeof input.closed === "boolean") {
      params.set("closed", String(input.closed));
    }
    if (input.cursor && input.cursor.trim().length > 0) {
      const cursor = input.cursor.trim();
      params.set("next_cursor", cursor);
      params.set("cursor", cursor);
    }
    if (Number.isFinite(input.offset) && Number(input.offset) > 0) {
      params.set("offset", String(Math.floor(Number(input.offset))));
    }
    if (Number.isFinite(input.page) && Number(input.page) > 0) {
      params.set("page", String(Math.floor(Number(input.page))));
    }

    const payload = await this.requestJson("GET", this.gammaBaseUrl, `/events?${params.toString()}`);
    return parseEventsPage(payload);
  }

  async listEvents(limit: number): Promise<RawPolymarketEvent[]> {
    const page = await this.listEventsPage({
      limit
    });
    return page.rows;
  }

  async getRecentEvents(limit: number): Promise<RawPolymarketEvent[]> {
    const boundedLimit = Math.max(1, Math.floor(limit));
    const attempts: Array<{ active?: boolean; closed?: boolean; tag: string }> = [
      { tag: "limit" },
      { tag: "limit_active_true", active: true },
      { tag: "limit_closed_false", closed: false }
    ];

    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const page = await this.listEventsPage({
          limit: boundedLimit,
          active: attempt.active,
          closed: attempt.closed
        });
        if (Array.isArray(page.rows) && page.rows.length > 0) {
          return page.rows;
        }
      } catch (error) {
        lastError = error;
        this.logger.warn(
          {
            attempt: attempt.tag,
            limit: boundedLimit,
            error: serializeError(error)
          },
          "Polymarket recent events attempt failed"
        );
      }
    }

    if (lastError) {
      throw lastError;
    }
    return [];
  }

  async getEventsBySlug(slug: string): Promise<RawPolymarketEvent[]> {
    if (!slug.trim()) return [];
    const page = await this.listEventsPage({
      limit: 200,
      slug
    });
    return page.rows;
  }

  async listMarketsPage(input: {
    limit: number;
    slug?: string;
    search?: string;
    query?: string;
    cursor?: string;
    offset?: number;
    page?: number;
    active?: boolean;
    closed?: boolean;
    archived?: boolean;
  }): Promise<RawPolymarketMarketPage> {
    const params = new URLSearchParams({
      limit: String(Math.max(1, Math.floor(input.limit)))
    });
    if (typeof input.active === "boolean") {
      params.set("active", String(input.active));
    }
    if (typeof input.closed === "boolean") {
      params.set("closed", String(input.closed));
    }
    if (typeof input.archived === "boolean") {
      params.set("archived", String(input.archived));
    }
    if (input.slug && input.slug.trim().length > 0) {
      params.set("slug", input.slug.trim());
    }
    if (input.search && input.search.trim().length > 0) {
      params.set("search", input.search.trim());
    }
    if (input.query && input.query.trim().length > 0) {
      params.set("query", input.query.trim());
    }
    if (input.cursor && input.cursor.trim().length > 0) {
      const cursor = input.cursor.trim();
      // Gamma has used different cursor key names across versions.
      params.set("next_cursor", cursor);
      params.set("cursor", cursor);
    }
    if (Number.isFinite(input.offset) && Number(input.offset) > 0) {
      params.set("offset", String(Math.floor(Number(input.offset))));
    }
    if (Number.isFinite(input.page) && Number(input.page) > 0) {
      params.set("page", String(Math.floor(Number(input.page))));
    }

    const payload = await this.requestJson("GET", this.gammaBaseUrl, `/markets?${params.toString()}`);
    return parseMarketsPage(payload);
  }

  async getActiveMarketBySlug(slug: string): Promise<RawPolymarketMarket | null> {
    const needle = String(slug || "").trim().toLowerCase();
    if (!needle) return null;
    const findExact = (rows: RawPolymarketMarket[]): RawPolymarketMarket | null => {
      for (const row of rows) {
        if (extractMarketSlug(row).toLowerCase() === needle) {
          return row;
        }
      }
      return null;
    };

    try {
      const direct = await this.listMarketsPage({
        limit: 25,
        slug: needle,
        active: true,
        closed: false,
        archived: false
      });
      const exact = findExact(direct.rows);
      if (exact) return exact;
    } catch (error) {
      this.logger.warn(
        {
          slug: needle,
          error: serializeError(error)
        },
        "Polymarket direct slug lookup failed; falling back to active markets scan"
      );
    }

    const page = await this.listMarketsPage({
      limit: 200,
      active: true,
      closed: false,
      archived: false
    });
    return findExact(page.rows);
  }

  async listMarketsPaginated(input: {
    maxScan: number;
    pageSize: number;
    search?: string;
    active?: boolean;
    closed?: boolean;
    archived?: boolean;
    onPage?: (rows: RawPolymarketMarket[], state: { pages: number; fetchedTotal: number }) => boolean | Promise<boolean>;
  }): Promise<PaginatedMarketScanResult> {
    const maxScan = Math.max(1, Math.floor(input.maxScan));
    const pageSize = Math.max(1, Math.floor(input.pageSize));
    const out: RawPolymarketMarket[] = [];
    const seenIds = new Set<string>();
    let fetchedTotal = 0;
    let pages = 0;
    let cursor: string | undefined;
    let offset = 0;
    let offsetMode = false;
    let stalePageRepeats = 0;

    while (out.length < maxScan) {
      const limit = Math.min(pageSize, maxScan - out.length);
      const page = await this.listMarketsPage({
        limit,
        search: input.search,
        active: input.active,
        closed: input.closed,
        archived: input.archived,
        cursor,
        offset: offsetMode ? offset : undefined,
        page: offsetMode ? pages + 1 : undefined
      });
      pages += 1;
      const before = out.length;
      const addedRows: RawPolymarketMarket[] = [];
      for (const row of page.rows) {
        const key = marketUniqueKey(row, out.length + fetchedTotal);
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        out.push(row);
        addedRows.push(row);
        if (out.length >= maxScan) break;
      }
      fetchedTotal = out.length;
      const added = out.length - before;
      const stop = input.onPage
        ? await input.onPage(addedRows, {
            pages,
            fetchedTotal
          })
        : false;

      if (page.nextCursor) {
        cursor = page.nextCursor;
        offsetMode = false;
        stalePageRepeats = 0;
      } else {
        cursor = undefined;
        offsetMode = true;
        offset += Math.max(added, page.rows.length);
      }

      if (added === 0) {
        stalePageRepeats += 1;
      } else {
        stalePageRepeats = 0;
      }
      if (stalePageRepeats >= 2) {
        break;
      }
      if (stop) {
        break;
      }
      if (page.rows.length < limit && !page.nextCursor) {
        break;
      }
    }

    if (out.length < maxScan) {
      // Fallback: some deployments ignore cursor/offset; progressively increase limit.
      let limit = Math.min(maxScan, Math.max(pageSize * 2, out.length + pageSize));
      let previousCount = out.length;
      while (limit <= maxScan) {
        const page = await this.listMarketsPage({
          limit,
          search: input.search,
          active: input.active,
          closed: input.closed,
          archived: input.archived
        });
        pages += 1;
        const addedRows: RawPolymarketMarket[] = [];
        for (const row of page.rows) {
          const key = marketUniqueKey(row, out.length + fetchedTotal);
          if (seenIds.has(key)) continue;
          seenIds.add(key);
          out.push(row);
          addedRows.push(row);
          if (out.length >= maxScan) break;
        }
        fetchedTotal = out.length;
        const stop = input.onPage
          ? await input.onPage(addedRows, {
              pages,
              fetchedTotal
            })
          : false;
        if (stop) {
          break;
        }
        if (out.length <= previousCount || out.length >= maxScan) {
          break;
        }
        previousCount = out.length;
        if (limit === maxScan) break;
        limit = Math.min(maxScan, limit * 2);
      }
    }

    return {
      rows: out.slice(0, maxScan),
      pages,
      fetchedTotal: Math.min(fetchedTotal, maxScan)
    };
  }

  async getMarketResolution(marketId: string): Promise<PolymarketMarketResolution | null> {
    if (!marketId.trim()) return null;
    try {
      const payload = await this.requestJson("GET", this.gammaBaseUrl, `/markets/${encodeURIComponent(marketId)}`);
      const row = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
      if (!row) return null;
      return parseMarketResolution(row);
    } catch {
      return null;
    }
  }

  async getMarketOutcome(marketId: string): Promise<"UP" | "DOWN" | null> {
    const resolution = await this.getMarketResolution(marketId);
    return resolution?.winningOutcome ?? null;
  }

  async getYesOrderBook(marketId: string, tokenId: string): Promise<YesOrderBook> {
    const book = await this.getTokenOrderBook(tokenId);
    const bestBid = book.bestBid;
    const bestAsk = book.bestAsk;
    const yesBid = clamp(bestBid, 0, 1);
    const yesAsk = clamp(bestAsk, yesBid, 1);

    return {
      marketId,
      tokenId,
      yesBid,
      yesAsk,
      yesMid: (yesBid + yesAsk) / 2,
      spread: Math.max(0, yesAsk - yesBid),
      bids: book.bids,
      asks: book.asks,
      ts: book.ts
    };
  }

  async getTokenOrderBook(tokenId: string): Promise<TokenOrderBook> {
    validateTokenId(tokenId);
    try {
      const payload = await this.requestJson(
        "GET",
        this.clobBaseUrl,
        `/book?token_id=${encodeURIComponent(tokenId)}`
      );
      const parsed = this.parseOrderBookPayload(payload, tokenId);
      if (parsed.bids.length > 0 || parsed.asks.length > 0) {
        return parsed;
      }
    } catch (error) {
      this.logger.debug(
        {
          tokenId,
          error: serializeError(error)
        },
        "Polymarket CLOB /book fetch failed; falling back to SDK"
      );
    }

    const client = await this.getPublicClient();
    const book = await this.runClobCall("getOrderBook", async () => client.getOrderBook(tokenId));
    return this.parseOrderBookPayload(book, tokenId);
  }

  async placeMarketableBuyYes(params: {
    tokenId: string;
    limitPrice: number;
    size: number;
    ttlMs: number;
    tickSize?: TickSize;
    negRisk?: boolean;
  }): Promise<{ orderId: string }> {
    validateTokenId(params.tokenId);
    validatePrice(params.limitPrice);
    validateSize(params.size);

    const authClient = await this.getAuthClient();
    const orderType = await this.getOrderTypeConstant("GTD");

    const expirationSec = Math.floor((Date.now() + Math.max(1000, params.ttlMs)) / 1000);
    const tickSize = params.tickSize ?? (await this.getTickSize(params.tokenId));
    const negRisk = params.negRisk ?? (await this.getNegRisk(params.tokenId));

    const { userOrder, options } = buildCreateOrderInput({
      tokenId: params.tokenId,
      side: "BUY",
      price: params.limitPrice,
      size: params.size,
      expirationSec,
      tickSize,
      negRisk
    });

    const response = await this.runClobCall("createAndPostOrder", async () =>
      authClient.createAndPostOrder(userOrder, options, orderType, false, false)
    );

    const orderId = pickString(response, ["orderID", "order_id", "id"]);
    if (!orderId) {
      throw new Error(`Polymarket order placement did not return orderID: ${JSON.stringify(response)}`);
    }
    return { orderId };
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!orderId) return;
    const authClient = await this.getAuthClient();
    await this.runClobCall("cancelOrder", async () => authClient.cancelOrder({ orderID: orderId }));
  }

  async cancelAll(): Promise<void> {
    const authClient = await this.getAuthClient();
    await this.runClobCall("cancelAll", async () => authClient.cancelAll());
  }

  async cancelAllForMarket(params: { marketId?: string; tokenId?: string }): Promise<void> {
    const payload: Record<string, string> = {};
    if (params.marketId && params.marketId.trim().length > 0) {
      payload.market = params.marketId.trim();
    }
    if (params.tokenId && params.tokenId.trim().length > 0) {
      validateTokenId(params.tokenId);
      payload.asset_id = params.tokenId.trim();
    }
    if (!payload.market && !payload.asset_id) {
      return;
    }

    const authClient = await this.getAuthClient();
    await this.runClobCall("cancelMarketOrders", async () => authClient.cancelMarketOrders(payload));
  }

  async getOrder(orderId: string): Promise<OpenOrderRow | null> {
    if (!orderId) return null;
    const authClient = await this.getAuthClient();
    const row = await this.runClobCall("getOrder", async () => authClient.getOrder(orderId));
    if (!row || typeof row !== "object") return null;
    const obj = row as Record<string, unknown>;
    return {
      id: pickString(obj, ["id", "order_id"]),
      status: pickString(obj, ["status"]).toUpperCase(),
      assetId: pickString(obj, ["asset_id", "assetId"]),
      market: pickString(obj, ["market"]),
      side: normalizeSide(pickString(obj, ["side"])) ?? "BUY",
      sizeMatched: asNumber(obj.size_matched),
      originalSize: asNumber(obj.original_size),
      price: asNumber(obj.price)
    };
  }

  async getOpenOrders(): Promise<OpenOrderRow[]> {
    const authClient = await this.getAuthClient();
    const rows = await this.runClobCall("getOpenOrders", async () => authClient.getOpenOrders(undefined, true));
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => normalizeOpenOrder(row))
      .filter((row): row is OpenOrderRow => row !== null);
  }

  async getRecentTrades(limit = 200): Promise<TradeRow[]> {
    const authClient = await this.getAuthClient();
    const rows = await this.runClobCall("getTrades", async () => authClient.getTrades(undefined, true));
    if (!Array.isArray(rows)) return [];
    return rows
      .slice(0, Math.max(1, Math.floor(limit)))
      .map((row) => normalizeTrade(row))
      .filter((row): row is TradeRow => row !== null);
  }

  async getTickSize(tokenId: string): Promise<TickSize> {
    const cached = this.tickSizeCache.get(tokenId);
    if (cached) return cached;

    const publicClient = await this.getPublicClient();
    const raw = await this.runClobCall("getTickSize", async () => publicClient.getTickSize(tokenId));
    const parsed = String(raw || "0.01") as TickSize;
    const tick = parsed === "0.1" || parsed === "0.01" || parsed === "0.001" || parsed === "0.0001"
      ? parsed
      : "0.01";
    this.tickSizeCache.set(tokenId, tick);
    return tick;
  }

  async getNegRisk(tokenId: string): Promise<boolean> {
    const cached = this.negRiskCache.get(tokenId);
    if (cached !== undefined) return cached;
    const publicClient = await this.getPublicClient();
    const raw = await this.runClobCall("getNegRisk", async () => publicClient.getNegRisk(tokenId));
    const value = Boolean(raw);
    this.negRiskCache.set(tokenId, value);
    return value;
  }

  private async runClobCall<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.throwIfCircuitOpen(label);
    this.markIngestionAttempt();
    const trace = beginHttpRequestTrace({
      logger: this.logger,
      service: "POLY_CLOB",
      baseUrl: this.clobBaseUrl,
      method: "SDK",
      path: `/${label}`,
      debugHttp: this.config.debugHttp,
      module: "polymarket"
    });
    try {
      const result = await withRetry(
        () =>
          this.requestScheduler.schedule(() =>
            withTimeout(
              fn(),
              this.getHttpTimeoutMs(),
              `Polymarket CLOB call timeout (${label})`
            )
          ),
        {
          maxRetries: this.config.polymarket.http.maxRetries,
          baseDelayMs: this.config.polymarket.http.baseBackoffMs,
          maxDelayMs: this.config.polymarket.http.maxBackoffMs,
          jitterMs: this.config.polymarket.http.jitterMs,
          isRetryable: (error) => isRetryableError(error),
          onRetry: (attempt, error, delayMs) => {
            this.logger.warn(
              {
                label,
                attempt,
                delayMs,
                error: serializeError(error)
              },
              "Polymarket call retrying"
            );
          }
        }
      );
      this.markNetworkSuccess();
      this.markIngestionSuccess(200);
      trace.done(200, null);
      return result;
    } catch (error) {
      this.markNetworkFailure(label, error);
      this.markIngestionFailure(error, extractStatus(error) ?? 0);
      trace.fail(error, extractStatus(error), null);
      this.logger.error({ label, error: serializeError(error) }, "Polymarket CLOB call failed after retries");
      throw error;
    }
  }

  private async getPublicClient(): Promise<any> {
    if (this.publicClient) return this.publicClient;
    const module = await this.getClobModule();
    this.publicClient = createPolymarketClobClient({
      mode: "read",
      host: this.clobBaseUrl,
      chainId: this.config.polymarket.auth.chainId,
      ClobClient: module.ClobClient
    });
    return this.publicClient;
  }

  private async getAuthClient(): Promise<any> {
    if (this.authClient) return this.authClient;

    const module = await this.getClobModule();
    const signerCtx = await this.requireSignerContext();
    const { creds, source } = await this.resolveTradeCreds(signerCtx);

    this.authClient = createPolymarketClobClient({
      mode: "trade",
      host: this.clobBaseUrl,
      chainId: signerCtx.chainId,
      ClobClient: module.ClobClient,
      signer: signerCtx.signer,
      apiCreds: creds,
      signatureType: signerCtx.signatureType,
      funder: signerCtx.funder
    });
    this.resolvedCredsSource = source;
    this.logger.info(
      {
        host: this.clobBaseUrl,
        chainId: signerCtx.chainId,
        signerAddress: signerCtx.signerAddress,
        signatureType: signerCtx.signatureType,
        funder: signerCtx.funder,
        apiKeyPrefix: prefixApiKey(creds.key),
        credsSource: source
      },
      "Initialized Polymarket trade client"
    );

    return this.authClient;
  }

  private async requireSignerContext(): Promise<{
    signer: any;
    signerAddress: string;
    chainId: number;
    signatureType: number;
    funder: string;
  }> {
    const privateKey = normalizePrivateKey(this.config.polymarket.auth.privateKey);
    if (!privateKey) {
      throw new Error(`Polymarket auth requires ${this.config.polymarket.auth.privateKeyEnv}`);
    }

    const walletModule = await dynamicImportModule<any>("@ethersproject/wallet");
    const signer = new walletModule.Wallet(privateKey);
    const signerAddress = String(signer.address || "").trim();
    const chainId = this.config.polymarket.auth.chainId;
    const signatureType = this.config.polymarket.auth.signatureType;
    const funder = (this.config.polymarket.auth.funder || signerAddress || "").trim();
    if (!funder) {
      throw new Error(`Polymarket auth requires ${this.config.polymarket.auth.funderEnv}`);
    }

    return { signer, signerAddress, chainId, signatureType, funder };
  }

  private async resolveTradeCreds(
    signerCtx: {
      signer: any;
      signerAddress: string;
      chainId: number;
      signatureType: number;
      funder: string;
    }
  ): Promise<{ creds: ApiCreds; source: CredsSource }> {
    if (this.hasApiCreds()) {
      return {
        creds: {
          key: this.config.polymarket.auth.apiKey as string,
          secret: this.config.polymarket.auth.apiSecret as string,
          passphrase: this.config.polymarket.auth.passphrase as string
        },
        source: "env"
      };
    }

    if (!this.config.polymarket.auth.autoDeriveApiKey) {
      throw new Error(
        `Polymarket credentials missing. Set ${this.config.polymarket.auth.apiKeyEnv}, ${this.config.polymarket.auth.apiSecretEnv}, and ${this.config.polymarket.auth.passphraseEnv}, or enable POLYMARKET_AUTO_DERIVE_API_KEY=true.`
      );
    }

    const cached = this.loadCachedCreds(signerCtx);
    if (cached) {
      return { creds: cached, source: "cache" };
    }

    const module = await this.getClobModule();
    const bootstrap = new module.ClobClient(this.clobBaseUrl, signerCtx.chainId, signerCtx.signer);
    const derived = await this.runClobCall("createOrDeriveApiKey", async () => bootstrap.createOrDeriveApiKey());
    const creds = normalizeClobCreds(derived);
    if (!creds) {
      throw new Error("Failed to derive Polymarket API creds from signer");
    }
    this.saveCachedCreds(signerCtx, creds);
    return { creds, source: "derived" };
  }

  private loadCachedCreds(signerCtx: {
    signerAddress: string;
    chainId: number;
    signatureType: number;
    funder: string;
  }): ClobCreds | null {
    try {
      if (!existsSync(this.credsCachePath)) return null;
      const raw = readFileSync(this.credsCachePath, "utf8");
      const parsed = JSON.parse(raw) as CachedCredsRow;
      if (!parsed || typeof parsed !== "object") return null;
      if (String(parsed.host || "") !== this.clobBaseUrl) return null;
      if (Number(parsed.chainId) !== Number(signerCtx.chainId)) return null;
      if (Number(parsed.signatureType) !== Number(signerCtx.signatureType)) return null;
      if (!sameAddress(parsed.signerAddress, signerCtx.signerAddress)) return null;
      if (!sameAddress(parsed.funder, signerCtx.funder)) return null;
      const creds = normalizeClobCreds(parsed);
      return creds;
    } catch {
      return null;
    }
  }

  private saveCachedCreds(
    signerCtx: {
      signerAddress: string;
      chainId: number;
      signatureType: number;
      funder: string;
    },
    creds: ClobCreds
  ): void {
    const payload: CachedCredsRow = {
      host: this.clobBaseUrl,
      chainId: signerCtx.chainId,
      signatureType: signerCtx.signatureType,
      signerAddress: signerCtx.signerAddress,
      funder: signerCtx.funder,
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
      derivedAt: new Date().toISOString()
    };
    writeFileSync(this.credsCachePath, JSON.stringify(payload, null, 2), "utf8");
    this.logger.info(
      {
        path: this.credsCachePath,
        signerAddress: signerCtx.signerAddress,
        signatureType: signerCtx.signatureType,
        funder: signerCtx.funder,
        apiKeyPrefix: prefixApiKey(creds.key)
      },
      "Saved Polymarket derived API creds cache"
    );
  }

  private async getOrderTypeConstant(name: "GTD"): Promise<any> {
    const module = await this.getClobModule();
    return module.OrderType[name];
  }

  private async getClobModule(): Promise<any> {
    if (this.clobModule) return this.clobModule;
    this.clobModule = await dynamicImportModule<any>("@polymarket/clob-client");
    return this.clobModule;
  }

  private hasApiCreds(): boolean {
    return Boolean(
      this.config.polymarket.auth.apiKey &&
      this.config.polymarket.auth.apiSecret &&
      this.config.polymarket.auth.passphrase
    );
  }

  private parseLevels(value: unknown, side: "bids" | "asks"): OrderBookLevel[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((row) => {
        const obj = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
        const price = asNumber(obj.price ?? obj.p);
        const size = asNumber(obj.size ?? obj.s);
        return {
          price: clamp(price, 0, 1),
          size: Math.max(0, size)
        };
      })
      .filter((row) => Number.isFinite(row.price) && row.size > 0)
      .sort((a, b) => (side === "bids" ? b.price - a.price : a.price - b.price));
  }

  private parseOrderBookPayload(payload: unknown, tokenId: string): TokenOrderBook {
    const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const obj =
      root.book && typeof root.book === "object"
        ? (root.book as Record<string, unknown>)
        : root.data && typeof root.data === "object"
          ? (root.data as Record<string, unknown>)
          : root;
    const bids = this.parseLevels(obj.bids, "bids");
    const asks = this.parseLevels(obj.asks, "asks");
    return {
      tokenId,
      bestBid: bids.length > 0 ? bids[0].price : 0,
      bestAsk: asks.length > 0 ? asks[0].price : 1,
      bids,
      asks,
      ts: Date.now()
    };
  }

  private serviceForBaseUrl(baseUrl: string): HttpService {
    const normalized = baseUrl.replace(/\/+$/, "");
    if (normalized === this.gammaBaseUrl) return "POLY_GAMMA";
    if (normalized === this.dataBaseUrl) return "POLY_DATA";
    return "POLY_CLOB";
  }

  private getHttpTimeoutMs(): number {
    return Math.max(15_000, Math.floor(this.config.polymarket.http.timeoutMs));
  }

  private async probePublicEndpoint(
    service: HttpService,
    baseUrl: string,
    pathCandidates: string[]
  ): Promise<{ ok: boolean; status: number | null; path: string; error?: string }> {
    for (const path of pathCandidates) {
      const requestPath = path.startsWith("/") ? path : `/${path}`;
      const url = `${baseUrl}${requestPath}`;
      this.markIngestionAttempt();
      const trace = beginHttpRequestTrace({
        logger: this.logger,
        service,
        baseUrl,
        method: "GET",
        path: requestPath,
        debugHttp: this.config.debugHttp,
        module: "polymarket"
      });
      try {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => {
          controller.abort("timeout");
        }, this.getHttpTimeoutMs());
        try {
          const response = await fetch(url, {
            method: "GET",
            signal: controller.signal
          });
          trace.done(response.status, response.headers);
          if (response.status >= 200 && response.status < 400) {
            this.markIngestionSuccess(response.status);
          } else {
            this.markIngestionFailure(new Error(`HTTP ${response.status}`), response.status);
          }
          if (response.status >= 200 && response.status < 400) {
            return { ok: true, status: response.status, path: requestPath };
          }
          if (response.status >= 300 && response.status < 500) {
            continue;
          }
          return { ok: false, status: response.status, path: requestPath };
        } finally {
          clearTimeout(timeoutHandle);
        }
      } catch (error) {
        this.markIngestionFailure(error);
        trace.fail(error);
        continue;
      }
    }
    return {
      ok: false,
      status: null,
      path: pathCandidates[0] || "/",
      error: "No reachable endpoint"
    };
  }

  private async requestJson(
    method: HttpMethod,
    baseUrl: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const url = `${baseUrl}${path}`;
    const service = this.serviceForBaseUrl(baseUrl);
    this.throwIfCircuitOpen(`${method} ${path}`);
    this.markIngestionAttempt();

    try {
      const result = await withRetry(
        async () => {
          const headers: Record<string, string> = {
            accept: "application/json"
          };

          if (body !== undefined) {
            headers["content-type"] = "application/json";
          }

          const response = await this.requestScheduler.schedule(async () => {
            const controller = new AbortController();
            const timeoutHandle = setTimeout(() => {
              controller.abort("timeout");
            }, this.getHttpTimeoutMs());
            const trace = beginHttpRequestTrace({
              logger: this.logger,
              service,
              baseUrl,
              method,
              path,
              debugHttp: this.config.debugHttp,
              module: "polymarket"
            });
            try {
              const response = await fetch(url, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
              });
              trace.done(response.status, response.headers);
              return response;
            } catch (error) {
              trace.fail(error);
              throw error;
            } finally {
              clearTimeout(timeoutHandle);
            }
          });

          const raw = await response.text();
          if (!response.ok) {
            this.markIngestionFailure(new Error(`HTTP ${response.status}`), response.status);
            throw makeHttpError(method, url, response.status, raw);
          }

          this.markIngestionSuccess(response.status);
          if (!raw) return {};
          return JSON.parse(raw) as unknown;
        },
        {
          maxRetries: this.config.polymarket.http.maxRetries,
          baseDelayMs: this.config.polymarket.http.baseBackoffMs,
          maxDelayMs: this.config.polymarket.http.maxBackoffMs,
          jitterMs: this.config.polymarket.http.jitterMs,
          isRetryable: (error) => isRetryableError(error),
          onRetry: (attempt, error, delayMs) => {
            this.logger.warn(
              {
                method,
                url,
                attempt,
                delayMs,
                error: serializeError(error)
              },
              "Polymarket HTTP retrying"
            );
          }
        }
      );
      this.markNetworkSuccess();
      return result;
    } catch (error) {
      this.markNetworkFailure(`${method} ${path}`, error);
      this.markIngestionFailure(error);
      this.logger.error(
        {
          method,
          url,
          error: serializeError(error)
        },
        "Polymarket HTTP failed after retries"
      );
      throw error;
    }
  }

  private throwIfCircuitOpen(label: string): void {
    if (Date.now() < this.circuitOpenUntilTs) {
      throw new Error(`Polymarket network circuit open for ${label}`);
    }
  }

  private markNetworkSuccess(): void {
    this.transientFailureCount = 0;
    this.circuitOpenUntilTs = 0;
  }

  private markNetworkFailure(label: string, error: unknown): void {
    if (!isRetryableError(error)) {
      return;
    }
    this.transientFailureCount += 1;
    if (this.transientFailureCount < this.circuitFailureThreshold) {
      return;
    }
    const step = this.transientFailureCount - this.circuitFailureThreshold;
    const baseMs = Math.min(this.circuitMaxOpenMs, this.circuitBaseOpenMs * 2 ** Math.min(step, 3));
    const jitterMs = Math.floor(Math.random() * 750);
    const openMs = Math.min(this.circuitMaxOpenMs, baseMs + jitterMs);
    const until = Date.now() + openMs;
    if (until <= this.circuitOpenUntilTs) {
      return;
    }
    this.circuitOpenUntilTs = until;
    this.logger.warn(
      {
        label,
        transientFailureCount: this.transientFailureCount,
        circuitOpenMs: openMs,
        circuitOpenUntilTs: until,
        error: serializeError(error)
      },
      "Polymarket network circuit breaker open"
    );
  }

  private markIngestionAttempt(): void {
    this.ingestionTelemetry.lastFetchAttemptTs = Date.now();
  }

  private markIngestionSuccess(status: number): void {
    this.ingestionTelemetry.lastFetchOkTs = Date.now();
    this.ingestionTelemetry.lastFetchErr = null;
    this.ingestionTelemetry.lastHttpStatus = Number.isFinite(Number(status))
      ? Math.max(0, Math.floor(Number(status)))
      : 0;
  }

  private markIngestionFailure(error: unknown, status?: number): void {
    const details = serializeError(error);
    const message = String(details.message || "").trim();
    this.ingestionTelemetry.lastFetchErr = message.length > 0 ? truncate(message, 300) : "unknown_error";
    if (Number.isFinite(Number(status))) {
      this.ingestionTelemetry.lastHttpStatus = Math.max(0, Math.floor(Number(status)));
      return;
    }
    if (error && typeof error === "object" && "status" in error) {
      const fromError = Number((error as { status?: unknown }).status);
      if (Number.isFinite(fromError)) {
        this.ingestionTelemetry.lastHttpStatus = Math.max(0, Math.floor(fromError));
        return;
      }
    }
    this.ingestionTelemetry.lastHttpStatus = 0;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, boundedTimeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function dynamicImportModule<T>(moduleName: string): Promise<T> {
  if (moduleName === "@polymarket/clob-client") {
    ensureNavigatorUserAgent();
  }
  const importer = new Function("moduleName", "return import(moduleName);") as (m: string) => Promise<T>;
  return importer(moduleName);
}

function ensureNavigatorUserAgent(): void {
  const globalObj = globalThis as unknown as {
    navigator?: { userAgent?: string };
  };

  try {
    if (!globalObj.navigator) {
      (globalThis as unknown as { navigator: { userAgent: string } }).navigator = { userAgent: "Node.js" };
      return;
    }
    if (typeof globalObj.navigator.userAgent !== "string" || globalObj.navigator.userAgent.length === 0) {
      Object.defineProperty(globalObj.navigator, "userAgent", {
        value: "Node.js",
        configurable: true
      });
    }
  } catch {
    // Ignore navigator polyfill failures; SDK import will throw actionable errors.
  }
}

function normalizeClobCreds(input: unknown): ClobCreds | null {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const key = pickString(obj, ["key", "apiKey"]);
  const secret = pickString(obj, ["secret", "apiSecret"]);
  const passphrase = pickString(obj, ["passphrase"]);
  if (!key || !secret || !passphrase) {
    return null;
  }
  return { key, secret, passphrase };
}

function prefixApiKey(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return `${trimmed.slice(0, 6)}...`;
}

function sameAddress(a: string, b: string): boolean {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function normalizePrivateKey(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function makeHttpError(method: string, url: string, status: number, rawBody: string): Error {
  const error = new Error(`HTTP ${status} ${method} ${url}: ${truncate(rawBody, 400)}`) as Error & {
    status?: number;
  };
  error.status = status;
  return error;
}

function isRetryableError(error: unknown): boolean {
  const status = extractStatus(error);
  if (status === 429) return true;
  if (status >= 500) return true;

  const message = String((error as Error)?.message || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("aborted") ||
    message.includes("aborterror") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("fetch failed") ||
    message.includes("temporarily") ||
    message.includes("socket")
  );
}

function extractStatus(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const obj = error as Record<string, unknown>;
  const direct = Number(obj.status);
  if (Number.isFinite(direct)) return direct;

  const response = obj.response && typeof obj.response === "object" ? (obj.response as Record<string, unknown>) : {};
  const nested = Number(response.status);
  if (Number.isFinite(nested)) return nested;

  return 0;
}

function serializeError(error: unknown): Record<string, unknown> {
  const obj = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return {
    message: error instanceof Error ? error.message : String(error),
    status: extractStatus(error),
    name: error instanceof Error ? error.name : String(obj.name || "Error")
  };
}

function parseMarketsPage(payload: unknown): RawPolymarketMarketPage {
  if (Array.isArray(payload)) {
    return {
      rows: payload.filter((row): row is RawPolymarketMarket => row !== null && typeof row === "object")
    };
  }

  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const rows =
    asObjectArray(obj.data) ??
    asObjectArray(obj.markets) ??
    asObjectArray(obj.items) ??
    asObjectArray(obj.results) ??
    [];

  const pagination =
    obj.pagination && typeof obj.pagination === "object"
      ? (obj.pagination as Record<string, unknown>)
      : {};
  const meta = obj.meta && typeof obj.meta === "object" ? (obj.meta as Record<string, unknown>) : {};
  const nextCursor =
    pickString(obj, ["next_cursor", "nextCursor", "cursor", "after"]) ||
    pickString(pagination, ["next_cursor", "nextCursor", "cursor"]) ||
    pickString(meta, ["next_cursor", "nextCursor", "cursor"]) ||
    undefined;

  return { rows, nextCursor };
}

function parseEventsPage(payload: unknown): RawPolymarketEventPage {
  if (Array.isArray(payload)) {
    return {
      rows: payload.filter((row): row is RawPolymarketEvent => row !== null && typeof row === "object")
    };
  }

  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const rows =
    asEventObjectArray(obj.data) ??
    asEventObjectArray(obj.events) ??
    asEventObjectArray(obj.items) ??
    asEventObjectArray(obj.results) ??
    [];

  const pagination =
    obj.pagination && typeof obj.pagination === "object"
      ? (obj.pagination as Record<string, unknown>)
      : {};
  const meta = obj.meta && typeof obj.meta === "object" ? (obj.meta as Record<string, unknown>) : {};
  const nextCursor =
    pickString(obj, ["next_cursor", "nextCursor", "cursor", "after"]) ||
    pickString(pagination, ["next_cursor", "nextCursor", "cursor"]) ||
    pickString(meta, ["next_cursor", "nextCursor", "cursor"]) ||
    undefined;

  return { rows, nextCursor };
}

function asObjectArray(value: unknown): RawPolymarketMarket[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((row): row is RawPolymarketMarket => row !== null && typeof row === "object");
}

function asEventObjectArray(value: unknown): RawPolymarketEvent[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((row): row is RawPolymarketEvent => row !== null && typeof row === "object");
}

function marketUniqueKey(row: RawPolymarketMarket, fallbackSeed: number): string {
  const id = pickString(row, ["id", "market_id", "conditionId", "condition_id", "slug"]);
  if (id) return id;
  const question = pickString(row, ["question", "title"]);
  if (question) return `q:${question.toLowerCase()}`;
  return `fallback:${fallbackSeed}:${JSON.stringify(row).slice(0, 96)}`;
}

function extractMarketSlug(row: RawPolymarketMarket): string {
  return pickString(row, ["slug", "market_slug", "eventSlug", "event_slug", "id"]).trim();
}

function normalizeOpenOrder(row: unknown): OpenOrderRow | null {
  const obj = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  const id = pickString(obj, ["id", "order_id"]);
  const assetId = pickString(obj, ["asset_id", "assetId"]);
  const side = normalizeSide(pickString(obj, ["side"]));
  if (!id || !assetId || !side) return null;

  return {
    id,
    status: pickString(obj, ["status"]).toUpperCase(),
    assetId,
    market: pickString(obj, ["market"]),
    side,
    sizeMatched: asNumber(obj.size_matched),
    originalSize: asNumber(obj.original_size),
    price: asNumber(obj.price)
  };
}

function normalizeTrade(row: unknown): TradeRow | null {
  const obj = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
  const id = pickString(obj, ["id"]);
  const assetId = pickString(obj, ["asset_id", "assetId"]);
  const side = normalizeSide(pickString(obj, ["side"]));
  if (!id || !assetId || !side) return null;

  return {
    id,
    takerOrderId: pickString(obj, ["taker_order_id", "takerOrderId"]),
    assetId,
    side,
    size: asNumber(obj.size),
    price: asNumber(obj.price),
    status: pickString(obj, ["status"]).toUpperCase(),
    matchTime: pickString(obj, ["match_time", "matchTime"])
  };
}

function normalizeSide(value: string): "BUY" | "SELL" | null {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "BUY") return "BUY";
  if (normalized === "SELL") return "SELL";
  return null;
}

function validateTokenId(tokenId: string): void {
  const normalized = String(tokenId || "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid tokenId: ${tokenId}`);
  }
}

function validatePrice(price: number): void {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error(`Invalid price: ${price}`);
  }
}

function validateSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Invalid size: ${size}`);
  }
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickString(input: unknown, keys: string[]): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function pickBoolean(input: unknown, keys: string[]): boolean | undefined {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
      if (normalized === "false" || normalized === "0" || normalized === "no") return false;
    }
  }
  return undefined;
}

function parseMarketResolution(row: Record<string, unknown>): PolymarketMarketResolution {
  const resolvedFlag = pickBoolean(row, ["closed", "resolved", "is_closed", "isResolved"]);
  const clobTokenIds = parseStringArray(row.clobTokenIds);
  const rawYesTokenId = clobTokenIds[0] || null;
  const rawNoTokenId = clobTokenIds[1] || null;
  const yesTokenId = rawYesTokenId;
  const noTokenId = rawYesTokenId && rawNoTokenId && rawYesTokenId === rawNoTokenId ? null : rawNoTokenId;
  const outcomeNames = parseOutcomeNames(row);
  let yesOutcomeText = outcomeNames[0] || "";
  let noOutcomeText = outcomeNames[1] || "";

  const directWinnerTokenId = pickString(row, [
    "winningTokenId",
    "winning_token_id",
    "winnerTokenId",
    "winner_token_id",
    "resolvedTokenId",
    "resolved_token_id"
  ]);
  let winningTokenId: string | null =
    directWinnerTokenId && (directWinnerTokenId === yesTokenId || directWinnerTokenId === noTokenId)
      ? directWinnerTokenId
      : null;
  let winningOutcomeText =
    pickString(row, ["outcome", "winning_outcome", "resolved_outcome", "winner", "result"]) || null;

  const tokens = Array.isArray(row.tokens) ? row.tokens : [];
  const winnerTokenIds = new Set<string>();
  const winnerOutcomeByTokenId = new Map<string, string>();
  for (const token of tokens) {
    if (!token || typeof token !== "object") continue;
    const obj = token as Record<string, unknown>;
    const tokenId = pickString(obj, ["token_id", "tokenId", "id", "clob_token_id"]);
    const outcomeLabel = pickString(obj, ["outcome", "name", "label"]);
    if (tokenId && tokenId === yesTokenId && outcomeLabel && !yesOutcomeText) {
      yesOutcomeText = outcomeLabel;
    }
    if (tokenId && tokenId === noTokenId && outcomeLabel && !noOutcomeText) {
      noOutcomeText = outcomeLabel;
    }
    const winner = pickBoolean(obj, ["winner", "is_winner", "won"]);
    if (winner) {
      if (tokenId) {
        winnerTokenIds.add(tokenId);
        if (outcomeLabel && !winnerOutcomeByTokenId.has(tokenId)) {
          winnerOutcomeByTokenId.set(tokenId, outcomeLabel);
        }
      }
    }
  }

  if (!winningTokenId) {
    const winnerTokensFromBook = Array.from(winnerTokenIds).filter(
      (tokenId) => tokenId === yesTokenId || tokenId === noTokenId
    );
    if (winnerTokensFromBook.length === 1) {
      winningTokenId = winnerTokensFromBook[0];
      if (!winningOutcomeText) {
        winningOutcomeText = winnerOutcomeByTokenId.get(winnerTokensFromBook[0]) || null;
      }
    }
  }

  let winningSide: "YES" | "NO" | null = null;
  if (winningTokenId && yesTokenId && winningTokenId === yesTokenId) {
    winningSide = "YES";
  } else if (winningTokenId && noTokenId && winningTokenId === noTokenId) {
    winningSide = "NO";
  }

  if (!winningSide) {
    winningSide = mapSideFromOutcomeText(winningOutcomeText, yesOutcomeText, noOutcomeText);
  }
  if (!winningTokenId) {
    if (winningSide === "YES") {
      winningTokenId = yesTokenId;
    } else if (winningSide === "NO") {
      winningTokenId = noTokenId;
    }
  }
  if (!winningOutcomeText) {
    winningOutcomeText = winningSide === "YES" ? yesOutcomeText || null : winningSide === "NO" ? noOutcomeText || null : null;
  }

  const yesOutcomeMapped = mapOutcomeText(yesOutcomeText);
  const noOutcomeMapped = mapOutcomeText(noOutcomeText);
  let winningOutcome = mapOutcomeText(winningOutcomeText);
  if (!winningOutcome && winningSide === "YES") {
    winningOutcome = yesOutcomeMapped;
  } else if (!winningOutcome && winningSide === "NO") {
    winningOutcome = noOutcomeMapped;
  }

  return {
    yesTokenId,
    noTokenId,
    winningTokenId,
    winningSide,
    winningOutcome,
    winningOutcomeText,
    yesOutcomeMapped,
    noOutcomeMapped,
    resolved: Boolean(resolvedFlag || winningTokenId || winningSide || winningOutcome)
  };
}

function mapSideFromOutcomeText(
  value: string | null,
  yesOutcomeText: string,
  noOutcomeText: string
): "YES" | "NO" | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const normalizedYes = normalizeText(yesOutcomeText);
  const normalizedNo = normalizeText(noOutcomeText);
  if (normalizedYes && normalized.includes(normalizedYes)) return "YES";
  if (normalizedNo && normalized.includes(normalizedNo)) return "NO";
  if (
    normalized.includes("yes") ||
    normalized.includes("up") ||
    normalized.includes("higher") ||
    normalized.includes("above") ||
    normalized.includes("increase") ||
    normalized.includes("rise")
  ) {
    return "YES";
  }
  if (
    normalized.includes("no") ||
    normalized.includes("down") ||
    normalized.includes("lower") ||
    normalized.includes("below") ||
    normalized.includes("decrease") ||
    normalized.includes("fall")
  ) {
    return "NO";
  }
  return null;
}

function mapOutcomeText(value: string | null): "UP" | "DOWN" | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (
    normalized.includes("yes") ||
    normalized.includes("up") ||
    normalized.includes("higher") ||
    normalized.includes("above") ||
    normalized.includes("increase") ||
    normalized.includes("rise")
  ) {
    return "UP";
  }
  if (
    normalized.includes("no") ||
    normalized.includes("down") ||
    normalized.includes("lower") ||
    normalized.includes("below") ||
    normalized.includes("decrease") ||
    normalized.includes("fall")
  ) {
    return "DOWN";
  }
  return null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((row) => String(row || "").trim())
      .filter((row) => row.length > 0);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed
            .map((row) => String(row || "").trim())
            .filter((row) => row.length > 0);
        }
      } catch {
        return [];
      }
    }
  }
  return [];
}

function parseOutcomeNames(row: Record<string, unknown>): string[] {
  if (Array.isArray(row.outcomes)) {
    return row.outcomes.map((value) => String(value || "").trim()).filter((value) => value.length > 0);
  }
  if (typeof row.outcomes === "string" && row.outcomes.trim().length > 0) {
    try {
      const parsed = JSON.parse(row.outcomes);
      if (Array.isArray(parsed)) {
        return parsed.map((value) => String(value || "").trim()).filter((value) => value.length > 0);
      }
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeText(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}
