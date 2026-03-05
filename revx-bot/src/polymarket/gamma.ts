export async function fetchEventBySlug(slug: string): Promise<any | null> {
  const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return Array.isArray(json) ? (json[0] ?? null) : json;
}

export function pickFirstMarket(event: any): any | null {
  const markets = event?.markets;
  if (!Array.isArray(markets) || markets.length === 0) return null;
  return markets[0];
}

export function parseClobTokenIds(market: any): string[] {
  try {
    return JSON.parse(market?.clobTokenIds ?? "[]");
  } catch {
    return [];
  }
}
