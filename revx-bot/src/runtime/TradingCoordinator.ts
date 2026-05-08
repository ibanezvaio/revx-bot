import { BotConfig } from "../config";
import { Execution } from "../exec/Execution";
import { IntelEngine } from "../intel/IntelEngine";
import { Logger } from "../logger";
import { MarketData } from "../md/MarketData";
import { NewsEngine } from "../news/NewsEngine";
import { PerformanceEngine } from "../performance/PerformanceEngine";
import { ExternalQuoteService } from "../quotes/ExternalQuoteService";
import { Reconciler } from "../recon/Reconciler";
import {
  PortfolioRiskCoordinator,
  PortfolioRuntimePlan,
  PortfolioVenueObservation
} from "../risk/PortfolioRiskCoordinator";
import { RiskManager } from "../risk/RiskManager";
import { RevXClient } from "../revx/RevXClient";
import { CrossVenueSignalEngine } from "../signal/CrossVenueSignalEngine";
import { SignalEngine } from "../signals/SignalEngine";
import { SignalsEngine } from "../signals/SignalsEngine";
import { createStore } from "../store/factory";
import { MakerStrategy } from "../strategy/MakerStrategy";
import { DashboardServer } from "../web/DashboardServer";
import { PolymarketEngine } from "../polymarket/PolymarketEngine";
import { Btc5mLiveRunner } from "../polymarket/live/Btc5mLiveRunner";
import { AttributionPolicyEngine } from "./AttributionPolicyEngine";
import { deriveSharedVenueBias, SharedMarketIntelligence } from "./SharedMarketIntelligence";
import { getTradingTruthReporter } from "../logging/truth";

export class TradingCoordinator {
  private readonly revxLogger: Logger;
  private readonly reconLogger: Logger;
  private readonly webLogger: Logger;
  private readonly pmLogger: Logger | null;
  private readonly portfolioLogger: Logger;
  private readonly attributionLogger: Logger;
  private readonly truthReporter: ReturnType<typeof getTradingTruthReporter>;

  private readonly store: ReturnType<typeof createStore>;
  private readonly client: RevXClient;
  private readonly marketData: MarketData;
  private readonly externalQuoteService: ExternalQuoteService;
  private readonly risk: RiskManager;
  private readonly signalEngine: SignalEngine;
  private readonly crossVenueSignalEngine: CrossVenueSignalEngine;
  private readonly newsEngine: NewsEngine;
  private readonly signalsEngine: SignalsEngine;
  private readonly intelEngine: IntelEngine;
  private readonly sharedMarketIntelligence: SharedMarketIntelligence;
  private readonly portfolioRiskCoordinator: PortfolioRiskCoordinator;
  private readonly attributionPolicyEngine: AttributionPolicyEngine;
  private readonly performanceEngine: PerformanceEngine | undefined;
  private readonly usePolymarketV2Runner: boolean;
  private readonly polymarketEngine: PolymarketEngine | undefined;
  private readonly polymarketV2Runner: Btc5mLiveRunner | undefined;
  private readonly polymarketRuntimeProvider: Btc5mLiveRunner | PolymarketEngine | undefined;
  private readonly execution: Execution;
  private readonly reconciler: Reconciler;
  private readonly dashboard: DashboardServer;
  private readonly strategy: MakerStrategy;

  private runtimePlan: PortfolioRuntimePlan | null = null;
  private storeInitialized = false;
  private runTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private shuttingDown = false;
  private stopSignalResolve: (() => void) | null = null;
  private readonly stopSignalPromise: Promise<void>;
  private portfolioMonitorTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger
  ) {
    this.revxLogger = logger.child({ module: "revx" });
    this.reconLogger = logger.child({ module: "recon" });
    this.webLogger = logger.child({ module: "web" });
    this.pmLogger = config.polymarket.enabled ? logger.child({ module: "polymarket" }) : null;
    this.portfolioLogger = logger.child({ module: "portfolio" });
    this.attributionLogger = logger.child({ module: "attribution" });
    this.truthReporter = getTradingTruthReporter(config, logger.child({ module: "truth" }));

    this.store = createStore(config, logger);
    this.client = new RevXClient(config, this.revxLogger);
    this.marketData = new MarketData(this.client, this.revxLogger);
    this.externalQuoteService = new ExternalQuoteService(config, this.revxLogger);
    this.risk = new RiskManager(config, this.revxLogger);
    this.signalEngine = new SignalEngine(config);
    this.crossVenueSignalEngine = new CrossVenueSignalEngine(config, logger);
    this.newsEngine = new NewsEngine(config, logger, this.store);
    this.signalsEngine = new SignalsEngine(config, logger, this.store);
    this.intelEngine = new IntelEngine(config, logger, this.newsEngine, this.signalsEngine);
    this.sharedMarketIntelligence = new SharedMarketIntelligence({
      store: this.store,
      signalsEngine: this.signalsEngine,
      intelEngine: this.intelEngine
    });
    this.portfolioRiskCoordinator = new PortfolioRiskCoordinator(config, this.portfolioLogger);
    this.attributionPolicyEngine = new AttributionPolicyEngine(config, this.attributionLogger, this.store);
    this.performanceEngine = config.performanceEnabled
      ? new PerformanceEngine(config, this.revxLogger, this.store, this.marketData)
      : undefined;
    const configuredPolyLiveRunner = String(process.env.POLY_LIVE_RUNNER || "").trim().toLowerCase();
    this.usePolymarketV2Runner =
      config.polymarket.enabled &&
      config.polymarket.mode === "live" &&
      configuredPolyLiveRunner !== "legacy" &&
      configuredPolyLiveRunner !== "v1";
    this.polymarketEngine = config.polymarket.enabled
      ? new PolymarketEngine(config, this.pmLogger ?? logger, { store: this.store })
      : undefined;
    this.polymarketV2Runner = this.usePolymarketV2Runner
      ? new Btc5mLiveRunner(config, this.pmLogger ?? logger, {
          store: this.store,
          intelEngine: this.intelEngine,
          signalsEngine: this.signalsEngine,
          marketIntelligence: this.sharedMarketIntelligence
        })
      : undefined;
    this.polymarketRuntimeProvider = this.usePolymarketV2Runner
      ? this.polymarketV2Runner
      : this.polymarketEngine;
    this.execution = new Execution(config, this.revxLogger, this.client, this.store, config.dryRun);
    this.reconciler = new Reconciler(
      config,
      this.reconLogger,
      this.client,
      this.store,
      this.marketData,
      this.performanceEngine
    );
    this.dashboard = new DashboardServer(
      config,
      this.webLogger,
      this.store,
      this.execution.getRunId(),
      {
        cancelAllBotOrders: async () => this.execution.cancelAllBotOrders(config.symbol)
      },
      this.externalQuoteService,
      this.newsEngine,
      this.signalsEngine,
      this.intelEngine,
      this.performanceEngine,
      this.polymarketRuntimeProvider
    );
    this.strategy = new MakerStrategy(
      config,
      this.revxLogger,
      this.client,
      this.store,
      this.marketData,
      this.execution,
      this.reconciler,
      this.risk,
      this.signalEngine,
      this.crossVenueSignalEngine,
      this.newsEngine,
      this.signalsEngine,
      this.intelEngine
    );
    this.stopSignalPromise = new Promise<void>((resolve) => {
      this.stopSignalResolve = resolve;
    });
  }

  async start(): Promise<void> {
    if (this.runTask) {
      return this.runTask;
    }
    this.runTask = this.run();
    return this.runTask;
  }

  async stop(reason = "STOP"): Promise<void> {
    if (this.stopTask) {
      return this.stopTask;
    }
    this.stopTask = this.performStop(reason);
    return this.stopTask;
  }

  private async run(): Promise<void> {
    this.store.init();
    this.storeInitialized = true;
    this.runtimePlan = this.portfolioRiskCoordinator.getRuntimePlan();
    this.portfolioRiskCoordinator.logStartupSnapshot();
    this.dashboard.start();
    this.logVenueStartupPlan();
    if (!this.hasAdmittedVenue()) {
      this.logger.error({ runtimePlan: this.runtimePlan }, "No venue admitted by portfolio startup gate");
      return;
    }
    this.startSharedServices();
    this.startPortfolioMonitor();
    this.logPolymarketRuntimeConfig();
    this.startPolymarketRuntime();

    try {
      if (this.shouldStartRevX()) {
        await this.strategy.start();
      } else {
        this.revxLogger.warn(
          { reason: this.getVenueStartupReason("REVX") },
          "RevX strategy startup skipped by portfolio gate"
        );
        await this.stopSignalPromise;
      }
    } finally {
      if (!this.shuttingDown) {
        this.logger.error(
          "Trading coordinator loop exited without SIGINT/SIGTERM; stopping venue runtimes with UNEXPECTED_EXIT"
        );
      }
      await this.stop(this.shuttingDown ? "SHUTDOWN" : "UNEXPECTED_EXIT");
    }
  }

  private startSharedServices(): void {
    this.externalQuoteService.start();
    this.newsEngine.start();
    this.signalsEngine.start();
    this.intelEngine.start();
    this.performanceEngine?.start();
    this.reconciler.start();
  }

  private startPolymarketRuntime(): void {
    if (!this.config.polymarket.enabled || !this.shouldStartPolymarket()) {
      if (this.config.polymarket.enabled) {
        this.pmLogger?.warn(
          { reason: this.getVenueStartupReason("POLYMARKET") },
          "Polymarket runtime startup skipped by portfolio gate"
        );
      }
      return;
    }
    if (this.usePolymarketV2Runner) {
      this.pmLogger?.warn(
        {
          liveRunner: "v2",
          mode: this.config.polymarket.mode,
          configuredRunner: String(process.env.POLY_LIVE_RUNNER || "").trim() || null
        },
        "Polymarket live runtime using v2 runner; set POLY_LIVE_RUNNER=legacy to force the legacy engine"
      );
      void this.polymarketV2Runner?.start().catch(async (error) => {
        this.pmLogger?.error({ error }, "Polymarket v2 live runner failed to start");
        await this.stop("POLY_V2_STARTUP_FAILED");
      });
      return;
    }
    void this.polymarketEngine?.start().catch((error) => {
      this.pmLogger?.error({ error }, "Polymarket engine failed to start in combined runtime");
      void this.stop("POLY_LEGACY_STARTUP_FAILED");
    });
  }

  private logPolymarketRuntimeConfig(): void {
    if (!this.config.polymarket.enabled) {
      return;
    }
    this.pmLogger?.warn(
      {
        enabled: this.config.polymarket.enabled,
        mode: this.config.polymarket.mode,
        fetchEnabled: this.config.polymarket.fetchEnabled,
        liveConfirmed: this.config.polymarket.liveConfirmed,
        liveExecutionEnabled: this.config.polymarket.liveExecutionEnabled,
        killSwitch: this.config.polymarket.killSwitch,
        seedSeriesPrefix: this.config.polymarket.marketQuery.seedSeriesPrefix || null,
        seedEventSlugs: this.config.polymarket.marketQuery.seedEventSlugs,
        sizing: this.config.polymarket.sizing,
        risk: this.config.polymarket.risk,
        cancelAllOnStart: this.config.polymarket.execution.cancelAllOnStart,
        paperForceTrade: this.config.polymarket.paper.forceTrade,
        paperForceIntervalSec: this.config.polymarket.paper.forceIntervalSec,
        paperForceNotional: this.config.polymarket.paper.forceNotional
      },
      "Polymarket enabled in combined runtime"
    );
  }

  private async performStop(reason: string): Promise<void> {
    this.shuttingDown = true;
    this.stopSignalResolve?.();
    this.stopSignalResolve = null;
    this.logger.warn({ reason }, "Trading coordinator stopping");

    this.strategy.stop();
    await this.polymarketV2Runner?.stop(reason);
    await this.polymarketEngine?.stop(reason);
    this.reconciler.stop();
    this.externalQuoteService.stop();
    this.newsEngine.stop();
    this.signalsEngine.stop();
    this.intelEngine.stop();
    this.performanceEngine?.stop();
    if (this.portfolioMonitorTimer) {
      clearInterval(this.portfolioMonitorTimer);
      this.portfolioMonitorTimer = null;
    }
    this.dashboard.stop();

    try {
      await this.execution.cancelAllBotOrders(this.config.symbol);
    } catch (error) {
      this.logger.error({ error }, "Failed cancelling bot orders during coordinator shutdown");
    }

    if (this.storeInitialized) {
      this.store.close();
      this.storeInitialized = false;
    }
  }

  private hasAdmittedVenue(): boolean {
    return (this.runtimePlan?.venues ?? []).some((venue) => venue.startupAction === "START");
  }

  private shouldStartRevX(): boolean {
    return this.getVenueStartupAction("REVX") === "START";
  }

  private shouldStartPolymarket(): boolean {
    return this.getVenueStartupAction("POLYMARKET") === "START";
  }

  private getVenueStartupAction(venue: "REVX" | "POLYMARKET"): "START" | "SKIP" {
    return this.runtimePlan?.venues.find((candidate) => candidate.venue === venue)?.startupAction ?? "SKIP";
  }

  private getVenueStartupReason(venue: "REVX" | "POLYMARKET"): string {
    return this.runtimePlan?.venues.find((candidate) => candidate.venue === venue)?.startupReason ?? "UNKNOWN";
  }

  private logVenueStartupPlan(): void {
    if (!this.runtimePlan) {
      return;
    }
    for (const venue of this.runtimePlan.venues) {
      const logger = venue.venue === "REVX" ? this.revxLogger : this.pmLogger ?? this.logger;
      const logPayload = {
        venue: venue.venue,
        mode: venue.mode,
        startupAction: venue.startupAction,
        startupReason: venue.startupReason,
        consumesLiveCapital: venue.consumesLiveCapital,
        requestedStartupBudgetUsd: venue.requestedStartupBudgetUsd,
        allocatedStartupBudgetUsd: venue.allocatedStartupBudgetUsd,
        dailyLossCapUsd: venue.dailyLossCapUsd,
        targetCapUsd: venue.targetCapUsd,
        hardCapUsd: venue.hardCapUsd
      };
      if (venue.startupAction === "START") {
        logger.warn(logPayload, "VENUE_STARTUP_ADMITTED");
      } else {
        logger.warn(logPayload, "VENUE_STARTUP_SKIPPED");
      }
    }
  }

  private startPortfolioMonitor(): void {
    void this.runPortfolioMonitor();
    const intervalMs = Math.max(1_000, Math.min(5_000, Math.floor(this.config.reconcileSeconds * 1_000)));
    this.portfolioMonitorTimer = setInterval(() => {
      void this.runPortfolioMonitor();
    }, intervalMs);
  }

  private async runPortfolioMonitor(): Promise<void> {
    if (this.shuttingDown || !this.storeInitialized) {
      return;
    }
    const nowTs = Date.now();
    const botStatus = this.store.getBotStatus();
    this.sharedMarketIntelligence.publishVenueBias(this.shouldStartRevX() ? deriveSharedVenueBias(botStatus) : null);

    const rollingMetrics = this.store.getRollingMetrics(nowTs);
    const policy = this.portfolioRiskCoordinator.evaluateRuntimePolicy(
      {
        revx: {
          started: this.shouldStartRevX(),
          exposureUsd: Math.max(0, Number(botStatus?.exposure_usd || 0)),
          realizedPnlUsd: Number(rollingMetrics.realized_pnl_today_usd || 0)
        },
        polymarket: this.getPolymarketObservation()
      },
      nowTs
    );
    const attributionFeedback = this.attributionPolicyEngine.evaluate(nowTs);
    const mergedRevxPolicy = this.attributionPolicyEngine.mergeRevxPolicy(
      policy.revxQuotePolicy,
      attributionFeedback.revx
    );
    const mergedPolymarketPolicy = this.attributionPolicyEngine.mergePolymarketPolicy(
      policy.polymarketEntryPolicy,
      attributionFeedback.polymarket
    );
    this.recordAttributionMetrics(nowTs, attributionFeedback);
    this.syncPolymarketTruth(nowTs);

    this.polymarketV2Runner?.setPortfolioEntryPolicy({
      allowNewEntries: mergedPolymarketPolicy.allowNewEntries,
      additionalBudgetUsd: mergedPolymarketPolicy.additionalBudgetUsd,
      reason: mergedPolymarketPolicy.reason,
      source: "PORTFOLIO_AND_ATTRIBUTION_POLICY"
    });
    this.strategy.setPortfolioQuotePolicy(mergedRevxPolicy);

  }

  private syncPolymarketTruth(nowTs: number): void {
    if (!this.config.polymarket.enabled) {
      return;
    }
    const runtimeSnapshot = this.polymarketRuntimeProvider?.getDashboardSnapshot?.();
    if (!runtimeSnapshot) {
      return;
    }
    const selection = runtimeSnapshot.selection || {};
    const dataHealth = runtimeSnapshot.dataHealth || {};
    const lastTrade = runtimeSnapshot.lastTrade || {};
    this.truthReporter.updatePolymarket({
      ts: nowTs,
      mode: this.config.polymarket.mode === "paper" ? "PAPER" : "LIVE",
      enabled: Boolean(this.config.polymarket.enabled),
      liveConfirmed: Boolean(this.config.polymarket.liveConfirmed),
      liveExecutionEnabled: Boolean(this.config.polymarket.liveExecutionEnabled),
      killSwitch: Boolean(this.config.polymarket.killSwitch),
      polyEngineRunning: Boolean(runtimeSnapshot.polyEngineRunning ?? runtimeSnapshot.running),
      fetchOk: Boolean(runtimeSnapshot.fetchOk),
      warningState: runtimeSnapshot.warningState ?? null,
      pollMode: runtimeSnapshot.pollMode ?? null,
      staleState: runtimeSnapshot.staleState ?? null,
      lastAction: runtimeSnapshot.lastAction ?? "HOLD",
      holdReason: runtimeSnapshot.holdReason ?? null,
      blockedBy: runtimeSnapshot.blockedBy ?? null,
      currentWindowHoldReason: runtimeSnapshot.currentWindowHoldReason ?? null,
      holdCategory: runtimeSnapshot.holdCategory ?? null,
      strategyAction: runtimeSnapshot.strategyAction ?? null,
      selectedTokenId: runtimeSnapshot.selectedTokenId ?? null,
      selectedBookable:
        typeof runtimeSnapshot.selectedBookable === "boolean" ? runtimeSnapshot.selectedBookable : null,
      selectedTradable:
        typeof runtimeSnapshot.selectedTradable === "boolean" ? runtimeSnapshot.selectedTradable : null,
      discoveredCurrent:
        typeof runtimeSnapshot.discoveredCurrent === "boolean" ? runtimeSnapshot.discoveredCurrent : null,
      discoveredNext: typeof runtimeSnapshot.discoveredNext === "boolean" ? runtimeSnapshot.discoveredNext : null,
      selectionSource: runtimeSnapshot.selectionSource ?? null,
      selectedFrom: runtimeSnapshot.selectedFrom ?? null,
      selectionCommitTs: runtimeSnapshot.selectionCommitTs ?? null,
      liveValidationReason: runtimeSnapshot.liveValidationReason ?? null,
      lastBookTs: runtimeSnapshot.lastBookTs ?? null,
      lastQuoteTs: runtimeSnapshot.lastQuoteTs ?? null,
      currentBucketSlug: runtimeSnapshot.currentBucketSlug ?? null,
      nextBucketSlug: runtimeSnapshot.nextBucketSlug ?? null,
      currentBucketStartSec: runtimeSnapshot.currentBucketStartSec ?? null,
      selectedWindowStartSec: runtimeSnapshot.selectedWindowStartSec ?? null,
      selectedWindowEndSec: runtimeSnapshot.selectedWindowEndSec ?? null,
      candidateRefreshed:
        typeof runtimeSnapshot.candidateRefreshed === "boolean" ? runtimeSnapshot.candidateRefreshed : null,
      lastPreorderValidationReason: runtimeSnapshot.lastPreorderValidationReason ?? null,
      openTrades: runtimeSnapshot.openTradesCount ?? 0,
      awaitingResolutionTrades: runtimeSnapshot.awaitingResolutionCount ?? 0,
      resolutionErrorTrades: runtimeSnapshot.resolutionErrorCount ?? 0,
      resolutionQueueCount: runtimeSnapshot.resolutionQueueCount ?? 0,
      resolvedTrades: runtimeSnapshot.resolvedTradesCount ?? runtimeSnapshot.resolvedTrades ?? 0,
      pnlTotalUsd: runtimeSnapshot.pnlTotalUsd ?? 0,
      lastTradeId: lastTrade.id ?? null,
      lastSlug: lastTrade.slug ?? null,
      lastTradeTs: lastTrade.ts ?? null,
      finalCandidatesCount: selection.finalCandidatesCount ?? null,
      discoveredCandidatesCount: selection.discoveredCandidatesCount ?? null,
      windowsCount: selection.windowsCount ?? null,
      selectedSlug: selection.selectedSlug ?? null,
      selectedMarketId: selection.selectedMarketId ?? null,
      windowStartTs: selection.windowStartTs ?? null,
      windowEndTs: selection.windowEndTs ?? null,
      remainingSec: selection.remainingSec ?? null,
      chosenSide: selection.chosenSide ?? null,
      chosenDirection: selection.chosenDirection ?? null,
      entriesInWindow: selection.entriesInWindow ?? null,
      windowRealizedPnlUsd: selection.realizedPnlUsd ?? selection.realizedPnlWindowUsd ?? null,
      resolutionSource: selection.resolutionSource ?? null,
      oracleSource: dataHealth.oracleSource ?? null,
      oracleState: dataHealth.oracleState ?? null,
      latestPolymarketTs: dataHealth.latestPolymarketTs ?? null,
      latestModelTs: dataHealth.latestModelTs ?? null,
      lastFetchAttemptTs: dataHealth.lastFetchAttemptTs ?? 0,
      lastFetchOkTs: dataHealth.lastFetchOkTs ?? 0,
      lastFetchErr: dataHealth.lastFetchErr ?? null,
      lastHttpStatus: dataHealth.lastHttpStatus ?? 0,
      lastUpdateTs: runtimeSnapshot.lastUpdateTs ?? nowTs,
      threshold: runtimeSnapshot.threshold ?? null,
      discoveredAtTs: runtimeSnapshot.discoveredAtTs ?? null,
      marketExpiresAtTs: runtimeSnapshot.marketExpiresAtTs ?? null,
      lastDiscoverySuccessTs: runtimeSnapshot.lastDiscoverySuccessTs ?? null,
      lastDecisionTs: runtimeSnapshot.lastDecisionTs ?? null,
      lastSelectedMarketTs: runtimeSnapshot.lastSelectedMarketTs ?? null,
      currentBtcMid: runtimeSnapshot.currentBtcMid ?? null,
      statusLine: runtimeSnapshot.statusLine ?? null,
      whyNotTrading: runtimeSnapshot.whyNotTrading ?? null,
      currentMarketStatus: runtimeSnapshot.currentMarketStatus ?? null,
      currentMarketSlug: runtimeSnapshot.currentMarketSlug ?? null,
      currentMarketRemainingSec: runtimeSnapshot.currentMarketRemainingSec ?? null,
      currentMarketExpiresAt: runtimeSnapshot.currentMarketExpiresAt ?? null
    });
  }

  private recordAttributionMetrics(
    nowTs: number,
    feedback: ReturnType<AttributionPolicyEngine["evaluate"]>
  ): void {
    this.store.recordMetric({
      ts: nowTs,
      key: "attributionRevxSamples",
      value: feedback.revx.sampleCount
    });
    this.store.recordMetric({
      ts: nowTs,
      key: "attributionRevxAvgMarkoutBps",
      value: Number.isFinite(Number(feedback.revx.avgMarkoutBps)) ? Number(feedback.revx.avgMarkoutBps) : 0
    });
    this.store.recordMetric({
      ts: nowTs,
      key: "attributionRevxBuyMultiplier",
      value: feedback.revx.multiplier
    });
    this.store.recordMetric({
      ts: nowTs,
      key: "attributionPolySamples",
      value: feedback.polymarket.sampleCount
    });
    this.store.recordMetric({
      ts: nowTs,
      key: "attributionPolyAvgMarkoutBps",
      value:
        Number.isFinite(Number(feedback.polymarket.avgMarkoutBps))
          ? Number(feedback.polymarket.avgMarkoutBps)
          : 0
    });
    this.store.recordMetric({
      ts: nowTs,
      key: "attributionPolyBudgetMultiplier",
      value: feedback.polymarket.multiplier
    });
  }

  private getPolymarketObservation(): PortfolioVenueObservation {
    if (!this.shouldStartPolymarket()) {
      return {
        started: false,
        exposureUsd: 0,
        realizedPnlUsd: 0
      };
    }
    const snapshot =
      this.polymarketV2Runner?.getPortfolioSnapshot() ??
      this.polymarketEngine?.getPortfolioSnapshot() ?? {
        running: false,
        exposureUsd: 0,
        realizedPnlUsd: 0
      };
    return {
      started: Boolean(snapshot.running),
      exposureUsd: Math.max(0, Number(snapshot.exposureUsd || 0)),
      realizedPnlUsd: Number(snapshot.realizedPnlUsd || 0)
    };
  }
}
