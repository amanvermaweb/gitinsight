import type { AiFeedback } from "@/lib/ai-feedback";
import { isRedisRestConfigured, runRedisCommand } from "@/lib/redis-rest";

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 2_000;
const REDIS_CACHE_PREFIX = "analyze:ai-feedback:";

type CacheRecord = {
  value: AiFeedback;
  expiresAt: number;
};

export type AiFeedbackCacheAdapter = {
  get: (key: string) => Promise<AiFeedback | null>;
  set: (key: string, value: AiFeedback, ttlSeconds: number) => Promise<void>;
};

const inMemoryCache = new Map<string, CacheRecord>();
let cacheReadsSincePrune = 0;
let distributedCacheAdapter: AiFeedbackCacheAdapter | null = null;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);

  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function getCacheTtlMs() {
  return parsePositiveIntegerEnv("ANALYZE_AI_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS);
}

function getCacheMaxEntries() {
  return parsePositiveIntegerEnv(
    "ANALYZE_AI_CACHE_MAX_ENTRIES",
    DEFAULT_CACHE_MAX_ENTRIES,
  );
}

function normalizeCacheKey(username: string) {
  return username.trim().toLowerCase();
}

function getRedisCacheKey(username: string) {
  return `${REDIS_CACHE_PREFIX}${username}`;
}

function pruneOldestEntries(maxEntries: number) {
  while (inMemoryCache.size >= maxEntries) {
    const oldestKey = inMemoryCache.keys().next().value;

    if (!oldestKey) {
      break;
    }

    inMemoryCache.delete(oldestKey);
  }
}

function isAiFeedback(value: unknown): value is AiFeedback {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Record<string, unknown>;

  return (
    typeof payload.summary === "string" &&
    Array.isArray(payload.strengths) &&
    Array.isArray(payload.weaknesses) &&
    Array.isArray(payload.suggestions)
  );
}

function pruneExpiredEntries(now: number) {
  cacheReadsSincePrune += 1;

  if (cacheReadsSincePrune < 250 && inMemoryCache.size < 2_000) {
    return;
  }

  cacheReadsSincePrune = 0;

  for (const [key, record] of inMemoryCache.entries()) {
    if (record.expiresAt <= now) {
      inMemoryCache.delete(key);
    }
  }
}

export function configureAiFeedbackCacheAdapter(adapter: AiFeedbackCacheAdapter | null) {
  // This hook allows plugging in a distributed cache (e.g. Upstash Redis)
  // without changing the API route implementation.
  distributedCacheAdapter = adapter;
}

export async function getCachedAiFeedback(
  username: string,
): Promise<AiFeedback | null> {
  const key = normalizeCacheKey(username);

  if (!key) {
    return null;
  }

  if (distributedCacheAdapter) {
    return distributedCacheAdapter.get(key);
  }

  if (isRedisRestConfigured()) {
    try {
      const redisValue = await runRedisCommand<string>([
        "GET",
        getRedisCacheKey(key),
      ]);

      if (!redisValue) {
        return null;
      }

      const parsed = JSON.parse(redisValue) as unknown;

      return isAiFeedback(parsed) ? parsed : null;
    } catch {
      // Local cache fallback keeps behavior stable even if Redis is degraded.
    }
  }

  const now = Date.now();
  pruneExpiredEntries(now);

  const record = inMemoryCache.get(key);

  if (!record) {
    return null;
  }

  if (record.expiresAt <= now) {
    inMemoryCache.delete(key);
    return null;
  }

  return record.value;
}

export async function setCachedAiFeedback(username: string, value: AiFeedback) {
  const key = normalizeCacheKey(username);

  if (!key) {
    return;
  }

  const ttlMs = getCacheTtlMs();

  if (distributedCacheAdapter) {
    await distributedCacheAdapter.set(key, value, Math.ceil(ttlMs / 1000));
    return;
  }

  if (isRedisRestConfigured()) {
    try {
      await runRedisCommand([
        "SET",
        getRedisCacheKey(key),
        JSON.stringify(value),
        "EX",
        Math.ceil(ttlMs / 1000),
      ]);
      return;
    } catch {
      // Local cache fallback keeps writes available if Redis is unavailable.
    }
  }

  pruneExpiredEntries(Date.now());
  pruneOldestEntries(getCacheMaxEntries());

  inMemoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}
