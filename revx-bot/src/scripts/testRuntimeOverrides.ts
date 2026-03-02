import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config";
import { buildRuntimeOverrideDefaults } from "../overrides/runtimeOverrides";
import { JsonStore } from "../store/jsonStore";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "revx-ovr-"));
  const path = join(dir, "runtime-overrides.json");
  const runtimeDefaults = buildRuntimeOverrideDefaults(loadConfig());
  const store = new JsonStore(path, { runtimeDefaults, maxBotEvents: 2000, eventDedupe: true });
  try {
    store.init();

    store.setRuntimeOverrides(
      "BTC-USD",
      {
        levelsBuy: 1,
        baseHalfSpreadBps: 9,
        ttlSeconds: 1
      },
      { source: "test", note: "initial set" }
    );

    const first = store.getRuntimeOverrides("BTC-USD");
    if (!first) {
      throw new Error("expected overrides after set");
    }
    if (first.levelsBuy !== 1) {
      throw new Error(`expected levelsBuy=1, got ${String(first.levelsBuy)}`);
    }

    await sleep(1300);
    const expired = store.getRuntimeOverrides("BTC-USD");
    if (expired) {
      throw new Error("expected overrides to expire after ttl");
    }

    const expireEvent = store
      .getRecentBotEvents(50)
      .find((row) => row.type === "OVERRIDE" && row.reason === "EXPIRE");
    if (!expireEvent) {
      throw new Error("expected OVERRIDE EXPIRE event");
    }

    store.setRuntimeOverrides(
      "BTC-USD",
      {
        allowBuy: false,
        levelsSell: 1
      },
      { source: "test", note: "second set" }
    );
    const second = store.getRuntimeOverrides("BTC-USD");
    if (!second || second.allowBuy !== false) {
      throw new Error("expected allowBuy=false override");
    }

    store.clearRuntimeOverrides("BTC-USD", { source: "test", note: "cleanup" });
    const cleared = store.getRuntimeOverrides("BTC-USD");
    if (cleared) {
      throw new Error("expected overrides to be cleared");
    }

    const clearEvent = store
      .getRecentBotEvents(50)
      .find((row) => row.type === "OVERRIDE" && row.reason === "CLEAR");
    if (!clearEvent) {
      throw new Error("expected OVERRIDE CLEAR event");
    }

    // eslint-disable-next-line no-console
    console.log("Runtime overrides smoke test: PASS");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Runtime overrides smoke test: FAIL", error);
  process.exit(1);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
