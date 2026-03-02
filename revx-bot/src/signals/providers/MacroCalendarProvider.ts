import { BotConfig } from "../../config";
import { RawSignalInput, SignalDirection, SignalsProvider, SignalsProviderResult } from "../types";
import { fetchTextWithTimeout, parseTimestamp, SIGNAL_PROVIDER_TIMEOUT_MS, stripHtml } from "./common";

type MacroRow = {
  ts: number;
  title: string;
  source: string;
  url?: string;
};

export class MacroCalendarProvider implements SignalsProvider {
  readonly name = "macro-calendar";

  constructor(private readonly config: BotConfig) {}

  async fetch(nowTs: number): Promise<SignalsProviderResult> {
    const started = Date.now();
    if (!this.config.signalsMacroEnabled) {
      return {
        provider: this.name,
        ok: true,
        items: [],
        error: "",
        durationMs: Date.now() - started,
        fetchedAtTs: nowTs
      };
    }
    try {
      const rows = this.config.signalsMacroUrl
        ? await this.fetchFromUrl(this.config.signalsMacroUrl, nowTs)
        : buildCuratedMacroStub(nowTs);
      const items: RawSignalInput[] = rows.map((row) => {
        const lower = row.title.toLowerCase();
        return {
          ts: row.ts,
          kind: "MACRO",
          title: row.title,
          source: row.source,
          url: row.url,
          categoryHint: inferMacroCategory(lower),
          directionHint: inferMacroDirection(lower),
          confidenceHint: 0.55,
          impactHint: 0.35,
          horizonMinutesHint: 240,
          tags: ["macro-calendar"]
        };
      });
      return {
        provider: this.name,
        ok: true,
        items,
        error: "",
        durationMs: Date.now() - started,
        fetchedAtTs: nowTs
      };
    } catch (error) {
      return {
        provider: this.name,
        ok: false,
        items: [],
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
        fetchedAtTs: nowTs
      };
    }
  }

  private async fetchFromUrl(url: string, nowTs: number): Promise<MacroRow[]> {
    const body = await fetchTextWithTimeout(url, SIGNAL_PROVIDER_TIMEOUT_MS);
    const parsed = JSON.parse(body) as unknown;
    const rows: MacroRow[] = [];
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const row = coerceRow(entry, nowTs);
        if (row) rows.push(row);
      }
      return rows;
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const candidates = Array.isArray(obj.items)
        ? obj.items
        : Array.isArray(obj.events)
          ? obj.events
          : Array.isArray(obj.data)
            ? obj.data
            : [];
      for (const entry of candidates) {
        const row = coerceRow(entry, nowTs);
        if (row) rows.push(row);
      }
    }
    return rows;
  }
}

function coerceRow(value: unknown, nowTs: number): MacroRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const title = stripHtml(String(row.title ?? row.event ?? row.name ?? "")).trim();
  if (!title) return null;
  const source = String(row.source ?? row.provider ?? row.calendar ?? "macro").trim() || "macro";
  const url = typeof row.url === "string" ? row.url.trim() : undefined;
  return {
    ts: parseTimestamp(row.ts ?? row.time ?? row.date ?? row.datetime, nowTs),
    title,
    source,
    url
  };
}

function inferMacroCategory(title: string): "rates" | "inflation" | "risk" {
  if (title.includes("cpi") || title.includes("inflation") || title.includes("ppi")) return "inflation";
  if (title.includes("rate") || title.includes("fomc") || title.includes("fed")) return "rates";
  return "risk";
}

function inferMacroDirection(title: string): SignalDirection {
  if (title.includes("rate cut") || title.includes("inflation cool")) return "UP";
  if (title.includes("rate hike") || title.includes("hot inflation")) return "DOWN";
  return "NEUTRAL";
}

function buildCuratedMacroStub(nowTs: number): MacroRow[] {
  const now = new Date(nowTs);
  const day = now.getUTCDay();
  const nextHourTs = nowTs + 60 * 60 * 1000;
  const rows: MacroRow[] = [
    {
      ts: nextHourTs,
      title: "US Treasury and macro calendar watch window",
      source: "curated-stub",
      url: undefined
    }
  ];
  if (day >= 1 && day <= 5) {
    rows.push({
      ts: nowTs + 2 * 60 * 60 * 1000,
      title: "Fed speakers / rates headline risk window",
      source: "curated-stub"
    });
  }
  return rows;
}
