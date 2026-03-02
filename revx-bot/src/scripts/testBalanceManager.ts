import { RevXHttpError } from "../revx/RevXClient";
import { BalanceManager } from "../strategy/BalanceManager";
import { classifyStrategyRuntimeError } from "../strategy/MakerStrategy";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const manager = new BalanceManager();
  manager.update({
    ts: Date.now(),
    freeUsd: 5,
    totalUsd: 5,
    freeBtc: 0.00005,
    totalBtc: 0.00005,
    reservedUsd: 1,
    reservedBtc: 0.00001
  });

  const price = 100_000;
  const desired = [
    { tag: "buy-1", side: "BUY" as const, level: 1, price, quoteSizeUsd: 10 },
    { tag: "sell-1", side: "SELL" as const, level: 1, price, quoteSizeUsd: 10 }
  ];
  const preflight = manager.preflightQuotes({
    desired,
    minNotionalUsd: 1,
    reserveUsd: 1,
    reserveBtc: 0.00001,
    btcDustBuffer: 0.00000001
  });

  assert(preflight.desired.length > 0, "preflight should keep at least one order");
  assert(
    preflight.events.some((event) => event.reason === "INSUFFICIENT_USD_CLAMPED"),
    "BUY should be clamped for insufficient USD"
  );
  assert(
    preflight.events.some(
      (event) => event.reason === "INSUFFICIENT_BTC_CLAMPED" || event.reason === "INSUFFICIENT_BTC_SKIPPED"
    ),
    "SELL should be clamped or skipped for insufficient BTC"
  );

  const insufficient = new RevXHttpError(
    "RevX POST /api/1.0/orders failed: 400",
    400,
    { message: "Insufficient balance" }
  );
  const insufficientClass = classifyStrategyRuntimeError(insufficient);
  assert(insufficientClass.recoverable, "insufficient balance must be recoverable");
  assert(!insufficientClass.stopEligible, "insufficient balance must not be stop-eligible");

  const auth = new RevXHttpError("RevX auth failed", 401, {
    message: "Invalid signature"
  });
  const authClass = classifyStrategyRuntimeError(auth);
  assert(authClass.isAuthOrSignatureFailure, "auth/signature errors must be detected");
  assert(authClass.stopEligible, "auth/signature errors should be stop-eligible");

  // eslint-disable-next-line no-console
  console.log("Balance manager + recoverable error classification test: PASS");
}

run();
