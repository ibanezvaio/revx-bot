import { computeSignalAggregate } from "../signals/SignalsEngine";
import { SignalItem } from "../signals/types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function signal(
  id: string,
  ts: number,
  impact: number,
  direction: "UP" | "DOWN" | "NEUTRAL",
  confidence: number,
  category: SignalItem["category"],
  kind: SignalItem["kind"] = "NEWS"
): SignalItem {
  return {
    id,
    ts,
    kind,
    category,
    title: id,
    source: "test",
    symbols: ["BTC"],
    impact,
    direction,
    confidence,
    horizonMinutes: 180,
    tags: []
  };
}

function run(): void {
  const now = Date.now();
  const items: SignalItem[] = [
    signal("fresh-down", now - 5_000, 0.92, "DOWN", 0.86, "war"),
    signal("old-up", now - 5 * 60 * 60 * 1000, 0.85, "UP", 0.9, "crypto")
  ];
  const aggregate = computeSignalAggregate(items, now, 60 * 60 * 1000, 0.6, 0.9);
  assert(aggregate.direction === "DOWN", `expected direction DOWN, got ${aggregate.direction}`);
  assert(aggregate.impact > 0.25, `expected impact > 0.25, got ${aggregate.impact}`);
  assert(aggregate.state === "CAUTION" || aggregate.state === "RISK_OFF" || aggregate.state === "PAUSE", `unexpected state ${aggregate.state}`);

  const pause = computeSignalAggregate(
    [
      signal("a", now - 1_000, 1, "DOWN", 0.95, "war"),
      signal("b", now - 1_500, 1, "DOWN", 0.95, "risk", "SYSTEM")
    ],
    now,
    60 * 60 * 1000,
    0.6,
    0.9
  );
  assert(pause.state === "PAUSE", `expected PAUSE, got ${pause.state}`);
  assert(pause.counts.NEWS >= 1 && pause.counts.SYSTEM >= 1, "expected kind counts");
  // eslint-disable-next-line no-console
  console.log("Signals aggregate tests: PASS");
}

run();
