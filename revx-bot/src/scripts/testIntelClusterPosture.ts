import {
  clusterIntelEvents,
  computeIntelPostureDecision,
  IntelClusterInput
} from "../intel/cluster";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function event(
  id: string,
  ts: number,
  source: string,
  provider: string,
  category: string,
  title: string,
  impact: number,
  confidence: number
): IntelClusterInput {
  return {
    id,
    ts,
    source,
    provider,
    kind: "NEWS",
    category,
    title,
    summary: title,
    impact,
    confidence,
    direction: "DOWN",
    reasonCodes: ["CATEGORY_" + String(category || "NEWS").toUpperCase()],
    tags: ["test"]
  };
}

function testDedupeAndConfirmations(): void {
  const now = Date.now();
  const events: IntelClusterInput[] = [
    event("a1", now - 20_000, "rss", "rss", "WAR", "Major strike escalates conflict", 0.96, 0.9),
    event("a2", now - 19_500, "rss", "rss", "WAR", "Major strike escalates conflict", 0.91, 0.88),
    event("b1", now - 19_000, "gdelt", "gdelt", "WAR", "Major strike escalates conflict", 0.94, 0.86)
  ];
  const out = clusterIntelEvents(events, now, {
    windowMs: 60 * 60 * 1000,
    dedupeWindowSeconds: 180,
    highImpactThreshold: 0.9,
    maxHighImpactPerMinute: 2
  });
  assert(out.dedupeStats.duplicateEvents >= 1, "expected duplicate events to be counted");
  assert(out.clusters.length === 1, `expected 1 cluster, got ${out.clusters.length}`);
  assert(out.clusters[0].confirmations >= 2, "expected >=2 independent provider confirmations");
}

function testHaltConfirmationRules(): void {
  const now = Date.now();
  const clustered = clusterIntelEvents(
    [
      event("n1", now - 15_000, "newsapi", "newsapi", "RISK", "Exchange outage spikes liquidations", 0.98, 0.9),
      event("n2", now - 14_000, "cryptopanic", "cryptopanic", "RISK", "Exchange outage spikes liquidations", 0.94, 0.86)
    ],
    now,
    {
      windowMs: 60 * 60 * 1000,
      dedupeWindowSeconds: 180,
      highImpactThreshold: 0.95,
      maxHighImpactPerMinute: 2
    }
  );
  const decisionConfirmed = computeIntelPostureDecision({
    nowTs: now,
    clusters: clustered.clusters,
    baseImpact: 0.88,
    baseConfidence: 0.82,
    haltImpactThreshold: 0.95,
    crossVenueAnomaly: false,
    lastState: "NORMAL",
    lastStateTs: now - 60_000,
    haltUntilTs: 0,
    flipCooldownSeconds: 10,
    haltSeconds: 90
  });
  assert(decisionConfirmed.state === "HALT", `expected HALT for confirmed cluster, got ${decisionConfirmed.state}`);

  const singleProvider = clusterIntelEvents(
    [event("x1", now - 12_000, "rss", "rss", "NEWS", "Large BTC move on rumors", 0.9, 0.8)],
    now
  );
  const decisionAnomalyAligned = computeIntelPostureDecision({
    nowTs: now,
    clusters: singleProvider.clusters,
    baseImpact: 0.75,
    baseConfidence: 0.7,
    haltImpactThreshold: 0.95,
    crossVenueAnomaly: true,
    lastState: "NORMAL",
    lastStateTs: now - 60_000,
    haltUntilTs: 0,
    flipCooldownSeconds: 10,
    haltSeconds: 90
  });
  assert(
    decisionAnomalyAligned.state === "HALT",
    `expected HALT when news + anomaly align, got ${decisionAnomalyAligned.state}`
  );

  const decisionNoAlignment = computeIntelPostureDecision({
    nowTs: now,
    clusters: singleProvider.clusters,
    baseImpact: 0.75,
    baseConfidence: 0.7,
    haltImpactThreshold: 0.95,
    crossVenueAnomaly: false,
    lastState: "NORMAL",
    lastStateTs: now - 60_000,
    haltUntilTs: 0,
    flipCooldownSeconds: 10,
    haltSeconds: 90
  });
  assert(
    decisionNoAlignment.state !== "HALT",
    "single provider high-impact without anomaly must not HALT"
  );
}

function run(): void {
  testDedupeAndConfirmations();
  testHaltConfirmationRules();
  // eslint-disable-next-line no-console
  console.log("Intel cluster/posture tests: PASS");
}

run();
