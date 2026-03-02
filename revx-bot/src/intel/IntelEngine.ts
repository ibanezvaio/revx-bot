import { createHash } from "node:crypto";
import { BotConfig } from "../config";
import {
  clusterIntelEvents,
  computeIntelPostureDecision,
  IntelCluster
} from "./cluster";
import {
  ExchangeStatusHealth,
  ExchangeStatusSignal,
  fetchExchangeStatusSignals
} from "./providers/ExchangeStatusProvider";
import { Logger } from "../logger";
import { NewsEngine } from "../news/NewsEngine";
import { Headline } from "../news/types";
import { SignalItem, SignalsDebugState, SignalSnapshot } from "../signals/types";
import { SignalsEngine } from "../signals/SignalsEngine";

export type IntelDirection = "UP" | "DOWN" | "NEUTRAL";
export type IntelPostureState = "NORMAL" | "CAUTION" | "RISK_OFF" | "HALT";

export type IntelEvent = {
  ts: number;
  publishedTs?: number;
  source: string;
  sourceDomain?: string;
  provider: string;
  kind: "NEWS" | "MACRO" | "SYSTEM" | "SOCIAL";
  category:
    | "WAR"
    | "OIL"
    | "RATES"
    | "INFLATION"
    | "CRYPTO"
    | "RISK"
    | "EXCHANGE"
    | "SYSTEM"
    | "MACRO"
    | "NEWS";
  title: string;
  summary: string;
  url?: string;
  sentiment?: number;
  direction: IntelDirection;
  impact: number;
  confidence: number;
  symbols: string[];
  tags: string[];
  reasonCodes: string[];
  id: string;
};

export type IntelPosture = {
  ts: number;
  state: IntelPostureState;
  impact: number;
  direction: IntelDirection;
  confidence: number;
  widenBps: number;
  sizeCut: number;
  skewBps: number;
  haltUntilTs: number;
  reasons: string[];
};

export type IntelProviderHealth = {
  provider: string;
  enabled: boolean;
  ok: boolean;
  degraded: boolean;
  excludeFromConfidence?: boolean;
  nonBlockingTag?: string;
  backoffUntilTs?: number;
  lastError: string;
  lastFetchTs: number;
  lastSuccessTs: number;
  lastItemTs: number;
  pollSeconds: number;
  itemsLastHour: number;
  count: number;
};

export type IntelCommentaryDriver = {
  source: string;
  title: string;
  impact: number;
  ageSeconds: number;
  category: string;
  url?: string;
};

export type IntelProviderFreshness = {
  provider: string;
  ok: boolean;
  lastSuccessTs: number;
  lastItemTs: number;
  lastError?: string;
  pollSeconds: number;
  itemsLastHour: number;
};

export type IntelCommentary = {
  headline: string;
  reasons: string[];
  hardHaltReasons: string[];
  softRiskReasons: string[];
  hardRiskState: "OK" | "HALT";
  intelConfidence: number;
  providerHealth: Array<{
    provider: string;
    ok: boolean;
    blocking: "NON_BLOCKING";
    lastError?: string;
  }>;
  topDrivers: IntelCommentaryDriver[];
  decaySeconds: number;
  providerFreshness: IntelProviderFreshness[];
};

export type IntelSnapshot = {
  ts: number;
  posture: IntelPosture;
  postureState: IntelPostureState;
  postureScore: number;
  commentary: IntelCommentary;
  providers: IntelProviderHealth[];
  clusters: IntelCluster[];
  postureHistory: IntelPostureHistoryEntry[];
  items: IntelEvent[];
};

export type IntelPostureHistoryEntry = {
  ts: number;
  state: IntelPostureState;
  impact: number;
  confidence: number;
  reason: string;
};

export type IntelHealth = {
  ts: number;
  providers: IntelProviderHealth[];
  lastError: string;
  running: boolean;
};

export type IntelAdjustment = {
  spreadMult: number;
  sizeMult: number;
  tobModeOverride: "UNCHANGED" | "OFF";
  hardBlock: boolean;
  cooldownSeconds: number;
  reasonCodes: string[];
};

export type IntelDebugSnapshot = {
  ts: number;
  posture: IntelPostureState;
  reasons: string[];
  uniqueHighImpactCount1m: number;
  dedupeStats: {
    rawEvents: number;
    uniqueEvents: number;
    duplicateEvents: number;
    cooldownSuppressed: number;
  };
  adjustmentsApplied: IntelAdjustment;
  guardEnabled: boolean;
};

export type IntelDedupeDebugSnapshot = {
  ts: number;
  ttl: {
    seenIdsSeconds: number;
    seenTitleDomainSeconds: number;
  };
  lastPoll: {
    ts: number;
    received: number;
    emitted: number;
    droppedById: number;
    droppedByTitleDomain: number;
    droppedByTemporal: number;
    droppedByCooldown: number;
  };
  totals: {
    received: number;
    emitted: number;
    droppedById: number;
    droppedByTitleDomain: number;
    droppedByTemporal: number;
    droppedByCooldown: number;
  };
  recentPolls: Array<{
    ts: number;
    received: number;
    emitted: number;
    droppedById: number;
    droppedByTitleDomain: number;
    droppedByTemporal: number;
    droppedByCooldown: number;
  }>;
  cacheSize: {
    seenIds: number;
    seenTitleDomain: number;
    perKeyCooldown: number;
  };
};

const DEFAULT_POSTURE: IntelPosture = {
  ts: 0,
  state: "NORMAL",
  impact: 0,
  direction: "NEUTRAL",
  confidence: 0,
  widenBps: 0,
  sizeCut: 0,
  skewBps: 0,
  haltUntilTs: 0,
  reasons: ["INTEL_IDLE"]
};

const EMPTY_COMMENTARY: IntelCommentary = {
  headline: "NORMAL: Intel stream idle",
  reasons: ["INTEL_NOT_READY"],
  hardHaltReasons: [],
  softRiskReasons: ["INTEL_NOT_READY"],
  hardRiskState: "OK",
  intelConfidence: 0,
  providerHealth: [],
  topDrivers: [],
  decaySeconds: 0,
  providerFreshness: []
};

const DEFAULT_INTEL_FAST_POLL_SECONDS = 10;
const DEFAULT_INTEL_SLOW_POLL_SECONDS = 60;
const CAUTION_ENTER_PERSIST_MS = 90_000;
const CAUTION_MIN_HOLD_MS = 5 * 60_000;
const MAX_PROVIDER_CONFIDENCE_PENALTY = 0.05;

export class IntelEngine {
  private running = false;
  private fastTimer: NodeJS.Timeout | null = null;
  private slowTimer: NodeJS.Timeout | null = null;
  private items: IntelEvent[] = [];
  private posture: IntelPosture = { ...DEFAULT_POSTURE };
  private providers = new Map<string, IntelProviderHealth>();
  private lastError = "";
  private haltUntilTs = 0;
  private postureStateTs = 0;
  private lastDedupeStats = {
    rawEvents: 0,
    uniqueEvents: 0,
    duplicateEvents: 0,
    cooldownSuppressed: 0
  };
  private readonly perKeyCooldown = new Map<string, number>();
  private readonly seenIds = new Map<string, number>();
  private readonly seenTitleDomain = new Map<string, number>();
  private dedupeLastPoll: IntelDedupeDebugSnapshot["lastPoll"] = {
    ts: 0,
    received: 0,
    emitted: 0,
    droppedById: 0,
    droppedByTitleDomain: 0,
    droppedByTemporal: 0,
    droppedByCooldown: 0
  };
  private dedupeTotals: IntelDedupeDebugSnapshot["totals"] = {
    received: 0,
    emitted: 0,
    droppedById: 0,
    droppedByTitleDomain: 0,
    droppedByTemporal: 0,
    droppedByCooldown: 0
  };
  private dedupePollHistory: IntelDedupeDebugSnapshot["recentPolls"] = [];
  private postureHistory: IntelPostureHistoryEntry[] = [];
  private lastHistoryReason = "";
  private lastHistoryState: IntelPostureState = "NORMAL";
  private lastHistoryTs = 0;
  private cautionCandidateSinceTs = 0;
  private cautionHoldUntilTs = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly newsEngine?: NewsEngine,
    private readonly signalsEngine?: SignalsEngine
  ) {
    this.seedProvider("gdelt", this.config.enableGdelt);
    this.seedProvider("rss", this.config.enableRss);
    this.seedProvider("cryptopanic", this.config.enableCryptopanic);
    this.seedProvider("newsapi", this.config.enableNewsapi);
    this.seedProvider("x", this.config.enableX);
    this.seedProvider("signals", true);
    this.seedProvider("news", true);
    this.seedProvider("coinbase-status", true);
    this.seedProvider("binance-status", true);
    this.seedProvider("kraken-status", true);
    this.seedProvider("cloudflare-status", true);
  }

  start(): void {
    if (this.running || !this.config.enableIntel) return;
    this.running = true;
    void this.refreshFast();
    void this.refreshSlow();
    this.fastTimer = setInterval(() => {
      void this.refreshFast();
    }, Math.max(5_000, this.getFastPollSeconds() * 1000));
    this.slowTimer = setInterval(() => {
      void this.refreshSlow();
    }, Math.max(15_000, this.getSlowPollSeconds() * 1000));
    this.logger.info(
      {
        fastPollSeconds: this.getFastPollSeconds(),
        slowPollSeconds: this.getSlowPollSeconds(),
        maxItems: this.config.intelMaxItems
      },
      "Intel engine started"
    );
  }

  stop(): void {
    this.running = false;
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    this.fastTimer = null;
    this.slowTimer = null;
  }

  getIntelSnapshot(nowTs = Date.now()): IntelSnapshot {
    const posture = this.computePosture(nowTs);
    const clusterResult = clusterIntelEvents(this.items, nowTs, {
      windowMs: this.config.intelDedupeWindowSeconds * 1000,
      dedupeWindowSeconds: this.config.intelDedupeWindowSeconds,
      highImpactThreshold: this.config.intelHardHaltImpact,
      maxHighImpactPerMinute: this.config.intelMaxHighImpactPerMinute
    });
    const providers = this.getProviders(nowTs);
    const commentary = this.buildCommentary(nowTs, posture, providers);
    return {
      ts: nowTs,
      posture,
      postureState: posture.state,
      postureScore: clamp(posture.impact * 0.7 + posture.confidence * 0.3, 0, 1),
      commentary,
      providers,
      clusters: clusterResult.clusters,
      postureHistory: this.postureHistory.slice(-240).map((row) => ({ ...row })),
      items: this.items.slice(0, this.config.intelMaxItems).map((row) => ({
        ...row,
        symbols: [...row.symbols],
        tags: [...row.tags],
        reasonCodes: [...row.reasonCodes]
      }))
    };
  }

  getIntelCommentary(nowTs = Date.now()): {
    ts: number;
    posture: IntelPostureState;
    commentary: IntelCommentary;
  } {
    const snapshot = this.getIntelSnapshot(nowTs);
    return {
      ts: nowTs,
      posture: snapshot.posture.state,
      commentary: snapshot.commentary
    };
  }

  getIntelHealth(nowTs = Date.now()): IntelHealth {
    return {
      ts: nowTs,
      providers: this.getProviders(nowTs),
      lastError: this.lastError,
      running: this.running
    };
  }

  getPosture(nowTs = Date.now()): IntelPosture {
    return this.computePosture(nowTs);
  }

  getAdjustment(nowTs = Date.now(), postureInput?: IntelPosture): IntelAdjustment {
    const posture = postureInput ?? this.computePosture(nowTs);
    const reasons = [...posture.reasons];
    const crossVenuePressure = this.hasCrossVenuePressure(nowTs);
    const providerDegraded = this.hasProviderDegraded();
    const guardEnabled =
      this.config.enableIntelTradeGuard &&
      !this.config.intelHardHaltOnly;

    let spreadMult = 1;
    let sizeMult = 1;
    let tobModeOverride: "UNCHANGED" | "OFF" = "UNCHANGED";
    let hardBlock = false;
    const reasonCodes: string[] = [];

    switch (posture.state) {
      case "CAUTION":
        spreadMult = 1.2;
        sizeMult = 0.8;
        reasonCodes.push("INTEL_SOFTEN_CAUTION");
        break;
      case "RISK_OFF":
        spreadMult = 1.5;
        sizeMult = 0.6;
        tobModeOverride = "OFF";
        reasonCodes.push("INTEL_SOFTEN_RISK_OFF");
        break;
      case "HALT":
        if (this.config.intelMaxAction === "halt" && guardEnabled) {
          hardBlock = true;
          tobModeOverride = "OFF";
          reasonCodes.push("INTEL_HALT_HARD_GUARD");
        } else {
          spreadMult = 1.5;
          sizeMult = 0.6;
          tobModeOverride = "OFF";
          reasonCodes.push(this.config.intelAlwaysOn ? "INTEL_HALT_SOFTEN_ALWAYS_ON" : "INTEL_HALT_SOFTEN");
        }
        break;
      default:
        break;
    }

    if (crossVenuePressure) {
      if (this.config.intelCrossvenueAction === "ignore") {
        spreadMult = Math.max(1, spreadMult);
        sizeMult = Math.min(1, Math.max(sizeMult, 0.9));
        hardBlock = false;
        reasonCodes.push("INTEL_CROSSVENUE_IGNORE");
      } else if (this.config.intelCrossvenueAction === "soften") {
        spreadMult = Math.max(spreadMult, 1.2);
        sizeMult = Math.min(sizeMult, 0.85);
        hardBlock = false;
        reasonCodes.push("INTEL_CROSSVENUE_SOFTEN");
      } else if (this.config.intelCrossvenueAction === "halt") {
        spreadMult = Math.max(spreadMult, 1.5);
        sizeMult = Math.min(sizeMult, 0.6);
        reasonCodes.push("INTEL_CROSSVENUE_SOFTEN_FROM_HALT");
      }
    }

    if (providerDegraded) {
      reasonCodes.push("INTEL_PROVIDER_DEGRADED_NON_BLOCKING");
    }

    for (const reason of reasons) {
      reasonCodes.push(reason);
    }

    return {
      spreadMult: clamp(spreadMult, 1, Math.max(1, this.config.intelMaxSpreadMult)),
      sizeMult: clamp(sizeMult, Math.max(0.05, this.config.intelMinSizeMult), 1),
      tobModeOverride,
      hardBlock,
      cooldownSeconds: Math.max(1, this.config.intelEventCooldownSeconds),
      reasonCodes: Array.from(new Set(reasonCodes))
    };
  }

  getDebugSnapshot(nowTs = Date.now()): IntelDebugSnapshot {
    const posture = this.computePosture(nowTs);
    const clusterResult = clusterIntelEvents(this.items, nowTs, {
      windowMs: this.config.intelDedupeWindowSeconds * 1000,
      dedupeWindowSeconds: this.config.intelDedupeWindowSeconds,
      highImpactThreshold: this.config.intelHardHaltImpact,
      maxHighImpactPerMinute: this.config.intelMaxHighImpactPerMinute
    });
    return {
      ts: nowTs,
      posture: posture.state,
      reasons: [...posture.reasons],
      uniqueHighImpactCount1m: clusterResult.uniqueHighImpactCount1m,
      dedupeStats: {
        ...this.lastDedupeStats,
        duplicateEvents: Math.max(this.lastDedupeStats.duplicateEvents, clusterResult.dedupeStats.duplicateEvents)
      },
      adjustmentsApplied: this.getAdjustment(nowTs, posture),
      guardEnabled: this.config.enableIntelTradeGuard && !this.config.intelHardHaltOnly
    };
  }

  getDedupeDebugSnapshot(nowTs = Date.now()): IntelDedupeDebugSnapshot {
    this.pruneDedupeCaches(nowTs);
    return {
      ts: nowTs,
      ttl: {
        seenIdsSeconds: 24 * 60 * 60,
        seenTitleDomainSeconds: 60 * 60
      },
      lastPoll: { ...this.dedupeLastPoll },
      totals: { ...this.dedupeTotals },
      recentPolls: this.dedupePollHistory.map((row) => ({ ...row })),
      cacheSize: {
        seenIds: this.seenIds.size,
        seenTitleDomain: this.seenTitleDomain.size,
        perKeyCooldown: this.perKeyCooldown.size
      }
    };
  }

  private async refreshFast(): Promise<void> {
    if (!this.running) return;
    const nowTs = Date.now();
    if (!this.shouldUseFastPoll(nowTs)) return;
    try {
      const signals = this.signalsEngine?.getSnapshot();
      const signalEvents = this.fromSignals(signals);
      const newsEvents = this.fromNews(this.newsEngine?.getSnapshot().items ?? []);
      this.mergeEvents([...signalEvents, ...newsEvents], nowTs);
      this.syncSignalsHealth(this.signalsEngine?.getDebugState(), nowTs);
      this.syncNewsHealth(nowTs);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.markProviderError("signals", this.lastError, nowTs);
    }
  }

  private async refreshSlow(): Promise<void> {
    if (!this.running) return;
    const nowTs = Date.now();
    try {
      const signals = this.signalsEngine?.getSnapshot();
      const signalEvents = this.fromSignals(signals);
      const newsEvents = this.fromNews(this.newsEngine?.getSnapshot().items ?? []);
      const exchangeStatus = await fetchExchangeStatusSignals(nowTs);
      const exchangeEvents = this.fromExchangeStatus(exchangeStatus.items);
      this.mergeEvents([...signalEvents, ...newsEvents, ...exchangeEvents], nowTs);
      this.syncSignalsHealth(this.signalsEngine?.getDebugState(), nowTs);
      this.syncNewsHealth(nowTs);
      this.syncExchangeStatusHealth(exchangeStatus.health, nowTs);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.markProviderError("news", this.lastError, nowTs);
    }
  }

  private shouldUseFastPoll(nowTs: number): boolean {
    const postureState = this.posture.ts > 0 ? this.posture.state : "NORMAL";
    if (postureState !== "NORMAL") return true;
    const aggregateState = String(this.signalsEngine?.getLatestAggregate().state || "NORMAL").toUpperCase();
    if (aggregateState !== "NORMAL" && aggregateState !== "CALM") return true;
    return false;
  }

  private fromNews(items: Headline[]): IntelEvent[] {
    const out: IntelEvent[] = [];
    for (const row of Array.isArray(items) ? items : []) {
      const provider = this.resolveNewsProvider(row);
      if (!this.allowNewsProviderName(provider)) continue;
      const category = mapNewsCategory(row.category, row.tags);
      const reasonCodes = buildReasonCodes(category, row.tags, String(row.source || provider));
      const kind: IntelEvent["kind"] = provider === "newsapi" || provider === "cryptopanic"
        ? "NEWS"
        : row.category === "macro" || row.category === "rates"
          ? "MACRO"
          : "NEWS";
      out.push({
        ts: normalizeTsMs(row.ts, Date.now()),
        publishedTs: normalizeTsMs(row.ts, Date.now()),
        source: String(row.source || provider || "news"),
        provider,
        kind,
        category,
        title: String(row.title || "").trim(),
        summary: String(row.title || "").trim(),
        url: row.url ? String(row.url) : undefined,
        sentiment: directionToSentiment(row.direction),
        direction: normalizeDirection(row.direction),
        impact: clamp(Number(row.impact) || 0, 0, 1),
        confidence: clamp(Number(row.confidence) || 0, 0, 1),
        symbols: Array.isArray(row.symbols) ? row.symbols.map((x) => String(x)) : [],
        tags: Array.isArray(row.tags) ? row.tags.map((x) => String(x)) : [],
        reasonCodes,
        id: String((row as { id?: unknown }).id || "").trim()
      });
    }
    return out;
  }

  private fromSignals(snapshot: SignalSnapshot | undefined): IntelEvent[] {
    if (!snapshot || !Array.isArray(snapshot.items)) return [];
    const out: IntelEvent[] = [];
    for (const row of snapshot.items) {
      const category = mapSignalCategory(row.category);
      const tags = Array.isArray(row.tags) ? row.tags : [];
      out.push({
        ts: normalizeTsMs(row.ts, Date.now()),
        publishedTs: normalizeTsMs(row.ts, Date.now()),
        source: String(row.source || "signals"),
        provider: resolveSignalProvider(row),
        kind: mapSignalKind(row.kind),
        category,
        title: String(row.title || "").trim(),
        summary: row.analysis?.summary ? String(row.analysis.summary) : String(row.title || "").trim(),
        url: row.url ? String(row.url) : undefined,
        sentiment: directionToSentiment(row.direction),
        direction: normalizeDirection(row.direction),
        impact: clamp(Number(row.impact) || 0, 0, 1),
        confidence: clamp(Number(row.confidence) || 0, 0, 1),
        symbols: Array.isArray(row.symbols) ? row.symbols.map((x) => String(x)) : [],
        tags: tags.map((x) => String(x)),
        reasonCodes: buildReasonCodes(category, tags, String(row.source || "signals")),
        id: String((row as { id?: unknown }).id || "").trim()
      });
    }
    return out;
  }

  private fromExchangeStatus(items: ExchangeStatusSignal[]): IntelEvent[] {
    const out: IntelEvent[] = [];
    for (const row of Array.isArray(items) ? items : []) {
      const errorTag = classifyProviderIssueTag(
        `${String(row.title || "")} ${String(row.summary || "")} ${Array.isArray(row.reasonCodes) ? row.reasonCodes.join(" ") : ""}`
      );
      const nonBlockingReasonCode = errorTag || "NON_BLOCKING_PROVIDER_STATUS";
      out.push({
        ts: normalizeTsMs(row.ts, Date.now()),
        publishedTs: normalizeTsMs(row.ts, Date.now()),
        source: String(row.source || row.provider || "exchange-status"),
        provider: String(row.provider || "exchange-status").toLowerCase(),
        kind: "SYSTEM",
        category: row.category === "EXCHANGE" ? "EXCHANGE" : "SYSTEM",
        title: String(row.title || "").trim(),
        summary: String(row.summary || row.title || "").trim(),
        url: row.url ? String(row.url) : undefined,
        sentiment: -0.5,
        direction: normalizeDirection(row.direction),
        impact: clamp(errorTag ? 0 : Math.min(Number(row.impact) || 0, 0.25), 0, 1),
        confidence: clamp(Math.min(Number(row.confidence) || 0, 0.45), 0, 1),
        symbols: ["BTC", "USD"],
        tags: Array.isArray(row.tags)
          ? Array.from(new Set([...row.tags.map((x) => String(x)), "non-blocking"]))
          : ["exchange-status", "non-blocking"],
        reasonCodes: Array.isArray(row.reasonCodes)
          ? Array.from(
              new Set([
                ...row.reasonCodes.map((x) => String(x)),
                "NON_BLOCKING_PROVIDER_STATUS",
                nonBlockingReasonCode
              ])
            )
          : ["EXCHANGE_STATUS_DEGRADED", "NON_BLOCKING_PROVIDER_STATUS", nonBlockingReasonCode],
        id: String((row as { id?: unknown }).id || "").trim()
      });
    }
    return out;
  }

  private mergeEvents(events: IntelEvent[], nowTs: number): void {
    const byId = new Map<string, IntelEvent>();
    const byTemporalKey = new Map<string, IntelEvent>();
    const batchSeenIds = new Set<string>();
    const batchSeenTitleDomain = new Set<string>();
    const dedupeWindowMs = Math.max(5_000, this.config.intelDedupeWindowSeconds * 1000);
    const itemTtlMs = Math.max(60_000, this.config.intelItemTtlSeconds * 1000);
    const seenIdTtlMs = 24 * 60 * 60 * 1000;
    const seenTitleDomainTtlMs = 60 * 60 * 1000;
    const cooldownMs = Math.max(1_000, this.config.intelEventCooldownSeconds * 1000);
    const dedupeCutoff = nowTs - dedupeWindowMs;
    const itemTtlCutoff = nowTs - itemTtlMs;
    this.pruneDedupeCaches(nowTs);
    const rawEvents = events.length;
    let duplicateEvents = 0;
    let droppedById = 0;
    let droppedByTitleDomain = 0;
    let cooldownSuppressed = 0;
    let emitted = 0;

    for (const row of this.items) {
      if (row.ts < itemTtlCutoff) continue;
      byId.set(row.id, row);
      if (row.ts >= dedupeCutoff) {
        byTemporalKey.set(eventDedupeKey(row), row);
      }
    }

    for (const incoming of events) {
      if (!incoming.title) continue;
      const row = this.canonicalizeEvent(incoming, nowTs);
      const key = eventDedupeKey(row);
      const previousByKey = byTemporalKey.get(key);
      if (previousByKey && Math.abs(row.ts - previousByKey.ts) <= dedupeWindowMs) {
        const materialChange = hasMaterialIntelChange(previousByKey, row);
        if (!materialChange) {
          duplicateEvents += 1;
          if (row.ts > previousByKey.ts) {
            byId.set(previousByKey.id, row);
            byTemporalKey.set(key, row);
          }
          continue;
        }
      }
      const idKey = row.id;
      if (batchSeenIds.has(idKey) || (this.seenIds.get(idKey) ?? 0) > row.ts) {
        droppedById += 1;
        continue;
      }
      const titleDomainKey = eventTitleDomainKey(row);
      if (
        titleDomainKey &&
        (batchSeenTitleDomain.has(titleDomainKey) || (this.seenTitleDomain.get(titleDomainKey) ?? 0) > row.ts)
      ) {
        droppedByTitleDomain += 1;
        continue;
      }
      const cooldownUntil = this.perKeyCooldown.get(key) ?? 0;
      const isPotentialHalt = row.impact >= this.config.intelHardHaltImpact;
      const materialChangeDuringCooldown = previousByKey ? hasMaterialIntelChange(previousByKey, row) : false;
      if (!isPotentialHalt && cooldownUntil > row.ts && !materialChangeDuringCooldown) {
        cooldownSuppressed += 1;
        continue;
      }
      this.perKeyCooldown.set(key, row.ts + cooldownMs);
      batchSeenIds.add(idKey);
      this.seenIds.set(idKey, row.ts + seenIdTtlMs);
      if (titleDomainKey) {
        batchSeenTitleDomain.add(titleDomainKey);
        this.seenTitleDomain.set(titleDomainKey, row.ts + seenTitleDomainTtlMs);
      }
      const previousById = byId.get(row.id);
      if (!previousById || row.ts >= previousById.ts) {
        byId.set(row.id, row);
        emitted += 1;
      }
      byTemporalKey.set(key, row);
    }

    this.lastDedupeStats = {
      rawEvents,
      uniqueEvents: byId.size,
      duplicateEvents: duplicateEvents + droppedById + droppedByTitleDomain,
      cooldownSuppressed
    };
    this.dedupeLastPoll = {
      ts: nowTs,
      received: rawEvents,
      emitted,
      droppedById,
      droppedByTitleDomain,
      droppedByTemporal: duplicateEvents,
      droppedByCooldown: cooldownSuppressed
    };
    this.dedupeTotals.received += rawEvents;
    this.dedupeTotals.emitted += emitted;
    this.dedupeTotals.droppedById += droppedById;
    this.dedupeTotals.droppedByTitleDomain += droppedByTitleDomain;
    this.dedupeTotals.droppedByTemporal += duplicateEvents;
    this.dedupeTotals.droppedByCooldown += cooldownSuppressed;
    this.dedupePollHistory.push({ ...this.dedupeLastPoll });
    if (this.dedupePollHistory.length > 120) {
      this.dedupePollHistory = this.dedupePollHistory.slice(this.dedupePollHistory.length - 120);
    }

    for (const [key, untilTs] of this.perKeyCooldown.entries()) {
      if (untilTs < nowTs - dedupeWindowMs) {
        this.perKeyCooldown.delete(key);
      }
    }
    this.pruneDedupeCaches(nowTs);

    this.items = Array.from(byId.values())
      .filter((row) => row.ts >= itemTtlCutoff)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, this.config.intelMaxItems);
    this.posture = this.computePosture(nowTs);
  }

  private canonicalizeEvent(incoming: IntelEvent, nowTs: number): IntelEvent {
    const ts = normalizeTsMs(incoming.ts, nowTs, nowTs);
    const publishedTs = normalizeTsMs(incoming.publishedTs ?? incoming.ts, ts, nowTs);
    const source = String(incoming.source || incoming.provider || "intel").trim();
    const title = String(incoming.title || "").trim();
    const url = normalizeIntelUrl(incoming.url);
    const sourceDomain =
      normalizeSourceDomain(incoming.sourceDomain) ||
      normalizeSourceDomain(extractDomainFromUrl(url)) ||
      normalizeSourceDomain(extractDomainFromSource(source));
    const normalizedTitle = normalizeTitleForDedupe(title);
    const minuteBucket = Math.floor((publishedTs || ts) / 60_000);
    const providedId = String(incoming.id || "").trim();
    const stableIdSeed = `${source.toLowerCase()}|${normalizedTitle}|${String(url || "").toLowerCase()}|${minuteBucket}`;
    const id = providedId.length > 0 ? providedId : hashEvent(stableIdSeed);
    return {
      ...incoming,
      ts,
      publishedTs,
      source,
      sourceDomain: sourceDomain || undefined,
      title,
      summary: String(incoming.summary || title).trim(),
      url,
      id,
      tags: Array.from(
        new Set(
          incoming.tags
            .map((x) => String(x).trim())
            .filter((x) => x.length > 0)
        )
      ),
      reasonCodes: Array.from(
        new Set(
          incoming.reasonCodes
            .map((x) => String(x).trim())
            .filter((x) => x.length > 0)
        )
      )
    };
  }

  private pruneDedupeCaches(nowTs: number): void {
    pruneExpiryMap(this.seenIds, nowTs, 20_000);
    pruneExpiryMap(this.seenTitleDomain, nowTs, 20_000);
  }

  private computePosture(nowTs: number): IntelPosture {
    const headlineMaxAgeMs = Math.max(10_000, this.config.intelHeadlineMaxAgeSeconds * 1000);
    const anomalyMaxAgeMs = Math.max(10_000, this.config.intelAnomalyMaxAgeSeconds * 1000);
    let weightedImpact = 0;
    let weightedDirection = 0;
    let weightedConfidence = 0;
    let weightSum = 0;
    const recentHighImpactUniqueKeys = new Set<string>();
    const freshItems: IntelEvent[] = [];
    const highImpactClamp = Math.max(1, this.config.intelMaxHighImpactPerMinute);

    for (const item of this.items) {
      const ageMs = Math.max(0, nowTs - item.ts);
      const isAnomaly = this.isAnomalyEvent(item);
      const maxAgeMs = isAnomaly ? anomalyMaxAgeMs : headlineMaxAgeMs;
      if (ageMs > maxAgeMs) continue;
      freshItems.push(item);
      const decayTauMs = isAnomaly ? 120_000 : 300_000;
      const decay = Math.exp(-ageMs / Math.max(1, decayTauMs));
      const sourceWeight = sourceWeightFor(item.source);
      const provider = this.providers.get(String(item.provider || "").toLowerCase());
      const providerHealthy = provider ? provider.ok : true;
      const providerNonBlocking = this.isNonBlockingProvider(item.provider);
      const weight = clamp(decay * sourceWeight * (providerHealthy ? 1 : 0.55), 0.02, 1);
      const dir = item.direction === "UP" ? 1 : item.direction === "DOWN" ? -1 : 0;
      let impactWeight = item.impact;
      let confidenceWeight = item.confidence;
      if (!providerHealthy) {
        impactWeight = Math.min(impactWeight, 0.3);
        confidenceWeight = Math.min(confidenceWeight, 0.45);
      }
      if (providerNonBlocking) {
        impactWeight = Math.min(impactWeight, 0.42);
      }
      if (item.impact >= 0.7) {
        recentHighImpactUniqueKeys.add(eventDedupeKey(item));
      }
      if (item.impact >= 0.7 && recentHighImpactUniqueKeys.size > highImpactClamp) {
        impactWeight = Math.min(impactWeight, 0.55);
      }
      weightedImpact += impactWeight * weight;
      weightedDirection += dir * item.impact * weight;
      weightedConfidence += confidenceWeight * weight;
      weightSum += weight;
    }
    const recentHighImpact = recentHighImpactUniqueKeys.size;

    const impact = clamp(Math.min(2, weightedImpact) / 2, 0, 1);
    const directionScore = weightSum > 0 ? weightedDirection / weightSum : 0;
    const direction: IntelDirection = directionScore > 0.05 ? "UP" : directionScore < -0.05 ? "DOWN" : "NEUTRAL";
    let confidence = clamp(weightSum > 0 ? weightedConfidence / weightSum : 0, 0, 1);
    const providerPenalty = this.computeProviderConfidencePenalty();
    confidence = clamp(confidence - providerPenalty, 0, 1);
    const providers = this.getProviders(nowTs);
    const enabledProviders = providers.filter(
      (row) => this.isProviderEnabled(row.provider) && !row.excludeFromConfidence
    );
    const staleProviderWindowMs = Math.max(30_000, this.config.intelStaleSeconds * 1000);
    const healthyProviders = enabledProviders.filter((row) => {
      if (!row.ok) return false;
      const lastActiveTs = Math.max(Number(row.lastItemTs) || 0, Number(row.lastSuccessTs) || 0);
      if (lastActiveTs <= 0) return false;
      return nowTs - lastActiveTs <= staleProviderWindowMs;
    });
    const providerOkCount = healthyProviders.length;
    const providerReadinessOk = providerOkCount >= Math.max(1, this.config.intelProviderMinOk);
    const allFreshItemsStale = freshItems.length === 0 && this.items.length > 0;
    if (!providerReadinessOk || allFreshItemsStale) {
      confidence = Math.min(confidence, 0.55);
    }
    const cappedImpact = (!providerReadinessOk || allFreshItemsStale)
      ? Math.min(impact, 0.45)
      : impact;
    const clusterResult = clusterIntelEvents(freshItems, nowTs, {
      windowMs: this.config.intelDedupeWindowSeconds * 1000,
      dedupeWindowSeconds: this.config.intelDedupeWindowSeconds,
      highImpactThreshold: this.config.intelHardHaltImpact,
      maxHighImpactPerMinute: this.config.intelMaxHighImpactPerMinute
    });
    const crossVenueAnomaly = this.hasCrossVenuePressure(nowTs);
    const decision = computeIntelPostureDecision({
      nowTs,
      clusters: clusterResult.clusters,
      baseImpact: cappedImpact,
      baseConfidence: confidence,
      haltImpactThreshold: this.config.intelHardHaltImpact,
      crossVenueAnomaly: providerReadinessOk ? crossVenueAnomaly : false,
      lastState: this.posture.state,
      lastStateTs: this.postureStateTs,
      haltUntilTs: this.haltUntilTs,
      flipCooldownSeconds: this.config.intelEventCooldownSeconds,
      haltSeconds: this.config.intelHaltSeconds
    });

    let state: IntelPostureState = "NORMAL";
    this.haltUntilTs = Math.max(0, decision.haltUntilTs);
    const reasons: string[] = decision.reasons.filter(
      (reason) => !/^HALT_|^DE_RISK_HIGH_IMPACT|^CAUTION_ELEVATED_INTEL|^NORMAL_LOW_IMPACT/.test(reason)
    );
    if (decision.state !== "NORMAL" && !crossVenueAnomaly) {
      reasons.push(`NON_BLOCKING_INTEL_CLUSTER_${decision.state}`);
    }
    if (recentHighImpact >= 1) reasons.push(`RECENT_HIGH_IMPACT (${Math.min(recentHighImpact, this.config.intelMaxHighImpactPerMinute)})`);
    if (clusterResult.uniqueHighImpactCount1m >= 1) {
      reasons.push(`UNIQUE_HIGH_IMPACT_1M (${clusterResult.uniqueHighImpactCount1m})`);
    }
    if (!providerReadinessOk) {
      reasons.push(`NON_BLOCKING_PROVIDER_READINESS_LOW (${providerOkCount}/${Math.max(1, this.config.intelProviderMinOk)})`);
    }
    if (allFreshItemsStale) {
      reasons.push("NON_BLOCKING_INTEL_ITEMS_STALE");
    }
    if (providerPenalty > 0) reasons.push(`NON_BLOCKING_PROVIDER_CONFIDENCE_PENALTY (${providerPenalty.toFixed(2)})`);
    for (const provider of providers) {
      if (!provider.lastError || provider.lastError.trim().length === 0) continue;
      const tag = classifyProviderIssueTag(`${provider.nonBlockingTag || ""} ${provider.lastError}`);
      if (!tag) continue;
      reasons.push(`${tag} (${provider.provider})`);
    }
    const topReasonCode = freshItems[0]?.reasonCodes?.[0];
    if (topReasonCode) reasons.push(topReasonCode);

    // Provider/news/status degradation is always non-blocking; posture is market-signal driven.
    const cautionSignal = crossVenueAnomaly;
    const riskOffSignal = crossVenueAnomaly && cappedImpact >= 0.75 && confidence >= 0.55;
    if (cautionSignal) {
      if (this.cautionCandidateSinceTs <= 0) {
        this.cautionCandidateSinceTs = nowTs;
      }
      const persistedMs = nowTs - this.cautionCandidateSinceTs;
      if (persistedMs >= CAUTION_ENTER_PERSIST_MS) {
        state = riskOffSignal ? "RISK_OFF" : "CAUTION";
        this.cautionHoldUntilTs = Math.max(this.cautionHoldUntilTs, nowTs + CAUTION_MIN_HOLD_MS);
        reasons.push(
          `CAUTION_PERSISTED (${Math.floor(persistedMs / 1000)}s >= ${Math.floor(
            CAUTION_ENTER_PERSIST_MS / 1000
          )}s)`
        );
      } else {
        reasons.push(
          `CAUTION_PENDING_PERSISTENCE (${Math.floor(persistedMs / 1000)}s < ${Math.floor(
            CAUTION_ENTER_PERSIST_MS / 1000
          )}s)`
        );
      }
    } else {
      this.cautionCandidateSinceTs = 0;
      if (
        (this.posture.state === "CAUTION" || this.posture.state === "RISK_OFF") &&
        nowTs < this.cautionHoldUntilTs
      ) {
        state = "CAUTION";
        reasons.push(
          `CAUTION_HOLD_ACTIVE (${Math.ceil((this.cautionHoldUntilTs - nowTs) / 1000)}s remaining)`
        );
      } else {
        this.cautionHoldUntilTs = 0;
      }
    }

    if (state !== this.posture.state) {
      this.postureStateTs = nowTs;
    }

    const widenBps =
      state === "NORMAL" ? 0 : clamp(cappedImpact * this.config.intelMaxWidenBps, 0, this.config.intelMaxWidenBps);
    const sizeCut =
      state === "NORMAL" ? 0 : clamp(cappedImpact * this.config.intelMaxSizeCut, 0, this.config.intelMaxSizeCut);
    const skewBps =
      state === "NORMAL"
        ? 0
        : clamp(
            -directionScore * this.config.intelMaxSkewBps * Math.max(0.3, impact),
            -this.config.intelMaxSkewBps,
            this.config.intelMaxSkewBps
          );

    const posture: IntelPosture = {
      ts: nowTs,
      state,
      impact: cappedImpact,
      direction,
      confidence,
      widenBps,
      sizeCut,
      skewBps,
      haltUntilTs: Math.max(this.haltUntilTs, 0),
      reasons: Array.from(new Set(reasons)).slice(0, 8)
    };
    this.recordPostureHistory(posture);
    return posture;
  }

  // Keep a compact in-memory timeline for /intel when client-side history is cold.
  private recordPostureHistory(posture: IntelPosture): void {
    const nowTs = normalizeTsMs(posture.ts, Date.now());
    const reason = String(posture.reasons[0] || "NO_REASON").slice(0, 140);
    const stateChanged = posture.state !== this.lastHistoryState;
    const reasonChanged = reason !== this.lastHistoryReason;
    const minSampleGapMs = 30_000;
    if (!stateChanged && !reasonChanged && nowTs - this.lastHistoryTs < minSampleGapMs) {
      return;
    }
    this.lastHistoryState = posture.state;
    this.lastHistoryReason = reason;
    this.lastHistoryTs = nowTs;
    this.postureHistory.push({
      ts: nowTs,
      state: posture.state,
      impact: clamp(posture.impact, 0, 1),
      confidence: clamp(posture.confidence, 0, 1),
      reason
    });
    if (this.postureHistory.length > 600) {
      this.postureHistory = this.postureHistory.slice(this.postureHistory.length - 600);
    }
  }

  private buildCommentary(
    nowTs: number,
    posture: IntelPosture,
    providers: IntelProviderHealth[]
  ): IntelCommentary {
    if (!this.config.enableIntel) {
      return {
        ...EMPTY_COMMENTARY,
        headline: "NORMAL: Intel disabled",
        reasons: ["INTEL_DISABLED"],
        hardHaltReasons: [],
        softRiskReasons: ["INTEL_DISABLED"],
        hardRiskState: "OK",
        intelConfidence: 0,
        providerHealth: providers.map((row) => ({
          provider: row.provider,
          ok: row.ok,
          blocking: "NON_BLOCKING" as const,
          lastError: row.lastError || undefined
        })),
        providerFreshness: providers.map((row) => ({
          provider: row.provider,
          ok: row.ok,
          lastSuccessTs: row.lastSuccessTs,
          lastItemTs: row.lastItemTs,
          lastError: row.lastError || undefined,
          pollSeconds: row.pollSeconds,
          itemsLastHour: row.itemsLastHour
        }))
      };
    }

    const topDrivers = this.computeTopDrivers(nowTs);
    const providerFreshness = providers.map((row) => ({
      provider: row.provider,
      ok: row.ok,
      lastSuccessTs: row.lastSuccessTs,
      lastItemTs: row.lastItemTs,
      lastError: row.lastError || undefined,
      pollSeconds: row.pollSeconds,
      itemsLastHour: row.itemsLastHour
    }));

    const reasons: string[] = [];
    for (const reason of posture.reasons) reasons.push(reason);

    const highRecent = topDrivers.filter(
      (row) => row.impact >= 0.7 && row.ageSeconds <= this.config.intelHeadlineMaxAgeSeconds
    ).length;
    if (highRecent > 0) reasons.push(`RECENT_HIGH_IMPACT_HEADLINES (${highRecent})`);

    const activeProviders = providerFreshness.filter((row) => this.isProviderEnabled(row.provider));
    const healthyProviders = activeProviders.filter((row) => row.ok);
    if (activeProviders.length > 1 && healthyProviders.length <= 1) {
      reasons.push(`NON_BLOCKING_PROVIDER_CONCENTRATION (${healthyProviders.length}/${activeProviders.length} healthy)`);
    }

    const staleProviders = providerFreshness.filter(
      (row) =>
        this.isProviderEnabled(row.provider) &&
        row.ok &&
        row.lastItemTs > 0 &&
        nowTs - row.lastItemTs > Math.max(30 * 60_000, row.pollSeconds * 3000)
    );
    for (const stale of staleProviders.slice(0, 2)) {
      reasons.push(
        `${stale.provider.toUpperCase()}_NON_BLOCKING_LOW_VOLUME (last item ${Math.ceil((nowTs - stale.lastItemTs) / 60_000)}m ago)`
      );
    }

    for (const bad of providerFreshness.filter((row) => this.isProviderEnabled(row.provider) && !row.ok).slice(0, 2)) {
      if (bad.lastError) {
        reasons.push(`${bad.provider.toUpperCase()}_NON_BLOCKING (${shorten(bad.lastError, 64)})`);
      }
    }

    const headline = this.buildHeadline(posture, topDrivers);
    const decaySeconds = this.estimateDecaySeconds(posture, nowTs, topDrivers);
    const hardHaltEnabled =
      this.config.enableIntelTradeGuard &&
      this.config.intelMaxAction === "halt" &&
      !this.config.intelHardHaltOnly;
    const hardHaltReasons = hardHaltEnabled && posture.state === "HALT"
      ? reasons.filter((reason) => /^HALT_|^INTEL_HALT|^HARD_HALT/i.test(reason)).slice(0, 4)
      : [];
    const softRiskReasons = reasons.filter((reason) => !hardHaltReasons.includes(reason));

    return {
      headline,
      reasons: Array.from(new Set(reasons)).slice(0, 6),
      hardHaltReasons,
      softRiskReasons: Array.from(new Set(softRiskReasons)).slice(0, 6),
      hardRiskState: "OK",
      intelConfidence: clamp(posture.confidence, 0, 1),
      providerHealth: providerFreshness.map((row) => ({
        provider: row.provider,
        ok: row.ok,
        blocking: "NON_BLOCKING" as const,
        lastError: row.lastError
      })),
      topDrivers: topDrivers.slice(0, 5),
      decaySeconds,
      providerFreshness: providerFreshness.slice(0, 12)
    };
  }

  private buildHeadline(posture: IntelPosture, topDrivers: IntelCommentaryDriver[]): string {
    const lead = topDrivers[0];
    const haltMode =
      this.config.enableIntelTradeGuard &&
      this.config.intelMaxAction === "halt" &&
      !this.config.intelHardHaltOnly
        ? "hard"
        : "soft";
    if (!lead) {
      if (posture.state === "HALT") {
        return `HALT (${haltMode}): Intel elevated risk`;
      }
      if (posture.state === "RISK_OFF") return "RISK_OFF: Risk-sensitive flow detected";
      if (posture.state === "CAUTION") return "CAUTION: Moderate headline pressure";
      return "NORMAL: No elevated drivers";
    }
    const category = String(lead.category || "NEWS").toUpperCase();
    if (posture.state === "HALT") {
      if (haltMode === "hard") {
        return `HALT (hard): quoting paused by intel guard`;
      }
      return `HALT (soft): ${category} elevated risk — spreads widened`;
    }
    if (posture.state === "RISK_OFF") {
      return `RISK_OFF: ${category} pressure (${shorten(lead.title, 68)})`;
    }
    if (posture.state === "CAUTION") {
      return `CAUTION: ${category} watch (${shorten(lead.title, 68)})`;
    }
    return `NORMAL: ${category} driver fading (${shorten(lead.title, 68)})`;
  }

  private estimateDecaySeconds(
    posture: IntelPosture,
    nowTs: number,
    topDrivers: IntelCommentaryDriver[]
  ): number {
    if (posture.state === "NORMAL") return 0;
    if (posture.state === "HALT" && posture.haltUntilTs > nowTs) {
      return Math.max(1, Math.ceil((posture.haltUntilTs - nowTs) / 1000));
    }
    const threshold = 0.34;
    if (posture.impact <= threshold) return 0;
    const halfLifeSeconds = Math.max(60, this.config.intelDecayMinutes * 60);
    const gap = posture.impact - threshold;
    const normalized = gap / Math.max(0.05, posture.impact);
    const driverBoost = topDrivers.length > 0 ? Math.max(0.6, Math.min(1.4, topDrivers.length / 4)) : 1;
    return Math.max(30, Math.ceil(halfLifeSeconds * normalized * driverBoost));
  }

  private computeTopDrivers(nowTs: number): IntelCommentaryDriver[] {
    const headlineMaxAgeMs = Math.max(10_000, this.config.intelHeadlineMaxAgeSeconds * 1000);
    const anomalyMaxAgeMs = Math.max(10_000, this.config.intelAnomalyMaxAgeSeconds * 1000);
    const scored: Array<{
      score: number;
      source: string;
      title: string;
      impact: number;
      ageSeconds: number;
      category: string;
      url?: string;
    }> = [];
    const seen = new Set<string>();
    for (const row of this.items) {
      const ageMs = Math.max(0, nowTs - row.ts);
      const isAnomaly = this.isAnomalyEvent(row);
      const maxAgeMs = isAnomaly ? anomalyMaxAgeMs : headlineMaxAgeMs;
      if (ageMs > maxAgeMs) continue;
      const decayTauMs = isAnomaly ? 120_000 : 300_000;
      const decay = Math.exp(-ageMs / Math.max(1, decayTauMs));
      const score = row.impact * Math.max(0.2, row.confidence) * sourceWeightFor(row.source) * decay;
      const key = `${normalizeTitleForDedupe(row.title)}|${String(row.source || "").trim().toLowerCase()}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      scored.push({
        score,
        source: row.source,
        title: row.title,
        impact: row.impact,
        ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
        category: row.category,
        url: row.url
      });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((row) => ({
        source: row.source,
        title: row.title,
        impact: clamp(row.impact, 0, 1),
        ageSeconds: row.ageSeconds,
        category: row.category,
        url: row.url
      }));
  }

  private computeUniqueHighImpactCount1m(nowTs: number): number {
    const oneMinuteAgo = nowTs - 60_000;
    const keys = new Set<string>();
    for (const item of this.items) {
      if (item.ts < oneMinuteAgo) continue;
      if (item.impact < 0.7) continue;
      keys.add(eventDedupeKey(item));
    }
    return keys.size;
  }

  private hasCrossVenuePressure(nowTs: number): boolean {
    const windowStart = nowTs - Math.max(10_000, this.config.intelAnomalyMaxAgeSeconds * 1000);
    let seen = 0;
    for (const item of this.items) {
      if (item.ts < windowStart) continue;
      const hasCrossTag = item.tags.some((tag) => /dispersion|cross|basis|venue/i.test(String(tag)));
      const hasCrossReason = item.reasonCodes.some((code) => /CROSSVENUE|DISPERSION|BASIS/.test(String(code)));
      const hasCrossTitle = /dispersion|cross venue|cross-venue|basis/i.test(String(item.title || ""));
      const provider = this.providers.get(String(item.provider || "").toLowerCase());
      const providerHealthy = provider ? provider.ok : true;
      if ((hasCrossTag || hasCrossReason || hasCrossTitle) && providerHealthy) {
        seen += 1;
      }
    }
    return seen > 0;
  }

  private isAnomalyEvent(item: IntelEvent): boolean {
    if (item.kind === "SYSTEM") return true;
    const hasCrossTag = item.tags.some((tag) => /dispersion|cross|basis|anomaly|system|outage/i.test(String(tag)));
    const hasCrossReason = item.reasonCodes.some((code) => /CROSSVENUE|DISPERSION|BASIS|ANOMALY|SYSTEM/.test(String(code)));
    const hasCrossTitle = /dispersion|cross venue|cross-venue|basis|outage|degraded|anomaly/i.test(String(item.title || ""));
    return hasCrossTag || hasCrossReason || hasCrossTitle;
  }

  private hasProviderDegraded(): boolean {
    let enabledProviders = 0;
    let degradedProviders = 0;
    for (const provider of this.providers.values()) {
      if (!this.isProviderEnabled(provider.provider)) continue;
      if (provider.excludeFromConfidence) continue;
      enabledProviders += 1;
      if (!provider.ok) degradedProviders += 1;
    }
    if (enabledProviders === 0) return false;
    return degradedProviders >= Math.max(1, Math.ceil(enabledProviders / 2));
  }

  private hasAllIntelProvidersDegraded(): boolean {
    let enabledProviders = 0;
    let degradedProviders = 0;
    for (const provider of this.providers.values()) {
      if (!this.isProviderEnabled(provider.provider)) continue;
      if (provider.excludeFromConfidence) continue;
      enabledProviders += 1;
      if (!provider.ok) degradedProviders += 1;
    }
    if (enabledProviders === 0) return false;
    return degradedProviders >= enabledProviders;
  }

  private computeProviderConfidencePenalty(): number {
    let enabledProviders = 0;
    let degradedProviders = 0;
    for (const provider of this.providers.values()) {
      if (!this.isProviderEnabled(provider.provider)) continue;
      if (provider.excludeFromConfidence) continue;
      enabledProviders += 1;
      if (!provider.ok) degradedProviders += 1;
    }
    if (enabledProviders === 0 || degradedProviders === 0) return 0;
    const ratio = degradedProviders / enabledProviders;
    return clamp(ratio * MAX_PROVIDER_CONFIDENCE_PENALTY, 0, MAX_PROVIDER_CONFIDENCE_PENALTY);
  }

  private syncNewsHealth(nowTs: number): void {
    const debug = this.newsEngine?.getDebugState();
    if (!debug) {
      this.markProviderError("news", "news engine unavailable", nowTs);
      return;
    }
    for (const row of debug.providerHealth) {
      const provider = String(row.provider || "news").toLowerCase();
      const prev = this.providers.get(provider);
      const fetchedAtTs = normalizeTsMs(row.fetchedAtTs, nowTs);
      const excludeFromConfidence = Boolean(
        (row as { excludeFromConfidence?: boolean }).excludeFromConfidence
      );
      const nonBlockingTag = String((row as { nonBlockingTag?: string }).nonBlockingTag || "").trim();
      this.providers.set(provider, {
        provider,
        enabled: excludeFromConfidence ? false : this.isProviderEnabled(provider),
        ok: excludeFromConfidence ? true : Boolean(row.ok),
        degraded: excludeFromConfidence ? false : !row.ok,
        excludeFromConfidence,
        nonBlockingTag: nonBlockingTag || undefined,
        backoffUntilTs: Number((row as { backoffUntilTs?: number }).backoffUntilTs) || 0,
        lastError: nonBlockingTag ? `${nonBlockingTag}${row.error ? ` (${String(row.error)})` : ""}` : String(row.error || ""),
        lastFetchTs: fetchedAtTs,
        lastSuccessTs: Number((row as { lastSuccessTs?: number }).lastSuccessTs) > 0
          ? normalizeTsMs(Number((row as { lastSuccessTs?: number }).lastSuccessTs), nowTs)
          : row.ok
            ? fetchedAtTs
            : Number(prev?.lastSuccessTs) || 0,
        lastItemTs:
          Number((row as { lastItemTs?: number }).lastItemTs) > 0
            ? normalizeTsMs(Number((row as { lastItemTs?: number }).lastItemTs), nowTs)
            : Number(prev?.lastItemTs) || 0,
        pollSeconds: this.resolvePollSeconds(provider),
        itemsLastHour:
          Number((row as { itemsLastHour?: number }).itemsLastHour) > 0
            ? Math.max(0, Number((row as { itemsLastHour?: number }).itemsLastHour))
            : Number(prev?.itemsLastHour) || 0,
        count: Number(row.count) || 0
      });
    }
    const prev = this.providers.get("news");
    this.providers.set("news", {
      provider: "news",
      enabled: true,
      ok: !debug.lastError,
      degraded: Boolean(debug.lastError),
      lastError: String(debug.lastError || ""),
      lastFetchTs: normalizeTsMs(debug.lastRefreshTs, nowTs),
      lastSuccessTs: debug.lastError
        ? Number(prev?.lastSuccessTs) || 0
        : normalizeTsMs(debug.lastRefreshTs, nowTs),
      lastItemTs: Number(prev?.lastItemTs) || 0,
      pollSeconds: Math.max(5, Math.floor(this.config.newsRefreshMs / 1000)),
      itemsLastHour: Number(prev?.itemsLastHour) || 0,
      count: this.items.filter((x) => x.kind === "NEWS").length
    });
    this.lastError = debug.lastError || this.lastError;
  }

  private syncSignalsHealth(debug: SignalsDebugState | undefined, nowTs: number): void {
    if (!debug) {
      this.markProviderError("signals", "signals engine unavailable", nowTs);
      return;
    }
    for (const row of debug.health.providers) {
      const provider = String(row.provider || "signals").toLowerCase();
      const prev = this.providers.get(provider);
      const fetchedAtTs = normalizeTsMs(row.fetchedAtTs, nowTs);
      this.providers.set(provider, {
        provider,
        enabled: this.isProviderEnabled(provider),
        ok: Boolean(row.ok),
        degraded: !row.ok,
        lastError: String(row.error || ""),
        lastFetchTs: fetchedAtTs,
        lastSuccessTs: row.ok ? fetchedAtTs : Number(prev?.lastSuccessTs) || 0,
        lastItemTs: Number(prev?.lastItemTs) || 0,
        pollSeconds: this.resolvePollSeconds(provider),
        itemsLastHour: Number(prev?.itemsLastHour) || 0,
        count: Number(row.count) || 0
      });
    }
    const prev = this.providers.get("signals");
    this.providers.set("signals", {
      provider: "signals",
      enabled: true,
      ok: Boolean(debug.health.ok),
      degraded: !debug.health.ok,
      lastError: String(debug.health.lastError || ""),
      lastFetchTs: normalizeTsMs(debug.lastRefreshTs, nowTs),
      lastSuccessTs: debug.health.ok
        ? normalizeTsMs(debug.lastRefreshTs, nowTs)
        : Number(prev?.lastSuccessTs) || 0,
      lastItemTs: Number(prev?.lastItemTs) || 0,
      pollSeconds: this.resolvePollSeconds("signals"),
      itemsLastHour: Number(prev?.itemsLastHour) || 0,
      count: this.items.filter((x) => x.kind === "SYSTEM" || x.kind === "MACRO").length
    });
    if (debug.health.lastError) this.lastError = debug.health.lastError;
  }

  private syncExchangeStatusHealth(healthRows: ExchangeStatusHealth[], nowTs: number): void {
    for (const row of Array.isArray(healthRows) ? healthRows : []) {
      const provider = String(row.provider || "exchange-status").toLowerCase();
      const prev = this.providers.get(provider);
      const fetchedAtTs = normalizeTsMs(row.fetchedAtTs, nowTs);
      this.providers.set(provider, {
        provider,
        enabled: true,
        ok: Boolean(row.ok),
        degraded: !row.ok,
        lastError: String(row.error || ""),
        lastFetchTs: fetchedAtTs,
        lastSuccessTs: row.ok ? fetchedAtTs : Number(prev?.lastSuccessTs) || 0,
        lastItemTs: Number(prev?.lastItemTs) || 0,
        pollSeconds: this.resolvePollSeconds(provider),
        itemsLastHour: Number(prev?.itemsLastHour) || 0,
        count: Number(prev?.count) || 0
      });
    }
  }

  private isProviderEnabled(provider: string): boolean {
    const normalized = provider.trim().toLowerCase();
    if (normalized.includes("gdelt")) return this.config.enableGdelt;
    if (normalized.includes("rss")) return this.config.enableRss;
    if (normalized.includes("newsapi")) return this.config.enableNewsapi;
    if (normalized.includes("cryptopanic")) return this.config.enableCryptopanic;
    if (normalized === "x") return this.config.enableX;
    return true;
  }

  private isNonBlockingProvider(provider: string): boolean {
    const normalized = String(provider || "").trim().toLowerCase();
    if (!normalized) return false;
    if (
      normalized.includes("cloudflare-status") ||
      normalized.includes("coinbase-status") ||
      normalized.includes("binance-status") ||
      normalized.includes("kraken-status")
    ) {
      return true;
    }
    if (normalized.includes("-status")) return true;
    if (normalized.includes("rss")) return true;
    if (normalized.includes("gdelt")) return true;
    if (normalized.includes("cryptopanic")) return true;
    if (normalized.includes("newsapi")) return true;
    return false;
  }

  private resolveNewsProvider(row: Headline): string {
    const rawProvider = String((row.raw as { provider?: string } | undefined)?.provider || "")
      .trim()
      .toLowerCase();
    if (rawProvider) return rawProvider;
    const source = String(row.source || "").trim().toLowerCase();
    if (source.includes("cryptopanic")) return "cryptopanic";
    if (source.includes("newsapi")) return "newsapi";
    if (source.includes("gdelt")) return "gdelt";
    return "rss";
  }

  private allowNewsProviderName(providerName: string): boolean {
    const provider = String(providerName || "").toLowerCase();
    if (provider.includes("gdelt") && !this.config.enableGdelt) return false;
    if (provider.includes("rss") && !this.config.enableRss) return false;
    if (provider.includes("newsapi") && !this.config.enableNewsapi) return false;
    if (provider.includes("cryptopanic") && !this.config.enableCryptopanic) return false;
    return true;
  }

  private getFastPollSeconds(): number {
    const configured = Number.isFinite(this.config.intelFastPollSeconds)
      ? this.config.intelFastPollSeconds
      : DEFAULT_INTEL_FAST_POLL_SECONDS;
    return Math.max(2, Math.floor(configured));
  }

  private getSlowPollSeconds(): number {
    const configured = Number.isFinite(this.config.intelSlowPollSeconds)
      ? this.config.intelSlowPollSeconds
      : DEFAULT_INTEL_SLOW_POLL_SECONDS;
    return Math.max(5, Math.floor(configured));
  }

  private resolvePollSeconds(provider: string): number {
    const normalized = String(provider || "").toLowerCase();
    if (normalized === "signals") return Math.max(2, Math.floor(this.config.signalsSystemRefreshMs / 1000));
    if (normalized.includes("macro")) return Math.max(5, Math.floor(this.config.signalsMacroRefreshMs / 1000));
    if (normalized.includes("system")) return Math.max(2, Math.floor(this.config.signalsSystemRefreshMs / 1000));
    if (normalized.includes("news") || normalized.includes("gdelt") || normalized.includes("rss") || normalized.includes("cryptopanic")) {
      // Avoid recursive posture/provider resolution while polling metadata is being built.
      const useFast = this.posture.state !== "NORMAL";
      if (useFast) return this.getFastPollSeconds();
      return this.getSlowPollSeconds();
    }
    return this.getSlowPollSeconds();
  }

  private seedProvider(provider: string, enabled: boolean): void {
    this.providers.set(provider, {
      provider,
      enabled,
      ok: !enabled,
      degraded: false,
      excludeFromConfidence: false,
      nonBlockingTag: undefined,
      backoffUntilTs: 0,
      lastError: enabled ? "not_ready" : "disabled",
      lastFetchTs: 0,
      lastSuccessTs: 0,
      lastItemTs: 0,
      pollSeconds: this.resolvePollSeconds(provider),
      itemsLastHour: 0,
      count: 0
    });
  }

  private markProviderError(provider: string, error: string, nowTs: number): void {
    const prev = this.providers.get(provider);
    this.providers.set(provider, {
      provider,
      enabled: this.isProviderEnabled(provider),
      ok: false,
      degraded: true,
      excludeFromConfidence: false,
      nonBlockingTag: classifyProviderIssueTag(String(error || "unknown")) || undefined,
      backoffUntilTs: 0,
      lastError: String(error || "unknown"),
      lastFetchTs: nowTs,
      lastSuccessTs: Number(prev?.lastSuccessTs) || 0,
      lastItemTs: Number(prev?.lastItemTs) || 0,
      pollSeconds: this.resolvePollSeconds(provider),
      itemsLastHour: Number(prev?.itemsLastHour) || 0,
      count: Number(prev?.count) || 0
    });
  }

  private getProviders(nowTs: number): IntelProviderHealth[] {
    const oneHourAgo = nowTs - 60 * 60 * 1000;
    const statsByProvider = new Map<string, { lastItemTs: number; itemsLastHour: number }>();
    for (const item of this.items) {
      const key = String(item.provider || "news").toLowerCase();
      const prev = statsByProvider.get(key) || { lastItemTs: 0, itemsLastHour: 0 };
      const lastItemTs = Math.max(prev.lastItemTs, item.ts);
      const itemsLastHour = prev.itemsLastHour + (item.ts >= oneHourAgo ? 1 : 0);
      statsByProvider.set(key, { lastItemTs, itemsLastHour });
    }

    const providers = Array.from(this.providers.values()).map((row) => {
      const stats = statsByProvider.get(row.provider) || { lastItemTs: row.lastItemTs, itemsLastHour: row.itemsLastHour };
      const safeLastFetchTs = Math.min(nowTs, Math.max(0, normalizeTsMs(row.lastFetchTs, 0)));
      const safeLastSuccessTs = Math.min(nowTs, Math.max(0, normalizeTsMs(row.lastSuccessTs, 0)));
      const safeLastItemTs = Math.min(
        nowTs,
        Math.max(
          normalizeTsMs(row.lastItemTs, 0),
          normalizeTsMs(stats.lastItemTs, 0)
        )
      );
      return {
        ...row,
        lastFetchTs: safeLastFetchTs,
        lastSuccessTs: safeLastSuccessTs,
        pollSeconds: this.resolvePollSeconds(row.provider),
        lastItemTs: safeLastItemTs,
        itemsLastHour: Math.max(Number(stats.itemsLastHour) || 0, 0)
      };
    });

    const hasNewsApi = providers.some((row) => row.provider === "newsapi");
    if (!hasNewsApi) {
      providers.push({
        provider: "newsapi",
        enabled: this.config.enableNewsapi,
        ok: !this.config.enableNewsapi,
        degraded: false,
        excludeFromConfidence: false,
        nonBlockingTag: undefined,
        backoffUntilTs: 0,
        lastError: this.config.enableNewsapi ? "not_ready" : "disabled",
        lastFetchTs: 0,
        lastSuccessTs: 0,
        lastItemTs: 0,
        pollSeconds: this.resolvePollSeconds("newsapi"),
        itemsLastHour: 0,
        count: 0
      });
    }

    const hasCryptoPanic = providers.some((row) => row.provider === "cryptopanic");
    if (!hasCryptoPanic) {
      providers.push({
        provider: "cryptopanic",
        enabled: this.config.enableCryptopanic,
        ok: !this.config.enableCryptopanic,
        degraded: false,
        excludeFromConfidence: false,
        nonBlockingTag: undefined,
        backoffUntilTs: 0,
        lastError: this.config.enableCryptopanic ? "not_ready" : "disabled",
        lastFetchTs: 0,
        lastSuccessTs: 0,
        lastItemTs: 0,
        pollSeconds: this.resolvePollSeconds("cryptopanic"),
        itemsLastHour: 0,
        count: 0
      });
    }

    return providers.sort((a, b) => a.provider.localeCompare(b.provider));
  }
}

function mapNewsCategory(category: string, tags: string[]): IntelEvent["category"] {
  const value = String(category || "other").toLowerCase();
  if (value === "war") return "WAR";
  if (value === "rates") return "RATES";
  if (value === "macro") {
    const lowerTags = (Array.isArray(tags) ? tags : []).map((x) => String(x).toLowerCase());
    if (lowerTags.some((x) => x.includes("inflation"))) return "INFLATION";
    if (lowerTags.some((x) => x.includes("oil"))) return "OIL";
    return "MACRO";
  }
  if (value === "crypto") return "CRYPTO";
  if (value === "regulation") return "RISK";
  if (value === "exchange") return "EXCHANGE";
  if (value === "outage") return "SYSTEM";
  return "NEWS";
}

function mapSignalCategory(category: string): IntelEvent["category"] {
  const value = String(category || "risk").toLowerCase();
  if (value === "war") return "WAR";
  if (value === "oil") return "OIL";
  if (value === "rates") return "RATES";
  if (value === "inflation") return "INFLATION";
  if (value === "crypto") return "CRYPTO";
  if (value === "exchange") return "EXCHANGE";
  if (value === "regulation") return "RISK";
  if (value === "risk") return "RISK";
  return "NEWS";
}

function mapSignalKind(kind: SignalItem["kind"]): IntelEvent["kind"] {
  if (kind === "MACRO") return "MACRO";
  if (kind === "SYSTEM") return "SYSTEM";
  return "NEWS";
}

function resolveSignalProvider(row: SignalItem): string {
  const rawProvider = String((row.raw as { provider?: string } | undefined)?.provider || "")
    .trim()
    .toLowerCase();
  if (rawProvider) return rawProvider;
  const source = String(row.source || "signals").toLowerCase();
  if (source.includes("gdelt")) return "gdelt";
  if (source.includes("rss")) return "rss";
  if (source.includes("newsapi")) return "newsapi";
  if (source.includes("cryptopanic")) return "cryptopanic";
  if (source.includes("macro")) return "macro";
  if (source.includes("system")) return "system";
  return "signals";
}

function normalizeDirection(value: unknown): IntelDirection {
  if (value === "UP" || value === "DOWN" || value === "NEUTRAL") return value;
  return "NEUTRAL";
}

function directionToSentiment(value: unknown): number {
  const direction = normalizeDirection(value);
  if (direction === "UP") return 0.5;
  if (direction === "DOWN") return -0.5;
  return 0;
}

function sourceWeightFor(source: string): number {
  const value = String(source || "").toLowerCase();
  if (/reuters|bloomberg|ft|wsj/.test(value)) return 1;
  if (/gdelt|coinbase|kraken|binance/.test(value)) return 0.9;
  if (/coindesk|cointelegraph|theblock|decrypt/.test(value)) return 0.8;
  if (/cryptopanic|newsapi/.test(value)) return 0.78;
  return 0.7;
}

function classifyProviderIssueTag(input: string): string {
  const text = String(input || "").toLowerCase();
  if (!text) return "";
  if (/provider_rate_limit|rate.?limit|quota|too many requests|http 429/.test(text)) {
    return "PROVIDER_RATE_LIMIT";
  }
  if (/provider_auth_error|provider_config_error|unauthorized|forbidden|http 401|http 403|invalid api key/.test(text)) {
    return "PROVIDER_AUTH_ERROR";
  }
  if (/provider_no_items|no items|empty/.test(text)) {
    return "PROVIDER_NO_ITEMS";
  }
  if (/provider_timeout|timeout|timed out|abort|aborted/.test(text)) {
    return "PROVIDER_TIMEOUT";
  }
  return "";
}

function buildReasonCodes(category: IntelEvent["category"], tags: unknown[], source: string): string[] {
  const out = new Set<string>();
  out.add(`CATEGORY_${String(category || "NEWS").toUpperCase()}`);
  const allTags = Array.isArray(tags) ? tags.map((x) => String(x || "").toLowerCase()) : [];
  if (allTags.some((x) => x.includes("war") || x.includes("geopolitical") || x.includes("attack"))) {
    out.add("KEYWORD_WAR");
  }
  if (allTags.some((x) => x.includes("rates") || x.includes("fed") || x.includes("inflation"))) {
    out.add("KEYWORD_MACRO");
  }
  if (allTags.some((x) => x.includes("exchange") || x.includes("outage") || x.includes("hack"))) {
    out.add("KEYWORD_EXCHANGE_RISK");
  }
  if (/reuters|bloomberg|ft|wsj/i.test(String(source || ""))) {
    out.add("SOURCE_TIER1");
  }
  if (allTags.some((x) => x.includes("dispersion") || x.includes("crossvenue") || x.includes("basis"))) {
    out.add("CROSSVENUE_DISPERSION");
  }
  return Array.from(out);
}

function eventDedupeKey(event: Pick<IntelEvent, "source" | "category" | "title">): string {
  const source = String(event.source || "").trim().toLowerCase();
  const category = String(event.category || "").trim().toLowerCase();
  const title = String(event.title || "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${source}|${category}|${title}`;
}

function eventTitleDomainKey(event: Pick<IntelEvent, "title" | "source" | "sourceDomain">): string {
  const title = normalizeTitleForDedupe(event.title);
  if (!title) return "";
  const domain = normalizeSourceDomain(event.sourceDomain) || normalizeSourceDomain(extractDomainFromSource(event.source));
  return `${title}|${domain || String(event.source || "").trim().toLowerCase()}`;
}

function hasMaterialIntelChange(previous: IntelEvent, incoming: IntelEvent): boolean {
  const prevDispersion = extractDispersionBps(previous);
  const nextDispersion = extractDispersionBps(incoming);
  if (
    Number.isFinite(prevDispersion) &&
    Number.isFinite(nextDispersion) &&
    Math.abs(nextDispersion - prevDispersion) >= 3
  ) {
    return true;
  }
  if (Math.abs((incoming.impact ?? 0) - (previous.impact ?? 0)) >= 0.2) return true;
  if (normalizeDirection(incoming.direction) !== normalizeDirection(previous.direction)) return true;
  return false;
}

function extractDispersionBps(event: IntelEvent): number {
  const haystack = [
    String(event.title || ""),
    String(event.summary || ""),
    ...(Array.isArray(event.tags) ? event.tags.map((x) => String(x)) : []),
    ...(Array.isArray(event.reasonCodes) ? event.reasonCodes.map((x) => String(x)) : [])
  ].join(" | ");
  const match = haystack.match(/dispersion[^0-9-]*(-?\d+(?:\.\d+)?)/i);
  if (!match) return Number.NaN;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function hashEvent(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

function normalizeTitleForDedupe(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeIntelUrl(value: unknown): string | undefined {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    const kept = new URLSearchParams();
    for (const [key, val] of parsed.searchParams.entries()) {
      if (/^utm_/i.test(key)) continue;
      if (/^fbclid$/i.test(key)) continue;
      if (/^gclid$/i.test(key)) continue;
      kept.append(key, val);
    }
    parsed.search = kept.toString();
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

function extractDomainFromUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function extractDomainFromSource(value: unknown): string {
  const source = String(value || "").trim().toLowerCase();
  if (!source) return "";
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(source)) return source;
  const withoutScheme = source.replace(/^[a-z]+:\/\//i, "");
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(withoutScheme)) {
    return withoutScheme.split("/")[0];
  }
  return "";
}

function normalizeSourceDomain(value: unknown): string {
  const domain = String(value || "").trim().toLowerCase();
  if (!domain) return "";
  return domain.replace(/^www\./, "");
}

function pruneExpiryMap(map: Map<string, number>, nowTs: number, maxSize: number): void {
  for (const [key, expiresAt] of map.entries()) {
    if (expiresAt <= nowTs) map.delete(key);
  }
  if (map.size <= maxSize) return;
  for (const key of map.keys()) {
    map.delete(key);
    if (map.size <= maxSize) break;
  }
}

function normalizeTsMs(value: unknown, fallback: number, maxTs = Date.now()): number {
  const parsed = Number(value);
  const fallbackMs = Math.max(0, Math.floor(Number(fallback) || 0));
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.min(maxTs, fallbackMs);
  const tsMs = parsed < 10_000_000_000 ? Math.floor(parsed * 1000) : Math.floor(parsed);
  return Math.min(Math.max(0, tsMs), maxTs);
}

function shorten(value: string, maxLen: number): string {
  const text = String(value || "").trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(0, maxLen - 1)).trimEnd() + "…";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
