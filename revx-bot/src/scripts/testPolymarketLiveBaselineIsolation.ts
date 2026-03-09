import { loadConfig } from "../config";
import { MakerStrategy } from "../strategy/MakerStrategy";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function shouldDisableBaseline(config: ReturnType<typeof loadConfig>): boolean {
  const strategy = Object.create(MakerStrategy.prototype) as {
    config: ReturnType<typeof loadConfig>;
    shouldDisableForcedBaselineWhilePolymarketLive: () => boolean;
  };
  strategy.config = config;
  return strategy.shouldDisableForcedBaselineWhilePolymarketLive();
}

async function run(): Promise<void> {
  const base = loadConfig();

  const disabledConfig = {
    ...base,
    quotingForceBaselineWhenEnabled: true,
    polymarket: {
      ...base.polymarket,
      enabled: true,
      mode: "live" as const,
      debugDisableRevolutBaselineWhileLive: true
    }
  };

  const enabledConfig = {
    ...base,
    quotingForceBaselineWhenEnabled: true,
    polymarket: {
      ...base.polymarket,
      enabled: true,
      mode: "live" as const,
      debugDisableRevolutBaselineWhileLive: false
    }
  };

  const paperConfig = {
    ...base,
    quotingForceBaselineWhenEnabled: true,
    polymarket: {
      ...base.polymarket,
      enabled: true,
      mode: "paper" as const,
      debugDisableRevolutBaselineWhileLive: true
    }
  };

  assert(
    shouldDisableBaseline(disabledConfig) === true,
    "baseline should be disabled when polymarket live isolation flag is enabled"
  );
  assert(
    shouldDisableBaseline(enabledConfig) === false,
    "baseline should stay enabled when polymarket live isolation flag is disabled"
  );
  assert(
    shouldDisableBaseline(paperConfig) === false,
    "baseline should not be force-disabled while polymarket runs in paper mode"
  );

  const baselineWillRunWhenDisabled =
    disabledConfig.quotingForceBaselineWhenEnabled && !shouldDisableBaseline(disabledConfig);
  const baselineWillRunWhenEnabled =
    enabledConfig.quotingForceBaselineWhenEnabled && !shouldDisableBaseline(enabledConfig);

  assert(
    baselineWillRunWhenDisabled === false,
    "forced baseline placement should be suppressed while polymarket live isolation is active"
  );
  assert(
    baselineWillRunWhenEnabled === true,
    "forced baseline placement should remain active when polymarket live isolation is disabled"
  );

  // eslint-disable-next-line no-console
  console.log("Polymarket live baseline isolation test: PASS");
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Polymarket live baseline isolation test: FAIL", error);
  process.exit(1);
});
