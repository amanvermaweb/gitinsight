import { NextRequest, NextResponse } from "next/server";
import { buildLiveAnalysis, GitHubRequestError } from "@/lib/gitinsight/live-analysis";
import { isValidGitHubUsername, normalizeUsername } from "@/lib/gitinsight/utils";

type AnalyzeRequestBody = {
  username?: string;
  apiKey?: string;
};

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as AnalyzeRequestBody | null;

  const username = normalizeUsername(String(body?.username ?? ""));
  const apiKey = String(body?.apiKey ?? "").trim();

  if (!username || !isValidGitHubUsername(username)) {
    return NextResponse.json(
      { error: "Enter a valid GitHub username." },
      { status: 400 },
    );
  }

  if (!apiKey) {
    return NextResponse.json(
      { error: "GitHub API key is required." },
      { status: 400 },
    );
  }

  try {
    const analysis = await buildLiveAnalysis(username, apiKey);

    return NextResponse.json(
      {
        source: "github",
        analysis,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof GitHubRequestError) {
      if (error.status === 401) {
        return NextResponse.json(
          { error: "GitHub API key is invalid or missing required scopes." },
          { status: 401 },
        );
      }

      if (error.status === 403) {
        return NextResponse.json(
          { error: "GitHub API request was rate limited or forbidden for this token." },
          { status: 403 },
        );
      }

      if (error.status === 404) {
        return NextResponse.json(
          { error: "GitHub user was not found." },
          { status: 404 },
        );
      }

      return NextResponse.json(
        { error: `GitHub API error: ${error.message}` },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { error: "Unexpected failure while building analysis." },
      { status: 500 },
    );
  }
}
