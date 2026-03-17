type RedisCommandArg = string | number;

type RedisCommandResponse<T> = {
  result?: T;
  error?: string;
};

type RedisPipelineResponseItem = {
  result?: unknown;
  error?: string;
};

const REDIS_REST_URL =
  process.env.KV_REST_API_URL?.trim() ??
  process.env.UPSTASH_REDIS_REST_URL?.trim() ??
  "";

const REDIS_REST_TOKEN =
  process.env.KV_REST_API_TOKEN?.trim() ??
  process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ??
  "";
const DEFAULT_REDIS_TIMEOUT_MS = 3_000;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);

  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function getRedisTimeoutMs() {
  return parsePositiveIntegerEnv("ANALYZE_REDIS_TIMEOUT_MS", DEFAULT_REDIS_TIMEOUT_MS);
}

async function fetchRedisWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), getRedisTimeoutMs());

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Redis request timed out.");
    }

    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function getRequestHeaders() {
  return {
    Authorization: `Bearer ${REDIS_REST_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export function isRedisRestConfigured() {
  return Boolean(REDIS_REST_URL && REDIS_REST_TOKEN);
}

export async function runRedisCommand<T>(
  command: RedisCommandArg[],
): Promise<T | null> {
  if (!isRedisRestConfigured()) {
    return null;
  }

  const response = await fetchRedisWithTimeout(REDIS_REST_URL, {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify(command),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Redis command failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as RedisCommandResponse<T>;

  if (payload.error) {
    throw new Error(payload.error);
  }

  if (typeof payload.result === "undefined") {
    return null;
  }

  return payload.result;
}

export async function runRedisPipeline(
  commands: RedisCommandArg[][],
): Promise<Array<unknown | null>> {
  if (!isRedisRestConfigured()) {
    return [];
  }

  const response = await fetchRedisWithTimeout(`${REDIS_REST_URL}/pipeline`, {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify(commands),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Redis pipeline failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as RedisPipelineResponseItem[];

  return payload.map((item) => {
    if (item.error) {
      throw new Error(item.error);
    }

    if (typeof item.result === "undefined") {
      return null;
    }

    return item.result;
  });
}
