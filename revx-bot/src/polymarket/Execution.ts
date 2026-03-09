import { randomUUID } from "node:crypto";
import { BotConfig } from "../config";
import { Logger } from "../logger";
import { sleep } from "../util/time";
import { PolymarketClient } from "./PolymarketClient";
import { ExecutionResult, OpenOrderState, PositionState } from "./types";

type SubmittedOrderMeta = {
  marketId: string;
  tokenId: string;
  orderSide: "BUY" | "SELL";
  positionSide: "YES" | "NO";
  limitPrice: number;
};

type FillTracker = {
  shares: number;
  notional: number;
};

export class PolymarketExecution {
  private readonly openOrders = new Map<string, OpenOrderState>();
  private readonly positions = new Map<string, PositionState>();
  private remoteOpenOrdersCount = 0;
  private remoteOpenOrderMarkets = new Set<string>();
  private remoteOpenBuyTokenIds = new Set<string>();
  private remoteOpenSellTokenIds = new Set<string>();
  private liveReadWarningState: string | null = null;
  private lastLiveReadWarningSignature = "";
  private lastLiveReadWarningLogTs = 0;
  private liveReadDegradedActive = false;
  private lastPassiveLiveSyncTs = 0;

  private readonly submittedByVenueOrderId = new Map<string, SubmittedOrderMeta>();
  private readonly fillsByVenueOrderId = new Map<string, FillTracker>();
  private readonly appliedSharesByVenueOrderId = new Map<string, number>();
  private readonly seenTradeIds = new Set<string>();

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly client: PolymarketClient
  ) {}

  async executeBuyYes(params: {
    marketId: string;
    tokenId: string;
    yesAsk: number;
    notionalUsd: number;
    tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
    negRisk?: boolean;
  }): Promise<ExecutionResult> {
    return this.executeEntry({
      marketId: params.marketId,
      tokenId: params.tokenId,
      side: "YES",
      askPrice: params.yesAsk,
      notionalUsd: params.notionalUsd,
      tickSize: params.tickSize,
      negRisk: params.negRisk
    });
  }

  async executeBuyNo(params: {
    marketId: string;
    tokenId: string;
    noAsk: number;
    notionalUsd: number;
    tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
    negRisk?: boolean;
  }): Promise<ExecutionResult> {
    return this.executeEntry({
      marketId: params.marketId,
      tokenId: params.tokenId,
      side: "NO",
      askPrice: params.noAsk,
      notionalUsd: params.notionalUsd,
      tickSize: params.tickSize,
      negRisk: params.negRisk
    });
  }

  async executeEntry(params: {
    marketId: string;
    tokenId: string;
    side: "YES" | "NO";
    askPrice: number;
    notionalUsd: number;
    tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
    negRisk?: boolean;
  }): Promise<ExecutionResult> {
    const price = clamp(params.askPrice, 0.0001, 0.9999);
    const shares = params.notionalUsd / price;
    const entryAction = params.side === "YES" ? "BUY_YES" : "BUY_NO";

    if (!(params.notionalUsd > 0) || !(shares > 0)) {
      return {
        action: "HOLD",
        accepted: false,
        filledShares: 0,
        reason: "NON_POSITIVE_SIZE"
      };
    }

    const hasOpenDuplicate = Array.from(this.openOrders.values()).some(
      (row) =>
        row.marketId === params.marketId &&
        row.tokenId === params.tokenId &&
        row.side === "BUY" &&
        row.status === "NEW"
    );
    if (hasOpenDuplicate) {
      return {
        action: "HOLD",
        accepted: false,
        filledShares: 0,
        reason: "OPEN_ORDER_ALREADY_EXISTS"
      };
    }

    if (this.config.polymarket.mode === "live" && this.remoteOpenBuyTokenIds.has(params.tokenId)) {
      return {
        action: "HOLD",
        accepted: false,
        filledShares: 0,
        reason: "REMOTE_OPEN_ORDER_ALREADY_EXISTS"
      };
    }

    if (this.config.polymarket.mode === "paper") {
      this.applyFill(
        {
          marketId: params.marketId,
          tokenId: params.tokenId,
          orderSide: "BUY",
          positionSide: params.side,
          limitPrice: price
        },
        shares,
        price
      );
      this.logger.info(
        {
          marketId: params.marketId,
          tokenId: params.tokenId,
          mode: "paper",
          notionalUsd: params.notionalUsd,
          shares,
          price
        },
        "Polymarket paper fill"
      );
      return {
        action: entryAction,
        accepted: true,
        filledShares: shares,
        fillPrice: price,
        reason: "PAPER_IMMEDIATE_FILL"
      };
    }

    const localOrderId = randomUUID();
    const limitPrice = clamp(price + this.config.polymarket.execution.takerPriceBuffer, 0.0001, 0.9999);
    const ttlMs = this.config.polymarket.execution.orderTtlMs;
    const startedTs = Date.now();
    const openOrder: OpenOrderState = {
      localOrderId,
      marketId: params.marketId,
      tokenId: params.tokenId,
      side: "BUY",
      limitPrice,
      shares,
      notionalUsd: params.notionalUsd,
      matchedShares: 0,
      createdTs: startedTs,
      expiresTs: startedTs + ttlMs,
      status: "NEW"
    };
    this.openOrders.set(localOrderId, openOrder);

    try {
      const placed =
        params.side === "YES"
          ? await this.client.placeMarketableBuyYes({
              marketId: params.marketId,
              tokenId: params.tokenId,
              limitPrice,
              size: shares,
              ttlMs,
              tickSize: params.tickSize,
              negRisk: params.negRisk
            })
          : await this.client.placeMarketableBuyNo({
              marketId: params.marketId,
              tokenId: params.tokenId,
              limitPrice,
              size: shares,
              ttlMs,
              tickSize: params.tickSize,
              negRisk: params.negRisk
            });

      openOrder.venueOrderId = placed.orderId;
      this.submittedByVenueOrderId.set(placed.orderId, {
        marketId: params.marketId,
        tokenId: params.tokenId,
        orderSide: "BUY",
        positionSide: params.side,
        limitPrice
      });

      const pollMs = Math.max(200, Math.min(1500, Math.floor(ttlMs / 3)));
      while (Date.now() < openOrder.expiresTs) {
        await this.refreshLiveState();

        const currentMatched = this.fillsByVenueOrderId.get(placed.orderId)?.shares ?? 0;
        openOrder.matchedShares = currentMatched;

        const status = await this.client.getOrder(placed.orderId);
        if (!status) {
          await sleep(pollMs);
          continue;
        }

        if (status.sizeMatched > currentMatched) {
          this.recordFill(placed.orderId, status.sizeMatched - currentMatched, status.price);
        }

        const terminal = isTerminalStatus(status.status);
        if (terminal) {
          openOrder.status = status.sizeMatched > 0 ? "FILLED" : "CANCELLED";
          break;
        }

        await sleep(pollMs);
      }

      if (openOrder.status === "NEW" && openOrder.venueOrderId) {
        await this.client.cancelOrder(openOrder.venueOrderId);
        openOrder.status = "CANCELLED";
        this.logger.info(
          {
            marketId: params.marketId,
            tokenId: params.tokenId,
            orderId: openOrder.venueOrderId,
            reason: "ORDER_TTL_EXPIRED"
          },
          "POLY_LIVE_CANCEL"
        );
      }

      await this.refreshLiveState();
      const fill = this.fillsByVenueOrderId.get(placed.orderId);
      const filledShares = fill ? fill.shares : 0;
      const fillPrice = fill && fill.shares > 0 ? fill.notional / fill.shares : undefined;

      return {
        action: entryAction,
        accepted: true,
        filledShares,
        fillPrice,
        orderId: placed.orderId,
        reason: filledShares > 0 ? "LIVE_FILLED_OR_PARTIAL" : "LIVE_PLACED_NO_FILL"
      };
    } catch (error) {
      openOrder.status = "REJECTED";
      this.logger.error(
        { error, marketId: params.marketId, tokenId: params.tokenId, side: params.side },
        "POLY_LIVE_REJECT"
      );
      const payload: Record<string, unknown> = {
        marketId: params.marketId,
        tokenId: params.tokenId,
        errorSummary: shortErrorSummary(error)
      };
      if (this.isPolyVerboseDebug()) {
        payload.error = serializeErrorDetails(error);
      }
      this.logger.error(payload, "Polymarket order rejected");
      const normalizedReason = this.normalizeOrderRejectReason(error);
      return {
        action: entryAction,
        accepted: false,
        filledShares: 0,
        reason: normalizedReason
      };
    } finally {
      this.openOrders.delete(localOrderId);
    }
  }

  async executeExit(params: {
    marketId: string;
    tokenId: string;
    side: "YES" | "NO";
    shares: number;
    bidPrice: number;
    tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
    negRisk?: boolean;
  }): Promise<ExecutionResult> {
    const price = clamp(params.bidPrice, 0.0001, 0.9999);
    const exitAction = params.side === "YES" ? "SELL_YES" : "SELL_NO";
    const positionKey = this.makePositionKey(params.marketId, params.tokenId);
    const position = this.positions.get(positionKey);
    const requestedShares = Number(params.shares);
    const shares = position && position.side === params.side ? Math.min(requestedShares, position.shares) : 0;

    if (!(requestedShares > 0) || !(shares > 0)) {
      return {
        action: "HOLD",
        accepted: false,
        filledShares: 0,
        reason: "NO_POSITION_TO_EXIT"
      };
    }

    const hasOpenDuplicate = Array.from(this.openOrders.values()).some(
      (row) =>
        row.marketId === params.marketId &&
        row.tokenId === params.tokenId &&
        row.side === "SELL" &&
        row.status === "NEW"
    );
    if (hasOpenDuplicate) {
      return {
        action: "HOLD",
        accepted: false,
        filledShares: 0,
        reason: "OPEN_ORDER_ALREADY_EXISTS"
      };
    }

    if (this.config.polymarket.mode === "live" && this.remoteOpenSellTokenIds.has(params.tokenId)) {
      return {
        action: "HOLD",
        accepted: false,
        filledShares: 0,
        reason: "REMOTE_OPEN_ORDER_ALREADY_EXISTS"
      };
    }

    if (this.config.polymarket.mode === "paper") {
      this.applyFill(
        {
          marketId: params.marketId,
          tokenId: params.tokenId,
          orderSide: "SELL",
          positionSide: params.side,
          limitPrice: price
        },
        shares,
        price
      );
      this.logger.info(
        {
          marketId: params.marketId,
          tokenId: params.tokenId,
          mode: "paper",
          shares,
          price
        },
        "Polymarket paper fill"
      );
      return {
        action: exitAction,
        accepted: true,
        filledShares: shares,
        fillPrice: price,
        reason: "PAPER_IMMEDIATE_FILL"
      };
    }

    const localOrderId = randomUUID();
    const limitPrice = clamp(price - this.config.polymarket.execution.takerPriceBuffer, 0.0001, 0.9999);
    const ttlMs = this.config.polymarket.execution.orderTtlMs;
    const startedTs = Date.now();
    const openOrder: OpenOrderState = {
      localOrderId,
      marketId: params.marketId,
      tokenId: params.tokenId,
      side: "SELL",
      limitPrice,
      shares,
      notionalUsd: shares * limitPrice,
      matchedShares: 0,
      createdTs: startedTs,
      expiresTs: startedTs + ttlMs,
      status: "NEW"
    };
    this.openOrders.set(localOrderId, openOrder);

    try {
      const placed = await this.client.placeMarketableOrder({
        marketId: params.marketId,
        tokenId: params.tokenId,
        side: "SELL",
        limitPrice,
        size: shares,
        ttlMs,
        tickSize: params.tickSize,
        negRisk: params.negRisk
      });

      openOrder.venueOrderId = placed.orderId;
      this.submittedByVenueOrderId.set(placed.orderId, {
        marketId: params.marketId,
        tokenId: params.tokenId,
        orderSide: "SELL",
        positionSide: params.side,
        limitPrice
      });

      const pollMs = Math.max(200, Math.min(1500, Math.floor(ttlMs / 3)));
      while (Date.now() < openOrder.expiresTs) {
        await this.refreshLiveState();

        const currentMatched = this.fillsByVenueOrderId.get(placed.orderId)?.shares ?? 0;
        openOrder.matchedShares = currentMatched;

        const status = await this.client.getOrder(placed.orderId);
        if (!status) {
          await sleep(pollMs);
          continue;
        }

        if (status.sizeMatched > currentMatched) {
          this.recordFill(placed.orderId, status.sizeMatched - currentMatched, status.price);
        }

        const terminal = isTerminalStatus(status.status);
        if (terminal) {
          openOrder.status = status.sizeMatched > 0 ? "FILLED" : "CANCELLED";
          break;
        }

        await sleep(pollMs);
      }

      if (openOrder.status === "NEW" && openOrder.venueOrderId) {
        await this.client.cancelOrder(openOrder.venueOrderId);
        openOrder.status = "CANCELLED";
        this.logger.info(
          {
            marketId: params.marketId,
            tokenId: params.tokenId,
            orderId: openOrder.venueOrderId,
            reason: "ORDER_TTL_EXPIRED"
          },
          "POLY_LIVE_CANCEL"
        );
      }

      await this.refreshLiveState();
      const fill = this.fillsByVenueOrderId.get(placed.orderId);
      const filledShares = fill ? fill.shares : 0;
      const fillPrice = fill && fill.shares > 0 ? fill.notional / fill.shares : undefined;

      return {
        action: exitAction,
        accepted: true,
        filledShares,
        fillPrice,
        orderId: placed.orderId,
        reason: filledShares > 0 ? "LIVE_FILLED_OR_PARTIAL" : "LIVE_PLACED_NO_FILL"
      };
    } catch (error) {
      openOrder.status = "REJECTED";
      this.logger.error(
        { error, marketId: params.marketId, tokenId: params.tokenId, side: params.side },
        "POLY_LIVE_REJECT"
      );
      const payload: Record<string, unknown> = {
        marketId: params.marketId,
        tokenId: params.tokenId,
        errorSummary: shortErrorSummary(error)
      };
      if (this.isPolyVerboseDebug()) {
        payload.error = serializeErrorDetails(error);
      }
      this.logger.error(payload, "Polymarket order rejected");
      const normalizedReason = this.normalizeOrderRejectReason(error);
      return {
        action: exitAction,
        accepted: false,
        filledShares: 0,
        reason: normalizedReason
      };
    } finally {
      this.openOrders.delete(localOrderId);
    }
  }

  async refreshLiveState(): Promise<void> {
    if (this.config.polymarket.mode !== "live") return;
    const nowTs = Date.now();
    const hasVenueStateToReconcile =
      this.openOrders.size > 0 ||
      this.remoteOpenOrdersCount > 0 ||
      this.submittedByVenueOrderId.size > 0;
    if (!hasVenueStateToReconcile && nowTs - this.lastPassiveLiveSyncTs < 30_000) {
      this.liveReadWarningState = null;
      return;
    }
    this.lastPassiveLiveSyncTs = nowTs;

    const [openOrdersResult, recentTradesResult] = await Promise.allSettled([
      this.client.getOpenOrders(),
      this.client.getRecentTrades(250)
    ]);
    const degradedLabels: string[] = [];
    const openOrders =
      openOrdersResult.status === "fulfilled" ? openOrdersResult.value : null;
    const recentTrades =
      recentTradesResult.status === "fulfilled" ? recentTradesResult.value : null;

    if (openOrdersResult.status === "rejected") {
      degradedLabels.push("getOpenOrders");
      this.logLiveReadDegraded(
        "getOpenOrders",
        openOrdersResult.reason,
        "Polymarket live read degraded: getOpenOrders failed; preserving cached open-order state"
      );
    }
    if (recentTradesResult.status === "rejected") {
      degradedLabels.push("getTrades");
      this.logLiveReadDegraded(
        "getTrades",
        recentTradesResult.reason,
        "Polymarket live read degraded: getTrades failed; preserving cached trade state"
      );
    }

    if (openOrders) {
      this.remoteOpenOrdersCount = openOrders.length;
      this.remoteOpenOrderMarkets = new Set(
        openOrders
          .map((row) => row.market)
          .filter((value) => value.length > 0)
      );
      this.remoteOpenBuyTokenIds = new Set(
        openOrders
          .filter((row) => row.side === "BUY")
          .map((row) => row.assetId)
          .filter((value) => value.length > 0)
      );
      this.remoteOpenSellTokenIds = new Set(
        openOrders
          .filter((row) => row.side === "SELL")
          .map((row) => row.assetId)
          .filter((value) => value.length > 0)
      );
    }

    const remoteOpenIds = openOrders ? new Set(openOrders.map((row) => row.id)) : null;

    for (const local of this.openOrders.values()) {
      if (!local.venueOrderId || !remoteOpenIds) continue;
      if (!remoteOpenIds.has(local.venueOrderId) && local.status === "NEW") {
        try {
          const status = await this.client.getOrder(local.venueOrderId);
          if (status && isTerminalStatus(status.status)) {
            local.status = status.sizeMatched > 0 ? "FILLED" : "CANCELLED";
            if (status.sizeMatched > 0) {
              this.recordFill(local.venueOrderId, status.sizeMatched, status.price, true);
            }
          }
        } catch (error) {
          degradedLabels.push("getOrder");
          this.logLiveReadDegraded(
            "getOrder",
            error,
            "Polymarket live read degraded: getOrder failed during refresh; preserving local order state",
            {
              venueOrderId: local.venueOrderId,
              marketId: local.marketId
            }
          );
        }
      }
    }

    for (const trade of recentTrades || []) {
      if (this.seenTradeIds.has(trade.id)) continue;
      this.seenTradeIds.add(trade.id);

      const orderId = trade.takerOrderId;
      if (!orderId) continue;
      const meta = this.submittedByVenueOrderId.get(orderId);
      if (!meta) continue;

      this.recordFill(orderId, trade.size, trade.price);
    }

    this.liveReadWarningState = degradedLabels.length > 0 ? "NETWORK_ERROR" : null;
    if (degradedLabels.length > 0) {
      this.liveReadDegradedActive = true;
    } else if (this.liveReadDegradedActive) {
      this.liveReadDegradedActive = false;
      this.logger.info("Polymarket live read recovered");
    }

    if (this.seenTradeIds.size > 20_000) {
      const arr = Array.from(this.seenTradeIds.values());
      this.seenTradeIds.clear();
      for (const id of arr.slice(arr.length - 10_000)) {
        this.seenTradeIds.add(id);
      }
    }
  }

  // Scaffolding for future maker mode. Disabled by default in config.
  async quoteBothSides(_params: {
    marketId: string;
    yesTokenId: string;
    noTokenId?: string;
    yesBid: number;
    yesAsk: number;
  }): Promise<void> {
    if (!this.config.polymarket.execution.enableMakerQuoting) {
      return;
    }
    this.logger.warn("Maker quoting scaffold is present but intentionally disabled");
  }

  async cancelAll(reason: string): Promise<void> {
    const localOpen = Array.from(this.openOrders.values());
    for (const order of localOpen) {
      try {
        if (order.venueOrderId) {
          await this.client.cancelOrder(order.venueOrderId);
          this.logger.info(
            {
              marketId: order.marketId,
              tokenId: order.tokenId,
              orderId: order.venueOrderId,
              reason
            },
            "POLY_LIVE_CANCEL"
          );
        }
      } catch (error) {
        const payload: Record<string, unknown> = {
          venueOrderId: order.venueOrderId ?? null,
          marketId: order.marketId,
          errorSummary: shortErrorSummary(error)
        };
        if (this.isPolyVerboseDebug()) {
          payload.error = serializeErrorDetails(error);
        }
        this.logger.warn(payload, "Failed to cancel Polymarket order");
      }
      order.status = "CANCELLED";
    }
    this.openOrders.clear();
    this.remoteOpenOrdersCount = 0;
    this.remoteOpenOrderMarkets.clear();
    this.remoteOpenBuyTokenIds.clear();
    this.remoteOpenSellTokenIds.clear();

    if (this.config.polymarket.mode === "live") {
      try {
        await this.client.cancelAll();
      } catch (error) {
        const payload: Record<string, unknown> = {
          errorSummary: shortErrorSummary(error)
        };
        if (this.isPolyVerboseDebug()) {
          payload.error = serializeErrorDetails(error);
        }
        this.logger.warn(payload, "Polymarket cancelAll endpoint failed");
      }
    }

    this.logger.warn({ reason }, "Polymarket cancel-all executed");
  }

  getOpenOrders(): OpenOrderState[] {
    return Array.from(this.openOrders.values()).sort((a, b) => a.createdTs - b.createdTs);
  }

  getOpenOrderCount(): number {
    return Math.max(this.openOrders.size, this.remoteOpenOrdersCount);
  }

  getPositions(): PositionState[] {
    return Array.from(this.positions.values()).sort((a, b) => a.marketId.localeCompare(b.marketId));
  }

  getTotalExposureUsd(): number {
    let exposure = 0;
    for (const position of this.positions.values()) {
      exposure += Math.max(0, position.costUsd);
    }
    for (const order of this.openOrders.values()) {
      if (order.side === "BUY") {
        exposure += Math.max(0, order.notionalUsd);
      }
    }
    return exposure;
  }

  getConcurrentWindows(): number {
    const windows = new Set<string>();
    for (const position of this.positions.values()) {
      if (position.shares > 0) {
        windows.add(position.marketId);
      }
    }
    for (const order of this.openOrders.values()) {
      windows.add(order.marketId);
    }
    for (const marketId of this.remoteOpenOrderMarkets.values()) {
      windows.add(marketId);
    }
    return windows.size;
  }

  getLiveReadWarningState(): string | null {
    return this.liveReadWarningState;
  }

  private logLiveReadDegraded(
    label: string,
    error: unknown,
    message: string,
    extra: Record<string, unknown> = {}
  ): void {
    if (!(this.config.debugHttp || process.env.DEBUG_POLY === "1" || process.env.DEBUG_POLY_VERBOSE === "true")) {
      return;
    }
    const nowTs = Date.now();
    const errorSummary = shortErrorSummary(error);
    const signature = JSON.stringify({ label, errorSummary, ...extra });
    if (
      signature === this.lastLiveReadWarningSignature &&
      nowTs - this.lastLiveReadWarningLogTs < 15_000
    ) {
      return;
    }
    this.lastLiveReadWarningSignature = signature;
    this.lastLiveReadWarningLogTs = nowTs;
    const payload: Record<string, unknown> = {
      label,
      errorSummary,
      ...extra
    };
    if (this.isPolyVerboseDebug()) {
      payload.error = serializeErrorDetails(error);
    }
    this.logger.warn(payload, message);
  }

  private isPolyVerboseDebug(): boolean {
    return this.config.debugHttp || process.env.DEBUG_POLY === "1" || process.env.DEBUG_POLY_VERBOSE === "true";
  }

  private normalizeOrderRejectReason(error: unknown): string {
    const summary = shortErrorSummary(error);
    const upper = summary.toUpperCase();
    if (upper.includes("SIZE (") && upper.includes("LOWER THAN THE MINIMUM: 5")) {
      return "ORDER_SIZE_BELOW_MIN_SHARES";
    }
    if (upper.includes("NO ORDERBOOK EXISTS") || upper.includes("REQUESTED TOKEN ID")) {
      return "SIDE_NOT_BOOKABLE";
    }
    if (upper.includes("INVALID_SIGNATURE") || upper.includes("SIGNATURE")) {
      return "ORDER_POST_REJECTED";
    }
    if (upper.includes("PRICE") && upper.includes("UNAVAILABLE")) {
      return "PRICE_UNAVAILABLE";
    }
    return "ORDER_POST_REJECTED";
  }

  private recordFill(orderId: string, sharesDelta: number, price: number, absolute = false): void {
    if (!(sharesDelta > 0)) return;
    const meta = this.submittedByVenueOrderId.get(orderId);
    if (!meta) return;

    const current = this.fillsByVenueOrderId.get(orderId) ?? { shares: 0, notional: 0 };
    if (absolute) {
      if (sharesDelta <= current.shares) return;
      const delta = sharesDelta - current.shares;
      current.shares = sharesDelta;
      current.notional += delta * Math.max(0, price || meta.limitPrice);
    } else {
      current.shares += sharesDelta;
      current.notional += sharesDelta * Math.max(0, price || meta.limitPrice);
    }
    this.fillsByVenueOrderId.set(orderId, current);

    const applied = this.appliedSharesByVenueOrderId.get(orderId) ?? 0;
    const unapplied = Math.max(0, current.shares - applied);
    if (unapplied > 0) {
      const avgPrice = current.shares > 0 ? current.notional / current.shares : meta.limitPrice;
      this.applyFill(meta, unapplied, avgPrice);
      this.appliedSharesByVenueOrderId.set(orderId, applied + unapplied);
    }
  }

  private applyFill(meta: SubmittedOrderMeta, filledShares: number, fillPrice: number): void {
    const key = this.makePositionKey(meta.marketId, meta.tokenId);
    const nowTs = Date.now();
    const current = this.positions.get(key);

    if (meta.orderSide === "BUY") {
      if (!current) {
        this.positions.set(key, {
          key,
          marketId: meta.marketId,
          tokenId: meta.tokenId,
          side: meta.positionSide,
          shares: filledShares,
          costUsd: filledShares * fillPrice,
          avgPrice: fillPrice,
          updatedTs: nowTs
        });
        return;
      }

      if (current.side !== meta.positionSide) {
        this.logger.warn(
          {
            marketId: meta.marketId,
            tokenId: meta.tokenId,
            currentSide: current.side,
            incomingSide: meta.positionSide
          },
          "Polymarket position-side mismatch on BUY fill; ignoring fill update"
        );
        return;
      }

      const nextShares = current.shares + filledShares;
      const nextCost = current.costUsd + filledShares * fillPrice;
      this.positions.set(key, {
        ...current,
        shares: nextShares,
        costUsd: nextCost,
        avgPrice: nextShares > 0 ? nextCost / nextShares : 0,
        updatedTs: nowTs
      });
      return;
    }

    if (!current) {
      return;
    }

    const reducedShares = Math.min(current.shares, filledShares);
    const remainingShares = Math.max(0, current.shares - reducedShares);
    if (!(remainingShares > 0)) {
      this.positions.delete(key);
      return;
    }
    const remainingCost = remainingShares * current.avgPrice;
    this.positions.set(key, {
      ...current,
      shares: remainingShares,
      costUsd: remainingCost,
      avgPrice: remainingCost / remainingShares,
      updatedTs: nowTs
    });
  }

  private makePositionKey(marketId: string, tokenId: string): string {
    return `${marketId}:${tokenId}`;
  }
}

function isTerminalStatus(status: string): boolean {
  const normalized = String(status || "").trim().toUpperCase();
  return normalized === "MATCHED" || normalized === "CANCELED" || normalized === "CANCELLED";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function serializeErrorDetails(error: unknown): Record<string, unknown> {
  const obj = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : String(obj.name || "Error"),
    status: Number(obj.status ?? (obj.response as Record<string, unknown> | undefined)?.status ?? 0) || 0
  };
}

function shortErrorSummary(error: unknown): string {
  const details = serializeErrorDetails(error);
  return [details.name, details.status, details.message]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length > 0 && value !== "0")
    .join(":");
}
