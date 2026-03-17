import { NextRequest } from "next/server";
import {
  buildDeterministicAiFeedback,
  generateAiFeedback,
  type AiFeedback,
} from "@/lib/ai-feedback";
import { getCachedAiFeedback, setCachedAiFeedback } from "@/lib/ai-response-cache";
import {
  enforceAnalyzeRequestProtection,
  getAnalyzeRequestClientIp,
} from "@/lib/analyze-request-protection";
import { jsonError, jsonSuccess } from "@/lib/api-response";
import { buildLiveAnalysis, GitHubRequestError } from "@/lib/live-analysis";
import type { AnalysisData } from "@/lib/types";
import { isValidGitHubUsername, normalizeUsername } from "@/lib/utils";

type AnalyzeRequestBody = {
  username?: string;
};

function scoreToPercentile(score: number) {
  return Math.max(5, Math.min(19, Math.round(24 - score * 1.95)));
}

function applyAiFeedback(analysis: AnalysisData, feedback: AiFeedback) {
  analysis.summary = feedback.summary;
  analysis.strengths = feedback.strengths;
  analysis.weaknesses = feedback.weaknesses;
  analysis.suggestions = feedback.suggestions;
  analysis.score = feedback.score;
  analysis.confidence = feedback.confidence;
  analysis.benchmarkDelta = `Top ${scoreToPercentile(feedback.score)}% of public technical portfolios`;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as AnalyzeRequestBody | null;

  if (!body || typeof body !== "object") {
    return jsonError("Invalid request body.", {
      status: 400,
    });
  }

  const username = normalizeUsername(String(body?.username ?? ""));
  const clientIp = getAnalyzeRequestClientIp(request.headers);
  const githubToken =
    process.env.GITHUB_TOKEN?.trim() ??
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim() ??
    "";
  const aiApiKey = process.env.AI_API_KEY?.trim() ?? process.env.GEMINI_API_KEY?.trim() ?? "";

  if (!username || !isValidGitHubUsername(username)) {
    return jsonError("Enter a valid GitHub username.", {
      status: 400,
    });
  }

  if (!githubToken) {
    return jsonError(
      "Server is missing GitHub credentials. Set GITHUB_TOKEN (or GITHUB_PERSONAL_ACCESS_TOKEN) in .env.local.",
      {
        status: 500,
      },
    );
  }

  if (!aiApiKey) {
    return jsonError(
      "Server is missing AI credentials. Set AI_API_KEY (or GEMINI_API_KEY) in .env.local.",
      {
        status: 500,
      },
    );
  }

  const protection = await enforceAnalyzeRequestProtection(clientIp);

  if (!protection.allowed) {
    return jsonError(protection.error, {
      status: protection.status,
      headers: protection.headers,
    });
  }

  try {
    const analysis = await buildLiveAnalysis(username, githubToken);
    const cachedAiFeedback = await getCachedAiFeedback(username, analysis);
    let usedCachedAiFeedback = false;
    let warning: string | undefined;

    if (cachedAiFeedback) {
      applyAiFeedback(analysis, cachedAiFeedback);
      usedCachedAiFeedback = true;
    } else {
      let aiFeedback: AiFeedback;

      try {
        aiFeedback = await generateAiFeedback(analysis, aiApiKey);
        await setCachedAiFeedback(username, aiFeedback, analysis);
      } catch {
        aiFeedback = buildDeterministicAiFeedback(analysis);
        warning =
          "AI provider is temporarily unavailable. Returned deterministic system feedback.";
      }

      applyAiFeedback(analysis, aiFeedback);
    }

    return jsonSuccess(
      {
        source: "github",
        analysis,
        cachedAi: usedCachedAiFeedback,
        warning,
      },
      {
        status: 200,
        headers: protection.headers,
      },
    );
  } catch (error) {
    if (error instanceof GitHubRequestError) {
      if (error.status === 401) {
        return jsonError(
          "Configured GitHub token is invalid or missing required scopes.",
          {
            status: 401,
            headers: protection.headers,
          },
        );
      }

      if (error.status === 403) {
        return jsonError(
          "GitHub API request was rate limited or forbidden for the configured token.",
          {
            status: 403,
            headers: protection.headers,
          },
        );
      }

      if (error.status === 404) {
        return jsonError("GitHub user was not found.", {
          status: 404,
          headers: protection.headers,
        });
      }

      return jsonError(`GitHub API error: ${error.message}`, {
        status: 502,
        headers: protection.headers,
      });
    }

    return jsonError("Unexpected failure while building analysis.", {
      status: 500,
      headers: protection.headers,
    });
  }
}
