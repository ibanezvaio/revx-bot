import { QuoteInputs } from "./QuoteDebugState";

export type SeedMode = "SEED_BUY" | "ACCUMULATE_BTC" | "TWO_SIDED" | "REBALANCE";

export type SeedState = {
  mode: SeedMode;
  reason: string;
  progress: {
    btcNotionalUsd: number;
    lowGateUsd: number;
    targetUsd: number;
  };
};

export type MakerConfig = {
  lowBtcGateUsd: number;
  targetBtcNotionalUsd: number;
  maxBtcNotionalUsd?: number | null;
  minBtcNotionalUsd?: number | null;
  seedTargetBtcNotionalUsd?: number | null;
};

export function computeSeedState(inputs: QuoteInputs, cfg: MakerConfig): SeedState {
  const btcNotionalUsd = computeBtcNotionalUsd(inputs);
  const lowGateUsd = safe(cfg.lowBtcGateUsd);
  const targetUsd = safe(cfg.targetBtcNotionalUsd);
  const minBtcNotionalUsd =
    Number.isFinite(Number(cfg.minBtcNotionalUsd)) && Number(cfg.minBtcNotionalUsd) > 0
      ? Number(cfg.minBtcNotionalUsd)
      : 10;
  const seedTargetUsd =
    Number.isFinite(Number(cfg.seedTargetBtcNotionalUsd)) && Number(cfg.seedTargetBtcNotionalUsd) > 0
      ? Number(cfg.seedTargetBtcNotionalUsd)
      : targetUsd;
  const accumulateUntilUsd = Math.max(lowGateUsd, minBtcNotionalUsd, seedTargetUsd);
  const maxBtcNotionalUsd =
    Number.isFinite(Number(cfg.maxBtcNotionalUsd)) && Number(cfg.maxBtcNotionalUsd) > 0
      ? Number(cfg.maxBtcNotionalUsd)
      : targetUsd * 1.5;

  if (btcNotionalUsd < accumulateUntilUsd) {
    const reason =
      btcNotionalUsd < minBtcNotionalUsd
        ? "Below minimum BTC notional"
        : btcNotionalUsd < lowGateUsd
          ? "Below low BTC gate"
          : "Below seed target BTC notional";
    return {
      mode: "ACCUMULATE_BTC",
      reason,
      progress: {
        btcNotionalUsd,
        lowGateUsd,
        targetUsd: seedTargetUsd
      }
    };
  }

  if (btcNotionalUsd > maxBtcNotionalUsd) {
    return {
      mode: "REBALANCE",
      reason: "Above max BTC notional",
      progress: {
        btcNotionalUsd,
        lowGateUsd,
        targetUsd
      }
    };
  }

  return {
    mode: "TWO_SIDED",
    reason: "Inventory healthy",
    progress: {
      btcNotionalUsd,
      lowGateUsd,
      targetUsd
    }
  };
}

function computeBtcNotionalUsd(inputs: QuoteInputs): number {
  const mid = safe(inputs.mid);
  const btcTotal = safe(inputs.btcTotal);
  if (mid > 0 && btcTotal >= 0) {
    return btcTotal * mid;
  }
  return safe(inputs.btcNotionalUsd);
}

function safe(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}
