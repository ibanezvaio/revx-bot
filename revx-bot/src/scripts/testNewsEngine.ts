import { computeNewsAggregate } from "../news/NewsEngine";
import { Headline } from "../news/types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function headline(
  ts: number,
  title: string,
  impact: number,
  direction: "UP" | "DOWN" | "NEUTRAL",
  confidence: number,
  category: Headline["category"]
): Headline {
  return {
    id: `${title}-${ts}`,
    ts,
    title,
    source: "test",
    url: "https://example.test",
    tags: [],
    symbols: ["BTC"],
    category,
    impact,
    direction,
    confidence
  };
}

function run(): void {
  const now = Date.now();
  const halfLifeMs = 60 * 60 * 1000;
  const items: Headline[] = [
    headline(now - 10_000, "Fresh risk-off headline", 0.9, "DOWN", 0.9, "macro"),
    headline(now - 5 * halfLifeMs, "Very old risk-on headline", 0.8, "UP", 0.9, "crypto")
  ];
  const aggregate = computeNewsAggregate(items, now, halfLifeMs);
  assert(aggregate.direction === "DOWN", `expected aggregate DOWN, got ${aggregate.direction}`);
  assert(aggregate.impact > 0.2, `expected non-trivial impact, got ${aggregate.impact}`);
  assert(aggregate.confidence >= 0 && aggregate.confidence <= 1, "confidence must be bounded [0,1]");
  assert(aggregate.categoryCounts.macro === 1, "macro category count should be 1");
  assert(aggregate.categoryCounts.crypto === 1, "crypto category count should be 1");

  const empty = computeNewsAggregate([], now, halfLifeMs);
  assert(empty.impact === 0, "empty impact should be 0");
  assert(empty.direction === "NEUTRAL", "empty direction should be NEUTRAL");
  assert(empty.confidence === 0, "empty confidence should be 0");

  // eslint-disable-next-line no-console
  console.log("NewsEngine aggregate tests: PASS");
}

run();
