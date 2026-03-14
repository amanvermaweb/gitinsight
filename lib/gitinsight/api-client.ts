import type { AnalyzeApiResponse } from "./types";

export async function fetchLiveAnalysis(
  username: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<AnalyzeApiResponse> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username,
      apiKey,
    }),
    signal,
  });

  const payload = (await response.json().catch(() => null)) as
    | AnalyzeApiResponse
    | { error?: string }
    | null;

  if (!response.ok) {
    throw new Error(
      (payload as { error?: string } | null)?.error ??
        "Unable to fetch live analysis from GitHub.",
    );
  }

  if (!payload || !("analysis" in payload)) {
    throw new Error("Unexpected response from analysis service.");
  }

  return payload;
}
