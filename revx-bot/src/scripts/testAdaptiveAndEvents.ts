import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAdaptiveSpreadController, computeSideEdgeAdjustments } from "../strategy/MakerStrategy";
import { JsonStore } from "../store/jsonStore";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function testAdaptiveClamp(): void {
  const config = {
    adaptiveSpread: true,
    adaptiveStepBps: 1,
    targetFillsPerHour: 3,
    edgeBadBps: 0,
    edgeGoodBps: 8,
    maxCancelsPerHour: 200,
    minHalfSpreadBps: 4,
    maxHalfSpreadBps: 20
  };

  const widen = applyAdaptiveSpreadController(
    10,
    {
      fills_last_30m: 2,
      fills_last_1h: 6,
      avg_edge_total_last_1h: -2,
      cancels_last_1h: 500
    },
    config
  );
  assert(widen.afterHalfSpreadBps <= config.maxHalfSpreadBps, "adaptive spread should clamp to max");
  assert(widen.afterHalfSpreadBps === 15, "unexpected widen output");

  const tighten = applyAdaptiveSpreadController(
    5,
    {
      fills_last_30m: 0,
      fills_last_1h: 0,
      avg_edge_total_last_1h: 20,
      cancels_last_1h: 0
    },
    config
  );
  assert(
    tighten.afterHalfSpreadBps >= config.minHalfSpreadBps,
    "adaptive spread should clamp to min"
  );
  assert(tighten.afterHalfSpreadBps === 4, "unexpected tighten output");
}

function testSideAdjustCaps(): void {
  const result = computeSideEdgeAdjustments(1_000, -1_000, {
    edgeGoodBps: 8,
    edgeBadBps: 0,
    edgeAdjustBps: 20,
    edgeMaxSideAdjustBps: 6
  });
  assert(result.bidBps === -6, "bid side adjustment should be capped");
  assert(result.askBps === 6, "ask side adjustment should be capped");
}

function testEventRingBuffer(): void {
  const path = join(tmpdir(), `revx-bot-events-${randomUUID()}.json`);
  const maxEvents = 500;
  const store = new JsonStore(path, { maxBotEvents: maxEvents, eventDedupe: true });
  store.init();

  store.recordBotEvent({
    event_id: "dup-1",
    ts: 1,
    type: "PLACED",
    side: "BUY",
    price: 100,
    quote_size_usd: 5,
    venue_order_id: "v1",
    client_order_id: "c1",
    reason: "test",
    bot_tag: "bot-a"
  });
  store.recordBotEvent({
    event_id: "dup-1",
    ts: 2,
    type: "PLACED",
    side: "BUY",
    price: 101,
    quote_size_usd: 5,
    venue_order_id: "v1",
    client_order_id: "c1",
    reason: "duplicate",
    bot_tag: "bot-a"
  });
  for (let i = 0; i < maxEvents + 20; i += 1) {
    store.recordBotEvent({
      event_id: `evt-${i}`,
      ts: 3 + i,
      type: "CANCELLED",
      side: "SELL",
      price: 102 + i,
      quote_size_usd: 5,
      venue_order_id: `v-${i}`,
      client_order_id: `c-${i}`,
      reason: "trim-test",
      bot_tag: "bot-a"
    });
  }

  const recent = store.getRecentBotEvents(100);
  assert(recent.length === 100, "limit query should return requested cap");
  const recentAll = store.getRecentBotEvents(10_000);
  assert(recentAll.length === maxEvents, "event buffer should be trimmed to configured max");
  assert(
    recentAll.some((row) => row.event_id === `evt-${maxEvents + 19}`),
    "latest event should remain"
  );
  assert(!recentAll.some((row) => row.event_id === "dup-1"), "oldest events should be trimmed");

  store.close();
  if (existsSync(path)) {
    rmSync(path);
  }
}

function main(): void {
  testAdaptiveClamp();
  testSideAdjustCaps();
  testEventRingBuffer();
  // eslint-disable-next-line no-console
  console.log("Adaptive/edge/event tests passed.");
}

main();
