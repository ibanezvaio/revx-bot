import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PaperLedger } from "./PaperLedger";

export type PaperHistoryResetResult = {
  timestamp: string;
  backupDir: string;
  backupFiles: string[];
  resetFiles: string[];
};

export function archiveAndResetPaperHistory(input: {
  rootDir?: string;
  now?: Date;
  extraTargets?: string[];
} = {}): PaperHistoryResetResult {
  const rootDir = path.resolve(input.rootDir || process.cwd());
  const now = input.now ?? new Date();
  const timestamp = formatUtcTimestamp(now);
  const backupDir = path.join(rootDir, "backups", `paper-reset-${timestamp}`);
  mkdirSync(backupDir, { recursive: true });

  const configuredTargets = Array.isArray(input.extraTargets) ? input.extraTargets : [];
  const relativeTargets = Array.from(
    new Set(
      [
        "data/polymarket-paper-ledger.jsonl",
        "logs/polymarket-paper-trades.jsonl",
        "logs/polymarket-decisions.jsonl",
        ...configuredTargets
      ].filter((target) => String(target || "").trim().length > 0)
    )
  );
  const backupFiles: string[] = [];
  const resetFiles: string[] = [];

  for (const rawTarget of relativeTargets) {
    const absolutePath = path.isAbsolute(rawTarget)
      ? path.resolve(rawTarget)
      : path.join(rootDir, rawTarget);
    const targetDir = path.dirname(absolutePath);
    mkdirSync(targetDir, { recursive: true });

    if (existsSync(absolutePath)) {
      const parsed = path.parse(absolutePath);
      const backupPath = path.join(backupDir, `${parsed.name}.${timestamp}${parsed.ext}`);
      renameSync(absolutePath, backupPath);
      backupFiles.push(backupPath);
    }

    writeFileSync(absolutePath, "", "utf8");
    resetFiles.push(absolutePath);
  }

  // Force a clean summary snapshot from the empty ledger so downstream truth/status reads start at zero.
  const resetLedger = new PaperLedger(path.join(rootDir, "data", "polymarket-paper-ledger.jsonl"));
  void resetLedger.getSummary(now.getTime());

  return {
    timestamp,
    backupDir,
    backupFiles,
    resetFiles
  };
}

function formatUtcTimestamp(input: Date): string {
  const year = input.getUTCFullYear();
  const month = String(input.getUTCMonth() + 1).padStart(2, "0");
  const day = String(input.getUTCDate()).padStart(2, "0");
  const hour = String(input.getUTCHours()).padStart(2, "0");
  const minute = String(input.getUTCMinutes()).padStart(2, "0");
  const second = String(input.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}
