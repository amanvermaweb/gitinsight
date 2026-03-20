import type { AnalysisData } from "./types";
import {
  buildScoreNarratives,
  computeGitInsightScore,
} from "./gitinsight-score";
import { clamp, roundToTenth } from "./utils";

type GitHubUser = {
  login: string;
  followers: number;
  public_repos: number;
};

type GitHubRepositorySearchResponse = {
  items: GitHubRepo[];
};

type GitHubIssueSearchResponse = {
  total_count: number;
};

type GitHubRepo = {
  full_name: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
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
const DEFAULT_GITHUB_TIMEOUT_MS = 10_000;
const DAYS_IN_SCORING_WINDOW = 90;
const MAX_EVENT_PAGES = 3;
const DEFAULT_MIN_SCORABLE_REPO_SIZE_KB = 80;
const DEFAULT_MAX_COMMITS_PER_MINUTE = 12;
const DEFAULT_QUALITY_STAR_CAP_PER_REPO = 3;
const DEFAULT_IMPACT_STAR_CAP_PER_REPO = 20;
const DEFAULT_IMPACT_FORK_CAP_PER_REPO = 12;
const DEFAULT_QUALITY_REPO_LIMIT = 6;
const DEFAULT_IMPACT_REPO_LIMIT = 12;
const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "GitInsight-App",
} as const;

const FRAMEWORK_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "React", regex: /\breact\b/i },
  { name: "Next.js", regex: /\bnext(?:\.js|js)?\b/i },
  { name: "Vue", regex: /\bvue\b/i },
  { name: "Nuxt", regex: /\bnuxt\b/i },
  { name: "Angular", regex: /\bangular\b/i },
  { name: "Svelte", regex: /\bsvelte\b/i },
  { name: "Remix", regex: /\bremix\b/i },
  { name: "Express", regex: /\bexpress\b/i },
  { name: "NestJS", regex: /\bnest\b|\bnestjs\b/i },
  { name: "Django", regex: /\bdjango\b/i },
  { name: "Flask", regex: /\bflask\b/i },
  { name: "FastAPI", regex: /\bfastapi\b/i },
  { name: "Rails", regex: /\brails\b/i },
  { name: "Spring", regex: /\bspring\b/i },
  { name: "Laravel", regex: /\blaravel\b/i },
];

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

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);

  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function getGitHubTimeoutMs() {
  return parsePositiveIntegerEnv("ANALYZE_GITHUB_TIMEOUT_MS", DEFAULT_GITHUB_TIMEOUT_MS);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), getGitHubTimeoutMs());

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
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

  let response: Response;

  try {
    response = await fetchWithTimeout(target, {
      method: "GET",
      cache: "no-store",
      headers: {
        ...GITHUB_API_HEADERS,
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new GitHubRequestError(504, "GitHub request timed out.");
    }

    throw new GitHubRequestError(
      502,
      "GitHub request failed before receiving a response.",
    );
  }

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
  let response: Response;

  try {
    response = await fetchWithTimeout(
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
  } catch (error) {
    if (isAbortError(error)) {
      throw new GitHubRequestError(504, "GitHub request timed out.");
    }

    throw new GitHubRequestError(
      502,
      "GitHub request failed before receiving a response.",
    );
  }

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

function toPercent(value: number) {
  return Math.round(clamp(value, 0, 1) * 100);
}

function getMinimumScorableRepoSizeKb() {
  return parsePositiveIntegerEnv(
    "ANALYZE_MIN_SCORABLE_REPO_SIZE_KB",
    DEFAULT_MIN_SCORABLE_REPO_SIZE_KB,
  );
}

function getMaxCommitsPerMinute() {
  return parsePositiveIntegerEnv(
    "ANALYZE_MAX_COMMITS_PER_MINUTE",
    DEFAULT_MAX_COMMITS_PER_MINUTE,
  );
}

function getQualityStarCapPerRepo() {
  return parsePositiveIntegerEnv(
    "ANALYZE_QUALITY_STAR_CAP_PER_REPO",
    DEFAULT_QUALITY_STAR_CAP_PER_REPO,
  );
}

function getImpactStarCapPerRepo() {
  return parsePositiveIntegerEnv(
    "ANALYZE_IMPACT_STAR_CAP_PER_REPO",
    DEFAULT_IMPACT_STAR_CAP_PER_REPO,
  );
}

function getImpactForkCapPerRepo() {
  return parsePositiveIntegerEnv(
    "ANALYZE_IMPACT_FORK_CAP_PER_REPO",
    DEFAULT_IMPACT_FORK_CAP_PER_REPO,
  );
}

function getQualityRepoLimit() {
  return parsePositiveIntegerEnv(
    "ANALYZE_QUALITY_REPO_LIMIT",
    DEFAULT_QUALITY_REPO_LIMIT,
  );
}

function getImpactRepoLimit() {
  return parsePositiveIntegerEnv(
    "ANALYZE_IMPACT_REPO_LIMIT",
    DEFAULT_IMPACT_REPO_LIMIT,
  );
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function minuteKeyFromIso(isoDate: string) {
  return isoDate.slice(0, 16);
}

function computeLongestStreak(days: Set<string>) {
  if (days.size === 0) {
    return 0;
  }

  const timestamps = Array.from(days)
    .map((entry) => Date.parse(`${entry}T00:00:00.000Z`))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (timestamps.length === 0) {
    return 0;
  }

  let longest = 1;
  let current = 1;

  for (let index = 1; index < timestamps.length; index += 1) {
    const diffDays = Math.round((timestamps[index] - timestamps[index - 1]) / 86_400_000);

    if (diffDays === 1) {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }

    if (diffDays > 1) {
      current = 1;
    }
  }

  return longest;
}

function countMeaningfulLanguages(languageTotals: Map<string, number>) {
  const totalBytes = Array.from(languageTotals.values()).reduce(
    (sum, value) => sum + value,
    0,
  );

  if (totalBytes <= 0) {
    return 0;
  }

  const shareThreshold = totalBytes * 0.05;
  return Array.from(languageTotals.entries()).filter(
    ([, bytes]) => bytes >= shareThreshold || bytes >= 20_000,
  ).length;
}

function detectFrameworkCount(repositories: GitHubRepo[]) {
  const detected = new Set<string>();

  for (const repo of repositories) {
    const corpus = [
      repo.full_name,
      repo.description ?? "",
      ...(repo.topics ?? []),
    ]
      .join(" ")
      .toLowerCase();

    for (const framework of FRAMEWORK_PATTERNS) {
      if (framework.regex.test(corpus)) {
        detected.add(framework.name);
      }
    }
  }

  return detected.size;
}

function toDateFilter(days: number) {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function detectArchetype(
  scoreComponents: ReturnType<typeof computeGitInsightScore>["components"],
  skills: Array<{ label: string; value: number }>,
) {
  const frontendSkill = skills.find((entry) => entry.label === "Frontend")?.value ?? 0;
  const backendSkill = skills.find((entry) => entry.label === "Backend")?.value ?? 0;

  if (scoreComponents.quality >= 75 && scoreComponents.consistency >= 65) {
    return "Quality-Focused Builder";
  }

  if (scoreComponents.consistency >= 78) {
    return "Consistency Grinder";
  }

  if (scoreComponents.impact >= 68) {
    return "Open Source Explorer";
  }

  if (frontendSkill >= 65 && backendSkill >= 60 && scoreComponents.breadth >= 65) {
    return "Full Stack Operator";
  }

  if (frontendSkill >= backendSkill + 12) {
    return "Frontend Specialist";
  }

  return "Quality-Focused Builder";
}

type ActivityWindowStats = {
  weightedCommits: number;
  activeDays: number;
  longestStreak: number;
  externalContributions: number;
  spamCommitsSuppressed: number;
  pushEventsLast90: number;
};

function computeActivityWindowStats(events: GitHubEvent[], username: string): ActivityWindowStats {
  const nowMs = Date.now();
  const minEventTimeMs = nowMs - DAYS_IN_SCORING_WINDOW * 86_400_000;
  const activeDaySet = new Set<string>();
  const externalContributionKeys = new Set<string>();
  const minuteCommitBuckets = new Map<string, number>();
  const maxCommitsPerMinute = getMaxCommitsPerMinute();
  const normalizedUsername = username.trim().toLowerCase();

  let weightedCommits = 0;
  let spamCommitsSuppressed = 0;
  let pushEventsLast90 = 0;

  for (const event of events) {
    const eventDate = new Date(event.created_at);
    const eventTime = eventDate.getTime();

    if (!Number.isFinite(eventTime) || eventTime < minEventTimeMs || eventTime > nowMs) {
      continue;
    }

    activeDaySet.add(dayKey(eventDate));

    const owner = event.repo.name.split("/")[0]?.toLowerCase() ?? "";
    const isExternalRepo = owner.length > 0 && owner !== normalizedUsername;

    if (
      isExternalRepo &&
      [
        "PushEvent",
        "PullRequestEvent",
        "IssuesEvent",
        "IssueCommentEvent",
        "PullRequestReviewEvent",
      ].includes(event.type)
    ) {
      externalContributionKeys.add(`${normalizeRepoKey(event.repo.name)}:${dayKey(eventDate)}`);
    }

    if (event.type !== "PushEvent") {
      continue;
    }

    const rawCommitCount = clamp(Number(event.payload?.size ?? 1), 1, 30);
    const minuteKey = minuteKeyFromIso(event.created_at);
    const alreadyCounted = minuteCommitBuckets.get(minuteKey) ?? 0;
    const remainingBudget = Math.max(0, maxCommitsPerMinute - alreadyCounted);
    const acceptedCommitCount = Math.min(rawCommitCount, remainingBudget);
    const suppressed = rawCommitCount - acceptedCommitCount;

    spamCommitsSuppressed += suppressed;
    minuteCommitBuckets.set(minuteKey, alreadyCounted + acceptedCommitCount);

    if (acceptedCommitCount <= 0) {
      continue;
    }

    pushEventsLast90 += acceptedCommitCount;

    const ageDays = (nowMs - eventTime) / 86_400_000;
    const recencyWeight = clamp(1 - (ageDays / DAYS_IN_SCORING_WINDOW) * 0.45, 0.55, 1);
    weightedCommits += acceptedCommitCount * recencyWeight;
  }

  return {
    weightedCommits: Math.round(weightedCommits),
    activeDays: activeDaySet.size,
    longestStreak: computeLongestStreak(activeDaySet),
    externalContributions: externalContributionKeys.size,
    spamCommitsSuppressed,
    pushEventsLast90,
  };
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

  const sinceDate = toDateFilter(DAYS_IN_SCORING_WINDOW);
  const [eventPage1, eventPage2, eventPage3, prSearch, issueSearch] = await Promise.all([
    requestGitHubBestEffort<GitHubEvent[]>(
      `/users/${username}/events/public?per_page=100&page=1`,
      apiKey,
    ),
    requestGitHubBestEffort<GitHubEvent[]>(
      `/users/${username}/events/public?per_page=100&page=2`,
      apiKey,
    ),
    requestGitHubBestEffort<GitHubEvent[]>(
      `/users/${username}/events/public?per_page=100&page=3`,
      apiKey,
    ),
    requestGitHubBestEffort<GitHubIssueSearchResponse>(
      `/search/issues?q=${encodeURIComponent(
        `author:${username} type:pr created:>=${sinceDate}`,
      )}&per_page=1`,
      apiKey,
    ),
    requestGitHubBestEffort<GitHubIssueSearchResponse>(
      `/search/issues?q=${encodeURIComponent(
        `author:${username} type:issue created:>=${sinceDate}`,
      )}&per_page=1`,
      apiKey,
    ),
  ]);

  const events = [eventPage1 ?? [], eventPage2 ?? [], eventPage3 ?? []]
    .slice(0, MAX_EVENT_PAGES)
    .flat();

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

  const activityWindowStats = computeActivityWindowStats(events, user.login);
  const pullRequestCount = Math.max(0, prSearch?.total_count ?? 0);
  const issueCount = Math.max(0, issueSearch?.total_count ?? 0);

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

  const minScorableRepoSizeKb = getMinimumScorableRepoSizeKb();
  const qualityStarCap = getQualityStarCapPerRepo();
  const impactStarCap = getImpactStarCapPerRepo();
  const impactForkCap = getImpactForkCapPerRepo();
  const scorableFeaturedRepos = featuredRepos
    .filter((repo) => repo.size >= minScorableRepoSizeKb)
    .slice(0, getQualityRepoLimit());
  const scorableImpactRepos = analyzedRepos
    .filter((repo) => repo.size >= minScorableRepoSizeKb)
    .slice(0, getImpactRepoLimit());
  const ignoredTinyRepos = analyzedRepos.filter(
    (repo) => repo.size < minScorableRepoSizeKb,
  ).length;

  const readmeByRepoName = new Map(
    enrichedRepos.map((repo) => [repo.name.toLowerCase(), repo.hasReadme] as const),
  );

  const reposWithReadme = scorableFeaturedRepos.filter(
    (repo) => readmeByRepoName.get(repo.full_name.toLowerCase()) === true,
  ).length;
  const qualityStars = scorableFeaturedRepos.reduce(
    (sum, repo) => sum + Math.min(repo.stargazers_count, qualityStarCap),
    0,
  );
  const impactStars = scorableImpactRepos.reduce(
    (sum, repo) => sum + Math.min(repo.stargazers_count, impactStarCap),
    0,
  );
  const impactForks = scorableImpactRepos.reduce(
    (sum, repo) => sum + Math.min(repo.forks_count, impactForkCap),
    0,
  );
  const avgRepoSizeScore = average(
    scorableFeaturedRepos.map((repo) =>
      clamp((repo.size - minScorableRepoSizeKb) / 2_000, 0, 1),
    ),
  );

  const meaningfulLanguageCount = countMeaningfulLanguages(languageTotals);
  const frameworkCount = detectFrameworkCount(
    scorableImpactRepos.length > 0 ? scorableImpactRepos : analyzedRepos,
  );

  const scoreResult = computeGitInsightScore({
    commits: activityWindowStats.weightedCommits,
    prs: pullRequestCount,
    issues: issueCount,
    activeDays: activityWindowStats.activeDays,
    streakDays: activityWindowStats.longestStreak,
    qualityStars,
    reposWithReadme,
    avgRepoSizeScore,
    impactStars,
    impactForks,
    followers: user.followers,
    externalContributions: activityWindowStats.externalContributions,
    languages: meaningfulLanguageCount,
    frameworks: frameworkCount,
  });
  const scoreNarratives = buildScoreNarratives(scoreResult.components);

  const totalLanguageBytes =
    Array.from(languageTotals.values()).reduce((sum, value) => sum + value, 0) || 1;

  const breakdown = [
    {
      label: "Activity",
      value: scoreResult.components.activity,
      note: `${activityWindowStats.weightedCommits} weighted commits, ${pullRequestCount} pull requests, and ${issueCount} issues in the last 90 days.`,
    },
    {
      label: "Consistency",
      value: scoreResult.components.consistency,
      note: `${activityWindowStats.activeDays} active days over 90 and a longest streak of ${activityWindowStats.longestStreak} days.`,
    },
    {
      label: "Code quality proxy",
      value: scoreResult.components.quality,
      note: `${reposWithReadme} qualifying repos with substantive README coverage and average repo-size score ${avgRepoSizeScore.toFixed(2)} (0-1).`,
    },
    {
      label: "Impact",
      value: scoreResult.components.impact,
      note: `${impactStars} capped stars, ${impactForks} capped forks, ${user.followers} followers, and ${activityWindowStats.externalContributions} external contributions.`,
    },
    {
      label: "Tech breadth",
      value: scoreResult.components.breadth,
      note: `${meaningfulLanguageCount} meaningful languages and ${frameworkCount} frameworks detected across scorable repositories.`,
    },
  ];

  const breakdownByScore = [...breakdown].sort((first, second) => second.value - first.value);
  const strongestMetric = breakdownByScore[0] ?? breakdown[0];
  const weakestMetric = breakdownByScore[breakdownByScore.length - 1] ?? breakdown[breakdown.length - 1];

  const score = scoreResult.finalScore;
  const confidence = roundToTenth(
    clamp(
      0.35 +
        clamp(analyzedRepos.length / 12, 0, 1) * 0.22 +
        readmeCoverage * 0.12 +
        recentCoverage * 0.12 +
        clamp(activityWindowStats.activeDays / DAYS_IN_SCORING_WINDOW, 0, 1) * 0.15 -
        clamp(ignoredTinyRepos / Math.max(1, analyzedRepos.length), 0, 0.2),
      0.25,
      0.95,
    ),
  );

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

  const archetype = detectArchetype(scoreResult.components, skills);

  const strengths = [
    scoreNarratives.strengthLine,
    `${user.login} has ${activityWindowStats.activeDays} active days in the last 90 days across ${user.public_repos} public repositories.`,
    `${toPercent(readmeCoverage)}% README coverage across featured repositories supports reviewer trust and maintainability perception.`,
  ];

  const weaknesses = [
    scoreNarratives.weaknessLine,
    ignoredTinyRepos > 0
      ? `${ignoredTinyRepos} small repositories were excluded from scoring to reduce gaming by low-signal projects.`
      : "No repositories were excluded by anti-gaming size filters.",
    activityWindowStats.spamCommitsSuppressed > 0
      ? `${activityWindowStats.spamCommitsSuppressed} same-minute commit units were discounted to avoid burst-spam inflation.`
      : "No commit-burst spam signals were detected in the 90-day activity window.",
  ];

  const suggestions = [
    scoreNarratives.coaching,
    "Promote one flagship repository with a structured case study covering constraints, tradeoffs, architecture, and outcomes.",
    "Publish demos and release notes consistently so impact and recency signals stay high without relying on commit volume alone.",
  ];

  return {
    username: user.login,
    score,
    confidence,
    followers: user.followers,
    totalStars,
    repositoriesAnalyzed: analyzedRepos.length,
    benchmarkDelta: "Top 50% among analyzed GitInsight profiles",
    headline:
      score >= 80
        ? `High-signal portfolio with strong momentum: ${activityWindowStats.activeDays} active days in the last 90 and ${meaningfulLanguageCount} meaningful languages.`
        : `Useful baseline signal with clear upside in ${scoreNarratives.weakestComponent} and open-source visibility.`,
    summary:
      `${user.login} scored ${score}/100 from ${analyzedRepos.length} analyzed repositories and ${activityWindowStats.pushEventsLast90} push-event commit units in the last 90 days. Strongest signal: ${strongestMetric?.label ?? "Activity"}. Lowest signal: ${weakestMetric?.label ?? "Impact"}.`,
    highlights: [
      `Analyzed ${analyzedRepos.length} top repositories and ${events.length} recent public events.`,
      `${readmeCoverage >= 0.7 ? "Strong" : "Moderate"} README coverage across featured repositories (${toPercent(readmeCoverage)}%).`,
      `${meaningfulLanguageCount} meaningful languages and ${frameworkCount} frameworks detected in scoring inputs.`,
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
    scoreMeta: {
      archetype,
      averageDeveloperScore: 56,
      nextLevel: {
        targetTopPercent: 10,
        starsNeeded: Math.max(0, 20 - totalStars),
        externalContributionsNeeded: Math.max(
          0,
          3 - activityWindowStats.externalContributions,
        ),
        commitsNeeded: Math.max(0, 40 - activityWindowStats.weightedCommits),
      },
    },
  };
}
