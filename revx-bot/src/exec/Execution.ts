import { BotConfig } from "../config";
import { randomUUID } from "node:crypto";
import { Logger } from "../logger";
import { PlaceOrderPayload, RevXClient, RevXHttpError } from "../revx/RevXClient";
import { BotEventType, OrderRecord, Side, Store } from "../store/Store";
import { sleep } from "../util/time";
import { makeClientOrderId, makeRunId } from "../util/uuid";

export class Execution {
  private readonly runId = makeRunId();
  private metricNonce = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly client: RevXClient,
    private readonly store: Store,
    private readonly dryRun: boolean
  ) {}

  getRunId(): string {
    return this.runId;
  }

  makeTag(symbol: string, side: Side, level: number | string): string {
    const levelSuffix = typeof level === "number" ? `L${level}` : String(level);
    return `bot-${this.runId}-${symbol}-${side}-${levelSuffix}`;
  }

  async placeMakerOrder(params: {
    symbol: string;
    side: Side;
    price: number;
    quoteSizeUsd: number;
    retryOnPostOnlyReject?: boolean;
  }): Promise<{ clientOrderId: string; venueOrderId?: string }> {
    return this.placeTaggedMakerOrder({
      ...params,
      botTag: null
    });
  }

  async placeTaggedMakerOrder(params: {
    symbol: string;
    side: Side;
    price: number;
    quoteSizeUsd: number;
    botTag: string | null;
    clientOrderId?: string;
    retryOnPostOnlyReject?: boolean;
  }): Promise<{ clientOrderId: string; venueOrderId?: string }> {
    const clientOrderId = params.clientOrderId ?? makeClientOrderId(this.runId);
    let workingPrice = roundPrice(params.price);
    const quoteSize = roundUsd(params.quoteSizeUsd);
    const allowPostOnlyRetry = params.retryOnPostOnlyReject !== false;

    this.store.upsertOrder({
      client_order_id: clientOrderId,
      bot_tag: params.botTag,
      symbol: params.symbol,
      side: params.side,
      price: workingPrice,
      quote_size: quoteSize,
      status: this.dryRun ? "DRY_RUN_NEW" : "SUBMITTING",
      last_seen_status: this.dryRun ? "DRY_RUN_NEW" : "SUBMITTING",
      is_bot: 1
    });

    if (this.dryRun) {
      this.logger.info(
        {
          side: params.side,
          symbol: params.symbol,
          price: workingPrice,
          quoteSize,
          clientOrderId,
          botTag: params.botTag
        },
        "DRY_RUN place maker order"
      );
      this.recordBotEvent({
        type: "PLACED",
        side: params.side,
        price: workingPrice,
        quoteSizeUsd: quoteSize,
        venueOrderId: null,
        clientOrderId,
        reason: "DRY_RUN",
        botTag: params.botTag
      });
      return { clientOrderId };
    }

    let widenedOnce = false;
    for (let attempt = 0; attempt <= this.config.placeRetry; attempt += 1) {
      const payload: PlaceOrderPayload = {
        client_order_id: clientOrderId,
        symbol: params.symbol,
        side: params.side.toLowerCase() as "buy" | "sell",
        type: "limit",
        order_configuration: {
          limit: {
            quote_size: quoteSize.toFixed(2),
            price: workingPrice.toFixed(2),
            execution_instructions: ["post_only"]
          }
        }
      };

      try {
        const raw = (await this.client.placeOrder(payload)) as Record<string, unknown>;
        const venueOrderId = pickString(raw, ["venue_order_id", "order_id", "id"]);
        const status = normalizeOrderStatus(pickString(raw, ["state", "status"]) || "NEW");

        this.store.upsertOrder({
          client_order_id: clientOrderId,
          venue_order_id: venueOrderId,
          bot_tag: params.botTag,
          symbol: params.symbol,
          side: params.side,
          price: workingPrice,
          quote_size: quoteSize,
          status,
          last_seen_status: status,
          is_bot: 1
        });

        this.logger.info(
          {
            side: params.side,
            price: workingPrice,
            quoteSize,
            clientOrderId,
            venueOrderId,
            botTag: params.botTag
          },
          "Placed post-only maker order"
        );
        this.recordBotEvent({
          type: "PLACED",
          side: params.side,
          price: workingPrice,
          quoteSizeUsd: quoteSize,
          venueOrderId: venueOrderId || null,
          clientOrderId,
          reason: "API_ACCEPTED",
          botTag: params.botTag
        });

        return { clientOrderId, venueOrderId };
      } catch (error) {
        if (
          allowPostOnlyRetry &&
          !widenedOnce &&
          error instanceof RevXHttpError &&
          isPostOnlyReject(error)
        ) {
          this.recordMetricEvent("post_only_reject_event", 1);
          if (this.config.trackPostOnlyRejects) {
            this.recordBotEvent({
              type: "REJECTED",
              side: params.side,
              price: workingPrice,
              quoteSizeUsd: quoteSize,
              venueOrderId: null,
              clientOrderId,
              reason: "POST_ONLY_REJECT",
              botTag: params.botTag
            });
          }
          widenedOnce = true;
          workingPrice =
            params.side === "BUY"
              ? roundPrice(workingPrice * (1 - 5 / 10_000))
              : roundPrice(workingPrice * (1 + 5 / 10_000));
          this.logger.warn(
            { clientOrderId, side: params.side, adjustedPrice: workingPrice },
            "Post-only rejected, widening by 5 bps and retrying"
          );
          continue;
        }

        if (isRetryableExecutionError(error) && attempt < this.config.placeRetry) {
          const existingLocal = this.store.getOrderByClientId(clientOrderId);
          if (existingLocal?.venue_order_id) {
            return { clientOrderId, venueOrderId: existingLocal.venue_order_id };
          }

          const existingVenue = await this.findVenueOrderByClientId(params.symbol, clientOrderId);
          if (existingVenue) {
            const status = normalizeOrderStatus(existingVenue.status ?? "NEW");
            this.store.upsertOrder({
              client_order_id: clientOrderId,
              venue_order_id: existingVenue.venueOrderId,
              bot_tag: params.botTag,
              symbol: params.symbol,
              side: params.side,
              price: workingPrice,
              quote_size: quoteSize,
              status,
              last_seen_status: status,
              is_bot: 1
            });
            return { clientOrderId, venueOrderId: existingVenue.venueOrderId };
          }

          const backoffMs = Math.min(400 * 2 ** attempt + jitter(150), 4_000);
          this.logger.warn(
            { attempt: attempt + 1, maxRetries: this.config.placeRetry, backoffMs, clientOrderId },
            "place order retry"
          );
          await sleep(backoffMs);
          continue;
        }

        this.store.upsertOrder({
          client_order_id: clientOrderId,
          bot_tag: params.botTag,
          symbol: params.symbol,
          side: params.side,
          price: workingPrice,
          quote_size: quoteSize,
          status: "REJECTED",
          last_seen_status: "REJECTED",
          is_bot: 1
        });
        this.recordBotEvent({
          type: error instanceof RevXHttpError && error.status >= 400 && error.status < 500 ? "REJECTED" : "ERROR",
          side: params.side,
          price: workingPrice,
          quoteSizeUsd: quoteSize,
          venueOrderId: null,
          clientOrderId,
          reason: error instanceof Error ? error.message : "PLACE_FAILED",
          botTag: params.botTag
        });
        throw error;
      }
    }

    throw new Error("unreachable place retry loop");
  }

  async cancelOrder(venueOrderId: string): Promise<void> {
    const existing = this.store.getOrderByVenueId(venueOrderId);
    if (this.dryRun) {
      this.logger.info({ venueOrderId }, "DRY_RUN cancel order");
      this.store.updateOrderStatusByVenueId(venueOrderId, "CANCELLED_DRY_RUN");
      this.recordRestingTime(existing);
      this.recordBotEvent({
        type: "CANCELLED",
        side: existing?.side ?? "-",
        price: existing?.price ?? 0,
        quoteSizeUsd: existing?.quote_size ?? 0,
        venueOrderId,
        clientOrderId: existing?.client_order_id ?? "-",
        reason: "DRY_RUN",
        botTag: existing?.bot_tag ?? null
      });
      return;
    }

    for (let attempt = 0; attempt <= this.config.cancelRetry; attempt += 1) {
      try {
        await this.client.cancelOrderById(venueOrderId);
        this.store.updateOrderStatusByVenueId(venueOrderId, "CANCELLED");
        this.recordRestingTime(existing);
        this.recordBotEvent({
          type: "CANCELLED",
          side: existing?.side ?? "-",
          price: existing?.price ?? 0,
          quoteSizeUsd: existing?.quote_size ?? 0,
          venueOrderId,
          clientOrderId: existing?.client_order_id ?? "-",
          reason: "USER_CANCEL",
          botTag: existing?.bot_tag ?? null
        });
        this.logger.info({ venueOrderId }, "Cancelled order");
        return;
      } catch (error) {
        if (error instanceof RevXHttpError) {
          if (error.status === 404) {
            this.store.updateOrderStatusByVenueId(venueOrderId, "INACTIVE");
            this.recordRestingTime(existing);
            this.recordBotEvent({
              type: "CANCELLED",
              side: existing?.side ?? "-",
              price: existing?.price ?? 0,
              quoteSizeUsd: existing?.quote_size ?? 0,
              venueOrderId,
              clientOrderId: existing?.client_order_id ?? "-",
              reason: "ALREADY_INACTIVE",
              botTag: existing?.bot_tag ?? null
            });
            this.logger.info(
              { venueOrderId, status: error.status },
              "Order not found; treated as cancelled"
            );
            return;
          }

          if (error.status === 409) {
            const responseMessage = extractHttpErrorMessage(error.responseBody);
            this.store.updateOrderStatusByVenueId(venueOrderId, "INACTIVE");
            this.recordRestingTime(existing);
            this.recordBotEvent({
              type: "CANCELLED",
              side: existing?.side ?? "-",
              price: existing?.price ?? 0,
              quoteSizeUsd: existing?.quote_size ?? 0,
              venueOrderId,
              clientOrderId: existing?.client_order_id ?? "-",
              reason: "ALREADY_INACTIVE",
              botTag: existing?.bot_tag ?? null
            });
            this.logger.info(
              { venueOrderId, status: error.status, responseMessage },
              "Order already inactive; treated as cancelled"
            );
            return;
          }
        }

        if (isRetryableCancelError(error) && attempt < this.config.cancelRetry) {
          const backoffMs = Math.min(300 * 2 ** attempt + jitter(120), 3_000);
          this.logger.warn(
            { attempt: attempt + 1, maxRetries: this.config.cancelRetry, backoffMs, venueOrderId },
            "cancel order retry"
          );
          await sleep(backoffMs);
          continue;
        }
        throw error;
      }
    }
  }

  async cancelOrders(orders: OrderRecord[]): Promise<void> {
    for (const order of orders) {
      if (!order.venue_order_id) continue;
      await this.cancelOrder(order.venue_order_id);
    }
  }

  async cancelOrderByTag(tag: string): Promise<void> {
    const orders = this.store.getBotOrdersByTag(tag);
    for (const order of orders) {
      if (!order.venue_order_id) continue;
      if (!isActiveStatus(order.status)) continue;
      await this.cancelOrder(order.venue_order_id);
    }
  }

  async cancelAllBotOrders(symbol?: string): Promise<void> {
    const targetSymbol = symbol ?? this.config.symbol;
    const activeOrders = await this.client.getActiveOrders(targetSymbol);
    const venueIds = new Set<string>();

    for (const row of activeOrders) {
      const obj = row as Record<string, unknown>;
      const venueOrderId = pickString(obj, ["venue_order_id", "order_id", "id"]);
      if (!venueOrderId) continue;

      const clientOrderId = pickString(obj, ["client_order_id"]);
      const looksBotOwnedByClientId = clientOrderId.startsWith("bot-");

      const localByClient = clientOrderId ? this.store.getOrderByClientId(clientOrderId) : null;
      const localByVenue = this.store.getOrderByVenueId(venueOrderId);
      const looksBotOwnedByStore = Boolean(
        (localByClient && (localByClient.is_bot === 1 || localByClient.bot_tag)) ||
          (localByVenue && (localByVenue.is_bot === 1 || localByVenue.bot_tag))
      );

      if (looksBotOwnedByClientId || looksBotOwnedByStore) {
        venueIds.add(venueOrderId);
      }
    }

    for (const venueOrderId of venueIds) {
      try {
        await this.cancelOrder(venueOrderId);
      } catch (error) {
        this.logger.error({ error, venueOrderId }, "Failed cancelling bot order");
      }
    }
  }

  private async findVenueOrderByClientId(
    symbol: string,
    clientOrderId: string
  ): Promise<{ venueOrderId: string; status?: string } | null> {
    try {
      const active = await this.client.getActiveOrders(symbol);
      for (const row of active) {
        const obj = row as Record<string, unknown>;
        if (pickString(obj, ["client_order_id"]) !== clientOrderId) continue;
        const venueOrderId = pickString(obj, ["venue_order_id", "order_id", "id"]);
        if (!venueOrderId) continue;
        return { venueOrderId, status: pickString(obj, ["state", "status"]) };
      }
    } catch (error) {
      this.logger.debug({ error, clientOrderId }, "findVenueOrderByClientId failed");
    }
    return null;
  }

  private recordMetricEvent(key: string, value: number): void {
    this.metricNonce = (this.metricNonce + 1) % 1_000;
    this.store.recordMetric({
      ts: Date.now() + this.metricNonce,
      key,
      value
    });
  }

  private recordRestingTime(order: OrderRecord | null): void {
    if (!order) return;
    if (!Number.isFinite(order.created_at) || order.created_at <= 0) return;
    const restingSeconds = Math.max(0, (Date.now() - order.created_at) / 1000);
    this.recordMetricEvent("resting_time_seconds", restingSeconds);
  }

  private recordBotEvent(params: {
    type: BotEventType;
    side: Side | "-";
    price: number;
    quoteSizeUsd: number;
    venueOrderId: string | null;
    clientOrderId: string;
    reason: string;
    botTag: string | null;
  }): void {
    this.store.recordBotEvent({
      event_id: randomUUID(),
      ts: Date.now(),
      type: params.type,
      side: params.side,
      price: params.price,
      quote_size_usd: params.quoteSizeUsd,
      venue_order_id: params.venueOrderId,
      client_order_id: params.clientOrderId,
      reason: params.reason,
      bot_tag: params.botTag ?? "-"
    });
  }
}

function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function isPostOnlyReject(error: RevXHttpError): boolean {
  const raw =
    typeof error.responseBody === "string"
      ? error.responseBody
      : JSON.stringify(error.responseBody ?? "");
  const message = raw.toLowerCase();
  return (
    message.includes("post") &&
    (message.includes("only") ||
      message.includes("maker") ||
      message.includes("cross") ||
      message.includes("immediate"))
  );
}

function isRetryableExecutionError(error: unknown): boolean {
  if (error instanceof RevXHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error) {
    return error.message.toLowerCase().includes("fetch failed");
  }
  return false;
}

function isRetryableCancelError(error: unknown): boolean {
  if (error instanceof RevXHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error) {
    return error.message.toLowerCase().includes("fetch failed");
  }
  return false;
}

function extractHttpErrorMessage(body: unknown): string {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  const maybeMessage = (body as Record<string, unknown>).message;
  return typeof maybeMessage === "string" ? maybeMessage : "";
}

function normalizeOrderStatus(status: string): string {
  return status.trim().toUpperCase();
}

function isActiveStatus(status: string): boolean {
  return [
    "NEW",
    "OPEN",
    "PARTIALLY_FILLED",
    "PARTIAL_FILLED",
    "PENDING",
    "PENDING_NEW",
    "ACCEPTED",
    "SUBMITTING"
  ].includes(normalizeOrderStatus(status));
}

function jitter(maxMs: number): number {
  return Math.floor(Math.random() * (maxMs + 1));
}
