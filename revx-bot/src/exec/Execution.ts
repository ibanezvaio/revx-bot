import { BotConfig } from "../config";
import { randomUUID } from "node:crypto";
import { Logger } from "../logger";
import { PlaceOrderPayload, RevXClient, RevXHttpError } from "../revx/RevXClient";
import { orderSubmitState } from "../recon/OrderSubmitState";
import { BotEventType, OrderRecord, Side, Store } from "../store/Store";
import { sleep } from "../util/time";
import { makeClientOrderId, makeRunId } from "../util/uuid";

const VENUE_ACK_TIMEOUT_MS = 3_000;
const VENUE_ACK_POLL_MS = 250;
const NO_ACK_RETRY_MAX = 1;

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
    const endpoint = "POST /api/1.0/orders";
    const payloadSummary = this.makeSubmitPayloadSummary({
      clientOrderId,
      symbol: params.symbol,
      side: params.side,
      type: "limit",
      price: workingPrice,
      quoteSize,
      executionInstructions: ["post_only"]
    });
    const minVenueNotionalUsd = resolveMinVenueNotionalUsd(this.config);
    try {
      assertValidQuoteSize({
        quoteSizeUsd: quoteSize,
        minNotionalUsd: minVenueNotionalUsd,
        symbol: params.symbol,
        side: params.side
      });
    } catch (error) {
      this.recordSubmitFailure({
        endpoint,
        payloadSummary,
        error
      });
      throw error;
    }
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
    let noAckRetriesUsed = 0;
    const maxPlaceRetries = Math.max(this.config.placeRetry, NO_ACK_RETRY_MAX);
    for (let attempt = 0; attempt <= maxPlaceRetries; attempt += 1) {
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
        let venueOrderId = pickString(raw, ["venue_order_id", "venueOrderId", "order_id", "orderId", "id"]);
        let status = normalizeOrderStatus(pickString(raw, ["state", "status", "order_status"]) || "NEW");
        if (!venueOrderId) {
          if (noAckRetriesUsed === 0) {
            this.logger.warn(
              {
                clientOrderId,
                symbol: params.symbol,
                side: params.side,
                responseBody: raw
              },
              "Order submit response missing venueOrderId"
            );
          }
          const ack = await this.awaitVenueAck(params.symbol, clientOrderId, VENUE_ACK_TIMEOUT_MS);
          if (ack?.venueOrderId) {
            venueOrderId = ack.venueOrderId;
            status = normalizeOrderStatus(ack.status ?? status);
          } else {
            if (noAckRetriesUsed < NO_ACK_RETRY_MAX && attempt < maxPlaceRetries) {
              noAckRetriesUsed += 1;
              this.logger.warn(
                { clientOrderId, symbol: params.symbol, side: params.side, timeoutMs: VENUE_ACK_TIMEOUT_MS },
                "No venue ack after submit; retrying once"
              );
              continue;
            }
            this.store.upsertOrder({
              client_order_id: clientOrderId,
              bot_tag: params.botTag,
              symbol: params.symbol,
              side: params.side,
              price: workingPrice,
              quote_size: quoteSize,
              status: "FAILED",
              last_seen_status: "FAILED",
              is_bot: 1
            });
            this.recordBotEvent({
              type: "ERROR",
              side: params.side,
              price: workingPrice,
              quoteSizeUsd: quoteSize,
              venueOrderId: null,
              clientOrderId,
              reason: "NO_VENUE_ACK_WITHIN_TIMEOUT",
              botTag: params.botTag
            });
            this.recordSubmitFailure({
              endpoint,
              payloadSummary,
              error: new Error("NO_VENUE_ACK_WITHIN_TIMEOUT")
            });
            throw new Error(
              `No venue ack for ${clientOrderId} within ${VENUE_ACK_TIMEOUT_MS}ms after submit retry`
            );
          }
        }

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
        this.logger.info(
          {
            event: "ORDER",
            action: "PLACED",
            symbol: params.symbol,
            side: params.side,
            price: workingPrice,
            quoteSizeUsd: quoteSize,
            clientOrderId,
            venueOrderId,
            botTag: params.botTag
          },
          `REVX_ORDER action=PLACED side=${params.side} symbol=${params.symbol} price=${workingPrice.toFixed(2)} size=${quoteSize.toFixed(2)} venueOrderId=${String(venueOrderId || "-")} clientOrderId=${clientOrderId}`
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
        this.recordSubmitSuccess({
          endpoint,
          payloadSummary,
          httpStatus: 200,
          responseBody: {
            venue_order_id: venueOrderId || null,
            status
          }
        });

        return { clientOrderId, venueOrderId };
      } catch (error) {
        const existingLocal = this.store.getOrderByClientId(clientOrderId);
        if (existingLocal?.venue_order_id) {
          return { clientOrderId, venueOrderId: existingLocal.venue_order_id };
        }
        const existingVenue = await this.findVenueOrderByClientId(params.symbol, clientOrderId);
        if (existingVenue?.venueOrderId) {
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

        if (isRetryableExecutionError(error) && attempt < maxPlaceRetries) {
          const backoffMs = Math.min(400 * 2 ** attempt + jitter(150), 4_000);
          this.logger.warn(
            { attempt: attempt + 1, maxRetries: maxPlaceRetries, backoffMs, clientOrderId },
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
        this.recordSubmitFailure({
          endpoint,
          payloadSummary,
          httpStatus: error instanceof RevXHttpError ? error.status : null,
          responseBody: error instanceof RevXHttpError ? error.responseBody : null,
          error
        });
        throw error;
      }
    }

    throw new Error("unreachable place retry loop");
  }

  async placeSeedTakerIocOrder(params: {
    symbol: string;
    side: Side;
    price: number;
    quoteSizeUsd: number;
    botTag?: string | null;
    reason?: string;
  }): Promise<{ clientOrderId: string; venueOrderId?: string; status: string }> {
    const clientOrderId = makeClientOrderId(this.runId);
    const quoteSize = roundUsd(params.quoteSizeUsd);
    const price = roundPrice(params.price);
    const endpoint = "POST /api/1.0/orders";
    const payloadSummary = this.makeSubmitPayloadSummary({
      clientOrderId,
      symbol: params.symbol,
      side: params.side,
      type: "limit",
      price,
      quoteSize,
      executionInstructions: ["immediate_or_cancel"]
    });
    const minVenueNotionalUsd = resolveMinVenueNotionalUsd(this.config);
    try {
      assertValidQuoteSize({
        quoteSizeUsd: quoteSize,
        minNotionalUsd: minVenueNotionalUsd,
        symbol: params.symbol,
        side: params.side
      });
    } catch (error) {
      this.recordSubmitFailure({
        endpoint,
        payloadSummary,
        error
      });
      throw error;
    }
    const botTag = params.botTag ?? "seed-taker";
    const reason = String(params.reason ?? "SEED_TAKER_IOC").trim() || "SEED_TAKER_IOC";

    this.store.upsertOrder({
      client_order_id: clientOrderId,
      bot_tag: botTag,
      symbol: params.symbol,
      side: params.side,
      price,
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
          price,
          quoteSize,
          clientOrderId
        },
        "DRY_RUN place seed taker IOC order"
      );
      return {
        clientOrderId,
        status: "DRY_RUN_NEW"
      };
    }

    const payload: PlaceOrderPayload = {
      client_order_id: clientOrderId,
      symbol: params.symbol,
      side: params.side.toLowerCase() as "buy" | "sell",
      type: "limit",
      order_configuration: {
        limit: {
          quote_size: quoteSize.toFixed(2),
          price: price.toFixed(2),
          execution_instructions: ["immediate_or_cancel"]
        }
      }
    };

    try {
      const raw = (await this.client.placeOrder(payload)) as Record<string, unknown>;
      const venueOrderId = pickString(raw, ["venue_order_id", "venueOrderId", "order_id", "orderId", "id"]);
      const status = normalizeOrderStatus(pickString(raw, ["state", "status", "order_status"]) || "NEW");
      this.store.upsertOrder({
        client_order_id: clientOrderId,
        venue_order_id: venueOrderId,
        bot_tag: botTag,
        symbol: params.symbol,
        side: params.side,
        price,
        quote_size: quoteSize,
        status,
        last_seen_status: status,
        is_bot: 1
      });
      this.recordBotEvent({
        type: "PLACED",
        side: params.side,
        price,
        quoteSizeUsd: quoteSize,
        venueOrderId: venueOrderId || null,
        clientOrderId,
        reason,
        botTag
      });
      this.logger.info(
        {
          side: params.side,
          symbol: params.symbol,
          price,
          quoteSize,
          clientOrderId,
          venueOrderId,
          status
        },
        "Placed seed taker IOC order"
      );
      this.recordSubmitSuccess({
        endpoint,
        payloadSummary,
        httpStatus: 200,
        responseBody: {
          venue_order_id: venueOrderId || null,
          status
        }
      });
      return { clientOrderId, venueOrderId, status };
    } catch (error) {
      this.store.upsertOrder({
        client_order_id: clientOrderId,
        bot_tag: botTag,
        symbol: params.symbol,
        side: params.side,
        price,
        quote_size: quoteSize,
        status: "REJECTED",
        last_seen_status: "REJECTED",
        is_bot: 1
      });
      this.recordBotEvent({
        type: error instanceof RevXHttpError && error.status >= 400 && error.status < 500 ? "REJECTED" : "ERROR",
        side: params.side,
        price,
        quoteSizeUsd: quoteSize,
        venueOrderId: null,
        clientOrderId,
        reason: error instanceof Error ? `${reason}: ${error.message}` : `${reason}: PLACE_FAILED`,
        botTag
      });
      this.recordSubmitFailure({
        endpoint,
        payloadSummary,
        httpStatus: error instanceof RevXHttpError ? error.status : null,
        responseBody: error instanceof RevXHttpError ? error.responseBody : null,
        error
      });
      throw error;
    }
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
        this.logger.info(
          {
            event: "ORDER",
            action: "CANCELLED",
            symbol: existing?.symbol ?? this.config.symbol,
            side: existing?.side ?? "-",
            venueOrderId,
            clientOrderId: existing?.client_order_id ?? null
          },
          `REVX_ORDER action=CANCELLED side=${String(existing?.side ?? "-")} symbol=${String(existing?.symbol ?? this.config.symbol)} price=${Number(existing?.price ?? 0).toFixed(2)} size=${Number(existing?.quote_size ?? 0).toFixed(2)} venueOrderId=${venueOrderId} clientOrderId=${String(existing?.client_order_id ?? "-")}`
        );
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
            this.logger.info(
              {
                event: "ORDER",
                action: "CANCELLED",
                symbol: existing?.symbol ?? this.config.symbol,
                side: existing?.side ?? "-",
                venueOrderId,
                clientOrderId: existing?.client_order_id ?? null
              },
              `REVX_ORDER action=CANCELLED side=${String(existing?.side ?? "-")} symbol=${String(existing?.symbol ?? this.config.symbol)} price=${Number(existing?.price ?? 0).toFixed(2)} size=${Number(existing?.quote_size ?? 0).toFixed(2)} venueOrderId=${venueOrderId} clientOrderId=${String(existing?.client_order_id ?? "-")}`
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
            this.logger.info(
              {
                event: "ORDER",
                action: "CANCELLED",
                symbol: existing?.symbol ?? this.config.symbol,
                side: existing?.side ?? "-",
                venueOrderId,
                clientOrderId: existing?.client_order_id ?? null
              },
              `REVX_ORDER action=CANCELLED side=${String(existing?.side ?? "-")} symbol=${String(existing?.symbol ?? this.config.symbol)} price=${Number(existing?.price ?? 0).toFixed(2)} size=${Number(existing?.quote_size ?? 0).toFixed(2)} venueOrderId=${venueOrderId} clientOrderId=${String(existing?.client_order_id ?? "-")}`
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
        if (pickString(obj, ["client_order_id", "clientOrderId"]) !== clientOrderId) continue;
        const venueOrderId = pickString(obj, ["venue_order_id", "venueOrderId", "order_id", "orderId", "id"]);
        if (!venueOrderId) continue;
        return { venueOrderId, status: pickString(obj, ["state", "status", "order_status"]) };
      }
    } catch (error) {
      this.logger.debug({ error, clientOrderId }, "findVenueOrderByClientId failed");
    }
    return null;
  }

  private async awaitVenueAck(
    symbol: string,
    clientOrderId: string,
    timeoutMs: number
  ): Promise<{ venueOrderId: string; status?: string } | null> {
    const deadline = Date.now() + Math.max(250, timeoutMs);
    while (Date.now() <= deadline) {
      const existingLocal = this.store.getOrderByClientId(clientOrderId);
      if (existingLocal?.venue_order_id) {
        return {
          venueOrderId: existingLocal.venue_order_id,
          status: existingLocal.status
        };
      }
      const existingVenue = await this.findVenueOrderByClientId(symbol, clientOrderId);
      if (existingVenue?.venueOrderId) {
        return existingVenue;
      }
      await sleep(VENUE_ACK_POLL_MS);
    }
    return null;
  }

  private makeSubmitPayloadSummary(input: {
    clientOrderId: string;
    symbol: string;
    side: Side;
    type: string;
    price: number;
    quoteSize: number;
    executionInstructions: string[];
  }): {
    clientOrderId: string;
    symbol: string;
    side: string;
    type: string;
    price: number;
    quoteSize: number;
    executionInstructions: string[];
  } {
    return {
      clientOrderId: String(input.clientOrderId),
      symbol: String(input.symbol),
      side: String(input.side),
      type: String(input.type),
      price: Number.isFinite(Number(input.price)) ? Number(input.price) : 0,
      quoteSize: Number.isFinite(Number(input.quoteSize)) ? Number(input.quoteSize) : 0,
      executionInstructions: Array.isArray(input.executionInstructions)
        ? input.executionInstructions.map((row) => String(row))
        : []
    };
  }

  private recordSubmitSuccess(input: {
    endpoint: string;
    payloadSummary: {
      clientOrderId: string;
      symbol: string;
      side: string;
      type: string;
      price: number;
      quoteSize: number;
      executionInstructions: string[];
    };
    httpStatus?: number | null;
    responseBody?: unknown;
  }): void {
    orderSubmitState.markSuccess({
      endpoint: input.endpoint,
      payloadSummary: input.payloadSummary,
      httpStatus: input.httpStatus,
      responseBody: input.responseBody
    });
  }

  private recordSubmitFailure(input: {
    endpoint: string;
    payloadSummary: {
      clientOrderId: string;
      symbol: string;
      side: string;
      type: string;
      price: number;
      quoteSize: number;
      executionInstructions: string[];
    };
    httpStatus?: number | null;
    responseBody?: unknown;
    error: unknown;
  }): void {
    orderSubmitState.markFailure({
      endpoint: input.endpoint,
      payloadSummary: input.payloadSummary,
      httpStatus: input.httpStatus,
      responseBody: input.responseBody,
      error: input.error
    });
    this.logger.error(
      {
        endpoint: input.endpoint,
        payloadSummary: input.payloadSummary,
        httpStatus: input.httpStatus ?? null,
        responseBody: input.responseBody ?? null,
        error:
          input.error instanceof Error
            ? {
                message: input.error.message,
                stack: input.error.stack || ""
              }
            : String(input.error ?? "")
      },
      "Order submit failed"
    );
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

function resolveMinVenueNotionalUsd(config: BotConfig): number {
  const configured = Number(config.minQuoteSizeUsd);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 0.01;
}

function assertValidQuoteSize(params: {
  quoteSizeUsd: number;
  minNotionalUsd: number;
  symbol: string;
  side: Side;
}): void {
  const quoteSizeUsd = Number(params.quoteSizeUsd);
  const minNotionalUsd = Math.max(0.01, Number(params.minNotionalUsd) || 0);
  if (!Number.isFinite(quoteSizeUsd) || quoteSizeUsd <= 0) {
    throw new Error(
      `Invalid quote size for ${params.symbol} ${params.side}: quoteSizeUsd=${String(params.quoteSizeUsd)}`
    );
  }
  if (quoteSizeUsd + 1e-9 < minNotionalUsd) {
    throw new Error(
      `Quote size below venue minimum notional for ${params.symbol} ${params.side}: quoteSizeUsd=${quoteSizeUsd.toFixed(2)} minNotionalUsd=${minNotionalUsd.toFixed(2)}`
    );
  }
}
