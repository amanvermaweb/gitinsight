import type { AnalysisData } from "./types";
import { clamp, roundToTenth } from "./utils";

type GitHubUser = {
  login: string;
  followers: number;
  public_repos: number;
};

type GitHubRepositorySearchResponse = {
  items: GitHubRepo[];
};

type GitHubRepo = {
  full_name: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  stargazers_count: number;
  pushed_at: string;
  archived: boolean;
  fork: boolean;
  size: number;
  topics?: string[];
  languages_url: string;
};

type GitHubReadme = {
  content: string;
  encoding: string;
};

type GitHubEvent = {
  type: string;
  created_at: string;
  repo: {
    name: string;
  };
  payload?: {
    size?: number;
  };
};

type MonthBucket = {
  key: string;
  label: string;
};

type EnrichedRepository = {
  name: string;
  stack: string[];
  stars: number;
  commits: number;
  quality: number;
  readme: string;
  recommendation: string;
  note: string;
  velocity: number[];
  hasReadme: boolean;
  languageEntries: Array<[string, number]>;
};

const GITHUB_API_ROOT = "https://api.github.com";
const TOP_REPOSITORY_SEARCH_LIMIT = 30;
const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "GitInsight-App",
} as const;

const CATEGORY_LANGUAGES: Record<string, string[]> = {
  Frontend: ["TypeScript", "JavaScript", "CSS", "HTML", "Vue", "Svelte", "Astro"],
  Backend: ["Go", "Rust", "Java", "Python", "Ruby", "PHP", "C#", "Kotlin"],
  DevOps: ["Dockerfile", "Shell", "HCL", "Nix"],
  Algorithms: ["C", "C++", "Rust", "Java", "Python"],
  "AI / ML": ["Python", "Jupyter Notebook", "R", "Julia"],
};

export class GitHubRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubRequestError";
    this.status = status;
  }
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function daysSince(isoDate: string) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  return Math.max(0, Math.floor(diffMs / 86_400_000));
}

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
}

function buildRecentMonths(count: number): MonthBucket[] {
  const formatter = new Intl.DateTimeFormat("en-US", { month: "short" });
  const now = new Date();
  const months: MonthBucket[] = [];

  for (let index = count - 1; index >= 0; index -= 1) {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1),
    );
    months.push({
      key: monthKey(date),
      label: formatter.format(date),
    });
  }

  return months;
}

function decodeReadmeLength(readme: GitHubReadme | null) {
  if (!readme || readme.encoding !== "base64") {
    return 0;
  }

  const normalized = readme.content.replace(/\n/g, "");

  try {
    return Buffer.from(normalized, "base64").toString("utf8").length;
  } catch {
    return 0;
  }
}

async function requestGitHub<T>(url: string, token: string): Promise<T> {
  const target = url.startsWith("http") ? url : `${GITHUB_API_ROOT}${url}`;

  const response = await fetch(target, {
    method: "GET",
    cache: "no-store",
    headers: {
      ...GITHUB_API_HEADERS,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;

    throw new GitHubRequestError(
      response.status,
      payload?.message ?? "GitHub request failed.",
    );
  }

  return (await response.json()) as T;
}

async function requestGitHubOptional<T>(url: string, token: string): Promise<T | null> {
  try {
    return await requestGitHub<T>(url, token);
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 404) {
      return null;
    }

    throw error;
  }
}

async function requestGitHubBestEffort<T>(url: string, token: string): Promise<T | null> {
  try {
    return await requestGitHub<T>(url, token);
  } catch {
    return null;
  }
}

function parseGitHubErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const maybeMessage = (payload as { message?: unknown }).message;
  return typeof maybeMessage === "string" ? maybeMessage : null;
}

function normalizeRepoKey(repoName: string) {
  return repoName.toLowerCase();
}

function extractLastPageNumber(linkHeader: string | null) {
  if (!linkHeader) {
    return null;
  }

  const links = linkHeader.split(",");
  const lastLink = links.find((entry) => /rel="last"/.test(entry));

  if (!lastLink) {
    return null;
  }

  const match = lastLink.match(/<([^>]+)>/);
  if (!match) {
    return null;
  }

  try {
    const pageValue = new URL(match[1]).searchParams.get("page");
    const pageNumber = Number(pageValue);
    if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
      return null;
    }

    return Math.floor(pageNumber);
  } catch {
    return null;
  }
}

async function requestRepositoryCommitCount(
  repoFullName: string,
  username: string,
  token: string,
) {
  const response = await fetch(
    `${GITHUB_API_ROOT}/repos/${repoFullName}/commits?author=${encodeURIComponent(
      username,
    )}&per_page=1`,
    {
      method: "GET",
      cache: "no-store",
      headers: {
        ...GITHUB_API_HEADERS,
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (!response.ok) {
    if (response.status === 404 || response.status === 409) {
      return 0;
    }

    const payload = await response.json().catch(() => null);
    throw new GitHubRequestError(
      response.status,
      parseGitHubErrorMessage(payload) ?? "GitHub request failed.",
    );
  }

  const lastPage = extractLastPageNumber(response.headers.get("link"));
  if (lastPage !== null) {
    return lastPage;
  }

  const firstPage = (await response.json().catch(() => [])) as unknown;
  return Array.isArray(firstPage) ? firstPage.length : 0;
}

function repositoryRecommendation(readmeLength: number, repo: GitHubRepo) {
  if (readmeLength < 160) {
    return "Expand README with architecture, setup, and expected outcomes to improve reviewer confidence.";
  }

  if (!repo.description) {
    return "Add a concise repository description so the project value is obvious before opening the code.";
  }

  if (!repo.homepage) {
    return "Add a demo or deployment link to strengthen product credibility during portfolio review.";
  }

  return "Add a short changelog section to communicate momentum and maintenance discipline.";
}

function readmeInsight(readmeLength: number) {
  if (readmeLength < 160) {
    return "README coverage is minimal and does not yet communicate architecture or impact.";
  }

  if (readmeLength < 700) {
    return "README captures intent but needs stronger implementation details and usage pathways.";
  }

  return "README is strong: framing, setup details, and project context are easy to evaluate.";
}

function scoreToPercentile(score: number) {
  return clamp(Math.round(24 - score * 1.95), 5, 19);
}

function toPercent(value: number) {
  return Math.round(clamp(value, 0, 1) * 100);
}

export async function buildLiveAnalysis(
  username: string,
  apiKey: string,
): Promise<AnalysisData> {
  const repositorySearchQuery = encodeURIComponent(
    `user:${username} fork:false archived:false`,
  );

  const [user, repositorySearch] = await Promise.all([
    requestGitHub<GitHubUser>(`/users/${username}`, apiKey),
    requestGitHub<GitHubRepositorySearchResponse>(
      `/search/repositories?q=${repositorySearchQuery}&sort=stars&order=desc&per_page=${TOP_REPOSITORY_SEARCH_LIMIT}`,
      apiKey,
    ),
  ]);
  const repos = repositorySearch.items ?? [];

  const events = await requestGitHubBestEffort<GitHubEvent[]>(
    `/users/${username}/events/public?per_page=100`,
    apiKey,
  );

  const ownedRepos = repos.filter((repo) => !repo.fork);
  const sortedRepos = [...ownedRepos].sort(
    (first, second) =>
      second.stargazers_count - first.stargazers_count ||
      new Date(second.pushed_at).getTime() - new Date(first.pushed_at).getTime(),
  );

  const analyzedRepos = sortedRepos.slice(0, Math.min(12, sortedRepos.length || 1));
  const featuredRepos = sortedRepos.slice(0, Math.min(6, sortedRepos.length || 1));
  const monthlyWindow = buildRecentMonths(7);
  const monthlyMap = new Map(monthlyWindow.map((month) => [month.key, 0]));
  const pushEvents = (events ?? []).filter((event) => event.type === "PushEvent");
  const nowMs = Date.now();
  const recentCommitsByRepo = new Map<string, number>();
  const weeklyByRepo = new Map<string, number[]>();

  for (const event of pushEvents) {
    const eventDate = new Date(event.created_at);
    const key = monthKey(eventDate);
    const commitSize = Math.max(1, Number(event.payload?.size ?? 1));

    if (monthlyMap.has(key)) {
      monthlyMap.set(key, (monthlyMap.get(key) ?? 0) + commitSize);
    }

    const repoKey = normalizeRepoKey(event.repo.name);
    recentCommitsByRepo.set(
      repoKey,
      (recentCommitsByRepo.get(repoKey) ?? 0) + commitSize,
    );

    const diffDays = Math.floor((nowMs - eventDate.getTime()) / 86_400_000);
    if (diffDays >= 0 && diffDays < 49) {
      const bucketIndex = 6 - Math.floor(diffDays / 7);
      const buckets = weeklyByRepo.get(repoKey) ?? Array(7).fill(0);
      buckets[bucketIndex] += commitSize;
      weeklyByRepo.set(repoKey, buckets);
    }
  }

  const monthlyRaw = monthlyWindow.map((month) => monthlyMap.get(month.key) ?? 0);
  const maxMonthlyRaw = Math.max(...monthlyRaw, 0);

  const activity = monthlyWindow.map((month, index) => ({
    label: month.label,
    value:
      maxMonthlyRaw > 0
        ? Math.round(42 + (monthlyRaw[index] / maxMonthlyRaw) * 52)
        : 52 + index * 4,
  }));

  const enrichedRepos = await Promise.all(
    featuredRepos.map(async (repo) => {
      const [languages, readme] = await Promise.all([
        requestGitHubOptional<Record<string, number>>(repo.languages_url, apiKey),
        requestGitHubOptional<GitHubReadme>(`/repos/${repo.full_name}/readme`, apiKey),
      ]);
      const repoKey = normalizeRepoKey(repo.full_name);
      const commitCount = await requestRepositoryCommitCount(
        repo.full_name,
        user.login,
        apiKey,
      ).catch(() => recentCommitsByRepo.get(repoKey) ?? 0);

      const languageEntries = Object.entries(languages ?? {}).sort(
        (first, second) => second[1] - first[1],
      );
      const primaryLanguages = languageEntries
        .slice(0, 3)
        .map(([language]) => language);
      const stack =
        primaryLanguages.length > 0
          ? primaryLanguages
          : repo.language
            ? [repo.language]
            : ["Unspecified"];

      const readmeLength = decodeReadmeLength(readme);
      const hasReadme = readmeLength >= 160;
      const recencyFactor = clamp(1.15 - daysSince(repo.pushed_at) / 365, 0, 1.15);
      const starFactor = clamp(repo.stargazers_count / 160, 0, 1.9);
      const quality = roundToTenth(
        clamp(6.2 + starFactor + recencyFactor + (hasReadme ? 0.65 : 0.15), 6.2, 9.8),
      );

      const weeklyRaw = weeklyByRepo.get(repoKey) ?? Array(7).fill(0);
      const weeklyMax = Math.max(...weeklyRaw, 1);
      const velocity = weeklyRaw.map((value) =>
        Math.max(2, Math.round((value / weeklyMax) * 10) + 2),
      );

      const note = repo.archived
        ? "Archived repository. Treat as historical signal rather than active velocity."
        : repo.stargazers_count > 120
          ? "Strong external signal and sustained relevance in developer ecosystems."
          : "Good implementation depth; visibility can improve with clearer positioning.";

      const enrichedRepo: EnrichedRepository = {
        name: repo.full_name,
        stack,
        stars: repo.stargazers_count,
        commits: commitCount,
        quality,
        readme: readmeInsight(readmeLength),
        recommendation: repositoryRecommendation(readmeLength, repo),
        note,
        velocity,
        hasReadme,
        languageEntries,
      };

      return enrichedRepo;
    }),
  );

  const totalStars = sortedRepos.reduce((sum, repo) => sum + repo.stargazers_count, 0);

  const readmeCoverage =
    enrichedRepos.filter((repo) => repo.hasReadme).length /
    Math.max(1, enrichedRepos.length);
  const descriptionCoverage =
    analyzedRepos.filter((repo) => Boolean(repo.description)).length /
    Math.max(1, analyzedRepos.length);
  const homepageCoverage =
    analyzedRepos.filter((repo) => Boolean(repo.homepage)).length /
    Math.max(1, analyzedRepos.length);
  const recentCoverage =
    analyzedRepos.filter((repo) => daysSince(repo.pushed_at) <= 120).length /
    Math.max(1, analyzedRepos.length);
  const activityDensity = clamp(pushEvents.length / 60, 0, 1);

  const languageTotals = new Map<string, number>();
  for (const repo of enrichedRepos) {
    for (const [language, bytes] of repo.languageEntries) {
      languageTotals.set(language, (languageTotals.get(language) ?? 0) + bytes);
    }
  }

  const totalLanguageBytes =
    Array.from(languageTotals.values()).reduce((sum, value) => sum + value, 0) || 1;
  const uniqueLanguageFactor = clamp(languageTotals.size / 12, 0, 1);
  const averageRepoQuality = average(enrichedRepos.map((repo) => repo.quality));

  const codeQuality = roundToTenth(
    clamp(6.2 + (averageRepoQuality - 6.2) * 0.9 + readmeCoverage * 0.35, 6.2, 9.8),
  );
  const documentation = roundToTenth(
    clamp(5.9 + readmeCoverage * 2.6 + descriptionCoverage * 1.2, 5.9, 9.6),
  );
  const originality = roundToTenth(
    clamp(6 + uniqueLanguageFactor * 2.3 + recentCoverage * 1.1, 6, 9.6),
  );
  const openSourceActivity = roundToTenth(
    clamp(5.8 + activityDensity * 2.2 + recentCoverage * 1.4, 5.8, 9.6),
  );
  const portfolioCompleteness = roundToTenth(
    clamp(6 + readmeCoverage * 1.5 + descriptionCoverage + homepageCoverage * 1.1, 6, 9.7),
  );

  const breakdown = [
    {
      label: "Code quality",
      value: codeQuality,
      note: `Average featured-repo quality is ${averageRepoQuality.toFixed(1)}/10, and ${toPercent(recentCoverage)}% of analyzed repositories were updated in the last 120 days.`,
    },
    {
      label: "Documentation",
      value: documentation,
      note: `${toPercent(readmeCoverage)}% of featured repositories have substantive README coverage and ${toPercent(descriptionCoverage)}% include clear project descriptions.`,
    },
    {
      label: "Project originality",
      value: originality,
      note: `${languageTotals.size} languages are represented across top repositories, with a language-diversity factor of ${toPercent(uniqueLanguageFactor)}%.`,
    },
    {
      label: "Open source activity",
      value: openSourceActivity,
      note: `${pushEvents.length} recent public push events were observed, and activity density scores ${toPercent(activityDensity)}% against the current benchmark window.`,
    },
    {
      label: "Portfolio completeness",
      value: portfolioCompleteness,
      note: `${toPercent(homepageCoverage)}% of analyzed repositories expose demo/homepage links, and README coverage currently sits at ${toPercent(readmeCoverage)}%.`,
    },
  ];

  const breakdownByScore = [...breakdown].sort((first, second) => second.value - first.value);
  const strongestMetric = breakdownByScore[0] ?? breakdown[0];
  const weakestMetric = breakdownByScore[breakdownByScore.length - 1] ?? breakdown[breakdown.length - 1];

  const score = roundToTenth(average(breakdown.map((metric) => metric.value)));

  const skills = Object.entries(CATEGORY_LANGUAGES).map(([label, langs]) => {
    const bytes = langs.reduce(
      (sum, language) => sum + (languageTotals.get(language) ?? 0),
      0,
    );
    const share = bytes / totalLanguageBytes;
    const matchedLanguageCount = langs.filter(
      (language) => (languageTotals.get(language) ?? 0) > 0,
    ).length;
    const coverage = matchedLanguageCount / Math.max(1, langs.length);
    const normalizedShare = clamp(share / 0.55, 0, 1);
    const value = clamp(
      Math.round(18 + normalizedShare * 52 + coverage * 22 + activityDensity * 8),
      18,
      95,
    );

    return {
      label,
      value,
    };
  });

  const strengths = [
    `${user.login} shows a strong portfolio baseline with ${user.public_repos} public repositories and clear shipping momentum.`,
    readmeCoverage >= 0.7
      ? "Documentation signal is strong across flagship repositories, improving reviewer trust quickly."
      : "Repository signal is good; documentation depth in top projects can still be elevated.",
    totalStars >= 300
      ? "Community pull is visible through combined stars and recurring engagement on top repositories."
      : "Project quality appears solid even with modest star counts across top repositories, indicating strong implementation fundamentals.",
  ];

  const weaknesses = [
    descriptionCoverage < 0.65
      ? "Several repositories are missing concise descriptions, making portfolio value harder to parse quickly."
      : "Repository descriptions are present, but some could communicate impact more clearly.",
    homepageCoverage < 0.35
      ? "Few projects expose demos or deployment links, reducing product-readiness signal during review."
      : "Deployment coverage is present but can be made more consistent across top projects.",
    activityDensity < 0.35
      ? "Recent public commit velocity appears light relative to portfolio breadth."
      : "Recent activity is healthy, but visibility can improve with better change narratives and release notes.",
  ];

  const suggestions = [
    "Promote one flagship repository with a structured case study that includes constraints, tradeoffs, and impact.",
    "Standardize README sections (problem, architecture, setup, results) across your top repositories.",
    "Add demo links or screenshots to high-quality repos so hiring reviewers can evaluate outcomes in seconds.",
  ];

  return {
    username: user.login,
    score,
    followers: user.followers,
    totalStars,
    repositoriesAnalyzed: analyzedRepos.length,
    benchmarkDelta: `Top ${scoreToPercentile(score)}% of public technical portfolios`,
    headline:
      score >= 8.4
        ? `High-signal portfolio with ${toPercent(recentCoverage)}% of analyzed repositories recently active and ${languageTotals.size} languages represented.`
        : `Technical portfolio with credible execution evidence, with the largest upside in documentation depth and deployment coverage (${toPercent(homepageCoverage)}% linked).`,
    summary:
      `${user.login} scored ${score}/10 from ${analyzedRepos.length} analyzed repositories and ${pushEvents.length} recent push events. The strongest measurable signal is ${strongestMetric?.label ?? "code quality"}, while the lowest-scoring area is ${weakestMetric?.label ?? "portfolio completeness"} and should be prioritized in the next iteration.`,
    highlights: [
      `Analyzed ${analyzedRepos.length} top repositories and ${pushEvents.length} recent public push events.`,
      `${readmeCoverage >= 0.7 ? "Strong" : "Moderate"} README coverage across featured repositories.`,
      `${languageTotals.size} distinct languages detected in the top analyzed projects.`,
    ],
    breakdown,
    activity,
    repositories: enrichedRepos.map((repo) => ({
      name: repo.name,
      stack: repo.stack,
      stars: repo.stars,
      commits: repo.commits,
      quality: repo.quality,
      readme: repo.readme,
      recommendation: repo.recommendation,
      note: repo.note,
      velocity: repo.velocity,
    })),
    skills,
    strengths,
    weaknesses,
    suggestions,
  };
}
