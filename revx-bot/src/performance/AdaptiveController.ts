import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BotConfig } from "../config";
import { Logger } from "../logger";
import { Store } from "../store/Store";
import { AdaptiveDecision, AdaptiveParams, AdaptiveStatus, AnalysisSummary } from "./types";

type AdaptiveThresholds = {
  fillsPerHourMin: number;
  toxicPctMax: number;
  avgToxBpsMin: number;
  netPnlStopLoss24h: number;
};

type DecisionInput = {
  summary1h: AnalysisSummary;
  summary24h: AnalysisSummary;
  posture: string;
};

type PersistedState = {
  enabled: boolean;
  currentParams: AdaptiveParams;
  lastDecision: AdaptiveDecision | null;
  lastEventTs: number;
  lastEventReason: string;
};

export class AdaptiveController {
  private timer: NodeJS.Timeout | null = null;
  private state: PersistedState;
  private readonly stateFilePath: string;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly store: Store,
    private readonly thresholds: AdaptiveThresholds,
    private readonly intervalSeconds: number,
    stateFilePath: string,
    private readonly onRecordEvent: (decision: AdaptiveDecision) => void
  ) {
    this.stateFilePath = stateFilePath;
    this.state = this.loadState();
  }

  start(runDecision: () => DecisionInput | null): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const input = runDecision();
      if (!input) return;
      this.evaluateAndApply(input);
    }, Math.max(10, this.intervalSeconds) * 1000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): AdaptiveStatus {
    return {
      enabled: this.state.enabled,
      ts: Date.now(),
      currentParams: { ...this.state.currentParams },
      lastDecision: this.state.lastDecision ? { ...this.state.lastDecision } : null,
      lastEventTs: this.state.lastEventTs,
      lastEventReason: this.state.lastEventReason,
      guardrails: {
        posture: this.currentPosture(),
        hardLimited: this.currentPosture() === "HALT" || this.currentPosture() === "RISK_OFF"
      }
    };
  }

  setEnabled(enabled: boolean): AdaptiveStatus {
    this.state.enabled = Boolean(enabled);
    this.persistState();
    return this.getStatus();
  }

  setParams(next: Partial<AdaptiveParams>, reason = "manual_set_params"): AdaptiveStatus {
    const before = { ...this.state.currentParams };
    const after = this.clampParams({
      ...this.state.currentParams,
      ...next
    });
    this.state.currentParams = after;
    this.state.lastEventTs = Date.now();
    this.state.lastEventReason = reason;
    this.persistState();
    this.applyRuntimeOverrides(after, reason);
    this.state.lastDecision = {
      ts: this.state.lastEventTs,
      action: "STABILIZE",
      reason,
      before,
      after,
      metrics: {
        avgEdgeBps: 0,
        avgToxBps30s: 0,
        toxicPct30s: 0,
        fillsPerHour: 0,
        netPnlUsd24h: 0,
        inventoryNotionalUsdAbs: 0,
        posture: this.currentPosture()
      }
    };
    return this.getStatus();
  }

  evaluateAndApply(input: DecisionInput): AdaptiveDecision | null {
    if (!this.state.enabled) return null;
    const posture = String(input.posture || "NORMAL").toUpperCase();
    const hardLimited = posture === "HALT" || posture === "RISK_OFF";
    const s1 = input.summary1h;
    const s24 = input.summary24h;
    const before = { ...this.state.currentParams };
    let after = { ...before };
    let action: AdaptiveDecision["action"] = "NONE";
    const reasons: string[] = [];

    const toxic =
      s1.toxicPct30s > this.thresholds.toxicPctMax ||
      s1.avgToxBps30s < this.thresholds.avgToxBpsMin;
    const lowFills = s1.fillsPerHour < this.thresholds.fillsPerHourMin;
    const profitableEdge = s1.avgEdgeBps > 0;
    const stopLossHit = s24.netPnlUsd < this.thresholds.netPnlStopLoss24h;

    if (toxic || stopLossHit) {
      action = "DEFENSIVE";
      reasons.push(
        toxic
          ? `toxicity high (${(s1.toxicPct30s * 100).toFixed(1)}%, avgTox30s=${s1.avgToxBps30s.toFixed(2)}bps)`
          : `24h pnl below stop (${s24.netPnlUsd.toFixed(2)} < ${this.thresholds.netPnlStopLoss24h.toFixed(2)})`
      );
      after = this.clampParams({
        quoteMode: "STEP_BACK",
        baseSpreadTicks: before.baseSpreadTicks + 1,
        sizeMultiplier: before.sizeMultiplier * 0.85,
        levels: Math.max(1, before.levels - 1),
        minRestSeconds: before.minRestSeconds + 2
      });
    } else if (!hardLimited && lowFills && profitableEdge && !toxic) {
      action = "COMPETITIVE";
      reasons.push(
        `fills/hr low (${s1.fillsPerHour.toFixed(2)} < ${this.thresholds.fillsPerHourMin.toFixed(2)}) and edge positive (${s1.avgEdgeBps.toFixed(2)}bps)`
      );
      after = this.clampParams({
        quoteMode: "JOIN_TOB",
        baseSpreadTicks: before.baseSpreadTicks - 1,
        sizeMultiplier: before.sizeMultiplier * 1.08,
        levels: Math.min(3, before.levels + 1),
        minRestSeconds: Math.max(5, before.minRestSeconds - 1)
      });
    } else if (hardLimited) {
      action = "STABILIZE";
      reasons.push(`posture ${posture}: risk increase blocked`);
      after = this.clampParams({
        quoteMode: "STEP_BACK",
        baseSpreadTicks: Math.max(before.baseSpreadTicks, 1),
        sizeMultiplier: Math.min(before.sizeMultiplier, 1),
        levels: Math.min(before.levels, 2),
        minRestSeconds: Math.max(before.minRestSeconds, 8)
      });
    }

    const changed = this.paramsChanged(before, after);
    const decision: AdaptiveDecision = {
      ts: Date.now(),
      action,
      reason: reasons.join(" | ") || "no change",
      before,
      after,
      metrics: {
        avgEdgeBps: s1.avgEdgeBps,
        avgToxBps30s: s1.avgToxBps30s,
        toxicPct30s: s1.toxicPct30s,
        fillsPerHour: s1.fillsPerHour,
        netPnlUsd24h: s24.netPnlUsd,
        inventoryNotionalUsdAbs: s1.avgInventoryNotionalUsdAbs,
        posture
      }
    };
    this.state.lastDecision = decision;

    if (changed) {
      this.state.currentParams = after;
      this.state.lastEventTs = decision.ts;
      this.state.lastEventReason = decision.reason;
      this.applyRuntimeOverrides(after, decision.reason);
      this.onRecordEvent(decision);
    }
    this.persistState();
    return decision;
  }

  private applyRuntimeOverrides(params: AdaptiveParams, reason: string): void {
    const effective = this.store.getEffectiveConfig(this.config.symbol);
    const baseLevelQuote = Number(effective.levelQuoteSizeUsd) || this.config.levelQuoteSizeUsd;
    const baseTobQuote = Number(effective.tobQuoteSizeUsd) || this.config.tobQuoteSizeUsd;
    const mid = this.store.getRecentTickerSnapshots(this.config.symbol, 1)[0]?.mid ?? 0;
    const tickBps = mid > 0 ? (0.01 / mid) * 10_000 : 0.5;
    const spreadBps =
      this.config.baseHalfSpreadBps +
      Math.max(0, params.baseSpreadTicks) * Math.max(0.2, tickBps);
    const patch = {
      levelsBuy: params.levels,
      levelsSell: params.levels,
      levelQuoteSizeUsd: round2(baseLevelQuote * params.sizeMultiplier),
      tobQuoteSizeUsd: round2(baseTobQuote * params.sizeMultiplier),
      baseHalfSpreadBps: round2(spreadBps),
      minOrderAgeSeconds: params.minRestSeconds,
      queueRefreshSeconds: Math.max(params.minRestSeconds, this.config.queueRefreshSeconds),
      maxDistanceFromTobBps: params.quoteMode === "JOIN_TOB" ? 0.8 : 2.5
    };
    this.store.setRuntimeOverrides(
      this.config.symbol,
      patch,
      {
        source: "adaptive-controller",
        note: reason.slice(0, 180)
      }
    );
  }

  private clampParams(params: AdaptiveParams): AdaptiveParams {
    return {
      quoteMode: params.quoteMode === "JOIN_TOB" ? "JOIN_TOB" : "STEP_BACK",
      baseSpreadTicks: clampInt(params.baseSpreadTicks, 0, 8),
      sizeMultiplier: clampNumber(params.sizeMultiplier, 0.5, 1.5),
      levels: clampInt(params.levels, 1, 3),
      minRestSeconds: clampInt(params.minRestSeconds, 5, 30)
    };
  }

  private paramsChanged(a: AdaptiveParams, b: AdaptiveParams): boolean {
    return (
      a.quoteMode !== b.quoteMode ||
      a.baseSpreadTicks !== b.baseSpreadTicks ||
      Math.abs(a.sizeMultiplier - b.sizeMultiplier) > 1e-6 ||
      a.levels !== b.levels ||
      a.minRestSeconds !== b.minRestSeconds
    );
  }

  private currentPosture(): string {
    const status = this.store.getBotStatus();
    const intelState = String((status as Record<string, unknown> | null)?.intel_state ?? "NORMAL");
    return intelState.toUpperCase();
  }

  private loadState(): PersistedState {
    const defaults: PersistedState = {
      enabled: this.config.adaptiveControllerEnabled,
      currentParams: {
        quoteMode: "JOIN_TOB",
        baseSpreadTicks: 0,
        sizeMultiplier: 1,
        levels: Math.min(3, Math.max(1, this.config.levels)),
        minRestSeconds: Math.max(5, Math.floor(this.config.minOrderAgeSeconds))
      },
      lastDecision: null,
      lastEventTs: 0,
      lastEventReason: ""
    };
    if (!existsSync(this.stateFilePath)) {
      return defaults;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.stateFilePath, "utf8")) as Partial<PersistedState>;
      return {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
        currentParams: this.clampParams({
          ...defaults.currentParams,
          ...(parsed.currentParams ?? {})
        }),
        lastDecision: parsed.lastDecision ?? null,
        lastEventTs: Number.isFinite(Number(parsed.lastEventTs)) ? Number(parsed.lastEventTs) : 0,
        lastEventReason: String(parsed.lastEventReason || "")
      };
    } catch (error) {
      this.logger.warn({ error }, "Adaptive controller state load failed; using defaults");
      return defaults;
    }
  }

  private persistState(): void {
    try {
      mkdirSync(dirname(this.stateFilePath), { recursive: true });
      writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), "utf8");
    } catch (error) {
      this.logger.warn({ error }, "Adaptive controller state persist failed");
    }
  }
}

function clampInt(value: number, min: number, max: number): number {
  const parsed = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : min;
  return Math.min(max, Math.max(min, parsed));
}

function clampNumber(value: number, min: number, max: number): number {
  const parsed = Number.isFinite(Number(value)) ? Number(value) : min;
  return Math.min(max, Math.max(min, parsed));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

