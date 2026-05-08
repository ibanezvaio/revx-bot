import { loadConfig } from "../../config";
import { PolymarketExecution } from "../Execution";
import { computePolymarketEffectiveSizingBasis } from "../sizingMinimums";

type LogEntry = {
  msg: string;
  payload: Record<string, unknown>;
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function makeExecution(configOverrides: Record<string, unknown> = {}): {
  execution: PolymarketExecution;
  logs: LogEntry[];
  client: Record<string, unknown>;
} {
  const base = loadConfig();
  const polymarketOverrides =
    configOverrides.polymarket && typeof configOverrides.polymarket === "object"
      ? (configOverrides.polymarket as Record<string, unknown>)
      : {};
  const restOverrides: Record<string, unknown> = { ...configOverrides };
  delete restOverrides.polymarket;
  const config = {
    ...base,
    ...restOverrides,
    polymarket: {
      ...base.polymarket,
      mode: "paper",
      sizing: {
        ...base.polymarket.sizing,
        maxNotionalPerWindow: 1
      },
      execution: {
        ...base.polymarket.execution,
        takerPriceBuffer: 0.01
      },
      ...polymarketOverrides
    }
  } as any;
  const logs: LogEntry[] = [];
  const logger = {
    info: (payload: Record<string, unknown>, msg: string) => logs.push({ msg, payload }),
    warn: (payload: Record<string, unknown>, msg: string) => logs.push({ msg, payload }),
    error: () => undefined,
    debug: () => undefined
  } as any;
  const client = {
    placeMarketableBuyYes: async () => ({ orderId: "buy-yes-order" }),
    placeMarketableBuyNo: async () => ({ orderId: "buy-no-order" }),
    getOrder: async () => ({ status: "CANCELLED", sizeMatched: 0, price: 0 }),
    cancelOrder: async () => undefined,
    getOpenOrders: async () => [] as Array<Record<string, unknown>>,
    getRecentTrades: async () => [] as Array<Record<string, unknown>>,
    syncOpenOrders: async () => [],
    syncOpenPositions: async () => []
  } as Record<string, unknown>;
  return {
    execution: new PolymarketExecution(config, logger, client as any),
    logs,
    client
  };
}

export async function runPolymarketExecutionSizingTests(): Promise<void> {
  const previousMinVenueShares = process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES;
  const previousConfiguredMinVenueShares = process.env.POLYMARKET_MIN_SHARES_REQUIRED;
  const previousMaxEntryCost = process.env.POLY_LIVE_MAX_ENTRY_COST_USD;
  const previousMinEntryCost = process.env.POLY_LIVE_MIN_ENTRY_COST_USD;
  const previousTargetEntryCost = process.env.POLY_LIVE_TARGET_ENTRY_COST_USD;
  const previousMaxShares = process.env.POLY_MAX_SHARES_PER_ENTRY;
  const previousSizingFeeBufferBps = process.env.POLY_LIVE_SIZING_FEE_BUFFER_BPS;
  const previousAvailableUsd = process.env.POLY_AVAILABLE_USD;
  try {
    process.env.POLY_LIVE_MAX_ENTRY_COST_USD = "3";
    process.env.POLY_LIVE_MIN_ENTRY_COST_USD = "1";
    process.env.POLY_LIVE_TARGET_ENTRY_COST_USD = "2";
    process.env.POLY_MAX_SHARES_PER_ENTRY = "25";
    process.env.POLY_LIVE_SIZING_FEE_BUFFER_BPS = "30";

    // YES side entry price should follow side ask, not 0.99 fallback.
    {
      process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES = "1";
      const { execution, logs } = makeExecution({
        polymarket: {
          sizing: {
            maxNotionalPerWindow: 5
          }
        }
      });
      const result = await execution.executeBuyYes({
        marketId: "m-price",
        tokenId: "yes-token",
        yesAsk: 0.16,
        notionalUsd: 2,
        tickSize: "0.01",
        priceSource: "SIDE_BOOK_LIVE"
      });
      assert(result.accepted === true, "price-source: expected accepted paper fill");
      assert(Number(result.fillPrice || 0) > 0 && Number(result.fillPrice || 0) < 0.3, "price-source: fillPrice should be near ask");
      const plan = logs.find((row) => row.msg === "POLY_V2_ENTRY_PRICE_PLAN");
      assert(Boolean(plan), "price-source: expected POLY_V2_ENTRY_PRICE_PLAN log");
      assert(Number(plan!.payload.chosenPrice || 0) < 0.3, "price-source: chosenPrice should not be 0.99");
    }

    // Budget clamp: allow order when affordable shares are clamped but still >= min shares.
    {
      process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES = "1";
      const { execution, logs } = makeExecution({
        polymarket: {
          sizing: {
            maxNotionalPerWindow: 1
          }
        }
      });
      const result = await execution.executeBuyYes({
        marketId: "m-clamp",
        tokenId: "yes-token",
        yesAsk: 0.2,
        notionalUsd: 10,
        tickSize: "0.01",
        priceSource: "SIDE_BOOK_LIVE"
      });
      assert(result.accepted === true, "budget-clamp: expected accepted paper fill");
      const precheck = logs.find((row) => row.msg === "POLY_ORDER_SIZING_PRECHECK");
      assert(Boolean(precheck), "budget-clamp: expected POLY_ORDER_SIZING_PRECHECK log");
      const estimatedCost = Number(precheck!.payload.estimatedCost || 0);
      assert(estimatedCost <= 1.000001, `budget-clamp: expected estimatedCost<=1, got ${estimatedCost}`);
      const finalSize = Number(precheck!.payload.finalSize || 0);
      assert(finalSize >= 1, `budget-clamp: expected finalSize>=1, got ${finalSize}`);
    }

    // Reject when affordable size is below min shares requirement.
    {
      process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES = "5";
      const { execution, logs } = makeExecution({
        polymarket: {
          sizing: {
            maxNotionalPerWindow: 1
          }
        }
      });
      const result = await execution.executeBuyYes({
        marketId: "m-reject",
        tokenId: "yes-token",
        yesAsk: 0.99,
        notionalUsd: 1,
        tickSize: "0.01",
        priceSource: "SIDE_BOOK_LIVE"
      });
      assert(result.accepted === false, "reject: expected hold/reject");
      assert(result.reason === "MIN_SHARES_UNAFFORDABLE", `reject: expected MIN_SHARES_UNAFFORDABLE, got ${String(result.reason)}`);
      const rejectLog = logs.find((row) => row.msg === "POLY_ORDER_SIZING_REJECT");
      assert(Boolean(rejectLog), "reject: expected POLY_ORDER_SIZING_REJECT log");
      assert(
        String(rejectLog!.payload.sizingRejectReason || "") === "MIN_SHARES_UNAFFORDABLE",
        "reject: expected explicit sizingRejectReason"
      );
      const expectedMinimums = computePolymarketEffectiveSizingBasis({
        enabled: true,
        orderPrice: 0.99,
        minVenueShares: 5,
        minVenueNotionalUsd: 0,
        feeBufferBps: 30
      });
      assert(
        Math.abs(Number(rejectLog!.payload.minValidPriceBasis) - expectedMinimums.minValidPriceBasis) < 1e-9,
        `reject: expected minValidPriceBasis=${String(expectedMinimums.minValidPriceBasis)}`
      );
      assert(
        Math.abs(Number(rejectLog!.payload.minValidSizeEffective) - expectedMinimums.minValidSizeEffective) < 1e-9,
        `reject: expected minValidSizeEffective=${String(expectedMinimums.minValidSizeEffective)}`
      );
      assert(
        Math.abs(Number(rejectLog!.payload.minValidCostUsdEffective) - expectedMinimums.minValidCostUsdEffective) < 1e-9,
        `reject: expected minValidCostUsdEffective=${String(expectedMinimums.minValidCostUsdEffective)}`
      );
      assert(
        Math.abs(Number(rejectLog!.payload.minValidCostUsd) - expectedMinimums.minValidCostUsdEffective) < 1e-9,
        `reject: expected minValidCostUsd=${String(expectedMinimums.minValidCostUsdEffective)}`
      );
    }

    // Live execution must keep the venue floor even when config/env still says 1 share.
    {
      delete process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES;
      process.env.POLYMARKET_MIN_SHARES_REQUIRED = "1";
      const { execution, client } = makeExecution({
        polymarket: {
          mode: "live",
          sizing: {
            maxNotionalPerWindow: 2,
            minSharesRequired: 1
          }
        }
      });
      let postCalls = 0;
      (client as any).placeMarketableBuyYes = async () => {
        postCalls += 1;
        return { orderId: "unexpected-live-post" };
      };
      const result = await execution.executeBuyYes({
        marketId: "m-live-floor",
        tokenId: "yes-token",
        yesAsk: 0.23,
        notionalUsd: 1.12,
        tickSize: "0.01",
        priceSource: "SIDE_BOOK_LIVE"
      });
      assert(result.accepted === false, "live-floor: expected hold/reject before posting");
      assert(
        result.reason === "MIN_SHARES_UNAFFORDABLE",
        `live-floor: expected MIN_SHARES_UNAFFORDABLE, got ${String(result.reason)}`
      );
      assert(postCalls === 0, `live-floor: expected no live post call, got ${String(postCalls)}`);
    }

    // Live post timeout must preserve unknown local order state and reserve buying power.
    {
      process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES = "1";
      process.env.POLY_AVAILABLE_USD = "10";
      const { execution, client } = makeExecution({
        polymarket: {
          mode: "live",
          sizing: {
            maxNotionalPerWindow: 5
          }
        }
      });
      (client as any).placeMarketableBuyYes = async () => {
        throw new Error("Polymarket CLOB call timeout (postOrder)");
      };
      const result = await execution.executeBuyYes({
        marketId: "m-timeout",
        tokenId: "yes-token",
        yesAsk: 0.4,
        notionalUsd: 3,
        tickSize: "0.01",
        priceSource: "SIDE_BOOK_LIVE"
      });
      assert(result.accepted === false, "post-timeout: expected rejected result");
      assert(
        result.reason === "ORDER_POST_STATUS_UNKNOWN",
        `post-timeout: expected ORDER_POST_STATUS_UNKNOWN, got ${String(result.reason)}`
      );
      assert(execution.hasUnknownOpenOrders() === true, "post-timeout: expected unknown open order state");
      assert(execution.getOpenOrders().length === 1, "post-timeout: expected retained local open order");
      assert(
        execution.getOpenOrders()[0]?.status === "UNKNOWN",
        `post-timeout: expected UNKNOWN status, got ${String(execution.getOpenOrders()[0]?.status)}`
      );
      assert(
        execution.countOpenEntryOrdersForMarket("m-timeout") === 1,
        `post-timeout: expected open-entry count=1, got ${String(execution.countOpenEntryOrdersForMarket("m-timeout"))}`
      );
      assert(execution.getTotalExposureUsd() > 0, "post-timeout: expected exposure reservation to remain in place");
    }

    // eslint-disable-next-line no-console
    console.log("PolymarketExecutionSizing tests: PASS");
  } finally {
    if (previousMinVenueShares === undefined) delete process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES;
    else process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES = previousMinVenueShares;
    if (previousConfiguredMinVenueShares === undefined) delete process.env.POLYMARKET_MIN_SHARES_REQUIRED;
    else process.env.POLYMARKET_MIN_SHARES_REQUIRED = previousConfiguredMinVenueShares;
    if (previousMaxEntryCost === undefined) delete process.env.POLY_LIVE_MAX_ENTRY_COST_USD;
    else process.env.POLY_LIVE_MAX_ENTRY_COST_USD = previousMaxEntryCost;
    if (previousMinEntryCost === undefined) delete process.env.POLY_LIVE_MIN_ENTRY_COST_USD;
    else process.env.POLY_LIVE_MIN_ENTRY_COST_USD = previousMinEntryCost;
    if (previousTargetEntryCost === undefined) delete process.env.POLY_LIVE_TARGET_ENTRY_COST_USD;
    else process.env.POLY_LIVE_TARGET_ENTRY_COST_USD = previousTargetEntryCost;
    if (previousMaxShares === undefined) delete process.env.POLY_MAX_SHARES_PER_ENTRY;
    else process.env.POLY_MAX_SHARES_PER_ENTRY = previousMaxShares;
    if (previousSizingFeeBufferBps === undefined) delete process.env.POLY_LIVE_SIZING_FEE_BUFFER_BPS;
    else process.env.POLY_LIVE_SIZING_FEE_BUFFER_BPS = previousSizingFeeBufferBps;
    if (previousAvailableUsd === undefined) delete process.env.POLY_AVAILABLE_USD;
    else process.env.POLY_AVAILABLE_USD = previousAvailableUsd;
  }
}

if (require.main === module) {
  void runPolymarketExecutionSizingTests();
}
