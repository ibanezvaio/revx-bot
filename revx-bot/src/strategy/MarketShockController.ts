export type MarketPhase = "SHOCK" | "COOLDOWN" | "STABILIZING" | "RECOVERY";

export type MarketShockInput = {
  ts: number;
  revxMid: number;
  revxBid: number;
  revxAsk: number;
  spreadBps: number;
  vol1mBps: number;
  vol5mBps: number;
  shockVolPeakBps: number;
  newLowInWindow: boolean;
  dispersionBps: number;
  bookDepthScore: number;
};

export type MarketShockConfig = {
  shockEnterBps: number;
  shockSpreadBps: number;
  shockDispersionBps: number;
  baselineSpreadBps: number;
  shockMinSeconds: number;
  reentryNoNewLowSeconds: number;
  recoveryDispersionBps: number;
  recoveryPersistSeconds: number;
};

export type MarketShockDecision = {
  phase: MarketPhase;
  state: MarketPhase;
  sinceTs: number;
  reasons: string[];
  shockVolPeakBps: number;
  actions: {
    spreadMult: number;
    sizeMult: number;
    reduceLevelsBy: number;
    sellSkewBps: number;
    buySkewBps: number;
    tobStepBackTicks: number;
    forceSeedReentry: boolean;
  };
};

const SHOCK_ACTIONS: MarketShockDecision["actions"] = {
  spreadMult: 1.35,
  sizeMult: 0.45,
  reduceLevelsBy: 1,
  sellSkewBps: 2,
  buySkewBps: 0,
  tobStepBackTicks: 2,
  forceSeedReentry: false
};

const COOLDOWN_ACTIONS: MarketShockDecision["actions"] = {
  spreadMult: 1.18,
  sizeMult: 0.7,
  reduceLevelsBy: 1,
  sellSkewBps: 1,
  buySkewBps: 0,
  tobStepBackTicks: 1,
  forceSeedReentry: false
};

const STABILIZING_ACTIONS: MarketShockDecision["actions"] = {
  spreadMult: 1.05,
  sizeMult: 0.85,
  reduceLevelsBy: 0,
  sellSkewBps: 0,
  buySkewBps: 1,
  tobStepBackTicks: 1,
  forceSeedReentry: false
};

const RECOVERY_ACTIONS: MarketShockDecision["actions"] = {
  spreadMult: 1,
  sizeMult: 0.95,
  reduceLevelsBy: 0,
  sellSkewBps: 0,
  buySkewBps: 2,
  tobStepBackTicks: 0,
  forceSeedReentry: true
};

export class MarketShockController {
  private phase: MarketPhase = "STABILIZING";
  private sinceTs = 0;
  private stabilizingCandidateSinceTs = 0;
  private recoveryCandidateSinceTs = 0;
  private shockVolPeakBps = 0;
  private lastVol5mBps = 0;
  private lastReasons: string[] = [];

  constructor(private readonly cfg: MarketShockConfig) {}

  getState(): MarketShockDecision {
    return {
      phase: this.phase,
      state: this.phase,
      sinceTs: this.sinceTs,
      reasons: this.lastReasons.slice(0, 10),
      shockVolPeakBps: this.shockVolPeakBps,
      actions: this.actionsForState(this.phase)
    };
  }

  update(input: MarketShockInput): MarketShockDecision {
    const now = Math.max(0, Math.floor(Number(input.ts) || Date.now()));
    const normalized = this.normalizeInput(input);
    const shockTriggered = this.isShockTriggered(normalized);
    const triggers = this.collectShockTriggers(normalized);
    const shockMinMs = Math.max(5_000, Math.floor(this.cfg.shockMinSeconds * 1000));
    const noNewLowMs = Math.max(10_000, Math.floor(this.cfg.reentryNoNewLowSeconds * 1000));
    const recoveryPersistMs = Math.max(10_000, Math.floor(this.cfg.recoveryPersistSeconds * 1000));
    const spreadRecoveryThreshold = Math.max(0.1, this.cfg.baselineSpreadBps * 2);
    const stabilizingReady =
      normalized.vol1mBps < Math.max(0.1, normalized.shockVolPeakBps) * 0.6 &&
      normalized.spreadBps < spreadRecoveryThreshold &&
      !normalized.newLowInWindow;
    const recoveryReady =
      normalized.vol5mBps <= this.lastVol5mBps + 0.01 &&
      normalized.dispersionBps < this.cfg.recoveryDispersionBps;

    if (shockTriggered) {
      this.shockVolPeakBps =
        this.phase === "SHOCK"
          ? Math.max(this.shockVolPeakBps, normalized.vol1mBps, normalized.shockVolPeakBps)
          : Math.max(normalized.vol1mBps, normalized.shockVolPeakBps);
      this.transitionTo("SHOCK", now, triggers);
      this.stabilizingCandidateSinceTs = 0;
      this.recoveryCandidateSinceTs = 0;
      this.lastVol5mBps = normalized.vol5mBps;
      return this.getState();
    }

    if (this.phase === "SHOCK") {
      if (now - this.sinceTs >= shockMinMs) {
        this.transitionTo("COOLDOWN", now, ["SHOCK_MIN_TIME_SATISFIED"]);
      }
      this.lastVol5mBps = normalized.vol5mBps;
      return this.getState();
    }

    if (this.phase === "COOLDOWN") {
      if (!stabilizingReady) {
        this.stabilizingCandidateSinceTs = 0;
        this.lastReasons = ["COOLDOWN_WAITING_FOR_NORMALIZATION"];
        this.lastVol5mBps = normalized.vol5mBps;
        return this.getState();
      }
      if (this.stabilizingCandidateSinceTs <= 0) {
        this.stabilizingCandidateSinceTs = now;
        this.lastReasons = ["STABILIZING_PENDING_PERSISTENCE"];
        this.lastVol5mBps = normalized.vol5mBps;
        return this.getState();
      }
      if (now - this.stabilizingCandidateSinceTs >= noNewLowMs) {
        this.transitionTo("STABILIZING", now, ["STABILIZING_CONDITIONS_MET"]);
      } else {
        this.lastReasons = ["STABILIZING_PENDING_PERSISTENCE"];
      }
      this.lastVol5mBps = normalized.vol5mBps;
      return this.getState();
    }

    if (this.phase === "STABILIZING") {
      if (!stabilizingReady) {
        this.transitionTo("COOLDOWN", now, ["REENTRY_REVERTED_TO_COOLDOWN"]);
        this.stabilizingCandidateSinceTs = 0;
        this.recoveryCandidateSinceTs = 0;
        this.lastVol5mBps = normalized.vol5mBps;
        return this.getState();
      }
      if (!recoveryReady) {
        this.recoveryCandidateSinceTs = 0;
        this.lastReasons = ["STABILIZING_WAITING_FOR_RECOVERY"];
        this.lastVol5mBps = normalized.vol5mBps;
        return this.getState();
      }
      if (this.recoveryCandidateSinceTs <= 0) {
        this.recoveryCandidateSinceTs = now;
        this.lastReasons = ["RECOVERY_PENDING_PERSISTENCE"];
        this.lastVol5mBps = normalized.vol5mBps;
        return this.getState();
      }
      if (now - this.recoveryCandidateSinceTs >= recoveryPersistMs) {
        this.transitionTo("RECOVERY", now, ["RECOVERY_CONDITIONS_MET"]);
      } else {
        this.lastReasons = ["RECOVERY_PENDING_PERSISTENCE"];
      }
      this.lastVol5mBps = normalized.vol5mBps;
      return this.getState();
    }

    if (this.phase === "RECOVERY") {
      if (!recoveryReady) {
        this.transitionTo("STABILIZING", now, ["RECOVERY_REVERTED_TO_STABILIZING"]);
      } else {
        this.lastReasons = ["RECOVERY_ACTIVE"];
      }
      this.lastVol5mBps = normalized.vol5mBps;
      return this.getState();
    }

    this.transitionTo("STABILIZING", now, ["STABILIZING_ACTIVE"]);
    this.lastVol5mBps = normalized.vol5mBps;
    return this.getState();
  }

  private normalizeInput(input: MarketShockInput): {
    revxMid: number;
    revxBid: number;
    revxAsk: number;
    spreadBps: number;
    vol1mBps: number;
    vol5mBps: number;
    shockVolPeakBps: number;
    newLowInWindow: boolean;
    dispersionBps: number;
    bookDepthScore: number;
  } {
    return {
      revxMid: Math.max(0, Number(input.revxMid) || 0),
      revxBid: Math.max(0, Number(input.revxBid) || 0),
      revxAsk: Math.max(0, Number(input.revxAsk) || 0),
      spreadBps: Math.max(0, Number(input.spreadBps) || 0),
      vol1mBps: Math.max(0, Number(input.vol1mBps) || 0),
      vol5mBps: Math.max(0, Number(input.vol5mBps) || 0),
      shockVolPeakBps: Math.max(0, Number(input.shockVolPeakBps) || 0),
      newLowInWindow: input.newLowInWindow === true,
      dispersionBps: Math.max(0, Number(input.dispersionBps) || 0),
      bookDepthScore: clamp(Number(input.bookDepthScore) || 1, 0, 10)
    };
  }

  private isShockTriggered(input: {
    spreadBps: number;
    vol1mBps: number;
    dispersionBps: number;
  }): boolean {
    return (
      input.vol1mBps >= this.cfg.shockEnterBps ||
      input.spreadBps >= this.cfg.shockSpreadBps ||
      input.dispersionBps >= this.cfg.shockDispersionBps
    );
  }

  private collectShockTriggers(input: {
    spreadBps: number;
    vol1mBps: number;
    dispersionBps: number;
    bookDepthScore: number;
  }): string[] {
    const triggers: string[] = [];
    const vol = input.vol1mBps;
    const dispersion = input.dispersionBps;
    const spread = input.spreadBps;
    const depth = input.bookDepthScore;

    if (vol >= this.cfg.shockEnterBps) {
      triggers.push(`VOL_SHOCK (${vol.toFixed(2)} >= ${this.cfg.shockEnterBps.toFixed(2)})`);
    }
    if (spread >= this.cfg.shockSpreadBps) {
      triggers.push(
        `SPREAD_SHOCK (${spread.toFixed(2)} >= ${this.cfg.shockSpreadBps.toFixed(2)})`
      );
    }
    if (dispersion >= this.cfg.shockDispersionBps) {
      triggers.push(
        `DISPERSION_SHOCK (${dispersion.toFixed(2)} >= ${this.cfg.shockDispersionBps.toFixed(2)})`
      );
    }
    if (depth < 0.5) {
      triggers.push(`BOOK_DEPTH_THIN (score=${depth.toFixed(2)})`);
    }
    return triggers.slice(0, 8);
  }

  private transitionTo(next: MarketPhase, ts: number, reasons: string[]): void {
    if (next !== this.phase) {
      this.phase = next;
      this.sinceTs = ts;
    } else if (this.sinceTs <= 0 || ts < this.sinceTs) {
      this.sinceTs = ts;
    }
    this.lastReasons = reasons.slice(0, 8);
  }

  private actionsForState(state: MarketPhase): MarketShockDecision["actions"] {
    if (state === "SHOCK") return { ...SHOCK_ACTIONS };
    if (state === "COOLDOWN") return { ...COOLDOWN_ACTIONS };
    if (state === "STABILIZING") return { ...STABILIZING_ACTIONS };
    return { ...RECOVERY_ACTIONS };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
