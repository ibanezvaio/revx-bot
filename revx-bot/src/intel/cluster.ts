import { createHash } from "node:crypto";

export type IntelClusterInput = {
  id: string;
  ts: number;
  source: string;
  provider: string;
  kind: string;
  category: string;
  title: string;
  summary?: string;
  impact: number;
  confidence: number;
  direction: string;
  reasonCodes: string[];
  tags: string[];
  url?: string;
};

export type IntelCluster = {
  id: string;
  key: string;
  ts: number;
  category: string;
  kind: string;
  title: string;
  summary: string;
  maxImpact: number;
  avgConfidence: number;
  direction: string;
  sourceCount: number;
  confirmations: number;
  sources: string[];
  providerBuckets: string[];
  reasonCodes: string[];
  tags: string[];
  urls: string[];
  count: number;
};

export type IntelDedupeStats = {
  rawEvents: number;
  uniqueEvents: number;
  duplicateEvents: number;
  cooldownSuppressed: number;
};

export type ClusterOutput = {
  clusters: IntelCluster[];
  dedupeStats: IntelDedupeStats;
  uniqueHighImpactCount1m: number;
};

export type IntelPostureDecisionInput = {
  nowTs: number;
  clusters: IntelCluster[];
  baseImpact: number;
  baseConfidence: number;
  haltImpactThreshold: number;
  crossVenueAnomaly: boolean;
  lastState: "NORMAL" | "CAUTION" | "RISK_OFF" | "HALT";
  lastStateTs: number;
  haltUntilTs: number;
  flipCooldownSeconds: number;
  haltSeconds: number;
};

export type IntelPostureDecision = {
  state: "NORMAL" | "CAUTION" | "RISK_OFF" | "HALT";
  reasons: string[];
  confidence: number;
  haltUntilTs: number;
  confirmedHighImpact: boolean;
  anomalyAligned: boolean;
};

type ClusterAccumulator = {
  id: string;
  key: string;
  ts: number;
  category: string;
  kind: string;
  title: string;
  summary: string;
  maxImpact: number;
  confidenceTotal: number;
  confidenceCount: number;
  direction: string;
  sourceSet: Set<string>;
  providerBucketSet: Set<string>;
  reasonCodes: Set<string>;
  tags: Set<string>;
  urls: Set<string>;
  count: number;
};

export function normalizeIntelTitle(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function providerBucket(provider: string): string {
  const p = String(provider || "").trim().toLowerCase();
  if (!p) return "unknown";
  if (p.includes("newsapi")) return "newsapi";
  if (p.includes("cryptopanic")) return "cryptopanic";
  if (p.includes("gdelt")) return "gdelt";
  if (p.includes("rss")) return "rss-news";
  if (p.includes("exchange-status") || p.includes("coinbase-status") || p.includes("binance-status") || p.includes("kraken-status") || p.includes("cloudflare-status")) {
    return "exchange-status";
  }
  if (p.includes("macro")) return "macro-calendar";
  if (p.includes("signals") || p.includes("system")) return "signals";
  return p;
}

export function clusterIntelEvents(
  events: IntelClusterInput[],
  nowTs: number,
  options?: {
    windowMs?: number;
    dedupeWindowSeconds?: number;
    highImpactThreshold?: number;
    maxHighImpactPerMinute?: number;
  }
): ClusterOutput {
  const windowMs = Math.max(60_000, Number(options?.windowMs) || 60 * 60 * 1000);
  const dedupeWindowMs = Math.max(5_000, (Number(options?.dedupeWindowSeconds) || 180) * 1000);
  const highImpactThreshold = clamp(Number(options?.highImpactThreshold) || 0.7, 0, 1);
  const maxHighImpactPerMinute = Math.max(1, Math.floor(Number(options?.maxHighImpactPerMinute) || 2));
  const cutoffTs = nowTs - windowMs;

  const dedupeByKey = new Map<string, IntelClusterInput>();
  let duplicateEvents = 0;

  for (const event of Array.isArray(events) ? events : []) {
    const ts = normalizeTsMs(event.ts, nowTs);
    if (ts < cutoffTs) continue;
    const normalizedTitle = normalizeIntelTitle(event.title);
    if (!normalizedTitle) continue;
    const sourceKey = String(event.source || "").trim().toLowerCase();
    const category = String(event.category || "NEWS").trim().toUpperCase();
    const key = `${sourceKey}|${category}|${normalizedTitle}`;
    const prev = dedupeByKey.get(key);
    if (prev && Math.abs(ts - normalizeTsMs(prev.ts, nowTs)) <= dedupeWindowMs) {
      duplicateEvents += 1;
      if (ts > normalizeTsMs(prev.ts, nowTs)) {
        dedupeByKey.set(key, { ...event, ts });
      }
      continue;
    }
    dedupeByKey.set(key, { ...event, ts });
  }

  const clusterMap = new Map<string, ClusterAccumulator>();
  for (const event of dedupeByKey.values()) {
    const ts = normalizeTsMs(event.ts, nowTs);
    const category = String(event.category || "NEWS").trim().toUpperCase();
    const normalizedTitle = normalizeIntelTitle(event.title);
    const clusterKey = `${category}|${normalizedTitle}`;
    const existing = clusterMap.get(clusterKey);
    if (!existing) {
      clusterMap.set(clusterKey, {
        id: hash(`${clusterKey}|${ts}`),
        key: clusterKey,
        ts,
        category,
        kind: String(event.kind || "NEWS").toUpperCase(),
        title: String(event.title || "").trim(),
        summary: String(event.summary || event.title || "").trim(),
        maxImpact: clamp(Number(event.impact) || 0, 0, 1),
        confidenceTotal: clamp(Number(event.confidence) || 0, 0, 1),
        confidenceCount: 1,
        direction: String(event.direction || "NEUTRAL").toUpperCase(),
        sourceSet: new Set([String(event.source || "unknown")]),
        providerBucketSet: new Set([providerBucket(event.provider || event.source)]),
        reasonCodes: new Set(Array.isArray(event.reasonCodes) ? event.reasonCodes.map((x) => String(x)) : []),
        tags: new Set(Array.isArray(event.tags) ? event.tags.map((x) => String(x)) : []),
        urls: new Set(event.url ? [String(event.url)] : []),
        count: 1
      });
      continue;
    }

    existing.ts = Math.max(existing.ts, ts);
    if ((Number(event.impact) || 0) >= existing.maxImpact) {
      existing.maxImpact = clamp(Number(event.impact) || 0, 0, 1);
      existing.title = String(event.title || existing.title).trim() || existing.title;
      existing.summary = String(event.summary || event.title || existing.summary).trim() || existing.summary;
      existing.direction = String(event.direction || existing.direction).toUpperCase();
      existing.kind = String(event.kind || existing.kind).toUpperCase();
    }
    existing.confidenceTotal += clamp(Number(event.confidence) || 0, 0, 1);
    existing.confidenceCount += 1;
    existing.count += 1;
    existing.sourceSet.add(String(event.source || "unknown"));
    existing.providerBucketSet.add(providerBucket(event.provider || event.source));
    for (const code of Array.isArray(event.reasonCodes) ? event.reasonCodes : []) {
      existing.reasonCodes.add(String(code));
    }
    for (const tag of Array.isArray(event.tags) ? event.tags : []) {
      existing.tags.add(String(tag));
    }
    if (event.url) existing.urls.add(String(event.url));
  }

  const clusters: IntelCluster[] = Array.from(clusterMap.values())
    .map((cluster) => ({
      id: cluster.id,
      key: cluster.key,
      ts: cluster.ts,
      category: cluster.category,
      kind: cluster.kind,
      title: cluster.title,
      summary: cluster.summary,
      maxImpact: clamp(cluster.maxImpact, 0, 1),
      avgConfidence: cluster.confidenceCount > 0 ? clamp(cluster.confidenceTotal / cluster.confidenceCount, 0, 1) : 0,
      direction: cluster.direction,
      sourceCount: cluster.sourceSet.size,
      confirmations: cluster.providerBucketSet.size,
      sources: Array.from(cluster.sourceSet).sort((a, b) => a.localeCompare(b)),
      providerBuckets: Array.from(cluster.providerBucketSet).sort((a, b) => a.localeCompare(b)),
      reasonCodes: Array.from(cluster.reasonCodes).sort((a, b) => a.localeCompare(b)),
      tags: Array.from(cluster.tags).sort((a, b) => a.localeCompare(b)),
      urls: Array.from(cluster.urls).slice(0, 6),
      count: cluster.count
    }))
    .sort((a, b) => {
      if (b.maxImpact !== a.maxImpact) return b.maxImpact - a.maxImpact;
      return b.ts - a.ts;
    });

  const uniqueHighImpactCount1mRaw = clusters.filter(
    (cluster) => cluster.ts >= nowTs - 60_000 && cluster.maxImpact >= highImpactThreshold
  ).length;

  return {
    clusters,
    dedupeStats: {
      rawEvents: Array.isArray(events) ? events.length : 0,
      uniqueEvents: dedupeByKey.size,
      duplicateEvents,
      cooldownSuppressed: 0
    },
    uniqueHighImpactCount1m: Math.min(uniqueHighImpactCount1mRaw, maxHighImpactPerMinute)
  };
}

export function computeIntelPostureDecision(
  input: IntelPostureDecisionInput
): IntelPostureDecision {
  const nowTs = normalizeTsMs(input.nowTs, Date.now());
  const clusters = Array.isArray(input.clusters) ? input.clusters : [];
  const haltThreshold = clamp(input.haltImpactThreshold, 0, 1);
  const baseImpact = clamp(input.baseImpact, 0, 1);
  const baseConfidence = clamp(input.baseConfidence, 0, 1);

  const confirmedHighImpact = clusters.some(
    (cluster) =>
      cluster.maxImpact >= haltThreshold &&
      cluster.confirmations >= 2 &&
      cluster.category !== "SYSTEM"
  );

  const anomalyAligned = Boolean(input.crossVenueAnomaly) && clusters.some(
    (cluster) =>
      cluster.maxImpact >= 0.7 &&
      cluster.confirmations >= 1 &&
      cluster.category !== "SYSTEM"
  );

  let candidate: "NORMAL" | "CAUTION" | "RISK_OFF" | "HALT" = "NORMAL";
  const reasons: string[] = [];

  if (confirmedHighImpact || anomalyAligned) {
    candidate = "HALT";
    if (confirmedHighImpact) reasons.push("HALT_CONFIRMED_CLUSTER");
    if (anomalyAligned) reasons.push("HALT_NEWS_ANOMALY_ALIGNMENT");
  } else if (baseImpact >= 0.62 || input.crossVenueAnomaly) {
    candidate = "RISK_OFF";
    reasons.push(input.crossVenueAnomaly ? "DE_RISK_CROSSVENUE_ANOMALY" : "DE_RISK_HIGH_IMPACT");
  } else if (baseImpact >= 0.35) {
    candidate = "CAUTION";
    reasons.push("CAUTION_ELEVATED_INTEL");
  } else {
    candidate = "NORMAL";
    reasons.push("NORMAL_LOW_IMPACT");
  }

  let state = candidate;
  let haltUntilTs = Math.max(0, normalizeTsMs(input.haltUntilTs, 0));
  const flipCooldownMs = Math.max(1_000, input.flipCooldownSeconds * 1000);
  const lastStateTs = normalizeTsMs(input.lastStateTs, 0);

  if (input.lastState === "HALT" && haltUntilTs > nowTs && !confirmedHighImpact && !anomalyAligned) {
    state = "RISK_OFF";
    reasons.push("HALT_DECAY_TO_DE_RISK");
  }

  if (state === "HALT") {
    haltUntilTs = nowTs + Math.max(5_000, input.haltSeconds * 1000);
  } else {
    haltUntilTs = Math.max(0, haltUntilTs);
  }

  if (state !== input.lastState && nowTs - lastStateTs < flipCooldownMs) {
    state = input.lastState;
    reasons.push("POSTURE_HYSTERESIS_HOLD");
  }

  return {
    state,
    reasons: Array.from(new Set(reasons)).slice(0, 8),
    confidence: baseConfidence,
    haltUntilTs,
    confirmedHighImpact,
    anomalyAligned
  };
}

function hash(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function normalizeTsMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.max(0, Math.floor(Number(fallback) || 0));
  if (parsed < 10_000_000_000) return Math.floor(parsed * 1000);
  return Math.floor(parsed);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
