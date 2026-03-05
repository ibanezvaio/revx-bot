import { registerVenueServiceHosts, validateVenueRoute } from "../http/venueGuard";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertThrows(fn: () => void, messagePart: string): void {
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    const text = error instanceof Error ? error.message : String(error);
    assert(text.includes(messagePart), `expected error to include "${messagePart}", got "${text}"`);
  }
  assert(threw, "expected function to throw");
}

function run(): void {
  registerVenueServiceHosts("REVX", ["https://revx.revolut.com"]);
  registerVenueServiceHosts("POLY_GAMMA", ["https://gamma-api.polymarket.com"]);

  validateVenueRoute({
    service: "REVX",
    module: "test",
    url: "https://revx.revolut.com/api/v2/orders"
  });
  validateVenueRoute({
    service: "POLY_GAMMA",
    module: "test",
    url: "https://gamma-api.polymarket.com/markets"
  });

  assertThrows(
    () =>
      validateVenueRoute({
        service: "REVX",
        module: "test",
        url: "https://gamma-api.polymarket.com/markets"
      }),
    "VENUE_MISROUTE_BLOCKED"
  );
  assertThrows(
    () =>
      validateVenueRoute({
        service: "POLY_GAMMA",
        module: "test",
        url: "https://revx.revolut.com/api/v2/orders"
      }),
    "VENUE_MISROUTE_BLOCKED"
  );

  // eslint-disable-next-line no-console
  console.log("VenueGuard tests: PASS");
}

run();
