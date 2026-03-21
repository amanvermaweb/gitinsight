import { NextRequest } from "next/server";
import {
  buildDeterministicAiFeedback,
  generateAiFeedback,
  type AiFeedback,
} from "@/lib/ai-feedback";
import { getAnalysisSnapshot, setAnalysisSnapshot } from "@/lib/analysis-snapshot-cache";
import { getCachedAiFeedback, setCachedAiFeedback } from "@/lib/ai-response-cache";
import {
  enforceAnalyzeRequestProtection,
  getAnalyzeRequestClientIp,
} from "@/lib/analyze-request-protection";
import { jsonError, jsonSuccess } from "@/lib/api-response";
import { upsertScorePercentile } from "@/lib/gitinsight-score";
import { buildLiveAnalysis, GitHubRequestError } from "@/lib/live-analysis";
import type { AnalysisData } from "@/lib/types";
import { isValidGitHubUsername, normalizeUsername } from "@/lib/utils";

type AnalyzeRequestBody = {
  username?: string;
};

const MIN_BENCHMARK_PROFILES = 5;

function benchmarkLabel(topPercent: number, totalProfiles: number) {
  if (totalProfiles < MIN_BENCHMARK_PROFILES) {
    if (totalProfiles <= 0) {
      return "Benchmark pending: no analyzed profiles yet.";
    }

    return `Benchmark warming up: ${totalProfiles} analyzed profile${totalProfiles === 1 ? "" : "s"} so far.`;
  }

  return `Top ${topPercent}% among ${totalProfiles} analyzed GitInsight profiles`;
}

export async function GET(request: NextRequest) {
  const username = normalizeUsername(request.nextUrl.searchParams.get("username") ?? "");

  if (!username || !isValidGitHubUsername(username)) {
    return jsonError("Enter a valid GitHub username.", {
      status: 400,
    });
  }

  const snapshot = await getAnalysisSnapshot(username);

  if (!snapshot) {
    return jsonError("No shared analysis snapshot is available for this user yet.", {
      status: 404,
    });
  }

  return jsonSuccess(
    {
      source: "github",
      analysis: snapshot,
      cachedAi: true,
    },
    {
      status: 200,
    },
  );
}

function applyAiFeedback(analysis: AnalysisData, feedback: AiFeedback) {
  analysis.summary = feedback.summary;
  analysis.strengths = feedback.strengths;
  analysis.weaknesses = feedback.weaknesses;
  analysis.suggestions = feedback.suggestions;
}

function enrichFeedbackWithScoreNarratives(analysis: AnalysisData) {
  const sorted = [...analysis.breakdown].sort((first, second) => second.value - first.value);
  const strongest = sorted[0];
  const weakest = sorted[sorted.length - 1];

  const strengthLine = strongest
    ? `Strength: ${strongest.label} is strongest at ${strongest.value}/100`
    : "Strength: Stable engineering signal detected";
  const weaknessLine = weakest
    ? `Weakness: ${weakest.label} is the lowest signal at ${weakest.value}/100`
    : "Weakness: Evidence is still sparse";
  const coaching = weakest
    ? `Raise ${weakest.label.toLowerCase()} first; it is the fastest lever to move the total score.`
    : "Increase evidence density across repos to improve confidence and score.";

  if (!analysis.strengths.some((item) => item.startsWith("Strength:"))) {
    analysis.strengths = [strengthLine, ...analysis.strengths].slice(0, 5);
  }

  if (!analysis.weaknesses.some((item) => item.startsWith("Weakness:"))) {
    analysis.weaknesses = [weaknessLine, ...analysis.weaknesses].slice(0, 5);
  }

  if (!analysis.suggestions.some((item) => item === coaching)) {
    analysis.suggestions = [coaching, ...analysis.suggestions].slice(0, 5);
  }

  analysis.weaknesses = analysis.weaknesses.map((item) =>
    item.replace(
      /lacks significant external impact/gi,
      "Opportunity: Increase open-source visibility",
    ),
  );
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

      if (!aiApiKey) {
        aiFeedback = buildDeterministicAiFeedback(analysis);
        warning =
          "AI provider credentials are not configured. Returned deterministic system feedback.";
      } else {
        try {
          aiFeedback = await generateAiFeedback(analysis, aiApiKey);
          await setCachedAiFeedback(username, aiFeedback, analysis);
        } catch {
          aiFeedback = buildDeterministicAiFeedback(analysis);
          warning =
            "AI provider is temporarily unavailable. Returned deterministic system feedback.";
        }
      }

      applyAiFeedback(analysis, aiFeedback);
    }

    enrichFeedbackWithScoreNarratives(analysis);

    try {
      const percentile = await upsertScorePercentile(analysis.username, analysis.score);
      analysis.benchmarkDelta = benchmarkLabel(percentile.topPercent, percentile.totalProfiles);
      analysis.scoreMeta = {
        ...analysis.scoreMeta,
        archetype: analysis.scoreMeta?.archetype ?? "Quality-Focused Builder",
        averageDeveloperScore: analysis.scoreMeta?.averageDeveloperScore ?? 56,
        topPercent: percentile.topPercent,
        benchmarkProfiles: percentile.totalProfiles,
        nextLevel: analysis.scoreMeta?.nextLevel,
      };
    } catch {
      analysis.benchmarkDelta = benchmarkLabel(50, 0);
      analysis.scoreMeta = {
        ...analysis.scoreMeta,
        archetype: analysis.scoreMeta?.archetype ?? "Quality-Focused Builder",
        averageDeveloperScore: analysis.scoreMeta?.averageDeveloperScore ?? 56,
        topPercent: analysis.scoreMeta?.topPercent ?? 50,
        benchmarkProfiles: analysis.scoreMeta?.benchmarkProfiles ?? 0,
        nextLevel: analysis.scoreMeta?.nextLevel,
      };
    }

    try {
      await setAnalysisSnapshot(analysis.username, analysis);
    } catch {
      // Snapshot caching is best-effort and should not fail analysis responses.
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
