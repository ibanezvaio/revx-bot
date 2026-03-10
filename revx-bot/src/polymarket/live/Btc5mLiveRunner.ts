import { BotConfig } from "../../config";
import { Logger } from "../../logger";
import { Store } from "../../store/Store";
import { sleep } from "../../util/time";
import { deriveBtc5mTickContext, slugForTs } from "../btc5m";
import { PolymarketClient } from "../PolymarketClient";
import { PolymarketExecution } from "../Execution";
import { PolymarketRisk } from "../Risk";
import { Sizing } from "../Sizing";
import { Btc5mExecutionGate } from "./Btc5mExecutionGate";
import { Btc5mSelector } from "./Btc5mSelector";
import { Btc5mDecision, Btc5mSelectedMarket, Btc5mTick } from "./Btc5mTypes";

type RunnerDeps = {
  store?: Store;
};

export class Btc5mLiveRunner {
  private readonly client: PolymarketClient;
  private readonly execution: PolymarketExecution;
  private readonly risk: PolymarketRisk;
  private readonly sizing: Sizing;
  private readonly selector: Btc5mSelector;
  private readonly gate: Btc5mExecutionGate;
  private readonly store?: Store;

  private running = false;
  private stopRequested = false;
  private loopTask: Promise<void> | null = null;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    deps: RunnerDeps = {}
  ) {
    this.store = deps.store;
    this.client = new PolymarketClient(config, logger);
    this.execution = new PolymarketExecution(config, logger, this.client);
    this.risk = new PolymarketRisk(config, logger);
    this.sizing = new Sizing(config);
    this.selector = new Btc5mSelector(config, logger, this.client);
    this.gate = new Btc5mExecutionGate(config);
  }

  async start(): Promise<void> {
    if (this.running) {
      return this.loopTask ?? Promise.resolve();
    }
    this.running = true;
    this.stopRequested = false;

    if (this.config.polymarket.execution.cancelAllOnStart && this.canMutateVenueState()) {
      await this.execution.cancelAll("POLY_V2_STARTUP");
    }

    this.loopTask = this.runLoop();
    await this.loopTask;
  }

  async stop(reason = "STOPPED"): Promise<void> {
    this.stopRequested = true;
    if (this.loopTask) {
      await this.loopTask.catch(() => undefined);
    }
    if (this.canMutateVenueState()) {
      await this.execution.cancelAll(`POLY_V2_${reason}`);
    }
    this.running = false;
  }

  private async runLoop(): Promise<void> {
    const loopMs = 2_000;
    while (!this.stopRequested) {
      const tick = deriveBtc5mTickContext(Date.now());
      const tickInvariant = this.validateTickInvariant(tick);
      this.logger.info(
        {
          tickNowSec: tick.tickNowSec,
          currentSlug: tick.currentSlug,
          nextSlug: tick.nextSlug,
          prevSlug: tick.prevSlug,
          remainingSec: tick.remainingSec
        },
        "POLY_V2_TICK"
      );

      if (!tickInvariant.ok) {
        this.logInvariantBroken(tick, tickInvariant.reason, {});
        this.logger.info(
          {
            action: "HOLD",
            blocker: tickInvariant.reason
          },
          "POLY_V2_DECISION"
        );
        await sleep(loopMs);
        continue;
      }

      const reference = this.getReferencePrice(tick.tickNowMs);
      const selectionResult = await this.selector.select({
        tick,
        referencePrice: reference.price
      });
      const selected = selectionResult.selected;
      this.logger.info(
        {
          selectedSlug: selected?.slug ?? null,
          selectedTokenId: selected?.selectedTokenId ?? null,
          side: selected?.chosenSide ?? null,
          orderbookOk: selected?.orderbookOk ?? false,
          reason: selectionResult.reason
        },
        "POLY_V2_SELECTION"
      );

      if (!selected) {
        this.logger.info(
          {
            edge: null,
            threshold: this.config.polymarket.live.minEdgeThreshold,
            spread: null,
            blocker: selectionResult.reason || "NO_DIRECT_MARKET",
            action: "HOLD"
          },
          "POLY_V2_DECISION"
        );
        await sleep(loopMs);
        continue;
      }

      const selectedInvariant = this.validateSelectionInvariant(tick, selected);
      if (!selectedInvariant.ok) {
        this.logInvariantBroken(tick, selectedInvariant.reason, {
          selectedSlug: selected.slug,
          selectedTokenId: selected.selectedTokenId,
          side: selected.chosenSide
        });
        this.logger.info(
          {
            edge: null,
            threshold: this.config.polymarket.live.minEdgeThreshold,
            spread: selected.chosenSide === "YES" ? selected.yesBook.spread : selected.noBook.spread,
            blocker: selectedInvariant.reason,
            action: "HOLD"
          },
          "POLY_V2_DECISION"
        );
        await sleep(loopMs);
        continue;
      }

      const decision = this.gate.evaluate({
        tick,
        selected,
        referencePrice: reference.price
      });

      const executionResult = await this.maybeExecuteDecision({
        tick,
        selected,
        decision,
        referenceAgeMs: reference.ageMs
      });

      this.logger.info(
        {
          edge: decision.edge,
          threshold: decision.threshold,
          spread: decision.spread,
          blocker: executionResult.blocker,
          action: executionResult.action
        },
        "POLY_V2_DECISION"
      );

      await sleep(loopMs);
    }
  }

  private async maybeExecuteDecision(input: {
    tick: Btc5mTick;
    selected: Btc5mSelectedMarket;
    decision: Btc5mDecision;
    referenceAgeMs: number | null;
  }): Promise<{ action: "BUY_YES" | "BUY_NO" | "HOLD"; blocker: string | null }> {
    if (!this.canMutateVenueState()) {
      return { action: "HOLD", blocker: "LIVE_EXECUTION_DISABLED" };
    }
    if (input.decision.action === "HOLD") {
      return { action: "HOLD", blocker: input.decision.blocker || "HOLD" };
    }
    if (!input.decision.chosenSide || !input.decision.sideAsk || !input.selected.selectedTokenId) {
      return { action: "HOLD", blocker: "SIDE_NOT_BOOKABLE" };
    }

    const tauSec = Math.max(0, input.tick.remainingSec);
    const oracleAgeMs =
      input.referenceAgeMs !== null
        ? input.referenceAgeMs
        : Math.max(this.config.polymarket.risk.staleMs + 1, 60_000);
    const exposure = this.execution.getTotalExposureUsd();
    const remainingExposureBudget = Math.max(0, this.config.polymarket.risk.maxExposure - exposure);
    const remainingWindowBudget = Math.max(0, this.config.polymarket.sizing.maxNotionalPerWindow);

    const computed = this.sizing.compute({
      edge: Math.max(0, input.decision.edge),
      pUpModel:
        input.decision.chosenSide === "YES"
          ? input.decision.pUpModel ?? 0.5
          : 1 - (input.decision.pUpModel ?? 0.5),
      yesAsk: input.decision.sideAsk,
      conviction: Math.min(0.8, Math.max(0.1, Math.abs(input.decision.edge) * 200)),
      remainingSec: tauSec,
      entryMaxRemainingSec: this.config.polymarket.paper.entryMaxRemainingSec,
      depthCapNotionalUsd: remainingWindowBudget,
      remainingWindowBudget,
      remainingExposureBudget,
      remainingDailyLossBudget: this.risk.getRemainingDailyLossBudget()
    });

    let notionalUsd = Math.max(0, computed.notionalUsd);
    const minVenueShares = this.getMinVenueShares();
    if (input.decision.sideAsk > 0 && notionalUsd > 0) {
      const shares = notionalUsd / input.decision.sideAsk;
      if (shares < minVenueShares) {
        notionalUsd = minVenueShares * input.decision.sideAsk;
      }
    }
    if (!(notionalUsd > 0)) {
      return { action: "HOLD", blocker: "SIZE_BELOW_MIN_NOTIONAL" };
    }

    const riskCheck = this.risk.checkNewOrder({
      tauSec,
      oracleAgeMs,
      projectedOrderNotionalUsd: notionalUsd,
      openOrders: this.execution.getOpenOrderCount(),
      totalExposureUsd: exposure,
      concurrentWindows: this.execution.getConcurrentWindows()
    });
    if (!riskCheck.ok) {
      return { action: "HOLD", blocker: riskCheck.reason || "RISK_BLOCKED" };
    }

    const result =
      input.decision.chosenSide === "YES"
        ? await this.execution.executeBuyYes({
            marketId: input.selected.marketId,
            tokenId: input.selected.selectedTokenId,
            yesAsk: input.decision.sideAsk,
            notionalUsd,
            tickSize: input.selected.tickSize,
            negRisk: input.selected.negRisk
          })
        : await this.execution.executeBuyNo({
            marketId: input.selected.marketId,
            tokenId: input.selected.selectedTokenId,
            noAsk: input.decision.sideAsk,
            notionalUsd,
            tickSize: input.selected.tickSize,
            negRisk: input.selected.negRisk
          });
    if (!result.accepted) {
      return { action: "HOLD", blocker: result.reason || "LIVE_REJECTED" };
    }
    return {
      action: input.decision.chosenSide === "YES" ? "BUY_YES" : "BUY_NO",
      blocker: null
    };
  }

  private validateTickInvariant(tick: Btc5mTick): { ok: true } | { ok: false; reason: string } {
    const expectedSlug = slugForTs(tick.currentBucketStartSec);
    if (tick.currentSlug !== expectedSlug) {
      return { ok: false, reason: "CURRENT_BUCKET_SLUG_MISMATCH" };
    }
    return { ok: true };
  }

  private validateSelectionInvariant(
    tick: Btc5mTick,
    selected: Btc5mSelectedMarket
  ): { ok: true } | { ok: false; reason: string } {
    if (selected.slug !== tick.currentSlug && selected.slug !== tick.nextSlug) {
      return { ok: false, reason: "SELECTED_SLUG_NOT_CURRENT_OR_NEXT" };
    }
    if (!selected.selectedTokenId || !selected.orderbookOk) {
      return { ok: false, reason: "SELECTED_TOKEN_NOT_EXECUTABLE" };
    }
    return { ok: true };
  }

  private logInvariantBroken(tick: Btc5mTick, reason: string, extra: Record<string, unknown>): void {
    this.logger.error(
      {
        reason,
        tickNowSec: tick.tickNowSec,
        currentBucketStartSec: tick.currentBucketStartSec,
        currentSlug: tick.currentSlug,
        nextSlug: tick.nextSlug,
        prevSlug: tick.prevSlug,
        remainingSec: tick.remainingSec,
        ...extra
      },
      "POLY_V2_INVARIANT_BROKEN"
    );
  }

  private getReferencePrice(nowMs: number): { price: number | null; ageMs: number | null } {
    if (!this.store) {
      return { price: null, ageMs: null };
    }
    const quotes = this.store
      .getLatestVenueQuotes(this.config.symbol)
      .filter((row) => Number.isFinite(row.mid) && row.mid !== null && Number(row.mid) > 0);
    if (quotes.length === 0) {
      return { price: null, ageMs: null };
    }
    const latestTs = Math.max(...quotes.map((row) => Number(row.ts || 0)));
    const mids = quotes
      .filter((row) => Number(row.ts || 0) >= latestTs - 5_000)
      .map((row) => Number(row.mid))
      .filter((row) => Number.isFinite(row) && row > 0)
      .sort((a, b) => a - b);
    const mid = mids.length > 0 ? mids[Math.floor(mids.length / 2)] : null;
    return {
      price: mid,
      ageMs: latestTs > 0 ? Math.max(0, nowMs - latestTs) : null
    };
  }

  private getMinVenueShares(): number {
    const envValue = Number(process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES || 5);
    if (!Number.isFinite(envValue)) return 5;
    return Math.max(1, Math.floor(envValue));
  }

  private canMutateVenueState(): boolean {
    return (
      this.config.polymarket.mode === "live" &&
      this.config.polymarket.liveConfirmed &&
      this.config.polymarket.liveExecutionEnabled &&
      !this.config.polymarket.killSwitch
    );
  }
}

