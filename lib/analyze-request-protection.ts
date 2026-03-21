import { checkRateLimit, getClientIpAddress } from "@/lib/rate-limit";
import {
  isRedisRestConfigured,
  runRedisCommand,
  runRedisPipeline,
} from "@/lib/redis-rest";

const MINUTE_LIMIT = 5;
const DAY_LIMIT = 50;
const COOLDOWN_MS = 5_000;
const COOLDOWN_BUCKET_MAX_ENTRIES = 10_000;
const MINUTE_WINDOW_MS = 60_000;
const DAY_WINDOW_MS = 86_400_000;
const PRUNE_CHECK_INTERVAL = 250;
const PRUNE_MIN_BUCKETS = 2_000;

const RATE_LIMIT_ERROR_MESSAGE =
  "Rate limit exceeded. Please try again later.";
const COOLDOWN_ERROR_MESSAGE =
  "Please wait a few seconds before making another request.";

type CooldownStatus = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type AnalyzeRequestProtectionResult =
  | {
      allowed: true;
      headers: Headers;
    }
  | {
      allowed: false;
      error: string;
      status: number;
      headers: Headers;
    };

type CooldownBucket = {
  lastRequestAt: number;
};

const cooldownBuckets = new Map<string, CooldownBucket>();
let cooldownChecksSincePrune = 0;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);

  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function pruneExpiredCooldowns(now: number, cooldownMs: number): void {
  cooldownChecksSincePrune += 1;

  if (
    cooldownChecksSincePrune < PRUNE_CHECK_INTERVAL &&
    cooldownBuckets.size < PRUNE_MIN_BUCKETS
  ) {
    return;
  }

  cooldownChecksSincePrune = 0;

  for (const [key, bucket] of cooldownBuckets.entries()) {
    if (now - bucket.lastRequestAt >= cooldownMs) {
      cooldownBuckets.delete(key);
    }
  }
}

function pruneOldestCooldownEntries(maxEntries: number): void {
  while (cooldownBuckets.size >= maxEntries) {
    const oldestKey = cooldownBuckets.keys().next().value;

    if (!oldestKey) {
      break;
    }

    cooldownBuckets.delete(oldestKey);
  }
}

function getCooldownStatus(key: string, cooldownMs: number): CooldownStatus {
  const now = Date.now();
  const bucket = cooldownBuckets.get(key);

  pruneExpiredCooldowns(now, cooldownMs);

  if (!bucket) {
    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  }

  const elapsedMs = now - bucket.lastRequestAt;
  const remainingMs = cooldownMs - elapsedMs;

  if (remainingMs <= 0) {
    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
  };
}

function recordRequestForCooldown(key: string): void {
  pruneOldestCooldownEntries(getCooldownBucketMaxEntries());

  cooldownBuckets.set(key, {
    lastRequestAt: Date.now(),
  });
}

function buildRateLimitHeaders(
  perMinuteRemaining: number,
  perDayRemaining: number,
): Headers {
  const headers = new Headers();

  headers.set("X-RateLimit-Minute-Limit", String(getPerMinuteLimit()));
  headers.set("X-RateLimit-Minute-Remaining", String(perMinuteRemaining));
  headers.set("X-RateLimit-Day-Limit", String(getPerDayLimit()));
  headers.set("X-RateLimit-Day-Remaining", String(perDayRemaining));

  return headers;
}

function getPerMinuteLimit(): number {
  return parsePositiveIntegerEnv("ANALYZE_RATE_LIMIT_PER_MINUTE", MINUTE_LIMIT);
}

function getPerDayLimit(): number {
  return parsePositiveIntegerEnv("ANALYZE_RATE_LIMIT_PER_DAY", DAY_LIMIT);
}

function getCooldownMs(): number {
  return parsePositiveIntegerEnv("ANALYZE_COOLDOWN_MS", COOLDOWN_MS);
}

function getCooldownBucketMaxEntries(): number {
  return parsePositiveIntegerEnv(
    "ANALYZE_COOLDOWN_MAX_ENTRIES",
    COOLDOWN_BUCKET_MAX_ENTRIES,
  );
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return fallback;
  }

  return numericValue;
}

function computeRetryAfterSeconds(now: number, windowMs: number): number {
  const resetAt = Math.floor(now / windowMs) * windowMs + windowMs;
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

async function enforceAnalyzeRequestProtectionDistributed(
  clientIp: string,
): Promise<AnalyzeRequestProtectionResult> {
  const perMinuteLimit = getPerMinuteLimit();
  const perDayLimit = getPerDayLimit();
  const cooldownMs = getCooldownMs();
  const now = Date.now();

  const cooldownKey = `analyze:cooldown:${clientIp}`;
  const cooldownSetResult = await runRedisCommand<string>([
    "SET",
    cooldownKey,
    "1",
    "PX",
    cooldownMs,
    "NX",
  ]);

  if (cooldownSetResult !== "OK") {
    const pttlResult = await runRedisCommand<number>(["PTTL", cooldownKey]);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(toPositiveNumber(pttlResult, cooldownMs) / 1000),
    );
    const headers = buildRateLimitHeaders(0, 0);

    headers.set("Retry-After", String(retryAfterSeconds));

    return {
      allowed: false,
      error: COOLDOWN_ERROR_MESSAGE,
      status: 429,
      headers,
    };
  }

  const minuteWindowKey = `analyze:minute:${clientIp}:${Math.floor(now / MINUTE_WINDOW_MS)}`;
  const dayWindowKey = `analyze:day:${clientIp}:${Math.floor(now / DAY_WINDOW_MS)}`;

  const [minuteCountRaw, , dayCountRaw] = await runRedisPipeline([
    ["INCR", minuteWindowKey],
    ["EXPIRE", minuteWindowKey, Math.ceil(MINUTE_WINDOW_MS / 1000)],
    ["INCR", dayWindowKey],
    ["EXPIRE", dayWindowKey, Math.ceil(DAY_WINDOW_MS / 1000)],
  ]);

  const minuteCount = toPositiveNumber(minuteCountRaw, 0);
  const dayCount = toPositiveNumber(dayCountRaw, 0);
  const perMinuteRemaining = Math.max(0, perMinuteLimit - minuteCount);
  const perDayRemaining = Math.max(0, perDayLimit - dayCount);
  const headers = buildRateLimitHeaders(perMinuteRemaining, perDayRemaining);

  if (minuteCount > perMinuteLimit || dayCount > perDayLimit) {
    const retryAfterSeconds = Math.max(
      minuteCount > perMinuteLimit
        ? computeRetryAfterSeconds(now, MINUTE_WINDOW_MS)
        : 0,
      dayCount > perDayLimit
        ? computeRetryAfterSeconds(now, DAY_WINDOW_MS)
        : 0,
    );

    headers.set("Retry-After", String(retryAfterSeconds));

    await runRedisCommand(["DEL", cooldownKey]);

    return {
      allowed: false,
      error: RATE_LIMIT_ERROR_MESSAGE,
      status: 429,
      headers,
    };
  }

  return {
    allowed: true,
    headers,
  };
}

function enforceAnalyzeRequestProtectionLocal(
  clientIp: string,
): AnalyzeRequestProtectionResult {
  const perMinuteLimit = getPerMinuteLimit();
  const perDayLimit = getPerDayLimit();
  const cooldownMs = getCooldownMs();

  const cooldownKey = `analyze:cooldown:${clientIp}`;
  const cooldownStatus = getCooldownStatus(cooldownKey, cooldownMs);

  if (!cooldownStatus.allowed) {
    const headers = buildRateLimitHeaders(0, 0);
    headers.set("Retry-After", String(cooldownStatus.retryAfterSeconds));

    return {
      allowed: false,
      error: COOLDOWN_ERROR_MESSAGE,
      status: 429,
      headers,
    };
  }

  const perMinute = checkRateLimit({
    key: `analyze:minute:${clientIp}`,
    maxRequests: perMinuteLimit,
    windowMs: 60_000,
  });

  const perDay = checkRateLimit({
    key: `analyze:day:${clientIp}`,
    maxRequests: perDayLimit,
    windowMs: 86_400_000,
  });

  const headers = buildRateLimitHeaders(perMinute.remaining, perDay.remaining);

  if (!perMinute.allowed || !perDay.allowed) {
    headers.set(
      "Retry-After",
      String(Math.max(perMinute.retryAfterSeconds, perDay.retryAfterSeconds)),
    );

    return {
      allowed: false,
      error: RATE_LIMIT_ERROR_MESSAGE,
      status: 429,
      headers,
    };
  }

  recordRequestForCooldown(cooldownKey);

  return {
    allowed: true,
    headers,
  };
}

export function getAnalyzeRequestClientIp(headers: Headers): string {
  return getClientIpAddress(headers);
}

export async function enforceAnalyzeRequestProtection(
  clientIp: string,
): Promise<AnalyzeRequestProtectionResult> {
  if (isRedisRestConfigured()) {
    try {
      return await enforceAnalyzeRequestProtectionDistributed(clientIp);
    } catch {
      return enforceAnalyzeRequestProtectionLocal(clientIp);
    }
  }

  return enforceAnalyzeRequestProtectionLocal(clientIp);
}
