export const FIVE_MIN_SEC = 300;

export type Btc5mBuckets = {
  nowSec: number;
  bucketStartSec: number;
  currentSlug: string;
  nextSlug: string;
  prevSlug: string;
  remainingSec: number;
  windowStartTs: number;
  windowEndTs: number;
};

export type Btc5mTickContext = {
  tickNowMs: number;
  tickNowSec: number;
  currentBucketStartSec: number;
  prevBucketStartSec: number;
  nextBucketStartSec: number;
  currentSlug: string;
  prevSlug: string;
  nextSlug: string;
  remainingSec: number;
};

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

export function deriveBtc5mTickContext(nowMs = Date.now()): Btc5mTickContext {
  const tickNowMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const tickNowSec = Math.floor(tickNowMs / 1000);
  const currentBucketStartSec = Math.floor(tickNowSec / FIVE_MIN_SEC) * FIVE_MIN_SEC;
  const prevBucketStartSec = currentBucketStartSec - FIVE_MIN_SEC;
  const nextBucketStartSec = currentBucketStartSec + FIVE_MIN_SEC;
  return {
    tickNowMs,
    tickNowSec,
    currentBucketStartSec,
    prevBucketStartSec,
    nextBucketStartSec,
    currentSlug: slugForTs(currentBucketStartSec),
    prevSlug: slugForTs(prevBucketStartSec),
    nextSlug: slugForTs(nextBucketStartSec),
    remainingSec: Math.max(0, nextBucketStartSec - tickNowSec)
  };
}

export function deriveBtc5mBuckets(nowMs = Date.now()): Btc5mBuckets {
  const nowSec = Math.floor(nowMs / 1000);
  const bucketStartSec = windowTs(nowMs);
  const windowStartTs = bucketStartSec * 1000;
  const windowEndTs = windowStartTs + FIVE_MIN_SEC * 1000;
  return {
    nowSec,
    bucketStartSec,
    currentSlug: slugForTs(bucketStartSec),
    nextSlug: slugForTs(bucketStartSec + FIVE_MIN_SEC),
    prevSlug: slugForTs(bucketStartSec - FIVE_MIN_SEC),
    remainingSec: Math.max(0, bucketStartSec + FIVE_MIN_SEC - nowSec),
    windowStartTs,
    windowEndTs
  };
}
