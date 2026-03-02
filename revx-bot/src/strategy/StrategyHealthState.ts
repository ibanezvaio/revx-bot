export type StrategyHealthSnapshot = {
  lastCycleCompletedTs: number;
  stalled: boolean;
};

class StrategyHealthState {
  private lastCycleCompletedTs = 0;
  private stalled = false;

  reset(): void {
    this.lastCycleCompletedTs = 0;
    this.stalled = false;
  }

  markCycleCompleted(ts?: number): void {
    const now = Number.isFinite(ts ?? Number.NaN) ? Number(ts) : Date.now();
    this.lastCycleCompletedTs = Math.max(0, now);
    this.stalled = false;
  }

  setStalled(stalled: boolean): void {
    this.stalled = Boolean(stalled);
  }

  getSnapshot(): StrategyHealthSnapshot {
    return {
      lastCycleCompletedTs: this.lastCycleCompletedTs,
      stalled: this.stalled
    };
  }
}

export const strategyHealthState = new StrategyHealthState();
