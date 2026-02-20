import { BotConfig } from "../config";
import { Logger } from "../logger";
import { MarketData } from "../md/MarketData";
import { FifoPnlEstimator } from "../metrics/PnL";
import { RevXClient } from "../revx/RevXClient";
import { findAsset, parseBalancesPayload } from "./balanceParsing";
import { BalanceSnapshot, FillRecord, ReconcilerState, Side, Store } from "../store/Store";

type ParsedOrder = {
  clientOrderId: string;
  venueOrderId: string;
  symbol: string;
  side: Side | null;
  price: number;
  quoteSize: number;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private latestState: ReconcilerState | null = null;
  private estimatorHydrated = false;
  private balanceDiagnosticsLogged = false;
  private readonly pnlEstimator = new FifoPnlEstimator();

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly client: RevXClient,
    private readonly store: Store,
    private readonly marketData?: MarketData
  ) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = Math.max(1, this.config.reconcileSeconds) * 1000;
    this.timer = setInterval(() => {
      void this.reconcileOnce().catch((error) => {
        this.logger.error({ error }, "Reconcile loop error");
      });
    }, intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getLatestState(): ReconcilerState | null {
    if (this.latestState) return this.latestState;
    const persisted = this.store.getReconcilerState();
    if (persisted) {
      this.latestState = persisted;
    }
    return this.latestState;
  }

  async reconcileOnce(): Promise<void> {
    const now = Date.now();

    if (!this.estimatorHydrated) {
      const historical = this.store.getRecentFills(10_000).sort((a, b) => a.ts - b.ts);
      for (const fill of historical) {
        this.pnlEstimator.apply({
          fill,
          side: this.store.getOrderByVenueId(fill.venue_order_id)?.side ?? null
        });
      }
      this.estimatorHydrated = true;
    }

    const knownBotByClient = new Map(
      this.store.getRecentBotOrders(8_000).map((order) => [order.client_order_id, order] as const)
    );

    const activeOrdersByTag: Record<string, ReturnType<typeof toOrderRecord>> = {};
    const activeOrders = await this.client.getActiveOrders(this.config.symbol);
    for (const raw of activeOrders) {
      const parsed = parseOrder(raw as Record<string, unknown>, now);
      if (!parsed.clientOrderId || !parsed.side || !parsed.symbol) continue;

      const known =
        knownBotByClient.get(parsed.clientOrderId) ??
        this.store.getOrderByClientId(parsed.clientOrderId);
      const isBot = known?.is_bot ?? 0;
      const botTag = known?.bot_tag ?? null;

      this.store.upsertOrder({
        client_order_id: parsed.clientOrderId,
        venue_order_id: parsed.venueOrderId,
        bot_tag: botTag,
        symbol: parsed.symbol,
        side: parsed.side,
        price: parsed.price,
        quote_size: parsed.quoteSize,
        status: parsed.status,
        last_seen_status: parsed.status,
        is_bot: isBot,
        created_at: parsed.createdAt,
        updated_at: parsed.updatedAt
      });

      if (isBot === 1 && botTag && isActiveStatus(parsed.status)) {
        activeOrdersByTag[botTag] = toOrderRecord({
          ...parsed,
          side: parsed.side as Side,
          botTag,
          isBot
        });
      }
    }

    const recentBotOrders = this.store.getRecentBotOrders(300);
    const seenVenue = new Set<string>();
    const newFills: Array<{ fill: FillRecord; side: Side | null }> = [];

    for (const order of recentBotOrders) {
      if (!order.venue_order_id || seenVenue.has(order.venue_order_id)) continue;
      seenVenue.add(order.venue_order_id);

      try {
        const orderById = (await this.client.getOrderById(order.venue_order_id)) as Record<
          string,
          unknown
        >;
        const status = normalizeOrderStatus(
          pickString(orderById, ["state", "status"]) || order.status
        );
        this.store.upsertOrder({
          client_order_id: order.client_order_id,
          venue_order_id: order.venue_order_id,
          bot_tag: order.bot_tag ?? null,
          symbol: order.symbol,
          side: order.side,
          price: order.price,
          quote_size: order.quote_size,
          status,
          last_seen_status: status,
          is_bot: order.is_bot,
          updated_at: now
        });
      } catch (error) {
        this.logger.debug({ error, venueOrderId: order.venue_order_id }, "getOrderById failed");
      }

      try {
        const fills = await this.client.getOrderFills(order.venue_order_id);
        for (const rawFill of fills) {
          const parsedFill = parseFill(rawFill as Record<string, unknown>, order.venue_order_id, now);
          if (!parsedFill) continue;

          const midAtFill = this.resolveMidAtFill(order.symbol);
          const edgeBps = computeFillEdgeBps(order.side, parsedFill.price, midAtFill);
          const fill: FillRecord = {
            ...parsedFill,
            mid_at_fill: midAtFill,
            edge_bps: edgeBps
          };

          const inserted = this.store.upsertFill(fill);
          if (inserted) {
            newFills.push({ fill, side: order.side });
            if (Number.isFinite(order.created_at) && order.created_at > 0) {
              const restingSeconds = Math.max(0, (fill.ts - order.created_at) / 1000);
              this.store.recordMetric({
                ts: fill.ts,
                key: "resting_time_seconds",
                value: restingSeconds
              });
            }
            this.store.recordBotEvent({
              event_id: `${fill.venue_order_id}:${fill.trade_id}`,
              ts: fill.ts,
              type: "FILLED",
              side: order.side,
              price: fill.price,
              quote_size_usd: Math.max(0, fill.qty * fill.price),
              venue_order_id: fill.venue_order_id,
              client_order_id: order.client_order_id,
              reason: `trade ${fill.trade_id}`,
              bot_tag: order.bot_tag ?? "-"
            });
          }
        }
      } catch (error) {
        this.logger.debug({ error, venueOrderId: order.venue_order_id }, "getOrderFills failed");
      }
    }

    const balancesRaw = await this.client.getBalances();
    const parsedBalances = parseBalancesPayload(balancesRaw, now);
    const balanceSnapshots: BalanceSnapshot[] = parsedBalances.snapshots;

    if (this.config.debugBalances && !this.balanceDiagnosticsLogged) {
      this.logger.info(
        {
          assets: parsedBalances.diagnostics.map((row) => ({
            asset: row.asset,
            rawAsset: row.rawAsset,
            keys: row.keys,
            available: row.availableRaw,
            free: row.freeRaw,
            tradable: row.tradableRaw,
            balance: row.balanceRaw,
            total: row.totalRaw,
            locked: row.lockedRaw,
            parsedFree: row.parsedFree,
            parsedTotal: row.parsedTotal
          }))
        },
        "Balances assets"
      );
      this.balanceDiagnosticsLogged = true;
    }

    if (balanceSnapshots.length > 0) {
      this.store.insertBalanceSnapshots(balanceSnapshots);
    }

    for (const entry of newFills) {
      this.pnlEstimator.apply(entry);
    }

    const latestBalances = this.store.getLatestBalances();
    const usd = findAsset(latestBalances, ["USD", "USDC"]);
    const btc = findAsset(latestBalances, ["BTC", "XBT"]);
    const snapshotTs = latestBalances.length > 0 ? Math.max(...latestBalances.map((b) => b.ts)) : now;
    const lastFillTs = this.store.getRecentFills(1)[0]?.ts ?? null;

    this.latestState = {
      ts: now,
      balances: {
        usd_free: usd?.free ?? 0,
        usd_total: usd?.total ?? 0,
        btc_free: btc?.free ?? 0,
        btc_total: btc?.total ?? 0,
        snapshot_ts: snapshotTs
      },
      activeOrdersByTag,
      lastFillTs
    };
    this.store.upsertReconcilerState(this.latestState);

    const pnl = this.pnlEstimator.snapshot();
    const rolling = this.store.getRollingMetrics(now);

    this.store.recordMetric({
      ts: now,
      key: "realized_pnl_usd",
      value: pnl.realizedPnlUsd
    });
    this.store.recordMetric({
      ts: now,
      key: "avg_edge_bps_buy",
      value: pnl.avgEdgeBpsBuy
    });
    this.store.recordMetric({
      ts: now,
      key: "avg_edge_bps_sell",
      value: pnl.avgEdgeBpsSell
    });
    this.store.recordMetric({
      ts: now,
      key: "fills_1h_count",
      value: rolling.fills_last_1h
    });
    this.store.recordMetric({
      ts: now,
      key: "fills_last_1h",
      value: rolling.fills_last_1h
    });
    this.store.recordMetric({
      ts: now,
      key: "fills_last_30m",
      value: rolling.fills_last_30m
    });
    this.store.recordMetric({
      ts: now,
      key: "cancels_1h_count",
      value: rolling.cancels_last_1h
    });
    this.store.recordMetric({
      ts: now,
      key: "cancels_last_1h",
      value: rolling.cancels_last_1h
    });
    this.store.recordMetric({
      ts: now,
      key: "post_only_rejects_last_1h",
      value: rolling.post_only_rejects_last_1h
    });
    this.store.recordMetric({
      ts: now,
      key: "avg_resting_time_seconds",
      value: rolling.avg_resting_time_seconds_last_1h
    });

    this.store.recordMetric({
      ts: now,
      key: "maker_fills_count",
      value: pnl.fillCount
    });
  }

  private resolveMidAtFill(symbol: string): number | null {
    const cached = this.marketData?.getCachedMid(symbol) ?? null;
    if (cached && cached > 0) return cached;

    const snapshot = this.store.getRecentTickerSnapshots(symbol, 1)[0];
    if (snapshot && snapshot.mid > 0) return snapshot.mid;

    return null;
  }
}

function toOrderRecord(params: {
  clientOrderId: string;
  venueOrderId: string;
  botTag: string;
  symbol: string;
  side: Side;
  price: number;
  quoteSize: number;
  status: string;
  isBot: number;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    client_order_id: params.clientOrderId,
    venue_order_id: params.venueOrderId,
    bot_tag: params.botTag,
    symbol: params.symbol,
    side: params.side,
    price: params.price,
    quote_size: params.quoteSize,
    status: params.status,
    last_seen_status: params.status,
    is_bot: params.isBot,
    created_at: params.createdAt,
    updated_at: params.updatedAt
  };
}

function parseOrder(raw: Record<string, unknown>, fallbackTs: number): ParsedOrder {
  const clientOrderId = pickString(raw, ["client_order_id"]);
  const venueOrderId = pickString(raw, ["venue_order_id", "order_id", "id"]);
  const symbol = normalizeSymbol(pickString(raw, ["symbol", "pair", "instrument"]));
  const side = parseSide(pickString(raw, ["side"]));
  const price = pickNumber(raw, ["price", "limit_price"], 0);
  const quoteSize = pickNumber(raw, ["quote_size", "size", "quote_amount"], 0);
  const status = normalizeOrderStatus(pickString(raw, ["state", "status"]) || "UNKNOWN");
  const createdAt = pickTimestamp(raw, ["created_at", "createdAt", "timestamp"], fallbackTs);
  const updatedAt = pickTimestamp(raw, ["updated_at", "updatedAt", "timestamp"], fallbackTs);
  return {
    clientOrderId,
    venueOrderId,
    symbol,
    side,
    price,
    quoteSize,
    status,
    createdAt,
    updatedAt
  };
}

function parseFill(
  raw: Record<string, unknown>,
  fallbackVenueOrderId: string,
  fallbackTs: number
): FillRecord | null {
  const venueOrderId =
    pickString(raw, ["venue_order_id", "order_id", "order", "id"]) || fallbackVenueOrderId;
  const tradeId = pickString(raw, ["trade_id", "id", "fill_id"]);
  if (!venueOrderId || !tradeId) return null;
  return {
    venue_order_id: venueOrderId,
    trade_id: tradeId,
    qty: pickNumber(raw, ["qty", "quantity", "size"], 0),
    price: pickNumber(raw, ["price"], 0),
    fee: pickNumber(raw, ["fee", "fees"], 0),
    ts: pickTimestamp(raw, ["timestamp", "created_at", "ts"], fallbackTs)
  };
}

function computeFillEdgeBps(side: Side, fillPrice: number, midAtFill: number | null): number | null {
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return null;
  if (!midAtFill || !Number.isFinite(midAtFill) || midAtFill <= 0) return null;
  if (side === "BUY") {
    return ((midAtFill - fillPrice) / midAtFill) * 10_000;
  }
  return ((fillPrice - midAtFill) / midAtFill) * 10_000;
}

function parseSide(side: string): Side | null {
  const normalized = side.trim().toUpperCase();
  if (normalized === "BUY") return "BUY";
  if (normalized === "SELL") return "SELL";
  return null;
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase().replace("/", "-");
}

function normalizeOrderStatus(value: string): string {
  return value.trim().toUpperCase();
}

function isActiveStatus(status: string): boolean {
  const normalized = normalizeOrderStatus(status);
  return [
    "NEW",
    "OPEN",
    "PARTIALLY_FILLED",
    "PARTIAL_FILLED",
    "PENDING",
    "PENDING_NEW",
    "ACCEPTED",
    "SUBMITTING"
  ].includes(normalized);
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function pickNumber(obj: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function pickTimestamp(obj: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? value : value * 1000;
    }
    if (typeof value === "string") {
      const asNumber = Number(value);
      if (Number.isFinite(asNumber)) {
        return asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
      }
      const parsedDate = Date.parse(value);
      if (!Number.isNaN(parsedDate)) return parsedDate;
    }
  }
  return fallback;
}
