import { BotConfig } from "../config";
import { Logger } from "../logger";

export type PortfolioVenueRiskSnapshot = {
  venue: "REVX" | "POLYMARKET";
  enabled: boolean;
  mode: "LIVE" | "PAPER" | "DRY_RUN" | "DISABLED";
  targetCapUsd: number;
  hardCapUsd: number;
  dailyLossCapUsd: number;
  notes: string[];
};

export type PortfolioRiskSnapshot = {
  ts: number;
  enforcementMode: "STARTUP_GATE";
  totalTargetCapUsd: number;
  totalHardCapUsd: number;
  totalDailyLossCapUsd: number;
  venues: PortfolioVenueRiskSnapshot[];
  notes: string[];
};

export type VenueStartupAction = "START" | "SKIP";

export type PortfolioVenueRuntimePlan = PortfolioVenueRiskSnapshot & {
  startupAction: VenueStartupAction;
  startupReason: string;
  consumesLiveCapital: boolean;
  requestedStartupBudgetUsd: number;
  allocatedStartupBudgetUsd: number;
  isPrimaryVenue: boolean;
};

export type PortfolioRuntimePlan = {
  ts: number;
  enforcementMode: "STARTUP_GATE";
  totalIndependentWorkingCapUsd: number;
  totalAllocatedVenueBudgetUsd: number;
  totalUnallocatedVenueBudgetUsd: number;
  totalRequestedStartupBudgetUsd: number;
  totalAllocatedStartupBudgetUsd: number;
  venueBudgetUtilization: number;
  venues: PortfolioVenueRuntimePlan[];
  notes: string[];
};

export type PortfolioVenueObservation = {
  started: boolean;
  exposureUsd: number;
  realizedPnlUsd: number;
};

export type PortfolioRuntimeObservation = {
  revx: PortfolioVenueObservation;
  polymarket: PortfolioVenueObservation;
};

export type PortfolioVenueEntryPolicy = {
  allowNewEntries: boolean;
  additionalBudgetUsd: number;
  reason: string | null;
};

export type RevxPortfolioQuotePolicy = {
  allowNewBuyRisk: boolean;
  effectiveWorkingCapUsd: number;
  effectiveTargetBtcNotionalUsd: number;
  effectiveMaxBtcNotionalUsd: number;
  buySizeMultiplier: number;
  reason: string | null;
};

export type PortfolioRuntimePolicy = {
  ts: number;
  totalLiveExposureUsd: number;
  totalRealizedPnlUsd: number;
  totalIndependentWorkingCapUsd: number;
  totalUnallocatedVenueBudgetUsd: number;
  revxQuotePolicy: RevxPortfolioQuotePolicy;
  polymarketEntryPolicy: PortfolioVenueEntryPolicy;
  notes: string[];
};

export class PortfolioRiskCoordinator {
  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger
  ) {}

  getSnapshot(nowTs = Date.now()): PortfolioRiskSnapshot {
    const venues = this.buildVenueSnapshots();
    return {
      ts: nowTs,
      enforcementMode: "STARTUP_GATE",
      totalTargetCapUsd: venues.reduce((sum, venue) => sum + venue.targetCapUsd, 0),
      totalHardCapUsd: venues.reduce((sum, venue) => sum + venue.hardCapUsd, 0),
      totalDailyLossCapUsd: venues.reduce((sum, venue) => sum + venue.dailyLossCapUsd, 0),
      venues,
      notes: [
        "Portfolio coordinator now produces startup admission decisions for each venue",
        "RevX and Polymarket capital budgets are independent; only signal is shared"
      ]
    };
  }

  getRuntimePlan(nowTs = Date.now()): PortfolioRuntimePlan {
    const snapshot = this.getSnapshot(nowTs);
    const totalIndependentWorkingCapUsd = snapshot.venues.reduce((sum, venue) => sum + venue.hardCapUsd, 0);
    const revx = snapshot.venues.find((venue) => venue.venue === "REVX");
    const polymarket = snapshot.venues.find((venue) => venue.venue === "POLYMARKET");
    const venues: PortfolioVenueRuntimePlan[] = [];

    let totalAllocatedVenueBudgetUsd = 0;

    if (revx) {
      const consumesLiveCapital = revx.mode === "LIVE";
      const requestedStartupBudgetUsd = consumesLiveCapital
        ? Math.min(revx.targetCapUsd, revx.hardCapUsd)
        : 0;
      const revxPlan = this.buildStartupPlan({
        snapshot: revx,
        consumesLiveCapital,
        requestedStartupBudgetUsd,
        allocatedStartupBudgetUsd: requestedStartupBudgetUsd,
        isPrimaryVenue: true,
        capitalAvailableUsd: requestedStartupBudgetUsd
      });
      venues.push(revxPlan);
      totalAllocatedVenueBudgetUsd += revxPlan.allocatedStartupBudgetUsd;
    }

    if (polymarket) {
      const consumesLiveCapital = polymarket.mode === "LIVE";
      const requestedStartupBudgetUsd = consumesLiveCapital
        ? Math.min(polymarket.targetCapUsd, polymarket.hardCapUsd)
        : 0;
      const capitalAvailableUsd = requestedStartupBudgetUsd;
      const allocatedStartupBudgetUsd = consumesLiveCapital ? requestedStartupBudgetUsd : 0;
      venues.push(
        this.buildStartupPlan({
          snapshot: polymarket,
          consumesLiveCapital,
          requestedStartupBudgetUsd,
          allocatedStartupBudgetUsd,
          isPrimaryVenue: false,
          capitalAvailableUsd
        })
      );
      totalAllocatedVenueBudgetUsd += allocatedStartupBudgetUsd;
    }

    const totalRequestedStartupBudgetUsd = venues.reduce((sum, venue) => sum + venue.requestedStartupBudgetUsd, 0);
    const totalAllocatedStartupBudgetUsd = venues.reduce((sum, venue) => sum + venue.allocatedStartupBudgetUsd, 0);
    const totalUnallocatedVenueBudgetUsd = Math.max(0, totalIndependentWorkingCapUsd - totalAllocatedVenueBudgetUsd);

    return {
      ts: nowTs,
      enforcementMode: "STARTUP_GATE",
      totalIndependentWorkingCapUsd,
      totalAllocatedVenueBudgetUsd,
      totalUnallocatedVenueBudgetUsd,
      totalRequestedStartupBudgetUsd,
      totalAllocatedStartupBudgetUsd,
      venueBudgetUtilization:
        totalIndependentWorkingCapUsd > 0
          ? Math.max(0, Math.min(1, totalAllocatedStartupBudgetUsd / totalIndependentWorkingCapUsd))
          : 0,
      venues,
      notes: [
        "Startup gate only admits venues that have explicit venue-local budget and loss protection",
        "RevX and Polymarket startup budgets are independent and do not reserve capital from each other",
        "Paper and dry-run venues remain admissible for research because they do not consume live capital"
      ]
    };
  }

  logStartupSnapshot(nowTs = Date.now()): void {
    this.logger.warn(this.getRuntimePlan(nowTs), "PORTFOLIO_RISK_COORDINATOR_READY");
  }

  evaluateRuntimePolicy(
    observation: PortfolioRuntimeObservation,
    nowTs = Date.now()
  ): PortfolioRuntimePolicy {
    const runtimePlan = this.getRuntimePlan(nowTs);
    const revxPlan = runtimePlan.venues.find((venue) => venue.venue === "REVX");
    const polymarketPlan = runtimePlan.venues.find((venue) => venue.venue === "POLYMARKET");
    const totalLiveExposureUsd = clampNonNegative(observation.revx.exposureUsd) + clampNonNegative(observation.polymarket.exposureUsd);
    const totalRealizedPnlUsd = Number(observation.revx.realizedPnlUsd || 0) + Number(observation.polymarket.realizedPnlUsd || 0);
    const revxQuotePolicy = this.buildRevxQuotePolicy({
      runtimePlan,
      revxPlan,
      observation
    });
    const polymarketEntryPolicy = this.buildPolymarketEntryPolicy({
      runtimePlan,
      polymarketPlan,
      observation
    });

    return {
      ts: nowTs,
      totalLiveExposureUsd,
      totalRealizedPnlUsd,
      totalIndependentWorkingCapUsd: runtimePlan.totalIndependentWorkingCapUsd,
      totalUnallocatedVenueBudgetUsd: runtimePlan.totalUnallocatedVenueBudgetUsd,
      revxQuotePolicy,
      polymarketEntryPolicy,
      notes: [
        "RevX and Polymarket runtime budgets are enforced independently",
        "No cross-venue capital reservation is applied; only signal is shared"
      ]
    };
  }

  private buildVenueSnapshots(): PortfolioVenueRiskSnapshot[] {
    const revxMode: PortfolioVenueRiskSnapshot["mode"] = this.config.dryRun ? "DRY_RUN" : "LIVE";
    const revxTargetCapUsd = safePositive(this.config.targetBtcNotionalUsd);
    const revxHardCapUsd = Math.max(
      0,
      Math.min(
        safePositive(this.config.workingCapUsd),
        safePositive(this.config.maxInventoryUsd),
        safePositive(this.config.maxBtcNotionalUsd)
      )
    );
    const revxDailyLossCapUsd = Math.abs(Number(this.config.pnlDailyStopUsd || 0));

    const polymarketEnabled = Boolean(this.config.polymarket.enabled);
    const polymarketMode: PortfolioVenueRiskSnapshot["mode"] = !polymarketEnabled
      ? "DISABLED"
      : this.config.polymarket.mode === "paper"
        ? "PAPER"
        : "LIVE";
    const polymarketTargetCapUsd = safePositive(this.config.polymarket.sizing.maxNotionalPerWindow);
    const polymarketHardCapUsd = Math.max(
      0,
      Math.min(
        safePositive(this.config.polymarket.risk.maxExposure),
        safePositive(this.config.polymarket.sizing.maxNotionalPerWindow) *
          Math.max(1, Math.floor(Number(this.config.polymarket.sizing.maxConcurrentWindows || 1)))
      )
    );
    const polymarketDailyLossCapUsd = safePositive(this.config.polymarket.sizing.maxDailyLoss);

    return [
      {
        venue: "REVX",
        enabled: true,
        mode: revxMode,
        targetCapUsd: revxTargetCapUsd,
        hardCapUsd: revxHardCapUsd,
        dailyLossCapUsd: revxDailyLossCapUsd,
        notes: ["Derived from workingCapUsd, maxInventoryUsd, maxBtcNotionalUsd, and pnlDailyStopUsd"]
      },
      {
        venue: "POLYMARKET",
        enabled: polymarketEnabled,
        mode: polymarketMode,
        targetCapUsd: polymarketTargetCapUsd,
        hardCapUsd: polymarketHardCapUsd,
        dailyLossCapUsd: polymarketDailyLossCapUsd,
        notes: ["Derived from maxNotionalPerWindow, maxConcurrentWindows, maxExposure, and maxDailyLoss"]
      }
    ];
  }

  private buildStartupPlan(input: {
    snapshot: PortfolioVenueRiskSnapshot;
    consumesLiveCapital: boolean;
    requestedStartupBudgetUsd: number;
    allocatedStartupBudgetUsd: number;
    isPrimaryVenue: boolean;
    capitalAvailableUsd: number;
  }): PortfolioVenueRuntimePlan {
    const { snapshot } = input;
    const isSimulation = snapshot.mode === "DRY_RUN" || snapshot.mode === "PAPER";
    let startupAction: VenueStartupAction = "START";
    let startupReason = isSimulation ? "SIMULATION_MODE_ALLOWED" : "LIVE_CAPITAL_ALLOCATED";
    const notes = [...snapshot.notes];

    if (!snapshot.enabled || snapshot.mode === "DISABLED") {
      startupAction = "SKIP";
      startupReason = "CONFIG_DISABLED";
    } else if (!isSimulation && input.requestedStartupBudgetUsd <= 0) {
      startupAction = "SKIP";
      startupReason = "NO_EFFECTIVE_STARTUP_BUDGET";
    } else if (!isSimulation && snapshot.hardCapUsd <= 0) {
      startupAction = "SKIP";
      startupReason = "NO_EFFECTIVE_HARD_CAP";
    } else if (!isSimulation && snapshot.dailyLossCapUsd <= 0) {
      startupAction = "SKIP";
      startupReason = "NO_DAILY_LOSS_GUARD";
    } else if (
      !isSimulation &&
      input.consumesLiveCapital &&
      input.allocatedStartupBudgetUsd + 1e-9 < input.requestedStartupBudgetUsd
    ) {
      startupAction = "SKIP";
      startupReason = "INSUFFICIENT_VENUE_STARTUP_BUDGET";
      notes.push(
        `Capital available at startup ${input.capitalAvailableUsd.toFixed(2)} below requested ${input.requestedStartupBudgetUsd.toFixed(2)}`
      );
    }

    if (startupAction === "START" && isSimulation) {
      notes.push("Simulation mode admitted without consuming shared live capital");
    }
    if (startupAction === "START" && input.consumesLiveCapital) {
      notes.push(`Allocated startup budget ${input.allocatedStartupBudgetUsd.toFixed(2)} USD`);
    }

    return {
      ...snapshot,
      notes,
      startupAction,
      startupReason,
      consumesLiveCapital: input.consumesLiveCapital,
      requestedStartupBudgetUsd: input.requestedStartupBudgetUsd,
      allocatedStartupBudgetUsd: startupAction === "START" ? input.allocatedStartupBudgetUsd : 0,
      isPrimaryVenue: input.isPrimaryVenue
    };
  }

  private buildPolymarketEntryPolicy(input: {
    runtimePlan: PortfolioRuntimePlan;
    polymarketPlan: PortfolioVenueRuntimePlan | undefined;
    observation: PortfolioRuntimeObservation;
  }): PortfolioVenueEntryPolicy {
    const { polymarketPlan } = input;
    if (!polymarketPlan || polymarketPlan.startupAction !== "START") {
      return {
        allowNewEntries: false,
        additionalBudgetUsd: 0,
        reason: polymarketPlan?.startupReason ?? "CONFIG_DISABLED"
      };
    }
    if (
      polymarketPlan.dailyLossCapUsd > 0 &&
      Number(input.observation.polymarket.realizedPnlUsd || 0) <= -Math.abs(polymarketPlan.dailyLossCapUsd)
    ) {
      return {
        allowNewEntries: false,
        additionalBudgetUsd: 0,
        reason: "POLYMARKET_DAILY_LOSS_LIMIT"
      };
    }

    const remainingPolyHardCapUsd = Math.max(
      0,
      polymarketPlan.hardCapUsd - clampNonNegative(input.observation.polymarket.exposureUsd)
    );
    const remainingPolyTargetUsd = Math.max(
      0,
      polymarketPlan.targetCapUsd - clampNonNegative(input.observation.polymarket.exposureUsd)
    );
    const budgetCapUsd =
      polymarketPlan.targetCapUsd > 0 ? Math.min(remainingPolyTargetUsd, remainingPolyHardCapUsd) : remainingPolyHardCapUsd;
    const additionalBudgetUsd = Math.max(0, budgetCapUsd);

    if (remainingPolyHardCapUsd <= 0) {
      return {
        allowNewEntries: false,
        additionalBudgetUsd: 0,
        reason: "POLYMARKET_HARD_CAP_REACHED"
      };
    }
    if (additionalBudgetUsd <= 0) {
      return {
        allowNewEntries: false,
        additionalBudgetUsd: 0,
        reason: "POLYMARKET_TARGET_BUDGET_EXHAUSTED"
      };
    }

    return {
      allowNewEntries: true,
      additionalBudgetUsd,
      reason: null
    };
  }

  private buildRevxQuotePolicy(input: {
    runtimePlan: PortfolioRuntimePlan;
    revxPlan: PortfolioVenueRuntimePlan | undefined;
    observation: PortfolioRuntimeObservation;
  }): RevxPortfolioQuotePolicy {
    const { revxPlan } = input;
    if (!revxPlan || revxPlan.startupAction !== "START") {
      return {
        allowNewBuyRisk: false,
        effectiveWorkingCapUsd: 0,
        effectiveTargetBtcNotionalUsd: 0,
        effectiveMaxBtcNotionalUsd: 0,
        buySizeMultiplier: 0,
        reason: revxPlan?.startupReason ?? "CONFIG_DISABLED"
      };
    }
    if (
      revxPlan.dailyLossCapUsd > 0 &&
      Number(input.observation.revx.realizedPnlUsd || 0) <= -Math.abs(revxPlan.dailyLossCapUsd)
    ) {
      return {
        allowNewBuyRisk: false,
        effectiveWorkingCapUsd: 0,
        effectiveTargetBtcNotionalUsd: 0,
        effectiveMaxBtcNotionalUsd: 0,
        buySizeMultiplier: 0,
        reason: "REVX_DAILY_LOSS_LIMIT"
      };
    }

    const effectiveWorkingCapUsd = Math.max(0, revxPlan.hardCapUsd);
    const effectiveMaxBtcNotionalUsd = Math.max(0, revxPlan.hardCapUsd);
    const effectiveTargetBtcNotionalUsd = Math.max(0, Math.min(revxPlan.targetCapUsd, effectiveMaxBtcNotionalUsd));
    const buySizeMultiplier = revxPlan.hardCapUsd > 0 ? 1 : 0;
    const reason = effectiveMaxBtcNotionalUsd <= 0 ? "REVX_HARD_CAP_UNAVAILABLE" : null;

    return {
      allowNewBuyRisk: effectiveMaxBtcNotionalUsd > 0,
      effectiveWorkingCapUsd,
      effectiveTargetBtcNotionalUsd,
      effectiveMaxBtcNotionalUsd,
      buySizeMultiplier,
      reason
    };
  }
}

function safePositive(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function clampNonNegative(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}
