import {
  buildClobClientCtorArgs,
  createPolymarketClobClient
} from "../polymarket/auth/clobClientFactory";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const readArgs = buildClobClientCtorArgs({
    mode: "read",
    host: "https://clob.polymarket.com",
    chainId: 137,
    ClobClient: class {}
  });
  assert(readArgs[0] === "https://clob.polymarket.com", "read host mismatch");
  assert(readArgs[1] === 137, "read chainId mismatch");
  assert(readArgs[2] === undefined, "read signer should be undefined");
  assert(readArgs[3] === undefined, "read creds should be undefined");

  const markerSigner = { address: "0xabc" };
  const markerCreds = { key: "key", secret: "secret", passphrase: "pass" };
  const tradeArgs = buildClobClientCtorArgs({
    mode: "trade",
    host: "https://clob.polymarket.com",
    chainId: 137,
    ClobClient: class {},
    signer: markerSigner,
    apiCreds: markerCreds,
    signatureType: 2,
    funder: "0xfunder"
  });
  assert(tradeArgs[0] === "https://clob.polymarket.com", "trade host mismatch");
  assert(tradeArgs[1] === 137, "trade chainId mismatch");
  assert(tradeArgs[2] === markerSigner, "trade signer arg position mismatch");
  assert(tradeArgs[3] === markerCreds, "trade creds arg position mismatch");
  assert(tradeArgs[4] === 2, "trade signatureType arg position mismatch");
  assert(tradeArgs[5] === "0xfunder", "trade funder arg position mismatch");

  let received: unknown[] = [];
  class MockClobClient {
    constructor(...args: unknown[]) {
      received = args;
    }
  }
  createPolymarketClobClient({
    mode: "trade",
    host: "https://clob.polymarket.com",
    chainId: 137,
    ClobClient: MockClobClient,
    signer: markerSigner,
    apiCreds: markerCreds,
    signatureType: 2,
    funder: "0xfunder"
  });
  assert(received[2] === markerSigner, "created signer arg mismatch");
  assert(received[3] === markerCreds, "created creds arg mismatch");
  assert(received[4] === 2, "created signatureType arg mismatch");
  assert(received[5] === "0xfunder", "created funder arg mismatch");

  // eslint-disable-next-line no-console
  console.log("Polymarket ClobClient factory tests: PASS");
}

run();
