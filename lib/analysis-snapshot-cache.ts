import { isRedisRestConfigured, runRedisCommand } from "@/lib/redis-rest";
import type { AnalysisData } from "@/lib/types";

const SNAPSHOT_KEY_PREFIX = "analyze:snapshot:";
const DEFAULT_SNAPSHOT_TTL_SECONDS = 60 * 60;
const DEFAULT_MAX_SNAPSHOTS = 2_000;

type SnapshotRecord = {
  value: AnalysisData;
  expiresAt: number;
};

const inMemorySnapshots = new Map<string, SnapshotRecord>();

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);

  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function getSnapshotTtlSeconds() {
  return parsePositiveIntegerEnv(
    "ANALYZE_SHARE_SNAPSHOT_TTL_SECONDS",
    DEFAULT_SNAPSHOT_TTL_SECONDS,
  );
}

function getSnapshotMaxEntries() {
  return parsePositiveIntegerEnv(
    "ANALYZE_SHARE_SNAPSHOT_MAX_ENTRIES",
    DEFAULT_MAX_SNAPSHOTS,
  );
}

function keyForUsername(username: string) {
  return username.trim().toLowerCase();
}

function redisKey(username: string) {
  return `${SNAPSHOT_KEY_PREFIX}${username}`;
}

function pruneExpired(now: number) {
  for (const [key, record] of inMemorySnapshots.entries()) {
    if (record.expiresAt <= now) {
      inMemorySnapshots.delete(key);
    }
  }
}

function pruneOldest(maxEntries: number) {
  while (inMemorySnapshots.size >= maxEntries) {
    const oldestKey = inMemorySnapshots.keys().next().value;

    if (!oldestKey) {
      break;
    }

    inMemorySnapshots.delete(oldestKey);
  }
}

export async function setAnalysisSnapshot(
  username: string,
  analysis: AnalysisData,
): Promise<void> {
  const normalizedUsername = keyForUsername(username);

  if (!normalizedUsername) {
    return;
  }

  const ttlSeconds = getSnapshotTtlSeconds();

  if (isRedisRestConfigured()) {
    try {
      await runRedisCommand([
        "SET",
        redisKey(normalizedUsername),
        JSON.stringify(analysis),
        "EX",
        ttlSeconds,
      ]);
      return;
    } catch {
    }
  }

  const now = Date.now();
  pruneExpired(now);
  pruneOldest(getSnapshotMaxEntries());

  inMemorySnapshots.set(normalizedUsername, {
    value: analysis,
    expiresAt: now + ttlSeconds * 1000,
  });
}

export async function getAnalysisSnapshot(
  username: string,
): Promise<AnalysisData | null> {
  const normalizedUsername = keyForUsername(username);

  if (!normalizedUsername) {
    return null;
  }

  if (isRedisRestConfigured()) {
    try {
      const raw = await runRedisCommand<string>(["GET", redisKey(normalizedUsername)]);

      if (!raw) {
        return null;
      }

      return JSON.parse(raw) as AnalysisData;
    } catch {
      // Fall through to in-memory cache.
    }
  }

  const now = Date.now();
  pruneExpired(now);

  const cached = inMemorySnapshots.get(normalizedUsername);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= now) {
    inMemorySnapshots.delete(normalizedUsername);
    return null;
  }

  return cached.value;
}
