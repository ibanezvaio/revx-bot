import { analyzeFillsWindow, computeEdgeBps } from "../performance/analysis";
import { MidSnapshotRow, PersistedFillRow } from "../performance/types";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function approx(actual: number, expected: number, tolerance: number, message: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}. actual=${actual} expected=${expected}`);
  }
}

function testEdgeBps(): void {
  const buy: PersistedFillRow = {
    id: "buy",
    ts: 1_000,
    symbol: "BTC-USD",
    side: "BUY",
    price: 99,
    base_qty: 0.1,
    quote_qty: 9.9,
    fee_usd: 0,
    order_id: "o1",
    client_order_id: "c1",
    posture: "NORMAL",
    revx_mid_at_fill: 100,
    source_json: "{}"
  };
  const sell: PersistedFillRow = {
    ...buy,
    id: "sell",
    side: "SELL",
    price: 101
  };
  approx(computeEdgeBps(buy) ?? 0, 100, 1e-9, "BUY edge bps should be positive when filled below mid");
  approx(computeEdgeBps(sell) ?? 0, 100, 1e-9, "SELL edge bps should be positive when filled above mid");
}

function testFifoMatching(): void {
  const fills: PersistedFillRow[] = [
    {
      id: "b1",
      ts: 1_000,
      symbol: "BTC-USD",
      side: "BUY",
      price: 100,
      base_qty: 1,
      quote_qty: 100,
      fee_usd: 0,
      order_id: "o-b1",
      client_order_id: "c-b1",
      posture: "NORMAL",
      revx_mid_at_fill: 100,
      source_json: "{}"
    },
    {
      id: "b2",
      ts: 2_000,
      symbol: "BTC-USD",
      side: "BUY",
      price: 110,
      base_qty: 1,
      quote_qty: 110,
      fee_usd: 0,
      order_id: "o-b2",
      client_order_id: "c-b2",
      posture: "NORMAL",
      revx_mid_at_fill: 110,
      source_json: "{}"
    },
    {
      id: "s1",
      ts: 3_000,
      symbol: "BTC-USD",
      side: "SELL",
      price: 120,
      base_qty: 1.5,
      quote_qty: 180,
      fee_usd: 0,
      order_id: "o-s1",
      client_order_id: "c-s1",
      posture: "NORMAL",
      revx_mid_at_fill: 120,
      source_json: "{}"
    }
  ];
  const mids: MidSnapshotRow[] = [{ ts: 3_100, symbol: "BTC-USD", revx_bid: 130, revx_ask: 130, revx_mid: 130 }];
  const { summary } = analyzeFillsWindow({
    fills,
    mids,
    latestMid: 130,
    nowTs: 3_200,
    window: "1h"
  });
  approx(summary.realizedPnlUsd, 25, 1e-9, "FIFO realized pnl should match lot-by-lot sell matching");
  approx(summary.unrealizedPnlUsd, 10, 1e-9, "Unrealized pnl should mark remaining inventory at latest mid");
  approx(summary.netPnlUsd, 35, 1e-9, "Net pnl should equal realized + unrealized");
}

function testToxicityWithSnapshotLookup(): void {
  const fills: PersistedFillRow[] = [
    {
      id: "tox",
      ts: 10_000,
      symbol: "BTC-USD",
      side: "BUY",
      price: 100,
      base_qty: 0.2,
      quote_qty: 20,
      fee_usd: 0,
      order_id: "o-tox",
      client_order_id: "c-tox",
      posture: "NORMAL",
      revx_mid_at_fill: 100,
      source_json: "{}"
    }
  ];
  const mids: MidSnapshotRow[] = [
    { ts: 40_000, symbol: "BTC-USD", revx_bid: 99, revx_ask: 99, revx_mid: 99 },
    { ts: 130_000, symbol: "BTC-USD", revx_bid: 101, revx_ask: 101, revx_mid: 101 }
  ];
  const { rows, summary } = analyzeFillsWindow({
    fills,
    mids,
    latestMid: 101,
    nowTs: 131_000,
    window: "1h"
  });
  assert(rows.length === 1, "Expected one analyzed fill row");
  approx(rows[0].toxBps30s ?? 0, -100, 1e-9, "tox 30s should use first mid snapshot at/after fill+30s");
  approx(rows[0].toxBps2m ?? 0, 100, 1e-9, "tox 2m should use first mid snapshot at/after fill+120s");
  approx(summary.toxicPct30s, 1, 1e-9, "toxic pct should count tox < -2bps as toxic");
}

function run(): void {
  testEdgeBps();
  testFifoMatching();
  testToxicityWithSnapshotLookup();
  // eslint-disable-next-line no-console
  console.log("Performance analysis tests: PASS");
}

run();
