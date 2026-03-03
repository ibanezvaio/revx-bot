import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { BotConfig } from "../config";
import { Logger } from "../logger";
import { Store } from "../store/Store";
import { CrossVenueFetcher } from "../signals/CrossVenueFetcher";
import { sleep } from "../util/time";
import { PolymarketClient } from "./PolymarketClient";
import { PolymarketExecution } from "./Execution";
import { MarketScanner } from "./MarketScanner";
import { LagProfiler, LagProfilerStats, LagSample } from "./LagProfiler";
import { OracleEstimator } from "./OracleEstimator";
import { OracleRouter, OracleSnapshot, OracleState } from "./OracleRouter";
import { ProbModel } from "./ProbModel";
import { PolymarketRisk } from "./Risk";
import { Sizing } from "./Sizing";
import { Strategy } from "./Strategy";
import { DecisionLogLine, SpotFeed, SpotVenueTick } from "./types";
import { VolEstimator } from "./VolEstimator";
import { PaperLedger } from "./paper/PaperLedger";
import {
  applySellSlippage,
  applyTakerSlippage,
  computePaperClosePnl,
  computePaperPnl,
  estimateNoBidFromYesBook,
  estimateNoAskFromYesBook,
  inferOutcomeFromOracle
} from "./paper/PaperMath";

export class PolymarketEngine {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private consecutiveErrors = 0;
  private readonly logPath: string;
  private readonly logsDirPath: string;
  private readonly client: PolymarketClient;
  private readonly scanner: MarketScanner;
  private readonly oracleEstimator: OracleEstimator;
  private readonly oracleRouter: OracleRouter;
  private readonly volEstimator: VolEstimator;
  private readonly probModel: ProbModel;
  private readonly strategy: Strategy;
  private readonly sizing: Sizing;
  private readonly execution: PolymarketExecution;
  private readonly risk: PolymarketRisk;
  private readonly paperLedger: PaperLedger;
  private readonly paperLedgerPath: string;
  private readonly dataDirPath: string;
  private readonly paperTradeLogPath: string;
  private readonly lagProfiler: LagProfiler;
  private readonly oracleSamples: Array<{ ts: number; px: number; source: string }> = [];
  private readonly marketLagState = new Map<
    string,
    { impliedMid: number; oracleEst: number; ts: number }
  >();
  private readonly resolutionPendingLogByTradeId = new Map<string, number>();
  private readonly paperStopLossTicksByTradeId = new Map<string, number>();
  private latestPolymarketSnapshot: {
    windowSlug: string;
    tauSec: number | null;
    priceToBeat: number | null;
    fastMid: number | null;
    yesMid: number | null;
    impliedProbMid: number | null;
  } | null = null;
  private latestModelSnapshot: {
    pBase: number | null;
    pBoosted: number | null;
    z: number | null;
    d: number | null;
    sigma: number | null;
    tauSec: number | null;
    polyUpdateAgeMs: number | null;
    lagPolyP90Ms: number | null;
    oracleAgeMs: number | null;
    boostApplied: boolean;
    boostReason: string | null;
  } | null = null;
  private oracleStaleSinceTs: number | null = null;
  private tradingPaused = false;
  private pauseReason = "";
  private pauseSinceTs: number | null = null;
  private lastTickLogTs = 0;
  private lastForceTradeTs = 0;
  private paperFatalLogged = false;
  private lastOracleSnapshot: OracleSnapshot | null = null;
  private readonly windowStateBySlug = new Map<
    string,
    {
      windowStartMs: number;
      windowEndMs: number;
      priceToBeat?: number;
      priceToBeatTs?: number;
      waitingLogged?: boolean;
    }
  >();

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    options: { store?: Store } = {}
  ) {
    const spotFeed = new ExistingSpotFeedAdapter(config);
    this.client = new PolymarketClient(config, logger);
    this.scanner = new MarketScanner(config, logger, this.client);
    this.oracleEstimator = new OracleEstimator(config, spotFeed);
    this.oracleRouter = new OracleRouter(config, logger, {
      symbol: this.config.polymarket.marketQuery.symbol,
      estimator: this.oracleEstimator,
      store: options.store
    });
    this.volEstimator = new VolEstimator(config);
    this.probModel = new ProbModel(config);
    this.strategy = new Strategy(config);
    this.sizing = new Sizing(config);
    this.execution = new PolymarketExecution(config, logger, this.client);
    this.risk = new PolymarketRisk(config, logger);

    this.logsDirPath = path.resolve(process.cwd(), "logs");
    this.dataDirPath = path.resolve(process.cwd(), "data");
    mkdirSync(this.logsDirPath, { recursive: true });
    mkdirSync(this.dataDirPath, { recursive: true });
    this.logPath = path.join(this.logsDirPath, "polymarket-decisions.jsonl");
    this.paperTradeLogPath = path.join(this.logsDirPath, "polymarket-paper-trades.jsonl");
    this.lagProfiler = new LagProfiler({
      maxSamples: 2000,
      logPath: path.join(this.logsDirPath, "polymarket-lag.jsonl")
    });
    this.paperLedgerPath = path.resolve(process.cwd(), this.config.polymarket.paper.ledgerPath);
    mkdirSync(path.dirname(this.paperLedgerPath), { recursive: true });
    this.paperLedger = new PaperLedger(this.paperLedgerPath);
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.paperFatalLogged = false;
    this.ensureOutputFilesAndWriteStartupMarkers();
    this.running = true;
    if (
      this.config.polymarket.mode === "live" &&
      this.config.polymarket.execution.cancelAllOnStart &&
      this.canMutateVenueState()
    ) {
      await this.execution.cancelAll("STARTUP_CANCEL_ALL");
    } else if (
      this.config.polymarket.mode === "live" &&
      this.config.polymarket.execution.cancelAllOnStart &&
      !this.canMutateVenueState()
    ) {
      this.logger.warn(
        { killSwitch: this.config.polymarket.killSwitch },
        "Skipping startup cancel-all due to POLYMARKET_KILL_SWITCH"
      );
    }
    this.loopPromise = this.runLoop();
    this.logger.warn(
      {
        mode: this.config.polymarket.mode,
        loopMs: this.config.polymarket.loopMs,
        decisionLog: this.logPath,
        paperLedger: this.config.polymarket.paper.ledgerPath,
        paperTradeLog: this.paperTradeLogPath,
        marketQuery: this.config.polymarket.marketQuery
      },
      "Polymarket engine started"
    );
  }

  async stop(reason = "STOP"): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch (error) {
        this.logger.warn({ error }, "Polymarket loop exited with error during stop");
      }
      this.loopPromise = null;
    }
    if (this.canMutateVenueState()) {
      await this.execution.cancelAll(reason);
    } else {
      this.logger.warn(
        { reason, killSwitch: this.config.polymarket.killSwitch },
        "Skipping cancel-all on stop due to POLYMARKET_KILL_SWITCH"
      );
    }
    this.paperLedger.flush();
    this.logger.warn({ reason }, "Polymarket engine stopped");
  }

  getLagSnapshot(limit = 50): { stats: LagProfilerStats; recent: LagSample[] } {
    return {
      stats: this.lagProfiler.getStats(),
      recent: this.lagProfiler.getRecent(limit)
    };
  }

  getDashboardSnapshot(): {
    latestPolymarket: {
      windowSlug: string;
      tauSec: number | null;
      priceToBeat: number | null;
      fastMid: number | null;
      yesMid: number | null;
      impliedProbMid: number | null;
    } | null;
    latestModel: {
      pBase: number | null;
      pBoosted: number | null;
      z: number | null;
      d: number | null;
      sigma: number | null;
      tauSec: number | null;
      polyUpdateAgeMs: number | null;
      lagPolyP90Ms: number | null;
      oracleAgeMs: number | null;
      boostApplied: boolean;
      boostReason: string | null;
    } | null;
    latestLag: LagProfilerStats;
    sniperWindow: {
      minRemainingSec: number;
      maxRemainingSec: number;
    };
    tradingPaused: boolean;
    pauseReason: string | null;
  } {
    return {
      latestPolymarket: this.latestPolymarketSnapshot ? { ...this.latestPolymarketSnapshot } : null,
      latestModel: this.latestModelSnapshot ? { ...this.latestModelSnapshot } : null,
      latestLag: this.lagProfiler.getStats(),
      sniperWindow: {
        minRemainingSec: this.config.polymarket.paper.entryMinRemainingSec,
        maxRemainingSec: this.config.polymarket.paper.entryMaxRemainingSec
      },
      tradingPaused: this.tradingPaused,
      pauseReason: this.pauseReason || null
    };
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const startedTs = Date.now();
      try {
        await this.runOnce(startedTs);
        this.consecutiveErrors = 0;
      } catch (error) {
        this.consecutiveErrors += 1;
        const transient = isTransientPolymarketError(error);
        this.logger[transient ? "warn" : "error"](
          {
            error,
            transient,
            consecutiveErrors: this.consecutiveErrors
          },
          transient ? "Polymarket transient tick failure (skipping tick)" : "Polymarket loop error"
        );
        if (transient) {
          this.setTradingPaused(true, "NETWORK_ERROR", startedTs);
        }
        this.maybeEmitTickLog({
          marketsSeen: 0,
          activeWindows: 0,
          now: new Date(startedTs).toISOString(),
          currentMarketId: null,
          tauSec: null,
          priceToBeat: null,
          oracleEst: null,
          sigma: null,
          yesBid: null,
          yesAsk: null,
          yesMid: null,
          pUpModel: null,
          edge: null,
          threshold: null,
          action: "ERROR",
          size: null,
          openTrades: this.paperLedger.getOpenTrades().length,
          resolvedTrades: this.paperLedger.getResolvedTrades().length,
          oracleSource: this.lastOracleSnapshot?.source ?? "none",
          oracleTs: this.lastOracleSnapshot?.rawTs ?? null,
          oracleStaleMs:
            this.lastOracleSnapshot && this.lastOracleSnapshot.rawTs > 0
              ? Math.max(0, startedTs - this.lastOracleSnapshot.rawTs)
              : null,
          oracleState: this.lastOracleSnapshot?.state ?? "INIT",
          selectedSlug: null,
          windowStart: null,
          windowEnd: null,
          acceptingOrders: null,
          enableOrderBook: null,
          tradingPaused: this.tradingPaused,
          pauseReason: this.pauseReason || null,
          pauseSinceTs: this.pauseSinceTs
        });
        if (!transient && this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
          this.logger.error(
            { consecutiveErrors: this.consecutiveErrors },
            "Polymarket reached max consecutive errors; continuing loop and waiting for recovery"
          );
          this.consecutiveErrors = 0;
        }
      }

      const elapsed = Date.now() - startedTs;
      const waitMs = Math.max(25, this.config.polymarket.loopMs - elapsed);
      await sleep(waitMs);
    }
  }

  private async runOnce(nowTs: number): Promise<void> {
    await this.execution.refreshLiveState();

    if (this.risk.isKillSwitchActive()) {
      if (this.canMutateVenueState()) {
        await this.execution.cancelAll("KILL_SWITCH_ACTIVE");
      }
      this.maybeEmitTickLog({
        marketsSeen: 0,
        activeWindows: 0,
        now: new Date(nowTs).toISOString(),
        currentMarketId: null,
        tauSec: null,
        priceToBeat: null,
        oracleEst: null,
        sigma: null,
        yesBid: null,
        yesAsk: null,
        yesMid: null,
        pUpModel: null,
        edge: null,
        threshold: null,
        action: "HOLD",
        size: null,
        openTrades: this.paperLedger.getOpenTrades().length,
        resolvedTrades: this.paperLedger.getResolvedTrades().length,
        oracleSource: this.lastOracleSnapshot?.source ?? "none",
        oracleTs: this.lastOracleSnapshot?.rawTs ?? null,
        oracleStaleMs:
          this.lastOracleSnapshot && this.lastOracleSnapshot.rawTs > 0
            ? Math.max(0, nowTs - this.lastOracleSnapshot.rawTs)
            : null,
        oracleState: this.lastOracleSnapshot?.state ?? "INIT",
        selectedSlug: null,
        windowStart: null,
        windowEnd: null,
        acceptingOrders: null,
        enableOrderBook: null
      });
      return;
    }

    const paperMode = this.config.polymarket.mode === "paper";
    const markets = await this.scanner.scanActiveBtc5m(nowTs);
    const scanDiagnostics = this.scanner.getLastDiagnostics();
    let selectedMarket = scanDiagnostics.selectedMarket
      ? this.applyWindowState(scanDiagnostics.selectedMarket, nowTs)
      : null;
    const selectedSlug = scanDiagnostics.selectedSlug;
    const selectedWindowStart = scanDiagnostics.selectedWindowStart;
    const selectedWindowEnd = scanDiagnostics.selectedWindowEnd;
    const selectedAcceptingOrders = scanDiagnostics.selectedAcceptingOrders;
    const selectedEnableOrderBook = scanDiagnostics.selectedEnableOrderBook;
    const seedModeEnabled =
      this.config.polymarket.marketQuery.seedEventSlugs.length > 0 ||
      String(this.config.polymarket.marketQuery.seedSeriesPrefix || "").trim().length > 0;
    const discoveredCandidates = seedModeEnabled
      ? selectedSlug
        ? 1
        : 0
      : Math.max(markets.length, scanDiagnostics.counters.btc5mCandidates);
    const hasOpenPaperTrades = paperMode && this.paperLedger.getOpenTrades().length > 0;
    let oracleEst = 0;
    let oracleAgeMs = 0;
    let sigmaPricePerSqrtSec = 0;
    let sigmaPerSqrtSec = 0;
    let hydratedMarkets = markets.map((market) => this.applyWindowState(market, nowTs));

    this.pruneOldWindowState(nowTs);

    const shouldEstimateOracle =
      markets.length > 0 ||
      hasOpenPaperTrades ||
      (paperMode && this.config.polymarket.paper.forceTrade && Boolean(selectedMarket));
    let oracleState: OracleState | "IDLE" = "IDLE";
    let oracleSource = "none";
    let oracleTs: number | null = null;
    let oracleStaleMs: number | null = null;

    if (shouldEstimateOracle) {
      const oracle = await this.oracleRouter.getOracleNow(nowTs);
      this.lastOracleSnapshot = oracle;
      oracleState = oracle.state;
      oracleSource = oracle.source;
      oracleTs = oracle.rawTs > 0 ? oracle.rawTs : null;
      oracleStaleMs = Number.isFinite(oracle.staleMs) ? oracle.staleMs : null;
      const oracleUnavailable = oracleState === "ORACLE_STALE" || oracleState === "ORACLE_UNAVAILABLE";
      if (oracleUnavailable) {
        if (this.oracleStaleSinceTs === null) {
          this.oracleStaleSinceTs = nowTs;
        }
      } else {
        this.oracleStaleSinceTs = null;
      }

      if (oracle.price > 0 && oracle.rawTs > 0) {
        oracleEst = oracle.price;
        this.volEstimator.update(oracle.price, oracle.rawTs);
        this.recordOracleSample(oracle.price, oracle.rawTs, oracle.source);
        const vol = this.volEstimator.getEstimate(oracle.price, nowTs);
        sigmaPricePerSqrtSec = vol.sigmaPricePerSqrtSec;
        sigmaPerSqrtSec = vol.sigmaPerSqrtSec;
        if (!(sigmaPricePerSqrtSec > 0) && oracle.fallbackSigmaPricePerSqrtSec > 0) {
          sigmaPricePerSqrtSec = oracle.fallbackSigmaPricePerSqrtSec;
          sigmaPerSqrtSec = oracleEst > 0 ? sigmaPricePerSqrtSec / oracleEst : 0;
        }
        oracleAgeMs = Math.max(0, nowTs - oracle.rawTs);
      } else {
        oracleAgeMs = Number.POSITIVE_INFINITY;
      }

      if (selectedMarket) {
        selectedMarket = this.applyWindowState(selectedMarket, nowTs, oracleEst > 0 ? oracleEst : undefined);
      }
      hydratedMarkets = hydratedMarkets.map((market) =>
        this.applyWindowState(market, nowTs, oracleEst > 0 ? oracleEst : undefined)
      );
      await this.resolvePaperTrades(nowTs);

      if (oracleUnavailable) {
        this.setTradingPaused(true, oracleState, nowTs);
      } else if (
        oracleState === "OK" &&
        (this.pauseReason === "ORACLE_STALE" ||
          this.pauseReason === "ORACLE_UNAVAILABLE" ||
          this.pauseReason === "NETWORK_ERROR")
      ) {
        this.setTradingPaused(false, "ORACLE_RECOVERED", nowTs);
      }

      if (this.config.polymarket.mode === "live" && oracleUnavailable) {
        const staleDurationMs = this.oracleStaleSinceTs ? nowTs - this.oracleStaleSinceTs : 0;
        if (staleDurationMs >= this.config.polymarket.risk.staleKillAfterMs) {
          this.logger.error(
            {
              oracleState,
              oracleSource,
              oracleTs,
              oracleStaleMs,
              staleDurationMs,
              lastOraclePrice: oracleEst > 0 ? oracleEst : this.lastOracleSnapshot?.price ?? null
            },
            "STALE_ORACLE_FEED persisted in live mode: trading paused and continuing recovery loop"
          );
        } else {
          this.logger.warn(
            {
              oracleState,
              oracleSource,
              oracleTs,
              oracleStaleMs,
              staleDurationMs,
              staleKillAfterMs: this.config.polymarket.risk.staleKillAfterMs
            },
            "Transient oracle gap in live mode; blocking new entries and continuing"
          );
        }
        this.maybeEmitTickLog({
          marketsSeen: discoveredCandidates,
          activeWindows: hydratedMarkets.length,
          now: new Date(nowTs).toISOString(),
          currentMarketId: hydratedMarkets[0]?.marketId ?? null,
          tauSec: hydratedMarkets[0] ? Math.max(0, Math.floor((hydratedMarkets[0].endTs - nowTs) / 1000)) : null,
          priceToBeat: hydratedMarkets[0]?.priceToBeat ?? null,
          oracleEst: oracleEst > 0 ? oracleEst : null,
          sigma: sigmaPricePerSqrtSec > 0 ? sigmaPricePerSqrtSec : null,
          yesBid: null,
          yesAsk: null,
          yesMid: null,
          pUpModel: null,
          edge: null,
          threshold: null,
          action: `HOLD:${oracleState}`,
          size: null,
          openTrades: this.paperLedger.getOpenTrades().length,
          resolvedTrades: this.paperLedger.getResolvedTrades().length,
          oracleSource,
          oracleTs,
          oracleStaleMs,
          oracleState,
          selectedSlug,
          windowStart: selectedWindowStart,
          windowEnd: selectedWindowEnd,
          acceptingOrders: selectedAcceptingOrders,
          enableOrderBook: selectedEnableOrderBook
        });
        return;
      }
    }

    if (oracleState === "OK") {
      await this.maybeForcePaperTrade(
        hydratedMarkets,
        {
          nowTs,
          oracleEst,
          sigmaPricePerSqrtSec,
          sigmaPerSqrtSec,
          oracleState
        },
        selectedMarket
      );
    }

    if (!shouldEstimateOracle && this.pauseReason === "NETWORK_ERROR") {
      this.setTradingPaused(false, "NETWORK_RECOVERED", nowTs);
    }

    if (hydratedMarkets.length === 0) {
      this.maybeEmitTickLog({
        marketsSeen: discoveredCandidates,
        activeWindows: 0,
        now: new Date(nowTs).toISOString(),
        currentMarketId: selectedMarket?.marketId ?? null,
        tauSec:
          selectedMarket
            ? Math.max(0, Math.floor((selectedMarket.endTs - nowTs) / 1000))
            : null,
        priceToBeat: selectedMarket && selectedMarket.priceToBeat > 0 ? selectedMarket.priceToBeat : null,
        oracleEst: oracleEst > 0 ? oracleEst : null,
        sigma: sigmaPricePerSqrtSec > 0 ? sigmaPricePerSqrtSec : null,
        yesBid: null,
        yesAsk: null,
        yesMid: null,
        pUpModel: null,
        edge: null,
        threshold: null,
        action: oracleState !== "OK" && oracleState !== "IDLE" ? `HOLD:${oracleState}` : "HOLD",
        size: null,
        openTrades: this.paperLedger.getOpenTrades().length,
        resolvedTrades: this.paperLedger.getResolvedTrades().length,
        oracleSource,
        oracleTs,
        oracleStaleMs,
        oracleState,
        selectedSlug,
        windowStart: selectedWindowStart,
        windowEnd: selectedWindowEnd,
        acceptingOrders: selectedAcceptingOrders,
        enableOrderBook: selectedEnableOrderBook
      });
      return;
    }

    if (shouldEstimateOracle && !(oracleEst > 0)) {
      this.maybeEmitTickLog({
        marketsSeen: discoveredCandidates,
        activeWindows: hydratedMarkets.length,
        now: new Date(nowTs).toISOString(),
        currentMarketId: hydratedMarkets[0]?.marketId ?? null,
        tauSec: hydratedMarkets[0] ? Math.max(0, Math.floor((hydratedMarkets[0].endTs - nowTs) / 1000)) : null,
        priceToBeat: hydratedMarkets[0]?.priceToBeat ?? null,
        oracleEst: null,
        sigma: null,
        yesBid: null,
        yesAsk: null,
        yesMid: null,
        pUpModel: null,
        edge: null,
        threshold: null,
        action: `HOLD:${oracleState}`,
        size: null,
        openTrades: this.paperLedger.getOpenTrades().length,
        resolvedTrades: this.paperLedger.getResolvedTrades().length,
        oracleSource,
        oracleTs,
        oracleStaleMs,
        oracleState,
        selectedSlug,
        windowStart: selectedWindowStart,
        windowEnd: selectedWindowEnd,
        acceptingOrders: selectedAcceptingOrders,
        enableOrderBook: selectedEnableOrderBook
      });
      return;
    }

    let tickLog: TickLogLine = {
      marketsSeen: discoveredCandidates,
      activeWindows: hydratedMarkets.length,
      now: new Date(nowTs).toISOString(),
      currentMarketId: hydratedMarkets[0]?.marketId ?? null,
      tauSec: hydratedMarkets[0] ? Math.max(0, Math.floor((hydratedMarkets[0].endTs - nowTs) / 1000)) : null,
      priceToBeat: hydratedMarkets[0]?.priceToBeat ?? null,
      oracleEst: oracleEst > 0 ? oracleEst : null,
      sigma: sigmaPricePerSqrtSec > 0 ? sigmaPricePerSqrtSec : null,
      yesBid: null,
      yesAsk: null,
      yesMid: null,
      pUpModel: null,
      edge: null,
      threshold: null,
      action: "HOLD",
      size: null,
      openTrades: this.paperLedger.getOpenTrades().length,
      resolvedTrades: this.paperLedger.getResolvedTrades().length,
      oracleSource,
      oracleTs,
      oracleStaleMs,
      oracleState,
      selectedSlug,
      windowStart: selectedWindowStart,
      windowEnd: selectedWindowEnd,
      acceptingOrders: selectedAcceptingOrders,
      enableOrderBook: selectedEnableOrderBook
    };
    const fastMidSnapshot = this.oracleRouter.getFastMidNow(nowTs);
    const fastMidNow =
      fastMidSnapshot && fastMidSnapshot.price > 0
        ? fastMidSnapshot.price
        : oracleEst > 0
          ? oracleEst
          : 0;
    const lagStatsSnapshot = this.lagProfiler.getStats();
    const lagPolyP90Ms = lagStatsSnapshot.metrics.polyUpdateAgeMs.p90;
    const shortReturn = this.computeShortReturn(nowTs, 45);
    const realizedVolPricePerSqrtSec = this.computeRealizedVolPricePerSqrtSec(
      nowTs,
      fastMidNow > 0 ? fastMidNow : oracleEst,
      sigmaPricePerSqrtSec,
      300
    );

    for (const market of hydratedMarkets) {
      const tauSec = Math.max(0, Math.floor((market.endTs - nowTs) / 1000));
      if (tauSec <= 0) continue;
      if (!(market.priceToBeat > 0)) continue;

      const windowStartTs =
        market.startTs ??
        Math.max(0, market.endTs - this.config.polymarket.marketQuery.cadenceMinutes * 60_000);
      const elapsedSec = Math.max(0, Math.floor((nowTs - windowStartTs) / 1000));
      const remainingSec = tauSec;

      const implied = await this.getImpliedYesBook(market);
      const orderBook = {
        marketId: market.marketId,
        tokenId: market.yesTokenId,
        yesBid: implied.yesBid,
        yesAsk: implied.yesAsk,
        yesMid: implied.yesMid,
        spread: implied.spread,
        bids: [],
        asks: [],
        ts: nowTs
      };
      const prob = this.probModel.computeAdaptive({
        oracleEst: fastMidNow > 0 ? fastMidNow : oracleEst,
        priceToBeat: market.priceToBeat,
        tauSec,
        cadenceSec: this.config.polymarket.marketQuery.cadenceMinutes * 60,
        shortReturn,
        realizedVolPricePerSqrtSec
      });
      const polyUpdateAgeMs = implied.bookTs > 0 ? Math.max(0, nowTs - implied.bookTs) : 0;
      const calibrated = this.probModel.computeExpiryProbCalibrated({
        fastMid: fastMidNow > 0 ? fastMidNow : oracleEst,
        priceToBeat: market.priceToBeat,
        sigmaPricePerSqrtSec,
        tauSec,
        polyUpdateAgeMs,
        lagPolyP90Ms,
        oracleAgeMs: oracleAgeMs > 0 && Number.isFinite(oracleAgeMs) ? oracleAgeMs : 0
      });
      const pForExtreme = calibrated.pBoosted;

      const decision = this.strategy.decide({
        pUpModel: prob.pUpModel,
        orderBook,
        sigmaPerSqrtSec,
        tauSec
      });
      let noAsk = estimateNoAskFromYesBook(decision.yesBid);
      let noTopAskSize = 0;
      if (market.noTokenId) {
        const noQuote = await this.getNoAskAndDepthFromTokenId(market.noTokenId, noAsk);
        noAsk = noQuote.noAsk;
        noTopAskSize = noQuote.topAskSize;
      }
      const yesEntryPrice = decision.yesAsk > 0 ? decision.yesAsk : decision.yesMid;
      const noEntryPrice = noAsk > 0 ? noAsk : estimateNoAskFromYesBook(decision.yesBid);
      const feeBps = paperMode ? this.config.polymarket.paper.feeBps : this.config.takerFeeBps;
      const slippageBps = paperMode ? this.config.polymarket.paper.slippageBps : this.config.takerSlipBps;
      const spreadProxy = Math.max(0, decision.spread) / 2;
      const costPenaltyProb = Math.max(0, feeBps + slippageBps) / 10_000 + spreadProxy;
      const edgeYes = prob.pUpModel - yesEntryPrice;
      const edgeNo = (1 - prob.pUpModel) - noEntryPrice;
      const netEdgeYes = edgeYes - costPenaltyProb;
      const netEdgeNo = edgeNo - costPenaltyProb;
      const stalenessEdge = this.computeStalenessEdge(market.marketId, decision.yesMid, oracleEst, nowTs);
      const convictionBase = Math.abs(prob.pUpModel - decision.yesMid);
      const conviction = clamp(convictionBase + stalenessEdge, 0, 0.9999);
      const chosenSide: "YES" | "NO" = netEdgeYes >= netEdgeNo ? "YES" : "NO";
      const chosenEdge = chosenSide === "YES" ? edgeYes : edgeNo;
      const netEdgeAfterCosts = chosenSide === "YES" ? netEdgeYes : netEdgeNo;
      const signedEdge = chosenSide === "YES" ? edgeYes : -edgeNo;
      const chosenAsk = chosenSide === "YES" ? yesEntryPrice : noEntryPrice;
      const extremeLow = this.config.polymarket.paper.extremeLowPrice;
      const extremeHigh = this.config.polymarket.paper.extremeHighPrice;
      const isExtremePrice = chosenAsk <= extremeLow || chosenAsk >= extremeHigh;
      const probExtreme = this.config.polymarket.paper.probExtreme;
      const hasExtremeModel =
        chosenSide === "YES"
          ? pForExtreme >= probExtreme
          : pForExtreme <= 1 - probExtreme;
      const inSnipingWindow =
        remainingSec <= this.config.polymarket.paper.entryMaxRemainingSec &&
        remainingSec >= this.config.polymarket.paper.entryMinRemainingSec;
      const minNetEdge = Math.max(
        this.config.polymarket.paper.minNetEdge,
        this.config.polymarket.paper.minEdgeThreshold
      );
      const requiredNetEdge = Math.max(minNetEdge, decision.threshold);
      const decisionAction =
        netEdgeAfterCosts > requiredNetEdge
          ? chosenSide === "YES"
            ? "BUY_YES"
            : "BUY_NO"
          : "HOLD";

      this.lagProfiler.record({
        tsMs: nowTs,
        windowSlug: market.eventSlug || market.slug || market.marketId,
        tauSec,
        priceToBeat: market.priceToBeat,
        fastMid: fastMidNow > 0 ? fastMidNow : null,
        oraclePrice: oracleEst > 0 ? oracleEst : null,
        oracleUpdatedAtMs: oracleTs ?? null,
        yesBid: implied.yesBid,
        yesAsk: implied.yesAsk,
        yesMid: implied.yesMid,
        impliedProbMid: implied.yesMid,
        pModel: prob.pUpModel,
        absProbGap: Math.abs(prob.pUpModel - implied.yesMid)
      });

      this.latestPolymarketSnapshot = {
        windowSlug: market.eventSlug || market.slug || market.marketId,
        tauSec,
        priceToBeat: market.priceToBeat,
        fastMid: fastMidNow > 0 ? fastMidNow : null,
        yesMid: implied.yesMid,
        impliedProbMid: implied.yesMid
      };
      this.latestModelSnapshot = {
        pBase: calibrated.pBase,
        pBoosted: calibrated.pBoosted,
        z: calibrated.z,
        d: calibrated.d,
        sigma: calibrated.sigma,
        tauSec: calibrated.tauSec,
        polyUpdateAgeMs: calibrated.polyUpdateAgeMs,
        lagPolyP90Ms: calibrated.lagPolyP90Ms,
        oracleAgeMs: calibrated.oracleAgeMs,
        boostApplied: calibrated.boostApplied,
        boostReason: calibrated.boostReason
      };

      if (paperMode) {
        await this.managePaperOpenPositions({
          nowTs,
          market,
          implied,
          edgeYes,
          edgeNo,
          costPenaltyProb,
          remainingSec
        });
      }

      const openOrderCount = paperMode ? 0 : this.execution.getOpenOrderCount();
      const totalExposureUsd = paperMode
        ? this.paperLedger.getOpenTrades().reduce((sum, row) => sum + row.entryCostUsd + row.feesUsd, 0)
        : this.execution.getTotalExposureUsd();
      const concurrentWindows = paperMode
        ? new Set(this.paperLedger.getOpenTrades().map((row) => row.marketId)).size
        : this.execution.getConcurrentWindows();
      const paperOpenNotional = this.paperLedger.getOpenNotionalForMarket(market.marketId);
      const livePositions = this.execution.getPositions();
      const liveExistingPosition = livePositions.find((row) => row.marketId === market.marketId);
      const liveWindowBudget = Math.max(
        0,
        this.config.polymarket.sizing.maxNotionalPerWindow - (liveExistingPosition?.costUsd ?? 0)
      );
      const paperWindowBudget = Math.max(
        0,
        this.config.polymarket.paper.maxNotionalPerWindow - paperOpenNotional
      );
      const remainingWindowBudget = paperMode
        ? Math.min(liveWindowBudget, paperWindowBudget)
        : liveWindowBudget;
      const remainingExposureBudget = Math.max(0, this.config.polymarket.risk.maxExposure - totalExposureUsd);
      const desiredSide = chosenSide;
      const sidePrice = desiredSide === "YES" ? decision.yesAsk : noAsk;
      const sideProb = desiredSide === "YES" ? prob.pUpModel : 1 - prob.pUpModel;
      const topAskDepthShares = desiredSide === "YES" ? implied.topAskSize : noTopAskSize;
      const depthCapNotionalUsd =
        topAskDepthShares > 0
          ? topAskDepthShares * Math.max(0.0001, sidePrice) * 0.35
          : 0;
      const size = this.sizing.compute({
        edge: Math.max(0, netEdgeAfterCosts),
        pUpModel: sideProb,
        yesAsk: sidePrice,
        conviction,
        remainingSec,
        entryMaxRemainingSec: this.config.polymarket.paper.entryMaxRemainingSec,
        depthCapNotionalUsd,
        remainingWindowBudget,
        remainingExposureBudget,
        remainingDailyLossBudget: this.risk.getRemainingDailyLossBudget()
      });

      let action = decisionAction;
      let executedSize = size.notionalUsd;
      let canAttemptTrade = (decisionAction === "BUY_YES" || decisionAction === "BUY_NO") && size.notionalUsd > 0;
      let blockReason = "";

      if (!(decision.yesBid > 0) || !(decision.yesAsk > 0)) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "MISSING_BBO";
      }
      if (decision.yesAsk < decision.yesBid) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "CROSSED_BBO";
      }
      if (decision.spread > this.config.polymarket.threshold.maxSpread) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "SPREAD_TOO_WIDE";
      }
      if (decision.yesMid < 0.001 || decision.yesMid > 0.999) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "YES_MID_OUT_OF_RANGE";
      }
      if (paperMode && oracleState !== "OK") {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = oracleState;
      }
      if (paperMode && netEdgeAfterCosts < this.config.polymarket.paper.minEdgeThreshold) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "NET_EDGE_BELOW_PAPER_MIN";
      }
      if (!(netEdgeAfterCosts > minNetEdge)) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "NET_EDGE_BELOW_MIN_NET_EDGE";
      }
      if (!inSnipingWindow) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "OUTSIDE_SNIPING_WINDOW";
      }
      if (!isExtremePrice) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "NON_EXTREME_PRICE";
      }
      if (!hasExtremeModel) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "MODEL_NOT_EXTREME";
      }
      if (remainingSec < this.config.polymarket.risk.noNewOrdersInLastSec) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = "NO_NEW_ORDERS_FINAL_SECONDS";
      }
      if (paperMode && !this.config.polymarket.paper.allowMultipleTradesPerWindow) {
        const windowTrades = this.paperLedger.getTradesForWindow(market.marketId, windowStartTs, market.endTs);
        const openWindowTrade = windowTrades.find((row) => !row.resolvedAt);
        if (openWindowTrade) {
          action = "HOLD";
          executedSize = 0;
          canAttemptTrade = false;
          blockReason = "WINDOW_ALREADY_OPEN";
        } else if (windowTrades.length > 0) {
          const profitableClosures = windowTrades.filter((row) => Number(row.pnlUsd || 0) > 0).length;
          const hasNonProfitableClose = windowTrades.some(
            (row) => row.resolvedAt && Number(row.pnlUsd || 0) <= 0
          );
          const allowSingleReentry =
            profitableClosures >= 1 &&
            !hasNonProfitableClose &&
            windowTrades.length < 2 &&
            remainingSec > this.config.polymarket.paper.entryMinRemainingSec;
          if (!allowSingleReentry) {
            action = "HOLD";
            executedSize = 0;
            canAttemptTrade = false;
            blockReason = "WINDOW_ALREADY_TRADED";
          }
        }
      }
      if (this.tradingPaused) {
        action = "HOLD";
        executedSize = 0;
        canAttemptTrade = false;
        blockReason = this.pauseReason ? `TRADING_PAUSED_${this.pauseReason}` : "TRADING_PAUSED";
      }

      if (canAttemptTrade) {
        if (this.config.polymarket.killSwitch) {
          action = "HOLD";
          executedSize = 0;
          blockReason = "KILL_SWITCH";
        } else {
          const check = this.risk.checkNewOrder({
            tauSec,
            oracleAgeMs,
            projectedOrderNotionalUsd: size.notionalUsd,
            openOrders: openOrderCount,
            totalExposureUsd,
            concurrentWindows
          });

          if (!check.ok) {
            action = "HOLD";
            executedSize = 0;
            if (check.reason?.startsWith("KILL_SWITCH") && this.canMutateVenueState()) {
              await this.execution.cancelAll(check.reason);
            }
            blockReason = check.reason || "RISK_BLOCKED";
          } else if (paperMode) {
            const accepted = this.executePaperTrade({
              marketId: market.marketId,
              marketSlug: market.eventSlug || market.slug,
              windowStartTs,
              windowEndTs: market.endTs,
              priceToBeat: market.priceToBeat,
              side: desiredSide,
              yesBid: decision.yesBid,
              yesAsk: decision.yesAsk,
              noAsk,
              edge: netEdgeAfterCosts,
              pBase: calibrated.pBase,
              pBoosted: calibrated.pBoosted,
              boostApplied: calibrated.boostApplied,
              boostReason: calibrated.boostReason,
              requestedNotionalUsd: size.notionalUsd,
              ts: nowTs
            });
            action = accepted ? (decisionAction === "BUY_NO" ? "BUY_NO" : "BUY_YES") : "HOLD";
            executedSize = accepted ? size.notionalUsd : 0;
            if (!accepted) {
              blockReason = "PAPER_TRADE_REJECTED";
            }
          } else if (decisionAction === "BUY_NO") {
            action = "HOLD";
            executedSize = 0;
            blockReason = "LIVE_NO_SIDE_DISABLED";
          } else {
            const result = await this.execution.executeBuyYes({
              marketId: market.marketId,
              tokenId: market.yesTokenId,
              yesAsk: decision.yesAsk,
              notionalUsd: size.notionalUsd,
              tickSize: market.tickSize,
              negRisk: market.negRisk
            });
            action = result.accepted ? "BUY_YES" : "HOLD";
            executedSize = result.accepted ? size.notionalUsd : 0;
            if (!result.accepted) {
              blockReason = result.reason || "LIVE_REJECTED";
            }
          }
        }
      } else {
        action = "HOLD";
        executedSize = 0;
      }

      const openTradesCount = this.paperLedger.getOpenTrades().length;
      const resolvedTradesCount = this.paperLedger.getResolvedTrades().length;
      tickLog = {
        marketsSeen: discoveredCandidates,
        activeWindows: hydratedMarkets.length,
        now: new Date(nowTs).toISOString(),
        currentMarketId: market.marketId,
        tauSec,
        priceToBeat: market.priceToBeat,
        oracleEst,
        sigma: sigmaPricePerSqrtSec,
        yesBid: decision.yesBid,
        yesAsk: decision.yesAsk,
        yesMid: decision.yesMid,
        pUpModel: prob.pUpModel,
        pBase: calibrated.pBase,
        pBoosted: calibrated.pBoosted,
        z: calibrated.z,
        d: calibrated.d,
        sigmaCalibrated: calibrated.sigma,
        polyUpdateAgeMs: calibrated.polyUpdateAgeMs,
        lagPolyP90Ms: calibrated.lagPolyP90Ms,
        boostApplied: calibrated.boostApplied,
        boostReason: calibrated.boostReason,
        edge: signedEdge,
        edgeYes,
        edgeNo,
        chosenSide,
        chosenEdge,
        conviction,
        stalenessEdge,
        netEdgeAfterCosts,
        threshold: decision.threshold,
        action,
        size: executedSize,
        openTrades: openTradesCount,
        resolvedTrades: resolvedTradesCount,
        oracleSource,
        oracleTs,
        oracleStaleMs,
        oracleState,
        selectedSlug,
        windowStart: selectedWindowStart,
        windowEnd: selectedWindowEnd,
        acceptingOrders: selectedAcceptingOrders,
        enableOrderBook: selectedEnableOrderBook,
        tradingPaused: this.tradingPaused,
        pauseReason: this.pauseReason || null,
        pauseSinceTs: this.pauseSinceTs
      };

      this.writeDecisionLog({
        ts: new Date(nowTs).toISOString(),
        marketId: market.marketId,
        slug: market.eventSlug || market.slug || selectedSlug || undefined,
        tauSec,
        priceToBeat: market.priceToBeat,
        oracleEst,
        sigma: sigmaPricePerSqrtSec,
        pUpModel: prob.pUpModel,
        pBase: calibrated.pBase,
        pBoosted: calibrated.pBoosted,
        z: calibrated.z,
        d: calibrated.d,
        sigmaCalibrated: calibrated.sigma,
        polyUpdateAgeMs: calibrated.polyUpdateAgeMs,
        lagPolyP90Ms: calibrated.lagPolyP90Ms,
        boostApplied: calibrated.boostApplied,
        boostReason: calibrated.boostReason,
        yesBid: decision.yesBid,
        yesAsk: decision.yesAsk,
        yesMid: decision.yesMid,
        edge: signedEdge,
        edgeYes,
        edgeNo,
        chosenSide,
        chosenEdge,
        conviction,
        stalenessEdge,
        netEdgeAfterCosts,
        threshold: decision.threshold,
        action: blockReason ? `${action}:${blockReason}` : action,
        size: executedSize,
        mode: this.config.polymarket.mode,
        openTrades: openTradesCount,
        resolvedTrades: resolvedTradesCount,
        oracleSource,
        oracleTs: oracleTs ?? undefined,
        oracleStaleMs: oracleStaleMs ?? undefined,
        oracleState: oracleState !== "IDLE" ? oracleState : undefined,
        tradingPaused: this.tradingPaused,
        pauseReason: this.pauseReason || undefined,
        pauseSinceTs: this.pauseSinceTs ?? undefined
      });
    }

    const riskSnapshot = this.risk.snapshot({
      openOrders: this.config.polymarket.mode === "paper" ? 0 : this.execution.getOpenOrderCount(),
      totalExposureUsd:
        this.config.polymarket.mode === "paper"
          ? this.paperLedger.getOpenTrades().reduce((sum, row) => sum + row.entryCostUsd + row.feesUsd, 0)
          : this.execution.getTotalExposureUsd(),
      concurrentWindows:
        this.config.polymarket.mode === "paper"
          ? new Set(this.paperLedger.getOpenTrades().map((row) => row.marketId)).size
          : this.execution.getConcurrentWindows()
    });

    this.maybeEmitTickLog(tickLog);

    if (riskSnapshot.totalExposureUsd >= this.config.polymarket.risk.maxExposure) {
      if (!this.risk.isKillSwitchActive()) {
        this.risk.triggerKillSwitch("MAX_EXPOSURE_REACHED");
      }
      if (this.canMutateVenueState()) {
        await this.execution.cancelAll("MAX_EXPOSURE_REACHED");
      }
      this.logger.error(
        {
          totalExposureUsd: riskSnapshot.totalExposureUsd,
          maxExposure: this.config.polymarket.risk.maxExposure
        },
        "Polymarket max exposure reached; kill-switch active but engine loop will continue in HOLD"
      );
    }
  }

  private executePaperTrade(params: {
    marketId: string;
    marketSlug?: string;
    windowStartTs: number;
    windowEndTs: number;
    priceToBeat: number;
    side: "YES" | "NO";
    yesBid: number;
    yesAsk: number;
    noAsk?: number;
    edge: number;
    pBase?: number;
    pBoosted?: number;
    boostApplied?: boolean;
    boostReason?: string;
    requestedNotionalUsd: number;
    ts: number;
    forced?: boolean;
  }): boolean {
    const tradesLastHour = this.paperLedger.countTradesSince(params.ts - 60 * 60 * 1000);
    if (tradesLastHour >= this.config.polymarket.paper.maxTradesPerHour) {
      return false;
    }

    const openNotional = this.paperLedger.getOpenNotionalForMarket(params.marketId);
    const remainingWindowNotional = Math.max(
      0,
      this.config.polymarket.paper.maxNotionalPerWindow - openNotional
    );
    const notionalUsd = Math.min(params.requestedNotionalUsd, remainingWindowNotional);
    if (!(notionalUsd > 0)) {
      return false;
    }

    const noAsk = params.noAsk && params.noAsk > 0 ? params.noAsk : estimateNoAskFromYesBook(params.yesBid);
    const noBid = estimateNoBidFromYesBook(params.yesAsk);
    const yesMid = clamp((params.yesBid + params.yesAsk) / 2, params.yesBid, params.yesAsk);
    const noMid = clamp((noBid + noAsk) / 2, noBid, noAsk);
    const takerEdgeTrigger = Math.max(this.config.polymarket.paper.minEdgeThreshold * 2, 0.05);
    const useTakerEntry = Boolean(params.forced) || params.edge >= takerEdgeTrigger;
    const rawEntryPrice =
      params.side === "YES"
        ? useTakerEntry
          ? params.yesAsk
          : yesMid
        : useTakerEntry
          ? noAsk
          : noMid;
    const effectiveSlippageBps = useTakerEntry
      ? this.config.polymarket.paper.slippageBps
      : this.config.polymarket.paper.slippageBps * 0.25;
    const entryPrice = applyTakerSlippage(rawEntryPrice, effectiveSlippageBps);
    const qty = notionalUsd / Math.max(0.0001, entryPrice);
    if (!(qty > 0)) {
      return false;
    }
    const entryCostUsd = qty * entryPrice;
    const feesUsd = entryCostUsd * (this.config.polymarket.paper.feeBps / 10_000);

    const trade = this.paperLedger.recordTrade({
      marketId: params.marketId,
      marketSlug: params.marketSlug,
      windowStartTs: params.windowStartTs,
      windowEndTs: params.windowEndTs,
      side: params.side,
      entryPrice,
      qty,
      notionalUsd: entryCostUsd,
      feeBps: this.config.polymarket.paper.feeBps,
      slippageBps: this.config.polymarket.paper.slippageBps,
      feesUsd,
      entryCostUsd,
      priceToBeat: params.priceToBeat,
      createdTs: params.ts
    });
    const openSummary = this.paperLedger.getSummary(params.ts);

    this.writePaperTradeLog({
      ts: new Date(params.ts).toISOString(),
      event: "TRADE_OPEN",
      entryStyle: useTakerEntry ? "TAKER" : "MAKER_LIMIT",
      tradeId: trade.id,
      marketId: trade.marketId,
      marketSlug: trade.marketSlug || null,
      side: trade.side,
      entryPrice: trade.entryPrice,
      qty: trade.qty,
      notionalUsd: trade.notionalUsd,
      feesUsd: trade.feesUsd,
      edge: params.edge,
      pBase: params.pBase ?? null,
      pBoosted: params.pBoosted ?? null,
      boostApplied: Boolean(params.boostApplied),
      boostReason: params.boostReason || null,
      cumulativePnlUsd: openSummary.totalPnlUsd,
      wins: openSummary.wins,
      losses: openSummary.losses,
      winRate: openSummary.winRate
    });

    this.logger.info(
      {
        tradeId: trade.id,
        marketId: trade.marketId,
        marketSlug: trade.marketSlug || null,
        side: trade.side,
        entryStyle: useTakerEntry ? "TAKER" : "MAKER_LIMIT",
        entryPrice: trade.entryPrice,
        qty: trade.qty,
        notionalUsd: trade.notionalUsd,
        feesUsd: trade.feesUsd
      },
      params.forced ? "PAPER FORCE TRADE CREATED" : "PAPER TRADE CREATED"
    );
    return true;
  }

  private async managePaperOpenPositions(params: {
    nowTs: number;
    remainingSec: number;
    market: {
      marketId: string;
      noTokenId?: string;
      eventSlug?: string;
      slug?: string;
    };
    implied: {
      yesBid: number;
      yesAsk: number;
      yesMid: number;
      spread: number;
    };
    edgeYes: number;
    edgeNo: number;
    costPenaltyProb: number;
  }): Promise<void> {
    if (this.config.polymarket.mode !== "paper") return;

    const openTrades = this.paperLedger.getOpenTrades().filter((row) => row.marketId === params.market.marketId);
    if (openTrades.length === 0) return;

    let noBid = estimateNoBidFromYesBook(params.implied.yesAsk);
    if (params.market.noTokenId) {
      noBid = await this.getNoBidFromTokenId(params.market.noTokenId, noBid);
    }

    for (const trade of openTrades) {
      const heldNetEdge =
        trade.side === "YES"
          ? params.edgeYes - params.costPenaltyProb
          : params.edgeNo - params.costPenaltyProb;
      const previousTicks = this.paperStopLossTicksByTradeId.get(trade.id) || 0;
      const negativeTicks =
        heldNetEdge < -this.config.polymarket.paper.stopLossEdge ? previousTicks + 1 : 0;
      this.paperStopLossTicksByTradeId.set(trade.id, negativeTicks);

      const rawExitPx = trade.side === "YES" ? params.implied.yesBid : noBid;
      const exitPrice = applySellSlippage(rawExitPx, this.config.polymarket.paper.slippageBps);
      const mtm = computePaperClosePnl({
        qty: trade.qty,
        entryCostUsd: trade.entryCostUsd,
        entryFeesUsd: trade.feesUsd,
        exitPrice,
        feeBps: trade.feeBps
      });
      const priceDelta = exitPrice - trade.entryPrice;

      let closeReason: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | null = null;
      if (negativeTicks >= this.config.polymarket.paper.stopLossConsecutiveTicks) {
        closeReason = "STOP_LOSS";
      } else if (
        mtm.pnlUsd >= this.config.polymarket.paper.takeProfitUsd ||
        priceDelta >= this.config.polymarket.paper.takeProfitDelta
      ) {
        closeReason = "TAKE_PROFIT";
      } else if (
        params.remainingSec < this.config.polymarket.risk.noNewOrdersInLastSec &&
        mtm.pnlUsd > 0
      ) {
        closeReason = "TIME_EXIT_PROFIT";
      }

      if (!closeReason) continue;
      this.closePaperTrade(trade.id, closeReason, exitPrice, mtm, params.nowTs);
    }
  }

  private closePaperTrade(
    tradeId: string,
    closeReason: "STOP_LOSS" | "TAKE_PROFIT" | "TIME_EXIT_PROFIT" | "MANUAL",
    exitPrice: number,
    mtm: { exitProceedsUsd: number; exitFeesUsd: number; pnlUsd: number },
    nowTs: number
  ): void {
    const closed = this.paperLedger.closeTrade({
      tradeId,
      resolvedAt: nowTs,
      closeReason,
      exitPrice,
      exitProceedsUsd: mtm.exitProceedsUsd,
      exitFeesUsd: mtm.exitFeesUsd,
      pnlUsd: mtm.pnlUsd
    });
    if (!closed) return;
    this.paperStopLossTicksByTradeId.delete(tradeId);
    const closeSummary = this.paperLedger.getSummary(nowTs);
    const result = mtm.pnlUsd > 0 ? "WIN" : "LOSS";

    this.writePaperTradeLog({
      ts: new Date(nowTs).toISOString(),
      event: "TRADE_CLOSED",
      tradeId: closed.id,
      marketId: closed.marketId,
      marketSlug: closed.marketSlug || null,
      side: closed.side,
      closeReason,
      exitPrice,
      exitProceedsUsd: mtm.exitProceedsUsd,
      exitFeesUsd: mtm.exitFeesUsd,
      pnlUsd: mtm.pnlUsd,
      result,
      cumulativePnlUsd: closeSummary.totalPnlUsd,
      wins: closeSummary.wins,
      losses: closeSummary.losses,
      winRate: closeSummary.winRate
    });

    this.logger.info(
      {
        tradeId: closed.id,
        marketId: closed.marketId,
        marketSlug: closed.marketSlug || null,
        side: closed.side,
        closeReason,
        exitPrice,
        pnlUsd: mtm.pnlUsd
      },
      "PAPER TRADE CLOSED"
    );
  }

  private async resolvePaperTrades(nowTs: number): Promise<void> {
    if (this.config.polymarket.mode !== "paper") {
      return;
    }

    const openTrades = this.paperLedger.getOpenTrades();
    for (const trade of openTrades) {
      const targetTs = trade.windowEndTs + this.config.polymarket.paper.resolveGraceMs;
      if (targetTs > nowTs) continue;

      const oracleSample = this.pickOracleAtOrAfter(targetTs);
      if (!oracleSample || !(oracleSample.px > 0)) {
        if (nowTs - targetTs >= 30_000) {
          const lastLogged = this.resolutionPendingLogByTradeId.get(trade.id) || 0;
          if (nowTs - lastLogged >= 10_000) {
            this.resolutionPendingLogByTradeId.set(trade.id, nowTs);
            this.logger.warn(
              {
                tradeId: trade.id,
                marketId: trade.marketId,
                marketSlug: trade.marketSlug || null,
                targetTs,
                nowTs
              },
              "PAPER RESOLUTION PENDING: awaiting oracle snapshot at/after window end"
            );
          }
        }
        continue;
      }

      const oracleAtEnd = oracleSample.px;
      const outcome = inferOutcomeFromOracle(oracleAtEnd, trade.priceToBeat);
      const resolutionSource: "oracle_proxy" | "internal_fair_mid" =
        oracleSample.source === "internal_fair_mid" ? "internal_fair_mid" : "oracle_proxy";

      const pnl = computePaperPnl({
        side: trade.side,
        outcome,
        qty: trade.qty,
        entryPrice: trade.entryPrice,
        feeBps: trade.feeBps
      });
      const resolved = this.paperLedger.resolveTrade({
        tradeId: trade.id,
        resolvedAt: nowTs,
        outcome,
        payoutUsd: pnl.payoutUsd,
        pnlUsd: pnl.pnlUsd,
        oracleAtEnd: oracleAtEnd > 0 ? oracleAtEnd : undefined,
        resolutionSource
      });
      if (!resolved) continue;
      const resolveSummary = this.paperLedger.getSummary(nowTs);
      const result = pnl.pnlUsd > 0 ? "WIN" : "LOSS";

      this.writePaperTradeLog({
        ts: new Date(nowTs).toISOString(),
        event: "TRADE_RESOLVED",
        tradeId: resolved.id,
        marketId: resolved.marketId,
        marketSlug: resolved.marketSlug || null,
        side: resolved.side,
        winner: outcome,
        finalOraclePrice: oracleAtEnd > 0 ? oracleAtEnd : null,
        exitPayoutUsd: pnl.payoutUsd,
        pnlUsd: pnl.pnlUsd,
        oracleAtEnd: oracleAtEnd > 0 ? oracleAtEnd : undefined,
        resolutionSource,
        result,
        cumulativePnlUsd: resolveSummary.totalPnlUsd,
        wins: resolveSummary.wins,
        losses: resolveSummary.losses,
        winRate: resolveSummary.winRate
      });
      this.resolutionPendingLogByTradeId.delete(trade.id);
      this.paperStopLossTicksByTradeId.delete(trade.id);

      this.logger.info(
        {
          tradeId: resolved.id,
          marketId: resolved.marketId,
          outcome,
          payoutUsd: pnl.payoutUsd,
          pnlUsd: pnl.pnlUsd,
          oracleAtEnd: oracleAtEnd > 0 ? oracleAtEnd : undefined,
          resolutionSource
        },
        "PAPER TRADE RESOLVED"
      );
    }
  }

  private async maybeForcePaperTrade(
    markets: Array<{
      marketId: string;
      slug?: string;
      priceToBeat: number;
      startTs?: number;
      endTs: number;
      yesTokenId: string;
      noTokenId?: string;
      acceptingOrders?: boolean;
      eventSlug?: string;
      yesBidHint?: number;
      yesAskHint?: number;
      yesMidHint?: number;
      yesLastTradeHint?: number;
      outcomePricesHint?: number[];
    }>,
    context: {
      nowTs: number;
      oracleEst: number;
      sigmaPricePerSqrtSec: number;
      sigmaPerSqrtSec: number;
      oracleState: OracleState | "IDLE";
    },
    selectedMarket?: {
      marketId: string;
      slug?: string;
      priceToBeat: number;
      startTs?: number;
      endTs: number;
      yesTokenId: string;
      noTokenId?: string;
      acceptingOrders?: boolean;
      eventSlug?: string;
      yesBidHint?: number;
      yesAskHint?: number;
      yesMidHint?: number;
      yesLastTradeHint?: number;
      outcomePricesHint?: number[];
    } | null
  ): Promise<void> {
    if (this.config.polymarket.mode !== "paper") return;
    if (this.config.polymarket.killSwitch) return;
    if (this.tradingPaused) return;
    if (!this.config.polymarket.paper.forceTrade) return;
    if (context.oracleState !== "OK") return;
    const intervalMs = this.config.polymarket.paper.forceIntervalSec * 1000;
    if (context.nowTs - this.lastForceTradeTs < intervalMs) return;
    const candidate =
      markets.length > 0
        ? markets[0]
        : selectedMarket && selectedMarket.endTs > context.nowTs
          ? selectedMarket
          : null;
    if (!candidate) return;
    if (!(candidate.priceToBeat > 0)) {
      this.logger.info(
        {
          marketId: candidate.marketId,
          selectedSlug: candidate.eventSlug || null
        },
        "forceTrade skipped: missing priceToBeat"
      );
      return;
    }

    if (!candidate.acceptingOrders) {
      this.logger.info(
        {
          marketId: candidate.marketId,
          selectedSlug: candidate.eventSlug || null
        },
        "forceTrade skipped: not accepting orders"
      );
      return;
    }

    const market = candidate;
    const tauSec = Math.max(0, Math.floor((market.endTs - context.nowTs) / 1000));
    if (tauSec <= 0) return;

    const implied = await this.getImpliedYesBook(market);
    const shortReturn = this.computeShortReturn(context.nowTs, 45);
    const realizedVolPricePerSqrtSec = this.computeRealizedVolPricePerSqrtSec(
      context.nowTs,
      context.oracleEst,
      context.sigmaPricePerSqrtSec,
      300
    );
    const prob = this.probModel.computeAdaptive({
      oracleEst: context.oracleEst,
      priceToBeat: market.priceToBeat,
      tauSec,
      cadenceSec: this.config.polymarket.marketQuery.cadenceMinutes * 60,
      shortReturn,
      realizedVolPricePerSqrtSec
    });
    const decision = this.strategy.decide({
      pUpModel: prob.pUpModel,
      orderBook: {
        marketId: market.marketId,
        tokenId: market.yesTokenId,
        yesBid: implied.yesBid,
        yesAsk: implied.yesAsk,
        yesMid: implied.yesMid,
        spread: implied.spread,
        bids: [],
        asks: [],
        ts: context.nowTs
      },
      sigmaPerSqrtSec: context.sigmaPerSqrtSec,
      tauSec
    });

    const configured = this.config.polymarket.paper.forceSide;
    const edgeYes = prob.pUpModel - implied.yesAsk;
    let noAsk = estimateNoAskFromYesBook(implied.yesBid);
    if (market.noTokenId) {
      noAsk = await this.getNoAskFromTokenId(market.noTokenId, noAsk);
    }
    const edgeNo = (1 - prob.pUpModel) - noAsk;
    const costPenaltyProb =
      (this.config.polymarket.paper.feeBps + this.config.polymarket.paper.slippageBps) / 10_000 +
      Math.max(0, implied.spread) / 2;
    const netYes = edgeYes - costPenaltyProb;
    const netNo = edgeNo - costPenaltyProb;
    const side =
      configured === "AUTO"
        ? Number.isFinite(netYes) && Number.isFinite(netNo)
          ? netYes >= netNo
            ? "YES"
            : "NO"
          : "YES"
        : configured;
    const accepted = this.executePaperTrade({
      marketId: market.marketId,
      marketSlug: market.eventSlug || market.slug,
      windowStartTs:
        market.startTs ??
        Math.max(0, market.endTs - this.config.polymarket.marketQuery.cadenceMinutes * 60_000),
      windowEndTs: market.endTs,
      priceToBeat: market.priceToBeat,
      side,
      yesBid: implied.yesBid,
      yesAsk: implied.yesAsk,
      noAsk,
      edge: decision.netEdgeAfterCosts,
      requestedNotionalUsd: this.config.polymarket.paper.forceNotional,
      ts: context.nowTs,
      forced: true
    });
    if (!accepted) return;

    this.lastForceTradeTs = context.nowTs;
    this.logger.info(
      {
        marketId: market.marketId,
        side,
        notionalUsd: this.config.polymarket.paper.forceNotional,
        intervalSec: this.config.polymarket.paper.forceIntervalSec
      },
      "PAPER FORCE TRADE CREATED"
    );
  }

  private applyWindowState(
    market: {
      marketId: string;
      slug: string;
      question: string;
      priceToBeat: number;
      endTs: number;
      startTs?: number;
      yesTokenId: string;
      noTokenId?: string;
      tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
      negRisk?: boolean;
      acceptingOrders: boolean;
      enableOrderBook?: boolean;
      closed?: boolean;
      eventSlug?: string;
      yesBidHint?: number;
      yesAskHint?: number;
      yesMidHint?: number;
      yesLastTradeHint?: number;
      outcomePricesHint?: number[];
    },
    nowTs: number,
    oracleEst?: number
  ): {
    marketId: string;
    slug: string;
    question: string;
    priceToBeat: number;
    endTs: number;
    startTs?: number;
    yesTokenId: string;
    noTokenId?: string;
    tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
    negRisk?: boolean;
    acceptingOrders: boolean;
    enableOrderBook?: boolean;
    closed?: boolean;
    eventSlug?: string;
    yesBidHint?: number;
    yesAskHint?: number;
    yesMidHint?: number;
    yesLastTradeHint?: number;
    outcomePricesHint?: number[];
  } {
    const key = String(market.eventSlug || market.slug || market.marketId).trim();
    if (!key) return market;

    const fallbackStart = this.roundDownToCadence(nowTs);
    const startMs = Number.isFinite(Number(market.startTs)) && Number(market.startTs) > 0
      ? Number(market.startTs)
      : fallbackStart;
    const endMs = Number(market.endTs);
    const previousState = this.windowStateBySlug.get(key);
    let state = previousState;
    if (!state || state.windowEndMs !== endMs || state.windowStartMs !== startMs) {
      state = {
        windowStartMs: startMs,
        windowEndMs: endMs,
        priceToBeat:
          previousState && previousState.windowEndMs >= nowTs - 60_000 && previousState.priceToBeat
            ? previousState.priceToBeat
            : undefined,
        priceToBeatTs: previousState?.priceToBeatTs
      };
      this.windowStateBySlug.set(key, state);
    }

    if (!(state.priceToBeat && state.priceToBeat > 0) && market.priceToBeat > 0) {
      state.priceToBeat = market.priceToBeat;
      state.priceToBeatTs = nowTs;
    }

    if (!(state.priceToBeat && state.priceToBeat > 0)) {
      if (nowTs < state.windowStartMs) {
        if (!state.waitingLogged) {
          this.logger.info(
            {
              slug: key,
              windowStartMs: state.windowStartMs,
              windowEndMs: state.windowEndMs,
              nowMs: nowTs
            },
            "waiting for windowStart"
          );
          state.waitingLogged = true;
        }
      } else if (oracleEst && oracleEst > 0) {
        state.priceToBeat = oracleEst;
        state.priceToBeatTs = nowTs;
        state.waitingLogged = false;
        this.logger.info(
          {
            slug: key,
            priceToBeat: state.priceToBeat,
            windowStartMs: state.windowStartMs,
            capturedTs: nowTs
          },
          "Captured priceToBeat"
        );
      }
    }

    return {
      ...market,
      startTs: state.windowStartMs,
      endTs: state.windowEndMs,
      priceToBeat: state.priceToBeat && state.priceToBeat > 0 ? state.priceToBeat : market.priceToBeat
    };
  }

  private pruneOldWindowState(nowTs: number): void {
    const minKeepEndTs = nowTs - 2 * 60 * 60 * 1000;
    for (const [key, state] of this.windowStateBySlug.entries()) {
      if (state.windowEndMs < minKeepEndTs) {
        this.windowStateBySlug.delete(key);
      }
    }
  }

  private roundDownToCadence(ts: number): number {
    const cadenceMs = Math.max(1, this.config.polymarket.marketQuery.cadenceMinutes) * 60_000;
    return Math.floor(ts / cadenceMs) * cadenceMs;
  }

  private async getImpliedYesBook(market: {
    marketId: string;
    yesTokenId: string;
    yesBidHint?: number;
    yesAskHint?: number;
    yesMidHint?: number;
    yesLastTradeHint?: number;
    outcomePricesHint?: number[];
  }): Promise<{
    yesBid: number;
    yesAsk: number;
    yesMid: number;
    spread: number;
    topBidSize: number;
    topAskSize: number;
    bookTs: number;
  }> {
    try {
      const orderBook = await this.client.getYesOrderBook(market.marketId, market.yesTokenId);
      if (orderBook.yesAsk >= orderBook.yesBid && orderBook.yesAsk > 0 && orderBook.yesBid >= 0) {
        return {
          yesBid: clamp(orderBook.yesBid, 0, 1),
          yesAsk: clamp(orderBook.yesAsk, Math.max(0, orderBook.yesBid), 1),
          yesMid: clamp(orderBook.yesMid, 0, 1),
          spread: Math.max(0, orderBook.yesAsk - orderBook.yesBid),
          topBidSize: Math.max(0, Number(orderBook.bids?.[0]?.size || 0)),
          topAskSize: Math.max(0, Number(orderBook.asks?.[0]?.size || 0)),
          bookTs: Number(orderBook.ts || Date.now())
        };
      }
    } catch (error) {
      this.setTradingPaused(true, "NETWORK_ERROR", Date.now());
      this.logger.warn(
        {
          marketId: market.marketId,
          tokenId: market.yesTokenId,
          error: error instanceof Error ? error.message : String(error)
        },
        "Failed to fetch YES orderbook; using fallback implied prices"
      );
    }

    const hintedMid =
      (Number.isFinite(Number(market.yesMidHint)) ? Number(market.yesMidHint) : 0) ||
      (Number.isFinite(Number(market.yesLastTradeHint)) ? Number(market.yesLastTradeHint) : 0) ||
      (Array.isArray(market.outcomePricesHint) && market.outcomePricesHint.length > 0
        ? Number(market.outcomePricesHint[0] || 0)
        : 0);
    const hintedBid = Number.isFinite(Number(market.yesBidHint)) ? Number(market.yesBidHint) : 0;
    const hintedAsk = Number.isFinite(Number(market.yesAskHint)) ? Number(market.yesAskHint) : 0;

    const fallbackMid = clamp(hintedMid > 0 ? hintedMid : 0.5, 0.01, 0.99);
    const yesBid = clamp(hintedBid > 0 ? hintedBid : fallbackMid - 0.01, 0, 1);
    const yesAsk = clamp(hintedAsk > 0 ? hintedAsk : fallbackMid + 0.01, yesBid, 1);
    return {
      yesBid,
      yesAsk,
      yesMid: (yesBid + yesAsk) / 2,
      spread: Math.max(0, yesAsk - yesBid),
      topBidSize: 0,
      topAskSize: 0,
      bookTs: Date.now()
    };
  }

  private async getNoBookFromTokenId(tokenId: string): Promise<{
    bestBid: number;
    bestAsk: number;
    topBidSize: number;
    topAskSize: number;
  } | null> {
    try {
      const noBook = await this.client.getTokenOrderBook(tokenId);
      return {
        bestBid: clamp(Number(noBook.bestBid || 0), 0.0001, 0.9999),
        bestAsk: clamp(Number(noBook.bestAsk || 0), 0.0001, 0.9999),
        topBidSize: Math.max(0, Number(noBook.bids?.[0]?.size || 0)),
        topAskSize: Math.max(0, Number(noBook.asks?.[0]?.size || 0))
      };
    } catch (error) {
      this.setTradingPaused(true, "NETWORK_ERROR", Date.now());
      this.logger.warn(
        {
          tokenId,
          error: error instanceof Error ? error.message : String(error)
        },
        "Failed to fetch NO orderbook; using inferred NO prices"
      );
    }
    return null;
  }

  private async getNoAskFromTokenId(tokenId: string, fallbackNoAsk: number): Promise<number> {
    const noBook = await this.getNoBookFromTokenId(tokenId);
    if (noBook?.bestAsk && noBook.bestAsk > 0) {
      return clamp(noBook.bestAsk, 0.0001, 0.9999);
    }
    return clamp(fallbackNoAsk, 0.0001, 0.9999);
  }

  private async getNoBidFromTokenId(tokenId: string, fallbackNoBid: number): Promise<number> {
    const noBook = await this.getNoBookFromTokenId(tokenId);
    if (noBook?.bestBid && noBook.bestBid > 0) {
      return clamp(noBook.bestBid, 0.0001, 0.9999);
    }
    return clamp(fallbackNoBid, 0.0001, 0.9999);
  }

  private async getNoAskAndDepthFromTokenId(
    tokenId: string,
    fallbackNoAsk: number
  ): Promise<{ noAsk: number; topAskSize: number }> {
    const noBook = await this.getNoBookFromTokenId(tokenId);
    if (!noBook) {
      return {
        noAsk: clamp(fallbackNoAsk, 0.0001, 0.9999),
        topAskSize: 0
      };
    }
    return {
      noAsk: clamp(noBook.bestAsk > 0 ? noBook.bestAsk : fallbackNoAsk, 0.0001, 0.9999),
      topAskSize: Math.max(0, noBook.topAskSize)
    };
  }

  private canMutateVenueState(): boolean {
    return !this.config.polymarket.killSwitch;
  }

  private maybeEmitTickLog(input: TickLogLine): void {
    if (Date.now() - this.lastTickLogTs < 30_000) {
      return;
    }
    const line: TickLogLine = {
      ...input,
      tradingPaused: input.tradingPaused ?? this.tradingPaused,
      pauseReason: input.pauseReason ?? (this.pauseReason || null),
      pauseSinceTs: input.pauseSinceTs ?? this.pauseSinceTs
    };
    this.lastTickLogTs = Date.now();
    this.logger.info(line, "Polymarket tick");
    appendFileSync(
      this.logPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        type: "tick",
        marketsSeen: line.marketsSeen,
        activeWindows: line.activeWindows,
        oracleEst: line.oracleEst,
        sigma: line.sigma,
        marketId: line.currentMarketId,
        slug: line.selectedSlug,
        tauSec: line.tauSec,
        priceToBeat: line.priceToBeat,
        yesBid: line.yesBid,
        yesAsk: line.yesAsk,
        yesMid: line.yesMid ?? null,
        pUp: line.pUpModel,
        pUpModel: line.pUpModel,
        pBase: line.pBase ?? null,
        pBoosted: line.pBoosted ?? null,
        z: line.z ?? null,
        d: line.d ?? null,
        sigmaCalibrated: line.sigmaCalibrated ?? null,
        polyUpdateAgeMs: line.polyUpdateAgeMs ?? null,
        lagPolyP90Ms: line.lagPolyP90Ms ?? null,
        boostApplied: line.boostApplied ?? false,
        boostReason: line.boostReason ?? null,
        edge: line.edge,
        edgeYes: line.edgeYes ?? null,
        edgeNo: line.edgeNo ?? null,
        chosenSide: line.chosenSide ?? null,
        chosenEdge: line.chosenEdge ?? null,
        conviction: line.conviction ?? null,
        stalenessEdge: line.stalenessEdge ?? null,
        netEdgeAfterCosts: line.netEdgeAfterCosts ?? null,
        threshold: line.threshold,
        size: line.size ?? null,
        openTrades: line.openTrades ?? 0,
        resolvedTrades: line.resolvedTrades ?? 0,
        oracleSource: line.oracleSource ?? "none",
        oracleTs: line.oracleTs ?? null,
        oracleStaleMs: line.oracleStaleMs ?? null,
        oracleState: line.oracleState ?? "IDLE",
        tradingPaused: line.tradingPaused ?? false,
        pauseReason: line.pauseReason ?? null,
        pauseSinceTs: line.pauseSinceTs ?? null,
        lastAction: line.action,
        selectedSlug: line.selectedSlug,
        windowStart: line.windowStart,
        windowEnd: line.windowEnd,
        acceptingOrders: line.acceptingOrders,
        enableOrderBook: line.enableOrderBook
      })}\n`,
      "utf8"
    );
  }

  private ensureOutputFilesAndWriteStartupMarkers(): void {
    mkdirSync(this.logsDirPath, { recursive: true });
    mkdirSync(this.dataDirPath, { recursive: true });
    mkdirSync(path.dirname(this.paperLedgerPath), { recursive: true });
    const nowIso = new Date().toISOString();
    appendFileSync(
      this.logPath,
      `${JSON.stringify({
        ts: nowIso,
        type: "startup",
        mode: this.config.polymarket.mode
      })}\n`,
      "utf8"
    );
    appendFileSync(
      this.paperTradeLogPath,
      `${JSON.stringify({
        ts: nowIso,
        type: "startup",
        mode: this.config.polymarket.mode
      })}\n`,
      "utf8"
    );
    if (this.config.polymarket.mode === "paper") {
      this.paperLedger.appendStartup();
    }
  }

  private handlePaperFatal(reason: string, error?: unknown): void {
    if (this.config.polymarket.mode !== "paper" || this.paperFatalLogged) {
      return;
    }
    this.paperFatalLogged = true;
    this.running = false;
    const message =
      error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message ?? reason)
        : reason;
    console.error(`[Polymarket paper fatal] ${reason}: ${message}`);
    appendFileSync(
      this.logPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        type: "error",
        error: `${reason}: ${message}`
      })}\n`,
      "utf8"
    );
  }
  private recordOracleSample(px: number, ts: number, source: string): void {
    if (!(px > 0)) return;
    this.oracleSamples.push({ px, ts, source });
    const minTs = ts - 2 * 60 * 60 * 1000;
    while (this.oracleSamples.length > 0 && this.oracleSamples[0].ts < minTs) {
      this.oracleSamples.shift();
    }
  }

  private pickOracleAtOrAfter(targetTs: number): { px: number; ts: number; source: string } | null {
    for (let i = 0; i < this.oracleSamples.length; i += 1) {
      const row = this.oracleSamples[i];
      if (row.ts >= targetTs) {
        return row;
      }
    }
    return null;
  }

  private pickOracleAtOrBefore(targetTs: number): { px: number; ts: number; source: string } | null {
    for (let i = this.oracleSamples.length - 1; i >= 0; i -= 1) {
      const row = this.oracleSamples[i];
      if (row.ts <= targetTs) {
        return row;
      }
    }
    return null;
  }

  private setTradingPaused(paused: boolean, reason: string, nowTs: number): void {
    const normalizedReason = String(reason || "").trim();
    if (paused) {
      if (!this.tradingPaused || this.pauseReason !== normalizedReason) {
        this.tradingPaused = true;
        this.pauseReason = normalizedReason || "PAUSED";
        this.pauseSinceTs = nowTs;
        this.logger.warn(
          {
            tradingPaused: true,
            pauseReason: this.pauseReason,
            pauseSinceTs: this.pauseSinceTs
          },
          "Polymarket trading paused"
        );
      }
      return;
    }

    if (this.tradingPaused) {
      this.tradingPaused = false;
      const previousReason = this.pauseReason || "PAUSED";
      const pausedForMs = this.pauseSinceTs ? Math.max(0, nowTs - this.pauseSinceTs) : null;
      this.pauseReason = "";
      this.pauseSinceTs = null;
      this.logger.info(
        {
          tradingPaused: false,
          previousReason,
          pausedForMs
        },
        "Polymarket trading resumed"
      );
    }
  }

  private computeShortReturn(nowTs: number, lookbackSec: number): number {
    if (this.oracleSamples.length < 2) return 0;
    const nowSample = this.pickOracleAtOrBefore(nowTs);
    const pastSample = this.pickOracleAtOrBefore(nowTs - Math.max(1, lookbackSec) * 1000);
    if (!nowSample || !pastSample || !(nowSample.px > 0) || !(pastSample.px > 0)) {
      return 0;
    }
    const ret = nowSample.px / pastSample.px - 1;
    return Number.isFinite(ret) ? clamp(ret, -0.05, 0.05) : 0;
  }

  private computeRealizedVolPricePerSqrtSec(
    nowTs: number,
    oracleNow: number,
    fallbackSigmaPricePerSqrtSec: number,
    lookbackSec: number
  ): number {
    const minTs = nowTs - Math.max(1, lookbackSec) * 1000;
    const window = this.oracleSamples.filter((row) => row.ts >= minTs && row.ts <= nowTs);
    if (window.length < 3) {
      return Math.max(1e-9, fallbackSigmaPricePerSqrtSec);
    }

    const scaledReturns: number[] = [];
    for (let i = 1; i < window.length; i += 1) {
      const prev = window[i - 1];
      const curr = window[i];
      const dtSec = Math.max(1e-3, (curr.ts - prev.ts) / 1000);
      if (!(prev.px > 0) || !(curr.px > 0)) continue;
      const logRet = Math.log(curr.px / prev.px);
      scaledReturns.push(logRet / Math.sqrt(dtSec));
    }
    if (scaledReturns.length < 2) {
      return Math.max(1e-9, fallbackSigmaPricePerSqrtSec);
    }

    const mean =
      scaledReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, scaledReturns.length);
    const variance =
      scaledReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      Math.max(1, scaledReturns.length - 1);
    const sigmaPerSqrtSec = Math.sqrt(Math.max(0, variance));
    const sigmaPrice = sigmaPerSqrtSec * Math.max(1, oracleNow);
    return Math.max(1e-9, Number.isFinite(sigmaPrice) ? sigmaPrice : fallbackSigmaPricePerSqrtSec);
  }

  private computeStalenessEdge(
    marketId: string,
    impliedMid: number,
    oracleEst: number,
    nowTs: number
  ): number {
    const key = String(marketId || "").trim();
    if (!key || !(impliedMid > 0) || !(oracleEst > 0)) {
      return 0;
    }
    const previous = this.marketLagState.get(key);
    this.marketLagState.set(key, {
      impliedMid,
      oracleEst,
      ts: nowTs
    });
    if (!previous) return 0;

    const impliedDelta = Math.abs(impliedMid - previous.impliedMid);
    const oracleDeltaBps = Math.abs((oracleEst - previous.oracleEst) / Math.max(1, previous.oracleEst)) * 10_000;
    const ageMs = Math.max(1, nowTs - previous.ts);

    const impliedIsSticky = impliedDelta <= 0.0025;
    const fastMidMoved = oracleDeltaBps >= 4;
    const freshComparison = ageMs <= 20_000;
    if (!impliedIsSticky || !fastMidMoved || !freshComparison) {
      return 0;
    }

    // Convert lag into a bounded additive conviction term.
    return clamp((oracleDeltaBps - 4) / 60, 0, 0.2);
  }

  private writeDecisionLog(line: DecisionLogLine): void {
    appendFileSync(this.logPath, `${JSON.stringify(line)}\n`, "utf8");
  }

  private writePaperTradeLog(line: Record<string, unknown>): void {
    appendFileSync(this.paperTradeLogPath, `${JSON.stringify(line)}\n`, "utf8");
  }
}

type TickLogLine = {
  marketsSeen: number;
  activeWindows: number;
  now: string;
  currentMarketId: string | null;
  tauSec: number | null;
  priceToBeat: number | null;
  oracleEst: number | null;
  sigma: number | null;
  yesBid: number | null;
  yesAsk: number | null;
  yesMid?: number | null;
  pUpModel: number | null;
  pBase?: number | null;
  pBoosted?: number | null;
  z?: number | null;
  d?: number | null;
  sigmaCalibrated?: number | null;
  polyUpdateAgeMs?: number | null;
  lagPolyP90Ms?: number | null;
  boostApplied?: boolean;
  boostReason?: string | null;
  edge: number | null;
  edgeYes?: number | null;
  edgeNo?: number | null;
  chosenSide?: "YES" | "NO" | null;
  chosenEdge?: number | null;
  conviction?: number | null;
  stalenessEdge?: number | null;
  netEdgeAfterCosts?: number | null;
  threshold: number | null;
  action: string;
  size?: number | null;
  openTrades?: number;
  resolvedTrades?: number;
  oracleSource?: string;
  oracleTs?: number | null;
  oracleStaleMs?: number | null;
  oracleState?: string;
  tradingPaused?: boolean;
  pauseReason?: string | null;
  pauseSinceTs?: number | null;
  selectedSlug: string | null;
  windowStart: number | null;
  windowEnd: number | null;
  acceptingOrders: boolean | null;
  enableOrderBook: boolean | null;
};

function isTransientPolymarketError(error: unknown): boolean {
  const message = String(
    error && typeof error === "object" && "message" in error
      ? (error as { message?: unknown }).message
      : error
  )
    .toLowerCase()
    .trim();

  return (
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("socket") ||
    message.includes("fetch failed") ||
    message.includes("circuit open") ||
    message.includes("aborted") ||
    message.includes("network")
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

class ExistingSpotFeedAdapter implements SpotFeed {
  private readonly fetcher: CrossVenueFetcher;

  constructor(config: BotConfig) {
    this.fetcher = new CrossVenueFetcher(config);
  }

  async fetch(symbol: string, nowTs = Date.now()): Promise<SpotVenueTick[]> {
    const rows = await this.fetcher.fetch(symbol, nowTs);
    return rows.map((row) => ({
      venue: row.venue,
      ts: row.ts,
      bid: row.bid,
      ask: row.ask,
      mid: row.mid,
      last: row.mid,
      spreadBps: row.spread_bps,
      ok: row.ok,
      error: row.error
    }));
  }
}
