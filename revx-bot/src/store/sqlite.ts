import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
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

const ACTIVE_STATUSES = [
  "NEW",
  "OPEN",
  "PARTIALLY_FILLED",
  "PARTIAL_FILLED",
  "PENDING",
  "PENDING_NEW",
  "ACCEPTED",
  "SUBMITTING"
];

const MAX_SIGNAL_SNAPSHOTS = 50_000;
const MAX_EXTERNAL_SNAPSHOTS = 200_000;

export class SQLiteStore implements Store {
  private readonly db: Database.Database;
  private readonly runtimeDefaults: RuntimeOverrideDefaults;

  constructor(dbPath: string, runtimeDefaults?: RuntimeOverrideDefaults) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.runtimeDefaults = runtimeDefaults ?? defaultRuntimeOverrideDefaults();
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        client_order_id TEXT PRIMARY KEY,
        venue_order_id TEXT UNIQUE,
        bot_tag TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        quote_size REAL NOT NULL,
        status TEXT NOT NULL,
        last_seen_status TEXT NOT NULL,
        is_bot INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_orders_symbol_status ON orders(symbol, status);
      CREATE INDEX IF NOT EXISTS idx_orders_venue_order_id ON orders(venue_order_id);
      CREATE INDEX IF NOT EXISTS idx_orders_bot_tag ON orders(bot_tag);

      CREATE TABLE IF NOT EXISTS order_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_order_id TEXT NOT NULL,
        venue_order_id TEXT,
        bot_tag TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        quote_size REAL NOT NULL,
        status TEXT NOT NULL,
        is_bot INTEGER NOT NULL DEFAULT 1,
        ts INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_order_history_bot_ts ON order_history(is_bot, ts);
      CREATE INDEX IF NOT EXISTS idx_order_history_client ON order_history(client_order_id);

      CREATE TABLE IF NOT EXISTS bot_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ts INTEGER NOT NULL,
        mid REAL NOT NULL,
        exposure_usd REAL NOT NULL,
        market_spread_bps REAL,
        vol_move_bps REAL,
        trend_move_bps REAL,
        spread_mult REAL,
        inventory_ratio REAL,
        skew_bps_applied REAL,
        fills_30m INTEGER,
        fills_1h INTEGER,
        avg_edge_buy_1h REAL,
        avg_edge_sell_1h REAL,
        cancels_1h INTEGER,
        rejects_1h INTEGER,
        adaptive_spread_bps_delta REAL,
        churn_warning INTEGER,
        action_budget_used INTEGER,
        action_budget_max INTEGER,
        adaptive_reasons TEXT,
        tob_mode TEXT,
        tob_reason TEXT,
        sell_throttle_state TEXT,
        quoting_json TEXT,
        quoting_inputs_json TEXT,
        allow_buy INTEGER NOT NULL,
        allow_sell INTEGER NOT NULL,
        buy_reasons TEXT NOT NULL,
        sell_reasons TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reconciler_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ts INTEGER NOT NULL,
        usd_free REAL NOT NULL,
        usd_total REAL NOT NULL,
        btc_free REAL NOT NULL,
        btc_total REAL NOT NULL,
        snapshot_ts INTEGER NOT NULL,
        active_orders_by_tag TEXT NOT NULL,
        last_fill_ts INTEGER
      );

      CREATE TABLE IF NOT EXISTS fills (
        venue_order_id TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        qty REAL NOT NULL,
        price REAL NOT NULL,
        fee REAL NOT NULL,
        mid_at_fill REAL,
        edge_bps REAL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (venue_order_id, trade_id)
      );

      CREATE INDEX IF NOT EXISTS idx_fills_ts ON fills(ts);

      CREATE TABLE IF NOT EXISTS balances (
        asset TEXT NOT NULL,
        free REAL NOT NULL,
        total REAL NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY(asset, ts)
      );

      CREATE INDEX IF NOT EXISTS idx_balances_asset_ts ON balances(asset, ts);

      CREATE TABLE IF NOT EXISTS ticker_snapshots (
        symbol TEXT NOT NULL,
        bid REAL NOT NULL,
        ask REAL NOT NULL,
        mid REAL NOT NULL,
        last REAL NOT NULL,
        ts INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ticker_snapshots_symbol_ts ON ticker_snapshots(symbol, ts);

      CREATE TABLE IF NOT EXISTS external_price_snapshots (
        symbol TEXT NOT NULL,
        venue TEXT NOT NULL,
        quote TEXT NOT NULL,
        ts INTEGER NOT NULL,
        bid REAL,
        ask REAL,
        mid REAL,
        spread_bps REAL,
        latency_ms INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        error TEXT,
        PRIMARY KEY(symbol, venue, ts)
      );

      CREATE INDEX IF NOT EXISTS idx_external_price_snapshots_symbol_ts
        ON external_price_snapshots(symbol, ts);

      CREATE TABLE IF NOT EXISTS signal_snapshots (
        symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        revx_mid REAL NOT NULL,
        global_mid REAL NOT NULL,
        fair_mid REAL NOT NULL,
        basis_bps REAL NOT NULL,
        drift_bps REAL NOT NULL,
        stdev_bps REAL NOT NULL,
        z_score REAL NOT NULL,
        confidence REAL NOT NULL,
        dispersion_bps REAL NOT NULL,
        vol_regime TEXT NOT NULL,
        drift_component_bps REAL NOT NULL,
        basis_correction_bps REAL NOT NULL,
        healthy_venues INTEGER NOT NULL,
        total_venues INTEGER NOT NULL,
        PRIMARY KEY(symbol, ts)
      );

      CREATE INDEX IF NOT EXISTS idx_signal_snapshots_symbol_ts
        ON signal_snapshots(symbol, ts);

      CREATE TABLE IF NOT EXISTS strategy_decisions (
        ts INTEGER PRIMARY KEY,
        mid REAL NOT NULL,
        spread_mult REAL NOT NULL,
        inventory_ratio REAL NOT NULL,
        details_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics (
        ts INTEGER NOT NULL,
        key TEXT NOT NULL,
        value REAL NOT NULL,
        PRIMARY KEY (ts, key)
      );

      CREATE INDEX IF NOT EXISTS idx_metrics_key_ts ON metrics(key, ts);

      CREATE TABLE IF NOT EXISTS bot_events (
        event_id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        quote_size_usd REAL NOT NULL,
        venue_order_id TEXT,
        client_order_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        bot_tag TEXT NOT NULL,
        details_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_bot_events_ts ON bot_events(ts);
      CREATE INDEX IF NOT EXISTS idx_bot_events_type_ts ON bot_events(type, ts);

      CREATE TABLE IF NOT EXISTS runtime_overrides (
        symbol TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    ensureColumn(this.db, "orders", "bot_tag", "TEXT");
    ensureColumn(this.db, "orders", "last_seen_status", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.db, "order_history", "bot_tag", "TEXT");
    ensureColumn(this.db, "bot_status", "market_spread_bps", "REAL");
    ensureColumn(this.db, "bot_status", "vol_move_bps", "REAL");
    ensureColumn(this.db, "bot_status", "trend_move_bps", "REAL");
    ensureColumn(this.db, "bot_status", "spread_mult", "REAL");
    ensureColumn(this.db, "bot_status", "inventory_ratio", "REAL");
    ensureColumn(this.db, "bot_status", "skew_bps_applied", "REAL");
    ensureColumn(this.db, "bot_status", "fills_30m", "INTEGER");
    ensureColumn(this.db, "bot_status", "fills_1h", "INTEGER");
    ensureColumn(this.db, "bot_status", "avg_edge_buy_1h", "REAL");
    ensureColumn(this.db, "bot_status", "avg_edge_sell_1h", "REAL");
    ensureColumn(this.db, "bot_status", "cancels_1h", "INTEGER");
    ensureColumn(this.db, "bot_status", "rejects_1h", "INTEGER");
    ensureColumn(this.db, "bot_status", "adaptive_spread_bps_delta", "REAL");
    ensureColumn(this.db, "bot_status", "churn_warning", "INTEGER");
    ensureColumn(this.db, "bot_status", "action_budget_used", "INTEGER");
    ensureColumn(this.db, "bot_status", "action_budget_max", "INTEGER");
    ensureColumn(this.db, "bot_status", "adaptive_reasons", "TEXT");
    ensureColumn(this.db, "bot_status", "tob_mode", "TEXT");
    ensureColumn(this.db, "bot_status", "tob_reason", "TEXT");
    ensureColumn(this.db, "bot_status", "sell_throttle_state", "TEXT");
    ensureColumn(this.db, "bot_status", "quoting_json", "TEXT");
    ensureColumn(this.db, "bot_status", "quoting_inputs_json", "TEXT");
    ensureColumn(this.db, "fills", "mid_at_fill", "REAL");
    ensureColumn(this.db, "fills", "edge_bps", "REAL");
    ensureColumn(this.db, "bot_events", "details_json", "TEXT");
  }

  close(): void {
    this.db.close();
  }

  upsertOrder(order: OrderUpsert): void {
    const now = Date.now();
    const createdAt = order.created_at ?? now;
    const updatedAt = order.updated_at ?? now;
    const status = normalizeStatus(order.status);
    const lastSeenStatus = normalizeStatus(order.last_seen_status ?? status);

    this.db
      .prepare(
        `
        INSERT INTO orders (
          client_order_id,
          venue_order_id,
          bot_tag,
          symbol,
          side,
          price,
          quote_size,
          status,
          last_seen_status,
          is_bot,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_order_id) DO UPDATE SET
          venue_order_id = COALESCE(excluded.venue_order_id, orders.venue_order_id),
          bot_tag = COALESCE(excluded.bot_tag, orders.bot_tag),
          symbol = excluded.symbol,
          side = excluded.side,
          price = excluded.price,
          quote_size = excluded.quote_size,
          status = excluded.status,
          last_seen_status = excluded.last_seen_status,
          is_bot = excluded.is_bot,
          updated_at = excluded.updated_at
      `
      )
      .run(
        order.client_order_id,
        order.venue_order_id ?? null,
        order.bot_tag ?? null,
        order.symbol,
        order.side,
        order.price,
        order.quote_size,
        status,
        lastSeenStatus,
        order.is_bot,
        createdAt,
        updatedAt
      );

    this.appendOrderHistory({
      client_order_id: order.client_order_id,
      venue_order_id: order.venue_order_id ?? null,
      bot_tag: order.bot_tag ?? null,
      symbol: order.symbol,
      side: order.side,
      price: order.price,
      quote_size: order.quote_size,
      status,
      is_bot: order.is_bot,
      ts: updatedAt
    });
  }

  updateOrderStatusByVenueId(venueOrderId: string, status: string, updatedAt = Date.now()): void {
    const normalized = normalizeStatus(status);

    this.db
      .prepare(
        `
        UPDATE orders
           SET status = ?, last_seen_status = ?, updated_at = ?
         WHERE venue_order_id = ?
      `
      )
      .run(normalized, normalized, updatedAt, venueOrderId);

    const row = this.getOrderByVenueId(venueOrderId);
    if (!row) return;

    this.appendOrderHistory({
      client_order_id: row.client_order_id,
      venue_order_id: row.venue_order_id,
      bot_tag: row.bot_tag ?? null,
      symbol: row.symbol,
      side: row.side,
      price: row.price,
      quote_size: row.quote_size,
      status: normalized,
      is_bot: row.is_bot,
      ts: updatedAt
    });
  }

  getActiveBotOrders(symbol?: string): OrderRecord[] {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
    if (symbol) {
      return this.db
        .prepare(
          `
          SELECT *
           FROM orders
           WHERE is_bot = 1
             AND symbol = ?
             AND venue_order_id IS NOT NULL
             AND TRIM(venue_order_id) <> ''
             AND status IN (${placeholders})
           ORDER BY updated_at DESC
        `
        )
        .all(symbol, ...ACTIVE_STATUSES) as OrderRecord[];
    }

    return this.db
      .prepare(
        `
        SELECT *
          FROM orders
         WHERE is_bot = 1
           AND venue_order_id IS NOT NULL
           AND TRIM(venue_order_id) <> ''
           AND status IN (${placeholders})
         ORDER BY updated_at DESC
      `
      )
      .all(...ACTIVE_STATUSES) as OrderRecord[];
  }

  getActiveOrders(symbol?: string): OrderRecord[] {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
    if (symbol) {
      return this.db
        .prepare(
          `
          SELECT *
            FROM orders
           WHERE symbol = ?
             AND status IN (${placeholders})
           ORDER BY updated_at DESC
        `
        )
        .all(symbol, ...ACTIVE_STATUSES) as OrderRecord[];
    }

    return this.db
      .prepare(
        `
        SELECT *
          FROM orders
         WHERE status IN (${placeholders})
         ORDER BY updated_at DESC
      `
      )
      .all(...ACTIVE_STATUSES) as OrderRecord[];
  }

  getOrderByVenueId(venueOrderId: string): OrderRecord | null {
    const row = this.db
      .prepare(
        `
        SELECT *
          FROM orders
         WHERE venue_order_id = ?
      `
      )
      .get(venueOrderId) as OrderRecord | undefined;
    return row ?? null;
  }

  getOrderByClientId(clientOrderId: string): OrderRecord | null {
    const row = this.db
      .prepare(
        `
        SELECT *
          FROM orders
         WHERE client_order_id = ?
      `
      )
      .get(clientOrderId) as OrderRecord | undefined;
    return row ?? null;
  }

  getBotOrdersByTag(tag: string): OrderRecord[] {
    return this.db
      .prepare(
        `
        SELECT *
          FROM orders
         WHERE is_bot = 1
           AND bot_tag = ?
         ORDER BY updated_at DESC
      `
      )
      .all(tag) as OrderRecord[];
  }

  getRecentBotOrders(limit: number): OrderRecord[] {
    return this.db
      .prepare(
        `
        SELECT *
          FROM orders
         WHERE is_bot = 1
         ORDER BY updated_at DESC
         LIMIT ?
      `
      )
      .all(limit) as OrderRecord[];
  }

  getRecentBotOrderHistory(limit: number): OrderHistoryRecord[] {
    return this.db
      .prepare(
        `
        SELECT client_order_id, venue_order_id, bot_tag, symbol, side, price, quote_size, status, is_bot, ts
          FROM order_history
         WHERE is_bot = 1
         ORDER BY ts DESC
         LIMIT ?
      `
      )
      .all(limit) as OrderHistoryRecord[];
  }

  upsertBotStatus(status: BotStatus): void {
    this.db
      .prepare(
        `
        INSERT INTO bot_status (
          id,
          ts,
          mid,
          exposure_usd,
          market_spread_bps,
          vol_move_bps,
          trend_move_bps,
          spread_mult,
          inventory_ratio,
          skew_bps_applied,
          fills_30m,
          fills_1h,
          avg_edge_buy_1h,
          avg_edge_sell_1h,
          cancels_1h,
          rejects_1h,
          adaptive_spread_bps_delta,
          churn_warning,
          action_budget_used,
          action_budget_max,
          adaptive_reasons,
          tob_mode,
          tob_reason,
          sell_throttle_state,
          quoting_json,
          quoting_inputs_json,
          allow_buy,
          allow_sell,
          buy_reasons,
          sell_reasons
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          ts = excluded.ts,
          mid = excluded.mid,
          exposure_usd = excluded.exposure_usd,
          market_spread_bps = excluded.market_spread_bps,
          vol_move_bps = excluded.vol_move_bps,
          trend_move_bps = excluded.trend_move_bps,
          spread_mult = excluded.spread_mult,
          inventory_ratio = excluded.inventory_ratio,
          skew_bps_applied = excluded.skew_bps_applied,
          fills_30m = excluded.fills_30m,
          fills_1h = excluded.fills_1h,
          avg_edge_buy_1h = excluded.avg_edge_buy_1h,
          avg_edge_sell_1h = excluded.avg_edge_sell_1h,
          cancels_1h = excluded.cancels_1h,
          rejects_1h = excluded.rejects_1h,
          adaptive_spread_bps_delta = excluded.adaptive_spread_bps_delta,
          churn_warning = excluded.churn_warning,
          action_budget_used = excluded.action_budget_used,
          action_budget_max = excluded.action_budget_max,
          adaptive_reasons = excluded.adaptive_reasons,
          tob_mode = excluded.tob_mode,
          tob_reason = excluded.tob_reason,
          sell_throttle_state = excluded.sell_throttle_state,
          quoting_json = excluded.quoting_json,
          quoting_inputs_json = excluded.quoting_inputs_json,
          allow_buy = excluded.allow_buy,
          allow_sell = excluded.allow_sell,
          buy_reasons = excluded.buy_reasons,
          sell_reasons = excluded.sell_reasons
      `
      )
      .run(
        status.ts,
        status.mid,
        status.exposure_usd,
        status.market_spread_bps ?? null,
        status.vol_move_bps ?? null,
        status.trend_move_bps ?? null,
        status.spread_mult ?? null,
        status.inventory_ratio ?? null,
        status.skew_bps_applied ?? null,
        status.fills_30m ?? null,
        status.fills_1h ?? null,
        status.avg_edge_buy_1h ?? null,
        status.avg_edge_sell_1h ?? null,
        status.cancels_1h ?? null,
        status.rejects_1h ?? null,
        status.adaptive_spread_bps_delta ?? null,
        status.churn_warning === undefined ? null : status.churn_warning ? 1 : 0,
        status.action_budget_used ?? null,
        status.action_budget_max ?? null,
        status.adaptive_reasons ? JSON.stringify(status.adaptive_reasons) : null,
        status.tob_mode ?? null,
        status.tob_reason ?? null,
        status.sell_throttle_state ?? null,
        status.quoting ? JSON.stringify(status.quoting) : null,
        status.quoting_inputs ? JSON.stringify(status.quoting_inputs) : null,
        status.allow_buy ? 1 : 0,
        status.allow_sell ? 1 : 0,
        JSON.stringify(status.buy_reasons),
        JSON.stringify(status.sell_reasons)
      );
  }

  getBotStatus(): BotStatus | null {
    const row = this.db
      .prepare(
        `
        SELECT ts, mid, exposure_usd, market_spread_bps, vol_move_bps, trend_move_bps,
               spread_mult, inventory_ratio, skew_bps_applied,
               fills_30m, fills_1h, avg_edge_buy_1h, avg_edge_sell_1h, cancels_1h, rejects_1h,
               adaptive_spread_bps_delta, churn_warning, action_budget_used, action_budget_max, adaptive_reasons,
               tob_mode, tob_reason, sell_throttle_state, quoting_json, quoting_inputs_json,
               allow_buy, allow_sell, buy_reasons, sell_reasons
          FROM bot_status
         WHERE id = 1
      `
      )
      .get() as
      | {
          ts: number;
          mid: number;
          exposure_usd: number;
          market_spread_bps: number | null;
          vol_move_bps: number | null;
          trend_move_bps: number | null;
          spread_mult: number | null;
          inventory_ratio: number | null;
          skew_bps_applied: number | null;
          fills_30m: number | null;
          fills_1h: number | null;
          avg_edge_buy_1h: number | null;
          avg_edge_sell_1h: number | null;
          cancels_1h: number | null;
          rejects_1h: number | null;
          adaptive_spread_bps_delta: number | null;
          churn_warning: number | null;
          action_budget_used: number | null;
          action_budget_max: number | null;
          adaptive_reasons: string | null;
          tob_mode: string | null;
          tob_reason: string | null;
          sell_throttle_state: string | null;
          quoting_json: string | null;
          quoting_inputs_json: string | null;
          allow_buy: number;
          allow_sell: number;
          buy_reasons: string;
          sell_reasons: string;
        }
      | undefined;

    if (!row) return null;
    const status: BotStatus = {
      ts: row.ts,
      mid: row.mid,
      exposure_usd: row.exposure_usd,
      market_spread_bps: row.market_spread_bps ?? undefined,
      vol_move_bps: row.vol_move_bps ?? undefined,
      trend_move_bps: row.trend_move_bps ?? undefined,
      spread_mult: row.spread_mult ?? undefined,
      inventory_ratio: row.inventory_ratio ?? undefined,
      skew_bps_applied: row.skew_bps_applied ?? undefined,
      fills_30m: row.fills_30m ?? undefined,
      fills_1h: row.fills_1h ?? undefined,
      avg_edge_buy_1h: row.avg_edge_buy_1h ?? undefined,
      avg_edge_sell_1h: row.avg_edge_sell_1h ?? undefined,
      cancels_1h: row.cancels_1h ?? undefined,
      rejects_1h: row.rejects_1h ?? undefined,
      adaptive_spread_bps_delta: row.adaptive_spread_bps_delta ?? undefined,
      churn_warning: row.churn_warning === null ? undefined : row.churn_warning === 1,
      action_budget_used: row.action_budget_used ?? undefined,
      action_budget_max: row.action_budget_max ?? undefined,
      adaptive_reasons: row.adaptive_reasons ? tryParseStringArray(row.adaptive_reasons) : undefined,
      tob_mode: row.tob_mode ?? undefined,
      tob_reason: row.tob_reason ?? undefined,
      sell_throttle_state: row.sell_throttle_state ?? undefined,
      quoting: row.quoting_json ? tryParseQuotedPlan(row.quoting_json) : undefined,
      quoting_inputs: row.quoting_inputs_json ? tryParseQuotedInputs(row.quoting_inputs_json) : undefined,
      allow_buy: row.allow_buy === 1,
      allow_sell: row.allow_sell === 1,
      buy_reasons: tryParseStringArray(row.buy_reasons),
      sell_reasons: tryParseStringArray(row.sell_reasons)
    };
    const normalized = normalizeLegacyPauseFileBotStatus(status);
    if (normalized && normalized !== status) {
      this.upsertBotStatus(normalized);
      return normalized;
    }
    return status;
  }

  upsertReconcilerState(state: ReconcilerState): void {
    this.db
      .prepare(
        `
        INSERT INTO reconciler_state (
          id,
          ts,
          usd_free,
          usd_total,
          btc_free,
          btc_total,
          snapshot_ts,
          active_orders_by_tag,
          last_fill_ts
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          ts = excluded.ts,
          usd_free = excluded.usd_free,
          usd_total = excluded.usd_total,
          btc_free = excluded.btc_free,
          btc_total = excluded.btc_total,
          snapshot_ts = excluded.snapshot_ts,
          active_orders_by_tag = excluded.active_orders_by_tag,
          last_fill_ts = excluded.last_fill_ts
      `
      )
      .run(
        state.ts,
        state.balances.usd_free,
        state.balances.usd_total,
        state.balances.btc_free,
        state.balances.btc_total,
        state.balances.snapshot_ts,
        JSON.stringify(state.activeOrdersByTag),
        state.lastFillTs ?? null
      );
  }

  getReconcilerState(): ReconcilerState | null {
    const row = this.db
      .prepare(
        `
        SELECT ts, usd_free, usd_total, btc_free, btc_total, snapshot_ts, active_orders_by_tag, last_fill_ts
          FROM reconciler_state
         WHERE id = 1
      `
      )
      .get() as
      | {
          ts: number;
          usd_free: number;
          usd_total: number;
          btc_free: number;
          btc_total: number;
          snapshot_ts: number;
          active_orders_by_tag: string;
          last_fill_ts: number | null;
        }
      | undefined;

    if (!row) return null;
    return {
      ts: row.ts,
      balances: {
        usd_free: row.usd_free,
        usd_total: row.usd_total,
        btc_free: row.btc_free,
        btc_total: row.btc_total,
        snapshot_ts: row.snapshot_ts
      },
      activeOrdersByTag: tryParseOrderMap(row.active_orders_by_tag),
      lastFillTs: row.last_fill_ts ?? null
    };
  }

  upsertFill(fill: FillRecord): boolean {
    const result = this.db
      .prepare(
        `
        INSERT INTO fills (venue_order_id, trade_id, qty, price, fee, mid_at_fill, edge_bps, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(venue_order_id, trade_id) DO NOTHING
      `
      )
      .run(
        fill.venue_order_id,
        fill.trade_id,
        fill.qty,
        fill.price,
        fill.fee,
        fill.mid_at_fill ?? null,
        fill.edge_bps ?? null,
        fill.ts
      );
    return result.changes > 0;
  }

  getRecentFills(limit: number): FillRecord[] {
    return this.db
      .prepare(
        `
        SELECT *
          FROM fills
         ORDER BY ts DESC
         LIMIT ?
      `
      )
      .all(limit) as FillRecord[];
  }

  getFillsSince(ts: number): FillRecord[] {
    return this.db
      .prepare(
        `
        SELECT *
          FROM fills
         WHERE ts >= ?
         ORDER BY ts ASC
      `
      )
      .all(ts) as FillRecord[];
  }

  insertBalanceSnapshots(snapshots: BalanceSnapshot[]): void {
    const insert = this.db.prepare(
      `
      INSERT OR REPLACE INTO balances (asset, free, total, ts)
      VALUES (?, ?, ?, ?)
    `
    );

    const tx = this.db.transaction((rows: BalanceSnapshot[]) => {
      for (const row of rows) {
        insert.run(row.asset, row.free, row.total, row.ts);
      }
    });

    tx(snapshots);
  }

  getLatestBalances(): BalanceSnapshot[] {
    return this.db
      .prepare(
        `
        SELECT b.asset, b.free, b.total, b.ts
          FROM balances b
          JOIN (
            SELECT asset, MAX(ts) AS max_ts
              FROM balances
             GROUP BY asset
          ) latest
            ON latest.asset = b.asset
           AND latest.max_ts = b.ts
         ORDER BY b.asset ASC
      `
      )
      .all() as BalanceSnapshot[];
  }

  getRecentBalanceSnapshots(limitTimestamps: number): BalanceSnapshot[] {
    return this.db
      .prepare(
        `
        SELECT b.asset, b.free, b.total, b.ts
          FROM balances b
          JOIN (
            SELECT DISTINCT ts
              FROM balances
             ORDER BY ts DESC
             LIMIT ?
          ) recent
            ON recent.ts = b.ts
         ORDER BY b.ts ASC, b.asset ASC
      `
      )
      .all(limitTimestamps) as BalanceSnapshot[];
  }

  recordMidSnapshot(snapshot: TickerSnapshot): void {
    this.insertTickerSnapshot(snapshot);
  }

  insertTickerSnapshot(snapshot: TickerSnapshot): void {
    this.db
      .prepare(
        `
        INSERT INTO ticker_snapshots (symbol, bid, ask, mid, last, ts)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      )
      .run(snapshot.symbol, snapshot.bid, snapshot.ask, snapshot.mid, snapshot.last, snapshot.ts);
  }

  getRecentTickerSnapshots(symbol: string, limit: number): TickerSnapshot[] {
    return this.db
      .prepare(
        `
        SELECT symbol, bid, ask, mid, last, ts
          FROM ticker_snapshots
         WHERE symbol = ?
         ORDER BY ts DESC
         LIMIT ?
      `
      )
      .all(symbol, limit) as TickerSnapshot[];
  }

  recordExternalPriceSnapshot(snapshot: ExternalVenueSnapshot): void {
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO external_price_snapshots (
          symbol, venue, quote, ts, bid, ask, mid, spread_bps, latency_ms, ok, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        snapshot.symbol,
        snapshot.venue,
        snapshot.quote,
        snapshot.ts,
        snapshot.bid,
        snapshot.ask,
        snapshot.mid,
        snapshot.spread_bps,
        Math.max(0, Math.round(snapshot.latency_ms)),
        snapshot.ok ? 1 : 0,
        snapshot.error ?? null
      );
    this.db
      .prepare(
        `
        DELETE FROM external_price_snapshots
         WHERE rowid IN (
           SELECT rowid
             FROM external_price_snapshots
            ORDER BY ts DESC
            LIMIT -1 OFFSET ?
         )
      `
      )
      .run(MAX_EXTERNAL_SNAPSHOTS);
  }

  recordSignalSnapshot(snapshot: SignalSnapshot): void {
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO signal_snapshots (
          symbol, ts, revx_mid, global_mid, fair_mid, basis_bps, drift_bps, stdev_bps, z_score,
          confidence, dispersion_bps, vol_regime, drift_component_bps, basis_correction_bps,
          healthy_venues, total_venues
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        snapshot.symbol,
        snapshot.ts,
        snapshot.revx_mid,
        snapshot.global_mid,
        snapshot.fair_mid,
        snapshot.basis_bps,
        snapshot.drift_bps,
        snapshot.stdev_bps,
        snapshot.z_score,
        snapshot.confidence,
        snapshot.dispersion_bps,
        snapshot.vol_regime,
        snapshot.drift_component_bps,
        snapshot.basis_correction_bps,
        snapshot.healthy_venues,
        snapshot.total_venues
      );
    this.db
      .prepare(
        `
        DELETE FROM signal_snapshots
         WHERE rowid IN (
           SELECT rowid
             FROM signal_snapshots
            ORDER BY ts DESC
            LIMIT -1 OFFSET ?
         )
      `
      )
      .run(MAX_SIGNAL_SNAPSHOTS);
  }

  getRecentExternalPriceSnapshots(symbol: string, limit: number): ExternalVenueSnapshot[] {
    const rows = this.db
      .prepare(
        `
        SELECT symbol, venue, quote, ts, bid, ask, mid, spread_bps, latency_ms, ok, error
          FROM external_price_snapshots
         WHERE symbol = ?
         ORDER BY ts DESC
         LIMIT ?
      `
      )
      .all(symbol, limit) as Array<
      Omit<ExternalVenueSnapshot, "ok"> & { ok: number }
    >;
    return rows.map((row) => ({
      ...row,
      ok: row.ok === 1
    }));
  }

  getLatestVenueQuotes(symbol: string): VenueQuote[] {
    const rows = this.db
      .prepare(
        `
        SELECT eps.venue, eps.bid, eps.ask, eps.mid, eps.ts, eps.error
          FROM external_price_snapshots eps
          JOIN (
            SELECT venue, MAX(ts) AS max_ts
              FROM external_price_snapshots
             WHERE symbol = ?
             GROUP BY venue
          ) latest
            ON latest.venue = eps.venue
           AND latest.max_ts = eps.ts
         WHERE eps.symbol = ?
         ORDER BY eps.venue ASC
      `
      )
      .all(symbol, symbol) as Array<{
      venue: string;
      bid: number | null;
      ask: number | null;
      mid: number | null;
      ts: number;
      error?: string | null;
    }>;
    return rows.map((row) => ({
      venue: row.venue,
      bid: row.bid ?? null,
      ask: row.ask ?? null,
      mid: row.mid ?? null,
      ts: row.ts,
      error: row.error ?? null
    }));
  }

  getRecentSignalSnapshots(symbol: string, limit: number): SignalSnapshot[] {
    return this.db
      .prepare(
        `
        SELECT
          symbol, ts, revx_mid, global_mid, fair_mid, basis_bps, drift_bps, stdev_bps, z_score,
          confidence, dispersion_bps, vol_regime, drift_component_bps, basis_correction_bps,
          healthy_venues, total_venues
        FROM signal_snapshots
        WHERE symbol = ?
        ORDER BY ts DESC
        LIMIT ?
      `
      )
      .all(symbol, limit) as SignalSnapshot[];
  }

  recordStrategyDecision(decision: StrategyDecision): void {
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO strategy_decisions (ts, mid, spread_mult, inventory_ratio, details_json)
        VALUES (?, ?, ?, ?, ?)
      `
      )
      .run(
        decision.ts,
        decision.mid,
        decision.spread_mult,
        decision.inventory_ratio,
        decision.details_json
      );
  }

  getRecentStrategyDecisions(limit: number): StrategyDecision[] {
    return this.db
      .prepare(
        `
        SELECT ts, mid, spread_mult, inventory_ratio, details_json
          FROM strategy_decisions
         ORDER BY ts DESC
         LIMIT ?
      `
      )
      .all(limit) as StrategyDecision[];
  }

  recordMetric(metric: MetricRecord): void {
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO metrics (ts, key, value)
        VALUES (?, ?, ?)
      `
      )
      .run(metric.ts, metric.key, metric.value);
  }

  getMetrics(key: string, sinceTs: number, limit: number): MetricRecord[] {
    return this.db
      .prepare(
        `
        SELECT ts, key, value
          FROM metrics
         WHERE key = ?
           AND ts >= ?
         ORDER BY ts DESC
         LIMIT ?
      `
      )
      .all(key, sinceTs, limit) as MetricRecord[];
  }

  recordBotEvent(event: BotEvent): void {
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO bot_events (
          event_id, ts, type, side, price, quote_size_usd, venue_order_id, client_order_id, reason, bot_tag, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        event.event_id,
        event.ts,
        event.type,
        event.side,
        event.price,
        event.quote_size_usd,
        event.venue_order_id,
        event.client_order_id,
        event.reason,
        event.bot_tag,
        event.details_json ?? null
      );
  }

  getRecentBotEvents(limit: number): BotEvent[] {
    return this.db
      .prepare(
        `
        SELECT event_id, ts, type, side, price, quote_size_usd, venue_order_id, client_order_id, reason, bot_tag, details_json
          FROM bot_events
         ORDER BY ts DESC
         LIMIT ?
      `
      )
      .all(limit) as BotEvent[];
  }

  getRollingMetrics(nowTs: number): RollingMetrics {
    const oneHourAgo = nowTs - 60 * 60 * 1000;
    const thirtyMinutesAgo = nowTs - 30 * 60 * 1000;
    const todayStart = dayStartTs(nowTs);

    const fills1h = this.getFillsSince(oneHourAgo);
    const fills30m = this.getFillsSince(thirtyMinutesAgo);
    const events1h = this.getRecentBotEvents(20_000).filter((row) => row.ts >= oneHourAgo);
    const resting1h = this.getMetrics("resting_time_seconds", oneHourAgo, 20_000);

    let buyEdgeSum = 0;
    let buyEdgeCount = 0;
    let sellEdgeSum = 0;
    let sellEdgeCount = 0;
    for (const fill of fills1h) {
      if (!Number.isFinite(fill.edge_bps ?? Number.NaN)) continue;
      const side = this.getOrderByVenueId(fill.venue_order_id)?.side;
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

    const latestPnlMetric = this.getMetrics("realized_pnl_usd", 0, 1)[0];
    const startDayPnlMetric = this.getMetrics("realized_pnl_usd", todayStart, 10_000).at(-1);
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
        resting1h.length > 0 ? resting1h.reduce((sum, row) => sum + row.value, 0) / resting1h.length : 0,
      realized_pnl_today_usd: realizedPnlToday
    };
  }

  getRuntimeOverrides(symbol: string): RuntimeOverridesRecord | null {
    const key = normalizeSymbol(symbol);
    const row = this.db
      .prepare(
        `
        SELECT json
          FROM runtime_overrides
         WHERE symbol = ?
      `
      )
      .get(key) as { json: string } | undefined;
    if (!row) return null;
    const parsed = tryParseRuntimeOverrides(row.json);
    if (!parsed) return null;
    if (!isRuntimeOverrideExpired(parsed)) {
      return parsed;
    }

    this.db.prepare(`DELETE FROM runtime_overrides WHERE symbol = ?`).run(key);
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
        expired_at_ms: parsed.expiresAtMs,
        updated_at_ms: parsed.updatedAtMs
      })
    });
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
      { usdTotal: latestAssetTotal(this.getLatestBalances(), "USD") }
    );
    this.db
      .prepare(
        `
        INSERT INTO runtime_overrides (symbol, json, updated_at, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET
          json = excluded.json,
          updated_at = excluded.updated_at,
          created_at = excluded.created_at
      `
      )
      .run(
        key,
        JSON.stringify(result.overrides),
        result.overrides.updatedAtMs,
        result.overrides.createdAtMs
      );
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
    return result.overrides;
  }

  clearRuntimeOverrides(symbol: string, meta?: RuntimeOverridesMeta): void {
    const key = normalizeSymbol(symbol);
    const existing = this.getRuntimeOverrides(key);
    if (!existing) return;
    this.db.prepare(`DELETE FROM runtime_overrides WHERE symbol = ?`).run(key);
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
  }

  getEffectiveConfig(symbol: string, context?: RuntimeOverrideContext): EffectiveRuntimeConfig {
    const key = normalizeSymbol(symbol);
    const effective = computeEffectiveRuntimeConfig(this.runtimeDefaults, this.getRuntimeOverrides(key));
    const usdTotal = context?.usdTotal ?? latestAssetTotal(this.getLatestBalances(), "USD");
    if (Number.isFinite(usdTotal ?? Number.NaN) && effective.cashReserveUsd > Number(usdTotal)) {
      effective.cashReserveUsd = Math.max(0, Number(usdTotal));
    }
    return effective;
  }

  private appendOrderHistory(row: OrderHistoryRecord): void {
    this.db
      .prepare(
        `
        INSERT INTO order_history (
          client_order_id,
          venue_order_id,
          bot_tag,
          symbol,
          side,
          price,
          quote_size,
          status,
          is_bot,
          ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        row.client_order_id,
        row.venue_order_id,
        row.bot_tag ?? null,
        row.symbol,
        row.side,
        row.price,
        row.quote_size,
        normalizeStatus(row.status),
        row.is_bot,
        row.ts
      );
  }
}

function normalizeStatus(value: string): string {
  return value.trim().toUpperCase();
}

function tryParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function tryParseOrderMap(raw: string): Record<string, OrderRecord> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, OrderRecord>;
  } catch {
    return {};
  }
}

function tryParseQuotedPlan(raw: string): BotStatus["quoting"] | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const row = parsed as Record<string, unknown>;
    const tob = String(row.tobPlanned ?? "").toUpperCase();
    if (tob !== "OFF" && tob !== "BUY" && tob !== "SELL" && tob !== "BOTH") return undefined;
    return {
      pausePolicy:
        row.pausePolicy && typeof row.pausePolicy === "object"
          ? (row.pausePolicy as NonNullable<BotStatus["quoting"]>["pausePolicy"])
          : undefined,
      quoteEnabled: Boolean(row.quoteEnabled),
      hardHalt: Boolean(row.hardHalt),
      hardHaltReasons: Array.isArray(row.hardHaltReasons)
        ? row.hardHaltReasons.filter((x): x is string => typeof x === "string")
        : [],
      quoteBlockedReasons: Array.isArray(row.quoteBlockedReasons)
        ? row.quoteBlockedReasons.filter((x): x is string => typeof x === "string")
        : [],
      buyLevelsPlanned: Number.isFinite(Number(row.buyLevelsPlanned))
        ? Math.max(0, Math.floor(Number(row.buyLevelsPlanned)))
        : 0,
      sellLevelsPlanned: Number.isFinite(Number(row.sellLevelsPlanned))
        ? Math.max(0, Math.floor(Number(row.sellLevelsPlanned)))
        : 0,
      tobPlanned: tob,
      effectiveTargetLevels:
        row.effectiveTargetLevels && typeof row.effectiveTargetLevels === "object"
          ? (row.effectiveTargetLevels as NonNullable<BotStatus["quoting"]>["effectiveTargetLevels"])
          : undefined,
      targetLevels:
        row.targetLevels && typeof row.targetLevels === "object"
          ? (row.targetLevels as NonNullable<BotStatus["quoting"]>["targetLevels"])
          : undefined,
      minLevelsFloorApplied: row.minLevelsFloorApplied === true,
      tobPolicy:
        row.tobPolicy === "JOIN" ||
        row.tobPolicy === "JOIN+1" ||
        row.tobPolicy === "JOIN+2" ||
        row.tobPolicy === "OFF"
          ? row.tobPolicy
          : undefined,
      appliedSpreadMult: Number.isFinite(Number(row.appliedSpreadMult))
        ? Number(row.appliedSpreadMult)
        : undefined,
      appliedSizeMult: Number.isFinite(Number(row.appliedSizeMult))
        ? Number(row.appliedSizeMult)
        : undefined,
      lowVolMode:
        row.lowVolMode === "KEEP_QUOTING"
          ? "KEEP_QUOTING"
          : undefined,
      volMoveBps: Number.isFinite(Number(row.volMoveBps))
        ? Number(row.volMoveBps)
        : undefined,
      minVolMoveBps: Number.isFinite(Number(row.minVolMoveBps))
        ? Number(row.minVolMoveBps)
        : undefined,
      whyNotQuoting:
        typeof row.whyNotQuoting === "string" && row.whyNotQuoting.trim().length > 0
          ? row.whyNotQuoting
          : undefined,
      whyNotQuotingDetails:
        typeof row.whyNotQuotingDetails === "string" && row.whyNotQuotingDetails.trim().length > 0
          ? row.whyNotQuotingDetails
          : undefined,
      lastPlannerOutputSummary:
        row.lastPlannerOutputSummary && typeof row.lastPlannerOutputSummary === "object"
          ? {
              desiredCount: Number.isFinite(Number((row.lastPlannerOutputSummary as Record<string, unknown>).desiredCount))
                ? Math.max(0, Math.floor(Number((row.lastPlannerOutputSummary as Record<string, unknown>).desiredCount)))
                : 0,
              buyLevels: Number.isFinite(Number((row.lastPlannerOutputSummary as Record<string, unknown>).buyLevels))
                ? Math.max(0, Math.floor(Number((row.lastPlannerOutputSummary as Record<string, unknown>).buyLevels)))
                : 0,
              sellLevels: Number.isFinite(Number((row.lastPlannerOutputSummary as Record<string, unknown>).sellLevels))
                ? Math.max(0, Math.floor(Number((row.lastPlannerOutputSummary as Record<string, unknown>).sellLevels)))
                : 0,
              tob:
                (row.lastPlannerOutputSummary as Record<string, unknown>).tob === "BUY" ||
                (row.lastPlannerOutputSummary as Record<string, unknown>).tob === "SELL" ||
                (row.lastPlannerOutputSummary as Record<string, unknown>).tob === "BOTH"
                  ? ((row.lastPlannerOutputSummary as Record<string, unknown>).tob as "BUY" | "SELL" | "BOTH")
                  : "OFF",
              actionBudget: Number.isFinite(Number((row.lastPlannerOutputSummary as Record<string, unknown>).actionBudget))
                ? Math.max(0, Math.floor(Number((row.lastPlannerOutputSummary as Record<string, unknown>).actionBudget)))
                : 0,
              actionsUsed: Number.isFinite(Number((row.lastPlannerOutputSummary as Record<string, unknown>).actionsUsed))
                ? Math.max(0, Math.floor(Number((row.lastPlannerOutputSummary as Record<string, unknown>).actionsUsed)))
                : 0,
              openBuyVenue: Number.isFinite(Number((row.lastPlannerOutputSummary as Record<string, unknown>).openBuyVenue))
                ? Math.max(0, Math.floor(Number((row.lastPlannerOutputSummary as Record<string, unknown>).openBuyVenue)))
                : 0,
              openSellVenue: Number.isFinite(Number((row.lastPlannerOutputSummary as Record<string, unknown>).openSellVenue))
                ? Math.max(0, Math.floor(Number((row.lastPlannerOutputSummary as Record<string, unknown>).openSellVenue)))
                : 0
            }
          : undefined,
      forceBaselineApplied: row.forceBaselineApplied === true,
      overrideApplied: row.overrideApplied === true,
      overrideReasons: Array.isArray(row.overrideReasons)
        ? row.overrideReasons.filter((x): x is string => typeof x === "string")
        : undefined,
      lastDecisionTs: Number.isFinite(Number(row.lastDecisionTs))
        ? Math.max(0, Math.floor(Number(row.lastDecisionTs)))
        : 0
    };
  } catch {
    return undefined;
  }
}

function tryParseQuotedInputs(raw: string): BotStatus["quoting_inputs"] | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const row = parsed as Record<string, unknown>;
    const thresholds =
      row.thresholds && typeof row.thresholds === "object"
        ? (row.thresholds as Record<string, unknown>)
        : {};
    const mode =
      String(thresholds.volProtectMode ?? "").toLowerCase() === "block" ? "block" : "widen";
    return {
      volMoveBps: Number.isFinite(Number(row.volMoveBps)) ? Number(row.volMoveBps) : 0,
      marketSpreadBps: Number.isFinite(Number(row.marketSpreadBps)) ? Number(row.marketSpreadBps) : 0,
      usd_free: Number.isFinite(Number(row.usd_free)) ? Number(row.usd_free) : 0,
      btcNotional: Number.isFinite(Number(row.btcNotional)) ? Number(row.btcNotional) : 0,
      trendMoveBps: Number.isFinite(Number(row.trendMoveBps)) ? Number(row.trendMoveBps) : 0,
      thresholds: {
        minVolMoveBpsToQuote: Number.isFinite(Number(thresholds.minVolMoveBpsToQuote))
          ? Number(thresholds.minVolMoveBpsToQuote)
          : 0,
        minMarketSpreadBps: Number.isFinite(Number(thresholds.minMarketSpreadBps))
          ? Number(thresholds.minMarketSpreadBps)
          : 0,
        trendPauseBps: Number.isFinite(Number(thresholds.trendPauseBps))
          ? Number(thresholds.trendPauseBps)
          : 0,
        volProtectMode: mode,
        volWidenMultMin: Number.isFinite(Number(thresholds.volWidenMultMin))
          ? Number(thresholds.volWidenMultMin)
          : 1.25,
        volWidenMultMax: Number.isFinite(Number(thresholds.volWidenMultMax))
          ? Number(thresholds.volWidenMultMax)
          : 1.75
      }
    };
  } catch {
    return undefined;
  }
}

function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function dayStartTs(nowTs: number): number {
  const d = new Date(nowTs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace("/", "-");
}

function tryParseRuntimeOverrides(raw: string): RuntimeOverridesRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as RuntimeOverridesRecord;
  } catch {
    return null;
  }
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
