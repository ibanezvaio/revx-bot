export async function fetchGammaEvent(slug: string): Promise<Record<string, unknown> | null> {
  const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return Array.isArray(json) ? ((json[0] as Record<string, unknown> | undefined) ?? null) : (json as Record<string, unknown>);
}
