export const FIVE_MIN_SEC = 300;

export function windowTs(nowMs = Date.now()): number {
  const s = Math.floor(nowMs / 1000);
  return Math.floor(s / FIVE_MIN_SEC) * FIVE_MIN_SEC;
}

export function slugForTs(ts: number): string {
  return `btc-updown-5m-${ts}`;
}

export function previousSlug(nowMs = Date.now()): string {
  const ts = windowTs(nowMs) - FIVE_MIN_SEC;
  return slugForTs(ts);
}

export function currentSlug(nowMs = Date.now()): string {
  return slugForTs(windowTs(nowMs));
}

export function nextSlug(nowMs = Date.now()): string {
  return slugForTs(windowTs(nowMs) + FIVE_MIN_SEC);
}
