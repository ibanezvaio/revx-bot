import { scoreSignalInputs } from "../signals/SignalScorer";
import { RawSignalInput } from "../signals/types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const now = Date.now();
  const rows: RawSignalInput[] = [
    {
      ts: now,
      kind: "NEWS",
      title: "Spot ETF approval boosts Bitcoin market sentiment",
      source: "Reuters",
      url: "https://example.test/etf"
    },
    {
      ts: now,
      kind: "NEWS",
      title: "Missile strike escalates war tensions and sanctions risk",
      source: "Reuters",
      url: "https://example.test/war"
    },
    {
      ts: now,
      kind: "MACRO",
      title: "Fed signals potential rate cut next quarter",
      source: "ft.com",
      url: "https://example.test/rates"
    }
  ];
  const scored = scoreSignalInputs(rows, now);
  const etf = scored.find((row) => row.url === "https://example.test/etf");
  const war = scored.find((row) => row.url === "https://example.test/war");
  const rates = scored.find((row) => row.url === "https://example.test/rates");
  assert(Boolean(etf), "ETF row missing");
  assert(Boolean(war), "war row missing");
  assert(Boolean(rates), "rates row missing");
  assert(etf?.direction === "UP", `ETF direction expected UP, got ${etf?.direction}`);
  assert(war?.direction === "DOWN", `war direction expected DOWN, got ${war?.direction}`);
  assert(rates?.category === "inflation" || rates?.category === "rates", `rates category expected inflation/rates, got ${rates?.category}`);
  assert((war?.impact ?? 0) > (rates?.impact ?? 0), "war impact should exceed typical rates headline");
  // eslint-disable-next-line no-console
  console.log("SignalsScorer tests: PASS");
}

run();
