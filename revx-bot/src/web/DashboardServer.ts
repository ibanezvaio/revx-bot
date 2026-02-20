import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { BotConfig } from "../config";
import { Logger } from "../logger";
import { BalanceSnapshot, FillRecord, OrderHistoryRecord, Store, TickerSnapshot } from "../store/Store";
import { renderEquityChartScript } from "../ui/components/EquityChart";
import { renderDrawdownChartScript } from "../ui/components/DrawdownChart";
import { renderUseEquitySeriesScript } from "../ui/hooks/useEquitySeries";

type PnlWindowKey = "24h" | "12h" | "4h" | "1h" | "15m";

type DashboardActions = {
  cancelAllBotOrders: () => Promise<void>;
};

const PNL_WINDOW_MS: Record<PnlWindowKey, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "15m": 15 * 60 * 1000
};

type DashboardEventType = "PLACED" | "CANCELLED" | "FILLED" | "REPLACED" | "REJECTED" | "ERROR";

type DashboardEvent = {
  event_id: string;
  ts: number;
  type: DashboardEventType;
  side: string;
  price: number | null;
  size: number | null;
  reason: string;
  client_id: string;
  client_order_id: string;
  venue_order_id: string | null;
};

export class DashboardServer {
  private server: Server | null = null;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly store: Store,
    private readonly runId: string,
    private readonly actions?: DashboardActions
  ) {}

  start(): void {
    if (!this.config.dashboardEnabled) {
      this.logger.info("Dashboard disabled by DASHBOARD_ENABLED=false");
      return;
    }

    if (this.server) return;

    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });

    this.server.on("error", (error) => {
      this.logger.warn(
        { error: (error as Error).message, port: this.config.dashboardPort },
        "Dashboard server unavailable; continuing without UI"
      );
      this.stop();
    });

    this.server.listen(this.config.dashboardPort, "127.0.0.1", () => {
      this.logger.info(
        { url: `http://127.0.0.1:${this.config.dashboardPort}` },
        "Dashboard listening"
      );
    });
  }

  stop(): void {
    if (!this.server) return;
    this.server.close();
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (method === "GET" && url.pathname === "/api/status") {
      const windowKey = parsePnlWindow(url.searchParams.get("window"));
      const eventLimit = parseLimit(url.searchParams.get("limit"), this.config.maxApiEvents, 50, 10_000);
      const payload = this.buildStatus(windowKey, eventLimit);
      writeJson(res, 200, payload);
      return;
    }

    if (method === "POST" && url.pathname === "/api/action/cancel-all") {
      await this.handleCancelAllAction(res);
      return;
    }

    if (method === "POST" && url.pathname === "/api/action/pause") {
      await this.handlePauseAction(req, res);
      return;
    }

    if (method === "POST" && url.pathname === "/api/action/kill-switch") {
      await this.handleKillSwitchAction(res);
      return;
    }

    if (method === "GET" && url.pathname === "/healthz") {
      writeJson(res, 200, { ok: true, ts: Date.now() });
      return;
    }

    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        renderDashboardHtml(
          this.config.maxUiEvents,
          this.config.maxEquityPoints,
          this.config.equitySampleMs,
          this.config.persistEquitySeries,
          this.config.symbol
        )
      );
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
  }

  private buildStatus(windowKey: PnlWindowKey, eventLimit: number): Record<string, unknown> {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const windowMs = PNL_WINDOW_MS[windowKey];
    const balanceLimit = estimateSnapshotCount(windowMs, this.config.reconcileSeconds, 220, 20_000);
    const tickerIntervalSeconds = Math.max(this.config.refreshSeconds, this.config.reconcileSeconds);
    const tickerLimit = estimateSnapshotCount(windowMs, tickerIntervalSeconds, 400, 20_000);

    const balances = this.store
      .getLatestBalances()
      .filter((row) => Math.abs(row.free) > 1e-12 || Math.abs(row.total) > 1e-12)
      .sort((a, b) => a.asset.localeCompare(b.asset));
    const activeBotOrders = this.store.getActiveBotOrders(this.config.symbol);
    const recentBotOrders = this.store.getRecentBotOrderHistory(eventLimit);
    const recentFills = this.store.getRecentFills(eventLimit);
    const recentEvents = this.store.getRecentBotEvents(eventLimit).map((row) => ({
      event_id: row.event_id,
      ts: row.ts,
      type: row.type as DashboardEventType,
      side: row.side,
      price: Number.isFinite(row.price) ? row.price : null,
      size: Number.isFinite(row.quote_size_usd) ? row.quote_size_usd : null,
      reason: row.reason,
      client_id: row.client_order_id,
      client_order_id: row.client_order_id,
      venue_order_id: row.venue_order_id
    }));
    const botStatus = this.store.getBotStatus();
    const fills1h = this.store.getFillsSince(oneHourAgo);

    const edgeStats = summarizeEdgeBps(fills1h);
    const realizedPnlMetric = this.store.getMetrics("realized_pnl_usd", 0, 1)[0];
    const avgEdgeBuyMetric = this.store.getMetrics("avg_edge_bps_buy", oneHourAgo, 1)[0];
    const avgEdgeSellMetric = this.store.getMetrics("avg_edge_bps_sell", oneHourAgo, 1)[0];
    const fills1hMetric = this.store.getMetrics("fills_1h_count", oneHourAgo, 1)[0];
    const fillsLast30mMetric = this.store.getMetrics("fills_last_30m", now - 30 * 60 * 1000, 1)[0];
    const postOnlyRejectsMetric = this.store.getMetrics("post_only_rejects_last_1h", oneHourAgo, 1)[0];
    const cancelsLast1hMetric = this.store.getMetrics("cancels_last_1h", oneHourAgo, 1)[0];
    const avgRestingMetric = this.store.getMetrics("avg_resting_time_seconds", oneHourAgo, 1)[0];
    const latestDecision = this.store.getRecentStrategyDecisions(1)[0];
    const latestDecisionDetails = parseJsonObject(latestDecision?.details_json);
    const signalState = parseJsonObject(latestDecisionDetails.signal_state);

    const tickerSeries = this.store.getRecentTickerSnapshots(this.config.symbol, tickerLimit);
    const ticker = tickerSeries[0] ?? null;

    const pnlSeries = buildPnlSeries(
      this.config.symbol,
      this.store.getRecentBalanceSnapshots(balanceLimit),
      tickerSeries,
      now - windowMs
    );

    const pnlNow = pnlSeries.length > 0 ? pnlSeries[pnlSeries.length - 1].pnlUsd : 0;
    const pnlMin = pnlSeries.length > 0 ? Math.min(...pnlSeries.map((point) => point.pnlUsd)) : 0;
    const pnlMax = pnlSeries.length > 0 ? Math.max(...pnlSeries.map((point) => point.pnlUsd)) : 0;

    return {
      ts: now,
      uptimeSeconds: Math.floor(process.uptime()),
      runId: this.runId,
      symbol: this.config.symbol,
      pnlWindow: windowKey,
      eventLimit,
      mode: {
        dryRun: this.config.dryRun,
        mockMode: this.config.mockMode,
        paused: existsSync(this.config.pauseSwitchFile),
        killSwitchArmed: existsSync(this.config.killSwitchFile)
      },
      ticker,
      balances,
      activeBotOrders,
      recentBotOrders,
      recentFills,
      recentEvents,
      botStatus,
      analytics: {
        trendMoveBps: botStatus?.trend_move_bps ?? null,
        realizedPnlUsd: realizedPnlMetric?.value ?? 0,
        edgeBpsLastFill: edgeStats.lastEdgeBps,
        avgEdgeBps1hBuy: avgEdgeBuyMetric?.value ?? 0,
        avgEdgeBps1hSell: avgEdgeSellMetric?.value ?? 0,
        fills1hCount: fills1hMetric?.value ?? fills1h.length,
        fillsLast1h: fills1hMetric?.value ?? fills1h.length,
        fillsLast30m: fillsLast30mMetric?.value ?? this.store.getFillsSince(now - 30 * 60 * 1000).length,
        postOnlyRejectsLast1h: postOnlyRejectsMetric?.value ?? 0,
        cancelsLast1h: cancelsLast1hMetric?.value ?? 0,
        avgRestingTimeSeconds: avgRestingMetric?.value ?? 0,
        signalVolRegime: asString(signalState.vol_regime, "normal"),
        signalDriftBps: asNumber(signalState.drift_bps, 0),
        signalZScore: asNumber(signalState.z_score, 0),
        signalStdevBps: asNumber(signalState.stdev_bps, 0),
        signalSkewBpsApplied: asNumber(latestDecisionDetails.signal_skew_bps_applied, 0),
        signalConfidence: asNumber(signalState.confidence, 0),
        effectiveHalfSpreadBps: asNumber(
          latestDecisionDetails.effective_half_spread_bps_after_adaptive,
          asNumber(latestDecisionDetails.effective_half_spread_bps, 0)
        ),
        adaptiveSpreadDeltaBps: asNumber(latestDecisionDetails.adaptive_spread_bps_delta, 0),
        adaptiveAdjustments: Array.isArray(latestDecisionDetails.adaptive_adjustments_applied)
          ? latestDecisionDetails.adaptive_adjustments_applied
          : [],
        targetFillsPerHour: this.config.targetFillsPerHour,
        actionBudgetUsed: asNumber(botStatus?.action_budget_used, 0),
        actionBudgetMax: asNumber(botStatus?.action_budget_max, this.config.maxActionsPerLoop),
        churnWarning: Boolean(botStatus?.churn_warning)
      },
      pnlSeries,
      pnlSummary: {
        pnlUsd: pnlNow,
        minPnlUsd: pnlMin,
        maxPnlUsd: pnlMax
      }
    };
  }

  private async handleCancelAllAction(res: ServerResponse): Promise<void> {
    if (!this.actions) {
      writeJson(res, 501, { ok: false, message: "cancel-all action unavailable" });
      return;
    }

    try {
      await this.actions.cancelAllBotOrders();
      writeJson(res, 200, { ok: true });
    } catch (error) {
      this.logger.error({ error }, "Dashboard cancel-all action failed");
      writeJson(res, 500, { ok: false, message: "cancel-all failed" });
    }
  }

  private async handlePauseAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const currentPaused = existsSync(this.config.pauseSwitchFile);
    const body = await readRequestBody(req);
    const requested = parseBoolean(body.paused);
    const nextPaused = requested === null ? !currentPaused : requested;

    try {
      if (nextPaused) {
        writeFileSync(this.config.pauseSwitchFile, `paused ${new Date().toISOString()}\n`, "utf8");
        if (this.actions) {
          await this.actions.cancelAllBotOrders();
        }
      } else if (existsSync(this.config.pauseSwitchFile)) {
        unlinkSync(this.config.pauseSwitchFile);
      }

      writeJson(res, 200, { ok: true, paused: existsSync(this.config.pauseSwitchFile) });
    } catch (error) {
      this.logger.error({ error }, "Dashboard pause action failed");
      writeJson(res, 500, { ok: false, message: "pause action failed" });
    }
  }

  private async handleKillSwitchAction(res: ServerResponse): Promise<void> {
    try {
      writeFileSync(this.config.killSwitchFile, `kill ${new Date().toISOString()}\n`, "utf8");
      if (this.actions) {
        await this.actions.cancelAllBotOrders();
      }
      writeJson(res, 200, { ok: true, killSwitchArmed: true });
    } catch (error) {
      this.logger.error({ error }, "Dashboard kill-switch action failed");
      writeJson(res, 500, { ok: false, message: "kill-switch action failed" });
    }
  }
}

type PnlPoint = {
  ts: number;
  equityUsd: number;
  pnlUsd: number;
  mid: number;
};

function buildPnlSeries(
  symbol: string,
  balances: BalanceSnapshot[],
  tickerSeries: TickerSnapshot[],
  cutoffTs: number
): PnlPoint[] {
  if (balances.length === 0 || tickerSeries.length === 0) {
    return [];
  }

  const [baseAsset, quoteAsset] = splitSymbol(symbol);
  const groupedSnapshots = groupBalanceSnapshotsByTs(balances).filter((row) => row.ts >= cutoffTs);
  const tickersAsc = [...tickerSeries].sort((a, b) => a.ts - b.ts);

  if (groupedSnapshots.length === 0 || tickersAsc.length === 0) {
    return [];
  }

  let tickerIndex = 0;
  let lastMid = Number.NaN;
  const points: PnlPoint[] = [];

  for (const snapshot of groupedSnapshots) {
    while (tickerIndex < tickersAsc.length && tickersAsc[tickerIndex].ts <= snapshot.ts) {
      lastMid = tickersAsc[tickerIndex].mid;
      tickerIndex += 1;
    }

    if (!Number.isFinite(lastMid) || lastMid <= 0) {
      lastMid = tickersAsc[Math.min(tickerIndex, tickersAsc.length - 1)].mid;
    }

    if (!Number.isFinite(lastMid) || lastMid <= 0) {
      continue;
    }

    const baseBalance = snapshot.assets.get(baseAsset)?.total ?? 0;
    const quoteBalance = snapshot.assets.get(quoteAsset)?.total ?? 0;
    const equityUsd = quoteBalance + baseBalance * lastMid;

    points.push({
      ts: snapshot.ts,
      equityUsd,
      pnlUsd: 0,
      mid: lastMid
    });
  }

  if (points.length === 0) {
    return [];
  }

  const baseline = points[0].equityUsd;
  for (const point of points) {
    point.pnlUsd = point.equityUsd - baseline;
  }

  return downsamplePoints(points, 280);
}

function groupBalanceSnapshotsByTs(
  balances: BalanceSnapshot[]
): Array<{ ts: number; assets: Map<string, BalanceSnapshot> }> {
  const grouped = new Map<number, Map<string, BalanceSnapshot>>();

  for (const row of balances) {
    const ts = row.ts;
    if (!grouped.has(ts)) {
      grouped.set(ts, new Map<string, BalanceSnapshot>());
    }
    grouped.get(ts)?.set(row.asset.toUpperCase(), row);
  }

  return Array.from(grouped.entries())
    .map(([ts, assets]) => ({ ts, assets }))
    .sort((a, b) => a.ts - b.ts);
}

function downsamplePoints(points: PnlPoint[], maxPoints: number): PnlPoint[] {
  if (points.length <= maxPoints) {
    return points;
  }

  const step = Math.ceil(points.length / maxPoints);
  const sampled = points.filter((_, idx) => idx % step === 0);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) {
    sampled.push(last);
  }
  return sampled;
}

function summarizeEdgeBps(
  fills: Array<{ edge_bps?: number | null; ts: number }>
): { lastEdgeBps: number | null } {
  if (!Array.isArray(fills) || fills.length === 0) {
    return { lastEdgeBps: null };
  }
  const sorted = [...fills].sort((a, b) => b.ts - a.ts);
  for (const fill of sorted) {
    if (typeof fill.edge_bps === "number" && Number.isFinite(fill.edge_bps)) {
      return { lastEdgeBps: fill.edge_bps };
    }
  }
  return { lastEdgeBps: null };
}

function classifyOrderEventType(status: string | null | undefined): DashboardEventType {
  const value = String(status ?? "").toUpperCase();
  if (value.includes("REPLACED")) return "REPLACED";
  if (value.includes("CANCEL")) return "CANCELLED";
  if (value.includes("FILL")) return "FILLED";
  if (value.includes("REJECT")) return "REJECTED";
  if (value.includes("ERROR") || value.includes("FAIL")) return "ERROR";
  return "PLACED";
}

function buildRecentEvents(
  orders: OrderHistoryRecord[],
  fills: FillRecord[],
  limit: number
): DashboardEvent[] {
  const events: DashboardEvent[] = [];

  for (const order of orders) {
    const type = classifyOrderEventType(order.status);
    const ts = Number(order.ts);
    const venueOrderId = order.venue_order_id ?? null;
    const clientId = order.client_order_id || "-";
    events.push({
      event_id: `order:${ts}:${type}:${venueOrderId ?? "-"}:${clientId}:${order.status}:${order.price}:${order.quote_size}`,
      ts: Number.isFinite(ts) ? ts : 0,
      type,
      side: String(order.side || "-").toUpperCase(),
      price: Number.isFinite(order.price) ? order.price : null,
      size: Number.isFinite(order.quote_size) ? order.quote_size : null,
      reason: String(order.status || ""),
      client_id: clientId,
      client_order_id: clientId,
      venue_order_id: venueOrderId
    });
  }

  for (const fill of fills) {
    const ts = Number(fill.ts);
    const tradeId = String(fill.trade_id || "-");
    events.push({
      event_id: `fill:${tradeId}:${ts}`,
      ts: Number.isFinite(ts) ? ts : 0,
      type: "FILLED",
      side: "-",
      price: Number.isFinite(fill.price) ? fill.price : null,
      size: Number.isFinite(fill.qty) ? fill.qty : null,
      reason: `trade ${tradeId}`,
      client_id: "-",
      client_order_id: "-",
      venue_order_id: fill.venue_order_id || null
    });
  }

  return events
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

function splitSymbol(symbol: string): [string, string] {
  const [base, quote] = symbol.split("-");
  return [base.toUpperCase(), quote.toUpperCase()];
}

function parsePnlWindow(raw: string | null): PnlWindowKey {
  if (raw === "12h" || raw === "4h" || raw === "1h" || raw === "15m" || raw === "24h") {
    return raw;
  }
  return "24h";
}

function parseLimit(raw: string | null, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function estimateSnapshotCount(
  windowMs: number,
  intervalSeconds: number,
  floor: number,
  ceiling: number
): number {
  const intervalMs = Math.max(intervalSeconds, 1) * 1000;
  const estimated = Math.ceil((windowMs * 1.1) / intervalMs) + 180;
  return Math.max(floor, Math.min(ceiling, estimated));
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  }
  return null;
}

async function readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function renderDashboardHtml(
  maxUiEventsDefault: number,
  maxEquityPointsDefault: number,
  equitySampleMsDefault: number,
  persistEquitySeriesDefault: boolean,
  symbol: string
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>REVX-BOT CONTROL ROOM</title>
  <style>
    :root {
      --bg: #060b14;
      --panel: #0f1826;
      --panel-2: #131e2f;
      --line: rgba(167, 196, 228, 0.14);
      --line-strong: rgba(167, 196, 228, 0.26);
      --text: #f3f7fc;
      --muted: #8fa6c1;
      --accent: #37b4ff;
      --good: #21e3a2;
      --warn: #f4c14d;
      --bad: #ff6d7c;
      --shadow: 0 14px 30px rgba(0, 0, 0, 0.33);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      color: var(--text);
      font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      background:
        radial-gradient(1000px 520px at 0% -20%, rgba(55,180,255,0.16), transparent 55%),
        radial-gradient(900px 480px at 100% 0%, rgba(33,227,162,0.08), transparent 50%),
        linear-gradient(180deg, #050a12 0%, #07101b 50%, #060b14 100%);
      min-height: 100vh;
    }

    .shell {
      max-width: 1450px;
      margin: 0 auto;
      padding: 16px 20px 24px;
    }

    .mission-bar {
      position: sticky;
      top: 0;
      z-index: 40;
      margin-bottom: 14px;
      background: linear-gradient(180deg, rgba(16,26,39,0.95), rgba(10,17,28,0.94));
      border: 1px solid var(--line-strong);
      border-radius: 14px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
      display: grid;
      grid-template-columns: 1.2fr 1.1fr 1fr;
      gap: 14px;
      padding: 12px 14px;
    }

    .brand-title {
      margin: 0;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 1.06rem;
    }

    .brand-sub {
      margin-top: 4px;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.76rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .meta-chip {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      background: rgba(255, 255, 255, 0.01);
      min-width: 0;
    }

    .meta-key {
      color: var(--muted);
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      margin-bottom: 4px;
    }

    .meta-val {
      font-size: 0.88rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .mission-right {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }

    .pill {
      border-radius: 999px;
      padding: 6px 10px;
      border: 1px solid var(--line-strong);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }

    .dot.live { background: var(--good); box-shadow: 0 0 0 5px rgba(33, 227, 162, 0.18); }
    .dot.dead { background: var(--bad); box-shadow: 0 0 0 5px rgba(255, 109, 124, 0.18); }

    .btn {
      border: 1px solid var(--line-strong);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
      border-radius: 10px;
      padding: 7px 10px;
      font-size: 0.72rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      transition: 160ms ease;
    }

    .btn:hover { border-color: rgba(55, 180, 255, 0.75); color: #fff; }
    .btn.warn { border-color: rgba(244, 193, 77, 0.48); }
    .btn.bad { border-color: rgba(255, 109, 124, 0.6); }

    .grid-kpi {
      display: grid;
      grid-template-columns: repeat(14, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }

    .view-tabs {
      display: inline-flex;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px;
      margin: 0 0 10px;
      background: rgba(255, 255, 255, 0.02);
    }

    .view-tab {
      border: 0;
      background: transparent;
      color: var(--muted);
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 0.68rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      cursor: pointer;
    }

    .view-tab.active {
      color: #06101b;
      background: var(--accent);
      font-weight: 700;
    }

    .kpi-card {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 45%), var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      box-shadow: var(--shadow);
      min-width: 0;
    }

    .kpi-key {
      font-family: "IBM Plex Mono", "Menlo", monospace;
      color: var(--muted);
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }

    .kpi-info {
      width: 16px;
      height: 16px;
      border-radius: 999px;
      border: 1px solid var(--line-strong);
      color: var(--muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      cursor: help;
    }

    .kpi-val {
      font-size: 1.16rem;
      font-weight: 700;
      line-height: 1.1;
    }

    .kpi-sub {
      margin-top: 4px;
      color: var(--muted);
      font-size: 0.73rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .panel {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 45%), var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: var(--shadow);
      padding: 12px;
      min-width: 0;
    }

    .panel-title {
      margin: 0;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 0.76rem;
      color: var(--muted);
    }

    .pnl-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }

    .pnl-main {
      font-size: 1.3rem;
      font-weight: 700;
    }

    .pnl-meta {
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.76rem;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .toggle-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }

    .toggle-btn {
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.02);
      color: var(--muted);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 0.7rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .toggle-btn.active {
      color: #06101b;
      background: var(--accent);
      border-color: rgba(55, 180, 255, 0.85);
      font-weight: 700;
    }

    .gate-row {
      margin: 8px 0;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .gate-chip {
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      padding: 4px 10px;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.68rem;
      cursor: pointer;
      background: rgba(255,255,255,0.02);
    }

    .gate-chip.ok { border-color: rgba(33, 227, 162, 0.5); color: #9ff2d3; }
    .gate-chip.block { border-color: rgba(255, 109, 124, 0.58); color: #ffc3cb; }

    .gate-line {
      width: 100%;
      color: var(--muted);
      font-size: 0.75rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .gate-details {
      display: none;
      width: 100%;
      border: 1px dashed var(--line);
      border-radius: 10px;
      padding: 8px;
      color: var(--muted);
      font-size: 0.73rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      white-space: normal;
      word-break: break-word;
    }

    .chart-wrap {
      width: 100%;
      height: 300px;
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
      background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.005));
    }

    #pnlChart { width: 100%; height: 100%; display: block; }
    #equityChart { width: 100%; height: 100%; display: block; }
    #compositionChart { width: 100%; height: 100%; display: block; }

    .equity-chart-shell {
      position: relative;
      margin-top: 8px;
    }

    .chart-tooltip {
      position: absolute;
      display: none;
      min-width: 220px;
      max-width: 300px;
      pointer-events: none;
      transform: translate(-50%, -100%);
      background: rgba(8, 14, 24, 0.96);
      border: 1px solid var(--line-strong);
      border-radius: 10px;
      padding: 8px 10px;
      box-shadow: var(--shadow);
      color: var(--text);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.68rem;
      line-height: 1.45;
      z-index: 8;
      white-space: nowrap;
    }

    .equity-sub {
      margin-top: 8px;
      color: var(--muted);
      font-size: 0.72rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .bottom-grid {
      margin-top: 12px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .events-panel { margin-top: 12px; }

    .table-wrap {
      width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: rgba(3, 8, 16, 0.45);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 760px;
      font-size: 0.86rem;
    }

    th, td {
      border-bottom: 1px solid var(--line);
      padding: 8px 8px;
      white-space: nowrap;
      text-align: left;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.74rem;
    }

    th {
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 500;
      position: sticky;
      top: 0;
      background: rgba(14, 23, 36, 0.95);
    }

    .side-buy { color: #7ad7ff; font-weight: 700; }
    .side-sell { color: #ffb2bd; font-weight: 700; }

    .copy-btn {
      margin-left: 6px;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--muted);
      border-radius: 6px;
      font-size: 10px;
      padding: 1px 4px;
      cursor: pointer;
    }

    .event-filters {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 8px;
      align-items: center;
    }

    .event-pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,0.02);
      color: var(--muted);
      padding: 4px 9px;
      font-size: 0.66rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      cursor: pointer;
    }

    .event-pill.active {
      color: #06101b;
      background: var(--accent);
      border-color: rgba(55, 180, 255, 0.9);
      font-weight: 700;
    }

    .event-limit-label {
      color: var(--muted);
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      margin-left: 8px;
    }

    .event-limit-select {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,0.02);
      color: var(--text);
      padding: 4px 10px;
      font-size: 0.68rem;
      letter-spacing: 0.05em;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      outline: none;
      cursor: pointer;
    }

    .event-info {
      margin-left: auto;
      color: var(--muted);
      font-size: 0.68rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }

    .badge {
      display: inline-flex;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 2px 8px;
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }

    .b-placed { border-color: rgba(55, 180, 255, 0.7); color: #8ad5ff; }
    .b-cancelled { border-color: rgba(244, 193, 77, 0.7); color: #ffd98f; }
    .b-filled { border-color: rgba(33, 227, 162, 0.7); color: #a8f4d6; }
    .b-replaced { border-color: rgba(191, 155, 255, 0.7); color: #dbc5ff; }
    .b-rejected { border-color: rgba(255, 156, 109, 0.7); color: #ffd1b7; }
    .b-error { border-color: rgba(255, 109, 124, 0.7); color: #ffc3cb; }

    .chip-row {
      margin-top: 4px;
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
    }

    .tiny-chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 0.6rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .roadmap-grid {
      margin-top: 10px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }

    .roadmap-col {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      background: rgba(255, 255, 255, 0.015);
      min-width: 0;
    }

    .roadmap-col h4 {
      margin: 0 0 8px;
      font-size: 0.78rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #d3e8ff;
      font-family: "IBM Plex Mono", "Menlo", monospace;
    }

    .roadmap-col ul {
      margin: 0;
      padding-left: 16px;
      color: var(--muted);
      font-size: 0.76rem;
      line-height: 1.45;
    }

    .readiness {
      margin-top: 10px;
      border: 1px dashed var(--line);
      border-radius: 10px;
      padding: 8px;
      color: var(--muted);
      font-family: "IBM Plex Mono", "Menlo", monospace;
      font-size: 0.73rem;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 10px;
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(2, 6, 12, 0.72);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 120;
      padding: 20px;
    }

    .modal {
      width: min(430px, 100%);
      background: #0d1726;
      border: 1px solid var(--line-strong);
      border-radius: 14px;
      box-shadow: var(--shadow);
      padding: 14px;
    }

    .modal h3 {
      margin: 0 0 8px;
      font-size: 1rem;
      font-family: "IBM Plex Mono", "Menlo", monospace;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .modal p {
      margin: 0 0 12px;
      color: var(--muted);
      font-size: 0.86rem;
      line-height: 1.45;
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    @media (max-width: 1180px) {
      .mission-bar { grid-template-columns: 1fr; }
      .meta-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .mission-right { justify-content: flex-start; }
      .grid-kpi { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .roadmap-grid { grid-template-columns: 1fr; }
      .bottom-grid { grid-template-columns: 1fr; }
    }

    @media (max-width: 760px) {
      .shell { padding: 12px; }
      .meta-grid { grid-template-columns: 1fr; }
      .grid-kpi { grid-template-columns: 1fr 1fr; }
      .chart-wrap { height: 250px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="mission-bar" id="missionBar">
      <div>
        <h1 class="brand-title">REVX-BOT CONTROL ROOM</h1>
        <div class="brand-sub" id="missionSymbol">-</div>
      </div>
      <div class="meta-grid">
        <div class="meta-chip"><div class="meta-key">Run ID</div><div class="meta-val" id="missionRunId">-</div></div>
        <div class="meta-chip"><div class="meta-key">Uptime (s)</div><div class="meta-val" id="missionUptime">-</div></div>
        <div class="meta-chip"><div class="meta-key">Last Update</div><div class="meta-val" id="missionLast">-</div></div>
      </div>
      <div class="mission-right">
        <div class="pill" id="connectionPill"><span class="dot dead" id="connectionDot"></span><span id="connectionText">disconnected</span></div>
        <div class="pill" id="modePill">MODE: <span id="modeValue">-</span></div>
        <button class="btn warn" id="pauseBtn" title="Shortcut: P">Pause</button>
        <button class="btn" id="cancelBtn" title="Shortcut: C">Cancel All</button>
        <button class="btn bad" id="killBtn">Kill Switch</button>
      </div>
    </header>

    <div class="view-tabs" id="viewTabs">
      <button class="view-tab active" data-view="control">Control Room</button>
      <button class="view-tab" data-view="roadmap">Roadmap</button>
    </div>

    <div id="controlView">

    <section class="grid-kpi" id="kpiCards">
      <article class="kpi-card"><div class="kpi-key">Mid Price <span class="kpi-info" title="Current ticker mid price">i</span></div><div class="kpi-val" id="kpiMid">-</div><div class="kpi-sub">MARK-BASED</div></article>
      <article class="kpi-card"><div class="kpi-key">Spread (bps) <span class="kpi-info" title="Inside spread in basis points">i</span></div><div class="kpi-val" id="kpiSpread">-</div><div class="kpi-sub">INSIDE MARKET</div></article>
      <article class="kpi-card"><div class="kpi-key">Active Bot Orders <span class="kpi-info" title="Current active bot-tagged orders">i</span></div><div class="kpi-val" id="kpiActive">-</div><div class="kpi-sub">OPEN + PARTIAL</div></article>
      <article class="kpi-card"><div class="kpi-key">Trend Move (bps) <span class="kpi-info" title="Recent trend movement used by strategy">i</span></div><div class="kpi-val" id="kpiTrend">-</div><div class="kpi-sub">last window</div></article>
      <article class="kpi-card"><div class="kpi-key">Fill Edge <span class="kpi-info" title="Last fill edge and 1h avg edge for buys/sells">i</span></div><div class="kpi-val" id="kpiEdge">-</div><div class="kpi-sub" id="kpiEdgeSub">1h avg B - | S -</div></article>
      <article class="kpi-card"><div class="kpi-key">Realized PnL (USD) <span class="kpi-info" title="Realized PnL and fills in last hour">i</span></div><div class="kpi-val" id="kpiRealized">-</div><div class="kpi-sub" id="kpiFills1h">fills 1h: -</div></article>
      <article class="kpi-card"><div class="kpi-key">Execution Health <span class="kpi-info" title="Fill velocity, post-only rejects, cancels, and average resting time">i</span></div><div class="kpi-val" id="kpiExecHealth">-</div><div class="kpi-sub" id="kpiExecHealthSub">post-only rejects 1h: - | cancels 1h: - | avg rest: -s</div></article>
      <article class="kpi-card"><div class="kpi-key">Signals <span class="kpi-info" title="Volatility regime, drift, z-score, stdev, confidence, and applied skew">i</span></div><div class="kpi-val" id="kpiSignal">-</div><div class="kpi-sub" id="kpiSignalSub">drift - bps | z - | stdev - bps | skew - bps | conf -</div></article>
      <article class="kpi-card"><div class="kpi-key">Adaptive Controller <span class="kpi-info" title="Adaptive spread changes and reasons based on fills, edge and churn">i</span></div><div class="kpi-val" id="kpiAdaptive">-</div><div class="kpi-sub" id="kpiAdaptiveSub">delta - bps | target fills/hr - | current -</div><div class="kpi-sub" id="kpiAdaptiveSub2">TOB: - | Sell throttle: -</div><div class="chip-row" id="kpiAdaptiveReasons"></div></article>
      <article class="kpi-card"><div class="kpi-key">Total Equity (USD) <span class="kpi-info" title="usd_total + btc_total * mid">i</span></div><div class="kpi-val" id="kpiEquityUsd">-</div><div class="kpi-sub" id="kpiEquityUsdSub">BTC notional: -</div></article>
      <article class="kpi-card"><div class="kpi-key">Total Equity (BTC) <span class="kpi-info" title="btc_total + usd_total / mid">i</span></div><div class="kpi-val" id="kpiEquityBtc">-</div><div class="kpi-sub" id="kpiEquityBtcSub">USD notional: -</div></article>
      <article class="kpi-card"><div class="kpi-key">USD Balance <span class="kpi-info" title="USD total and free balances">i</span></div><div class="kpi-val" id="kpiUsdTotal">-</div><div class="kpi-sub" id="kpiUsdFree">free: -</div></article>
      <article class="kpi-card"><div class="kpi-key">BTC Balance <span class="kpi-info" title="BTC total and free balances">i</span></div><div class="kpi-val" id="kpiBtcTotal">-</div><div class="kpi-sub" id="kpiBtcFree">free: -</div></article>
      <article class="kpi-card"><div class="kpi-key">BTC Notional (USD) <span class="kpi-info" title="btc_total * mid">i</span></div><div class="kpi-val" id="kpiBtcNotionalUsd">-</div><div class="kpi-sub" id="kpiBtcNotionalSub">mid-linked</div></article>
    </section>

    <section class="panel">
      <div class="pnl-head">
        <h2 class="panel-title">SESSION PROFIT / LOSS</h2>
        <div class="pnl-main" id="pnlNow">-</div>
      </div>
      <div class="pnl-meta">
        <span id="pnlRange">24H range -</span>
        <span id="pnlSpan">-</span>
      </div>
      <div class="toggle-row" id="windowToggles">
        <button class="toggle-btn active" data-window="24h">24H</button>
        <button class="toggle-btn" data-window="12h">12H</button>
        <button class="toggle-btn" data-window="4h">4H</button>
        <button class="toggle-btn" data-window="1h">1H</button>
        <button class="toggle-btn" data-window="15m">15M</button>
      </div>
      <div class="gate-row">
        <button class="gate-chip" id="buyGateChip" data-gate="buy">Buy: -</button>
        <button class="gate-chip" id="sellGateChip" data-gate="sell">Sell: -</button>
        <div class="gate-line" id="gateLine">Buy: - | Sell: -</div>
        <div class="gate-details" id="gateDetails"></div>
      </div>
      <div class="chart-wrap">
        <svg id="pnlChart" viewBox="0 0 1200 300" preserveAspectRatio="none"></svg>
      </div>
    </section>

    <section class="panel">
      <div class="pnl-head">
        <h2 class="panel-title">EQUITY TRACKING</h2>
        <div class="pnl-main" id="equityNow">-</div>
      </div>
      <div class="pnl-meta">
        <span id="equityRange">USD range -</span>
        <span id="equitySpan">-</span>
      </div>
      <div class="toggle-row">
        <button class="toggle-btn equity-toggle-btn active" data-equity-mode="USD">USD</button>
        <button class="toggle-btn equity-toggle-btn" data-equity-mode="BTC">BTC</button>
        <button class="toggle-btn equity-window-btn active" data-equity-window="24h">24H</button>
        <button class="toggle-btn equity-window-btn" data-equity-window="12h">12H</button>
        <button class="toggle-btn equity-window-btn" data-equity-window="4h">4H</button>
        <button class="toggle-btn equity-window-btn" data-equity-window="1h">1H</button>
        <button class="toggle-btn equity-window-btn" data-equity-window="15m">15M</button>
        <button class="btn" id="resetEquityBtn">Reset series</button>
      </div>
      <div class="equity-chart-shell" id="equityChartShell">
        <div class="chart-wrap">
          <svg id="equityChart" viewBox="0 0 1200 300" preserveAspectRatio="none"></svg>
        </div>
        <div class="chart-tooltip" id="equityTooltip"></div>
      </div>
      <div class="equity-sub">
        <span id="compositionLegend">USD total - | BTC notional -</span>
      </div>
      <div class="chart-wrap" style="height:180px; margin-top:8px;">
        <svg id="compositionChart" viewBox="0 0 1200 180" preserveAspectRatio="none"></svg>
      </div>
      <div class="equity-sub" style="margin-top:8px;">
        <span id="drawdownSummary">Max DD: -</span>
        <span>
          <button class="toggle-btn drawdown-toggle-btn active" data-dd-mode="abs">DD Abs</button>
          <button class="toggle-btn drawdown-toggle-btn" data-dd-mode="pct">DD %</button>
        </span>
      </div>
      <div class="chart-wrap" style="height:180px; margin-top:8px;">
        <svg id="drawdownChart" viewBox="0 0 1200 180" preserveAspectRatio="none"></svg>
      </div>
    </section>

    <section class="bottom-grid">
      <article class="panel">
        <h3 class="panel-title">Balances</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Asset</th><th>Free</th><th>Total</th></tr></thead>
            <tbody id="balancesBody"></tbody>
          </table>
        </div>
      </article>

      <article class="panel">
        <h3 class="panel-title">Active Bot Orders</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Client ID</th><th>Side</th><th>Price</th><th>Quote</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody id="ordersBody"></tbody>
          </table>
        </div>
      </article>
    </section>

    <section class="panel events-panel">
      <h3 class="panel-title">Recent Bot Order Events</h3>
      <div class="event-filters" id="eventFilters">
        <button class="event-pill active" data-filter="ALL">ALL</button>
        <button class="event-pill" data-filter="PLACED">PLACED</button>
        <button class="event-pill" data-filter="CANCELLED">CANCELLED</button>
        <button class="event-pill" data-filter="FILLED">FILLED</button>
        <button class="event-pill" data-filter="REPLACED">REPLACED</button>
        <button class="event-pill" data-filter="REJECTED">REJECTED</button>
        <button class="event-pill" data-filter="ERROR">ERROR</button>
        <span class="event-limit-label">max</span>
        <select class="event-limit-select" id="eventLimitSelect" aria-label="Maximum events kept">
          <option value="50">50</option>
          <option value="200">200</option>
          <option value="500">500</option>
          <option value="2000">2000</option>
        </select>
        <span class="event-info" id="eventsInfo">Showing last - events</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Side</th><th>Price</th><th>Size</th><th>Reason</th><th>Client ID</th></tr></thead>
          <tbody id="eventsBody"></tbody>
        </table>
      </div>
    </section>
    </div>

    <section class="panel" id="roadmapView" style="display:none">
      <h3 class="panel-title">Next Milestone Roadmap</h3>
      <div class="roadmap-grid">
        <article class="roadmap-col">
          <h4>Milestone 1</h4>
          <ul>
            <li>Stable post-only maker loop</li>
            <li>TOB micro with guardrails</li>
            <li>Kill switch, pause, circuit breakers</li>
          </ul>
        </article>
        <article class="roadmap-col">
          <h4>Milestone 2 (Current)</h4>
          <ul>
            <li>Adaptive spread + edge-weighted quoting</li>
            <li>Execution health diagnostics</li>
            <li>Bounded, deduped order events</li>
          </ul>
        </article>
        <article class="roadmap-col">
          <h4>Milestone 3 (Scale)</h4>
          <ul>
            <li>Multi-symbol scheduling and risk buckets</li>
            <li>Improved metrics persistence + replay</li>
            <li>Alerts and backtesting harness</li>
          </ul>
        </article>
      </div>
      <div class="readiness">
        <div id="roadmapEdge">Avg edge last 1h: - bps (target &gt; 5)</div>
        <div id="roadmapFills">Fills/hr: - (target 2-4)</div>
        <div id="roadmapCancels">Churn cancels/hr: - (target &lt; 150)</div>
        <div id="roadmapPnl">PnL today: -</div>
      </div>
    </section>
  </div>

  <div class="modal-backdrop" id="confirmModal">
    <div class="modal">
      <h3>Cancel All Bot Orders</h3>
      <p>This will cancel active bot-tagged orders for the current symbol. Continue?</p>
      <div class="modal-actions">
        <button class="btn" id="modalCancel">Back</button>
        <button class="btn warn" id="modalConfirm">Confirm Cancel All</button>
      </div>
    </div>
  </div>

  <script>
    const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });
    const WINDOW_ORDER = ["24h", "12h", "4h", "1h", "15m"];
    const EVENT_LIMIT_OPTIONS = [50, 200, 500, 2000];
    const DEFAULT_MAX_UI_EVENTS = ${Math.min(2000, Math.max(50, maxUiEventsDefault))};

    function normalizeEventLimit(value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return DEFAULT_MAX_UI_EVENTS;
      if (EVENT_LIMIT_OPTIONS.includes(parsed)) return parsed;
      let nearest = EVENT_LIMIT_OPTIONS[0];
      let bestDist = Math.abs(parsed - nearest);
      for (const option of EVENT_LIMIT_OPTIONS) {
        const dist = Math.abs(parsed - option);
        if (dist < bestDist) {
          nearest = option;
          bestDist = dist;
        }
      }
      return nearest;
    }

    ${renderUseEquitySeriesScript({
      maxEquityPointsDefault,
      equitySampleMsDefault,
      persistDefault: persistEquitySeriesDefault,
      symbol
    })}

    ${renderEquityChartScript()}

    ${renderDrawdownChartScript()}

    function useDashboardState() {
      const state = {
        data: null,
        lastSuccessMs: 0,
        lastError: "",
        pnlWindow: "24h",
        equityMode: "USD",
        equityWindow: "24h",
        drawdownMode: "abs",
        eventFilter: "ALL",
        uiEvents: [],
        maxUiEvents: normalizeEventLimit(DEFAULT_MAX_UI_EVENTS),
        maxEquityPoints: eqNormalizeMaxPoints(DEFAULT_MAX_EQUITY_POINTS),
        equitySampleMs: eqNormalizeSampleMs(DEFAULT_EQUITY_SAMPLE_MS),
        persistEquitySeries: DEFAULT_PERSIST_EQUITY_SERIES,
        equityStorageKey: DEFAULT_EQUITY_STORAGE_KEY,
        equitySeries: DEFAULT_PERSIST_EQUITY_SERIES ? eqReadPersistedSeries(DEFAULT_EQUITY_STORAGE_KEY) : [],
        view: "control"
      };
      const listeners = [];
      let inFlight = false;

      function getState() { return state; }
      function subscribe(fn) { listeners.push(fn); return () => { const idx = listeners.indexOf(fn); if (idx >= 0) listeners.splice(idx, 1); }; }
      function notify() { for (const fn of listeners) fn(state); }

      async function refresh() {
        if (inFlight) return;
        inFlight = true;
        try {
          const r = await fetch(
            "/api/status?window=" +
              encodeURIComponent(state.pnlWindow) +
              "&limit=" +
              encodeURIComponent(String(state.maxUiEvents)),
            { cache: "no-store" }
          );
          if (!r.ok) throw new Error("status " + r.status);
          const payload = await r.json();
          const incoming = Array.isArray(payload.recentEvents) ? payload.recentEvents : buildEvents(payload);
          state.uiEvents = mergeEvents(state.uiEvents, incoming, state.maxUiEvents);
          state.equitySeries = useEquitySeries(payload, state.equitySeries, {
            maxPoints: state.maxEquityPoints,
            sampleMs: state.equitySampleMs,
            persist: state.persistEquitySeries,
            storageKey: state.equityStorageKey
          });
          state.data = payload;
          state.lastSuccessMs = Date.now();
          state.lastError = "";
        } catch (err) {
          state.lastError = String(err && err.message ? err.message : err);
        } finally {
          inFlight = false;
          notify();
        }
      }

      async function action(path, body) {
        const r = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {})
        });
        if (!r.ok) {
          const maybe = await r.text();
          throw new Error(maybe || ("action failed " + r.status));
        }
        await refresh();
        return r.json();
      }

      function setWindow(windowKey) {
        if (!WINDOW_ORDER.includes(windowKey)) return;
        state.pnlWindow = windowKey;
        notify();
        void refresh();
      }

      function setEventFilter(filter) {
        state.eventFilter = filter;
        notify();
      }

      function setMaxUiEvents(limit) {
        state.maxUiEvents = normalizeEventLimit(limit);
        state.uiEvents = state.uiEvents.slice(0, state.maxUiEvents);
        notify();
        void refresh();
      }

      function setView(view) {
        if (view !== "control" && view !== "roadmap") return;
        state.view = view;
        notify();
      }

      function setEquityMode(mode) {
        if (mode !== "USD" && mode !== "BTC") return;
        state.equityMode = mode;
        notify();
      }

      function setEquityWindow(windowKey) {
        const valid = ["15m", "1h", "4h", "12h", "24h"];
        if (!valid.includes(windowKey)) return;
        state.equityWindow = windowKey;
        notify();
      }

      function setDrawdownMode(mode) {
        if (mode !== "abs" && mode !== "pct") return;
        state.drawdownMode = mode;
        notify();
      }

      function resetEquitySeries() {
        state.equitySeries = [];
        if (state.persistEquitySeries) {
          eqClearPersistedSeries(state.equityStorageKey);
        }
        notify();
      }

      return {
        getState,
        subscribe,
        refresh,
        setWindow,
        setEventFilter,
        setMaxUiEvents,
        setView,
        setEquityMode,
        setEquityWindow,
        setDrawdownMode,
        resetEquitySeries,
        action
      };
    }

    function el(id) { return document.getElementById(id); }
    function text(id, v) { const node = el(id); if (node) node.textContent = v; }

    function n(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function ts(ms) {
      if (!ms) return "-";
      return new Date(ms).toLocaleTimeString();
    }

    function ageSince(ms) {
      if (!ms) return "-";
      const delta = Math.max(0, Date.now() - Number(ms));
      const totalSeconds = Math.floor(delta / 1000);
      const h = Math.floor(totalSeconds / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = totalSeconds % 60;
      return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    }

    function money(v, d = 2) {
      const x = Number(v);
      if (!Number.isFinite(x)) return "-";
      return x.toFixed(d);
    }

    function parseNumericField(value) {
      if (value === null || value === undefined) return null;
      if (typeof value === "string" && value.trim().length === 0) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function quoteFromOrder(order) {
      const directFields = [
        order.quote_size,
        order.quoteSize,
        order.quoteSizeUsd,
        order.quote_size_usd,
        order.quote_amount,
        order.notional
      ];
      for (const value of directFields) {
        const parsed = parseNumericField(value);
        if (parsed !== null && parsed > 0) return parsed;
      }

      const qty =
        parseNumericField(order.qty) ??
        parseNumericField(order.quantity) ??
        parseNumericField(order.base_size) ??
        parseNumericField(order.size);
      const price = parseNumericField(order.price);
      if (qty !== null && qty > 0 && price !== null && price > 0) {
        return qty * price;
      }
      return null;
    }

    function normalizeAssetCodeForUi(row) {
      if (!row || typeof row !== "object") return "";
      const values = [row.asset, row.currency, row.code, row.ccy, row.symbol];
      for (const value of values) {
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim().toUpperCase();
        }
      }
      return "";
    }

    function findBalanceRow(rows, aliases) {
      if (!Array.isArray(rows)) return null;
      const wanted = new Set((aliases || []).map((value) => String(value).toUpperCase()));
      for (const row of rows) {
        const code = normalizeAssetCodeForUi(row);
        if (wanted.has(code)) return row;
      }
      return null;
    }

    function computeClientEquity(data) {
      const rows = Array.isArray(data && data.balances) ? data.balances : [];
      const ticker = data && data.ticker ? data.ticker : {};
      const mid = n(ticker.mid, 0);
      const usdRow = findBalanceRow(rows, ["USD", "USDC"]);
      const btcRow = findBalanceRow(rows, ["BTC", "XBT"]);
      const usd_total = n(usdRow && usdRow.total, 0);
      const usd_free = n(usdRow && usdRow.free, 0);
      const btc_total = n(btcRow && btcRow.total, 0);
      const btc_free = n(btcRow && btcRow.free, 0);

      if (!(mid > 0)) {
        return {
          mid,
          usd_total,
          usd_free,
          btc_total,
          btc_free,
          equityUsd: 0,
          equityBtc: 0,
          btcNotionalUsd: 0,
          usdNotionalBtc: 0
        };
      }

      const equityUsd = usd_total + btc_total * mid;
      const equityBtc = btc_total + usd_total / mid;
      const btcNotionalUsd = btc_total * mid;
      const usdNotionalBtc = usd_total / mid;
      return {
        mid,
        usd_total,
        usd_free,
        btc_total,
        btc_free,
        equityUsd,
        equityBtc,
        btcNotionalUsd,
        usdNotionalBtc
      };
    }

    function classifyEventType(status) {
      const s = String(status || "").toUpperCase();
      if (!s) return "PLACED";
      if (s.includes("REPLACED")) return "REPLACED";
      if (s.includes("CANCEL")) return "CANCELLED";
      if (s.includes("FILL")) return "FILLED";
      if (s.includes("REJECT")) return "REJECTED";
      if (s.includes("ERROR") || s.includes("FAIL")) return "ERROR";
      return "PLACED";
    }

    function eventBadgeClass(type) {
      if (type === "PLACED") return "b-placed";
      if (type === "CANCELLED") return "b-cancelled";
      if (type === "FILLED") return "b-filled";
      if (type === "REPLACED") return "b-replaced";
      if (type === "REJECTED") return "b-rejected";
      return "b-error";
    }

    function statusToGate(enabled, reasons) {
      if (enabled === null || enabled === undefined) {
        return { short: "unknown", details: "awaiting first strategy cycle", ok: false };
      }
      if (enabled) {
        return { short: "enabled", details: "all checks passed", ok: true };
      }
      const detail = Array.isArray(reasons) && reasons.length > 0 ? reasons.join("; ") : "blocked";
      return { short: "blocked", details: detail, ok: false };
    }

    function buildEvents(data) {
      const events = [];
      const orders = Array.isArray(data.recentBotOrders) ? data.recentBotOrders : [];
      const fills = Array.isArray(data.recentFills) ? data.recentFills : [];
      const rows = Array.isArray(data.recentEvents) ? data.recentEvents : [];

      for (const row of rows) {
        events.push(normalizeIncomingEvent(row));
      }

      for (const row of orders) {
        events.push({
          event_id:
            "order:" +
            String(row.ts || row.updated_at || 0) +
            ":" +
            String(row.status || "") +
            ":" +
            String(row.venue_order_id || "-") +
            ":" +
            String(row.client_order_id || "-"),
          ts: n(row.ts || row.updated_at, 0),
          type: classifyEventType(row.status),
          side: String(row.side || "-"),
          price: n(row.price, Number.NaN),
          size: quoteFromOrder(row),
          reason: String(row.status || ""),
          client_id: String(row.client_order_id || "-"),
          client_order_id: String(row.client_order_id || "-"),
          venue_order_id: String(row.venue_order_id || "-")
        });
      }

      for (const row of fills) {
        events.push({
          event_id: "fill:" + String(row.trade_id || "-") + ":" + String(row.ts || 0),
          ts: n(row.ts, 0),
          type: "FILLED",
          side: "-",
          price: n(row.price, Number.NaN),
          size: n(row.qty, Number.NaN),
          reason: "trade " + String(row.trade_id || "-"),
          client_id: "-",
          client_order_id: "-",
          venue_order_id: String(row.venue_order_id || "-")
        });
      }

      events.sort((a, b) => b.ts - a.ts);
      return events;
    }

    function normalizeIncomingEvent(row) {
      return {
        event_id: String(
            row.event_id ||
            row.eventId ||
            (String(row.ts || 0) +
              ":" +
              String(row.type || "") +
              ":" +
              String(row.venue_order_id || row.order_id || "-") +
              ":" +
              String(row.client_order_id || row.client_id || row.clientId || "-"))
        ),
        ts: n(row.ts, 0),
        type: String(row.type || "PLACED").toUpperCase(),
        side: String(row.side || "-").toUpperCase(),
        price: parseNumericField(row.price),
        size: parseNumericField(row.size ?? row.qty ?? row.quote_size ?? row.quoteSizeUsd),
        reason: String(row.reason || row.status || ""),
        client_id: String(row.client_id || row.clientId || row.client_order_id || "-"),
        client_order_id: String(row.client_order_id || row.client_id || row.clientId || "-"),
        venue_order_id: String(row.venue_order_id || row.venueId || row.order_id || "-")
      };
    }

    function eventKey(row) {
      if (row && row.event_id) return String(row.event_id);
      const venueOrderId = String((row && (row.venue_order_id || row.order_id)) || "-");
      const clientOrderId = String((row && (row.client_order_id || row.client_id || row.clientId)) || "-");
      return (
        String(n(row && row.ts, 0)) +
        "|" +
        String((row && row.type) || "-") +
        "|" +
        venueOrderId +
        "|" +
        clientOrderId
      );
    }

    function mergeEvents(existing, incoming, maxEvents) {
      const merged = [];
      const seen = new Set();
      const combined = []
        .concat(Array.isArray(incoming) ? incoming : [])
        .concat(Array.isArray(existing) ? existing : [])
        .map((row) => normalizeIncomingEvent(row))
        .sort((a, b) => n(b.ts, 0) - n(a.ts, 0));

      for (const row of combined) {
        const key = eventKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(row);
        if (merged.length >= maxEvents) break;
      }

      return merged;
    }

    function renderMissionBar(state) {
      const data = state.data;
      if (!data) return;

      const now = Date.now();
      const connected = state.lastSuccessMs > 0 && now - state.lastSuccessMs < 5000;
      const mode = data.mode || {};
      const modeLabel = mode.dryRun ? "DRY" : "LIVE";

      text("missionSymbol", String(data.symbol || "-"));
      text("missionRunId", String(data.runId || "-"));
      text("missionUptime", String(data.uptimeSeconds || "-"));
      text("missionLast", "last " + ageSince(state.lastSuccessMs));
      text("connectionText", connected ? "connected" : "disconnected");
      text("modeValue", modeLabel + (mode.paused ? " / PAUSED" : ""));

      const dot = el("connectionDot");
      if (dot) {
        dot.classList.remove("live", "dead");
        dot.classList.add(connected ? "live" : "dead");
      }

      const pauseBtn = el("pauseBtn");
      if (pauseBtn) {
        pauseBtn.textContent = mode.paused ? "Resume" : "Pause";
      }
    }

    function renderKpiCards(state) {
      const data = state.data;
      if (!data) return;

      const ticker = data.ticker || {};
      const analytics = data.analytics || {};
      const botStatus = data.botStatus || {};

      const bid = n(ticker.bid, 0);
      const ask = n(ticker.ask, 0);
      const mid = n(ticker.mid, 0);
      const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10000 : 0;

      text("kpiMid", mid > 0 ? fmt.format(mid) : "-");
      text("kpiSpread", bid > 0 && ask > 0 ? money(spreadBps, 2) + " bps" : "-");
      text("kpiActive", String(Array.isArray(data.activeBotOrders) ? data.activeBotOrders.length : 0));
      text("kpiTrend", money(n(analytics.trendMoveBps, n(botStatus.trend_move_bps, 0)), 2) + " bps");

      const edge = analytics.edgeBpsLastFill;
      text("kpiEdge", edge === null || edge === undefined ? "-" : money(edge, 2) + " bps");
      text(
        "kpiEdgeSub",
        "1h avg B " + money(n(analytics.avgEdgeBps1hBuy, 0), 2) + " | S " + money(n(analytics.avgEdgeBps1hSell, 0), 2)
      );

      text("kpiRealized", money(n(analytics.realizedPnlUsd, 0), 2) + " USD");
      text("kpiFills1h", "fills 1h: " + String(n(analytics.fills1hCount, 0)));
      const cancels1h = n(analytics.cancelsLast1h, 0);
      const rejects1h = n(analytics.postOnlyRejectsLast1h, 0);
      const fills30m = n(analytics.fillsLast30m, 0);
      const fills1h = n(analytics.fillsLast1h, n(analytics.fills1hCount, 0));
      const avgRest = n(analytics.avgRestingTimeSeconds, 0);
      const actionBudgetUsed = n(analytics.actionBudgetUsed, 0);
      const actionBudgetMax = Math.max(1, n(analytics.actionBudgetMax, 1));
      const health =
        rejects1h >= 6
          ? "REJECTS"
          : cancels1h > 150
            ? "CHURN"
            : fills30m === 0
              ? "STARVED"
              : "OK";
      text(
        "kpiExecHealth",
        health + " | fills 1h " + String(fills1h) + " | 30m " + String(fills30m)
      );
      text(
        "kpiExecHealthSub",
        "post-only rejects 1h: " +
          String(rejects1h) +
          " | cancels 1h: " +
          String(cancels1h) +
          " | avg rest: " +
          money(avgRest, 1) +
          "s | budget: " +
          String(actionBudgetUsed) +
          "/" +
          String(actionBudgetMax)
      );

      text("kpiSignal", String(analytics.signalVolRegime || "normal"));
      text(
        "kpiSignalSub",
        "drift " +
          money(n(analytics.signalDriftBps, 0), 2) +
          " bps | z " +
          money(n(analytics.signalZScore, 0), 2) +
          " | stdev " +
          money(n(analytics.signalStdevBps, 0), 2) +
          " bps" +
          " | skew " +
          money(n(analytics.signalSkewBpsApplied, 0), 2) +
          " bps | conf " +
          money(n(analytics.signalConfidence, 0), 2)
      );

      text(
        "kpiAdaptive",
        money(n(analytics.effectiveHalfSpreadBps, 0), 2) + " bps"
      );
      text(
        "kpiAdaptiveSub",
        "delta " +
          money(n(analytics.adaptiveSpreadDeltaBps, 0), 2) +
          " bps | target fills/hr " +
          String(n(analytics.targetFillsPerHour, 0)) +
          " | current " +
          String(fills1h)
      );
      const tobMode = String(botStatus.tob_mode || "OFF");
      const tobReason = String(botStatus.tob_reason || "n/a");
      const sellThrottleState = String(botStatus.sell_throttle_state || "NORMAL");
      text(
        "kpiAdaptiveSub2",
        "TOB: " + tobMode + " (" + tobReason + ") | Sell throttle: " + sellThrottleState
      );
      const adaptiveReasons = Array.isArray(analytics.adaptiveAdjustments)
        ? analytics.adaptiveAdjustments
        : [];
      const reasonNode = el("kpiAdaptiveReasons");
      if (reasonNode) {
        reasonNode.innerHTML = adaptiveReasons.length
          ? adaptiveReasons
              .map((reason) => '<span class="tiny-chip">' + escapeHtml(String(reason)) + "</span>")
              .join("")
          : '<span class="tiny-chip">NONE</span>';
      }

      const equity = computeClientEquity(data);
      const hasMid = equity.mid > 0;
      text("kpiEquityUsd", hasMid ? "$" + money(equity.equityUsd, 2) : "-");
      text("kpiEquityUsdSub", hasMid ? "BTC notional: $" + money(equity.btcNotionalUsd, 2) : "BTC notional: -");
      text("kpiEquityBtc", hasMid ? money(equity.equityBtc, 6) + " BTC" : "-");
      text("kpiEquityBtcSub", hasMid ? "USD notional: " + money(equity.usdNotionalBtc, 8) + " BTC" : "USD notional: -");
      text("kpiUsdTotal", "$" + money(equity.usd_total, 2));
      text("kpiUsdFree", "free: $" + money(equity.usd_free, 2));
      text("kpiBtcTotal", money(equity.btc_total, 6) + " BTC");
      text("kpiBtcFree", "free: " + money(equity.btc_free, 8) + " BTC");
      text("kpiBtcNotionalUsd", hasMid ? "$" + money(equity.btcNotionalUsd, 2) : "-");
      text("kpiBtcNotionalSub", hasMid ? "at mid " + money(equity.mid, 2) : "mid unavailable");
    }

    function renderPnlPanel(state) {
      const data = state.data;
      if (!data) return;

      const summary = data.pnlSummary || {};
      const series = Array.isArray(data.pnlSeries) ? data.pnlSeries : [];
      const botStatus = data.botStatus || {};

      text("pnlNow", "PnL " + money(n(summary.pnlUsd, 0), 2) + " USD");
      text(
        "pnlRange",
        String(data.pnlWindow || "24h").toUpperCase() +
          " range " +
          money(n(summary.minPnlUsd, 0), 2) +
          " to " +
          money(n(summary.maxPnlUsd, 0), 2)
      );

      const spanStart = series.length > 0 ? ts(series[0].ts) : "-";
      const spanEnd = series.length > 0 ? ts(series[series.length - 1].ts) : "-";
      text("pnlSpan", spanStart + " to " + spanEnd);

      const buyGate = statusToGate(botStatus.allow_buy, botStatus.buy_reasons || []);
      const sellGate = statusToGate(botStatus.allow_sell, botStatus.sell_reasons || []);

      const buyChip = el("buyGateChip");
      if (buyChip) {
        buyChip.textContent = "Buy: " + buyGate.short;
        buyChip.classList.remove("ok", "block");
        buyChip.classList.add(buyGate.ok ? "ok" : "block");
      }

      const sellChip = el("sellGateChip");
      if (sellChip) {
        sellChip.textContent = "Sell: " + sellGate.short;
        sellChip.classList.remove("ok", "block");
        sellChip.classList.add(sellGate.ok ? "ok" : "block");
      }

      text("gateLine", "Buy: " + buyGate.short + " | Sell: " + sellGate.short);

      const toggles = document.querySelectorAll("#windowToggles .toggle-btn");
      toggles.forEach((btn) => {
        const win = btn.getAttribute("data-window");
        btn.classList.toggle("active", win === state.pnlWindow);
      });

      renderChart(series);
    }

    function renderChart(series) {
      const svg = el("pnlChart");
      if (!svg) return;

      if (!Array.isArray(series) || series.length === 0) {
        svg.innerHTML = '<text x="20" y="44" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="15">No PnL data yet</text>';
        return;
      }

      const W = 1200;
      const H = 300;
      const PADX = 46;
      const PADY = 28;
      const values = series.map((p) => n(p.pnlUsd, 0));
      let min = Math.min.apply(null, values);
      let max = Math.max.apply(null, values);
      if (min === max) {
        min -= 1;
        max += 1;
      }
      const range = max - min;
      const xSpan = Math.max(1, series.length - 1);

      const x = (idx) => PADX + (idx / xSpan) * (W - PADX * 2);
      const y = (val) => H - PADY - ((val - min) / range) * (H - PADY * 2);

      const zeroVal = min > 0 ? min : (max < 0 ? max : 0);
      const yZero = y(zeroVal);
      const lastVal = values[values.length - 1];
      const up = lastVal >= 0;
      const stroke = up ? "#21e3a2" : "#ff6d7c";
      const fill = up ? "rgba(33, 227, 162, 0.16)" : "rgba(255, 109, 124, 0.18)";

      let line = "";
      for (let i = 0; i < series.length; i += 1) {
        line += (i === 0 ? "M " : " L ") + x(i).toFixed(2) + " " + y(values[i]).toFixed(2);
      }

      const area =
        line +
        " L " +
        x(series.length - 1).toFixed(2) +
        " " +
        yZero.toFixed(2) +
        " L " +
        x(0).toFixed(2) +
        " " +
        yZero.toFixed(2) +
        " Z";

      const maxY = y(max).toFixed(2);
      const minY = y(min).toFixed(2);
      const lastX = x(series.length - 1).toFixed(2);
      const lastY = y(lastVal).toFixed(2);

      svg.innerHTML =
        '<line x1="' + PADX + '" y1="' + yZero.toFixed(2) + '" x2="' + (W - PADX) + '" y2="' + yZero.toFixed(2) + '" stroke="rgba(143,166,193,0.4)" stroke-width="1" />' +
        '<line x1="' + PADX + '" y1="' + maxY + '" x2="' + (W - PADX) + '" y2="' + maxY + '" stroke="rgba(255,255,255,0.08)" stroke-width="1" />' +
        '<line x1="' + PADX + '" y1="' + minY + '" x2="' + (W - PADX) + '" y2="' + minY + '" stroke="rgba(255,255,255,0.08)" stroke-width="1" />' +
        '<path d="' + area + '" fill="' + fill + '" />' +
        '<path d="' + line + '" fill="none" stroke="' + stroke + '" stroke-width="3" stroke-linecap="round" />' +
        '<circle cx="' + lastX + '" cy="' + lastY + '" r="4" fill="' + stroke + '" />' +
        '<text x="' + (PADX + 6) + '" y="' + (Number(maxY) - 8) + '" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="12">max ' + money(max, 2) + '</text>' +
        '<text x="' + (PADX + 6) + '" y="' + (Number(minY) - 8) + '" fill="#8fa6c1" font-family="IBM Plex Mono, Menlo, monospace" font-size="12">min ' + money(min, 2) + '</text>';
    }

    function renderBalances(state) {
      const data = state.data;
      if (!data) return;
      const rows = Array.isArray(data.balances) ? data.balances : [];
      const body = el("balancesBody");
      if (!body) return;
      if (rows.length === 0) {
        body.innerHTML = '<tr><td colspan="3" style="color:#8fa6c1">none</td></tr>';
        return;
      }

      body.innerHTML = rows
        .map((row) =>
          '<tr>' +
            '<td>' + String(row.asset || "-") + '</td>' +
            '<td>' + money(row.free, 8) + '</td>' +
            '<td>' + money(row.total, 8) + '</td>' +
          '</tr>'
        )
        .join("");
    }

    function renderOrders(state) {
      const data = state.data;
      if (!data) return;
      const rows = Array.isArray(data.activeBotOrders) ? data.activeBotOrders : [];
      const body = el("ordersBody");
      if (!body) return;
      if (rows.length === 0) {
        body.innerHTML = '<tr><td colspan="6" style="color:#8fa6c1">none</td></tr>';
        return;
      }

      body.innerHTML = rows
        .map((row) => {
          const side = String(row.side || "-").toUpperCase();
          const sideClass = side === "BUY" ? "side-buy" : side === "SELL" ? "side-sell" : "";
          const clientId = String(row.client_order_id || "-");
          const quote = quoteFromOrder(row);
          return (
            '<tr>' +
              '<td><span>' + escapeHtml(clientId) + '</span><button class="copy-btn" data-copy="' + escapeHtml(clientId) + '">copy</button></td>' +
              '<td class="' + sideClass + '">' + side + '</td>' +
              '<td>' + money(row.price, 2) + '</td>' +
              '<td>' + (quote === null ? '-' : money(quote, 2)) + '</td>' +
              '<td>' + escapeHtml(String(row.status || "-")) + '</td>' +
              '<td>' + ts(row.updated_at) + '</td>' +
            '</tr>'
          );
        })
        .join("");
    }

    function renderEvents(state) {
      const filter = state.eventFilter;
      const allEvents = Array.isArray(state.uiEvents) ? state.uiEvents : [];
      const events = filter === "ALL" ? allEvents : allEvents.filter((row) => row.type === filter);
      text("eventsInfo", "Showing last " + String(state.maxUiEvents) + " events");

      document.querySelectorAll(".event-pill").forEach((node) => {
        const val = node.getAttribute("data-filter");
        node.classList.toggle("active", val === filter);
      });

      const body = el("eventsBody");
      if (!body) return;
      if (events.length === 0) {
        body.innerHTML = '<tr><td colspan="7" style="color:#8fa6c1">none</td></tr>';
        return;
      }

      body.innerHTML = events
        .slice(0, state.maxUiEvents)
        .map((row) => {
          const side = String(row.side || "-").toUpperCase();
          const sideClass = side === "BUY" ? "side-buy" : side === "SELL" ? "side-sell" : "";
          return (
            '<tr>' +
              '<td>' + ts(row.ts) + '</td>' +
              '<td><span class="badge ' + eventBadgeClass(row.type) + '">' + row.type + '</span></td>' +
              '<td class="' + sideClass + '">' + side + '</td>' +
              '<td>' + (Number.isFinite(row.price) ? money(row.price, 2) : '-') + '</td>' +
              '<td>' + (Number.isFinite(row.size) ? money(row.size, 8) : '-') + '</td>' +
              '<td>' + escapeHtml(row.reason || "-") + '</td>' +
              '<td>' + escapeHtml(row.client_id || "-") + '</td>' +
            '</tr>'
          );
        })
        .join("");
    }

    function renderRoadmap(state) {
      const data = state.data;
      if (!data) return;
      const analytics = data.analytics || {};
      text(
        "roadmapEdge",
        "Avg edge last 1h: " + money((n(analytics.avgEdgeBps1hBuy, 0) + n(analytics.avgEdgeBps1hSell, 0)) / 2, 2) + " bps (target > 5)"
      );
      text(
        "roadmapFills",
        "Fills/hr: " + String(n(analytics.fillsLast1h, n(analytics.fills1hCount, 0))) + " (target 2-4)"
      );
      text(
        "roadmapCancels",
        "Churn cancels/hr: " + String(n(analytics.cancelsLast1h, 0)) + " (target < 150)"
      );
      text("roadmapPnl", "PnL today: " + money(n(analytics.realizedPnlUsd, 0), 2) + " USD");
    }

    function render(state) {
      renderMissionBar(state);
      renderRoadmap(state);
      const controlView = el("controlView");
      const roadmapView = el("roadmapView");
      const isControl = state.view !== "roadmap";
      if (controlView) controlView.style.display = isControl ? "" : "none";
      if (roadmapView) roadmapView.style.display = isControl ? "none" : "";
      document.querySelectorAll(".view-tab").forEach((node) => {
        const value = node.getAttribute("data-view");
        node.classList.toggle("active", value === state.view);
      });
      if (isControl) {
        renderKpiCards(state);
        renderPnlPanel(state);
        renderEquityPanel(state);
        renderBalances(state);
        renderOrders(state);
        renderEvents(state);
      }
      const eventLimitSelect = el("eventLimitSelect");
      if (eventLimitSelect && String(eventLimitSelect.value) !== String(state.maxUiEvents)) {
        eventLimitSelect.value = String(state.maxUiEvents);
      }
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    const store = useDashboardState();
    store.subscribe(render);

    document.querySelectorAll("#windowToggles .toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const windowKey = btn.getAttribute("data-window");
        if (!windowKey) return;
        store.setWindow(windowKey);
      });
    });

    document.querySelectorAll(".equity-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-equity-mode");
        if (!mode) return;
        store.setEquityMode(mode);
      });
    });

    document.querySelectorAll(".equity-window-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const windowKey = btn.getAttribute("data-equity-window");
        if (!windowKey) return;
        store.setEquityWindow(windowKey);
      });
    });

    document.querySelectorAll(".drawdown-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-dd-mode");
        if (!mode) return;
        store.setDrawdownMode(mode);
      });
    });

    const resetEquityBtn = el("resetEquityBtn");
    if (resetEquityBtn) {
      resetEquityBtn.addEventListener("click", () => {
        store.resetEquitySeries();
      });
    }

    document.querySelectorAll(".view-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.getAttribute("data-view");
        if (!view) return;
        store.setView(view);
      });
    });

    document.querySelectorAll(".event-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        const filter = btn.getAttribute("data-filter");
        if (!filter) return;
        store.setEventFilter(filter);
      });
    });

    const eventLimitSelect = el("eventLimitSelect");
    if (eventLimitSelect) {
      eventLimitSelect.value = String(store.getState().maxUiEvents);
      eventLimitSelect.addEventListener("change", () => {
        store.setMaxUiEvents(eventLimitSelect.value);
      });
    }

    let showingGate = "";
    document.querySelectorAll(".gate-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-gate") || "";
        const state = store.getState();
        const data = state.data;
        const detailsNode = el("gateDetails");
        if (!data || !detailsNode) return;
        const bot = data.botStatus || {};
        const details = key === "buy" ? (bot.buy_reasons || []) : (bot.sell_reasons || []);

        if (showingGate === key) {
          showingGate = "";
          detailsNode.style.display = "none";
          detailsNode.textContent = "";
          return;
        }

        showingGate = key;
        detailsNode.style.display = "block";
        detailsNode.textContent = (details && details.length > 0) ? details.join("; ") : "No reason details available";
      });
    });

    async function doCancelAll() {
      await store.action("/api/action/cancel-all", {});
    }

    async function togglePause() {
      const state = store.getState();
      const data = state.data || {};
      const mode = data.mode || {};
      await store.action("/api/action/pause", { paused: !mode.paused });
    }

    async function triggerKill() {
      if (!confirm("Arm kill switch and cancel bot orders?")) return;
      await store.action("/api/action/kill-switch", {});
    }

    const modal = el("confirmModal");
    const openModal = () => { if (modal) modal.style.display = "flex"; };
    const closeModal = () => { if (modal) modal.style.display = "none"; };

    const cancelBtn = el("cancelBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", openModal);

    const modalCancel = el("modalCancel");
    if (modalCancel) modalCancel.addEventListener("click", closeModal);

    const modalConfirm = el("modalConfirm");
    if (modalConfirm) {
      modalConfirm.addEventListener("click", async () => {
        closeModal();
        try {
          await doCancelAll();
        } catch (err) {
          alert("Cancel-all failed: " + String(err && err.message ? err.message : err));
        }
      });
    }

    const pauseBtn = el("pauseBtn");
    if (pauseBtn) {
      pauseBtn.addEventListener("click", async () => {
        try {
          await togglePause();
        } catch (err) {
          alert("Pause/resume failed: " + String(err && err.message ? err.message : err));
        }
      });
    }

    const killBtn = el("killBtn");
    if (killBtn) {
      killBtn.addEventListener("click", async () => {
        try {
          await triggerKill();
        } catch (err) {
          alert("Kill-switch failed: " + String(err && err.message ? err.message : err));
        }
      });
    }

    document.addEventListener("click", (evt) => {
      const target = evt.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches(".copy-btn")) {
        const value = target.getAttribute("data-copy") || "";
        if (!value || value === "-") return;
        navigator.clipboard.writeText(value).catch(() => {});
      }
    });

    document.addEventListener("keydown", (evt) => {
      if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
      const tag = (evt.target && evt.target.tagName ? String(evt.target.tagName) : "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      if (evt.key === "p" || evt.key === "P") {
        evt.preventDefault();
        void togglePause().catch((err) => {
          alert("Pause/resume failed: " + String(err && err.message ? err.message : err));
        });
      }

      if (evt.key === "c" || evt.key === "C") {
        evt.preventDefault();
        openModal();
      }

      if (evt.key === "Escape") {
        closeModal();
      }
    });

    void store.refresh();
    setInterval(() => { void store.refresh(); }, 2000);
  </script>
</body>
</html>`;
}
