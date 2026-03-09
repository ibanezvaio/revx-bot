import { loadConfig } from "../config";
import { buildLogger } from "../logger";
import { PolymarketClient } from "../polymarket/PolymarketClient";

process.env.DRY_RUN = "false";
process.env.POLYMARKET_ENABLED = "true";
process.env.POLYMARKET_MODE = "live";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function runDelayedExpirationRetryScenario(): Promise<void> {
  const base = loadConfig();
  const config = {
    ...base,
    polymarket: {
      ...base.polymarket,
      enabled: true,
      mode: "live" as const,
      http: {
        ...base.polymarket.http,
        maxRetries: 2,
        baseBackoffMs: 1,
        maxBackoffMs: 1,
        jitterMs: 0
      }
    }
  };
  const logger = buildLogger(config);
  const client = new PolymarketClient(config, logger);
  const clientAny = client as any;

  let nowMs = 1_772_986_200_000;
  const originalDateNow = Date.now;
  const attempts: Array<{
    nowSec: number;
    expirationSec: number;
    userOrder: Record<string, unknown>;
    signedOrder: Record<string, unknown>;
  }> = [];
  (Date as unknown as { now: () => number }).now = () => nowMs;

  clientAny.requestScheduler = {
    schedule: async (fn: () => Promise<unknown>) => await fn()
  };
  clientAny.getHttpTimeoutMs = () => 60_000;
  clientAny.getFeeRateBps = async () => 7;
  clientAny.getAuthClient = async () => ({
    createOrder: async (userOrder: Record<string, unknown>) => ({
      signature: `sig-${attempts.length + 1}`,
      maker: "0xmaker",
      signer: "0xsigner",
      ...JSON.parse(JSON.stringify(userOrder))
    }),
    postOrder: async (signedOrder: Record<string, unknown>) => {
      attempts.push({
        nowSec: Math.floor(nowMs / 1000),
        expirationSec: Number(signedOrder.expiration || 0),
        userOrder: {
          tokenID: signedOrder.tokenID,
          price: signedOrder.price,
          size: signedOrder.size,
          side: signedOrder.side,
          expiration: signedOrder.expiration,
          feeRateBps: signedOrder.feeRateBps
        },
        signedOrder
      });
      if (attempts.length === 1) {
        nowMs += 65_000;
        const error = new Error("HTTP 400 createAndPostOrder invalid expiration value") as Error & {
          status?: number;
        };
        error.status = 400;
        throw error;
      }
      return { orderID: "live-order-2" };
    }
  });
  clientAny.getOrderTypeConstant = async () => "GTD";
  clientAny.getTickSize = async () => "0.01";
  clientAny.getNegRisk = async () => false;

  try {
    const placed = await client.placeMarketableBuyYes({
      tokenId: "123456789",
      limitPrice: 0.49,
      size: 10,
      ttlMs: 15_000
    });

    assert(placed.orderId === "live-order-2", `expected orderId live-order-2, got ${String(placed.orderId)}`);
    assert(attempts.length === 2, `expected 2 createAndPostOrder attempts, got ${String(attempts.length)}`);
    assert(attempts[0].expirationSec >= attempts[0].nowSec + 120, `first attempt expiration must keep >=120s lead, got ${String(attempts[0].expirationSec - attempts[0].nowSec)}`);
    assert(attempts[1].expirationSec >= attempts[1].nowSec + 120, `rebuilt retry expiration must keep >=120s lead, got ${String(attempts[1].expirationSec - attempts[1].nowSec)}`);
    assert(attempts[1].expirationSec > attempts[0].expirationSec, `retry should rebuild with fresher expiration, got ${String(attempts[0].expirationSec)} then ${String(attempts[1].expirationSec)}`);
    assert(attempts[0].userOrder !== attempts[1].userOrder, "retry must rebuild the order payload instead of reusing the prior object");
    assert(attempts[0].userOrder.expiration === attempts[0].expirationSec, "first attempt payload expiration must match the computed plan exactly");
    assert(attempts[1].userOrder.expiration === attempts[1].expirationSec, "retry payload expiration must match the rebuilt plan exactly");
    assert(attempts[0].userOrder.feeRateBps === 7, `first attempt should finalize feeRateBps before signing, got ${String(attempts[0].userOrder.feeRateBps)}`);
    assert(attempts[1].userOrder.feeRateBps === 7, `retry attempt should finalize feeRateBps before signing, got ${String(attempts[1].userOrder.feeRateBps)}`);
  } finally {
    (Date as unknown as { now: () => number }).now = originalDateNow;
  }
}

async function runSignedPayloadMutationGuardScenario(): Promise<void> {
  const base = loadConfig();
  const logger = buildLogger(base);
  const client = new PolymarketClient(base, logger);
  const clientAny = client as any;

  clientAny.requestScheduler = {
    schedule: async (fn: () => Promise<unknown>) => await fn()
  };
  clientAny.getHttpTimeoutMs = () => 60_000;
  clientAny.getTickSize = async () => "0.01";
  clientAny.getNegRisk = async () => false;
  clientAny.getFeeRateBps = async () => 9;
  clientAny.getOrderTypeConstant = async () => "GTD";
  let sawMutationLog = false;
  const originalError = clientAny.logger.error.bind(clientAny.logger);
  clientAny.logger.error = (...args: unknown[]) => {
    const text = String(args[1] ?? args[0] ?? "");
    if (text.includes("POLY_ORDER_PAYLOAD_MUTATED")) {
      sawMutationLog = true;
    }
    return originalError(...(args as [unknown, string?]));
  };
  clientAny.getAuthClient = async () => ({
    createOrder: async (userOrder: Record<string, unknown>) => {
      userOrder.feeRateBps = 11;
      return { signature: "sig-bad", ...userOrder };
    },
    postOrder: async () => {
      throw new Error("postOrder should not run after mutation is detected");
    }
  });

  let threw = false;
  try {
    await client.placeMarketableBuyYes({
      tokenId: "123456789",
      limitPrice: 0.49,
      size: 10,
      ttlMs: 15_000
    });
  } catch (error) {
    threw = String((error as Error)?.message || "").includes("mutated after signing/finalization");
  }
  assert(threw, "mutated userOrder payload should throw before postOrder");
  assert(sawMutationLog, "payload mutation guard should emit POLY_ORDER_PAYLOAD_MUTATED");
}

async function runTradeAuthContextScenario(): Promise<void> {
  const base = loadConfig();
  const config = {
    ...base,
    polymarket: {
      ...base.polymarket,
      enabled: true,
      mode: "live" as const
    }
  };
  const logger = buildLogger(config);
  const client = new PolymarketClient(config, logger);
  const clientAny = client as any;

  const markerSigner = { address: "0xSigner" };
  const markerCreds = { key: "key-123", secret: "secret-456", passphrase: "pass-789" };
  let receivedArgs: unknown[] | null = null;

  class MockClobClient {
    constructor(...args: unknown[]) {
      receivedArgs = args;
    }
  }

  clientAny.getClobModule = async () => ({ ClobClient: MockClobClient });
  clientAny.requireSignerContext = async () => ({
    signer: markerSigner,
    signerAddress: "0xSigner",
    chainId: 137,
    signatureType: 2,
    funder: "0xFunder"
  });
  clientAny.resolveTradeCreds = async () => ({
    creds: markerCreds,
    source: "env"
  });

  await clientAny.getAuthClient();

  assert(Array.isArray(receivedArgs), "expected trade client constructor to be invoked");
  assert(receivedArgs?.[2] === markerSigner, "trade client signer must match signer context");
  assert(receivedArgs?.[3] === markerCreds, "trade client api creds must match resolved creds");
  assert(receivedArgs?.[4] === 2, "trade client signatureType must match signer context");
  assert(receivedArgs?.[5] === "0xFunder", "trade client funder must match signer context");
  assert(clientAny.authClientInfo?.signerAddress === "0xSigner", "auth debug info signer mismatch");
  assert(clientAny.authClientInfo?.signatureType === 2, "auth debug info signatureType mismatch");
  assert(clientAny.authClientInfo?.funder === "0xFunder", "auth debug info funder mismatch");
}

async function run(): Promise<void> {
  await runDelayedExpirationRetryScenario();
  await runSignedPayloadMutationGuardScenario();
  await runTradeAuthContextScenario();
  // eslint-disable-next-line no-console
  console.log("Polymarket live order posting tests: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Polymarket live order posting tests: FAIL", error);
  process.exit(1);
});
