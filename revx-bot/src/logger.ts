import pino from "pino";
import { BotConfig } from "./config";

export function buildLogger(config: BotConfig) {
  return pino({
    level: config.logLevel,
    base: {
      pid: process.pid,
      app: "revx-bot"
    },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err
    },
    timestamp: pino.stdTimeFunctions.isoTime
  });
}

export type Logger = ReturnType<typeof buildLogger>;
