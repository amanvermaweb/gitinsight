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
import {
  buildScoreNarratives,
  upsertScorePercentile,
} from "@/lib/gitinsight-score";
import { buildLiveAnalysis, GitHubRequestError } from "@/lib/live-analysis";
import type { AnalysisData } from "@/lib/types";
import { isValidGitHubUsername, normalizeUsername } from "@/lib/utils";

type AnalyzeRequestBody = {
  username?: string;
};

function benchmarkLabel(topPercent: number) {
  return `Top ${topPercent}% among analyzed GitInsight profiles`;
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

function getComponentScore(analysis: AnalysisData, label: string) {
  return analysis.breakdown.find((entry) => entry.label.toLowerCase() === label.toLowerCase())
    ?.value ?? 0;
}

function applyAiFeedback(analysis: AnalysisData, feedback: AiFeedback) {
  analysis.summary = feedback.summary;
  analysis.strengths = feedback.strengths;
  analysis.weaknesses = feedback.weaknesses;
  analysis.suggestions = feedback.suggestions;
  analysis.score = feedback.score;
  analysis.confidence = feedback.confidence;
}

function enrichFeedbackWithScoreNarratives(analysis: AnalysisData) {
  const narratives = buildScoreNarratives({
    activity: getComponentScore(analysis, "Activity"),
    consistency: getComponentScore(analysis, "Consistency"),
    quality: getComponentScore(analysis, "Code quality proxy"),
    impact: getComponentScore(analysis, "Impact"),
    breadth: getComponentScore(analysis, "Tech breadth"),
  });

  if (!analysis.strengths.some((item) => item.startsWith("Strength:"))) {
    analysis.strengths = [narratives.strengthLine, ...analysis.strengths].slice(0, 5);
  }

  if (!analysis.weaknesses.some((item) => item.startsWith("Weakness:"))) {
    analysis.weaknesses = [narratives.weaknessLine, ...analysis.weaknesses].slice(0, 5);
  }

  if (!analysis.suggestions.some((item) => item === narratives.coaching)) {
    analysis.suggestions = [narratives.coaching, ...analysis.suggestions].slice(0, 5);
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
      analysis.benchmarkDelta = benchmarkLabel(percentile.topPercent);
      analysis.scoreMeta = {
        ...analysis.scoreMeta,
        archetype: analysis.scoreMeta?.archetype ?? "Quality-Focused Builder",
        averageDeveloperScore: analysis.scoreMeta?.averageDeveloperScore ?? 56,
        topPercent: percentile.topPercent,
        nextLevel: analysis.scoreMeta?.nextLevel,
      };
    } catch {
      analysis.benchmarkDelta = benchmarkLabel(50);
      analysis.scoreMeta = {
        ...analysis.scoreMeta,
        archetype: analysis.scoreMeta?.archetype ?? "Quality-Focused Builder",
        averageDeveloperScore: analysis.scoreMeta?.averageDeveloperScore ?? 56,
        topPercent: analysis.scoreMeta?.topPercent ?? 50,
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
