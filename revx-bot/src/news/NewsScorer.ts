import { Headline, NewsCategory, NewsDirection, RawHeadline } from "./types";
import { makeHeadlineId, normalizeTitle } from "./providers/common";

type KeywordRule = {
  words: string[];
  impact: number;
  category: NewsCategory;
  directionBias: NewsDirection;
  tag: string;
};

const KEYWORD_RULES: KeywordRule[] = [
  { words: ["strike", "missile", "attack", "war", "sanctions", "emergency"], impact: 0.8, category: "war", directionBias: "DOWN", tag: "geopolitical-shock" },
  { words: ["fed", "rate hike", "interest rates", "cpi", "inflation", "fomc"], impact: 0.72, category: "rates", directionBias: "DOWN", tag: "rates-macro" },
  { words: ["rate cut", "inflation cooling", "disinflation"], impact: 0.62, category: "rates", directionBias: "UP", tag: "rates-supportive" },
  { words: ["bank failure", "liquidity crisis", "credit event"], impact: 0.82, category: "macro", directionBias: "DOWN", tag: "macro-stress" },
  { words: ["exchange hack", "hack", "exploit", "breach"], impact: 0.85, category: "exchange", directionBias: "DOWN", tag: "exchange-risk" },
  { words: ["outage", "downtime", "halted trading", "service disruption"], impact: 0.76, category: "outage", directionBias: "DOWN", tag: "market-outage" },
  { words: ["sec", "regulation", "lawsuit", "enforcement", "ban"], impact: 0.68, category: "regulation", directionBias: "DOWN", tag: "regulatory-risk" },
  { words: ["etf approval", "approved etf", "spot etf approved"], impact: 0.75, category: "crypto", directionBias: "UP", tag: "etf-approval" },
  { words: ["etf denial", "etf rejected", "etf delay"], impact: 0.7, category: "crypto", directionBias: "DOWN", tag: "etf-denial" },
  { words: ["liquidation", "forced liquidations", "short squeeze"], impact: 0.66, category: "crypto", directionBias: "DOWN", tag: "liquidations" }
];

const SOURCE_TIER: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /reuters|bloomberg|ft\.com|wsj/i, score: 0.95 },
  { pattern: /coindesk|cointelegraph|theblock|decrypt/i, score: 0.82 },
  { pattern: /binance|coinbase|kraken|okx|bybit/i, score: 0.75 },
  { pattern: /.*/, score: 0.6 }
];

export function scoreHeadline(
  raw: RawHeadline,
  similarSourceCount = 1
): Headline {
  const title = String(raw.title || "").trim();
  const normalized = normalizeTitle(title);
  const tags = new Set<string>();
  const symbols = new Set<string>();
  const categoryVotes = new Map<NewsCategory, number>();

  let impact = 0.08;
  let upVotes = 0;
  let downVotes = 0;
  let strongHits = 0;

  for (const rule of KEYWORD_RULES) {
    const matched = rule.words.some((word) => containsKeyword(normalized, word));
    if (!matched) continue;
    strongHits += 1;
    impact = Math.max(impact, rule.impact);
    categoryVotes.set(rule.category, (categoryVotes.get(rule.category) ?? 0) + 1);
    tags.add(rule.tag);
    if (rule.directionBias === "UP") upVotes += 1;
    if (rule.directionBias === "DOWN") downVotes += 1;
  }

  if (containsKeyword(normalized, "btc") || containsKeyword(normalized, "bitcoin")) symbols.add("BTC");
  if (containsKeyword(normalized, "crypto")) symbols.add("CRYPTO");
  if (containsKeyword(normalized, "usd") || containsKeyword(normalized, "dollar")) symbols.add("USD");
  if (containsKeyword(normalized, "rates") || containsKeyword(normalized, "fed")) symbols.add("RATES");
  if (containsKeyword(normalized, "oil")) symbols.add("OIL");

  const source = String(raw.source || "").trim() || "unknown";
  const sourceTier = resolveSourceTier(source + " " + String(raw.url || ""));
  const category = pickCategory(categoryVotes);
  const direction = pickDirection(upVotes, downVotes);
  const confidence = clamp(
    0.25 +
      Math.min(0.45, strongHits * 0.12) +
      sourceTier * 0.2 +
      Math.min(0.2, Math.max(0, similarSourceCount - 1) * 0.08),
    0,
    1
  );

  if (strongHits === 0 && symbols.size === 0) {
    impact = Math.min(impact, 0.22);
  }

  return {
    id: makeHeadlineId(title, raw.url),
    ts: Math.max(0, Number(raw.ts) || Date.now()),
    title,
    source,
    url: String(raw.url || "").trim(),
    tags: Array.from(tags),
    symbols: Array.from(symbols),
    category,
    impact: clamp(impact, 0, 1),
    direction,
    confidence,
    raw: raw.raw
  };
}

export function buildHeadlineFingerprint(title: string): string {
  const normalized = normalizeTitle(title);
  const terms = normalized
    .split(" ")
    .filter((word) => word.length >= 3)
    .filter((word) => !STOP_WORDS.has(word))
    .slice(0, 12);
  return terms.join(" ");
}

function pickCategory(votes: Map<NewsCategory, number>): NewsCategory {
  if (votes.size === 0) return "other";
  let best: NewsCategory = "other";
  let bestScore = -1;
  for (const [category, score] of votes.entries()) {
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}

function pickDirection(upVotes: number, downVotes: number): NewsDirection {
  if (upVotes > downVotes) return "UP";
  if (downVotes > upVotes) return "DOWN";
  return "NEUTRAL";
}

function resolveSourceTier(input: string): number {
  for (const row of SOURCE_TIER) {
    if (row.pattern.test(input)) return row.score;
  }
  return 0.6;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function containsKeyword(text: string, keyword: string): boolean {
  const normalizedKeyword = String(keyword || "").trim().toLowerCase();
  if (!normalizedKeyword) return false;
  const escaped = normalizedKeyword
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const regex = new RegExp(`(^|\\W)${escaped}($|\\W)`, "i");
  return regex.test(text);
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "will",
  "after",
  "amid",
  "into",
  "over",
  "under",
  "new",
  "more",
  "than",
  "about",
  "crypto",
  "bitcoin"
]);
