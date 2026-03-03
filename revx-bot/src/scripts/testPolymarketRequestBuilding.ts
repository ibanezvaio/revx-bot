import { buildCreateOrderInput } from "../polymarket/auth/requestBuilder";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const built = buildCreateOrderInput({
    tokenId: "1234567890",
    side: "BUY",
    price: 1.5,
    size: 10,
    expirationSec: nowSec - 100,
    tickSize: "0.01",
    negRisk: true
  });

  assert(built.userOrder.tokenID === "1234567890", "tokenID mismatch");
  assert(built.userOrder.side === "BUY", "side mismatch");
  assert(built.userOrder.price < 1 && built.userOrder.price > 0, "price clamp failed");
  assert(built.userOrder.price === 0.99, `expected clamped price 0.99, got ${built.userOrder.price}`);
  assert(built.userOrder.expiration >= nowSec, "expiration clamp failed");
  assert(built.options.tickSize === "0.01", "tickSize mismatch");
  assert(built.options.negRisk === true, "negRisk mismatch");

  const rounded = buildCreateOrderInput({
    tokenId: "1234567890",
    side: "BUY",
    price: 0.538,
    size: 10,
    expirationSec: nowSec + 5,
    tickSize: "0.01",
    negRisk: false
  });
  assert(rounded.userOrder.price === 0.53, `expected tick-rounded price 0.53, got ${rounded.userOrder.price}`);

  let threw = false;
  try {
    buildCreateOrderInput({
      tokenId: "",
      side: "BUY",
      price: 0.5,
      size: 1,
      expirationSec: nowSec + 10,
      tickSize: "0.01",
      negRisk: false
    });
  } catch {
    threw = true;
  }
  assert(threw, "expected invalid tokenId to throw");

  // eslint-disable-next-line no-console
  console.log("Polymarket request-building tests: PASS");
}

run();
