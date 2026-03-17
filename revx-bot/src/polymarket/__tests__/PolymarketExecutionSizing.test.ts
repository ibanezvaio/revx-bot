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
  const client = {} as any;
  return {
    execution: new PolymarketExecution(config, logger, client),
    logs
  };
}

export async function runPolymarketExecutionSizingTests(): Promise<void> {
  const previousMinVenueShares = process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES;
  const previousMaxEntryCost = process.env.POLY_LIVE_MAX_ENTRY_COST_USD;
  const previousMinEntryCost = process.env.POLY_LIVE_MIN_ENTRY_COST_USD;
  const previousTargetEntryCost = process.env.POLY_LIVE_TARGET_ENTRY_COST_USD;
  const previousMaxShares = process.env.POLY_MAX_SHARES_PER_ENTRY;
  const previousSizingFeeBufferBps = process.env.POLY_LIVE_SIZING_FEE_BUFFER_BPS;
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

    // eslint-disable-next-line no-console
    console.log("PolymarketExecutionSizing tests: PASS");
  } finally {
    if (previousMinVenueShares === undefined) delete process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES;
    else process.env.POLYMARKET_LIVE_MIN_VENUE_SHARES = previousMinVenueShares;
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
  }
}

if (require.main === module) {
  void runPolymarketExecutionSizingTests();
}
