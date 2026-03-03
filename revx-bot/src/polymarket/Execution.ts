import { randomUUID } from "node:crypto";
import { BotConfig } from "../config";
import { Logger } from "../logger";
import { sleep } from "../util/time";
import { PolymarketClient } from "./PolymarketClient";
import { ExecutionResult, OpenOrderState, PositionState } from "./types";

type SubmittedOrderMeta = {
  marketId: string;
  tokenId: string;
  side: "BUY" | "SELL";
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
    const price = clamp(params.yesAsk, 0.0001, 0.9999);
    const shares = params.notionalUsd / price;

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
      this.applyFill(params.marketId, shares, price);
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
        action: "BUY_YES",
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
      const placed = await this.client.placeMarketableBuyYes({
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
        side: "BUY",
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
      }

      await this.refreshLiveState();
      const fill = this.fillsByVenueOrderId.get(placed.orderId);
      const filledShares = fill ? fill.shares : 0;
      const fillPrice = fill && fill.shares > 0 ? fill.notional / fill.shares : undefined;

      return {
        action: "BUY_YES",
        accepted: true,
        filledShares,
        fillPrice,
        orderId: placed.orderId,
        reason: filledShares > 0 ? "LIVE_FILLED_OR_PARTIAL" : "LIVE_PLACED_NO_FILL"
      };
    } catch (error) {
      openOrder.status = "REJECTED";
      this.logger.error({ error, marketId: params.marketId, tokenId: params.tokenId }, "Polymarket order rejected");
      return {
        action: "BUY_YES",
        accepted: false,
        filledShares: 0,
        reason: error instanceof Error ? error.message : "ORDER_FAILED"
      };
    } finally {
      this.openOrders.delete(localOrderId);
    }
  }

  async refreshLiveState(): Promise<void> {
    if (this.config.polymarket.mode !== "live") return;

    const [openOrders, recentTrades] = await Promise.all([
      this.client.getOpenOrders(),
      this.client.getRecentTrades(250)
    ]);

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

    const remoteOpenIds = new Set(openOrders.map((row) => row.id));

    for (const local of this.openOrders.values()) {
      if (!local.venueOrderId) continue;
      if (!remoteOpenIds.has(local.venueOrderId) && local.status === "NEW") {
        const status = await this.client.getOrder(local.venueOrderId);
        if (status && isTerminalStatus(status.status)) {
          local.status = status.sizeMatched > 0 ? "FILLED" : "CANCELLED";
          if (status.sizeMatched > 0) {
            this.recordFill(local.venueOrderId, status.sizeMatched, status.price, true);
          }
        }
      }
    }

    for (const trade of recentTrades) {
      if (this.seenTradeIds.has(trade.id)) continue;
      this.seenTradeIds.add(trade.id);

      const orderId = trade.takerOrderId;
      if (!orderId) continue;
      const meta = this.submittedByVenueOrderId.get(orderId);
      if (!meta) continue;
      if (meta.side !== "BUY") continue;

      this.recordFill(orderId, trade.size, trade.price);
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
        }
      } catch (error) {
        this.logger.warn({ error, order }, "Failed to cancel Polymarket order");
      }
      order.status = "CANCELLED";
    }
    this.openOrders.clear();
    this.remoteOpenOrdersCount = 0;
    this.remoteOpenOrderMarkets.clear();
    this.remoteOpenBuyTokenIds.clear();

    if (this.config.polymarket.mode === "live") {
      try {
        await this.client.cancelAll();
      } catch (error) {
        this.logger.warn({ error }, "Polymarket cancelAll endpoint failed");
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
      exposure += Math.max(0, order.notionalUsd);
    }
    return exposure;
  }

  getConcurrentWindows(): number {
    const windows = new Set<string>();
    for (const position of this.positions.values()) {
      if (position.yesShares > 0) {
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
    if (unapplied > 0 && meta.side === "BUY") {
      const avgPrice = current.shares > 0 ? current.notional / current.shares : meta.limitPrice;
      this.applyFill(meta.marketId, unapplied, avgPrice);
      this.appliedSharesByVenueOrderId.set(orderId, applied + unapplied);
    }
  }

  private applyFill(marketId: string, filledShares: number, fillPrice: number): void {
    const current = this.positions.get(marketId);
    if (!current) {
      this.positions.set(marketId, {
        marketId,
        yesShares: filledShares,
        costUsd: filledShares * fillPrice,
        avgPrice: fillPrice,
        updatedTs: Date.now()
      });
      return;
    }

    const nextShares = current.yesShares + filledShares;
    const nextCost = current.costUsd + filledShares * fillPrice;
    const avgPrice = nextShares > 0 ? nextCost / nextShares : 0;
    this.positions.set(marketId, {
      marketId,
      yesShares: nextShares,
      costUsd: nextCost,
      avgPrice,
      updatedTs: Date.now()
    });
  }
}

function isTerminalStatus(status: string): boolean {
  const normalized = String(status || "").trim().toUpperCase();
  return normalized === "MATCHED" || normalized === "CANCELED" || normalized === "CANCELLED";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
