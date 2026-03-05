import { join } from "node:path";
import { BotConfig } from "../config";
import { Logger } from "../logger";
import { MarketData } from "../md/MarketData";
import { Store } from "../store/Store";
import { AdaptiveController } from "./AdaptiveController";
import { analyzeFillsWindow } from "./analysis";
import { PerformanceStorage } from "./PerformanceStorage";
import {
  AdaptiveDecision,
  AdaptiveParams,
  AdaptiveStatus,
  AnalysisSummary,
  AnalysisWindowKey,
  EquityPoint,
  FillAnalysisRow,
  PersistedFillRow
} from "./types";

type RecordFillInput = {
  ts: number;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  baseQty: number;
  feeUsd: number;
  venueOrderId: string;
  clientOrderId: string;
  revxMidAtFill: number;
  posture?: string;
  source?: "venue" | "inferred";
  sourceJson?: string;
};

export class PerformanceEngine {
  private readonly storage: PerformanceStorage;
  private readonly adaptiveController: AdaptiveController;
  private midTimer: NodeJS.Timeout | null = null;
  private latestSummaryByWindow: Record<AnalysisWindowKey, AnalysisSummary | null> = {
    "1h": null,
    "24h": null,
    "7d": null
  };
  private samplingMid = false;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly store: Store,
    private readonly marketData: MarketData
  ) {
    this.storage = new PerformanceStorage(config.runtimeBaseDir, logger);
    this.adaptiveController = new AdaptiveController(
      config,
      logger,
      store,
      {
        fillsPerHourMin: config.adaptiveFillsPerHourMin,
        toxicPctMax: config.adaptiveToxicPctMax,
        avgToxBpsMin: config.adaptiveAvgToxBpsMin,
        netPnlStopLoss24h: config.adaptiveNetPnlStopLoss24h
      },
      config.adaptiveControllerIntervalSeconds,
      join(config.runtimeBaseDir, "data", "adaptive-controller.json"),
      (decision) => this.recordAdaptiveDecision(decision)
    );
  }

  start(): void {
    if (!this.midTimer) {
      this.midTimer = setInterval(() => {
        void this.sampleMid();
      }, 1_000);
    }
    this.adaptiveController.start(() => {
      const summary1h = this.getSummary("1h");
      const summary24h = this.getSummary("24h");
      const status = this.store.getBotStatus() as Record<string, unknown> | null;
      const posture = String(status?.intel_state ?? "NORMAL").toUpperCase();
      return { summary1h, summary24h, posture };
    });
  }

  stop(): void {
    if (this.midTimer) {
      clearInterval(this.midTimer);
      this.midTimer = null;
    }
    this.adaptiveController.stop();
  }

  getHealth(): Record<string, unknown> {
    return {
      ts: Date.now(),
      storage: this.storage.getHealth(),
      adaptive: this.adaptiveController.getStatus()
    };
  }

  recordFill(input: RecordFillInput): void {
    const ts = Math.max(0, Math.floor(Number(input.ts) || Date.now()));
    const symbol = String(input.symbol || this.config.symbol).toUpperCase();
    const baseQty = safePositive(input.baseQty);
    const price = safePositive(input.price);
    if (!(baseQty > 0) || !(price > 0)) return;
    const persisted: PersistedFillRow = {
      id: `${input.venueOrderId || "no-order"}:${input.clientOrderId || "no-client"}:${ts}:${input.side}:${baseQty}`,
      ts,
      symbol,
      side: input.side,
      price,
      base_qty: baseQty,
      quote_qty: baseQty * price,
      fee_usd: Number.isFinite(input.feeUsd) ? input.feeUsd : 0,
      order_id: String(input.venueOrderId || ""),
      client_order_id: String(input.clientOrderId || ""),
      posture: String(input.posture || "UNKNOWN"),
      revx_mid_at_fill:
        Number.isFinite(input.revxMidAtFill) && input.revxMidAtFill > 0
          ? input.revxMidAtFill
          : price,
      source_json: this.normalizeSourceJson(input.source, input.sourceJson)
    };
    this.storage.recordFill(persisted);
  }

  getSummary(window: AnalysisWindowKey): AnalysisSummary {
    const now = Date.now();
    const windowMs = window === "1h" ? 60 * 60 * 1000 : window === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const fills = this.storage.getFillsSince(this.config.symbol, now - windowMs - 6 * 60 * 60 * 1000);
    const mids = this.storage.getMidSnapshotsSince(this.config.symbol, now - windowMs - 10 * 60 * 1000);
    const latestMid = this.resolveLatestMid();
    const rolling = this.store.getRollingMetrics(now);
    const cancelReplaceRatio = rolling.fills_last_1h > 0 ? rolling.cancels_last_1h / rolling.fills_last_1h : 0;
    const result = analyzeFillsWindow({
      fills,
      mids,
      latestMid,
      nowTs: now,
      window,
      inventoryToxicThresholdUsd: this.config.maxInventoryUsd * 0.4,
      cancelReplaceRatio
    });
    this.latestSummaryByWindow[window] = result.summary;
    this.storage.recordAnalysisRun({
      ts: now,
      window,
      metrics_json: JSON.stringify(result.summary)
    });
    return result.summary;
  }

  getFills(
    window: AnalysisWindowKey,
    limit: number,
    options?: { symbol?: string; includeInferred?: boolean }
  ): FillAnalysisRow[] {
    const now = Date.now();
    const symbol = String(options?.symbol || this.config.symbol).toUpperCase();
    const includeInferred = options?.includeInferred !== false;
    const windowMs = window === "1h" ? 60 * 60 * 1000 : window === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const fillsRaw = this.storage.getFillsSince(symbol, now - windowMs - 6 * 60 * 60 * 1000);
    const fills = includeInferred ? fillsRaw : fillsRaw.filter((row) => this.resolveFillSource(row) !== "inferred");
    const mids = this.storage.getMidSnapshotsSince(symbol, now - windowMs - 10 * 60 * 1000);
    const latestMid = this.resolveLatestMid(symbol);
    const result = analyzeFillsWindow({
      fills,
      mids,
      latestMid,
      nowTs: now,
      window
    });
    return result.rows.sort((a, b) => b.ts - a.ts).slice(0, Math.max(1, Math.floor(limit || 100)));
  }

  getFillsDebug(params: {
    window: AnalysisWindowKey;
    limit: number;
    symbol?: string;
    includeInferred?: boolean;
  }): {
    uiEndpoint: string;
    storeBackend: "sqlite" | "json" | "memory";
    storeQueryPath: string;
    totalTradesInStore: number;
    tradesReturnedToUI: number;
    lastTradeTs: number | null;
    last5TradesPreview: FillAnalysisRow[];
  } {
    const symbol = String(params.symbol || this.config.symbol).toUpperCase();
    const includeInferred = params.includeInferred !== false;
    const allTrades = this.storage.getFillsSince(symbol, 0);
    const visibleTrades = includeInferred
      ? allTrades
      : allTrades.filter((row) => this.resolveFillSource(row) !== "inferred");
    const rows = this.getFills(params.window, params.limit, {
      symbol,
      includeInferred
    });
    const health = this.storage.getHealth();
    const storeBackend: "sqlite" | "json" | "memory" =
      health.mode === "sqlite" ? "sqlite" : health.mode === "jsonl" ? "json" : "memory";
    const lastTradeTs =
      visibleTrades.length > 0
        ? visibleTrades.reduce((maxTs, row) => Math.max(maxTs, Number(row.ts) || 0), 0)
        : null;
    return {
      uiEndpoint: "/api/analysis/fills",
      storeBackend,
      storeQueryPath: `performance:${health.mode}`,
      totalTradesInStore: visibleTrades.length,
      tradesReturnedToUI: rows.length,
      lastTradeTs,
      last5TradesPreview: rows.slice(0, 5)
    };
  }

  getEquityCurve(window: AnalysisWindowKey): EquityPoint[] {
    const now = Date.now();
    const windowMs = window === "1h" ? 60 * 60 * 1000 : window === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const fills = this.storage.getFillsSince(this.config.symbol, now - windowMs - 6 * 60 * 60 * 1000);
    const mids = this.storage.getMidSnapshotsSince(this.config.symbol, now - windowMs - 10 * 60 * 1000);
    const latestMid = this.resolveLatestMid();
    const result = analyzeFillsWindow({
      fills,
      mids,
      latestMid,
      nowTs: now,
      window
    });
    return result.curve;
  }

  getStatusSummaries(): { analysisSummary_1h: AnalysisSummary; analysisSummary_24h: AnalysisSummary } {
    return {
      analysisSummary_1h: this.latestSummaryByWindow["1h"] ?? this.getSummary("1h"),
      analysisSummary_24h: this.latestSummaryByWindow["24h"] ?? this.getSummary("24h")
    };
  }

  getAdaptiveStatus(): AdaptiveStatus {
    return this.adaptiveController.getStatus();
  }

  setAdaptiveEnabled(enabled: boolean): AdaptiveStatus {
    return this.adaptiveController.setEnabled(enabled);
  }

  setAdaptiveParams(params: Partial<AdaptiveParams>, reason = "api_set_params"): AdaptiveStatus {
    return this.adaptiveController.setParams(params, reason);
  }

  private recordAdaptiveDecision(decision: AdaptiveDecision): void {
    this.storage.recordAdaptiveEvent({
      ts: decision.ts,
      action: decision.action,
      reason: decision.reason,
      before_params_json: JSON.stringify(decision.before),
      after_params_json: JSON.stringify(decision.after),
      metrics_json: JSON.stringify(decision.metrics)
    });
  }

  private async sampleMid(): Promise<void> {
    if (this.samplingMid) return;
    this.samplingMid = true;
    try {
      const fromStore = this.store.getRecentTickerSnapshots(this.config.symbol, 1)[0] ?? null;
      let bid = Number(fromStore?.bid ?? 0);
      let ask = Number(fromStore?.ask ?? 0);
      let mid = Number(fromStore?.mid ?? 0);
      if (!(mid > 0) || !(bid > 0) || !(ask > 0)) {
        try {
          const ticker = await this.marketData.getTicker(this.config.symbol);
          bid = Number(ticker.bid);
          ask = Number(ticker.ask);
          mid = Number(ticker.mid);
        } catch (error) {
          this.logger.debug({ error }, "Performance mid sample ticker fetch failed");
        }
      }
      if (!(mid > 0)) return;
      this.storage.recordMidSnapshot({
        ts: Date.now(),
        symbol: this.config.symbol,
        revx_bid: bid > 0 ? bid : mid,
        revx_ask: ask > 0 ? ask : mid,
        revx_mid: mid
      });
      const retentionCutoff = Date.now() - 48 * 60 * 60 * 1000;
      this.storage.pruneMidSnapshots(retentionCutoff);
    } finally {
      this.samplingMid = false;
    }
  }

  private resolveLatestMid(symbol = this.config.symbol): number {
    const latest = this.storage.getLatestMid(symbol);
    if (latest && Number.isFinite(latest.revx_mid) && latest.revx_mid > 0) return latest.revx_mid;
    return this.store.getRecentTickerSnapshots(symbol, 1)[0]?.mid ?? 0;
  }

  private resolveFillSource(fill: PersistedFillRow): string {
    const normalized = String(fill.source_json || "").trim();
    if (!normalized) return "venue";
    try {
      const parsed = JSON.parse(normalized) as Record<string, unknown>;
      const sourceRaw = parsed.source;
      if (typeof sourceRaw === "string" && sourceRaw.trim().length > 0) {
        return sourceRaw.trim().toLowerCase();
      }
      return "venue";
    } catch {
      return "venue";
    }
  }

  private normalizeSourceJson(source: "venue" | "inferred" | undefined, input: string | undefined): string {
    const parsed = tryParseJsonObject(input);
    const payload: Record<string, unknown> = {
      ...parsed,
      source: source || (typeof parsed.source === "string" && parsed.source.length > 0 ? parsed.source : "venue")
    };
    return JSON.stringify(payload);
  }
}

function safePositive(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value > 0 ? value : 0;
}

function tryParseJsonObject(value: string | undefined): Record<string, unknown> {
  const normalized = String(value || "").trim();
  if (!normalized) return {};
  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse failure; store opaque payload below
  }
  return { raw: normalized };
}
