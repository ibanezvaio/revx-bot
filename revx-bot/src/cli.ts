import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { Execution } from "./exec/Execution";
import { buildLogger } from "./logger";
import { MarketData } from "./md/MarketData";
import { localDayStartTs } from "./metrics/PnL";
import { findAsset, parseBalancesPayload } from "./recon/balanceParsing";
import { Reconciler } from "./recon/Reconciler";
import { RevXClient } from "./revx/RevXClient";
import { RiskManager } from "./risk/RiskManager";
import { SignalEngine } from "./signals/SignalEngine";
import { createStore } from "./store/factory";
import { MakerStrategy } from "./strategy/MakerStrategy";
import { sleep } from "./util/time";

async function run(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const args = process.argv.slice(3);
  const config = loadConfig();
  const logger = buildLogger(config);
  let store: ReturnType<typeof createStore> | null = null;

  try {
    if (command === "dry-run") {
      const dryConfig = { ...config, dryRun: true };
      const dryLogger = buildLogger(dryConfig);
      const dryClient = new RevXClient(dryConfig, dryLogger);
      const dryStore = createStore(dryConfig, dryLogger);
      dryStore.init();

      const marketData = new MarketData(dryClient, dryLogger);
      const risk = new RiskManager(dryConfig, dryLogger);
      const signalEngine = new SignalEngine(dryConfig);
      const execution = new Execution(dryConfig, dryLogger, dryClient, dryStore, true);
      const dryReconciler = new Reconciler(dryConfig, dryLogger, dryClient, dryStore, marketData);
      const strategy = new MakerStrategy(
        dryConfig,
        dryLogger,
        dryClient,
        dryStore,
        marketData,
        execution,
        dryReconciler,
        risk,
        signalEngine
      );

      await strategy.runSingleCycle();
      // eslint-disable-next-line no-console
      console.log("Dry-run cycle completed.");
      dryStore.close();
      return;
    }

    if (command === "simulate") {
      const minutes = clamp(parseArgNumber(args, "--minutes", 5), 1, 240);
      const dryConfig = {
        ...config,
        dryRun: true,
        mockMode: true,
        revxApiKey: "MOCK-API-KEY",
        revxPrivateKeyBase64: undefined,
        revxPrivateKeyPath: undefined
      };
      const dryLogger = buildLogger(dryConfig);
      const dryClient = new RevXClient(dryConfig, dryLogger);
      const dryStore = createStore(dryConfig, dryLogger);
      dryStore.init();

      const marketData = new MarketData(dryClient, dryLogger);
      const risk = new RiskManager(dryConfig, dryLogger);
      const signalEngine = new SignalEngine(dryConfig);
      const execution = new Execution(dryConfig, dryLogger, dryClient, dryStore, true);
      const dryReconciler = new Reconciler(dryConfig, dryLogger, dryClient, dryStore, marketData);
      const strategy = new MakerStrategy(
        dryConfig,
        dryLogger,
        dryClient,
        dryStore,
        marketData,
        execution,
        dryReconciler,
        risk,
        signalEngine
      );

      const cycles = Math.max(1, Math.ceil((minutes * 60) / Math.max(dryConfig.refreshSeconds, 1)));
      // eslint-disable-next-line no-console
      console.log(`Simulating ${cycles} cycles (~${minutes}m) in DRY_RUN mode...`);
      for (let i = 0; i < cycles; i += 1) {
        await strategy.runSingleCycle();
        const decision = dryStore.getRecentStrategyDecisions(1)[0];
        const details = parseDecisionDetails(decision?.details_json ?? "");
        const effective = Number(details.effective_half_spread_bps_after_adaptive);
        const delta = Number(details.adaptive_spread_bps_delta);
        const reasons = Array.isArray(details.adaptive_adjustments_applied)
          ? details.adaptive_adjustments_applied.map((v) => String(v))
          : [];
        const targets = Array.isArray(details.target_prices)
          ? details.target_prices
              .slice(0, 6)
              .map((q) => ({
                tag: String((q as Record<string, unknown>).tag ?? "-"),
                side: String((q as Record<string, unknown>).side ?? "-"),
                level: String((q as Record<string, unknown>).level ?? "-"),
                price: Number((q as Record<string, unknown>).price ?? 0),
                quote_size_usd: Number((q as Record<string, unknown>).quote_size_usd ?? 0)
              }))
          : [];

        // eslint-disable-next-line no-console
        console.log(
          `[${i + 1}/${cycles}] halfSpread=${fmt(effective, 2)} bps delta=${fmt(delta, 2)} bps reasons=${reasons.length ? reasons.join(",") : "none"}`
        );
        // eslint-disable-next-line no-console
        console.table(targets);

        if (i < cycles - 1) {
          await sleep(Math.max(250, dryConfig.refreshSeconds * 1000));
        }
      }

      dryStore.close();
      // eslint-disable-next-line no-console
      console.log("Simulation complete.");
      return;
    }

    store = createStore(config, logger);
    store.init();
    const client = new RevXClient(config, logger);
    const marketData = new MarketData(client, logger);
    const reconciler = new Reconciler(config, logger, client, store, marketData);

    if (command === "status") {
      await reconciler.reconcileOnce();
      const balances = store.getLatestBalances();
      const ticker = store.getRecentTickerSnapshots(config.symbol, 1)[0];
      const mid = ticker?.mid ?? 0;
      const usd = findAsset(balances, ["USD", "USDC"]);
      const btc = findAsset(balances, ["BTC", "XBT"]);
      const btcNotional = (btc?.total ?? 0) * mid;
      const inventoryRatio = clamp(
        (btcNotional - config.targetBtcNotionalUsd) /
          Math.max(1, config.maxBtcNotionalUsd - config.targetBtcNotionalUsd),
        -1,
        1
      );

      const botStatus = store.getBotStatus();
      const skewAppliedBps = botStatus?.skew_bps_applied ?? inventoryRatio * config.skewMaxBps;

      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      const fills1h = store.getFillsSince(oneHourAgo);
      let buyEdgeSum = 0;
      let buyEdgeCount = 0;
      let sellEdgeSum = 0;
      let sellEdgeCount = 0;

      for (const fill of fills1h) {
        if (!Number.isFinite(fill.edge_bps ?? Number.NaN)) continue;
        const side = store.getOrderByVenueId(fill.venue_order_id)?.side;
        if (side === "BUY") {
          buyEdgeSum += fill.edge_bps as number;
          buyEdgeCount += 1;
        } else if (side === "SELL") {
          sellEdgeSum += fill.edge_bps as number;
          sellEdgeCount += 1;
        }
      }

      const avgEdgeBuy1h = buyEdgeCount > 0 ? buyEdgeSum / buyEdgeCount : 0;
      const avgEdgeSell1h = sellEdgeCount > 0 ? sellEdgeSum / sellEdgeCount : 0;

      const todayStart = localDayStartTs();
      const todayPnlSeries = store.getMetrics("realized_pnl_usd", todayStart, 10_000);
      const latestPnlMetric = store.getMetrics("realized_pnl_usd", 0, 1)[0];
      const latestPnl = latestPnlMetric?.value ?? 0;
      const startOfDayPnl =
        todayPnlSeries.length > 0 ? todayPnlSeries[todayPnlSeries.length - 1].value : latestPnl;
      const realizedPnlToday = latestPnl - startOfDayPnl;

      const activeBot = store.getActiveBotOrders(config.symbol);
      const grouped = activeBot.map((o) => {
        const parsed = parseBotTag(o.bot_tag ?? "");
        return {
          side: parsed.side,
          level: parsed.level,
          price: o.price,
          quote_size: o.quote_size,
          status: o.status,
          age_sec: Math.max(0, Math.floor((Date.now() - o.created_at) / 1000)),
          bot_tag: o.bot_tag ?? "-"
        };
      });

      const recentFills = store.getRecentFills(10);
      const decisions = store.getRecentStrategyDecisions(5).map((d) => {
        const details = parseDecisionDetails(d.details_json);
        return {
          ts: new Date(d.ts).toISOString(),
          mid: d.mid,
          spread_mult: d.spread_mult,
          inventory_ratio: d.inventory_ratio,
          bid_half_spread_bps: coerceNumber(details.bid_half_spread_bps),
          ask_half_spread_bps: coerceNumber(details.ask_half_spread_bps),
          inventory_skew_bps: coerceNumber(details.inventory_skew_bps),
          trend_move_bps: coerceNumber(details.trend_move_bps)
        };
      });

      // eslint-disable-next-line no-console
      console.log(`Symbol: ${config.symbol}`);
      // eslint-disable-next-line no-console
      console.log(`DRY_RUN: ${config.dryRun}`);
      // eslint-disable-next-line no-console
      console.log(
        `USD free: ${fmt(usd?.free ?? 0, 2)} | USD total: ${fmt(usd?.total ?? 0, 2)} | BTC free: ${fmt(
          btc?.free ?? 0,
          8
        )} | BTC total: ${fmt(btc?.total ?? 0, 8)} | BTC notional: ${fmt(btcNotional, 2)}`
      );
      // eslint-disable-next-line no-console
      console.log(
        `inventory ratio: ${fmt(inventoryRatio, 3)} | skew applied: ${fmt(skewAppliedBps, 2)} bps`
      );
      // eslint-disable-next-line no-console
      console.log(
        `TOB mode: ${String(botStatus?.tob_mode ?? "OFF")} | TOB reason: ${String(
          botStatus?.tob_reason ?? "n/a"
        )} | sell throttle: ${String(botStatus?.sell_throttle_state ?? "NORMAL")}`
      );
      // eslint-disable-next-line no-console
      console.log(
        `fills_1h: ${fills1h.length} | avg edge bps (BUY 1h): ${fmt(avgEdgeBuy1h, 2)} | avg edge bps (SELL 1h): ${fmt(avgEdgeSell1h, 2)}`
      );
      // eslint-disable-next-line no-console
      console.log(`realized PnL (today): ${fmt(realizedPnlToday, 2)} USD`);

      // eslint-disable-next-line no-console
      console.log("\nActive Bot Orders (grouped):");
      // eslint-disable-next-line no-console
      console.table(grouped);

      // eslint-disable-next-line no-console
      console.log("\nLast 10 Fills:");
      // eslint-disable-next-line no-console
      console.table(recentFills);

      // eslint-disable-next-line no-console
      console.log("\nLast 5 Strategy Decisions:");
      // eslint-disable-next-line no-console
      console.table(decisions);

      if (config.debugBalances) {
        const rawBalances = await client.getBalances();
        const parsedBalances = parseBalancesPayload(rawBalances, Date.now());
        // eslint-disable-next-line no-console
        console.log("\nRaw Balance Sources (DEBUG_BALANCES=true):");
        // eslint-disable-next-line no-console
        console.table(
          parsedBalances.diagnostics.map((row) => ({
            asset: row.asset,
            raw_asset: row.rawAsset,
            available: row.availableRaw,
            free: row.freeRaw,
            tradable: row.tradableRaw,
            balance: row.balanceRaw,
            total: row.totalRaw,
            locked: row.lockedRaw,
            parsed_free: row.parsedFree,
            parsed_total: row.parsedTotal
          }))
        );
      }

      return;
    }

    if (command === "balances") {
      const rawFlag = args.includes("--raw");
      const rawBalances = await client.getBalances();
      const parsedBalances = parseBalancesPayload(rawBalances, Date.now());
      const usd = findAsset(parsedBalances.snapshots, ["USD", "USDC"]);
      const btc = findAsset(parsedBalances.snapshots, ["BTC", "XBT"]);

      // eslint-disable-next-line no-console
      console.log(`Parsed balances:`);
      // eslint-disable-next-line no-console
      console.table([
        {
          usd_free: usd?.free ?? 0,
          usd_total: usd?.total ?? 0,
          btc_free: btc?.free ?? 0,
          btc_total: btc?.total ?? 0
        }
      ]);

      if (rawFlag || config.debugBalances) {
        // eslint-disable-next-line no-console
        console.log("\nRaw asset payload fields:");
        // eslint-disable-next-line no-console
        console.table(
          parsedBalances.diagnostics.map((row) => ({
            asset: row.asset,
            raw_asset: row.rawAsset,
            keys: row.keys.join(","),
            available: row.availableRaw,
            free: row.freeRaw,
            tradable: row.tradableRaw,
            balance: row.balanceRaw,
            total: row.totalRaw,
            locked: row.lockedRaw,
            parsed_free: row.parsedFree,
            parsed_total: row.parsedTotal
          }))
        );
      }

      return;
    }

    if (command === "cancel-all") {
      const all = args.includes("--all");
      const execution = new Execution(config, logger, client, store, config.dryRun);
      await reconciler.reconcileOnce();

      if (all) {
        const activeOrders = await client.getActiveOrders(config.symbol);
        let cancelled = 0;
        for (const row of activeOrders) {
          const obj = row as Record<string, unknown>;
          const venueOrderId = pickString(obj, ["venue_order_id", "order_id", "id"]);
          if (!venueOrderId) continue;
          await execution.cancelOrder(venueOrderId);
          cancelled += 1;
        }
        // eslint-disable-next-line no-console
        console.log(`Cancelled ${cancelled} active order(s) for ${config.symbol} (--all).`);
      } else {
        const activeBot = store.getActiveBotOrders(config.symbol);
        let cancelled = 0;
        for (const order of activeBot) {
          if (!order.venue_order_id) continue;
          await execution.cancelOrder(order.venue_order_id);
          cancelled += 1;
        }
        // eslint-disable-next-line no-console
        console.log(`Cancelled ${cancelled} bot-tagged order(s) for ${config.symbol}.`);
      }
      return;
    }

    if (command === "tune") {
      const apply = args.includes("--apply");
      const since = Date.now() - 60 * 60 * 1000;
      const fills = store.getFillsSince(since);
      const decisions = store
        .getRecentStrategyDecisions(1_000)
        .filter((d) => d.ts >= since);
      const pnlMetric = store.getMetrics("realized_pnl_usd", since, 1)[0];
      const realizedPnl = pnlMetric?.value ?? 0;
      const invValues = decisions.map((d) => d.inventory_ratio);
      const invSwing = invValues.length > 1 ? Math.max(...invValues) - Math.min(...invValues) : 0;

      let suggestedSpread = config.baseHalfSpreadBps;
      let rationale = "No change suggested";

      if (fills.length === 0) {
        suggestedSpread = Math.max(8, config.baseHalfSpreadBps - 2);
        rationale = "No fills in last hour -> tighten base half spread by 2 bps";
      } else if (realizedPnl < 0 && invSwing > 0.6) {
        suggestedSpread = Math.min(80, config.baseHalfSpreadBps + 5);
        rationale = "Adverse selection risk (negative PnL + high inventory swing) -> widen by 5 bps";
      } else if (realizedPnl < 0) {
        suggestedSpread = Math.min(80, config.baseHalfSpreadBps + 3);
        rationale = "Negative realized PnL -> widen by 3 bps";
      }

      // eslint-disable-next-line no-console
      console.log(
        `fills_1h=${fills.length} realized_pnl=${fmt(realizedPnl, 2)} inv_swing=${fmt(invSwing, 3)}`
      );
      // eslint-disable-next-line no-console
      console.log(
        `BASE_HALF_SPREAD_BPS current=${config.baseHalfSpreadBps} suggested=${suggestedSpread}`
      );
      // eslint-disable-next-line no-console
      console.log(`Rationale: ${rationale}`);

      if (apply && suggestedSpread !== config.baseHalfSpreadBps) {
        const envPath = join(process.cwd(), ".env");
        const raw = readFileSync(envPath, "utf8");
        const updated = upsertEnvValue(raw, "BASE_HALF_SPREAD_BPS", String(suggestedSpread));
        writeFileSync(envPath, updated, "utf8");
        // eslint-disable-next-line no-console
        console.log(`Applied BASE_HALF_SPREAD_BPS=${suggestedSpread} to ${envPath}`);
      }
      return;
    }

    // eslint-disable-next-line no-console
    console.error(
      "Unknown command: " +
        command +
        ". Use: status | balances [--raw] | cancel-all [--all] | dry-run | simulate [--minutes N] | tune [--apply]"
    );
    process.exitCode = 1;
  } finally {
    if (store) {
      store.close();
    }
  }
}

function parseBotTag(tag: string): { side: string; level: number; tag: string } {
  const m = /-(BUY|SELL)-L(\d+)$/.exec(tag);
  if (!m) return { side: "?", level: -1, tag };
  return { side: m[1], level: Number(m[2]), tag };
}

function parseDecisionDetails(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function coerceNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function fmt(v: number, decimals: number): string {
  return Number.isFinite(v) ? v.toFixed(decimals) : "-";
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function parseArgNumber(args: string[], flag: string, fallback: number): number {
  const idx = args.findIndex((arg) => arg === flag);
  if (idx < 0) return fallback;
  const raw = args[idx + 1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function upsertEnvValue(raw: string, key: string, value: string): string {
  const lines = raw.split(/\r?\n/);
  let updated = false;
  const out = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      updated = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!updated) out.push(`${key}=${value}`);
  return out.join("\n");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
