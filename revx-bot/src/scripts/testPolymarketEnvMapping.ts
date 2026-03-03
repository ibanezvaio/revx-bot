import { loadConfig } from "../config";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    prev[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function run(): void {
  const baseEnv: Record<string, string | undefined> = {
    DRY_RUN: "true",
    POLYMARKET_ENABLED: "true",
    POLYMARKET_MODE: "live",
    POLYMARKET_LIVE_CONFIRMED: "true",
    POLYMARKET_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111",
    POLYMARKET_FUNDER: "0x2222222222222222222222222222222222222222",
    POLYMARKET_API_KEY: "test_api_key",
    POLYMARKET_PASSPHRASE: "test_passphrase",
    POLYMARKET_AUTO_DERIVE_API_KEY: "false"
  };

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_API_SECRET: undefined,
      POLYMARKET_SECRET: "legacy_secret"
    },
    () => {
      const config = loadConfig();
      assert(config.polymarket.auth.apiSecret === "legacy_secret", "expected legacy POLYMARKET_SECRET fallback");
    }
  );

  withEnv(
    {
      ...baseEnv,
      POLYMARKET_API_SECRET: "preferred_secret",
      POLYMARKET_SECRET: "legacy_secret"
    },
    () => {
      const config = loadConfig();
      assert(config.polymarket.auth.apiSecret === "preferred_secret", "expected POLYMARKET_API_SECRET to take priority");
    }
  );

  // eslint-disable-next-line no-console
  console.log("Polymarket env mapping tests: PASS");
}

run();
