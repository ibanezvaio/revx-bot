import { BotConfig } from "../../config";
import { Logger } from "../../logger";
import { SignalDirection, SignalItem } from "../types";

type LlmSignalReview = {
  id: string;
  summary: string;
  rationale: string[];
  direction: SignalDirection;
  confidence: number;
};

type LlmPayload = {
  reviews: LlmSignalReview[];
};

export class SignalLlmAnalyzer {
  private lastRunTs = 0;
  private suspendedUntilTs = 0;
  private lastError = "";

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger
  ) {}

  isEnabled(): boolean {
    return Boolean(this.config.signalsLlmEnabled && this.config.openAiApiKey);
  }

  getState(): { suspendedUntilTs: number; lastError?: string; lastRunTs: number } {
    return {
      suspendedUntilTs: this.suspendedUntilTs,
      lastError: this.lastError || undefined,
      lastRunTs: this.lastRunTs
    };
  }

  async analyze(items: SignalItem[], nowTs = Date.now()): Promise<SignalItem[]> {
    if (!this.isEnabled()) return items;
    if (nowTs < this.suspendedUntilTs) return items;
    if (nowTs - this.lastRunTs < 60_000) return items;

    const candidates = items
      .filter((row) => row.impact >= 0.55)
      .slice(0, 8)
      .map((row) => ({
        id: row.id,
        title: row.title,
        source: row.source,
        ts: row.ts,
        category: row.category,
        impact: row.impact,
        direction: row.direction,
        confidence: row.confidence
      }));
    if (candidates.length === 0) return items;

    this.lastRunTs = nowTs;
    try {
      const prompt = buildPrompt(candidates);
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.openAiApiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          max_output_tokens: 600,
          input: prompt
        })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as {
        output_text?: string;
        output?: Array<{ content?: Array<{ text?: string }> }>;
      };
      const text = extractText(payload);
      const parsed = parseJson(text);
      if (!parsed) return items;
      const map = new Map(parsed.reviews.map((row) => [row.id, row]));
      return items.map((row) => applyReview(row, map.get(row.id)));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.suspendedUntilTs = nowTs + 10 * 60 * 1000;
      this.logger.warn(
        {
          error: this.lastError,
          suspendedUntilTs: this.suspendedUntilTs
        },
        "Signals LLM analyzer failed; suspending for 10 minutes"
      );
      return items;
    }
  }
}

function buildPrompt(items: Array<Record<string, unknown>>): string {
  return [
    "You are validating market-moving signal headlines.",
    "Return strict JSON only with shape:",
    '{"reviews":[{"id":"...","summary":"...","rationale":["..."],"direction":"UP|DOWN|NEUTRAL","confidence":0.0}]}',
    "Rules:",
    "- Keep rationale concise (1-3 bullets).",
    "- confidence must be between 0 and 1.",
    "- Do not invent IDs; only use IDs from the input.",
    "",
    "Input headlines:",
    JSON.stringify(items)
  ].join("\n");
}

function extractText(payload: {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
}): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim().length > 0) {
    return payload.output_text;
  }
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (typeof part.text === "string" && part.text.trim().length > 0) {
          return part.text;
        }
      }
    }
  }
  return "";
}

function parseJson(text: string): LlmPayload | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const reviewsRaw = (parsed as { reviews?: unknown[] }).reviews;
    if (!Array.isArray(reviewsRaw)) return null;
    const reviews: LlmSignalReview[] = [];
    for (const row of reviewsRaw) {
      if (!row || typeof row !== "object") continue;
      const review = row as Record<string, unknown>;
      const direction = normalizeDirection(review.direction);
      if (!direction) continue;
      const id = String(review.id ?? "").trim();
      if (!id) continue;
      const confidenceNum = Number(review.confidence);
      if (!Number.isFinite(confidenceNum)) continue;
      reviews.push({
        id,
        summary: String(review.summary ?? "").slice(0, 260),
        rationale: Array.isArray(review.rationale)
          ? review.rationale.slice(0, 3).map((item) => String(item))
          : [],
        direction,
        confidence: Math.min(1, Math.max(0, confidenceNum))
      });
    }
    return { reviews };
  } catch {
    return null;
  }
}

function applyReview(item: SignalItem, review: LlmSignalReview | undefined): SignalItem {
  if (!review) return item;
  const next: SignalItem = {
    ...item,
    analysis: {
      summary: review.summary || item.title,
      rationale: review.rationale
    }
  };
  if (review.confidence > item.confidence) {
    next.direction = review.direction;
    next.confidence = review.confidence;
  }
  return next;
}

function normalizeDirection(value: unknown): SignalDirection | null {
  if (value === "UP" || value === "DOWN" || value === "NEUTRAL") return value;
  return null;
}
