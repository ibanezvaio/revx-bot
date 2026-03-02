import { dirname, extname, basename, join } from "node:path";
import { BotConfig } from "../config";
import { Logger } from "../logger";
import { buildRuntimeOverrideDefaults } from "../overrides/runtimeOverrides";
import { Store } from "./Store";
import { JsonStore } from "./jsonStore";

export function createStore(config: BotConfig, logger: Logger): Store {
  const runtimeDefaults = buildRuntimeOverrideDefaults(config);
  if (config.storeBackend === "json") {
    const jsonPath = toJsonPath(config.dbPath);
    logger.info({ jsonPath }, "Using JSON store");
    return new JsonStore(jsonPath, {
      maxBotEvents: Math.max(config.maxApiEvents, config.maxUiEvents, 500),
      maxSignalPoints: config.maxSignalPoints,
      eventDedupe: config.eventDedupe,
      runtimeDefaults
    });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqliteModule = require("./sqlite") as {
      SQLiteStore: new (
        dbPath: string,
        runtimeDefaults: ReturnType<typeof buildRuntimeOverrideDefaults>
      ) => Store;
    };
    logger.info({ dbPath: config.dbPath }, "Using SQLite store");
    return new sqliteModule.SQLiteStore(config.dbPath, runtimeDefaults);
  } catch (error) {
    const reason = (error as Error).message;
    const installHint = "Install: npm i better-sqlite3";
    logger.error({ reason }, installHint);
    throw new Error(`SQLite backend requested but unavailable. ${installHint}`);
  }
}

function toJsonPath(dbPath: string): string {
  if (extname(dbPath).length > 0) {
    return join(dirname(dbPath), `${basename(dbPath, extname(dbPath))}.json`);
  }
  return `${dbPath}.json`;
}
