type RateLimitBucket = {
  count: number;
  resetAt: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

type CheckRateLimitInput = {
  key: string;
  maxRequests: number;
  windowMs: number;
};

const DEFAULT_MAX_BUCKETS = 10_000;
const buckets = new Map<string, RateLimitBucket>();
let checksSinceLastPrune = 0;

function normalizePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function getMaxBuckets() {
  const configuredValue = Number.parseInt(process.env.RATE_LIMIT_MAX_BUCKETS ?? "", 10);
  return normalizePositiveInteger(configuredValue, DEFAULT_MAX_BUCKETS);
}

function pruneExpiredBuckets(now: number) {
  checksSinceLastPrune += 1;

  if (checksSinceLastPrune < 250 && buckets.size < 2_000) {
    return;
  }

  checksSinceLastPrune = 0;

  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

function pruneOldestBuckets(maxBuckets: number) {
  while (buckets.size > maxBuckets) {
    const oldestKey = buckets.keys().next().value;

    if (!oldestKey) {
      break;
    }

    buckets.delete(oldestKey);
  }
}

export function checkRateLimit(input: CheckRateLimitInput): RateLimitResult {
  const now = Date.now();
  const maxRequests = normalizePositiveInteger(input.maxRequests, 1);
  const windowMs = normalizePositiveInteger(input.windowMs, 60_000);

  pruneExpiredBuckets(now);

  const existingBucket = buckets.get(input.key);

  if (!existingBucket && buckets.size >= getMaxBuckets()) {
    pruneOldestBuckets(Math.max(0, getMaxBuckets() - 1));
  }

  if (!existingBucket || existingBucket.resetAt <= now) {
    const resetAt = now + windowMs;
    const remaining = Math.max(0, maxRequests - 1);

    buckets.set(input.key, {
      count: 1,
      resetAt,
    });

    return {
      allowed: true,
      limit: maxRequests,
      remaining,
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  const nextCount = existingBucket.count + 1;
  const allowed = nextCount <= maxRequests;

  existingBucket.count = nextCount;

  const remaining = allowed ? Math.max(0, maxRequests - nextCount) : 0;
  const retryAfterSeconds = Math.max(1, Math.ceil((existingBucket.resetAt - now) / 1000));

  return {
    allowed,
    limit: maxRequests,
    remaining,
    resetAt: existingBucket.resetAt,
    retryAfterSeconds,
  };
}

export function getClientIpAddress(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");

  if (forwardedFor) {
    const firstIp = forwardedFor.split(",")[0]?.trim();

    if (firstIp) {
      return firstIp;
    }
  }

  const fallbackHeaderCandidates = [
    "x-real-ip",
    "cf-connecting-ip",
    "true-client-ip",
  ];

  for (const headerName of fallbackHeaderCandidates) {
    const value = headers.get(headerName)?.trim();

    if (value) {
      return value;
    }
  }

  return "unknown";
}

export function createRateLimitHeaders(
  result: RateLimitResult,
  includeRetryAfter: boolean,
): Headers {
  const headers = new Headers();

  headers.set("X-RateLimit-Limit", String(result.limit));
  headers.set("X-RateLimit-Remaining", String(result.remaining));
  headers.set("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));

  if (includeRetryAfter) {
    headers.set("Retry-After", String(result.retryAfterSeconds));
  }

  return headers;
}
