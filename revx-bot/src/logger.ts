import pino from "pino";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { BotConfig } from "./config";

export function buildLogger(config: BotConfig) {
  const destination = createFilteredDestination(config);
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
  }, destination);
}

export type Logger = ReturnType<typeof buildLogger>;

function createFilteredDestination(config: Pick<BotConfig, "logModules">): NodeJS.WritableStream {
  const verboseLogPath = path.join(process.cwd(), "logs", "verbose.log");
  mkdirSync(path.dirname(verboseLogPath), { recursive: true });
  const verboseStream = createWriteStream(verboseLogPath, { flags: "a" });
  const debugAll = isTruthyEnv(process.env.DEBUG);
  const debugRecon = isTruthyEnv(process.env.DEBUG_RECON);
  const debugPoly = isTruthyEnv(process.env.DEBUG_POLY);
  const defaultStdoutPrefixes = ["REVX_ORDER ", "REVX_FILL ", "POLY_STATUS ", "POLY_TRADE ", "TRUTH "];
  const modules = Array.isArray(config.logModules)
    ? config.logModules
        .map((row) => String(row || "").trim().toLowerCase())
        .filter((row) => row.length > 0)
    : [];
  const allow = new Set(modules);
  const emitStdoutForModule = (moduleName: string): boolean => {
    if (allow.has("all")) return true;
    if (allow.has(moduleName)) return true;
    if (debugRecon && moduleName === "recon") return true;
    if (debugPoly && moduleName === "polymarket") return true;
    return false;
  };
  const shouldEmitByMessage = (message: string): boolean =>
    defaultStdoutPrefixes.some((prefix) => message.startsWith(prefix));

  return new Writable({
    write(chunk, _encoding, callback) {
      const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      if (!raw) {
        callback();
        return;
      }
      verboseStream.write(raw);
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let emit = false;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const message = String(parsed.msg || "");
          const level = Number(parsed.level);
          const moduleName = String(parsed.module || "core").trim().toLowerCase();
          emit =
            debugAll ||
            (Number.isFinite(level) && level >= 40) ||
            shouldEmitByMessage(message) ||
            emitStdoutForModule(moduleName);
        } catch {
          emit = debugAll;
        }
        if (emit) {
          process.stdout.write(trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`);
        }
      }
      callback();
    }
  });
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
