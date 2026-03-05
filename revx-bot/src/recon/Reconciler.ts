import { BotConfig } from "../config";
import { randomUUID } from "node:crypto";
import { Logger } from "../logger";
import { MarketData } from "../md/MarketData";
import { FifoPnlEstimator } from "../metrics/PnL";
import { RevXClient, RevXDegradedError, RevXFill, RevXHttpError, RevXOrder } from "../revx/RevXClient";
import { ParsedBalancesPayload, findAsset, parseBalancesPayload } from "./balanceParsing";
import { FillRecord, OrderRecord, ReconcilerState, Side, Store } from "../store/Store";
import { BalanceState } from "./BalanceState";
import { NormalizedVenueActiveOrder, orderReconcileState } from "./OrderReconcileState";
import type { PerformanceEngine } from "../performance/PerformanceEngine";

type ParsedOrder = {
  clientOrderId: string;
  venueOrderId: string;
  symbol: string;
  side: Side | null;
  price: number;
  quoteSize: number;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private statusPollTimer: NodeJS.Timeout | null = null;
  private latestState: ReconcilerState | null = null;
  private estimatorHydrated = false;
  private balanceDiagnosticsLogged = false;
  private runningScheduledReconcile = false;
  private runningStatusPoll = false;
  private runningBalanceRefresh = false;
  private runningReconcileOnce = false;
  private runningReconcileOnceStartedTs = 0;
  private runningReconcileOnceId = "";
  private firstBalanceAttemptPromise: Promise<void> | null = null;
  private pendingWatchdogStartedTs = 0;
  private readonly orderStatusMisses = new Map<string, number>();
  private readonly pnlEstimator = new FifoPnlEstimator();
  private lastBalanceTotals: { usdTotal: number; btcTotal: number; ts: number } | null = null;
  private inferredFillSeq = 0;
  private fillsReconcileDisabledUsingBalanceDeltaLogged = false;
  private fillsReconcileSkipWarned = false;
  private readonly debugRecon =
    process.env.DEBUG_RECON === "1" || process.env.DEBUG === "1";

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly client: RevXClient,
    private readonly store: Store,
    private readonly marketData?: MarketData,
    private readonly performanceEngine?: PerformanceEngine
  ) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = Math.max(1, this.config.reconcileSeconds) * 1000;
    const statusPollMs = Math.min(2_000, Math.max(1_000, Math.floor(this.config.refreshSeconds * 1000)));
    this.clearPendingLocalOrdersAtStartup();
    void this.client
      .initializeTradesEndpointCapability()
      .then(() => {
        const mode = this.client.getFillsReconcileMode();
        this.logger.info(
          {
            fillsEndpoint: mode.fillsEndpoint ?? "NONE",
            fillsReconcile: mode.fillsReconcile
          },
          "RevX reconcile mode"
        );
      })
      .catch((error) => {
        this.logger.warn({ error }, "Failed to initialize RevX trades endpoint capability");
      });
    this.firstBalanceAttemptPromise = this.refreshBalances("startup");
    this.timer = setInterval(() => {
      void this.runScheduledReconcile().catch((error) => {
        this.logger.error({ error }, "Reconcile loop error");
      });
    }, intervalMs);
    this.statusPollTimer = setInterval(() => {
      void this.pollActiveOrderStatuses().catch((error) => {
        this.logger.warn({ error }, "Order status poll loop error");
      });
    }, statusPollMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
    this.runningScheduledReconcile = false;
    this.runningStatusPoll = false;
  }

  getLatestState(): ReconcilerState | null {
    if (this.latestState) return this.latestState;
    const persisted = this.store.getReconcilerState();
    if (persisted) {
      this.latestState = persisted;
    }
    return this.latestState;
  }

  async awaitFirstBalanceAttempt(): Promise<void> {
    if (!this.firstBalanceAttemptPromise) {
      this.firstBalanceAttemptPromise = this.refreshBalances("startup");
    }
    await this.firstBalanceAttemptPromise;
    await BalanceState.waitForFirstFetchAttempt();
  }

  async refreshBalancesNow(
    trigger: "manual" | "insufficient_balance" = "manual",
    traceId?: string
  ): Promise<void> {
    if (this.runningBalanceRefresh) return;
    this.runningBalanceRefresh = true;
    try {
      await this.refreshBalances(trigger, traceId);
    } finally {
      this.runningBalanceRefresh = false;
    }
  }

  async reconcileOnce(): Promise<void> {
    const requestedReconcileId = randomUUID().slice(0, 8);
    if (this.runningReconcileOnce) {
      const ageMs =
        this.runningReconcileOnceStartedTs > 0
          ? Math.max(0, Date.now() - this.runningReconcileOnceStartedTs)
          : 0;
      if (this.debugRecon) {
        this.logger.debug(
          {
            reconcileId: requestedReconcileId,
            inFlightReconcileId: this.runningReconcileOnceId || undefined,
            ageMs
          },
          "reconcile_inflight_skip"
        );
      }
      return;
    }
    this.runningReconcileOnce = true;
    this.runningReconcileOnceStartedTs = Date.now();
    this.runningReconcileOnceId = requestedReconcileId;
    try {
    const reconcileId = requestedReconcileId;
    const traceId = reconcileId;
    const reconcileStartedMs = Date.now();
    const logStage = (stageName: string, stageStartedMs: number, details: Record<string, unknown> = {}): void => {
      if (!this.debugRecon) return;
      const durationMs = Math.max(0, Date.now() - stageStartedMs);
      this.logger.info(
        {
          reconcileId,
          stageName,
          durationMs,
          ...details
        },
        "Reconcile stage timing"
      );
    };

    const refreshBalancesStartedMs = Date.now();
    await this.refreshBalancesNow("manual", traceId);
    logStage("refreshBalancesNow", refreshBalancesStartedMs, { trigger: "manual", traceId });
    const now = Date.now();
    const pendingStaleMs = 5_000;

    if (!this.estimatorHydrated) {
      const historical = this.store.getRecentFills(10_000).sort((a, b) => a.ts - b.ts);
      for (const fill of historical) {
        this.pnlEstimator.apply({
          fill,
          side: this.store.getOrderByVenueId(fill.venue_order_id)?.side ?? null
        });
      }
      this.estimatorHydrated = true;
    }

    const knownBotByClient = new Map(
      this.store.getRecentBotOrders(8_000).map((order) => [order.client_order_id, order] as const)
    );

    const activeOrdersByTag: Record<string, ReturnType<typeof toOrderRecord>> = {};
    const activeVenueOrderIds = new Set<string>();
    const venueOpenKeys = new Set<string>();
    const venueActiveNormalized: NormalizedVenueActiveOrder[] = [];
    let venueFetchOk = true;
    let activeOrders: RevXOrder[] = [];
    const getActiveOrdersStartedMs = Date.now();
    try {
      activeOrders = await this.client.getActiveOrders(this.config.symbol, { traceId });
      logStage("getActiveOrders", getActiveOrdersStartedMs, {
        symbol: this.config.symbol,
        openOrdersCount: activeOrders.length,
        venueFetchOk: true
      });
    } catch (error) {
      if (error instanceof RevXDegradedError) {
        venueFetchOk = false;
        this.logger.warn(
          { endpoint: error.endpoint, openUntilMs: error.openUntilMs },
          "RevX degraded; using locally known active orders"
        );
        const fallbackActiveOrders = this.store.getActiveOrders(this.config.symbol);
        for (const fallback of fallbackActiveOrders) {
          if (fallback.venue_order_id) {
            activeVenueOrderIds.add(fallback.venue_order_id);
            venueOpenKeys.add(orderVenueKey(fallback.venue_order_id));
          }
          venueOpenKeys.add(orderClientKey(fallback.client_order_id));
          venueActiveNormalized.push(normalizeVenueActiveFromLocal(fallback));
          if (fallback.is_bot === 1 && fallback.bot_tag && fallback.venue_order_id) {
            activeOrdersByTag[fallback.bot_tag] = toOrderRecord({
              clientOrderId: fallback.client_order_id,
              venueOrderId: fallback.venue_order_id,
              botTag: fallback.bot_tag,
              symbol: fallback.symbol,
              side: fallback.side,
              price: fallback.price,
              quoteSize: fallback.quote_size,
              status: fallback.status,
              isBot: fallback.is_bot,
              createdAt: fallback.created_at,
              updatedAt: fallback.updated_at
            });
          }
        }
        logStage("getActiveOrders", getActiveOrdersStartedMs, {
          symbol: this.config.symbol,
          openOrdersCount: 0,
          fallbackActiveOrdersCount: fallbackActiveOrders.length,
          venueFetchOk: false,
          degraded: true
        });
      } else {
        logStage("getActiveOrders", getActiveOrdersStartedMs, {
          symbol: this.config.symbol,
          openOrdersCount: 0,
          venueFetchOk: false,
          errored: true,
          errorType: error instanceof Error ? error.name : typeof error
        });
        throw error;
      }
    }

    for (const raw of activeOrders) {
      const parsed = parseOrder(raw as Record<string, unknown>, now);
      if (!parsed.clientOrderId || !parsed.side || !parsed.symbol) continue;
      if (parsed.venueOrderId) {
        activeVenueOrderIds.add(parsed.venueOrderId);
        venueOpenKeys.add(orderVenueKey(parsed.venueOrderId));
      }
      venueOpenKeys.add(orderClientKey(parsed.clientOrderId));

      const known =
        knownBotByClient.get(parsed.clientOrderId) ??
        this.store.getOrderByClientId(parsed.clientOrderId);
      const isBot = known?.is_bot ?? 0;
      const botTag = known?.bot_tag ?? null;

      this.store.upsertOrder({
        client_order_id: parsed.clientOrderId,
        venue_order_id: parsed.venueOrderId,
        bot_tag: botTag,
        symbol: parsed.symbol,
        side: parsed.side,
        price: parsed.price,
        quote_size: parsed.quoteSize,
        status: parsed.status,
        last_seen_status: parsed.status,
        is_bot: isBot,
        created_at: parsed.createdAt,
        updated_at: parsed.updatedAt
      });

      if (isBot === 1 && botTag && isActiveStatus(parsed.status)) {
        activeOrdersByTag[botTag] = toOrderRecord({
          ...parsed,
          side: parsed.side as Side,
          botTag,
          isBot
        });
      }

      venueActiveNormalized.push({
        clientOrderId: parsed.clientOrderId,
        venueOrderId: parsed.venueOrderId || null,
        symbol: parsed.symbol,
        side: String((parsed.side as Side | null) ?? known?.side ?? "").toUpperCase() || "-",
        price: Number.isFinite(parsed.price) && parsed.price > 0 ? parsed.price : known?.price ?? 0,
        quoteSize:
          Number.isFinite(parsed.quoteSize) && parsed.quoteSize > 0 ? parsed.quoteSize : known?.quote_size ?? 0,
        status: parsed.status || known?.status || "OPEN",
        createdTs:
          Number.isFinite(parsed.createdAt) && parsed.createdAt > 0 ? parsed.createdAt : known?.created_at ?? now,
        updatedTs:
          Number.isFinite(parsed.updatedAt) && parsed.updatedAt > 0 ? parsed.updatedAt : known?.updated_at ?? now
      });
    }

    const reconcileStats = this.reconcileLocalActiveBotOrders({
      nowTs: now,
      venueOpenKeys,
      pendingStaleMs,
      venueFetchOk
    });

    const recentBotOrders = this.store.getRecentBotOrders(300);
    const nonTerminalPrioritizedStatuses = new Set([
      "OPEN",
      "NEW",
      "PARTIALLY_FILLED",
      "PARTIAL_FILLED",
      "PENDING",
      "PENDING_NEW",
      "UNKNOWN"
    ]);
    const terminalStatuses = new Set([
      "FILLED",
      "CANCELLED",
      "CANCELED",
      "REJECTED",
      "FAILED",
      "INACTIVE",
      "INACTIVE_DUPLICATE",
      "EXPIRED"
    ]);
    const updatedWithinWindowMs = 6 * 60 * 60 * 1000;
    const updatedCutoffTs = now - updatedWithinWindowMs;
    const maxOrdersPerReconcile = 30;
    const candidateOrders = recentBotOrders
      .filter((order) => String(order.venue_order_id || "").trim().length > 0)
      .filter((order) => {
        const normalizedStatus = normalizeOrderStatus(order.status || "UNKNOWN");
        const updatedAtTs = Number.isFinite(Number(order.updated_at)) ? Number(order.updated_at) : 0;
        if (nonTerminalPrioritizedStatuses.has(normalizedStatus)) return true;
        return updatedAtTs >= updatedCutoffTs && !terminalStatuses.has(normalizedStatus);
      })
      .sort((a, b) => {
        const aStatus = normalizeOrderStatus(a.status || "UNKNOWN");
        const bStatus = normalizeOrderStatus(b.status || "UNKNOWN");
        const aPriority = nonTerminalPrioritizedStatuses.has(aStatus) ? 0 : 1;
        const bPriority = nonTerminalPrioritizedStatuses.has(bStatus) ? 0 : 1;
        if (aPriority !== bPriority) return aPriority - bPriority;
        return Number(b.updated_at || 0) - Number(a.updated_at || 0);
      });
    const seenCandidateVenueIds = new Set<string>();
    const reconcileOrders: OrderRecord[] = [];
    for (const order of candidateOrders) {
      const venueOrderId = String(order.venue_order_id || "").trim();
      if (!venueOrderId || seenCandidateVenueIds.has(venueOrderId)) continue;
      seenCandidateVenueIds.add(venueOrderId);
      reconcileOrders.push(order);
      if (reconcileOrders.length >= maxOrdersPerReconcile) break;
    }
    logStage("orderCandidateSelection", reconcileStartedMs, {
      recentBotOrdersCount: recentBotOrders.length,
      candidateOrdersCount: candidateOrders.length,
      selectedOrdersCount: reconcileOrders.length,
      maxOrdersPerReconcile,
      updatedWithinHours: 6
    });
    const seenVenue = new Set<string>();
    const newFills: Array<{ fill: FillRecord; side: Side | null }> = [];
    let skipOrderDetailFetch = false;
    let orderByIdLookupsAttempted = 0;
    let orderByIdLookupsCompleted = 0;
    let fillsLookupsAttempted = 0;
    let cumulativeFetchedFills = 0;
    let getOrderFillsErrorCount = 0;
    const maxGetOrderFillsErrors = 5;
    let stoppedByGetOrderFillsErrorLimit = false;
    let fillsSkippedOrders = 0;
    let fillsSkipEndpointMissing = false;
    let fillsSkipDisabled = false;

    for (let orderIndex = 0; orderIndex < reconcileOrders.length; orderIndex += 1) {
      const order = reconcileOrders[orderIndex];
      const venueOrderId = String(order.venue_order_id || "").trim();
      if (!venueOrderId) continue;
      seenVenue.add(venueOrderId);

      if (!skipOrderDetailFetch && !activeVenueOrderIds.has(venueOrderId)) {
        orderByIdLookupsAttempted += 1;
        const getOrderByIdStartedMs = Date.now();
        try {
          const orderById = (await this.client.getOrderById(venueOrderId, { traceId })) as Record<
            string,
            unknown
          >;
          orderByIdLookupsCompleted += 1;
          logStage("getOrderById", getOrderByIdStartedMs, {
            orderIndex: orderIndex + 1,
            totalOrders: reconcileOrders.length,
            venueOrderId,
            cumulativeLookups: orderByIdLookupsCompleted,
            cumulativeUniqueVenueOrders: seenVenue.size
          });
          const status = normalizeOrderStatus(
            pickString(orderById, ["state", "status"]) || order.status
          );
          this.store.upsertOrder({
            client_order_id: order.client_order_id,
            venue_order_id: venueOrderId,
            bot_tag: order.bot_tag ?? null,
            symbol: order.symbol,
            side: order.side,
            price: order.price,
            quote_size: order.quote_size,
            status,
            last_seen_status: status,
            is_bot: order.is_bot,
            updated_at: now
          });
        } catch (error) {
          if (error instanceof RevXDegradedError) {
            skipOrderDetailFetch = true;
            logStage("getOrderById", getOrderByIdStartedMs, {
              orderIndex: orderIndex + 1,
              totalOrders: reconcileOrders.length,
              venueOrderId,
              cumulativeLookups: orderByIdLookupsCompleted,
              cumulativeUniqueVenueOrders: seenVenue.size,
              degraded: true
            });
            this.logger.warn(
              { endpoint: error.endpoint, openUntilMs: error.openUntilMs },
              "RevX degraded; skipping order-by-id lookups this cycle"
            );
          } else {
            logStage("getOrderById", getOrderByIdStartedMs, {
              orderIndex: orderIndex + 1,
              totalOrders: reconcileOrders.length,
              venueOrderId,
              cumulativeLookups: orderByIdLookupsCompleted,
              cumulativeUniqueVenueOrders: seenVenue.size,
              errored: true,
              errorType: error instanceof Error ? error.name : typeof error
            });
            this.logger.debug({ error, venueOrderId }, "getOrderById failed");
          }
        }
      }

      fillsLookupsAttempted += 1;
      const getOrderFillsStartedMs = Date.now();
      try {
        const fillsResult = await this.client.getOrderFills(venueOrderId, { traceId });
        const fillsMetadata = fillsResult as RevXFill[] & {
          endpointMissing404?: boolean;
          disableFillsReconcile?: boolean;
        };
        if (fillsMetadata.endpointMissing404 || fillsMetadata.disableFillsReconcile) {
          fillsSkippedOrders += 1;
          fillsSkipEndpointMissing = fillsSkipEndpointMissing || fillsMetadata.endpointMissing404 === true;
          fillsSkipDisabled = fillsSkipDisabled || fillsMetadata.disableFillsReconcile === true;
          logStage("getOrderFills", getOrderFillsStartedMs, {
            orderIndex: orderIndex + 1,
            totalOrders: reconcileOrders.length,
            venueOrderId,
            skipped: true,
            endpointMissing404: fillsMetadata.endpointMissing404 === true,
            disableFillsReconcile: fillsMetadata.disableFillsReconcile === true
          });
          continue;
        }
        const fills = fillsResult;
        cumulativeFetchedFills += fills.length;
        let insertedFillsForOrder = 0;
        for (const rawFill of fills) {
          const parsedFill = parseFill(rawFill as Record<string, unknown>, venueOrderId, now);
          if (!parsedFill) continue;

          const midAtFill = this.resolveMidAtFill(order.symbol);
          const edgeBps = computeFillEdgeBps(order.side, parsedFill.price, midAtFill);
          const fill: FillRecord = {
            ...parsedFill,
            mid_at_fill: midAtFill,
            edge_bps: edgeBps
          };

          const inserted = this.store.upsertFill(fill);
          if (inserted) {
            const posture =
              (this.store.getBotStatus()?.quoting &&
              typeof this.store.getBotStatus()?.quoting === "object"
                ? String(
                    (this.store.getBotStatus()?.quoting as Record<string, unknown>).signalsState ??
                      "NORMAL"
                  )
                : "NORMAL") || "NORMAL";
            this.performanceEngine?.recordFill({
              ts: fill.ts,
              symbol: order.symbol,
              side: order.side,
              price: fill.price,
              baseQty: fill.qty,
              feeUsd: fill.fee,
              venueOrderId: fill.venue_order_id,
              clientOrderId: order.client_order_id,
              revxMidAtFill: Number(midAtFill || fill.price),
              posture,
              sourceJson: JSON.stringify(rawFill)
            });
            newFills.push({ fill, side: order.side });
            if (Number.isFinite(order.created_at) && order.created_at > 0) {
              const restingSeconds = Math.max(0, (fill.ts - order.created_at) / 1000);
              this.store.recordMetric({
                ts: fill.ts,
                key: "resting_time_seconds",
                value: restingSeconds
              });
            }
            this.store.recordBotEvent({
              event_id: `${fill.venue_order_id}:${fill.trade_id}`,
              ts: fill.ts,
              type: "FILLED",
              side: order.side,
              price: fill.price,
              quote_size_usd: Math.max(0, fill.qty * fill.price),
              venue_order_id: fill.venue_order_id,
              client_order_id: order.client_order_id,
              reason: `trade ${fill.trade_id}`,
              bot_tag: order.bot_tag ?? "-"
            });
            this.logger.info(
              {
                event: "FILL",
                source: "venue",
                symbol: order.symbol,
                side: order.side,
                venueOrderId: fill.venue_order_id,
                clientOrderId: order.client_order_id,
                tradeId: fill.trade_id,
                price: fill.price,
                qty: fill.qty,
                ts: fill.ts,
                traceId
              },
              `REVX_FILL side=${order.side} symbol=${order.symbol} price=${fill.price.toFixed(2)} size=${fill.qty.toFixed(8)} venueOrderId=${fill.venue_order_id} clientOrderId=${order.client_order_id}`
            );
            this.logger.info(
              {
                event: "ORDER",
                action: "FILLED",
                source: "venue",
                symbol: order.symbol,
                side: order.side,
                price: fill.price,
                qty: fill.qty,
                venueOrderId: fill.venue_order_id,
                clientOrderId: order.client_order_id,
                tradeId: fill.trade_id,
                ts: fill.ts,
                traceId
              },
              `REVX_ORDER action=FILLED side=${order.side} symbol=${order.symbol} price=${fill.price.toFixed(2)} size=${fill.qty.toFixed(8)} venueOrderId=${fill.venue_order_id} clientOrderId=${order.client_order_id}`
            );
            insertedFillsForOrder += 1;
          }
        }
        logStage("getOrderFills", getOrderFillsStartedMs, {
          orderIndex: orderIndex + 1,
          totalOrders: reconcileOrders.length,
          venueOrderId,
          fillsCount: fills.length,
          insertedFills: insertedFillsForOrder,
          cumulativeFetchedFills,
          cumulativeInsertedFills: newFills.length,
          cumulativeUniqueVenueOrders: seenVenue.size
        });
      } catch (error) {
        let errorStatus: number | undefined;
        let errorCode: string | undefined;
        let errorMessage = error instanceof Error ? error.message : String(error);
        if (error instanceof RevXHttpError) {
          errorStatus = error.status;
          if (error.responseBody && typeof error.responseBody === "object") {
            const responseBody = error.responseBody as Record<string, unknown>;
            const codeCandidate =
              responseBody.code ?? responseBody.error_code ?? responseBody.errorCode ?? responseBody.type;
            if (codeCandidate !== undefined && codeCandidate !== null) {
              errorCode = String(codeCandidate);
            }
            const messageCandidate = responseBody.message ?? responseBody.error ?? responseBody.detail;
            if (typeof messageCandidate === "string" && messageCandidate.trim().length > 0) {
              errorMessage = messageCandidate.trim();
            }
          }
        }
        const endpointMissing404 =
          (errorStatus === 404 || errorStatus === 410) &&
          isEndpointMissingErrorMessage(errorMessage);
        getOrderFillsErrorCount += 1;
        logStage("getOrderFills", getOrderFillsStartedMs, {
          orderIndex: orderIndex + 1,
          totalOrders: reconcileOrders.length,
          venueOrderId,
          cumulativeFetchedFills,
          cumulativeInsertedFills: newFills.length,
          cumulativeUniqueVenueOrders: seenVenue.size,
          errored: true,
          errorType: error instanceof Error ? error.name : typeof error,
          errorStatus,
          errorCode,
          errorMessage,
          errorCount: getOrderFillsErrorCount,
          endpointMissing404
        });
        this.logger.warn(
          {
            reconcileId,
            venueOrderId,
            status: errorStatus,
            code: errorCode,
            message: errorMessage,
            errorCount: getOrderFillsErrorCount,
            endpointMissing404
          },
          "getOrderFills failed"
        );
        if (endpointMissing404) {
          this.logger.warn(
            { reconcileId, venueOrderId, status: errorStatus, message: errorMessage },
            "Skipping terminal mark for endpoint-missing getOrderFills 404"
          );
        } else if (errorStatus === 404 || errorStatus === 410) {
          this.markOrderTerminal(order, "FAILED", now);
          this.orderStatusMisses.delete(venueOrderId);
          this.logger.info(
            { reconcileId, venueOrderId, status: errorStatus },
            "Order marked terminal after getOrderFills 404/410"
          );
        }
        if (getOrderFillsErrorCount >= maxGetOrderFillsErrors) {
          stoppedByGetOrderFillsErrorLimit = true;
          this.logger.warn(
            {
              reconcileId,
              errorCount: getOrderFillsErrorCount,
              maxErrors: maxGetOrderFillsErrors,
              processedOrders: orderIndex + 1,
              totalOrders: reconcileOrders.length
            },
            "Stopping reconcile order loop after getOrderFills error limit"
          );
          break;
        }
      }
    }

    for (const entry of newFills) {
      this.pnlEstimator.apply(entry);
    }
    if (fillsSkippedOrders > 0) {
      const payload = {
        reconcileId,
        skippedOrders: fillsSkippedOrders,
        endpointMissing404: fillsSkipEndpointMissing,
        disableFillsReconcile: fillsSkipDisabled
      };
      if (!this.fillsReconcileSkipWarned) {
        this.fillsReconcileSkipWarned = true;
        this.logger.warn(payload, "Fills reconciliation skipped for this cycle");
      } else {
        this.logger.debug(payload, "Fills reconciliation skipped for this cycle");
      }
    }

    const latestBalances = this.store.getLatestBalances();
    const usd = findAsset(latestBalances, ["USD", "USDC"]);
    const btc = findAsset(latestBalances, ["BTC", "XBT"]);
    const snapshotTs = latestBalances.length > 0 ? Math.max(...latestBalances.map((b) => b.ts)) : now;
    const lastFillTs = this.store.getRecentFills(1)[0]?.ts ?? null;

    this.latestState = {
      ts: now,
      balances: {
        usd_free: usd?.free ?? 0,
        usd_total: usd?.total ?? 0,
        btc_free: btc?.free ?? 0,
        btc_total: btc?.total ?? 0,
        snapshot_ts: snapshotTs
      },
      activeOrdersByTag,
      lastFillTs
    };
    this.store.upsertReconcilerState(this.latestState);

    const pnl = this.pnlEstimator.snapshot();
    const rolling = this.store.getRollingMetrics(now);
    const readHealth = this.client.getReadHealth();

    this.store.recordMetric({
      ts: now,
      key: "realized_pnl_usd",
      value: pnl.realizedPnlUsd
    });
    this.store.recordMetric({
      ts: now,
      key: "avg_edge_bps_buy",
      value: pnl.avgEdgeBpsBuy
    });
    this.store.recordMetric({
      ts: now,
      key: "avg_edge_bps_sell",
      value: pnl.avgEdgeBpsSell
    });
    this.store.recordMetric({
      ts: now,
      key: "fills_1h_count",
      value: rolling.fills_last_1h
    });
    this.store.recordMetric({
      ts: now,
      key: "fills_last_1h",
      value: rolling.fills_last_1h
    });
    this.store.recordMetric({
      ts: now,
      key: "fills_last_30m",
      value: rolling.fills_last_30m
    });
    this.store.recordMetric({
      ts: now,
      key: "revx_degraded",
      value: readHealth.degraded ? 1 : 0
    });
    if (readHealth.lastDegradedTs !== null) {
      this.store.recordMetric({
        ts: now,
        key: "revx_last_degraded_ts",
        value: readHealth.lastDegradedTs
      });
    }
    this.store.recordMetric({
      ts: now,
      key: "cancels_1h_count",
      value: rolling.cancels_last_1h
    });
    this.store.recordMetric({
      ts: now,
      key: "cancels_last_1h",
      value: rolling.cancels_last_1h
    });
    this.store.recordMetric({
      ts: now,
      key: "post_only_rejects_last_1h",
      value: rolling.post_only_rejects_last_1h
    });
    this.store.recordMetric({
      ts: now,
      key: "avg_resting_time_seconds",
      value: rolling.avg_resting_time_seconds_last_1h
    });

    this.store.recordMetric({
      ts: now,
      key: "maker_fills_count",
      value: pnl.fillCount
    });

    orderReconcileState.markSuccess({
      ts: now,
      venueFetchOk,
      venueActiveOrders: venueActiveNormalized,
      venueOpenKeys: Array.from(venueOpenKeys),
      localCountBefore: reconcileStats.localCountBefore,
      localCountAfter: reconcileStats.localCountAfter,
      pendingPruned: reconcileStats.pendingPruned,
      dupesRemoved: reconcileStats.dupesRemoved
    });
    logStage("reconcileOnce_total", reconcileStartedMs, {
      openOrdersCount: activeOrders.length,
      recentBotOrdersCount: recentBotOrders.length,
      selectedOrdersCount: reconcileOrders.length,
      uniqueVenueOrdersConsidered: seenVenue.size,
      orderByIdLookupsAttempted,
      orderByIdLookupsCompleted,
      fillsLookupsAttempted,
      fillsSkippedOrders,
      fillsSkipEndpointMissing,
      fillsSkipDisabled,
      getOrderFillsErrorCount,
      stoppedByGetOrderFillsErrorLimit,
      cumulativeFetchedFills,
      newFillsCount: newFills.length
    });
    } finally {
      this.runningReconcileOnce = false;
      this.runningReconcileOnceStartedTs = 0;
      this.runningReconcileOnceId = "";
    }
  }

  private async runScheduledReconcile(): Promise<void> {
    if (this.runningScheduledReconcile) return;
    this.runningScheduledReconcile = true;
    try {
      await this.reconcileOnce();
    } catch (error) {
      orderReconcileState.markError(error, Date.now());
      throw error;
    } finally {
      this.runningScheduledReconcile = false;
    }
  }

  private async pollActiveOrderStatuses(): Promise<void> {
    if (this.runningStatusPoll) return;
    this.runningStatusPoll = true;
    const nowTs = Date.now();
    try {
      const active = this.store.getActiveBotOrders(this.config.symbol);
      if (active.length === 0) {
        this.orderStatusMisses.clear();
        return;
      }
      const seenActiveVenueIds = new Set<string>();
      const unknownVenueIds = new Set<string>();
      for (const order of active) {
        const venueOrderId = String(order.venue_order_id || "").trim();
        if (!venueOrderId) continue;
        seenActiveVenueIds.add(venueOrderId);
        try {
          const raw = (await this.client.getOrderById(venueOrderId)) as Record<string, unknown>;
          const status = normalizeOrderStatus(
            pickString(raw, ["state", "status", "order_status"]) || order.status || "NEW"
          );
          this.orderStatusMisses.delete(venueOrderId);
          this.store.upsertOrder({
            client_order_id: order.client_order_id,
            venue_order_id: venueOrderId,
            bot_tag: order.bot_tag ?? null,
            symbol: order.symbol,
            side: order.side,
            price: Number.isFinite(order.price) ? order.price : 0,
            quote_size: Number.isFinite(order.quote_size) ? order.quote_size : 0,
            status,
            last_seen_status: status,
            is_bot: order.is_bot,
            created_at: order.created_at,
            updated_at: nowTs
          });
        } catch (error) {
          if (error instanceof RevXDegradedError) {
            orderReconcileState.markReconcileError(error, nowTs);
            continue;
          }
          if (error instanceof RevXHttpError && error.status === 404) {
            const misses = (this.orderStatusMisses.get(venueOrderId) ?? 0) + 1;
            this.orderStatusMisses.set(venueOrderId, misses);
            if (misses >= 3) {
              unknownVenueIds.add(venueOrderId);
              this.markOrderTerminal(order, "UNKNOWN", nowTs);
            }
            continue;
          }
          orderReconcileState.markReconcileError(error, nowTs);
        }
      }

      // Clean miss counters for orders no longer active.
      for (const key of Array.from(this.orderStatusMisses.keys())) {
        if (!seenActiveVenueIds.has(key)) {
          this.orderStatusMisses.delete(key);
        }
      }

      if (unknownVenueIds.size > 0) {
        try {
          const openOrders = await this.client.getActiveOrders(this.config.symbol);
          const openVenueIds = new Set<string>();
          for (const row of openOrders) {
            const raw = row as Record<string, unknown>;
            const venueOrderId = pickString(raw, [
              "venue_order_id",
              "venueOrderId",
              "order_id",
              "orderId",
              "id"
            ]);
            if (!venueOrderId) continue;
            openVenueIds.add(venueOrderId);
            const existing = this.store.getOrderByVenueId(venueOrderId);
            if (!existing) continue;
            const status = normalizeOrderStatus(
              pickString(raw, ["state", "status", "order_status"]) || existing.status || "NEW"
            );
            this.store.upsertOrder({
              client_order_id: existing.client_order_id,
              venue_order_id: venueOrderId,
              bot_tag: existing.bot_tag ?? null,
              symbol: existing.symbol,
              side: existing.side,
              price: existing.price,
              quote_size: existing.quote_size,
              status,
              last_seen_status: status,
              is_bot: existing.is_bot,
              created_at: existing.created_at,
              updated_at: nowTs
            });
            this.orderStatusMisses.delete(venueOrderId);
          }

          for (const venueOrderId of unknownVenueIds) {
            if (openVenueIds.has(venueOrderId)) continue;
            const existing = this.store.getOrderByVenueId(venueOrderId);
            if (!existing) continue;
            this.markOrderTerminal(existing, "UNKNOWN", nowTs);
          }
        } catch (error) {
          orderReconcileState.markReconcileError(error, nowTs);
        }
      }
    } finally {
      this.runningStatusPoll = false;
    }
  }

  private async refreshBalances(
    trigger: "startup" | "reconcile" | "manual" | "insufficient_balance",
    traceId?: string
  ): Promise<void> {
    const fetchTs = Date.now();
    try {
      const balancesRaw = await this.client.getBalances({ traceId });
      const parsedBalances: ParsedBalancesPayload = parseBalancesPayload(balancesRaw, fetchTs);
      BalanceState.markFetchSuccess({
        normalizedBalances: parsedBalances.snapshots,
        diagnostics: parsedBalances.diagnostics,
        ts: fetchTs
      });

      if (this.config.debugBalances && !this.balanceDiagnosticsLogged) {
        this.logger.info(
          {
            assets: parsedBalances.diagnostics.map((row) => ({
              asset: row.asset,
              rawAsset: row.rawAsset,
              keys: row.keys,
              available: row.availableRaw,
              free: row.freeRaw,
              tradable: row.tradableRaw,
              balance: row.balanceRaw,
              total: row.totalRaw,
              locked: row.lockedRaw,
              parsedFree: row.parsedFree,
              parsedTotal: row.parsedTotal
            }))
          },
          "Balances assets"
        );
        this.balanceDiagnosticsLogged = true;
      }

      if (parsedBalances.snapshots.length > 0) {
        this.store.insertBalanceSnapshots(parsedBalances.snapshots);
      }

      const usd = findAsset(parsedBalances.snapshots, ["USD", "USDC"]);
      const btc = findAsset(parsedBalances.snapshots, ["BTC", "XBT"]);
      const usdTotal = usd?.total ?? 0;
      const btcTotal = btc?.total ?? 0;
      const fillsMode = this.client.getFillsReconcileMode();
      if (fillsMode.disableFillsReconcile && !this.fillsReconcileDisabledUsingBalanceDeltaLogged) {
        this.fillsReconcileDisabledUsingBalanceDeltaLogged = true;
        this.logger.warn(
          {
            fillsEndpoint: fillsMode.fillsEndpoint ?? "NONE",
            fillsReconcile: fillsMode.fillsReconcile
          },
          "fills_reconcile_disabled_using_balance_delta"
        );
      }
      if (fillsMode.disableFillsReconcile && this.lastBalanceTotals) {
        const deltaUsd = usdTotal - this.lastBalanceTotals.usdTotal;
        const deltaBtc = btcTotal - this.lastBalanceTotals.btcTotal;
        const usdEpsilon = 0.25;
        const btcEpsilon = 0.000001;
        if (Math.abs(deltaUsd) > usdEpsilon && Math.abs(deltaBtc) > btcEpsilon) {
          const side: Side = deltaBtc > 0 ? "BUY" : "SELL";
          const sizeBtc = Math.abs(deltaBtc);
          const inferredPrice = Math.abs(deltaUsd / deltaBtc);
          if (Number.isFinite(inferredPrice) && inferredPrice > 0) {
            this.inferredFillSeq += 1;
            const inferredClientOrderId = `inferred:${fetchTs}:${this.inferredFillSeq}`;
            const inferredVenueOrderId = "inferred-balance-delta";
            const inferredFill: FillRecord = {
              venue_order_id: inferredVenueOrderId,
              trade_id: `inferred:${fetchTs}:${this.inferredFillSeq}`,
              qty: sizeBtc,
              price: inferredPrice,
              fee: 0,
              mid_at_fill: inferredPrice,
              edge_bps: null,
              ts: fetchTs
            };
            const inserted = this.store.upsertFill(inferredFill);
            if (inserted) {
              this.store.recordBotEvent({
                event_id: `${inferredFill.venue_order_id}:${inferredFill.trade_id}`,
                ts: fetchTs,
                type: "FILLED",
                side,
                price: inferredPrice,
                quote_size_usd: Math.abs(deltaUsd),
                venue_order_id: null,
                client_order_id: inferredClientOrderId,
                reason: "INFERRED_BALANCE_DELTA",
                bot_tag: "INFERRED_FILL",
                details_json: JSON.stringify({
                  source: "inferred",
                  symbol: this.config.symbol,
                  side,
                  sizeBTC: sizeBtc,
                  deltaUSD: deltaUsd,
                  deltaBTC: deltaBtc
                })
              });
              this.performanceEngine?.recordFill({
                ts: fetchTs,
                symbol: this.config.symbol,
                side,
                price: inferredPrice,
                baseQty: sizeBtc,
                feeUsd: 0,
                venueOrderId: inferredVenueOrderId,
                clientOrderId: inferredClientOrderId,
                revxMidAtFill: inferredPrice,
                posture: "INFERRED",
                source: "inferred",
                sourceJson: JSON.stringify({
                  source: "inferred",
                  symbol: this.config.symbol,
                  side,
                  sizeBTC: sizeBtc,
                  deltaUSD: deltaUsd,
                  deltaBTC: deltaBtc,
                  venueOrderId: inferredVenueOrderId,
                  clientOrderId: inferredClientOrderId
                })
              });
              this.logger.info(
                {
                  ts: fetchTs,
                  symbol: this.config.symbol,
                  side,
                  sizeBTC: Number(sizeBtc.toFixed(8)),
                  price: Number(inferredPrice.toFixed(2)),
                  deltaUSD: Number(deltaUsd.toFixed(2)),
                  deltaBTC: Number(deltaBtc.toFixed(8)),
                  venueOrderId: inferredVenueOrderId,
                  clientOrderId: inferredClientOrderId,
                  source: "inferred"
                },
                "inferred_fill_detected"
              );
              this.logger.info(
                {
                  event: "FILL",
                  source: "inferred",
                  symbol: this.config.symbol,
                  side,
                  venueOrderId: inferredVenueOrderId,
                  clientOrderId: inferredClientOrderId,
                  tradeId: inferredFill.trade_id,
                  price: inferredPrice,
                  qty: sizeBtc,
                  ts: fetchTs
                },
                `REVX_FILL side=${side} symbol=${this.config.symbol} price=${inferredPrice.toFixed(2)} size=${sizeBtc.toFixed(8)} venueOrderId=${inferredVenueOrderId} clientOrderId=${inferredClientOrderId}`
              );
              this.logger.info(
                {
                  event: "ORDER",
                  action: "FILLED",
                  source: "inferred",
                  symbol: this.config.symbol,
                  side,
                  venueOrderId: inferredVenueOrderId,
                  clientOrderId: inferredClientOrderId,
                  tradeId: inferredFill.trade_id,
                  price: inferredPrice,
                  qty: sizeBtc,
                  ts: fetchTs
                },
                `REVX_ORDER action=FILLED side=${side} symbol=${this.config.symbol} price=${inferredPrice.toFixed(2)} size=${sizeBtc.toFixed(8)} venueOrderId=${inferredVenueOrderId} clientOrderId=${inferredClientOrderId}`
              );
            }
          }
        }
      }
      this.lastBalanceTotals = { usdTotal, btcTotal, ts: fetchTs };
      this.logger.info(
        {
          trigger,
          usdTotal: Number(usdTotal.toFixed(2)),
          btcTotal: Number(btcTotal.toFixed(8))
        },
        `Balances updated: USD=$${usdTotal.toFixed(2)} BTC=${btcTotal.toFixed(8)}`
      );
    } catch (error) {
      BalanceState.markFetchError(error, Date.now());
      this.logger.warn({ trigger, error }, "Balance fetch failed");
    }
  }

  private resolveMidAtFill(symbol: string): number | null {
    const cached = this.marketData?.getCachedMid(symbol) ?? null;
    if (cached && cached > 0) return cached;

    const snapshot = this.store.getRecentTickerSnapshots(symbol, 1)[0];
    if (snapshot && snapshot.mid > 0) return snapshot.mid;

    return null;
  }

  private reconcileLocalActiveBotOrders(params: {
    nowTs: number;
    venueOpenKeys: Set<string>;
    pendingStaleMs: number;
    venueFetchOk: boolean;
  }): {
    localCountBefore: number;
    localCountAfter: number;
    pendingPruned: number;
    dupesRemoved: number;
  } {
    const localActive = this.store
      .getRecentBotOrders(2_000)
      .filter((order) => order.symbol === this.config.symbol)
      .filter((order) => isActiveStatus(order.status))
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
    const localCountBefore = localActive.length;
    let pendingPruned = 0;
    let dupesRemoved = 0;
    const seenKeys = new Set<string>();
    const pendingStillLocal: OrderRecord[] = [];

    for (const order of localActive) {
      const dedupeKey = orderLifecycleKey(order);
      if (!dedupeKey) continue;
      if (seenKeys.has(dedupeKey)) {
        this.markOrderTerminal(order, "INACTIVE_DUPLICATE", params.nowTs);
        dupesRemoved += 1;
        continue;
      }
      seenKeys.add(dedupeKey);

      const isPending = isPendingStatus(order.status);
      if (!isPending) continue;
      const isOpenVenue = isOrderOpenOnVenue(order, params.venueOpenKeys);
      const createdTs = Number.isFinite(Number(order.created_at)) ? Number(order.created_at) : Number(order.updated_at || 0);
      const ageMs = Math.max(0, params.nowTs - Math.max(0, createdTs));
      const lastSeenVenueTs = isOpenVenue ? params.nowTs : 0;
      if (!isOpenVenue && params.venueFetchOk && (ageMs > params.pendingStaleMs || lastSeenVenueTs === 0)) {
        this.markOrderTerminal(order, "FAILED", params.nowTs);
        pendingPruned += 1;
        continue;
      }
      if (!isOpenVenue) pendingStillLocal.push(order);
    }

    if (pendingStillLocal.length > 0) {
      if (this.pendingWatchdogStartedTs <= 0) {
        this.pendingWatchdogStartedTs = params.nowTs;
      }
      const watchdogAgeMs = params.nowTs - this.pendingWatchdogStartedTs;
      if (watchdogAgeMs > Math.max(params.pendingStaleMs * 2, 10_000)) {
        for (const stale of pendingStillLocal) {
          this.markOrderTerminal(stale, "FAILED", params.nowTs);
          pendingPruned += 1;
        }
        this.logger.warn(
          {
            symbol: this.config.symbol,
            pendingCount: pendingStillLocal.length,
            watchdogAgeMs
          },
          "Pending-local watchdog forced cleanup"
        );
        this.pendingWatchdogStartedTs = 0;
      }
    } else {
      this.pendingWatchdogStartedTs = 0;
    }

    const localCountAfter = this.store.getActiveBotOrders(this.config.symbol).length;
    return {
      localCountBefore,
      localCountAfter,
      pendingPruned,
      dupesRemoved
    };
  }

  private markOrderTerminal(order: OrderRecord, status: string, nowTs: number): void {
    const normalized = normalizeOrderStatus(status || "INACTIVE");
    this.store.upsertOrder({
      client_order_id: order.client_order_id,
      venue_order_id: order.venue_order_id,
      bot_tag: order.bot_tag ?? null,
      symbol: order.symbol,
      side: order.side,
      price: order.price,
      quote_size: order.quote_size,
      status: normalized,
      last_seen_status: normalized,
      is_bot: order.is_bot,
      created_at: order.created_at,
      updated_at: nowTs
    });
  }

  private clearPendingLocalOrdersAtStartup(): void {
    const nowTs = Date.now();
    const pendingLocal = this.store
      .getRecentBotOrders(5_000)
      .filter((order) => order.symbol === this.config.symbol)
      .filter((order) => isPendingStatus(order.status))
      .filter((order) => !String(order.venue_order_id || "").trim());
    for (const order of pendingLocal) {
      this.markOrderTerminal(order, "FAILED", nowTs);
    }
    if (pendingLocal.length > 0) {
      this.logger.warn(
        { symbol: this.config.symbol, cleared: pendingLocal.length },
        "Cleared pending-local orders at startup"
      );
    }
  }
}

function toOrderRecord(params: {
  clientOrderId: string;
  venueOrderId: string;
  botTag: string;
  symbol: string;
  side: Side;
  price: number;
  quoteSize: number;
  status: string;
  isBot: number;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    client_order_id: params.clientOrderId,
    venue_order_id: params.venueOrderId,
    bot_tag: params.botTag,
    symbol: params.symbol,
    side: params.side,
    price: params.price,
    quote_size: params.quoteSize,
    status: params.status,
    last_seen_status: params.status,
    is_bot: params.isBot,
    created_at: params.createdAt,
    updated_at: params.updatedAt
  };
}

function parseOrder(raw: Record<string, unknown>, fallbackTs: number): ParsedOrder {
  const clientOrderId = pickString(raw, ["client_order_id", "clientOrderId"]);
  const venueOrderId = pickString(raw, ["venue_order_id", "venueOrderId", "order_id", "orderId", "id"]);
  const symbol = normalizeSymbol(pickString(raw, ["symbol", "pair", "instrument"]));
  const side = parseSide(pickString(raw, ["side"]));
  const price = pickNumber(raw, ["price", "limit_price", "limitPrice"], 0);
  const quoteSize = pickNumber(raw, ["quote_size", "quoteSize", "size", "quote_amount"], 0);
  const status = normalizeOrderStatus(pickString(raw, ["state", "status", "order_status"]) || "UNKNOWN");
  const createdAt = pickTimestamp(raw, ["created_at", "createdAt", "timestamp"], fallbackTs);
  const updatedAt = pickTimestamp(raw, ["updated_at", "updatedAt", "timestamp"], fallbackTs);
  return {
    clientOrderId,
    venueOrderId,
    symbol,
    side,
    price,
    quoteSize,
    status,
    createdAt,
    updatedAt
  };
}

function parseFill(
  raw: Record<string, unknown>,
  fallbackVenueOrderId: string,
  fallbackTs: number
): FillRecord | null {
  const venueOrderId =
    pickString(raw, ["venue_order_id", "order_id", "order", "id"]) || fallbackVenueOrderId;
  const tradeId = pickString(raw, ["trade_id", "id", "fill_id"]);
  if (!venueOrderId || !tradeId) return null;
  return {
    venue_order_id: venueOrderId,
    trade_id: tradeId,
    qty: pickNumber(raw, ["qty", "quantity", "size"], 0),
    price: pickNumber(raw, ["price"], 0),
    fee: pickNumber(raw, ["fee", "fees"], 0),
    ts: pickTimestamp(raw, ["timestamp", "created_at", "ts"], fallbackTs)
  };
}

function computeFillEdgeBps(side: Side, fillPrice: number, midAtFill: number | null): number | null {
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return null;
  if (!midAtFill || !Number.isFinite(midAtFill) || midAtFill <= 0) return null;
  if (side === "BUY") {
    return ((midAtFill - fillPrice) / midAtFill) * 10_000;
  }
  return ((fillPrice - midAtFill) / midAtFill) * 10_000;
}

function parseSide(side: string): Side | null {
  const normalized = side.trim().toUpperCase();
  if (normalized === "BUY") return "BUY";
  if (normalized === "SELL") return "SELL";
  return null;
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase().replace("/", "-");
}

function normalizeOrderStatus(value: string): string {
  return value.trim().toUpperCase();
}

function isActiveStatus(status: string): boolean {
  const normalized = normalizeOrderStatus(status);
  return [
    "NEW",
    "OPEN",
    "PARTIALLY_FILLED",
    "PARTIAL_FILLED",
    "PENDING",
    "PENDING_NEW",
    "ACCEPTED",
    "SUBMITTING"
  ].includes(normalized);
}

function isPendingStatus(status: string): boolean {
  const normalized = normalizeOrderStatus(status);
  return ["PENDING", "PENDING_NEW", "ACCEPTED", "SUBMITTING", "NEW"].includes(normalized);
}

function orderVenueKey(value: string | null | undefined): string {
  const id = String(value || "").trim();
  return id.length > 0 ? `venue:${id}` : "";
}

function orderClientKey(value: string | null | undefined): string {
  const id = String(value || "").trim();
  return id.length > 0 ? `client:${id}` : "";
}

function orderLifecycleKey(order: OrderRecord): string {
  const venueKey = orderVenueKey(order.venue_order_id);
  if (venueKey) return venueKey;
  return orderClientKey(order.client_order_id);
}

function isOrderOpenOnVenue(order: OrderRecord, openKeys: Set<string>): boolean {
  const venueKey = orderVenueKey(order.venue_order_id);
  if (venueKey && openKeys.has(venueKey)) return true;
  const clientKey = orderClientKey(order.client_order_id);
  return clientKey ? openKeys.has(clientKey) : false;
}

function normalizeVenueActiveFromLocal(order: OrderRecord): NormalizedVenueActiveOrder {
  return {
    clientOrderId: String(order.client_order_id || ""),
    venueOrderId: order.venue_order_id ? String(order.venue_order_id) : null,
    symbol: String(order.symbol || ""),
    side: String(order.side || "-").toUpperCase(),
    price: Number.isFinite(Number(order.price)) ? Number(order.price) : 0,
    quoteSize: Number.isFinite(Number(order.quote_size)) ? Number(order.quote_size) : 0,
    status: String(order.status || "").toUpperCase(),
    createdTs: Number.isFinite(Number(order.created_at)) ? Number(order.created_at) : 0,
    updatedTs: Number.isFinite(Number(order.updated_at)) ? Number(order.updated_at) : 0
  };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function pickNumber(obj: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function pickTimestamp(obj: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? value : value * 1000;
    }
    if (typeof value === "string") {
      const asNumber = Number(value);
      if (Number.isFinite(asNumber)) {
        return asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
      }
      const parsedDate = Date.parse(value);
      if (!Number.isNaN(parsedDate)) return parsedDate;
    }
  }
  return fallback;
}

function isEndpointMissingErrorMessage(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("endpoint get") && normalized.includes("not found");
}
