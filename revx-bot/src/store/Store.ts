export type Side = "BUY" | "SELL";

export type OrderRecord = {
  client_order_id: string;
  venue_order_id: string | null;
  bot_tag?: string | null;
  symbol: string;
  side: Side;
  price: number;
  quote_size: number;
  status: string;
  last_seen_status?: string;
  is_bot: number;
  created_at: number;
  updated_at: number;
};

export type FillRecord = {
  venue_order_id: string;
  trade_id: string;
  qty: number;
  price: number;
  fee: number;
  mid_at_fill?: number | null;
  edge_bps?: number | null;
  ts: number;
};

export type BalanceSnapshot = {
  asset: string;
  free: number;
  total: number;
  ts: number;
};

export type TickerSnapshot = {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  ts: number;
};

export type OrderUpsert = {
  client_order_id: string;
  venue_order_id?: string | null;
  bot_tag?: string | null;
  symbol: string;
  side: Side;
  price: number;
  quote_size: number;
  status: string;
  last_seen_status?: string;
  is_bot: number;
  created_at?: number;
  updated_at?: number;
};

export type OrderHistoryRecord = {
  client_order_id: string;
  venue_order_id: string | null;
  bot_tag?: string | null;
  symbol: string;
  side: Side;
  price: number;
  quote_size: number;
  status: string;
  is_bot: number;
  ts: number;
};

export type BotStatus = {
  ts: number;
  mid: number;
  exposure_usd: number;
  market_spread_bps?: number;
  vol_move_bps?: number;
  trend_move_bps?: number;
  spread_mult?: number;
  inventory_ratio?: number;
  skew_bps_applied?: number;
  fills_30m?: number;
  fills_1h?: number;
  avg_edge_buy_1h?: number;
  avg_edge_sell_1h?: number;
  cancels_1h?: number;
  rejects_1h?: number;
  adaptive_spread_bps_delta?: number;
  churn_warning?: boolean;
  action_budget_used?: number;
  action_budget_max?: number;
  adaptive_reasons?: string[];
  tob_mode?: string;
  tob_reason?: string;
  sell_throttle_state?: string;
  allow_buy: boolean;
  allow_sell: boolean;
  buy_reasons: string[];
  sell_reasons: string[];
};

export type StrategyDecision = {
  ts: number;
  mid: number;
  spread_mult: number;
  inventory_ratio: number;
  details_json: string;
};

export type MetricRecord = {
  ts: number;
  key: string;
  value: number;
};

export type BotEventType =
  | "PLACED"
  | "CANCELLED"
  | "REPLACED"
  | "FILLED"
  | "REJECTED"
  | "ERROR";

export type BotEvent = {
  event_id: string;
  ts: number;
  type: BotEventType;
  side: Side | "-";
  price: number;
  quote_size_usd: number;
  venue_order_id: string | null;
  client_order_id: string;
  reason: string;
  bot_tag: string;
};

export type RollingMetrics = {
  ts: number;
  fills_last_30m: number;
  fills_last_1h: number;
  cancels_last_1h: number;
  post_only_rejects_last_1h: number;
  avg_edge_bps_buy_last_1h: number;
  avg_edge_bps_sell_last_1h: number;
  avg_edge_total_last_1h: number;
  avg_resting_time_seconds_last_1h: number;
  realized_pnl_today_usd: number;
};

export type ReconcilerState = {
  ts: number;
  balances: {
    usd_free: number;
    usd_total: number;
    btc_free: number;
    btc_total: number;
    snapshot_ts: number;
  };
  activeOrdersByTag: Record<string, OrderRecord>;
  lastFillTs: number | null;
};

export interface Store {
  init(): void;
  close(): void;

  upsertOrder(order: OrderUpsert): void;
  updateOrderStatusByVenueId(venueOrderId: string, status: string, updatedAt?: number): void;
  getActiveBotOrders(symbol?: string): OrderRecord[];
  getActiveOrders(symbol?: string): OrderRecord[];
  getOrderByVenueId(venueOrderId: string): OrderRecord | null;
  getOrderByClientId(clientOrderId: string): OrderRecord | null;
  getBotOrdersByTag(tag: string): OrderRecord[];
  getRecentBotOrders(limit: number): OrderRecord[];
  getRecentBotOrderHistory(limit: number): OrderHistoryRecord[];
  upsertBotStatus(status: BotStatus): void;
  getBotStatus(): BotStatus | null;
  upsertReconcilerState(state: ReconcilerState): void;
  getReconcilerState(): ReconcilerState | null;

  upsertFill(fill: FillRecord): boolean;
  getRecentFills(limit: number): FillRecord[];
  getFillsSince(ts: number): FillRecord[];

  insertBalanceSnapshots(snapshots: BalanceSnapshot[]): void;
  getLatestBalances(): BalanceSnapshot[];
  getRecentBalanceSnapshots(limitTimestamps: number): BalanceSnapshot[];

  recordMidSnapshot(snapshot: TickerSnapshot): void;
  insertTickerSnapshot(snapshot: TickerSnapshot): void;
  getRecentTickerSnapshots(symbol: string, limit: number): TickerSnapshot[];

  recordStrategyDecision(decision: StrategyDecision): void;
  getRecentStrategyDecisions(limit: number): StrategyDecision[];

  recordMetric(metric: MetricRecord): void;
  getMetrics(key: string, sinceTs: number, limit: number): MetricRecord[];

  recordBotEvent(event: BotEvent): void;
  getRecentBotEvents(limit: number): BotEvent[];
  getRollingMetrics(nowTs: number): RollingMetrics;
}
