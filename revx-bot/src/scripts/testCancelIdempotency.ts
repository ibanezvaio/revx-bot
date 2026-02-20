import { loadConfig } from "../config";
import { Execution } from "../exec/Execution";
import { buildLogger } from "../logger";
import { RevXClient, RevXHttpError } from "../revx/RevXClient";
import { Store } from "../store/Store";

async function main(): Promise<void> {
  process.env.DRY_RUN = "true";
  process.env.REVX_API_KEY = "";
  process.env.REVX_PRIVATE_KEY_BASE64 = "";
  process.env.REVX_PRIVATE_KEY_PATH = "";

  const config = loadConfig();
  const logger = buildLogger(config);

  let lastStatus = "";
  let eventCount = 0;
  const store = {
    getOrderByVenueId: (_venueOrderId: string) => ({
      client_order_id: "bot-test-client",
      venue_order_id: "test-venue-order-id",
      bot_tag: "bot-test-tag",
      symbol: "BTC-USD",
      side: "BUY",
      price: 50_000,
      quote_size: 5,
      status: "OPEN",
      last_seen_status: "OPEN",
      is_bot: 1,
      created_at: Date.now() - 10_000,
      updated_at: Date.now()
    }),
    updateOrderStatusByVenueId: (_venueOrderId: string, status: string) => {
      lastStatus = status;
    },
    recordMetric: () => {
      // no-op
    },
    recordBotEvent: () => {
      eventCount += 1;
    }
  } as unknown as Store;

  const client = {
    cancelOrderById: async () => {
      throw new RevXHttpError(
        "RevX DELETE /api/1.0/orders/:id failed: 409",
        409,
        { message: "Can't cancel order in inactive state" }
      );
    }
  } as unknown as RevXClient;

  const execution = new Execution(config, logger, client, store, false);
  await execution.cancelOrder("test-venue-order-id");

  if (lastStatus !== "INACTIVE") {
    throw new Error(`Expected local status INACTIVE, got: ${lastStatus || "<empty>"}`);
  }
  if (eventCount === 0) {
    throw new Error("Expected a CANCELLED bot event to be recorded");
  }

  // eslint-disable-next-line no-console
  console.log("PASS: cancelOrder() treats 409 inactive-state as success");
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
