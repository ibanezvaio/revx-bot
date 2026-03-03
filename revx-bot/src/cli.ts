import "dotenv/config";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "./config";
import { Execution } from "./exec/Execution";
import { buildLogger } from "./logger";
import { MarketData } from "./md/MarketData";
import { localDayStartTs } from "./metrics/PnL";
import { findAsset, parseBalancesPayload } from "./recon/balanceParsing";
import { Reconciler } from "./recon/Reconciler";
import { RevXClient } from "./revx/RevXClient";
import { RiskManager } from "./risk/RiskManager";
import { CrossVenueSignalEngine } from "./signal/CrossVenueSignalEngine";
import { SignalEngine } from "./signals/SignalEngine";
import { createStore } from "./store/factory";
import { MakerStrategy } from "./strategy/MakerStrategy";
import { sleep } from "./util/time";
import { PolymarketEngine } from "./polymarket/PolymarketEngine";
import { PolymarketClient } from "./polymarket/PolymarketClient";
import { GammaSeedScanner } from "./polymarket/GammaSeedScanner";
import { MarketScanner } from "./polymarket/MarketScanner";


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
      const crossVenueSignalEngine = new CrossVenueSignalEngine(dryConfig, dryLogger);
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
        signalEngine,
        crossVenueSignalEngine
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
      const crossVenueSignalEngine = new CrossVenueSignalEngine(dryConfig, dryLogger);
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
        signalEngine,
        crossVenueSignalEngine
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

    if (command === "polymarket") {
      const subcommand = args[0] ?? "";
      const isPing = subcommand === "ping" || args.includes("--ping");
      const isWhoAmI = subcommand === "whoami";
      const isDeriveCreds = subcommand === "derive-creds";
      const isPaperRun = subcommand === "paper";
      const isScan = subcommand === "scan";
      const isBook = subcommand === "book";
      const isResolveEvent = subcommand === "resolve-event";
      const isLagSummary = subcommand === "lag-summary";
      const btc5m = args.includes("--btc5m");
      if (!isPing && !isWhoAmI && !isDeriveCreds && !isPaperRun && !isScan && !isBook && !isResolveEvent && !isLagSummary && !btc5m) {
        throw new Error("polymarket command requires one of: ping | whoami | derive-creds | lag-summary [--minutes N] | scan --btc5m | resolve-event --slug <slug> | book --token-id <id> | paper --btc5m | --btc5m");
      }
      if (isPaperRun && !btc5m) {
        throw new Error("polymarket paper requires --btc5m");
      }
      if (isScan && !btc5m) {
        throw new Error("polymarket scan requires --btc5m");
      }

      if (isLagSummary) {
        const minutes = clamp(parseArgNumber(args, "--minutes", 60), 1, 24 * 60);
        const summary = await summarizeLagJsonl(minutes);
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      const mode = isPaperRun
        ? "paper"
        : args.includes("--live")
          ? "live"
          : args.includes("--paper")
            ? "paper"
            : config.polymarket.mode;
      const forceTrade = args.includes("--force-trade")
        ? true
        : config.polymarket.paper.forceTrade;
      const forceIntervalSec = parseArgNumber(
        args,
        "--force-interval-sec",
        config.polymarket.paper.forceIntervalSec
      );
      const forceNotional = parseArgNumber(
        args,
        "--force-notional",
        config.polymarket.paper.forceNotional
      );
      const effectiveConfig = {
        ...config,
        polymarket: {
          ...config.polymarket,
          enabled: true,
          mode,
          execution: {
            ...config.polymarket.execution,
            cancelAllOnStart:
              args.includes("--cancel-all-on-start") || config.polymarket.execution.cancelAllOnStart
          },
          paper: {
            ...config.polymarket.paper,
            forceTrade,
            forceIntervalSec: clamp(forceIntervalSec, 10, 24 * 60 * 60),
            forceNotional: clamp(forceNotional, 0.01, 100_000)
          }
        }
      } as typeof config;
      validatePolymarketLiveConfig(effectiveConfig, {
        allowMissingApiCreds: isDeriveCreds
      });
      const pmLogger = buildLogger(effectiveConfig);
      const client = new PolymarketClient(effectiveConfig, pmLogger);

      if (isPing) {
        try {
          const result = await client.ping();
          // eslint-disable-next-line no-console
          console.log("Polymarket ping: OK");
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          const status = extractStatus(error);
          if (status === 401) {
            // eslint-disable-next-line no-console
            console.error("Polymarket ping auth failed (401 Unauthorized/Invalid api key).");
            // eslint-disable-next-line no-console
            console.error(
              "Likely causes: wrong signatureType/funder for this account, stale creds, or creds derived from a different wallet."
            );
            // eslint-disable-next-line no-console
            console.error(
              "Try: node dist/cli.js polymarket whoami --live  and  node dist/cli.js polymarket derive-creds --live"
            );
          }
          throw error;
        }
        return;
      }

      if (isWhoAmI) {
        const who = await client.whoAmI();
        // eslint-disable-next-line no-console
        console.log("Polymarket whoami:");
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(who, null, 2));
        return;
      }

      if (isDeriveCreds) {
        const printSecrets = args.includes("--print-secrets");
        const derived = await client.deriveCreds({
          printSecrets,
          useCache: !args.includes("--fresh"),
          saveCache: true
        });
        // eslint-disable-next-line no-console
        console.log("Polymarket derive-creds:");
        const output = printSecrets
          ? derived
          : { apiKey: String((derived as Record<string, unknown>).apiKey || "") };
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      if (isScan) {
        const scanner = new MarketScanner(effectiveConfig, pmLogger, client);
        const diagnostics = await scanner.scanBtc5m(Date.now(), {
          debug: args.includes("--debug")
        });
        // eslint-disable-next-line no-console
        console.log("Polymarket BTC-5m scan counters:");
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              fetchedTotal: diagnostics.counters.fetchedTotal,
              tradableTotal: diagnostics.counters.tradableTotal,
              btcTotal: diagnostics.counters.btcTotal,
              cadenceTotal: diagnostics.counters.cadenceTotal,
              directionTotal: diagnostics.counters.directionTotal,
              btc5mCandidates: diagnostics.counters.btc5mCandidates,
              activeWindows: diagnostics.counters.activeWindows,
              pagesScanned: diagnostics.counters.pagesScanned,
              recentEventsCount: diagnostics.counters.recentEventsCount,
              prefixMatchesCount: diagnostics.counters.prefixMatchesCount,
              selectedSlug: diagnostics.selectedSlug
            },
            null,
            2
          )
        );
        // eslint-disable-next-line no-console
        console.log("First 20 BTC-5m candidates:");
        // eslint-disable-next-line no-console
        console.table(
          diagnostics.candidates.slice(0, 20).map((row) => ({
            id: row.marketId,
            question: row.question,
            accepting_orders: row.acceptingOrders,
            enable_order_book: row.enableOrderBook,
            closed: row.closed,
            active: row.active
          }))
        );
        if (args.includes("--debug")) {
          // eslint-disable-next-line no-console
          console.log("First rejected non-tradable candidates:");
          // eslint-disable-next-line no-console
          console.table(
            diagnostics.rejectedNotTradable.map((row) => ({
              id: row.marketId,
              question: row.question,
              reasons: row.reasons.join(","),
              accepting_orders: row.acceptingOrders,
              enable_order_book: row.enableOrderBook,
              closed: row.closed,
              active: row.active
            }))
          );
        }
        return;
      }

      if (isResolveEvent) {
        const slug = parseArgString(args, "--slug", "");
        if (!slug) {
          throw new Error("polymarket resolve-event requires --slug <event-slug>");
        }
        const seedScanner = new GammaSeedScanner(effectiveConfig, pmLogger, client);
        const resolved = await seedScanner.resolveEventBySlug(slug);
        if (!resolved) {
          throw new Error(`Failed to resolve event slug: ${slug}`);
        }
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              slug: resolved.slug,
              conditionId: resolved.conditionId,
              outcomes: resolved.outcomes,
              tokenUpId: resolved.tokenUpId,
              tokenDownId: resolved.tokenDownId,
              windowStart: resolved.windowStartTs ? new Date(resolved.windowStartTs).toISOString() : null,
              windowEnd: new Date(resolved.windowEndTs).toISOString(),
              acceptingOrders: resolved.acceptingOrders,
              enableOrderBook: resolved.enableOrderBook,
              active: resolved.active,
              closed: resolved.closed
            },
            null,
            2
          )
        );
        return;
      }

      if (isBook) {
        const tokenId = parseArgString(args, "--token-id", "");
        if (!tokenId) {
          throw new Error("polymarket book requires --token-id <id>");
        }
        const book = await client.getTokenOrderBook(tokenId);
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              tokenId,
              bestBid: book.bestBid,
              bestAsk: book.bestAsk,
              bids: book.bids.slice(0, 5),
              asks: book.asks.slice(0, 5)
            },
            null,
            2
          )
        );
        return;
      }

      const engine = new PolymarketEngine(effectiveConfig, pmLogger);

      // eslint-disable-next-line no-console
      console.log("Polymarket module starting with strict safety defaults:");
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            mode,
            loopMs: effectiveConfig.polymarket.loopMs,
            marketQuery: effectiveConfig.polymarket.marketQuery,
            threshold: effectiveConfig.polymarket.threshold,
            sizing: effectiveConfig.polymarket.sizing,
            risk: effectiveConfig.polymarket.risk,
            authEnv: {
              apiKeyEnv: effectiveConfig.polymarket.auth.apiKeyEnv,
              apiSecretEnv: effectiveConfig.polymarket.auth.apiSecretEnv,
              legacySecretEnv: effectiveConfig.polymarket.auth.legacySecretEnv,
              passphraseEnv: effectiveConfig.polymarket.auth.passphraseEnv,
              privateKeyEnv: effectiveConfig.polymarket.auth.privateKeyEnv,
              funderEnv: effectiveConfig.polymarket.auth.funderEnv
            },
            chainId: effectiveConfig.polymarket.auth.chainId,
            network: effectiveConfig.polymarket.auth.network,
            signatureType: effectiveConfig.polymarket.auth.signatureType,
            autoDeriveApiKey: effectiveConfig.polymarket.auth.autoDeriveApiKey,
            execution: effectiveConfig.polymarket.execution,
            paper: effectiveConfig.polymarket.paper
          },
          null,
          2
        )
      );
      // eslint-disable-next-line no-console
      console.log(
        "Safety warning: start paper mode, tiny sizing, and never allow new orders in the last 30s. Consider --cancel-all-on-start for live sessions."
      );
      // eslint-disable-next-line no-console
      console.log("Decision logs: logs/polymarket-decisions.jsonl");
      // eslint-disable-next-line no-console
      console.log(
        `Paper force-trade: ${effectiveConfig.polymarket.paper.forceTrade ? "ENABLED" : "disabled"} (intervalSec=${effectiveConfig.polymarket.paper.forceIntervalSec}, notional=${effectiveConfig.polymarket.paper.forceNotional}, side=${effectiveConfig.polymarket.paper.forceSide})`
      );

      await engine.start();

      const runMs = isPaperRun
        ? Math.floor(clamp(parseArgNumber(args, "--hours", 12), 0.01, 168) * 60 * 60 * 1000)
        : 0;
      if (isPaperRun) {
        // eslint-disable-next-line no-console
        console.log(`Polymarket paper overnight mode: running for ${fmt(runMs / (60 * 60 * 1000), 2)} hours`);
      }

      await new Promise<void>((resolve) => {
        let stopping = false;
        let timeout: NodeJS.Timeout | null = null;
        const stop = async (signal: string): Promise<void> => {
          if (stopping) return;
          stopping = true;
          if (timeout) {
            clearTimeout(timeout);
            timeout = null;
          }
          await engine.stop(signal);
          resolve();
        };

        process.once("SIGINT", () => {
          void stop("SIGINT");
        });
        process.once("SIGTERM", () => {
          void stop("SIGTERM");
        });
        if (runMs > 0) {
          timeout = setTimeout(() => {
            void stop("TIMEBOX_COMPLETE");
          }, runMs);
        }
      });

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
        ". Use: status | balances [--raw] | cancel-all [--all] | dry-run | simulate [--minutes N] | tune [--apply] | polymarket ping [--paper|--live] | polymarket whoami [--paper|--live] | polymarket derive-creds [--paper|--live] [--print-secrets] [--fresh] | polymarket lag-summary [--minutes N] | polymarket scan --btc5m [--debug] | polymarket resolve-event --slug <slug> | polymarket book --token-id <id> [--paper|--live] | polymarket paper --btc5m [--hours N] [--force-trade] [--force-interval-sec N] [--force-notional X] | polymarket --btc5m [--paper|--live] [--cancel-all-on-start]"
    );
    process.exitCode = 1;
  } finally {
    if (store) {
      store.close();
    }
  }
}

async function summarizeLagJsonl(minutes: number): Promise<Record<string, unknown>> {
  const logPath = join(process.cwd(), "logs/polymarket-lag.jsonl");
  if (!existsSync(logPath)) {
    return {
      ok: false,
      reason: "lag log missing",
      path: logPath,
      minutes
    };
  }

  const sinceTs = Date.now() - Math.max(1, minutes) * 60 * 1000;
  const metrics: Record<string, number[]> = {
    polyUpdateAgeMs: [],
    oracleAgeMs: [],
    absOracleFast: [],
    absProbGap: [],
    bookMoveLagMs: []
  };
  let scanned = 0;
  let kept = 0;

  const rl = createInterface({
    input: createReadStream(logPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    scanned += 1;
    let row: Record<string, unknown> | null = null;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      row = null;
    }
    if (!row) continue;
    const tsMs = Number(row.tsMs ?? row.ts ?? 0);
    if (!Number.isFinite(tsMs) || tsMs < sinceTs) {
      continue;
    }
    kept += 1;
    for (const key of Object.keys(metrics)) {
      const value = Number(row[key] ?? Number.NaN);
      if (Number.isFinite(value)) {
        metrics[key].push(value);
      }
    }
  }

  return {
    ok: true,
    path: logPath,
    minutes,
    scanned,
    kept,
    stats: Object.fromEntries(
      Object.entries(metrics).map(([key, values]) => [key, summarizeNumbers(values)])
    )
  };
}

function summarizeNumbers(values: number[]): Record<string, number | null> {
  if (values.length === 0) {
    return { count: 0, mean: null, p50: null, p90: null };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    count: values.length,
    mean,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9)
  };
}

function percentile(sortedValues: number[], q: number): number | null {
  if (sortedValues.length === 0) return null;
  const qq = Math.max(0, Math.min(1, q));
  const rank = (sortedValues.length - 1) * qq;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sortedValues[low];
  const w = rank - low;
  return sortedValues[low] * (1 - w) + sortedValues[high] * w;
}

function parseBotTag(tag: string): { side: string; level: number; tag: string } {
  const m = /-(BUY|SELL)-L(\d+)$/.exec(tag);
  if (!m) return { side: "?", level: -1, tag };
  return { side: m[1], level: Number(m[2]), tag };
}

function validatePolymarketLiveConfig(
  config: ReturnType<typeof loadConfig>,
  options?: { allowMissingApiCreds?: boolean }
): void {
  if (config.polymarket.mode !== "live") {
    return;
  }
  if (!config.polymarket.liveConfirmed) {
    throw new Error("POLYMARKET_MODE=live requires POLYMARKET_LIVE_CONFIRMED=true");
  }

  const auth = config.polymarket.auth;
  if (!auth.privateKey) {
    throw new Error(`${auth.privateKeyEnv} is required when running polymarket --live`);
  }
  if (!auth.funder) {
    throw new Error(`${auth.funderEnv} is required when running polymarket --live`);
  }
  const hasApiCreds = Boolean(auth.apiKey && auth.apiSecret && auth.passphrase);
  if (!hasApiCreds && !auth.autoDeriveApiKey && !options?.allowMissingApiCreds) {
    throw new Error(
      `Live Polymarket mode requires (${auth.apiKeyEnv}, ${auth.apiSecretEnv} or ${auth.legacySecretEnv}, ${auth.passphraseEnv}) or POLYMARKET_AUTO_DERIVE_API_KEY=true`
    );
  }
}

function extractStatus(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const obj = error as Record<string, unknown>;
  const status = Number(obj.status);
  if (Number.isFinite(status)) return status;
  const response = obj.response && typeof obj.response === "object" ? (obj.response as Record<string, unknown>) : {};
  const nested = Number(response.status);
  if (Number.isFinite(nested)) return nested;
  return 0;
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

function parseArgString(args: string[], flag: string, fallback: string): string {
  const idx = args.findIndex((arg) => arg === flag);
  if (idx < 0) return fallback;
  const raw = String(args[idx + 1] || "").trim();
  return raw.length > 0 ? raw : fallback;
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
