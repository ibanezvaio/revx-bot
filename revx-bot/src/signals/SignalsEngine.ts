import { BotConfig } from "../config";
import { Logger } from "../logger";
import { Store } from "../store/Store";
import { SignalLlmAnalyzer } from "./llm/SignalLlmAnalyzer";
import { scoreSignalInputs } from "./SignalScorer";
import { GdeltProvider } from "./providers/GdeltProvider";
import { MacroCalendarProvider } from "./providers/MacroCalendarProvider";
import { RssNewsProvider } from "./providers/RssNewsProvider";
import { clamp, dedupeKey } from "./providers/common";
import { SystemStatusProvider } from "./providers/SystemStatusProvider";
import {
  ProviderHealth,
  RawSignalInput,
  SignalAggregate,
  SignalDirection,
  SignalItem,
  SignalSnapshot,
  SignalsDebugState,
  SignalsProvider
} from "./types";

const EMPTY_AGGREGATE: SignalAggregate = {
  ts: 0,
  impact: 0,
  direction: "NEUTRAL",
  confidence: 0,
  state: "NORMAL",
  reasons: [],
  latestTs: 0,
  counts: {}
};

const EMPTY_SNAPSHOT: SignalSnapshot = {
  ts: 0,
  items: [],
  aggregate: { ...EMPTY_AGGREGATE },
  health: {
    ok: true,
    providers: []
  }
};

export class SignalsEngine {
  private readonly newsProviders: SignalsProvider[];
  private readonly macroProviders: SignalsProvider[];
  private readonly systemProviders: SignalsProvider[];
  private readonly llmAnalyzer: SignalLlmAnalyzer;
  private running = false;
  private newsTimer: NodeJS.Timeout | null = null;
  private macroTimer: NodeJS.Timeout | null = null;
  private systemTimer: NodeJS.Timeout | null = null;
  private snapshot: SignalSnapshot = { ...EMPTY_SNAPSHOT };
  private debugState: SignalsDebugState = {
    ts: 0,
    health: { ok: true, providers: [] },
    dedupe: { rawCount: 0, keptCount: 0, duplicateCount: 0 },
    loopTimings: {
      newsLastDurationMs: 0,
      macroLastDurationMs: 0,
      systemLastDurationMs: 0,
      llmLastDurationMs: 0
    },
    llm: {
      enabled: false,
      suspendedUntilTs: 0,
      lastRunTs: 0
    },
    lastRefreshTs: 0
  };
  private healthByProvider = new Map<string, ProviderHealth>();
  private lastError = "";
  private inFlightNews = false;
  private inFlightMacro = false;
  private inFlightSystem = false;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly store: Store
  ) {
    this.newsProviders = [new RssNewsProvider(config), new GdeltProvider(config)];
    this.macroProviders = [new MacroCalendarProvider(config)];
    this.systemProviders = [new SystemStatusProvider(config, store)];
    this.llmAnalyzer = new SignalLlmAnalyzer(config, logger);
  }

  start(): void {
    if (!this.config.signalsEnabled || this.running) return;
    this.running = true;
    void this.refreshNews();
    void this.refreshMacro();
    void this.refreshSystem();
    this.newsTimer = setInterval(() => {
      void this.refreshNews();
    }, this.config.signalsNewsRefreshMs);
    this.macroTimer = setInterval(() => {
      void this.refreshMacro();
    }, this.config.signalsMacroRefreshMs);
    this.systemTimer = setInterval(() => {
      void this.refreshSystem();
    }, this.config.signalsSystemRefreshMs);
    this.logger.info(
      {
        newsRefreshMs: this.config.signalsNewsRefreshMs,
        macroRefreshMs: this.config.signalsMacroRefreshMs,
        systemRefreshMs: this.config.signalsSystemRefreshMs
      },
      "Signals engine started"
    );
  }

  stop(): void {
    this.running = false;
    if (this.newsTimer) clearInterval(this.newsTimer);
    if (this.macroTimer) clearInterval(this.macroTimer);
    if (this.systemTimer) clearInterval(this.systemTimer);
    this.newsTimer = null;
    this.macroTimer = null;
    this.systemTimer = null;
  }

  getSnapshot(): SignalSnapshot {
    return {
      ts: this.snapshot.ts,
      items: this.snapshot.items.map((row) => ({ ...row, analysis: row.analysis ? { ...row.analysis, rationale: [...row.analysis.rationale] } : undefined })),
      aggregate: {
        ...this.snapshot.aggregate,
        reasons: [...this.snapshot.aggregate.reasons],
        counts: { ...this.snapshot.aggregate.counts }
      },
      health: {
        ok: this.snapshot.health.ok,
        lastError: this.snapshot.health.lastError,
        providers: this.snapshot.health.providers.map((row) => ({ ...row }))
      }
    };
  }

  getDebugState(): SignalsDebugState {
    return {
      ts: this.debugState.ts,
      health: {
        ok: this.debugState.health.ok,
        lastError: this.debugState.health.lastError,
        providers: this.debugState.health.providers.map((row) => ({ ...row }))
      },
      dedupe: { ...this.debugState.dedupe },
      loopTimings: { ...this.debugState.loopTimings },
      llm: { ...this.debugState.llm },
      lastRefreshTs: this.debugState.lastRefreshTs
    };
  }

  getLatestAggregate(): SignalAggregate {
    return { ...this.snapshot.aggregate, reasons: [...this.snapshot.aggregate.reasons], counts: { ...this.snapshot.aggregate.counts } };
  }

  private async refreshNews(): Promise<void> {
    if (!this.running || this.inFlightNews) return;
    this.inFlightNews = true;
    const started = Date.now();
    try {
      const inputs = await this.fetchFromProviders(this.newsProviders, Date.now());
      let scored = scoreSignalInputs(inputs);
      const llmStarted = Date.now();
      scored = await this.llmAnalyzer.analyze(scored, Date.now());
      this.debugState.loopTimings.llmLastDurationMs = Date.now() - llmStarted;
      this.mergeSignals(scored);
      this.debugState.loopTimings.newsLastDurationMs = Date.now() - started;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: this.lastError }, "Signals news refresh failed");
      this.markHealthError("news", this.lastError);
      this.debugState.loopTimings.newsLastDurationMs = Date.now() - started;
      this.updateSnapshot(Date.now());
    } finally {
      this.inFlightNews = false;
    }
  }

  private async refreshMacro(): Promise<void> {
    if (!this.running || this.inFlightMacro) return;
    this.inFlightMacro = true;
    const started = Date.now();
    try {
      const inputs = await this.fetchFromProviders(this.macroProviders, Date.now());
      const scored = scoreSignalInputs(inputs);
      this.mergeSignals(scored);
      this.debugState.loopTimings.macroLastDurationMs = Date.now() - started;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.markHealthError("macro", this.lastError);
      this.logger.warn({ error: this.lastError }, "Signals macro refresh failed");
      this.debugState.loopTimings.macroLastDurationMs = Date.now() - started;
      this.updateSnapshot(Date.now());
    } finally {
      this.inFlightMacro = false;
    }
  }

  private async refreshSystem(): Promise<void> {
    if (!this.running || this.inFlightSystem) return;
    this.inFlightSystem = true;
    const started = Date.now();
    try {
      const inputs = await this.fetchFromProviders(this.systemProviders, Date.now());
      const scored = scoreSignalInputs(inputs);
      this.mergeSignals(scored);
      this.debugState.loopTimings.systemLastDurationMs = Date.now() - started;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.markHealthError("system", this.lastError);
      this.logger.warn({ error: this.lastError }, "Signals system refresh failed");
      this.debugState.loopTimings.systemLastDurationMs = Date.now() - started;
      this.updateSnapshot(Date.now());
    } finally {
      this.inFlightSystem = false;
    }
  }

  private async fetchFromProviders(
    providers: SignalsProvider[],
    nowTs: number
  ): Promise<RawSignalInput[]> {
    const results = await Promise.all(
      providers.map((provider) => provider.fetch(nowTs))
    );
    const items: RawSignalInput[] = [];
    for (const result of results) {
      this.healthByProvider.set(result.provider, {
        provider: result.provider,
        ok: result.ok,
        count: result.items.length,
        durationMs: result.durationMs,
        fetchedAtTs: result.fetchedAtTs,
        error: result.error
      });
      if (result.ok) {
        items.push(...result.items);
      } else if (result.error) {
        this.lastError = result.error;
      }
    }
    return items;
  }

  private mergeSignals(scored: SignalItem[]): void {
    const existing = this.snapshot.items;
    const map = new Map<string, SignalItem>();
    for (const row of existing) {
      map.set(row.id, row);
    }
    let rawCount = 0;
    for (const row of scored) {
      rawCount += 1;
      const id = row.id || dedupeKey(row.title, row.url);
      const prev = map.get(id);
      if (!prev || row.ts >= prev.ts) {
        map.set(id, { ...row, id });
      }
    }
    const nowTs = Date.now();
    const maxAgeMs = Math.max(60_000, this.config.signalsHalfLifeMs * 6);
    const items = Array.from(map.values())
      .filter((row) => nowTs - row.ts <= maxAgeMs)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, this.config.signalsMaxItems);
    const aggregate = computeSignalAggregate(
      items,
      nowTs,
      this.config.signalsHalfLifeMs,
      this.config.signalsMinConf,
      this.config.signalsPauseImpact
    );
    const providers = Array.from(this.healthByProvider.values()).sort((a, b) =>
      a.provider.localeCompare(b.provider)
    );
    const healthOk = providers.length === 0 ? true : providers.some((row) => row.ok);
    const lastError = !healthOk ? this.lastError || providers.find((row) => !row.ok)?.error : undefined;
    this.snapshot = {
      ts: nowTs,
      items,
      aggregate,
      health: {
        ok: healthOk,
        lastError,
        providers
      }
    };
    this.debugState = {
      ...this.debugState,
      ts: nowTs,
      health: {
        ok: healthOk,
        lastError,
        providers
      },
      dedupe: {
        rawCount,
        keptCount: items.length,
        duplicateCount: Math.max(0, rawCount - items.length)
      },
      llm: {
        enabled: this.llmAnalyzer.isEnabled(),
        ...this.llmAnalyzer.getState()
      },
      lastRefreshTs: nowTs
    };
    this.recordMetrics(nowTs, aggregate);
  }

  private updateSnapshot(nowTs: number): void {
    const providers = Array.from(this.healthByProvider.values()).sort((a, b) =>
      a.provider.localeCompare(b.provider)
    );
    const healthOk = providers.length === 0 ? false : providers.some((row) => row.ok);
    this.snapshot = {
      ...this.snapshot,
      ts: nowTs,
      health: {
        ok: healthOk,
        lastError: this.lastError || this.snapshot.health.lastError,
        providers
      }
    };
    this.debugState.ts = nowTs;
    this.debugState.health = { ...this.snapshot.health, providers: providers.map((row) => ({ ...row })) };
    this.debugState.lastRefreshTs = nowTs;
  }

  private markHealthError(provider: string, error: string): void {
    this.healthByProvider.set(provider, {
      provider,
      ok: false,
      count: 0,
      durationMs: 0,
      fetchedAtTs: Date.now(),
      error
    });
  }

  private recordMetrics(ts: number, aggregate: SignalAggregate): void {
    this.store.recordMetric({ ts, key: "signals_impact", value: aggregate.impact });
    this.store.recordMetric({ ts, key: "signals_confidence", value: aggregate.confidence });
    this.store.recordMetric({ ts, key: "signals_direction", value: directionToNumber(aggregate.direction) });
    this.store.recordMetric({ ts, key: "signals_state", value: stateToNumber(aggregate.state) });
    this.store.recordMetric({ ts, key: "signals_latest_ts", value: aggregate.latestTs });
  }
}

export function computeSignalAggregate(
  items: SignalItem[],
  nowTs: number,
  halfLifeMs: number,
  minConf: number,
  pauseImpact: number
): SignalAggregate {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      ...EMPTY_AGGREGATE,
      ts: nowTs
    };
  }
  const safeHalfLifeMs = Math.max(60_000, halfLifeMs);
  let weightedImpact = 0;
  let weightedDirection = 0;
  let weightedConfidence = 0;
  let weightSum = 0;
  const counts: Record<string, number> = {};
  let latestTs = 0;
  for (const item of items) {
    latestTs = Math.max(latestTs, item.ts);
    counts[item.category] = (counts[item.category] ?? 0) + 1;
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    const ageMs = Math.max(0, nowTs - item.ts);
    const decay = Math.exp(-ageMs / safeHalfLifeMs);
    const weight = Math.max(0.02, decay);
    const direction = item.direction === "UP" ? 1 : item.direction === "DOWN" ? -1 : 0;
    weightedImpact += item.impact * weight;
    weightedDirection += direction * item.impact * item.confidence * weight;
    weightedConfidence += item.confidence * weight;
    weightSum += weight;
  }
  const impact = clamp(Math.min(2, weightedImpact) / 2, 0, 1);
  const directionScore = weightSum > 0 ? weightedDirection / weightSum : 0;
  const direction: SignalDirection =
    directionScore > 0.05 ? "UP" : directionScore < -0.05 ? "DOWN" : "NEUTRAL";
  const confidence = clamp(weightSum > 0 ? weightedConfidence / weightSum : 0, 0, 1);
  const { state, reasons } = decideAggregateState(impact, direction, confidence, minConf, pauseImpact);
  return {
    ts: nowTs,
    impact,
    direction,
    confidence,
    state,
    reasons,
    latestTs,
    counts
  };
}

function decideAggregateState(
  impact: number,
  direction: SignalDirection,
  confidence: number,
  minConf: number,
  pauseImpact: number
): { state: SignalAggregate["state"]; reasons: string[] } {
  const reasons: string[] = [];
  if (impact >= pauseImpact && confidence >= minConf) {
    reasons.push(`SIGNALS_PAUSE_THRESHOLD (impact=${impact.toFixed(2)} conf=${confidence.toFixed(2)})`);
    return { state: "PAUSE", reasons };
  }
  if (impact >= 0.65 && direction === "DOWN") {
    reasons.push(`SIGNALS_RISK_OFF (impact=${impact.toFixed(2)} direction=DOWN)`);
    return { state: "RISK_OFF", reasons };
  }
  if (impact >= 0.65 && direction === "UP") {
    reasons.push(`SIGNALS_RISK_ON (impact=${impact.toFixed(2)} direction=UP)`);
    return { state: "RISK_ON", reasons };
  }
  if (impact >= 0.35) {
    reasons.push(`SIGNALS_CAUTION (impact=${impact.toFixed(2)})`);
    return { state: "CAUTION", reasons };
  }
  return { state: "NORMAL", reasons: ["SIGNALS_NORMAL"] };
}

function directionToNumber(value: SignalDirection): number {
  if (value === "UP") return 1;
  if (value === "DOWN") return -1;
  return 0;
}

function stateToNumber(value: SignalAggregate["state"]): number {
  if (value === "NORMAL") return 0;
  if (value === "CAUTION") return 1;
  if (value === "RISK_OFF") return 2;
  if (value === "RISK_ON") return 3;
  return 4;
}
