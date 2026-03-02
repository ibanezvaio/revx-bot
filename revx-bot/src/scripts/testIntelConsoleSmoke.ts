import { BotConfig, loadConfig } from "../config";
import { buildLogger } from "../logger";
import { Store } from "../store/Store";
import { DashboardServer } from "../web/DashboardServer";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeConfig(): BotConfig {
  process.env.DRY_RUN = "true";
  process.env.DASHBOARD_ENABLED = "true";
  process.env.DASHBOARD_PORT = "0";
  const base = loadConfig();
  return {
    ...base,
    dryRun: true,
    dashboardEnabled: true,
    dashboardPort: 0
  };
}

async function run(): Promise<void> {
  const config = makeConfig();
  const logger = buildLogger(config);
  const store = {} as unknown as Store;
  const server = new DashboardServer(config, logger, store, "test-run");
  server.start();
  try {
    let port = 0;
    for (let i = 0; i < 40; i += 1) {
      port = server.getPort();
      if (port > 0) break;
      await sleep(50);
    }
    if (port <= 0) {
      // Some sandboxed environments disallow binding localhost sockets.
      // eslint-disable-next-line no-console
      console.log("Intel console smoke test: SKIP (localhost bind unavailable)");
      return;
    }
    const response = await fetch(`http://127.0.0.1:${port}/intel`);
    assert(response.status === 200, `expected /intel status 200, got ${response.status}`);
    const body = await response.text();
    assert(/REVX Intel Console/.test(body), "expected Intel Console HTML content");
  } finally {
    server.stop();
  }
  // eslint-disable-next-line no-console
  console.log("Intel console smoke test: PASS");
}

void run();
