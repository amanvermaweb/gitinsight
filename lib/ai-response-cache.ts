import { createHash } from "node:crypto";
import type { AiFeedback } from "@/lib/ai-feedback";
import { isRedisRestConfigured, runRedisCommand } from "@/lib/redis-rest";
import type { AnalysisData } from "@/lib/types";

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 2_000;
const DEFAULT_AI_PROMPT_VERSION = "v7";
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

function getCacheTtlMs(): number {
  return parsePositiveIntegerEnv("ANALYZE_AI_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS);
}

function getCacheMaxEntries(): number {
  return parsePositiveIntegerEnv(
    "ANALYZE_AI_CACHE_MAX_ENTRIES",
    DEFAULT_CACHE_MAX_ENTRIES,
  );
}

function buildAnalysisFingerprint(analysis: AnalysisData): string {
  const payload = {
    score: analysis.score,
    repositoriesAnalyzed: analysis.repositoriesAnalyzed,
    breakdown: analysis.breakdown.map((metric) => ({
      label: metric.label,
      value: metric.value,
    })),
    repositories: analysis.repositories.slice(0, 6).map((repo) => ({
      name: repo.name,
      stars: repo.stars,
      commits: repo.commits,
      quality: repo.quality,
      stack: repo.stack,
    })),
    skills: analysis.skills,
  };

  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 24);
}

function normalizeCacheKey(username: string, analysis: AnalysisData): string {
  const normalized = username.trim().toLowerCase();
  const promptVersion = process.env.ANALYZE_AI_PROMPT_VERSION?.trim() || DEFAULT_AI_PROMPT_VERSION;

  if (!normalized) {
    return "";
  }

  return `${promptVersion}:${normalized}:${buildAnalysisFingerprint(analysis)}`;
}

function getRedisCacheKey(username: string): string {
  return `${REDIS_CACHE_PREFIX}${username}`;
}

function pruneOldestEntries(maxEntries: number): void {
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
  const strengths = payload.strengths;
  const weaknesses = payload.weaknesses;
  const suggestions = payload.suggestions;

  const hasNonEmptyStringArray = (items: unknown): boolean =>
    Array.isArray(items) &&
    items.length >= 2 &&
    items.length <= 4 &&
    items.every((item) => typeof item === "string" && item.trim().length > 0);

  return (
    typeof payload.summary === "string" &&
    hasNonEmptyStringArray(strengths) &&
    hasNonEmptyStringArray(weaknesses) &&
    hasNonEmptyStringArray(suggestions)
  );
}

function pruneExpiredEntries(now: number): void {
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
  distributedCacheAdapter = adapter;
}

export async function getCachedAiFeedback(
  username: string,
  analysis: AnalysisData,
): Promise<AiFeedback | null> {
  const key = normalizeCacheKey(username, analysis);

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
      // Fall back to local memory cache if Redis is unavailable.
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

export async function setCachedAiFeedback(
  username: string,
  value: AiFeedback,
  analysis: AnalysisData,
): Promise<void> {
  const key = normalizeCacheKey(username, analysis);

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
      // Fall back to local memory cache if Redis write fails.
    }
  }

  pruneExpiredEntries(Date.now());
  pruneOldestEntries(getCacheMaxEntries());

  inMemoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}
