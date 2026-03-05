export const FIVE_MIN_SEC = 300;

export function currentWindowTs(nowMs = Date.now()): number {
  const nowSec = Math.floor(nowMs / 1000);
  return Math.floor(nowSec / FIVE_MIN_SEC) * FIVE_MIN_SEC;
}

export function btc5mSlug(windowTs: number): string {
  return `btc-updown-5m-${windowTs}`;
}
