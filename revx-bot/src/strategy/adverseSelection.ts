export type AdverseSelectionSide = "BUY" | "SELL";

export type AdverseSelectionSample = {
  ts: number;
  bps: number;
};

export type AdverseSelectionStats = {
  as_avg_bps: number;
  as_bad_rate: number;
  as_last_bps: number | null;
  as_samples: number;
};

export type AdverseSelectionDecision = {
  as_toxic: boolean;
  reason: string;
};

export type AdverseSelectionDefenseConfig = {
  widenStepBps: number;
  maxWidenBps: number;
  cooldownSeconds: number;
  decayBpsPerMin: number;
};

export type AdverseSelectionDefenseState = {
  widenBps: number;
  cooldownUntilTs: number;
  cooldownRemainingSeconds: number;
  inCooldown: boolean;
  lastDecayTs: number;
};

export type AdverseSelectionFillInput = {
  id: string;
  ts: number;
  side: AdverseSelectionSide;
  fillMid: number;
};

export type AdverseSelectionTickInput = {
  ts: number;
  latestMid: number;
};

export type AdverseSelectionTrackerConfig = {
  enabled: boolean;
  horizonSeconds: number;
  sampleFills: number;
  badAvgBps: number;
  badRate: number;
  badFillBps: number;
  widenStepBps: number;
  maxWidenBps: number;
  cooldownSeconds: number;
  decayBpsPerMin: number;
};

export type AdverseSelectionSummary = {
  as_avg_bps: number;
  as_bad_rate: number;
  as_last_bps: number | null;
  as_samples: number;
  as_toxic: boolean;
  reason: string;
  widen_bps_applied: number;
  cooldown_remaining_s: number;
  in_cooldown: boolean;
};

type PendingAsFill = {
  id: string;
  ts: number;
  dueTs: number;
  side: AdverseSelectionSide;
  fillMid: number;
};

export function computeAsBps(
  input:
    | { side: AdverseSelectionSide; fillMid: number; futureMid: number }
    | AdverseSelectionSide,
  fillMidArg?: number,
  futureMidArg?: number
): number {
  let side: AdverseSelectionSide;
  let fillMid: number;
  let futureMid: number;

  if (typeof input === "string") {
    side = input;
    fillMid = Number(fillMidArg);
    futureMid = Number(futureMidArg);
  } else {
    side = input.side;
    fillMid = Number(input.fillMid);
    futureMid = Number(input.futureMid);
  }

  if (!(fillMid > 0) || !(futureMid > 0)) {
    return 0;
  }
  if (side === "BUY") {
    return ((futureMid - fillMid) / fillMid) * 10_000;
  }
  return ((fillMid - futureMid) / fillMid) * 10_000;
}

export function rollingStats(
  samples: AdverseSelectionSample[],
  sampleLimit: number,
  badFillBps: number
): AdverseSelectionStats {
  const limited = samples
    .slice(-Math.max(1, Math.floor(sampleLimit)))
    .filter((row) => Number.isFinite(row.bps));
  if (limited.length === 0) {
    return {
      as_avg_bps: 0,
      as_bad_rate: 0,
      as_last_bps: null,
      as_samples: 0
    };
  }
  const total = limited.reduce((sum, row) => sum + row.bps, 0);
  const badCount = limited.reduce((sum, row) => (row.bps <= badFillBps ? sum + 1 : sum), 0);
  return {
    as_avg_bps: total / limited.length,
    as_bad_rate: badCount / limited.length,
    as_last_bps: limited[limited.length - 1].bps,
    as_samples: limited.length
  };
}

export function toxicDecision(
  stats: AdverseSelectionStats,
  badAvgBps: number,
  badRate: number,
  minSamples = 5
): AdverseSelectionDecision {
  const minRequired = Math.max(1, Math.floor(minSamples));
  if (stats.as_samples < minRequired) {
    return {
      as_toxic: false,
      reason: `AS_WAITING_SAMPLES (${stats.as_samples}/${minRequired})`
    };
  }
  const avgThreshold = -Math.abs(Number(badAvgBps) || 0);
  const rateThreshold = clamp(Number(badRate) || 0, 0, 1);
  const toxicByAvg = stats.as_avg_bps <= avgThreshold;
  const toxicByRate = stats.as_bad_rate >= rateThreshold;
  const toxic = toxicByAvg || toxicByRate;
  const reason = toxic
    ? `AS_TOXIC (avg=${stats.as_avg_bps.toFixed(2)} bps, bad_rate=${stats.as_bad_rate.toFixed(2)})`
    : `AS_OK (avg=${stats.as_avg_bps.toFixed(2)} bps, bad_rate=${stats.as_bad_rate.toFixed(2)})`;
  return { as_toxic: toxic, reason };
}

export function updateDefenseState(params: {
  nowTs: number;
  toxic: boolean;
  currentWidenBps: number;
  currentCooldownUntilTs: number;
  lastDecayTs: number;
  config: AdverseSelectionDefenseConfig;
}): AdverseSelectionDefenseState {
  const nowTs = Math.max(0, Number(params.nowTs) || Date.now());
  const step = Math.max(0, Number(params.config.widenStepBps) || 0);
  const maxWiden = Math.max(0, Number(params.config.maxWidenBps) || 0);
  const cooldownMs = Math.max(1, Math.floor(Number(params.config.cooldownSeconds) || 0)) * 1000;
  const decayPerMin = Math.max(0, Number(params.config.decayBpsPerMin) || 0);

  let widenBps = clamp(Number(params.currentWidenBps) || 0, 0, maxWiden);
  let cooldownUntilTs = Math.max(0, Number(params.currentCooldownUntilTs) || 0);
  let lastDecayTs = Math.max(0, Number(params.lastDecayTs) || nowTs);

  if (params.toxic) {
    widenBps = clamp(widenBps + step, 0, maxWiden);
    cooldownUntilTs = nowTs + cooldownMs;
    lastDecayTs = nowTs;
  } else if (nowTs >= cooldownUntilTs && widenBps > 0 && decayPerMin > 0) {
    const elapsedMs = Math.max(0, nowTs - lastDecayTs);
    const decayAmount = (elapsedMs / 60_000) * decayPerMin;
    if (decayAmount > 0) {
      widenBps = Math.max(0, widenBps - decayAmount);
      lastDecayTs = nowTs;
    }
  }

  const cooldownRemainingSeconds =
    cooldownUntilTs > nowTs ? Math.ceil((cooldownUntilTs - nowTs) / 1000) : 0;

  return {
    widenBps,
    cooldownUntilTs,
    cooldownRemainingSeconds,
    inCooldown: cooldownRemainingSeconds > 0,
    lastDecayTs
  };
}

export class AdverseSelectionTracker {
  private readonly cfg: AdverseSelectionTrackerConfig;
  private readonly pending = new Map<string, PendingAsFill>();
  private readonly seen = new Set<string>();
  private readonly seenQueue: string[] = [];
  private samples: AdverseSelectionSample[] = [];
  private widenBps = 0;
  private cooldownUntilTs = 0;
  private lastDecayTs = 0;
  private lastSummary: AdverseSelectionSummary = {
    as_avg_bps: 0,
    as_bad_rate: 0,
    as_last_bps: null,
    as_samples: 0,
    as_toxic: false,
    reason: "AS_WAITING_SAMPLES (0/5)",
    widen_bps_applied: 0,
    cooldown_remaining_s: 0,
    in_cooldown: false
  };

  constructor(config: AdverseSelectionTrackerConfig) {
    this.cfg = {
      ...config,
      sampleFills: Math.max(1, Math.floor(config.sampleFills)),
      horizonSeconds: Math.max(1, Math.floor(config.horizonSeconds)),
      badRate: clamp(config.badRate, 0, 1),
      maxWidenBps: Math.max(0, config.maxWidenBps),
      widenStepBps: Math.max(0, config.widenStepBps),
      decayBpsPerMin: Math.max(0, config.decayBpsPerMin),
      cooldownSeconds: Math.max(1, Math.floor(config.cooldownSeconds))
    };
  }

  ingestFill(fill: AdverseSelectionFillInput): void {
    const id = String(fill.id || "").trim();
    if (!id || this.seen.has(id)) return;
    const ts = Math.max(0, Number(fill.ts) || 0);
    const fillMid = Number(fill.fillMid);
    if (!(ts > 0) || !(fillMid > 0)) return;

    this.seen.add(id);
    this.seenQueue.push(id);
    const maxSeen = Math.max(500, this.cfg.sampleFills * 20);
    while (this.seenQueue.length > maxSeen) {
      const oldest = this.seenQueue.shift();
      if (oldest) this.seen.delete(oldest);
    }

    this.pending.set(id, {
      id,
      ts,
      dueTs: ts + this.cfg.horizonSeconds * 1000,
      side: fill.side,
      fillMid
    });
  }

  onTick(tick: AdverseSelectionTickInput): AdverseSelectionSummary {
    const nowTs = Math.max(0, Number(tick.ts) || Date.now());
    const latestMid = Number(tick.latestMid);

    if (latestMid > 0) {
      for (const [id, pending] of this.pending.entries()) {
        if (pending.dueTs > nowTs) continue;
        const bps = computeAsBps({
          side: pending.side,
          fillMid: pending.fillMid,
          futureMid: latestMid
        });
        this.samples.push({ ts: pending.ts, bps });
        this.pending.delete(id);
      }
    }

    if (this.samples.length > this.cfg.sampleFills) {
      this.samples = this.samples.slice(this.samples.length - this.cfg.sampleFills);
    }

    const stats = rollingStats(this.samples, this.cfg.sampleFills, this.cfg.badFillBps);
    const decision = toxicDecision(stats, this.cfg.badAvgBps, this.cfg.badRate, Math.min(this.cfg.sampleFills, 5));
    const defense = updateDefenseState({
      nowTs,
      toxic: this.cfg.enabled ? decision.as_toxic : false,
      currentWidenBps: this.widenBps,
      currentCooldownUntilTs: this.cooldownUntilTs,
      lastDecayTs: this.lastDecayTs,
      config: {
        widenStepBps: this.cfg.widenStepBps,
        maxWidenBps: this.cfg.maxWidenBps,
        cooldownSeconds: this.cfg.cooldownSeconds,
        decayBpsPerMin: this.cfg.decayBpsPerMin
      }
    });

    this.widenBps = defense.widenBps;
    this.cooldownUntilTs = defense.cooldownUntilTs;
    this.lastDecayTs = defense.lastDecayTs;

    this.lastSummary = {
      ...stats,
      as_toxic: this.cfg.enabled ? decision.as_toxic : false,
      reason: decision.reason,
      widen_bps_applied: defense.widenBps,
      cooldown_remaining_s: defense.cooldownRemainingSeconds,
      in_cooldown: defense.inCooldown
    };
    return this.lastSummary;
  }

  getSummary(): AdverseSelectionSummary {
    return { ...this.lastSummary };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
