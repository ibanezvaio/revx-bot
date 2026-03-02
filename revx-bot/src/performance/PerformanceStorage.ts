import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { Logger } from "../logger";
import { MidSnapshotRow, PersistedFillRow } from "./types";

type AdaptiveEventRow = {
  ts: number;
  action: string;
  reason: string;
  before_params_json: string;
  after_params_json: string;
  metrics_json: string;
};

type AnalysisRunRow = {
  ts: number;
  window: string;
  metrics_json: string;
};

type JsonlPayload = PersistedFillRow | MidSnapshotRow | AnalysisRunRow | AdaptiveEventRow;

type QueryHealth = {
  mode: "sqlite" | "jsonl";
  dbPath: string;
  lastError: string | null;
};

export class PerformanceStorage {
  private readonly dataDir: string;
  private readonly dbPath: string;
  private readonly jsonlPathByTable: Record<string, string>;
  private mode: "sqlite" | "jsonl" = "jsonl";
  private db: any | null = null;
  private lastError: string | null = null;

  constructor(
    runtimeBaseDir: string,
    private readonly logger: Logger
  ) {
    this.dataDir = join(runtimeBaseDir, "data");
    this.dbPath = join(this.dataDir, "revx.db");
    this.jsonlPathByTable = {
      fills: join(this.dataDir, "fills.jsonl"),
      mid_snapshots: join(this.dataDir, "mid_snapshots.jsonl"),
      analysis_runs: join(this.dataDir, "analysis_runs.jsonl"),
      adaptive_events: join(this.dataDir, "adaptive_events.jsonl")
    };
    mkdirSync(this.dataDir, { recursive: true });
    this.init();
  }

  getHealth(): QueryHealth {
    return {
      mode: this.mode,
      dbPath: this.dbPath,
      lastError: this.lastError
    };
  }

  recordFill(fill: PersistedFillRow): void {
    const normalized = {
      ...fill,
      id: fill.id || this.makeFillId(fill)
    };
    if (this.mode === "sqlite" && this.db) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO fills
           (id, ts, symbol, side, price, base_qty, quote_qty, fee_usd, order_id, client_order_id, posture, revx_mid_at_fill, source_json)
           VALUES (@id, @ts, @symbol, @side, @price, @base_qty, @quote_qty, @fee_usd, @order_id, @client_order_id, @posture, @revx_mid_at_fill, @source_json)`
        )
        .run(normalized);
      return;
    }
    this.appendJsonl("fills", normalized);
  }

  recordMidSnapshot(row: MidSnapshotRow): void {
    if (this.mode === "sqlite" && this.db) {
      this.db
        .prepare(
          `INSERT INTO mid_snapshots (ts, symbol, revx_bid, revx_ask, revx_mid)
           VALUES (@ts, @symbol, @revx_bid, @revx_ask, @revx_mid)`
        )
        .run(row);
      return;
    }
    this.appendJsonl("mid_snapshots", row);
  }

  pruneMidSnapshots(olderThanTs: number): void {
    if (this.mode === "sqlite" && this.db) {
      this.db
        .prepare("DELETE FROM mid_snapshots WHERE ts < ?")
        .run(Math.max(0, Math.floor(olderThanTs)));
      return;
    }
    this.pruneJsonl("mid_snapshots", (row) => Number(row.ts) >= olderThanTs);
  }

  recordAnalysisRun(row: AnalysisRunRow): void {
    if (this.mode === "sqlite" && this.db) {
      this.db
        .prepare(
          `INSERT INTO analysis_runs (ts, window, metrics_json)
           VALUES (@ts, @window, @metrics_json)`
        )
        .run(row);
      return;
    }
    this.appendJsonl("analysis_runs", row);
  }

  recordAdaptiveEvent(row: AdaptiveEventRow): void {
    if (this.mode === "sqlite" && this.db) {
      this.db
        .prepare(
          `INSERT INTO adaptive_events (ts, action, reason, before_params_json, after_params_json, metrics_json)
           VALUES (@ts, @action, @reason, @before_params_json, @after_params_json, @metrics_json)`
        )
        .run(row);
      return;
    }
    this.appendJsonl("adaptive_events", row);
  }

  getFillsSince(symbol: string, sinceTs: number): PersistedFillRow[] {
    const cutoff = Math.max(0, Math.floor(sinceTs));
    const normalizedSymbol = String(symbol || "").toUpperCase();
    if (this.mode === "sqlite" && this.db) {
      return this.db
        .prepare(
          `SELECT id, ts, symbol, side, price, base_qty, quote_qty, fee_usd, order_id, client_order_id, posture, revx_mid_at_fill, source_json
             FROM fills
            WHERE symbol = ? AND ts >= ?
            ORDER BY ts ASC`
        )
        .all(normalizedSymbol, cutoff) as PersistedFillRow[];
    }
    return this.readJsonl<PersistedFillRow>("fills")
      .filter((row) => String(row.symbol || "").toUpperCase() === normalizedSymbol && Number(row.ts) >= cutoff)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  getLatestFills(symbol: string, limit: number): PersistedFillRow[] {
    const normalizedSymbol = String(symbol || "").toUpperCase();
    const safeLimit = Math.max(1, Math.floor(limit || 100));
    if (this.mode === "sqlite" && this.db) {
      return this.db
        .prepare(
          `SELECT id, ts, symbol, side, price, base_qty, quote_qty, fee_usd, order_id, client_order_id, posture, revx_mid_at_fill, source_json
             FROM fills
            WHERE symbol = ?
            ORDER BY ts DESC
            LIMIT ?`
        )
        .all(normalizedSymbol, safeLimit) as PersistedFillRow[];
    }
    return this.readJsonl<PersistedFillRow>("fills")
      .filter((row) => String(row.symbol || "").toUpperCase() === normalizedSymbol)
      .sort((a, b) => Number(b.ts) - Number(a.ts))
      .slice(0, safeLimit);
  }

  getMidSnapshotsSince(symbol: string, sinceTs: number): MidSnapshotRow[] {
    const cutoff = Math.max(0, Math.floor(sinceTs));
    const normalizedSymbol = String(symbol || "").toUpperCase();
    if (this.mode === "sqlite" && this.db) {
      return this.db
        .prepare(
          `SELECT ts, symbol, revx_bid, revx_ask, revx_mid
             FROM mid_snapshots
            WHERE symbol = ? AND ts >= ?
            ORDER BY ts ASC`
        )
        .all(normalizedSymbol, cutoff) as MidSnapshotRow[];
    }
    return this.readJsonl<MidSnapshotRow>("mid_snapshots")
      .filter((row) => String(row.symbol || "").toUpperCase() === normalizedSymbol && Number(row.ts) >= cutoff)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  getLatestMid(symbol: string): MidSnapshotRow | null {
    const normalizedSymbol = String(symbol || "").toUpperCase();
    if (this.mode === "sqlite" && this.db) {
      const row = this.db
        .prepare(
          `SELECT ts, symbol, revx_bid, revx_ask, revx_mid
             FROM mid_snapshots
            WHERE symbol = ?
            ORDER BY ts DESC
            LIMIT 1`
        )
        .get(normalizedSymbol) as MidSnapshotRow | undefined;
      return row ?? null;
    }
    const rows = this.readJsonl<MidSnapshotRow>("mid_snapshots")
      .filter((row) => String(row.symbol || "").toUpperCase() === normalizedSymbol)
      .sort((a, b) => Number(b.ts) - Number(a.ts));
    return rows[0] ?? null;
  }

  getMidAtOrAfter(symbol: string, targetTs: number): MidSnapshotRow | null {
    const normalizedSymbol = String(symbol || "").toUpperCase();
    const ts = Math.max(0, Math.floor(targetTs));
    if (this.mode === "sqlite" && this.db) {
      const direct = this.db
        .prepare(
          `SELECT ts, symbol, revx_bid, revx_ask, revx_mid
             FROM mid_snapshots
            WHERE symbol = ? AND ts >= ?
            ORDER BY ts ASC
            LIMIT 1`
        )
        .get(normalizedSymbol, ts) as MidSnapshotRow | undefined;
      if (direct) return direct;
      const fallback = this.db
        .prepare(
          `SELECT ts, symbol, revx_bid, revx_ask, revx_mid
             FROM mid_snapshots
            WHERE symbol = ?
            ORDER BY ts DESC
            LIMIT 1`
        )
        .get(normalizedSymbol) as MidSnapshotRow | undefined;
      return fallback ?? null;
    }
    const rows = this.readJsonl<MidSnapshotRow>("mid_snapshots")
      .filter((row) => String(row.symbol || "").toUpperCase() === normalizedSymbol)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const row of rows) {
      if (Number(row.ts) >= ts) return row;
    }
    return rows.length > 0 ? rows[rows.length - 1] : null;
  }

  getRecentAdaptiveEvents(limit: number): AdaptiveEventRow[] {
    const safeLimit = Math.max(1, Math.floor(limit || 20));
    if (this.mode === "sqlite" && this.db) {
      return this.db
        .prepare(
          `SELECT ts, action, reason, before_params_json, after_params_json, metrics_json
             FROM adaptive_events
            ORDER BY ts DESC
            LIMIT ?`
        )
        .all(safeLimit) as AdaptiveEventRow[];
    }
    return this.readJsonl<AdaptiveEventRow>("adaptive_events")
      .sort((a, b) => Number(b.ts) - Number(a.ts))
      .slice(0, safeLimit);
  }

  private init(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const BetterSqlite3 = require("better-sqlite3");
      this.db = new BetterSqlite3(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS fills (
          id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          price REAL NOT NULL,
          base_qty REAL NOT NULL,
          quote_qty REAL NOT NULL,
          fee_usd REAL NOT NULL,
          order_id TEXT,
          client_order_id TEXT,
          posture TEXT,
          revx_mid_at_fill REAL,
          source_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_fills_symbol_ts ON fills(symbol, ts);

        CREATE TABLE IF NOT EXISTS mid_snapshots (
          ts INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          revx_bid REAL NOT NULL,
          revx_ask REAL NOT NULL,
          revx_mid REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mid_symbol_ts ON mid_snapshots(symbol, ts);

        CREATE TABLE IF NOT EXISTS analysis_runs (
          ts INTEGER NOT NULL,
          window TEXT NOT NULL,
          metrics_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_analysis_runs_ts ON analysis_runs(ts);

        CREATE TABLE IF NOT EXISTS adaptive_events (
          ts INTEGER NOT NULL,
          action TEXT NOT NULL,
          reason TEXT NOT NULL,
          before_params_json TEXT NOT NULL,
          after_params_json TEXT NOT NULL,
          metrics_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_adaptive_events_ts ON adaptive_events(ts);
      `);
      this.mode = "sqlite";
      this.lastError = null;
      this.logger.info({ dbPath: this.dbPath }, "Performance storage using SQLite");
    } catch (error) {
      this.mode = "jsonl";
      this.db = null;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { error: this.lastError, dataDir: this.dataDir },
        "Performance storage falling back to JSONL"
      );
      for (const path of Object.values(this.jsonlPathByTable)) {
        mkdirSync(dirname(path), { recursive: true });
        if (!existsSync(path)) {
          writeFileSync(path, "", "utf8");
        }
      }
    }
  }

  private appendJsonl(table: keyof PerformanceStorage["jsonlPathByTable"], row: JsonlPayload): void {
    const path = this.jsonlPathByTable[table];
    appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
  }

  private readJsonl<T>(table: keyof PerformanceStorage["jsonlPathByTable"]): T[] {
    const path = this.jsonlPathByTable[table];
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf8");
    if (!content.trim()) return [];
    const rows: T[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed) as T);
      } catch {
        // ignore corrupt row
      }
    }
    return rows;
  }

  private pruneJsonl(
    table: keyof PerformanceStorage["jsonlPathByTable"],
    keep: (row: Record<string, unknown>) => boolean
  ): void {
    const path = this.jsonlPathByTable[table];
    if (!existsSync(path)) return;
    const rows = this.readJsonl<Record<string, unknown>>(table).filter(keep);
    const tempPath = `${path}.tmp`;
    const nextContent = rows.map((row) => JSON.stringify(row)).join("\n");
    writeFileSync(tempPath, nextContent.length > 0 ? `${nextContent}\n` : "", "utf8");
    renameSync(tempPath, path);
  }

  private makeFillId(fill: PersistedFillRow): string {
    const hash = createHash("sha1");
    hash.update(
      [
        fill.symbol,
        fill.side,
        String(fill.ts),
        fill.order_id,
        fill.client_order_id,
        String(fill.price),
        String(fill.base_qty)
      ].join("|")
    );
    return hash.digest("hex");
  }
}

