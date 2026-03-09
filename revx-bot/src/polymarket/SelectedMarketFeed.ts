import { WebSocket } from "undici";
import { Logger } from "../logger";

export type SelectedMarketSubscription = {
  marketId: string;
  slug: string | null;
  tokenIds: string[];
};

export type SelectedTokenTopOfBook = {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  topBidSize: number;
  topAskSize: number;
  lastTrade: number | null;
  ts: number;
};

export class SelectedMarketFeed {
  private socket: InstanceType<typeof WebSocket> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private subscription: SelectedMarketSubscription | null = null;
  private lastSubscriptionSignature = "";
  private readonly latestByTokenId = new Map<string, SelectedTokenTopOfBook>();
  private readonly reconnectBaseMs = 1_000;
  private readonly reconnectMaxMs = 10_000;
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private lastWarningTs = 0;
  private lastWarningSignature = "";

  constructor(
    private readonly logger: Logger,
    private readonly wsUrl: string
  ) {}

  setSelectedMarket(next: SelectedMarketSubscription | null): void {
    const normalized = this.normalizeSubscription(next);
    const nextSignature = normalized
      ? `${normalized.marketId}|${normalized.slug || "-"}|${normalized.tokenIds.join(",")}`
      : "";
    if (nextSignature === this.lastSubscriptionSignature) {
      return;
    }
    this.lastSubscriptionSignature = nextSignature;
    this.subscription = normalized;
    this.latestByTokenId.clear();
    this.disconnectSocket();
    if (this.subscription && this.subscription.tokenIds.length > 0) {
      this.connectSocket();
    }
  }

  stop(): void {
    this.subscription = null;
    this.lastSubscriptionSignature = "";
    this.latestByTokenId.clear();
    this.disconnectSocket();
  }

  getTokenTopOfBook(
    tokenId: string,
    nowTs = Date.now(),
    maxAgeMs = 8_000
  ): SelectedTokenTopOfBook | null {
    const normalizedTokenId = String(tokenId || "").trim();
    if (!normalizedTokenId) return null;
    const cached = this.latestByTokenId.get(normalizedTokenId);
    if (!cached) return null;
    if (cached.ts <= 0 || nowTs - cached.ts > Math.max(1_000, maxAgeMs)) {
      return null;
    }
    return { ...cached };
  }

  private normalizeSubscription(input: SelectedMarketSubscription | null): SelectedMarketSubscription | null {
    if (!input) return null;
    const marketId = String(input.marketId || "").trim();
    if (!marketId) return null;
    const tokenIds = Array.from(
      new Set(
        (Array.isArray(input.tokenIds) ? input.tokenIds : [])
          .map((value) => String(value || "").trim())
          .filter((value) => value.length > 0)
      )
    );
    if (tokenIds.length === 0) return null;
    return {
      marketId,
      slug: String(input.slug || "").trim() || null,
      tokenIds
    };
  }

  private connectSocket(): void {
    if (!this.subscription) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.intentionalClose = false;
    let socket: InstanceType<typeof WebSocket>;
    try {
      socket = new WebSocket(this.wsUrl);
    } catch (error) {
      this.logWarning("ws_construct_failed", error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.sendSubscription();
    };
    socket.onmessage = (event) => {
      const text = this.decodeMessageData(event.data);
      if (!text) return;
      this.handleMessage(text);
    };
    socket.onerror = (event) => {
      this.logWarning("ws_error", event);
    };
    socket.onclose = () => {
      this.socket = null;
      if (this.intentionalClose || !this.subscription) {
        return;
      }
      this.scheduleReconnect();
    };
  }

  private disconnectSocket(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    } catch {
      // noop
    }
  }

  private scheduleReconnect(): void {
    if (!this.subscription || this.intentionalClose) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectAttempt += 1;
    const delayMs = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * Math.max(1, this.reconnectAttempt)
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSocket();
    }, delayMs);
  }

  private sendSubscription(): void {
    if (!this.subscription || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const tokenIds = this.subscription.tokenIds;
    const payloads = [
      {
        type: "market",
        assets_ids: tokenIds
      },
      {
        type: "subscribe",
        channel: "market",
        assets_ids: tokenIds
      }
    ];
    for (const payload of payloads) {
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        this.logWarning("ws_subscribe_failed", error);
      }
    }
  }

  private handleMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    this.ingestPayload(parsed);
  }

  private ingestPayload(payload: unknown): void {
    if (Array.isArray(payload)) {
      for (const row of payload) {
        this.ingestPayload(row);
      }
      return;
    }
    if (!payload || typeof payload !== "object") {
      return;
    }
    const obj = payload as Record<string, unknown>;
    if (obj.data !== undefined) {
      this.ingestPayload(obj.data);
    }
    if (Array.isArray(obj.events)) {
      this.ingestPayload(obj.events);
    }

    const tokenId = pickString(obj, ["asset_id", "assetId", "token_id", "tokenId", "token"]);
    if (!tokenId) {
      return;
    }
    if (!this.subscription?.tokenIds.includes(tokenId)) {
      return;
    }

    const nowTs = Date.now();
    const previous = this.latestByTokenId.get(tokenId) || null;
    const fromLevels = parseTopOfBookFromLevels(obj);
    const bestBidFromFields = parseNumber(obj.best_bid ?? obj.bestBid ?? obj.bid);
    const bestAskFromFields = parseNumber(obj.best_ask ?? obj.bestAsk ?? obj.ask);
    const bestBid =
      fromLevels.bestBid ??
      (bestBidFromFields > 0 ? clamp(bestBidFromFields, 0.0001, 0.9999) : previous?.bestBid ?? null);
    const bestAsk =
      fromLevels.bestAsk ??
      (bestAskFromFields > 0 ? clamp(bestAskFromFields, 0.0001, 0.9999) : previous?.bestAsk ?? null);
    const topBidSize =
      fromLevels.topBidSize > 0 ? fromLevels.topBidSize : previous?.topBidSize ?? 0;
    const topAskSize =
      fromLevels.topAskSize > 0 ? fromLevels.topAskSize : previous?.topAskSize ?? 0;
    const tradePriceRaw =
      parseNumber(obj.last_trade_price ?? obj.lastTradePrice ?? obj.price ?? obj.lastPrice ?? obj.mid);
    const lastTrade =
      tradePriceRaw > 0
        ? clamp(tradePriceRaw, 0.0001, 0.9999)
        : previous?.lastTrade ?? null;

    this.latestByTokenId.set(tokenId, {
      tokenId,
      bestBid,
      bestAsk,
      topBidSize,
      topAskSize,
      lastTrade,
      ts: nowTs
    });
  }

  private decodeMessageData(data: unknown): string | null {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString("utf8");
    }
    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer).toString("utf8");
    }
    return null;
  }

  private logWarning(source: string, error: unknown): void {
    const nowTs = Date.now();
    const signature = `${source}:${String((error as Error)?.message || error)}`;
    if (signature === this.lastWarningSignature && nowTs - this.lastWarningTs < 10_000) {
      return;
    }
    this.lastWarningSignature = signature;
    this.lastWarningTs = nowTs;
    this.logger.warn(
      {
        source,
        wsUrl: this.wsUrl,
        error: String((error as Error)?.message || error)
      },
      "Selected market websocket feed warning"
    );
  }
}

function parseTopOfBookFromLevels(input: Record<string, unknown>): {
  bestBid: number | null;
  bestAsk: number | null;
  topBidSize: number;
  topAskSize: number;
} {
  const bids = parseLevels(input.bids);
  const asks = parseLevels(input.asks);
  return {
    bestBid: bids.length > 0 ? bids[0].price : null,
    bestAsk: asks.length > 0 ? asks[0].price : null,
    topBidSize: bids.length > 0 ? bids[0].size : 0,
    topAskSize: asks.length > 0 ? asks[0].size : 0
  };
}

function parseLevels(value: unknown): Array<{ price: number; size: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (Array.isArray(row)) {
        const price = parseNumber(row[0]);
        const size = parseNumber(row[1]);
        if (!(price > 0) || !(size > 0)) return null;
        return {
          price: clamp(price, 0.0001, 0.9999),
          size: Math.max(0, size)
        };
      }
      const obj = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      const price = parseNumber(obj.price ?? obj.p);
      const size = parseNumber(obj.size ?? obj.s);
      if (!(price > 0) || !(size > 0)) return null;
      return {
        price: clamp(price, 0.0001, 0.9999),
        size: Math.max(0, size)
      };
    })
    .filter((row): row is { price: number; size: number } => row !== null);
}

function parseNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : Number.NaN;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}
