import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  computeEffectiveRuntimeConfig,
  EffectiveRuntimeConfig,
  isRuntimeOverrideExpired,
  RuntimeOverrideContext,
  RuntimeOverrideDefaults,
  RuntimeOverridesInput,
  RuntimeOverridesMeta,
  RuntimeOverridesRecord,
  mergeRuntimeOverrides
} from "../overrides/runtimeOverrides";
import {
  BalanceSnapshot,
  BotEvent,
  BotStatus,
  ExternalVenueSnapshot,
  FillRecord,
  MetricRecord,
  OrderHistoryRecord,
  OrderRecord,
  OrderUpsert,
  ReconcilerState,
  RollingMetrics,
  VenueQuote,
  SignalSnapshot,
  Store,
  normalizeLegacyPauseFileBotStatus,
  StrategyDecision,
  TickerSnapshot
} from "./Store";

type JsonDb = {
  orders: OrderRecord[];
  orderHistory: OrderHistoryRecord[];
  botStatus: BotStatus | null;
  reconcilerState: ReconcilerState | null;
  fills: FillRecord[];
  balances: BalanceSnapshot[];
  tickerSnapshots: TickerSnapshot[];
  strategyDecisions: StrategyDecision[];
  metrics: MetricRecord[];
  botEvents: BotEvent[];
  externalPriceSnapshots: ExternalVenueSnapshot[];
  signalSnapshots: SignalSnapshot[];
  runtime_overrides: Record<string, RuntimeOverridesRecord>;
};

const ACTIVE_STATUSES = new Set([
  "NEW",
  "OPEN",
  "PARTIALLY_FILLED",
  "PARTIAL_FILLED",
  "PENDING",
  "PENDING_NEW",
  "ACCEPTED",
  "SUBMITTING"
]);

const MAX_ORDER_HISTORY = 20_000;
const MAX_TICKER_SNAPSHOTS = 200_000;
const MAX_STRATEGY_DECISIONS = 20_000;
const MAX_METRICS = 60_000;
const DEFAULT_MAX_BOT_EVENTS = 10_000;
const DEFAULT_MAX_SIGNAL_POINTS = 2_000;

export class JsonStore implements Store {
  private state: JsonDb = {
    orders: [],
    orderHistory: [],
    botStatus: null,
    reconcilerState: null,
    fills: [],
    balances: [],
    tickerSnapshots: [],
    strategyDecisions: [],
    metrics: [],
    botEvents: [],
    externalPriceSnapshots: [],
    signalSnapshots: [],
    runtime_overrides: {}
  };
  private readonly runtimeDefaults: RuntimeOverrideDefaults;

  constructor(
    private readonly filePath: string,
    private readonly options?: {
      maxBotEvents?: number;
      maxSignalPoints?: number;
      eventDedupe?: boolean;
      runtimeDefaults?: RuntimeOverrideDefaults;
    }
  ) {
    this.runtimeDefaults = options?.runtimeDefaults ?? defaultRuntimeOverrideDefaults();
  }

  init(): void {
    if (existsSync(this.filePath)) {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<JsonDb>;
      this.state = {
        orders: Array.isArray(parsed.orders) ? parsed.orders : [],
        orderHistory: Array.isArray(parsed.orderHistory) ? parsed.orderHistory : [],
        botStatus: parsed.botStatus && typeof parsed.botStatus === "object" ? (parsed.botStatus as BotStatus) : null,
        reconcilerState:
          parsed.reconcilerState && typeof parsed.reconcilerState === "object"
            ? (parsed.reconcilerState as ReconcilerState)
            : null,
        fills: Array.isArray(parsed.fills) ? parsed.fills : [],
        balances: Array.isArray(parsed.balances) ? parsed.balances : [],
        tickerSnapshots: Array.isArray(parsed.tickerSnapshots) ? parsed.tickerSnapshots : [],
        strategyDecisions: Array.isArray(parsed.strategyDecisions) ? parsed.strategyDecisions : [],
        metrics: Array.isArray(parsed.metrics) ? parsed.metrics : [],
        botEvents: Array.isArray(parsed.botEvents) ? parsed.botEvents : [],
        externalPriceSnapshots: Array.isArray(parsed.externalPriceSnapshots)
          ? (parsed.externalPriceSnapshots as ExternalVenueSnapshot[])
          : [],
        signalSnapshots: Array.isArray(parsed.signalSnapshots)
          ? (parsed.signalSnapshots as SignalSnapshot[])
          : [],
        runtime_overrides:
          parsed.runtime_overrides && typeof parsed.runtime_overrides === "object"
            ? (parsed.runtime_overrides as Record<string, RuntimeOverridesRecord>)
            : {}
      };

      if (this.state.orderHistory.length === 0 && this.state.orders.length > 0) {
        this.state.orderHistory = [...this.state.orders]
          .sort((a, b) => a.updated_at - b.updated_at)
          .map((order) => ({
            client_order_id: order.client_order_id,
            venue_order_id: order.venue_order_id,
            bot_tag: order.bot_tag ?? null,
            symbol: order.symbol,
            side: order.side,
            price: order.price,
            quote_size: order.quote_size,
            status: normalizeStatus(order.status),
            is_bot: order.is_bot,
            ts: order.updated_at
          }))
          .slice(-MAX_ORDER_HISTORY);
      }

      if (this.state.botEvents.length > this.maxBotEvents()) {
        trimTail(this.state.botEvents, this.maxBotEvents());
      }
      if (this.state.externalPriceSnapshots.length > this.maxSignalPoints() * 8) {
        trimTail(this.state.externalPriceSnapshots, this.maxSignalPoints() * 8);
      }
      if (this.state.signalSnapshots.length > this.maxSignalPoints()) {
        trimTail(this.state.signalSnapshots, this.maxSignalPoints());
      }
      const normalizedStatus = normalizeLegacyPauseFileBotStatus(this.state.botStatus);
      if (normalizedStatus !== this.state.botStatus) {
        this.state.botStatus = normalizedStatus;
        this.flush();
      }

      return;
    }

    mkdirSync(dirname(this.filePath), { recursive: true });
    this.flush();
  }

  close(): void {
    this.flush();
  }

  upsertOrder(order: OrderUpsert): void {
    const now = Date.now();
    const createdAt = order.created_at ?? now;
    const updatedAt = order.updated_at ?? now;
    const status = normalizeStatus(order.status);
    const lastSeenStatus = normalizeStatus(order.last_seen_status ?? status);

    const idx = this.state.orders.findIndex((o) => o.client_order_id === order.client_order_id);
    const next: OrderRecord = {
      client_order_id: order.client_order_id,
      venue_order_id: order.venue_order_id ?? null,
      bot_tag: order.bot_tag ?? null,
      symbol: order.symbol,
      side: order.side,
      price: order.price,
      quote_size: order.quote_size,
      status,
      last_seen_status: lastSeenStatus,
      is_bot: order.is_bot,
      created_at: createdAt,
      updated_at: updatedAt
    };

    if (idx === -1) {
      this.state.orders.push(next);
    } else {
      const current = this.state.orders[idx];
      this.state.orders[idx] = {
        ...current,
        ...next,
        venue_order_id: next.venue_order_id ?? current.venue_order_id,
        bot_tag: next.bot_tag ?? current.bot_tag ?? null,
        created_at: current.created_at
      };
    }

    this.state.orderHistory.push({
      client_order_id: next.client_order_id,
      venue_order_id: next.venue_order_id,
      bot_tag: next.bot_tag ?? null,
      symbol: next.symbol,
      side: next.side,
      price: next.price,
      quote_size: next.quote_size,
      status: next.status,
      is_bot: next.is_bot,
      ts: updatedAt
    });
    trimTail(this.state.orderHistory, MAX_ORDER_HISTORY);
    this.flush();
  }

  updateOrderStatusByVenueId(venueOrderId: string, status: string, updatedAt = Date.now()): void {
    const order = this.state.orders.find((o) => o.venue_order_id === venueOrderId);
    if (!order) return;

    const normalized = normalizeStatus(status);
    order.status = normalized;
    order.last_seen_status = normalized;
    order.updated_at = updatedAt;

    this.state.orderHistory.push({
      client_order_id: order.client_order_id,
      venue_order_id: order.venue_order_id,
      bot_tag: order.bot_tag ?? null,
      symbol: order.symbol,
      side: order.side,
      price: order.price,
      quote_size: order.quote_size,
      status: normalized,
      is_bot: order.is_bot,
      ts: updatedAt
    });
    trimTail(this.state.orderHistory, MAX_ORDER_HISTORY);
    this.flush();
  }

  getActiveBotOrders(symbol?: string): OrderRecord[] {
    return this.state.orders
      .filter((o) => o.is_bot === 1)
      .filter((o) => (symbol ? o.symbol === symbol : true))
      .filter((o) => {
        const venueOrderId = String(o.venue_order_id ?? "").trim();
        return venueOrderId.length > 0;
      })
      .filter((o) => ACTIVE_STATUSES.has(normalizeStatus(o.status)))
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  getActiveOrders(symbol?: string): OrderRecord[] {
    return this.state.orders
      .filter((o) => (symbol ? o.symbol === symbol : true))
      .filter((o) => ACTIVE_STATUSES.has(normalizeStatus(o.status)))
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  getOrderByVenueId(venueOrderId: string): OrderRecord | null {
    return this.state.orders.find((o) => o.venue_order_id === venueOrderId) ?? null;
  }

  getOrderByClientId(clientOrderId: string): OrderRecord | null {
    return this.state.orders.find((o) => o.client_order_id === clientOrderId) ?? null;
  }

  getBotOrdersByTag(tag: string): OrderRecord[] {
    return this.state.orders
      .filter((o) => o.is_bot === 1 && (o.bot_tag ?? null) === tag)
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  getRecentBotOrders(limit: number): OrderRecord[] {
    return this.state.orders
      .filter((o) => o.is_bot === 1)
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, limit);
  }

  getRecentBotOrderHistory(limit: number): OrderHistoryRecord[] {
    return this.state.orderHistory
      .filter((o) => o.is_bot === 1)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  upsertBotStatus(status: BotStatus): void {
    this.state.botStatus = normalizeLegacyPauseFileBotStatus(status);
    this.flush();
  }

  getBotStatus(): BotStatus | null {
    const normalized = normalizeLegacyPauseFileBotStatus(this.state.botStatus);
    if (normalized !== this.state.botStatus) {
      this.state.botStatus = normalized;
      this.flush();
    }
    return this.state.botStatus;
  }

  upsertReconcilerState(state: ReconcilerState): void {
    this.state.reconcilerState = state;
    this.flush();
  }

  getReconcilerState(): ReconcilerState | null {
    return this.state.reconcilerState;
  }

  upsertFill(fill: FillRecord): boolean {
    const exists = this.state.fills.some(
      (f) => f.trade_id === fill.trade_id && f.venue_order_id === fill.venue_order_id
    );
    if (exists) return false;
    this.state.fills.push(fill);
    this.flush();
    return true;
  }

  getRecentFills(limit: number): FillRecord[] {
    return [...this.state.fills].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  getFillsSince(ts: number): FillRecord[] {
    return this.state.fills.filter((f) => f.ts >= ts).sort((a, b) => a.ts - b.ts);
  }

  insertBalanceSnapshots(snapshots: BalanceSnapshot[]): void {
    for (const snapshot of snapshots) {
      const idx = this.state.balances.findIndex(
        (b) => b.asset === snapshot.asset && b.ts === snapshot.ts
      );
      if (idx === -1) {
        this.state.balances.push(snapshot);
      } else {
        this.state.balances[idx] = snapshot;
      }
    }
    this.flush();
  }

  getLatestBalances(): BalanceSnapshot[] {
    const latest = new Map<string, BalanceSnapshot>();
    for (const bal of this.state.balances) {
      const current = latest.get(bal.asset);
      if (!current || bal.ts > current.ts) {
        latest.set(bal.asset, bal);
      }
    }
    return Array.from(latest.values()).sort((a, b) => a.asset.localeCompare(b.asset));
  }

  getRecentBalanceSnapshots(limitTimestamps: number): BalanceSnapshot[] {
    const uniqueTsDesc = Array.from(new Set(this.state.balances.map((b) => b.ts)))
      .sort((a, b) => b - a)
      .slice(0, limitTimestamps);
    const tsSet = new Set(uniqueTsDesc);
    return this.state.balances
      .filter((b) => tsSet.has(b.ts))
      .sort((a, b) => (a.ts === b.ts ? a.asset.localeCompare(b.asset) : a.ts - b.ts));
  }

  recordMidSnapshot(snapshot: TickerSnapshot): void {
    this.insertTickerSnapshot(snapshot);
  }

  insertTickerSnapshot(snapshot: TickerSnapshot): void {
    this.state.tickerSnapshots.push(snapshot);
    trimTail(this.state.tickerSnapshots, MAX_TICKER_SNAPSHOTS);
    this.flush();
  }

  getRecentTickerSnapshots(symbol: string, limit: number): TickerSnapshot[] {
    return this.state.tickerSnapshots
      .filter((t) => t.symbol === symbol)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  recordExternalPriceSnapshot(snapshot: ExternalVenueSnapshot): void {
    const exists = this.state.externalPriceSnapshots.some(
      (row) =>
        row.symbol === snapshot.symbol &&
        row.venue === snapshot.venue &&
        row.ts === snapshot.ts
    );
    if (exists) return;
    this.state.externalPriceSnapshots.push(snapshot);
    trimTail(this.state.externalPriceSnapshots, this.maxSignalPoints() * 8);
    this.flush();
  }

  recordSignalSnapshot(snapshot: SignalSnapshot): void {
    const exists = this.state.signalSnapshots.some(
      (row) => row.symbol === snapshot.symbol && row.ts === snapshot.ts
    );
    if (exists) return;
    this.state.signalSnapshots.push(snapshot);
    trimTail(this.state.signalSnapshots, this.maxSignalPoints());
    this.flush();
  }

  getRecentExternalPriceSnapshots(symbol: string, limit: number): ExternalVenueSnapshot[] {
    return this.state.externalPriceSnapshots
      .filter((row) => row.symbol === symbol)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  getLatestVenueQuotes(symbol: string): VenueQuote[] {
    const latestByVenue = new Map<string, ExternalVenueSnapshot>();
    for (const row of this.state.externalPriceSnapshots) {
      if (row.symbol !== symbol) continue;
      const current = latestByVenue.get(row.venue);
      if (!current || row.ts > current.ts) {
        latestByVenue.set(row.venue, row);
      }
    }
    return Array.from(latestByVenue.values())
      .sort((a, b) => a.venue.localeCompare(b.venue))
      .map((row) => ({
        venue: row.venue,
        bid: row.bid ?? null,
        ask: row.ask ?? null,
        mid: row.mid ?? null,
        ts: row.ts,
        error: row.error ?? null
      }));
  }

  getRecentSignalSnapshots(symbol: string, limit: number): SignalSnapshot[] {
    return this.state.signalSnapshots
      .filter((row) => row.symbol === symbol)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  recordStrategyDecision(decision: StrategyDecision): void {
    const idx = this.state.strategyDecisions.findIndex((d) => d.ts === decision.ts);
    if (idx === -1) {
      this.state.strategyDecisions.push(decision);
    } else {
      this.state.strategyDecisions[idx] = decision;
    }
    trimTail(this.state.strategyDecisions, MAX_STRATEGY_DECISIONS);
    this.flush();
  }

  getRecentStrategyDecisions(limit: number): StrategyDecision[] {
    return [...this.state.strategyDecisions].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  recordMetric(metric: MetricRecord): void {
    const idx = this.state.metrics.findIndex((m) => m.ts === metric.ts && m.key === metric.key);
    if (idx === -1) {
      this.state.metrics.push(metric);
    } else {
      this.state.metrics[idx] = metric;
    }
    trimTail(this.state.metrics, MAX_METRICS);
    this.flush();
  }

  getMetrics(key: string, sinceTs: number, limit: number): MetricRecord[] {
    return this.state.metrics
      .filter((m) => m.key === key && m.ts >= sinceTs)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  recordBotEvent(event: BotEvent): void {
    if (this.options?.eventDedupe !== false) {
      const exists = this.state.botEvents.some((row) => row.event_id === event.event_id);
      if (exists) return;
    }
    this.state.botEvents.push(event);
    trimTail(this.state.botEvents, this.maxBotEvents());
    this.flush();
  }

  getRecentBotEvents(limit: number): BotEvent[] {
    return [...this.state.botEvents].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  getRollingMetrics(nowTs: number): RollingMetrics {
    const oneHourAgo = nowTs - 60 * 60 * 1000;
    const thirtyMinutesAgo = nowTs - 30 * 60 * 1000;
    const todayStart = dayStartTs(nowTs);

    const fills1h = this.state.fills.filter((row) => row.ts >= oneHourAgo);
    const fills30m = this.state.fills.filter((row) => row.ts >= thirtyMinutesAgo);
    const events1h = this.state.botEvents.filter((row) => row.ts >= oneHourAgo);
    const resting1h = this.state.metrics.filter(
      (row) => row.key === "resting_time_seconds" && row.ts >= oneHourAgo
    );

    let buyEdgeSum = 0;
    let buyEdgeCount = 0;
    let sellEdgeSum = 0;
    let sellEdgeCount = 0;
    for (const fill of fills1h) {
      if (!Number.isFinite(fill.edge_bps ?? Number.NaN)) continue;
      const side = this.state.orders.find((order) => order.venue_order_id === fill.venue_order_id)?.side;
      if (side === "BUY") {
        buyEdgeSum += fill.edge_bps as number;
        buyEdgeCount += 1;
      } else if (side === "SELL") {
        sellEdgeSum += fill.edge_bps as number;
        sellEdgeCount += 1;
      }
    }

    const avgEdgeBuy = buyEdgeCount > 0 ? buyEdgeSum / buyEdgeCount : 0;
    const avgEdgeSell = sellEdgeCount > 0 ? sellEdgeSum / sellEdgeCount : 0;
    const avgEdgeTotal =
      buyEdgeCount + sellEdgeCount > 0
        ? (buyEdgeSum + sellEdgeSum) / (buyEdgeCount + sellEdgeCount)
        : 0;

    const latestPnlMetric = this.state.metrics
      .filter((row) => row.key === "realized_pnl_usd")
      .sort((a, b) => b.ts - a.ts)[0];
    const startDayPnlMetric = this.state.metrics
      .filter((row) => row.key === "realized_pnl_usd" && row.ts >= todayStart)
      .sort((a, b) => a.ts - b.ts)[0];
    const realizedPnlToday =
      (latestPnlMetric?.value ?? 0) - (startDayPnlMetric?.value ?? latestPnlMetric?.value ?? 0);

    return {
      ts: nowTs,
      fills_last_30m: fills30m.length,
      fills_last_1h: fills1h.length,
      cancels_last_1h: events1h.filter((row) => row.type === "CANCELLED").length,
      post_only_rejects_last_1h: events1h.filter(
        (row) => row.type === "REJECTED" && row.reason.includes("POST_ONLY_REJECT")
      ).length,
      avg_edge_bps_buy_last_1h: avgEdgeBuy,
      avg_edge_bps_sell_last_1h: avgEdgeSell,
      avg_edge_total_last_1h: avgEdgeTotal,
      avg_resting_time_seconds_last_1h:
        resting1h.length > 0
          ? resting1h.reduce((sum, row) => sum + row.value, 0) / resting1h.length
          : 0,
      realized_pnl_today_usd: realizedPnlToday
    };
  }

  getRuntimeOverrides(symbol: string): RuntimeOverridesRecord | null {
    const key = normalizeSymbol(symbol);
    const current = this.state.runtime_overrides[key] ?? null;
    if (!current) return null;
    if (!isRuntimeOverrideExpired(current)) {
      return current;
    }

    delete this.state.runtime_overrides[key];
    this.recordBotEvent({
      event_id: randomUUID(),
      ts: Date.now(),
      type: "OVERRIDE",
      side: "-",
      price: 0,
      quote_size_usd: 0,
      venue_order_id: null,
      client_order_id: "-",
      reason: "EXPIRE",
      bot_tag: "override",
      details_json: JSON.stringify({
        symbol: key,
        action: "EXPIRE",
        expired_at_ms: current.expiresAtMs,
        updated_at_ms: current.updatedAtMs
      })
    });
    this.flush();
    return null;
  }

  setRuntimeOverrides(
    symbol: string,
    patch: Partial<RuntimeOverridesInput>,
    meta?: RuntimeOverridesMeta
  ): RuntimeOverridesRecord {
    const key = normalizeSymbol(symbol);
    const existing = this.getRuntimeOverrides(key);
    const result = mergeRuntimeOverrides(
      key,
      existing,
      patch as Partial<Record<string, unknown>>,
      this.runtimeDefaults,
      meta,
      { usdTotal: latestAssetTotal(this.state.balances, "USD") }
    );
    this.state.runtime_overrides[key] = result.overrides;
    this.recordBotEvent({
      event_id: randomUUID(),
      ts: Date.now(),
      type: "OVERRIDE",
      side: "-",
      price: 0,
      quote_size_usd: 0,
      venue_order_id: null,
      client_order_id: "-",
      reason: "SET",
      bot_tag: "override",
      details_json: JSON.stringify({
        symbol: key,
        warnings: result.warnings,
        unknown_keys: result.unknownKeys,
        overrides: result.overrides
      })
    });
    this.flush();
    return result.overrides;
  }

  clearRuntimeOverrides(symbol: string, meta?: RuntimeOverridesMeta): void {
    const key = normalizeSymbol(symbol);
    const existing = this.state.runtime_overrides[key];
    if (!existing) return;
    delete this.state.runtime_overrides[key];
    this.recordBotEvent({
      event_id: randomUUID(),
      ts: meta?.nowMs ?? Date.now(),
      type: "OVERRIDE",
      side: "-",
      price: 0,
      quote_size_usd: 0,
      venue_order_id: null,
      client_order_id: "-",
      reason: "CLEAR",
      bot_tag: "override",
      details_json: JSON.stringify({
        symbol: key,
        action: "CLEAR",
        source: meta?.source ?? "dashboard",
        note: meta?.note ?? "",
        previous: existing
      })
    });
    this.flush();
  }

  getEffectiveConfig(symbol: string, context?: RuntimeOverrideContext): EffectiveRuntimeConfig {
    const key = normalizeSymbol(symbol);
    const effective = computeEffectiveRuntimeConfig(this.runtimeDefaults, this.getRuntimeOverrides(key));
    const usdTotal =
      context?.usdTotal ??
      latestAssetTotal(this.state.balances, "USD");
    if (Number.isFinite(usdTotal ?? Number.NaN) && effective.cashReserveUsd > Number(usdTotal)) {
      effective.cashReserveUsd = Math.max(0, Number(usdTotal));
    }
    return effective;
  }

  private flush(): void {
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.state), "utf8");
    renameSync(tmpPath, this.filePath);
  }

  private maxBotEvents(): number {
    return Math.max(500, this.options?.maxBotEvents ?? DEFAULT_MAX_BOT_EVENTS);
  }

  private maxSignalPoints(): number {
    return Math.max(200, this.options?.maxSignalPoints ?? DEFAULT_MAX_SIGNAL_POINTS);
  }
}

function normalizeStatus(value: string): string {
  return value.trim().toUpperCase();
}

function trimTail<T>(arr: T[], maxLen: number): void {
  if (arr.length <= maxLen) return;
  arr.splice(0, arr.length - maxLen);
}

function dayStartTs(nowTs: number): number {
  const d = new Date(nowTs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace("/", "-");
}

function latestAssetTotal(rows: BalanceSnapshot[], asset: string): number | undefined {
  const needle = asset.trim().toUpperCase();
  let latestTs = -1;
  let total: number | undefined;
  for (const row of rows) {
    if (row.asset.toUpperCase() !== needle) continue;
    if (row.ts >= latestTs) {
      latestTs = row.ts;
      total = row.total;
    }
  }
  return total;
}

function defaultRuntimeOverrideDefaults(): RuntimeOverrideDefaults {
  return {
    symbol: "BTC-USD",
    enabled: true,
    allowBuy: true,
    allowSell: true,
    levelsBuy: 2,
    levelsSell: 2,
    levelQuoteSizeUsd: 8,
    baseHalfSpreadBps: 18,
    levelStepBps: 10,
    minMarketSpreadBps: 0.5,
    repriceMoveBps: 10,
    queueRefreshSeconds: 90,
    tobEnabled: false,
    tobQuoteSizeUsd: 3,
    targetBtcNotionalUsd: 80,
    maxBtcNotionalUsd: 120,
    skewMaxBps: 25,
    cashReserveUsd: 60,
    workingCapUsd: 100,
    maxActiveOrders: 10,
    maxActionsPerLoop: 4
  };
}
