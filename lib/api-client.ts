import type { AnalyzeApiResponse } from "@/lib/types";

type ApiErrorPayload = {
  error?: string;
};

async function parseJsonPayload<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

function extractErrorMessage(payload: ApiErrorPayload | null, fallback: string) {
  return payload?.error ?? fallback;
}

export async function fetchLiveAnalysis(
  username: string,
  signal: AbortSignal,
): Promise<AnalyzeApiResponse> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username,
    }),
    signal,
  });

  const payload = await parseJsonPayload<AnalyzeApiResponse | ApiErrorPayload>(response);

  if (!response.ok) {
    throw new Error(
      extractErrorMessage(
        payload as ApiErrorPayload | null,
        "Unable to fetch live analysis from GitHub.",
      ),
    );
  }

  if (!payload || !("analysis" in payload)) {
    throw new Error("Unexpected response from analysis service.");
  }

  return payload;
}
