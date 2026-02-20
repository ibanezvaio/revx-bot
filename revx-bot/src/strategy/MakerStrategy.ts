import { BotConfig } from "../config";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Execution } from "../exec/Execution";
import { Logger } from "../logger";
import { MarketData } from "../md/MarketData";
import { Reconciler } from "../recon/Reconciler";
import { RevXClient } from "../revx/RevXClient";
import { RiskManager } from "../risk/RiskManager";
import { SignalEngine } from "../signals/SignalEngine";
import { OrderRecord, Side, Store } from "../store/Store";
import { sleep } from "../util/time";

type DesiredQuote = {
  tag: string;
  side: Side;
  level: number | string;
  price: number;
  quoteSizeUsd: number;
};

type MidPoint = { ts: number; mid: number };

type TrendEffect = {
  applied: boolean;
  direction: "UP" | "DOWN" | "NONE";
  mode: "spread" | "reduce_level";
};

type AdaptiveControllerResult = {
  afterHalfSpreadBps: number;
  deltaBps: number;
  adjustments: string[];
};

type SideEdgeAdjustments = {
  bidBps: number;
  askBps: number;
};

export class MakerStrategy {
  private running = false;
  private readonly mids: MidPoint[] = [];
  private pausedUntilMs = 0;
  private pauseReason = "";
  private refreshCursor = 0;
  private lastMetricsLogMs = 0;
  private lastTightSpreadCancelMs = 0;
  private lastPauseSwitchCancelMs = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly client: RevXClient,
    private readonly store: Store,
    private readonly marketData: MarketData,
    private readonly execution: Execution,
    private readonly reconciler: Reconciler,
    private readonly risk: RiskManager,
    private readonly signalEngine: SignalEngine
  ) {}

  stop(): void {
    this.running = false;
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.runSingleCycle();
        this.risk.recordSuccess();
      } catch (error) {
        if (error instanceof FatalStrategyError) throw error;
        const state = this.risk.recordError(error);
        if (state.shouldStop) {
          this.logger.error(
            { maxConsecutiveErrors: this.config.maxConsecutiveErrors },
            "Max consecutive errors reached; cancel all and stop"
          );
          await this.execution.cancelAllBotOrders(this.config.symbol);
          throw error;
        }
      }
      await sleep(this.config.refreshSeconds * 1000);
    }
  }

  async runSingleCycle(): Promise<void> {
    if (this.risk.checkKillSwitch()) {
      this.logger.warn(
        { path: this.config.killSwitchFile },
        "Kill-switch file detected; cancelling all and stopping"
      );
      await this.execution.cancelAllBotOrders(this.config.symbol);
      throw new FatalStrategyError("Kill-switch triggered");
    }

    if (existsSync(this.config.pauseSwitchFile)) {
      if (Date.now() - this.lastPauseSwitchCancelMs > 10_000) {
        await this.execution.cancelAllBotOrders(this.config.symbol);
        this.lastPauseSwitchCancelMs = Date.now();
      }
      this.store.upsertBotStatus({
        ts: Date.now(),
        mid: this.store.getRecentTickerSnapshots(this.config.symbol, 1)[0]?.mid ?? 0,
        exposure_usd: 0,
        allow_buy: false,
        allow_sell: false,
        buy_reasons: [`Paused by PAUSE_SWITCH_FILE (${this.config.pauseSwitchFile})`],
        sell_reasons: [`Paused by PAUSE_SWITCH_FILE (${this.config.pauseSwitchFile})`]
      });
      return;
    }

    if (Date.now() < this.pausedUntilMs) {
      this.logger.warn(
        { until: new Date(this.pausedUntilMs).toISOString(), reason: this.pauseReason },
        "Strategy paused"
      );
      return;
    }

    const latest = this.reconciler.getLatestState();
    if (!latest || Date.now() - latest.ts > this.config.reconcileSeconds * 1500) {
      await this.reconciler.reconcileOnce();
    }

    const ticker = await this.marketData.getTicker(this.config.symbol);
    const tickerAgeMs = Date.now() - ticker.ts;
    if (tickerAgeMs > 5_000) {
      this.logger.warn(
        { symbol: this.config.symbol, tickerTs: ticker.ts, tickerAgeMs },
        "Stale ticker; skipping cycle"
      );
      return;
    }

    this.store.recordMidSnapshot({
      symbol: ticker.symbol,
      bid: ticker.bid,
      ask: ticker.ask,
      mid: ticker.mid,
      last: ticker.last,
      ts: ticker.ts
    });

    this.recordMid(ticker.mid, ticker.ts);
    const signalState = this.signalEngine.update(ticker.mid, ticker.ts);

    const marketSpreadBps = calcSpreadBps(ticker.bid, ticker.ask, ticker.mid);
    const volMoveBps = Math.abs(this.computeSignedMoveBps(this.config.volWindowSeconds));

    const lowInsideSpread = marketSpreadBps < this.config.minInsideSpreadBps;
    const lowMovement = volMoveBps < this.config.minVolMoveBpsToQuote;
    if (lowInsideSpread && lowMovement) {
      if (Date.now() - this.lastTightSpreadCancelMs > 10_000) {
        await this.execution.cancelAllBotOrders(this.config.symbol);
        this.lastTightSpreadCancelMs = Date.now();
      }
      this.store.upsertBotStatus({
        ts: ticker.ts,
        mid: ticker.mid,
        exposure_usd: 0,
        market_spread_bps: marketSpreadBps,
        vol_move_bps: volMoveBps,
        spread_mult: this.config.volSpreadMultMin,
        allow_buy: false,
        allow_sell: false,
        buy_reasons: [
          `Blocked: inside spread ${marketSpreadBps.toFixed(2)} bps < ${this.config.minInsideSpreadBps.toFixed(2)} and vol move ${volMoveBps.toFixed(2)} bps < ${this.config.minVolMoveBpsToQuote.toFixed(2)}`
        ],
        sell_reasons: [
          `Blocked: inside spread ${marketSpreadBps.toFixed(2)} bps < ${this.config.minInsideSpreadBps.toFixed(2)} and vol move ${volMoveBps.toFixed(2)} bps < ${this.config.minVolMoveBpsToQuote.toFixed(2)}`
        ]
      });
      return;
    }
    if (volMoveBps >= this.config.volPauseBps) {
      await this.execution.cancelAllBotOrders(this.config.symbol);
      this.pauseFor(
        this.config.pauseSecondsOnVol * 1000,
        `volatility ${volMoveBps.toFixed(2)} bps >= ${this.config.volPauseBps}`
      );
      return;
    }

    const spreadMult = clamp(
      1 + volMoveBps / this.config.volPauseBps,
      this.config.volSpreadMultMin,
      this.config.volSpreadMultMax
    );

    const nowMs = Date.now();
    const rolling = this.store.getRollingMetrics(nowMs);
    const edgeLookback = computeEdgeStatsSince(
      this.store,
      nowMs - this.config.edgeLookbackMinutes * 60 * 1000
    );
    const fillsInTargetWindow = this.store.getFillsSince(
      nowMs - this.config.targetFillsWindowMinutes * 60 * 1000
    ).length;
    const fillsInDroughtWindow = this.store.getFillsSince(
      nowMs - this.config.fillDroughtMinutes * 60 * 1000
    ).length;

    const effectiveHalfSpreadBeforeAdaptive = this.config.baseHalfSpreadBps * spreadMult;
    const adaptive = applyAdaptiveSpreadController(
      effectiveHalfSpreadBeforeAdaptive,
      {
        fills_last_30m: fillsInDroughtWindow,
        fills_last_1h: fillsInTargetWindow,
        avg_edge_total_last_1h: edgeLookback.avgTotal,
        cancels_last_1h: rolling.cancels_last_1h
      },
      this.config
    );
    let effectiveHalfSpread = adaptive.afterHalfSpreadBps;
    const adaptiveSpreadDeltaBps = adaptive.deltaBps;
    const adaptiveAdjustments = adaptive.adjustments;

    let signalEffectEnabled = false;
    let signalSkewBps = 0;
    let signalSpreadAction = "none";

    const state = this.reconciler.getLatestState();
    const balances = state?.balances ?? {
      usd_free: 0,
      usd_total: 0,
      btc_free: 0,
      btc_total: 0,
      snapshot_ts: ticker.ts
    };

    const equityUsd = balances.usd_total + balances.btc_total * ticker.mid;
    const targetBtcNotionalUsd = this.config.dynamicTargetBtc
      ? Math.max(0, equityUsd * 0.5)
      : this.config.targetBtcNotionalUsd;
    const maxBtcNotionalUsd = this.config.dynamicTargetBtc
      ? targetBtcNotionalUsd + this.config.dynamicTargetBufferUsd
      : this.config.maxBtcNotionalUsd;
    const lowBtcGate =
      targetBtcNotionalUsd - (maxBtcNotionalUsd - targetBtcNotionalUsd) / 2;

    const btcNotional = balances.btc_total * ticker.mid;
    const inventoryError = btcNotional - targetBtcNotionalUsd;
    const invDenom = Math.max(1, maxBtcNotionalUsd - targetBtcNotionalUsd);
    const inventoryRatio = clamp(inventoryError / invDenom, -1, 1);
    const inventorySkewBps = inventoryRatio * this.config.skewMaxBps;
    let skewBps = inventorySkewBps;

    let bidHalfSpreadBps = effectiveHalfSpread + Math.max(0, skewBps);
    let askHalfSpreadBps = effectiveHalfSpread - Math.min(0, skewBps);

    const pnl = this.risk.evaluateDailyLoss(
      ticker.mid,
      [
        { asset: "USD", free: balances.usd_free, total: balances.usd_total, ts: balances.snapshot_ts },
        { asset: "BTC", free: balances.btc_free, total: balances.btc_total, ts: balances.snapshot_ts }
      ],
      "BTC",
      "USD"
    );
    if (pnl.tripped) {
      await this.execution.cancelAllBotOrders(this.config.symbol);
      throw new FatalStrategyError("Daily loss limit reached");
    }

    const activeBotOrders = this.store.getActiveBotOrders(this.config.symbol);
    const buyOpenUsd = activeBotOrders
      .filter((o) => o.side === "BUY")
      .reduce((sum, o) => sum + o.quote_size, 0);

    const buyReasons: string[] = [];
    const sellReasons: string[] = [];

    if (adaptiveAdjustments.length > 0) {
      const msg = `Adaptive spread delta=${adaptiveSpreadDeltaBps.toFixed(2)} bps reasons=${adaptiveAdjustments.join(",")} (fills30m=${rolling.fills_last_30m}, fills1h=${rolling.fills_last_1h})`;
      buyReasons.push(msg);
      sellReasons.push(msg);
    }

    let buyLevels = this.config.levels;
    let sellLevels = this.config.levels;
    const initialSellLevels = sellLevels;

    const trendMoveBps = this.computeSignedMoveBps(this.config.trendWindowSeconds);
    const trendEffect: TrendEffect = {
      applied: false,
      direction: trendMoveBps > 0 ? "UP" : trendMoveBps < 0 ? "DOWN" : "NONE",
      mode: this.config.trendProtectionMode
    };

    if (Math.abs(trendMoveBps) >= this.config.trendPauseBps) {
      trendEffect.applied = true;
      if (trendMoveBps > 0) {
        if (this.config.trendProtectionMode === "reduce_level") {
          sellLevels = Math.max(0, sellLevels - 1);
          sellReasons.push(
            `Trend guard UP ${trendMoveBps.toFixed(2)} bps: reduced sell levels by 1`
          );
        } else {
          askHalfSpreadBps += this.config.trendSkewBps;
          sellReasons.push(
            `Trend guard UP ${trendMoveBps.toFixed(2)} bps: widened ask by ${this.config.trendSkewBps.toFixed(2)} bps`
          );
        }
      } else if (trendMoveBps < 0) {
        if (this.config.trendProtectionMode === "reduce_level") {
          buyLevels = Math.max(0, buyLevels - 1);
          buyReasons.push(
            `Trend guard DOWN ${trendMoveBps.toFixed(2)} bps: reduced buy levels by 1`
          );
        } else {
          bidHalfSpreadBps += this.config.trendSkewBps;
          buyReasons.push(
            `Trend guard DOWN ${trendMoveBps.toFixed(2)} bps: widened bid by ${this.config.trendSkewBps.toFixed(2)} bps`
          );
        }
      }
    }

    signalEffectEnabled = this.config.signalEnabled && signalState.confidence > 0;
    if (signalEffectEnabled) {
      const preSignalHalfSpread = effectiveHalfSpread;
      signalSkewBps = clamp(
        signalState.zScore * this.config.signalZscoreToSkew +
          signalState.driftBps * this.config.signalDriftToSkew,
        -this.config.signalMaxSkewBps,
        this.config.signalMaxSkewBps
      );
      skewBps += signalSkewBps;

      if (signalState.volRegime === "calm") {
        effectiveHalfSpread *= this.config.signalCalmTighten;
        signalSpreadAction = `calm_tighten_x${this.config.signalCalmTighten.toFixed(2)}`;
      } else if (signalState.volRegime === "hot") {
        effectiveHalfSpread *= this.config.signalHotWiden;
        signalSpreadAction = `hot_widen_x${this.config.signalHotWiden.toFixed(2)}`;
        const hotLevelCap = Math.max(0, this.config.signalLevelsInHot);
        buyLevels = Math.min(buyLevels, hotLevelCap);
        sellLevels = Math.min(sellLevels, hotLevelCap);
      }

      effectiveHalfSpread = clamp(
        effectiveHalfSpread,
        this.config.minHalfSpreadBps,
        this.config.maxHalfSpreadBps
      );
      const halfSpreadDelta = effectiveHalfSpread - preSignalHalfSpread;
      bidHalfSpreadBps += halfSpreadDelta + Math.max(0, signalSkewBps);
      askHalfSpreadBps += halfSpreadDelta - Math.min(0, signalSkewBps);

      const msg = `Signals ${signalSpreadAction}: regime=${signalState.volRegime} z=${signalState.zScore.toFixed(2)} drift=${signalState.driftBps.toFixed(2)} skew=${signalSkewBps.toFixed(2)} bps conf=${signalState.confidence.toFixed(2)}`;
      buyReasons.push(msg);
      sellReasons.push(msg);
    } else {
      signalSpreadAction = "disabled_or_low_confidence";
    }

    const sideEdgeAdjust = computeSideEdgeAdjustments(
      edgeLookback.avgBuy,
      edgeLookback.avgSell,
      this.config
    );
    bidHalfSpreadBps += sideEdgeAdjust.bidBps;
    askHalfSpreadBps += sideEdgeAdjust.askBps;

    buyReasons.push(
      `Edge-weight BUY adjust=${sideEdgeAdjust.bidBps.toFixed(2)} bps from avg_edge_buy=${edgeLookback.avgBuy.toFixed(2)}`
    );
    sellReasons.push(
      `Edge-weight SELL adjust=${sideEdgeAdjust.askBps.toFixed(2)} bps from avg_edge_sell=${edgeLookback.avgSell.toFixed(2)}`
    );

    if (btcNotional > maxBtcNotionalUsd) {
      buyLevels = 0;
      buyReasons.push(
        `BTC notional ${fmtUsd(btcNotional)} > max ${fmtUsd(maxBtcNotionalUsd)}`
      );
    }

    const quoteSizing = computeSideQuoteSizes(
      this.config.levelQuoteSizeUsd,
      this.config.minQuoteSizeUsd,
      inventoryRatio
    );
    let sellQuoteSizeUsd = quoteSizing.sellQuoteSizeUsd;
    let maxSellByBal = Math.max(
      0,
      Math.floor((balances.btc_free * ticker.mid) / Math.max(sellQuoteSizeUsd, 0.0000001))
    );
    let sellThrottleState = "NORMAL";

    if (maxSellByBal === 0 && balances.btc_total > 0 && sellQuoteSizeUsd > this.config.minQuoteSizeUsd) {
      sellQuoteSizeUsd = this.config.minQuoteSizeUsd;
      maxSellByBal = Math.max(
        0,
        Math.floor((balances.btc_free * ticker.mid) / Math.max(sellQuoteSizeUsd, 0.0000001))
      );
      sellReasons.push(
        `Reduced SELL quote size to minimum ${fmtUsd(sellQuoteSizeUsd)} to keep sell quoting possible. ${formatSellDiagnostics({
          btcTotal: balances.btc_total,
          btcFree: balances.btc_free,
          btcNotional,
          targetBtcNotionalUsd,
          lowBtcGate,
          maxSellByBal
        })}`
      );
    }

    if (btcNotional < this.config.sellDisableBelowNotionalUsd) {
      const before = sellLevels;
      sellLevels = 0;
      sellThrottleState = "DISABLED_MIN_NOTIONAL";
      if (before !== sellLevels) {
        sellReasons.push(
          `BTC notional below minimal sell threshold (${fmtUsd(btcNotional)} < ${fmtUsd(
            this.config.sellDisableBelowNotionalUsd
          )}). ${formatSellDiagnostics({
            btcTotal: balances.btc_total,
            btcFree: balances.btc_free,
            btcNotional,
            targetBtcNotionalUsd,
            lowBtcGate,
            maxSellByBal
          })}`
        );
      }
    } else if (this.config.sellThrottleBelowLowGate && btcNotional < lowBtcGate) {
      const before = sellLevels;
      sellLevels = Math.min(sellLevels, this.config.minSellLevelsBelowLowGate);
      sellThrottleState = "THROTTLED_LOW_GATE";
      sellReasons.push(
        `BTC notional below low gate; throttling sells to ${sellLevels}. ${formatSellDiagnostics({
          btcTotal: balances.btc_total,
          btcFree: balances.btc_free,
          btcNotional,
          targetBtcNotionalUsd,
          lowBtcGate,
          maxSellByBal
        })}`
      );
      if (before !== sellLevels) {
        sellReasons.push(`Sell levels adjusted ${before} -> ${sellLevels} by low-gate throttle.`);
      }
    }

    const maxBuyByCash = Math.max(
      0,
      Math.floor((balances.usd_free - this.config.cashReserveUsd) / quoteSizing.buyQuoteSizeUsd)
    );
    if (maxBuyByCash < buyLevels) {
      const spendableUsd = balances.usd_free - this.config.cashReserveUsd;
      const requiredPerLevel = this.config.levelQuoteSizeUsd;
      const suggestion =
        spendableUsd < requiredPerLevel
          ? " Reduce CASH_RESERVE_USD or LEVEL_QUOTE_SIZE_USD to enable buys."
          : "";
      buyReasons.push(
        `USD free ${fmtUsd(balances.usd_free)} only supports ${maxBuyByCash} buy levels after reserve (spendableUsd=${fmtUsd(
          spendableUsd
        )}, requiredPerLevel=${fmtUsd(requiredPerLevel)}).${suggestion}`
      );
      buyLevels = maxBuyByCash;
    }

    const maxBuyByCap = Math.max(
      0,
      Math.floor((this.config.workingCapUsd - buyOpenUsd) / quoteSizing.buyQuoteSizeUsd)
    );
    if (maxBuyByCap < buyLevels) {
      buyReasons.push(
        `Working cap ${fmtUsd(this.config.workingCapUsd)} limits buy levels to ${maxBuyByCap}`
      );
      buyLevels = maxBuyByCap;
    }

    if (maxSellByBal < sellLevels) {
      sellReasons.push(
        `BTC free ${balances.btc_free.toFixed(8)} supports ${maxSellByBal} sell levels. ${formatSellDiagnostics({
          btcTotal: balances.btc_total,
          btcFree: balances.btc_free,
          btcNotional,
          targetBtcNotionalUsd,
          lowBtcGate,
          maxSellByBal
        })}`
      );
      sellLevels = maxSellByBal;
    }

    const totalLevels = buyLevels + sellLevels;
    if (totalLevels > this.config.maxActiveOrders) {
      let trim = totalLevels - this.config.maxActiveOrders;
      while (trim > 0 && (buyLevels > 0 || sellLevels > 0)) {
        if (sellLevels >= buyLevels && sellLevels > 0) {
          sellLevels -= 1;
          sellReasons.push(
            `Trimmed by MAX_ACTIVE_ORDERS. ${formatSellDiagnostics({
              btcTotal: balances.btc_total,
              btcFree: balances.btc_free,
              btcNotional,
              targetBtcNotionalUsd,
              lowBtcGate,
              maxSellByBal
            })}`
          );
        } else if (buyLevels > 0) {
          buyLevels -= 1;
          buyReasons.push("Trimmed by MAX_ACTIVE_ORDERS");
        }
        trim -= 1;
      }
    }

    if (sellLevels < initialSellLevels) {
      sellReasons.push(
        `Sell levels reduced ${initialSellLevels} -> ${sellLevels}. ${formatSellDiagnostics({
          btcTotal: balances.btc_total,
          btcFree: balances.btc_free,
          btcNotional,
          targetBtcNotionalUsd,
          lowBtcGate,
          maxSellByBal
        })}`
      );
    }

    const rejectSpikeThreshold = Math.max(3, this.config.targetFillsPerHour);
    const rejectsSpiking = rolling.post_only_rejects_last_1h >= rejectSpikeThreshold;
    const churnWarning = rolling.cancels_last_1h > this.config.maxCancelsPerHour;
    const tobRegime: "calm" | "normal" | "hot" =
      volMoveBps <= this.config.calmVolBps
        ? "calm"
        : volMoveBps <= this.config.tobMaxVolBps
          ? "normal"
          : "hot";
    const absInventoryRatio = Math.abs(inventoryRatio);
    const tobQuoteSizeActive =
      tobRegime === "calm" ? this.config.tobQuoteSizeUsd : this.config.tobQuoteSizeUsdNormal;

    if (
      absInventoryRatio > this.config.tobMaxInventoryRatioForOneSided &&
      inventoryRatio < -this.config.tobMaxInventoryRatioForBoth
    ) {
      const before = sellLevels;
      sellLevels = Math.min(sellLevels, 0);
      if (before !== sellLevels) {
        sellReasons.push(
          `Inventory extreme (BTC-light, ratio=${inventoryRatio.toFixed(
            3
          )}); reduced SELL levels ${before} -> ${sellLevels}`
        );
      }
    } else if (
      absInventoryRatio > this.config.tobMaxInventoryRatioForOneSided &&
      inventoryRatio > this.config.tobMaxInventoryRatioForBoth
    ) {
      const before = buyLevels;
      buyLevels = Math.min(buyLevels, 0);
      if (before !== buyLevels) {
        buyReasons.push(
          `Inventory extreme (BTC-heavy, ratio=${inventoryRatio.toFixed(
            3
          )}); reduced BUY levels ${before} -> ${buyLevels}`
        );
      }
    }

    const tickSize = ticker.tickSize > 0 ? ticker.tickSize : 0.01;
    const desired = buildDesiredQuotes({
      symbol: this.config.symbol,
      execution: this.execution,
      mid: ticker.mid,
      bestBid: ticker.bid,
      bestAsk: ticker.ask,
      tickSize,
      buyLevels,
      sellLevels,
      bidHalfSpreadBps,
      askHalfSpreadBps,
      levelStepBps: this.config.levelStepBps,
      buyQuoteSizeUsd: quoteSizing.buyQuoteSizeUsd,
      sellQuoteSizeUsd
    });

    let tobMode: "OFF" | "BOTH" | "BUY-ONLY" | "SELL-ONLY" = "OFF";
    let tobReason = "Disabled in config";
    let allowTobBuy = false;
    let allowTobSell = false;

    if (this.config.enableTopOfBook) {
      if (tobRegime === "hot") {
        tobMode = "OFF";
        tobReason = `Hot volatility regime (${volMoveBps.toFixed(2)} bps > ${this.config.tobMaxVolBps.toFixed(2)})`;
      } else if (rolling.cancels_last_1h >= this.config.maxCancelsPerHour) {
        tobMode = "OFF";
        tobReason = `High churn (${rolling.cancels_last_1h} cancels/1h >= ${this.config.maxCancelsPerHour})`;
      } else if (rejectsSpiking) {
        tobMode = "OFF";
        tobReason = `Post-only rejects spiking (${rolling.post_only_rejects_last_1h}/1h)`;
      } else if (absInventoryRatio <= this.config.tobMaxInventoryRatioForBoth) {
        tobMode = "BOTH";
        tobReason = `Inventory balanced (|ratio|=${absInventoryRatio.toFixed(3)} <= ${this.config.tobMaxInventoryRatioForBoth.toFixed(2)})`;
        allowTobBuy = true;
        allowTobSell = true;
      } else if (inventoryRatio < -this.config.tobMaxInventoryRatioForBoth) {
        tobMode = "BUY-ONLY";
        tobReason = `BTC-light inventory (ratio=${inventoryRatio.toFixed(3)}): TOB BUY-only for rebalance`;
        allowTobBuy = true;
      } else {
        tobMode = "SELL-ONLY";
        tobReason = `BTC-heavy inventory (ratio=${inventoryRatio.toFixed(3)}): TOB SELL-only for rebalance`;
        allowTobSell = true;
      }
    }

    const topOfBookEnabled = tobMode !== "OFF";
    const topOfBookDiagnostics: string[] = [];
    topOfBookDiagnostics.push(`TOB mode ${tobMode}: ${tobReason}`);
    let topOfBookBuyAdded = false;
    let topOfBookSellAdded = false;

    if (topOfBookEnabled) {
      const tobUsd = roundUsd(tobQuoteSizeActive);
      const tobCapacity = this.config.maxActiveOrders - desired.length;

      if (allowTobBuy && buyLevels > 0 && tobCapacity > 0) {
        if (balances.usd_free - this.config.cashReserveUsd >= tobUsd) {
          desired.push({
            tag: this.execution.makeTag(this.config.symbol, "BUY", "L0-TOB"),
            side: "BUY",
            level: "L0-TOB",
            price: enforcePostOnlyPrice(
              roundToTick(ticker.bid, tickSize, "BUY"),
              "BUY",
              ticker.bid,
              ticker.ask,
              tickSize
            ),
            quoteSizeUsd: tobUsd
          });
          topOfBookBuyAdded = true;
        } else {
          topOfBookDiagnostics.push(
            `TOB BUY skipped: usd_free ${fmtUsd(balances.usd_free)} below reserve + size`
          );
        }
      } else if (!allowTobBuy) {
        topOfBookDiagnostics.push("TOB BUY disabled by inventory rebalance policy");
      }

      if (allowTobSell && sellLevels > 0 && this.config.maxActiveOrders - desired.length > 0) {
        if (balances.btc_free * ticker.mid >= tobUsd) {
          desired.push({
            tag: this.execution.makeTag(this.config.symbol, "SELL", "L0-TOB"),
            side: "SELL",
            level: "L0-TOB",
            price: enforcePostOnlyPrice(
              roundToTick(ticker.ask, tickSize, "SELL"),
              "SELL",
              ticker.bid,
              ticker.ask,
              tickSize
            ),
            quoteSizeUsd: tobUsd
          });
          topOfBookSellAdded = true;
        } else {
          topOfBookDiagnostics.push(
            `TOB SELL skipped: btc_free ${balances.btc_free.toFixed(8)} insufficient for ${fmtUsd(tobUsd)}`
          );
        }
      } else if (!allowTobSell) {
        topOfBookDiagnostics.push("TOB SELL disabled by inventory rebalance policy");
      }
    } else if (this.config.enableTopOfBook) {
      topOfBookDiagnostics.push(
        `TOB disabled by guards (regime=${tobRegime}, vol=${volMoveBps.toFixed(2)}, calm<=${this.config.calmVolBps.toFixed(2)}, hot>${this.config.tobMaxVolBps.toFixed(2)}, inventoryRatio=${inventoryRatio.toFixed(3)}, cancels1h=${rolling.cancels_last_1h}, rejects1h=${rolling.post_only_rejects_last_1h})`
      );
    }

    if (topOfBookBuyAdded) {
      buyReasons.push("TOB BUY active at best bid");
    }
    if (topOfBookSellAdded) {
      sellReasons.push("TOB SELL active at best ask");
    }
    for (const detail of topOfBookDiagnostics) {
      buyReasons.push(detail);
      sellReasons.push(detail);
    }

    const finalBuyEnabled = desired.some((q) => q.side === "BUY");
    const finalSellEnabled = desired.some((q) => q.side === "SELL");

    const decisionTargets = desired.map((q) => ({
      tag: q.tag,
      side: q.side,
      level: q.level,
      price: q.price,
      quote_size_usd: q.quoteSizeUsd
    }));

    const botStatusBase = {
      ts: ticker.ts,
      mid: ticker.mid,
      exposure_usd: btcNotional,
      market_spread_bps: marketSpreadBps,
      vol_move_bps: volMoveBps,
      trend_move_bps: trendMoveBps,
      spread_mult: spreadMult,
      inventory_ratio: inventoryRatio,
      skew_bps_applied: skewBps,
      fills_30m: rolling.fills_last_30m,
      fills_1h: rolling.fills_last_1h,
      avg_edge_buy_1h: edgeLookback.avgBuy,
      avg_edge_sell_1h: edgeLookback.avgSell,
      cancels_1h: rolling.cancels_last_1h,
      rejects_1h: rolling.post_only_rejects_last_1h,
      adaptive_spread_bps_delta: adaptiveSpreadDeltaBps,
      churn_warning: churnWarning,
      adaptive_reasons: adaptiveAdjustments,
      tob_mode: tobMode,
      tob_reason: tobReason,
      sell_throttle_state: sellThrottleState,
      allow_buy: finalBuyEnabled,
      allow_sell: finalSellEnabled,
      buy_reasons: buyReasons,
      sell_reasons: sellReasons
    };
    this.store.upsertBotStatus(botStatusBase);

    this.store.recordStrategyDecision({
      ts: ticker.ts,
      mid: ticker.mid,
      spread_mult: spreadMult,
      inventory_ratio: inventoryRatio,
      details_json: JSON.stringify({
        market_spread_bps: marketSpreadBps,
        vol_move_bps: volMoveBps,
        trend_move_bps: trendMoveBps,
        trend_applied: trendEffect.applied,
        trend_mode: trendEffect.mode,
        trend_direction: trendEffect.direction,
        effective_half_spread_bps_before_adaptive: effectiveHalfSpreadBeforeAdaptive,
        effective_half_spread_bps_after_adaptive: effectiveHalfSpread,
        adaptive_spread_bps_delta: adaptiveSpreadDeltaBps,
        adaptive_adjustments_applied: adaptiveAdjustments,
        signal_state: {
          ts: signalState.ts,
          ema: signalState.ema,
          vol_regime: signalState.volRegime,
          drift_bps: signalState.driftBps,
          z_score: signalState.zScore,
          confidence: signalState.confidence,
          stdev_bps: signalState.stdevBps
        },
        signal_skew_bps_applied: signalSkewBps,
        signal_spread_action: signalSpreadAction,
        fills_last_1h: rolling.fills_last_1h,
        fills_last_30m: rolling.fills_last_30m,
        edge_lookback_minutes: this.config.edgeLookbackMinutes,
        edge_lookback_avg_buy_bps: edgeLookback.avgBuy,
        edge_lookback_avg_sell_bps: edgeLookback.avgSell,
        edge_lookback_avg_total_bps: edgeLookback.avgTotal,
        rolling_metrics: rolling,
        inventory_skew_bps: inventorySkewBps,
        total_skew_bps: skewBps,
        side_edge_adjust_bid_bps: sideEdgeAdjust.bidBps,
        side_edge_adjust_ask_bps: sideEdgeAdjust.askBps,
        bid_half_spread_bps: bidHalfSpreadBps,
        ask_half_spread_bps: askHalfSpreadBps,
        equity_usd: equityUsd,
        dynamic_target_btc: this.config.dynamicTargetBtc,
        target_btc_notional_usd: targetBtcNotionalUsd,
        max_btc_notional_usd: maxBtcNotionalUsd,
        low_btc_gate: lowBtcGate,
        btc_total: balances.btc_total,
        btc_free: balances.btc_free,
        btc_notional_usd: btcNotional,
        max_sell_by_bal: maxSellByBal,
        buy_quote_size_usd: quoteSizing.buyQuoteSizeUsd,
        sell_quote_size_usd: sellQuoteSizeUsd,
        target_prices: decisionTargets,
        buy_levels: buyLevels,
        sell_levels: sellLevels,
        sell_throttle_state: sellThrottleState,
        top_of_book_enabled: topOfBookEnabled,
        top_of_book_mode: tobMode,
        top_of_book_reason: tobReason,
        top_of_book_regime: tobRegime,
        top_of_book_quote_size_usd: tobQuoteSizeActive,
        top_of_book_buy_added: topOfBookBuyAdded,
        top_of_book_sell_added: topOfBookSellAdded,
        top_of_book_diagnostics: topOfBookDiagnostics
      })
    });

    const actionsUsed = await this.reconcileDesiredOrders(
      ticker.mid,
      ticker.bid,
      ticker.ask,
      tickSize,
      desired,
      activeBotOrders,
      this.config.maxActionsPerLoop
    );
    this.store.upsertBotStatus({
      ...botStatusBase,
      action_budget_used: actionsUsed,
      action_budget_max: this.config.maxActionsPerLoop
    });

    const now = Date.now();
    if (now - this.lastMetricsLogMs >= this.config.metricsLogEverySeconds * 1000) {
      this.lastMetricsLogMs = now;
      this.logger.info(
        {
          mid: ticker.mid,
          marketSpreadBps: Number(marketSpreadBps.toFixed(2)),
          volMoveBps: Number(volMoveBps.toFixed(2)),
          trendMoveBps: Number(trendMoveBps.toFixed(2)),
          spreadMult: Number(spreadMult.toFixed(3)),
          adaptiveSpreadDeltaBps: Number(adaptiveSpreadDeltaBps.toFixed(2)),
          adaptiveAdjustments,
          effectiveHalfSpreadBps: Number(effectiveHalfSpread.toFixed(2)),
          signalVolRegime: signalState.volRegime,
          signalEma: Number(signalState.ema.toFixed(2)),
          signalZScore: Number(signalState.zScore.toFixed(3)),
          signalDriftBps: Number(signalState.driftBps.toFixed(2)),
          signalSkewBpsApplied: Number(signalSkewBps.toFixed(2)),
          signalStdevBps: Number(signalState.stdevBps.toFixed(3)),
          signalConfidence: Number(signalState.confidence.toFixed(2)),
          fillsLast30m: rolling.fills_last_30m,
          fillsLast1h: rolling.fills_last_1h,
          avgEdgeBuy: Number(edgeLookback.avgBuy.toFixed(2)),
          avgEdgeSell: Number(edgeLookback.avgSell.toFixed(2)),
          cancels1h: rolling.cancels_last_1h,
          postOnlyRejects1h: rolling.post_only_rejects_last_1h,
          inventoryRatio: Number(inventoryRatio.toFixed(3)),
          skewBps: Number(skewBps.toFixed(2)),
          btcNotional: Number(btcNotional.toFixed(2)),
          targetBtcNotionalUsd: Number(targetBtcNotionalUsd.toFixed(2)),
          lowBtcGate: Number(lowBtcGate.toFixed(2)),
          buyLevels,
          sellLevels,
          topOfBookBuyAdded,
          topOfBookSellAdded,
          tobMode,
          tobReason,
          sellThrottleState,
          rejectsSpiking,
          churnWarning,
          actionsUsed,
          actionBudgetMax: this.config.maxActionsPerLoop,
          buyQuoteSizeUsd: Number(quoteSizing.buyQuoteSizeUsd.toFixed(2)),
          sellQuoteSizeUsd: Number(sellQuoteSizeUsd.toFixed(2)),
          maxSellByBal
        },
        "Maker v2 snapshot"
      );
    }
  }

  private async reconcileDesiredOrders(
    mid: number,
    bestBid: number,
    bestAsk: number,
    tickSize: number,
    desired: DesiredQuote[],
    activeBotOrders: OrderRecord[],
    budget: number
  ): Promise<number> {
    let actions = 0;
    const desiredMap = new Map(desired.map((q) => [q.tag, q]));
    const activeByTag = new Map<string, OrderRecord[]>();

    for (const order of activeBotOrders) {
      if (!order.bot_tag) continue;
      const bucket = activeByTag.get(order.bot_tag) ?? [];
      bucket.push(order);
      activeByTag.set(order.bot_tag, bucket);
    }

    const primaryByTag = new Map<string, OrderRecord>();
    const extraOrders: OrderRecord[] = [];
    for (const [tag, bucket] of activeByTag.entries()) {
      bucket.sort((a, b) => b.updated_at - a.updated_at);
      primaryByTag.set(tag, bucket[0]);
      for (const extra of bucket.slice(1)) {
        extraOrders.push(extra);
      }
    }

    for (const order of extraOrders) {
      if (actions >= budget) return actions;
      if (!order.venue_order_id) continue;
      await this.execution.cancelOrder(order.venue_order_id);
      actions += 1;
    }

    for (const [tag, order] of primaryByTag.entries()) {
      if (actions >= budget) return actions;
      if (desiredMap.has(tag)) continue;
      if (!order.venue_order_id) continue;
      await this.execution.cancelOrder(order.venue_order_id);
      actions += 1;
    }

    const replaceList: Array<{ existing: OrderRecord; target: DesiredQuote }> = [];
    const placeList: DesiredQuote[] = [];

    for (const target of desired) {
      const existing = primaryByTag.get(target.tag);
      if (!existing) {
        placeList.push(target);
        continue;
      }

      const violatesPostOnly = violatesPostOnlyConstraint(
        existing.side,
        existing.price,
        bestBid,
        bestAsk,
        tickSize
      );

      if (violatesPostOnly) {
        replaceList.push({ existing, target });
        continue;
      }

      const moveBps = calcMoveBps(existing.price, target.price, mid);
      if (moveBps < this.config.repriceMoveBps) continue;

      const ageSec = (Date.now() - existing.created_at) / 1000;
      if (ageSec < this.config.minOrderAgeSeconds) {
        continue;
      }

      replaceList.push({ existing, target });
    }

    for (const item of replaceList) {
      if (actions + 2 > budget) break;
      if (!item.existing.venue_order_id) continue;
      await this.execution.cancelOrder(item.existing.venue_order_id);
      actions += 1;
      await this.execution.placeTaggedMakerOrder({
        symbol: this.config.symbol,
        side: item.target.side,
        price: item.target.price,
        quoteSizeUsd: item.target.quoteSizeUsd,
        botTag: item.target.tag,
        retryOnPostOnlyReject: true
      });
      actions += 1;
      this.recordReplacementEvent(item.existing, item.target, "REPRICE_REPLACE");
    }

    const refreshCandidate = this.pickQueueRefreshCandidate(desired, primaryByTag);
    if (refreshCandidate && actions + 2 <= budget) {
      const { target, existing } = refreshCandidate;
      if (existing.venue_order_id) {
        await this.execution.cancelOrder(existing.venue_order_id);
        actions += 1;
        await this.execution.placeTaggedMakerOrder({
          symbol: this.config.symbol,
          side: target.side,
          price: target.price,
          quoteSizeUsd: target.quoteSizeUsd,
          botTag: target.tag,
          retryOnPostOnlyReject: true
        });
        actions += 1;
        this.recordReplacementEvent(existing, target, "QUEUE_REFRESH");
      }
    }

    for (const target of placeList) {
      if (actions >= budget) break;
      await this.execution.placeTaggedMakerOrder({
        symbol: this.config.symbol,
        side: target.side,
        price: target.price,
        quoteSizeUsd: target.quoteSizeUsd,
        botTag: target.tag,
        retryOnPostOnlyReject: true
      });
      actions += 1;
    }
    return actions;
  }

  private recordReplacementEvent(
    existing: OrderRecord,
    target: DesiredQuote,
    reason: string
  ): void {
    this.store.recordBotEvent({
      event_id: randomUUID(),
      ts: Date.now(),
      type: "REPLACED",
      side: target.side,
      price: target.price,
      quote_size_usd: target.quoteSizeUsd,
      venue_order_id: existing.venue_order_id,
      client_order_id: existing.client_order_id,
      reason,
      bot_tag: target.tag
    });
  }

  private pickQueueRefreshCandidate(
    desired: DesiredQuote[],
    activeByTag: Map<string, OrderRecord>
  ): { target: DesiredQuote; existing: OrderRecord } | null {
    if (desired.length === 0) return null;
    const ordered = [...desired].sort((a, b) => a.tag.localeCompare(b.tag));
    this.refreshCursor = this.refreshCursor % ordered.length;

    for (let i = 0; i < ordered.length; i += 1) {
      const idx = (this.refreshCursor + i) % ordered.length;
      const target = ordered[idx];
      const existing = activeByTag.get(target.tag);
      if (!existing) continue;

      const ageSec = (Date.now() - existing.created_at) / 1000;
      if (ageSec < this.config.queueRefreshSeconds) continue;
      if (ageSec < this.config.minOrderAgeSeconds) continue;

      this.refreshCursor = idx + 1;
      return { target, existing };
    }

    this.refreshCursor += 1;
    return null;
  }

  private recordMid(mid: number, ts: number): void {
    this.mids.push({ ts, mid });
    const maxWindowSec = Math.max(this.config.volWindowSeconds, this.config.trendWindowSeconds);
    const cutoff = ts - maxWindowSec * 1000;
    while (this.mids.length > 0 && this.mids[0].ts < cutoff) {
      this.mids.shift();
    }
  }

  private computeSignedMoveBps(windowSeconds: number): number {
    if (this.mids.length < 2) return 0;
    const latest = this.mids[this.mids.length - 1];
    const cutoff = latest.ts - windowSeconds * 1000;

    let anchor = this.mids[0];
    for (const point of this.mids) {
      anchor = point;
      if (point.ts >= cutoff) break;
    }

    if (!anchor || anchor.mid <= 0 || latest.mid <= 0) return 0;
    return ((latest.mid - anchor.mid) / anchor.mid) * 10_000;
  }

  private pauseFor(durationMs: number, reason: string): void {
    this.pausedUntilMs = Date.now() + durationMs;
    this.pauseReason = reason;
    this.logger.warn({ pausedUntilMs: this.pausedUntilMs, reason }, "Maker strategy paused");
  }
}

class FatalStrategyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalStrategyError";
  }
}

function buildDesiredQuotes(params: {
  symbol: string;
  execution: Execution;
  mid: number;
  bestBid: number;
  bestAsk: number;
  tickSize: number;
  buyLevels: number;
  sellLevels: number;
  bidHalfSpreadBps: number;
  askHalfSpreadBps: number;
  levelStepBps: number;
  buyQuoteSizeUsd: number;
  sellQuoteSizeUsd: number;
}): DesiredQuote[] {
  const quotes: DesiredQuote[] = [];

  for (let i = 0; i < params.buyLevels; i += 1) {
    const bps = params.bidHalfSpreadBps + i * params.levelStepBps;
    const raw = params.mid * (1 - bps / 10_000);
    const rounded = roundToTick(raw, params.tickSize, "BUY");
    const safe = enforcePostOnlyPrice(rounded, "BUY", params.bestBid, params.bestAsk, params.tickSize);

    quotes.push({
      tag: params.execution.makeTag(params.symbol, "BUY", i),
      side: "BUY",
      level: i,
      price: safe,
      quoteSizeUsd: roundUsd(params.buyQuoteSizeUsd)
    });
  }

  for (let i = 0; i < params.sellLevels; i += 1) {
    const bps = params.askHalfSpreadBps + i * params.levelStepBps;
    const raw = params.mid * (1 + bps / 10_000);
    const rounded = roundToTick(raw, params.tickSize, "SELL");
    const safe = enforcePostOnlyPrice(rounded, "SELL", params.bestBid, params.bestAsk, params.tickSize);

    quotes.push({
      tag: params.execution.makeTag(params.symbol, "SELL", i),
      side: "SELL",
      level: i,
      price: safe,
      quoteSizeUsd: roundUsd(params.sellQuoteSizeUsd)
    });
  }

  return quotes;
}

function computeSideQuoteSizes(
  baseQuoteSizeUsd: number,
  minQuoteSizeUsd: number,
  inventoryRatio: number
): { buyQuoteSizeUsd: number; sellQuoteSizeUsd: number } {
  const base = Math.max(baseQuoteSizeUsd, minQuoteSizeUsd);
  const min = Math.max(1, Math.min(minQuoteSizeUsd, base));

  let buy = base;
  let sell = base;

  if (inventoryRatio > 0) {
    buy = base - inventoryRatio * (base - min);
  } else if (inventoryRatio < 0) {
    sell = base - Math.abs(inventoryRatio) * (base - min);
  }

  return {
    buyQuoteSizeUsd: clamp(buy, min, base),
    sellQuoteSizeUsd: clamp(sell, min, base)
  };
}

function roundToTick(price: number, tickSize: number, side: Side): number {
  const tick = tickSize > 0 ? tickSize : 0.01;
  const rawTicks = price / tick;
  const ticks = side === "BUY" ? Math.floor(rawTicks + 1e-12) : Math.ceil(rawTicks - 1e-12);
  const rounded = ticks * tick;
  const decimals = countDecimals(tick);
  return Number(rounded.toFixed(decimals));
}

function enforcePostOnlyPrice(
  price: number,
  side: Side,
  bestBid: number,
  bestAsk: number,
  tickSize: number
): number {
  const tick = tickSize > 0 ? tickSize : 0.01;

  if (side === "BUY") {
    const maxFromAsk = bestAsk > 0 ? bestAsk - tick : Number.POSITIVE_INFINITY;
    const maxPrice = Number.isFinite(maxFromAsk) ? Math.min(bestBid, maxFromAsk) : bestBid;
    const fallback = Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : Math.max(tick, price);
    const safe = price >= maxFromAsk ? fallback : price;
    return Math.max(tick, roundToTick(safe, tick, "BUY"));
  }

  const minFromBid = bestBid > 0 ? bestBid + tick : 0;
  const minPrice = Math.max(bestAsk, minFromBid);
  const fallback = minPrice > 0 ? minPrice : Math.max(tick, price);
  const safe = price <= minFromBid ? fallback : price;
  return Math.max(tick, roundToTick(safe, tick, "SELL"));
}

function violatesPostOnlyConstraint(
  side: Side,
  price: number,
  bestBid: number,
  bestAsk: number,
  tickSize: number
): boolean {
  const tick = tickSize > 0 ? tickSize : 0.01;
  if (side === "BUY") {
    if (bestAsk <= 0) return false;
    return price >= bestAsk - tick;
  }
  if (bestBid <= 0) return false;
  return price <= bestBid + tick;
}

function calcSpreadBps(bid: number, ask: number, mid: number): number {
  if (bid <= 0 || ask <= 0 || mid <= 0) return 0;
  return ((ask - bid) / mid) * 10_000;
}

function calcMoveBps(currentPrice: number, targetPrice: number, mid: number): number {
  if (currentPrice <= 0 || targetPrice <= 0 || mid <= 0) return Number.POSITIVE_INFINITY;
  return (Math.abs(currentPrice - targetPrice) / mid) * 10_000;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function countDecimals(value: number): number {
  const str = value.toString();
  const idx = str.indexOf(".");
  if (idx < 0) return 0;
  return str.length - idx - 1;
}

export function applyAdaptiveSpreadController(
  currentHalfSpreadBps: number,
  metrics: {
    fills_last_30m: number;
    fills_last_1h: number;
    avg_edge_total_last_1h: number;
    cancels_last_1h: number;
  },
  config: Pick<
    BotConfig,
    | "adaptiveSpread"
    | "adaptiveStepBps"
    | "targetFillsPerHour"
    | "edgeBadBps"
    | "edgeGoodBps"
    | "maxCancelsPerHour"
    | "minHalfSpreadBps"
    | "maxHalfSpreadBps"
  >
): AdaptiveControllerResult {
  let next = currentHalfSpreadBps;
  const adjustments: string[] = [];

  if (config.adaptiveSpread) {
    if (metrics.fills_last_30m === 0) {
      next -= config.adaptiveStepBps;
      adjustments.push("FILL_DROUGHT_TIGHTEN");
    } else if (
      config.targetFillsPerHour > 0 &&
      metrics.fills_last_1h >= config.targetFillsPerHour
    ) {
      next += config.adaptiveStepBps;
      adjustments.push("OVER_TARGET_WIDEN");
    }

    if (metrics.avg_edge_total_last_1h < config.edgeBadBps) {
      next += config.adaptiveStepBps * 2;
      adjustments.push("NEG_EDGE_WIDEN");
    } else if (metrics.avg_edge_total_last_1h > config.edgeGoodBps) {
      next -= config.adaptiveStepBps;
      adjustments.push("GOOD_EDGE_TIGHTEN");
    }

    if (metrics.cancels_last_1h > config.maxCancelsPerHour) {
      next += config.adaptiveStepBps * 2;
      adjustments.push("HIGH_CHURN_WIDEN");
    }
  }

  const clamped = clamp(next, config.minHalfSpreadBps, config.maxHalfSpreadBps);
  return {
    afterHalfSpreadBps: clamped,
    deltaBps: clamped - currentHalfSpreadBps,
    adjustments
  };
}

export function computeSideEdgeAdjustments(
  avgBuyEdgeBps: number,
  avgSellEdgeBps: number,
  config: Pick<BotConfig, "edgeGoodBps" | "edgeBadBps" | "edgeAdjustBps" | "edgeMaxSideAdjustBps">
): SideEdgeAdjustments {
  let bidBps = 0;
  let askBps = 0;

  if (avgBuyEdgeBps > config.edgeGoodBps) {
    bidBps -= config.edgeAdjustBps;
  } else if (avgBuyEdgeBps < config.edgeBadBps) {
    bidBps += config.edgeAdjustBps;
  }

  if (avgSellEdgeBps > config.edgeGoodBps) {
    askBps -= config.edgeAdjustBps;
  } else if (avgSellEdgeBps < config.edgeBadBps) {
    askBps += config.edgeAdjustBps;
  }

  return {
    bidBps: clamp(bidBps, -config.edgeMaxSideAdjustBps, config.edgeMaxSideAdjustBps),
    askBps: clamp(askBps, -config.edgeMaxSideAdjustBps, config.edgeMaxSideAdjustBps)
  };
}

function computeEdgeStatsSince(store: Store, sinceTs: number): { avgBuy: number; avgSell: number; avgTotal: number } {
  const fills = store.getFillsSince(sinceTs);
  let buySum = 0;
  let buyCount = 0;
  let sellSum = 0;
  let sellCount = 0;

  for (const fill of fills) {
    if (!Number.isFinite(fill.edge_bps ?? Number.NaN)) continue;
    const side = store.getOrderByVenueId(fill.venue_order_id)?.side;
    if (side === "BUY") {
      buySum += fill.edge_bps as number;
      buyCount += 1;
    } else if (side === "SELL") {
      sellSum += fill.edge_bps as number;
      sellCount += 1;
    }
  }

  const avgBuy = buyCount > 0 ? buySum / buyCount : 0;
  const avgSell = sellCount > 0 ? sellSum / sellCount : 0;
  const avgTotal = buyCount + sellCount > 0 ? (buySum + sellSum) / (buyCount + sellCount) : 0;
  return { avgBuy, avgSell, avgTotal };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function formatSellDiagnostics(params: {
  btcTotal: number;
  btcFree: number;
  btcNotional: number;
  targetBtcNotionalUsd: number;
  lowBtcGate: number;
  maxSellByBal: number;
}): string {
  return `btc_total=${params.btcTotal.toFixed(8)} btc_free=${params.btcFree.toFixed(8)} btcNotional=${fmtUsd(
    params.btcNotional
  )} targetBtcNotionalUsd=${fmtUsd(params.targetBtcNotionalUsd)} lowBtcGate=${fmtUsd(
    params.lowBtcGate
  )} maxSellByBal=${params.maxSellByBal}`;
}
