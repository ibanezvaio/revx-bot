import { buildL2Headers, buildL2SigningPayload, createL2HmacSignature } from "../polymarket/auth/hmac";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const input = {
    timestamp: 1700000000,
    method: "POST" as const,
    requestPath: "/order",
    body: '{"foo":"bar"}'
  };

  const payload = buildL2SigningPayload(input);
  const signature = createL2HmacSignature(input, "dGVzdF9zZWNyZXRfYmFzZTY0");

  assert(payload === '1700000000POST/order{"foo":"bar"}', `unexpected payload: ${payload}`);
  assert(
    signature === "t+un5uBUQFkBt2NHY0+WV6pdhZPp9UQWwMNFHVhxe6U=",
    `unexpected signature: ${signature}`
  );

  const headers = buildL2Headers(
    {
      address: "0xabc",
      apiKey: "k",
      passphrase: "p",
      secretBase64: "dGVzdF9zZWNyZXRfYmFzZTY0"
    },
    input
  );

  assert(headers.POLY_ADDRESS === "0xabc", "missing POLY_ADDRESS");
  assert(headers.POLY_API_KEY === "k", "missing POLY_API_KEY");
  assert(headers.POLY_PASSPHRASE === "p", "missing POLY_PASSPHRASE");
  assert(headers.POLY_SIGNATURE === signature, "header signature mismatch");
  assert(headers.POLY_TIMESTAMP === "1700000000", "header timestamp mismatch");

  // eslint-disable-next-line no-console
  console.log("Polymarket auth signing tests: PASS");
}

run();
