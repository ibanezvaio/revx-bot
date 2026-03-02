import { createHash } from "node:crypto";

export const SIGNAL_PROVIDER_TIMEOUT_MS = 1_500;

export async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "revx-bot-signals/1.0"
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function withRetry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let lastError: unknown;
  const attempts = Math.max(1, retries + 1);
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await sleep(Math.min(600, 120 * (i + 1)));
      }
    }
  }
  throw lastError;
}

export function dedupeKey(title: string, url?: string): string {
  const input = `${normalizeText(title)}|${String(url || "").trim().toLowerCase()}`;
  return createHash("sha1").update(input).digest("hex");
}

export function normalizeText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripHtml(value: string): string {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseTimestamp(value: unknown, fallbackTs: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return fallbackTs;
}

export function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
