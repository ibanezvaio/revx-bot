import { SignalCategory, SignalDirection, SignalItem, RawSignalInput } from "./types";
import { clamp, dedupeKey, domainFromUrl, normalizeText } from "./providers/common";

type KeywordRule = {
  words: string[];
  category: SignalCategory;
  direction: SignalDirection;
  impact: number;
  tag: string;
};

const RULES: KeywordRule[] = [
  { words: ["strike", "attack", "war", "missile", "sanctions", "emergency"], category: "war", direction: "DOWN", impact: 0.86, tag: "war-shock" },
  { words: ["bank failure", "liquidity crisis", "credit event"], category: "risk", direction: "DOWN", impact: 0.82, tag: "macro-stress" },
  { words: ["hack", "exploit", "breach", "outage", "downtime"], category: "exchange", direction: "DOWN", impact: 0.8, tag: "exchange-risk" },
  { words: ["fed", "rate hike", "jobs", "cpi", "inflation"], category: "rates", direction: "DOWN", impact: 0.72, tag: "rates-risk" },
  { words: ["rate cut", "inflation cools", "disinflation"], category: "inflation", direction: "UP", impact: 0.66, tag: "rates-supportive" },
  { words: ["etf approval", "spot etf approved"], category: "crypto", direction: "UP", impact: 0.76, tag: "etf-positive" },
  { words: ["etf denied", "etf delay", "sec enforcement", "sec lawsuit"], category: "regulation", direction: "DOWN", impact: 0.74, tag: "regulatory-risk" },
  { words: ["oil spike", "oil prices surge"], category: "oil", direction: "DOWN", impact: 0.62, tag: "oil-risk" }
];

const TIER_ONE_RE = /(reuters|bloomberg|ft\.com|wsj|federalreserve\.gov|imf\.org|worldbank\.org)/i;

export function scoreSignalInputs(inputs: RawSignalInput[], nowTs = Date.now()): SignalItem[] {
  const base = inputs
    .filter((row) => row && typeof row.title === "string" && row.title.trim().length > 0)
    .map((row) => toSignalItem(row, nowTs));
  const consensusMap = new Map<string, Set<string>>();
  for (const item of base) {
    const key = themeKey(item.title);
    if (!consensusMap.has(key)) consensusMap.set(key, new Set<string>());
    consensusMap.get(key)?.add(String(item.source || "").toLowerCase());
  }
  return base.map((item) => {
    const key = themeKey(item.title);
    const sourceCount = consensusMap.get(key)?.size ?? 1;
    const consensusBoost = Math.min(0.2, Math.max(0, sourceCount - 1) * 0.07);
    return {
      ...item,
      confidence: clamp(item.confidence + consensusBoost, 0, 1)
    };
  });
}

function toSignalItem(input: RawSignalInput, nowTs: number): SignalItem {
  const title = String(input.title || "").trim();
  const normalized = normalizeText(title);
  const tags = new Set<string>(Array.isArray(input.tags) ? input.tags.map((row) => String(row)) : []);
  const symbols = new Set<string>(Array.isArray(input.symbols) ? input.symbols.map((row) => String(row).toUpperCase()) : []);
  let impact = clamp(Number(input.impactHint ?? 0.18), 0, 1);
  let confidence = clamp(Number(input.confidenceHint ?? 0.35), 0, 1);
  let category: SignalCategory = input.categoryHint ?? "risk";
  let upHits = 0;
  let downHits = 0;
  let strongHits = 0;

  for (const rule of RULES) {
    const matched = rule.words.some((word) => containsKeyword(normalized, word));
    if (!matched) continue;
    strongHits += 1;
    impact = Math.max(impact, rule.impact);
    category = rule.category;
    tags.add(rule.tag);
    if (rule.direction === "UP") upHits += 1;
    if (rule.direction === "DOWN") downHits += 1;
  }

  if (containsKeyword(normalized, "btc") || containsKeyword(normalized, "bitcoin")) symbols.add("BTC");
  if (containsKeyword(normalized, "crypto")) symbols.add("CRYPTO");
  if (containsKeyword(normalized, "usd") || containsKeyword(normalized, "dollar")) symbols.add("USD");
  if (containsKeyword(normalized, "oil")) symbols.add("OIL");

  const sourceHint = `${String(input.source || "")} ${String(input.url || "")}`.trim();
  const sourceTierBoost = TIER_ONE_RE.test(sourceHint) || TIER_ONE_RE.test(domainFromUrl(String(input.url || ""))) ? 0.15 : 0;
  confidence = clamp(
    Math.max(confidence, 0.2 + Math.min(0.45, strongHits * 0.12) + sourceTierBoost),
    0,
    1
  );

  const direction = normalizeDirection(input.directionHint, upHits, downHits);
  const horizonMinutes = resolveHorizonMinutes(input, category);
  const ts = Number.isFinite(Number(input.ts)) ? Math.floor(Number(input.ts)) : nowTs;
  return {
    id: dedupeKey(title, input.url ?? `${input.kind}-${input.source}-${ts}`),
    ts: Math.max(0, ts),
    kind: input.kind,
    category,
    title,
    source: String(input.source || "unknown"),
    url: input.url,
    symbols: Array.from(symbols),
    impact: clamp(impact, 0, 1),
    direction,
    confidence: clamp(confidence, 0, 1),
    horizonMinutes,
    tags: Array.from(tags),
    raw: input.raw
  };
}

function resolveHorizonMinutes(input: RawSignalInput, category: SignalCategory): number {
  if (Number.isFinite(Number(input.horizonMinutesHint)) && Number(input.horizonMinutesHint) > 0) {
    return Math.floor(Number(input.horizonMinutesHint));
  }
  if (category === "war" || category === "risk") return 360;
  if (category === "rates" || category === "inflation") return 480;
  if (category === "exchange" || category === "regulation") return 720;
  return 180;
}

function normalizeDirection(hint: SignalDirection | undefined, upHits: number, downHits: number): SignalDirection {
  if (hint === "UP" || hint === "DOWN" || hint === "NEUTRAL") return hint;
  if (upHits > downHits) return "UP";
  if (downHits > upHits) return "DOWN";
  return "NEUTRAL";
}

function themeKey(title: string): string {
  const normalized = normalizeText(title);
  const words = normalized
    .split(" ")
    .filter((word) => word.length >= 3)
    .filter((word) => !STOP_WORDS.has(word))
    .slice(0, 10);
  return words.join(" ");
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
  "crypto",
  "bitcoin",
  "market"
]);
