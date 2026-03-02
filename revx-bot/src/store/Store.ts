import {
  EffectiveRuntimeConfig,
  RuntimeOverrideContext,
  RuntimeOverridesInput,
  RuntimeOverridesMeta,
  RuntimeOverridesRecord
} from "../overrides/runtimeOverrides";
import { ExternalVenueSnapshot, SignalSnapshot } from "../signal/types";

export type { ExternalVenueSnapshot, SignalSnapshot };

export type VenueQuote = {
  venue: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  ts: number;
  error?: string | null;
};

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
  seed_start_ts?: number;
  seed_reposts?: number;
  seed_attempts?: number;
  seed_taker_fired?: boolean;
  adverse_selection_avg_bps?: number;
  adverse_selection_bad_rate?: number;
  adverse_selection_last_bps?: number | null;
  adverse_selection_samples?: number;
  adverse_selection_toxic?: boolean;
  adverse_selection_widen_bps?: number;
  adverse_selection_cooldown_seconds?: number;
  news_state?: "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE";
  news_impact?: number;
  news_direction?: "UP" | "DOWN" | "NEUTRAL";
  news_confidence?: number;
  news_last_ts?: number;
  signals_state?: "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE";
  signals_impact?: number;
  signals_direction?: "UP" | "DOWN" | "NEUTRAL";
  signals_confidence?: number;
  signals_last_ts?: number;
  adverse_state?: "NORMAL" | "WIDEN" | "REDUCE" | "PAUSE" | "HEDGE";
  adverse_toxicity_score?: number;
  adverse_spread_mult?: number;
  signal_regime?: "CALM" | "TREND" | "VOLATILE" | "CRISIS";
  signal_bias?: "LONG" | "SHORT" | "NEUTRAL";
  signal_bias_confidence?: number;
  balances?: {
    freeUsd: number;
    freeBtc: number;
    reservedUsd: number;
    reservedBtc: number;
    spendableUsd: number;
    spendableBtc: number;
  };
  shock_state?: "NORMAL" | "SHOCK" | "COOLDOWN" | "REENTRY";
  market_phase?: "SHOCK" | "COOLDOWN" | "STABILIZING" | "RECOVERY";
  shock_reasons?: string[];
  phase_reasons?: string[];
  shock_since_ts?: number;
  phase_since_ts?: number;
  shock_vol_peak_bps?: number;
  inventory_action?: "ACCUMULATE" | "DISTRIBUTE" | "HOLD";
  inventory_bands?: {
    floor: number;
    target: number;
    cap: number;
    hysteresis: number;
  };
  phase_aware_caps?: {
    maxSellUsdPerHour: number;
    seedBuyUsd: number;
  };
  reentry_progress?: {
    btcNotionalUsd: number;
    targetUsd: number;
    seedOrdersPlaced: number;
    lastSeedTs: number;
  };
  error_policy?: {
    recoverableCount5m: number;
    lastRecoverableError: string;
    transientBackoffMs: number;
    hardHalt: boolean;
    hardHaltReason: string;
  };
  quoting?: {
    pausePolicy?: {
      minLevelsFloorEnabled: boolean;
      minLevelsFloor: {
        buy: number;
        sell: number;
      };
      pauseThresholds: {
        impact: number;
        confidence: number;
      };
      persistenceSeconds: number;
    };
    quoteEnabled: boolean;
    hardHalt: boolean;
    hardHaltReasons: string[];
    quoteBlockedReasons: string[];
    buyLevelsPlanned: number;
    sellLevelsPlanned: number;
    tobPlanned: "OFF" | "BUY" | "SELL" | "BOTH";
    effectiveTargetLevels?: {
      buy: number;
      sell: number;
      tob: "OFF" | "BUY" | "SELL" | "BOTH";
    };
    newsState?: "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE";
    newsImpact?: number;
    newsDirection?: "UP" | "DOWN" | "NEUTRAL";
    newsConfidence?: number;
    newsReasons?: string[];
    signalsState?: "NORMAL" | "CAUTION" | "RISK_OFF" | "RISK_ON" | "PAUSE";
    signalsImpact?: number;
    signalsDirection?: "UP" | "DOWN" | "NEUTRAL";
    signalsConfidence?: number;
    signalsReasons?: string[];
    adverseState?: "NORMAL" | "WIDEN" | "REDUCE" | "PAUSE" | "HEDGE";
    toxicityScore?: number;
    adverseReasons?: string[];
    regime?: "CALM" | "TREND" | "VOLATILE" | "CRISIS";
    bias?: "LONG" | "SHORT" | "NEUTRAL";
    biasConfidence?: number;
    signalConfidence?: number;
    globalMid?: number;
    fairMid?: number;
    basisBps?: number;
    dispersionBps?: number;
    targetLevels?: {
      buy: number;
      sell: number;
      tob: "OFF" | "BUY" | "SELL" | "BOTH";
    };
    minLevelsFloorApplied?: boolean;
    tobPolicy?: "JOIN" | "JOIN+1" | "JOIN+2" | "OFF";
    appliedSpreadMult?: number;
    appliedSizeMult?: number;
    makerMinEdgeBps?: number;
    takerMinEdgeBps?: number;
    takerFeeBps?: number;
    slippageBufferBps?: number;
    seeding?: {
      active: boolean;
      mode: "ACCUMULATE_BTC" | "TWO_SIDED" | "REBALANCE";
      btcNotionalUsd: number;
      targetUsd: number;
      lastSeedOrderTs: number;
      reason: string;
    };
    lowVolMode?: "KEEP_QUOTING";
    volMoveBps?: number;
    minVolMoveBps?: number;
    whyNotQuoting?: string;
    whyNotQuotingDetails?: string;
    lastPlannerOutputSummary?: {
      desiredCount: number;
      buyLevels: number;
      sellLevels: number;
      tob: "OFF" | "BUY" | "SELL" | "BOTH";
      usedLevelsBuy?: number;
      usedLevelsSell?: number;
      usedTob?: "OFF" | "BUY" | "SELL" | "BOTH";
      perSideBlockReasons?: {
        buy: string[];
        sell: string[];
      };
      actionBudget: number;
      actionsUsed: number;
      openBuyVenue: number;
      openSellVenue: number;
    };
    forceBaselineApplied?: boolean;
    overrideApplied?: boolean;
    overrideReasons?: string[];
    lastClampEvents?: Array<{
      ts: number;
      side: Side;
      tag: string;
      reason: string;
      beforeQuoteUsd: number;
      afterQuoteUsd: number;
      beforeBaseQtyBtc: number;
      afterBaseQtyBtc: number;
      details: string;
    }>;
    clampCounters?: Record<string, number>;
    cancelReasonCounts?: Record<string, number>;
    lastCancelReason?: string | null;
    cycleActions?: {
      placed: number;
      cancelled: number;
      kept: number;
      refreshSkipped?: boolean;
      refreshSkipReason?: string;
    };
    lastDecisionTs: number;
    shockState?: "NORMAL" | "SHOCK" | "COOLDOWN" | "REENTRY";
    marketPhase?: "SHOCK" | "COOLDOWN" | "STABILIZING" | "RECOVERY";
    shockReasons?: string[];
    phaseReasons?: string[];
    shockSinceTs?: number;
    phaseSinceTs?: number;
    shockVolPeakBps?: number;
    inventoryAction?: "ACCUMULATE" | "DISTRIBUTE" | "HOLD";
    bands?: {
      floor: number;
      target: number;
      cap: number;
      hysteresis: number;
    };
    phaseAwareCaps?: {
      maxSellUsdPerHour: number;
      seedBuyUsd: number;
    };
    reentryProgress?: {
      btcNotionalUsd: number;
      targetUsd: number;
      seedOrdersPlaced: number;
      lastSeedTs: number;
    };
    errorPolicy?: {
      recoverableCount5m: number;
      lastRecoverableError: string;
      transientBackoffMs: number;
      hardHalt: boolean;
      hardHaltReason: string;
    };
  };
  quoting_inputs?: {
    volMoveBps: number;
    marketSpreadBps: number;
    usd_free: number;
    btcNotional: number;
    trendMoveBps: number;
    thresholds: {
      minVolMoveBpsToQuote: number;
      minMarketSpreadBps: number;
      trendPauseBps: number;
      volProtectMode: "block" | "widen";
      volWidenMultMin: number;
      volWidenMultMax: number;
    };
  };
  lastError?: string;
  lastSubmitError?: {
    ts: number;
    endpoint: string;
    payloadSummary: {
      clientOrderId: string;
      symbol: string;
      side: string;
      type: string;
      price: number;
      quoteSize: number;
      executionInstructions: string[];
    };
    httpStatus: number | null;
    responseBody: unknown;
    errorMessage: string;
    errorStack: string;
    ok: boolean;
  } | null;
  allow_buy: boolean;
  allow_sell: boolean;
  buy_reasons: string[];
  sell_reasons: string[];
};

const LEGACY_PAUSE_FILE_REASON_RE =
  /PAUSE_SWITCH_FILE|KILL_SWITCH_FILE|paused by pause|kill-switch file detected|pause switch file/i;

export function normalizeLegacyPauseFileBotStatus(status: BotStatus | null): BotStatus | null {
  if (!status) return status;

  const buyReasons = Array.isArray(status.buy_reasons)
    ? status.buy_reasons.filter((reason) => !LEGACY_PAUSE_FILE_REASON_RE.test(String(reason)))
    : [];
  const sellReasons = Array.isArray(status.sell_reasons)
    ? status.sell_reasons.filter((reason) => !LEGACY_PAUSE_FILE_REASON_RE.test(String(reason)))
    : [];

  const removedBuy = (status.buy_reasons?.length ?? 0) - buyReasons.length;
  const removedSell = (status.sell_reasons?.length ?? 0) - sellReasons.length;
  const allowBuy = status.allow_buy === false && removedBuy > 0 && buyReasons.length === 0 ? true : status.allow_buy;
  const allowSell =
    status.allow_sell === false && removedSell > 0 && sellReasons.length === 0 ? true : status.allow_sell;

  const changed =
    removedBuy > 0 ||
    removedSell > 0 ||
    allowBuy !== status.allow_buy ||
    allowSell !== status.allow_sell;
  if (!changed) return status;

  return {
    ...status,
    allow_buy: allowBuy,
    allow_sell: allowSell,
    buy_reasons: buyReasons,
    sell_reasons: sellReasons
  };
}

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
  | "HEDGE"
  | "SEED_TAKER"
  | "REJECTED"
  | "ERROR"
  | "OVERRIDE";

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
  details_json?: string | null;
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
  recordExternalPriceSnapshot(snapshot: ExternalVenueSnapshot): void;
  recordSignalSnapshot(snapshot: SignalSnapshot): void;
  getRecentExternalPriceSnapshots(symbol: string, limit: number): ExternalVenueSnapshot[];
  getLatestVenueQuotes(symbol: string): VenueQuote[];
  getRecentSignalSnapshots(symbol: string, limit: number): SignalSnapshot[];

  recordStrategyDecision(decision: StrategyDecision): void;
  getRecentStrategyDecisions(limit: number): StrategyDecision[];

  recordMetric(metric: MetricRecord): void;
  getMetrics(key: string, sinceTs: number, limit: number): MetricRecord[];

  recordBotEvent(event: BotEvent): void;
  getRecentBotEvents(limit: number): BotEvent[];
  getRollingMetrics(nowTs: number): RollingMetrics;

  getRuntimeOverrides(symbol: string): RuntimeOverridesRecord | null;
  setRuntimeOverrides(
    symbol: string,
    patch: Partial<RuntimeOverridesInput>,
    meta?: RuntimeOverridesMeta
  ): RuntimeOverridesRecord;
  clearRuntimeOverrides(symbol: string, meta?: RuntimeOverridesMeta): void;
  getEffectiveConfig(symbol: string, context?: RuntimeOverrideContext): EffectiveRuntimeConfig;
}
