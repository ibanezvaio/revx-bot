import { analyzeFillsWindow } from "../performance/analysis";
import { MidSnapshotRow, PersistedFillRow } from "../performance/types";

function makeFill(
  id: string,
  ts: number,
  side: "BUY" | "SELL",
  price: number,
  qty: number,
  midAtFill: number
): PersistedFillRow {
  return {
    id,
    ts,
    symbol: "BTC-USD",
    side,
    price,
    base_qty: qty,
    quote_qty: qty * price,
    fee_usd: 0.01,
    order_id: `venue-${id}`,
    client_order_id: `client-${id}`,
    posture: "NORMAL",
    revx_mid_at_fill: midAtFill,
    source_json: JSON.stringify({ smoke: true })
  };
}

function run(): void {
  const now = Date.now();
  const fills: PersistedFillRow[] = [
    makeFill("f1", now - 40 * 60_000, "BUY", 99_500, 0.001, 99_550),
    makeFill("f2", now - 34 * 60_000, "SELL", 99_920, 0.001, 99_900),
    makeFill("f3", now - 25 * 60_000, "BUY", 100_100, 0.0012, 100_150),
    makeFill("f4", now - 12 * 60_000, "SELL", 100_460, 0.001, 100_420),
    makeFill("f5", now - 3 * 60_000, "BUY", 100_300, 0.0008, 100_330)
  ];
  const mids: MidSnapshotRow[] = [
    { ts: now - 39 * 60_000, symbol: "BTC-USD", revx_bid: 99_520, revx_ask: 99_540, revx_mid: 99_530 },
    { ts: now - 30 * 60_000, symbol: "BTC-USD", revx_bid: 100_010, revx_ask: 100_030, revx_mid: 100_020 },
    { ts: now - 20 * 60_000, symbol: "BTC-USD", revx_bid: 100_190, revx_ask: 100_210, revx_mid: 100_200 },
    { ts: now - 8 * 60_000, symbol: "BTC-USD", revx_bid: 100_510, revx_ask: 100_530, revx_mid: 100_520 },
    { ts: now - 60_000, symbol: "BTC-USD", revx_bid: 100_390, revx_ask: 100_410, revx_mid: 100_400 }
  ];

  const result = analyzeFillsWindow({
    fills,
    mids,
    latestMid: 100_420,
    nowTs: now,
    window: "1h"
  });

  // eslint-disable-next-line no-console
  console.log("=== analysis_smoke_test ===");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result.summary, null, 2));
  // eslint-disable-next-line no-console
  console.log(`fills analyzed: ${result.rows.length}, equity points: ${result.curve.length}`);
}

run();

