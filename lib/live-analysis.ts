import type { AnalysisData, DomainInfo, RepositoryDomain } from "./types";
import {
  computeEngineeringScore,
  resolveEngineeringWeights,
  explainEngineeringScoreChange,
} from "./gitinsight-score";
import { clamp, roundToTenth } from "./utils";
import type { ProjectType } from "./types";
import { detectRepositoryDomain } from "./scoring/domain-detection";
import {
  buildDomainScorecard,
  domainToProjectType,
  resolveMetricScore,
} from "./scoring/domain-strategies";
import { analyzeEvolution } from "./scoring/evolution-analyzer";
import {
  buildConfidenceSummary,
  buildInsights,
  buildRecommendations,
} from "./scoring/insight-recommendations";

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

type GitHubCommitListItem = {
  sha: string;
  commit?: {
    message?: string;
  };
};

type GitHubCommitDetail = {
  sha: string;
  commit?: {
    message?: string;
  };
  files?: Array<{
    filename?: string;
    status?: string;
    additions?: number;
    deletions?: number;
    changes?: number;
  }>;
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
  contributors: number;
  sizeKb: number;
  primaryLanguage: string;
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
const COMMIT_SAMPLE_REPO_LIMIT = 4;
const COMMIT_SAMPLE_PER_REPO = 6;
const COMMIT_DETAIL_LIMIT = 20;
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

async function requestRepositoryContributorCount(repoFullName: string, token: string) {
  let response: Response;

  try {
    response = await fetchWithTimeout(
      `${GITHUB_API_ROOT}/repos/${repoFullName}/contributors?per_page=1&anon=1`,
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

async function requestRecentCommitsForRepo(
  repoFullName: string,
  username: string,
  token: string,
): Promise<GitHubCommitListItem[]> {
  return (
    (await requestGitHubBestEffort<GitHubCommitListItem[]>(
      `/repos/${repoFullName}/commits?author=${encodeURIComponent(
        username,
      )}&per_page=${COMMIT_SAMPLE_PER_REPO}`,
      token,
    )) ?? []
  );
}

async function requestCommitDetail(
  repoFullName: string,
  sha: string,
  token: string,
): Promise<GitHubCommitDetail | null> {
  return requestGitHubBestEffort<GitHubCommitDetail>(
    `/repos/${repoFullName}/commits/${sha}`,
    token,
  );
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

function stdDev(values: number[]) {
  if (values.length <= 1) {
    return 0;
  }

  const mean = average(values);
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function averageQuality(values: number[]) {
  if (!values.length) {
    return 0;
  }

  return average(values.map((value) => clamp(value / 10, 0, 1))) * 100;
}

function containsAnyPattern(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizePercentage(value: number) {
  return Math.round(clamp(value, 0, 1) * 100);
}

function scoreCommitMessageQuality(message: string) {
  const trimmed = message.trim();
  if (!trimmed) {
    return 0;
  }

  const firstLine = trimmed.split("\n")[0].trim();
  const length = firstLine.length;
  const imperativePattern =
    /^(add|build|create|implement|refactor|fix|improve|remove|update|replace|optimize|test|document)\b/i;
  const lowSignalPattern = /^(update|changes|wip|fix|misc|test)\s*$/i;
  const scopePattern = /\b(api|auth|schema|deploy|test|cache|worker|ui|state|perf)\b/i;

  let score = 25;
  if (length >= 18 && length <= 72) {
    score += 30;
  } else if (length >= 10) {
    score += 14;
  }

  if (imperativePattern.test(firstLine)) {
    score += 20;
  }

  if (scopePattern.test(firstLine)) {
    score += 20;
  }

  if (lowSignalPattern.test(firstLine)) {
    score -= 35;
  }

  return Math.round(clamp(score, 0, 100));
}

function buildRepositoryCorpus(repositories: Array<Pick<GitHubRepo, "full_name" | "description" | "topics" | "homepage" | "language">>) {
  return repositories
    .map((repo) =>
      [
        repo.full_name,
        repo.description ?? "",
        (repo.topics ?? []).join(" "),
        repo.homepage ?? "",
        repo.language ?? "",
      ]
        .join(" ")
        .toLowerCase(),
    )
    .join(" ");
}

function detectDeploymentTargets(corpus: string) {
  const targets: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["Vercel", /\bvercel\b/i],
    ["AWS", /\baws\b|\blambda\b|\becs\b|\bs3\b/i],
    ["GCP", /\bgcp\b|\bgoogle cloud\b|\bcloud run\b/i],
    ["Azure", /\bazure\b/i],
    ["Netlify", /\bnetlify\b/i],
    ["Docker", /\bdocker\b|\bcontainer\b/i],
    ["Kubernetes", /\bkubernetes\b|\bk8s\b|\bhelm\b/i],
  ];

  for (const [name, pattern] of checks) {
    if (pattern.test(corpus)) {
      targets.push(name);
    }
  }

  return targets;
}

type ProjectTypeDetection = {
  projectType: ProjectType;
  confidence: number;
  evidence: string[];
  domainInfo: DomainInfo;
};

type DomainSystemDesignSignals = {
  score: number;
  confidence: number;
  unclearReason?: string;
  hasAuthSystems: boolean;
  hasDbSchema: boolean;
  hasApis: boolean;
  modularityScore: number;
  concurrencyScore: number;
  lowLevelComplexityScore: number;
  performanceConsiderationsScore: number;
  libraryApiDesignScore: number;
  reusabilityScore: number;
  abstractionQualityScore: number;
  backendComplexityScore: number;
  frontendStateManagementComplexityScore: number;
  evidence: string[];
};

function languageShare(
  languageTotals: Map<string, number>,
  totalLanguageBytes: number,
  languageNames: string[],
) {
  const bytes = languageNames.reduce(
    (sum, language) => sum + (languageTotals.get(language) ?? 0),
    0,
  );

  return clamp(bytes / Math.max(1, totalLanguageBytes), 0, 1);
}

function scorePatternHits(corpus: string, patterns: RegExp[], hitValue: number, cap = 100) {
  const hits = patterns.filter((pattern) => pattern.test(corpus)).length;
  return Math.round(clamp(hits * hitValue, 0, cap));
}

function detectPrimaryProjectType(params: {
  fullCorpus: string;
  analyzedRepos: GitHubRepo[];
  languageTotals: Map<string, number>;
  totalLanguageBytes: number;
  sampledPaths: string[];
}): ProjectTypeDetection {
  const detection = detectRepositoryDomain({
    corpus: params.fullCorpus,
    repositoryCount: params.analyzedRepos.length,
    languageTotals: params.languageTotals,
    totalLanguageBytes: params.totalLanguageBytes,
    sampledPaths: params.sampledPaths,
  });

  return {
    projectType: domainToProjectType(detection.primary_domain),
    confidence: detection.domain_confidence,
    evidence: detection.evidence,
    domainInfo: {
      primary_domain: detection.primary_domain,
      domain_confidence: detection.domain_confidence,
      secondary_domains: detection.secondary_domains,
      is_multi_domain: detection.is_multi_domain,
    },
  };
}

function describeProjectType(projectType: ProjectType) {
  switch (projectType) {
    case "web-app":
      return "web app";
    case "backend-service":
      return "backend service";
    case "library":
      return "library";
    case "system-software":
      return "system software";
    case "cli-tool":
      return "CLI tool";
    case "ml-project":
      return "ML project";
    default:
      return "project";
  }
}

function projectTypeToDomain(projectType: ProjectType): RepositoryDomain {
  switch (projectType) {
    case "web-app":
      return "web_application";
    case "backend-service":
      return "backend_service";
    case "system-software":
      return "system_software";
    case "library":
      return "library_framework";
    case "cli-tool":
      return "cli_tool";
    case "ml-project":
      return "ai_ml_project";
    default:
      return "library_framework";
  }
}

function computeDomainSystemDesignSignals(params: {
  projectType: ProjectType;
  detectionConfidence: number;
  fullCorpus: string;
  readmeCoverage: number;
  avgRepoSizeKb: number;
  avgContributorCount: number;
}): DomainSystemDesignSignals {
  const { projectType, detectionConfidence, fullCorpus, readmeCoverage, avgRepoSizeKb, avgContributorCount } = params;

  const hasAuthSystems = containsAnyPattern(fullCorpus, [
    /\bauth\b/i,
    /\boauth\b/i,
    /\bjwt\b/i,
    /\bsession\b/i,
    /\bpermission\b/i,
  ]);
  const hasDbSchema = containsAnyPattern(fullCorpus, [
    /\bpostgres\b/i,
    /\bmysql\b/i,
    /\bmongodb\b/i,
    /\bprisma\b/i,
    /\bschema\b/i,
    /\bmigration\b/i,
  ]);
  const hasApis = containsAnyPattern(fullCorpus, [
    /\bapi\b/i,
    /\bgraphql\b/i,
    /\bendpoint\b/i,
    /\broute\b/i,
    /\bcontroller\b/i,
  ]);

  const backendComplexityScore = Math.round(
    clamp(
      (hasAuthSystems ? 22 : 0) +
        (hasDbSchema ? 26 : 0) +
        (hasApis ? 24 : 0) +
        (containsAnyPattern(fullCorpus, [/\bqueue\b/i, /\bworker\b/i, /\bcache\b/i, /\bwebhook\b/i]) ? 18 : 0) +
        (containsAnyPattern(fullCorpus, [/\bredis\b/i, /\bmessage bus\b/i, /\bevent\b/i]) ? 10 : 0),
      0,
      100,
    ),
  );
  const frontendStateManagementComplexityScore = Math.round(
    clamp(
      containsAnyPattern(fullCorpus, [/\bredux\b/i, /\bzustand\b/i, /\bxstate\b/i, /\bmobx\b/i])
        ? 74
        : containsAnyPattern(fullCorpus, [/\bcontext api\b/i, /\bcontext\b/i])
          ? 52
          : 32,
      0,
      100,
    ),
  );

  const modularityScore = scorePatternHits(
    fullCorpus,
    [/\bmodule\b/i, /\bpackage\b/i, /\binterface\b/i, /\blayer\b/i, /\badapter\b/i],
    20,
  );
  const concurrencyScore = scorePatternHits(
    fullCorpus,
    [/\bconcurrency\b/i, /\bthread\b/i, /\bmutex\b/i, /\bchannel\b/i, /\basync\b/i, /\bparallel\b/i],
    16,
  );
  const lowLevelComplexityScore = scorePatternHits(
    fullCorpus,
    [/\bpointer\b/i, /\bmemory\b/i, /\ballocator\b/i, /\bsyscall\b/i, /\bkernel\b/i, /\bunsafe\b/i],
    16,
  );
  const performanceConsiderationsScore = scorePatternHits(
    fullCorpus,
    [/\bbenchmark\b/i, /\bprofil\w*\b/i, /\blatency\b/i, /\bthroughput\b/i, /\bperf\b/i, /\boptimiz\w*\b/i],
    16,
  );

  const libraryApiDesignScore = scorePatternHits(
    fullCorpus,
    [/\bapi\b/i, /\btyped\b/i, /\bsemver\b/i, /\binterface\b/i, /\bgeneric\b/i, /\bpublic\b/i],
    16,
  );
  const reusabilityScore = scorePatternHits(
    fullCorpus,
    [/\breusable\b/i, /\bplugin\b/i, /\bconfigurable\b/i, /\bextensible\b/i, /\bnpm\b/i, /\bcrate\b/i],
    16,
  );
  const abstractionQualityScore = scorePatternHits(
    fullCorpus,
    [/\babstraction\b/i, /\binterface\b/i, /\btrait\b/i, /\badapter\b/i, /\bencapsulat\w*\b/i],
    18,
  );

  const complexitySignal = Math.round(
    clamp(
      clamp(avgRepoSizeKb / 2800, 0, 1) * 60 + clamp(avgContributorCount / 12, 0, 1) * 40,
      0,
      100,
    ),
  );

  let score = 0;
  const scoreConfidence = roundToTenth(
    clamp(0.48 + detectionConfidence * 0.24 + readmeCoverage * 0.18, 0.3, 0.95),
  );
  let unclearReason: string | undefined;

  if (projectType === "web-app") {
    score = Math.round(
      clamp(
        (hasAuthSystems ? 24 : 4) +
          (hasDbSchema ? 26 : 4) +
          (hasApis ? 24 : 6) +
          backendComplexityScore * 0.16 +
          frontendStateManagementComplexityScore * 0.1,
        0,
        100,
      ),
    );
  } else if (projectType === "system-software") {
    score = Math.round(
      clamp(
        modularityScore * 0.26 +
          concurrencyScore * 0.22 +
          lowLevelComplexityScore * 0.24 +
          performanceConsiderationsScore * 0.16 +
          complexitySignal * 0.12,
        0,
        100,
      ),
    );
  } else if (projectType === "library") {
    score = Math.round(
      clamp(
        libraryApiDesignScore * 0.4 +
          reusabilityScore * 0.3 +
          abstractionQualityScore * 0.2 +
          complexitySignal * 0.1,
        0,
        100,
      ),
    );
  } else if (projectType === "cli-tool") {
    const commandStructureScore = scorePatternHits(
      fullCorpus,
      [/\bcommand\b/i, /\bflags?\b/i, /\bsubcommand\b/i, /\barg\w*\b/i, /\bterminal\b/i],
      18,
    );
    score = Math.round(
      clamp(
        commandStructureScore * 0.38 +
          modularityScore * 0.22 +
          performanceConsiderationsScore * 0.18 +
          abstractionQualityScore * 0.12 +
          complexitySignal * 0.1,
        0,
        100,
      ),
    );
  } else {
    const reproducibilityScore = scorePatternHits(
      fullCorpus,
      [/\breproduc\w*\b/i, /\bseed\b/i, /\bevaluation\b/i, /\bmetric\b/i, /\bexperiment\b/i],
      18,
    );
    score = Math.round(
      clamp(
        reproducibilityScore * 0.32 +
          libraryApiDesignScore * 0.2 +
          modularityScore * 0.18 +
          performanceConsiderationsScore * 0.12 +
          complexitySignal * 0.18,
        0,
        100,
      ),
    );
  }

  if (scoreConfidence < 0.58) {
    unclearReason = `System design unclear due to ${describeProjectType(projectType)} architecture evidence density.`;
  }

  return {
    score,
    confidence: scoreConfidence,
    unclearReason,
    hasAuthSystems,
    hasDbSchema,
    hasApis,
    modularityScore,
    concurrencyScore,
    lowLevelComplexityScore,
    performanceConsiderationsScore,
    libraryApiDesignScore,
    reusabilityScore,
    abstractionQualityScore,
    backendComplexityScore,
    frontendStateManagementComplexityScore,
    evidence: [
      `Domain: ${describeProjectType(projectType)} (classifier confidence ${Math.round(detectionConfidence * 100)}%)`,
      `Complexity signal from repo size/contributors: ${complexitySignal}/100`,
      unclearReason ?? `System design evidence confidence: ${Math.round(scoreConfidence * 100)}%`,
    ],
  };
}

function detectTutorialCloneRisk(repositories: GitHubRepo[], enrichedRepos: EnrichedRepository[]) {
  const tutorialPattern =
    /(tutorial|course|bootcamp|clone|todo|weather-app|portfolio|netflix|spotify|youtube|airbnb|amazon|twitter|instagram)/i;
  const cloneNamedRepos = repositories.filter((repo) => tutorialPattern.test(repo.full_name));
  const shallowQualityRepos = enrichedRepos.filter(
    (repo) => repo.quality < 7.1 && repo.commits < 15,
  ).length;
  const lowReadmeRepos = enrichedRepos.filter((repo) => !repo.hasReadme).length;

  const riskScore = Math.round(
    clamp(
      (cloneNamedRepos.length / Math.max(1, repositories.length)) * 50 +
        (shallowQualityRepos / Math.max(1, enrichedRepos.length)) * 30 +
        (lowReadmeRepos / Math.max(1, enrichedRepos.length)) * 20,
      0,
      100,
    ),
  );

  const verdict: "low-risk" | "medium-risk" | "high-risk" =
    riskScore >= 70 ? "high-risk" : riskScore >= 40 ? "medium-risk" : "low-risk";
  const signals = [
    cloneNamedRepos.length > 0 ? "tutorial-clone-naming" : "",
    shallowQualityRepos >= 2 ? "shallow-repo-depth" : "",
    lowReadmeRepos >= Math.ceil(enrichedRepos.length / 2) ? "weak-documentation-proof" : "",
  ].filter(Boolean);

  return {
    riskScore,
    verdict,
    signals,
    evidence: [
      `${cloneNamedRepos.length} repositories match tutorial/clone naming patterns`,
      `${shallowQualityRepos} repositories are shallow (quality < 7.1 and < 15 commits)`,
      `${lowReadmeRepos} repositories lack substantial README coverage`,
    ],
  };
}

function toDateFilter(days: number) {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function detectArchetype(
  scoreComponents: {
    depth: number;
    systemDesign: number;
    execution: number;
    consistency: number;
    impact: number;
  },
  skills: Array<{ label: string; value: number }>,
) {
  const frontendSkill = skills.find((entry) => entry.label === "Frontend")?.value ?? 0;
  const backendSkill = skills.find((entry) => entry.label === "Backend")?.value ?? 0;

  if (scoreComponents.depth >= 75 && scoreComponents.consistency >= 65) {
    return "Quality-Focused Builder";
  }

  if (scoreComponents.consistency >= 78) {
    return "Consistency Grinder";
  }

  if (scoreComponents.impact >= 68) {
    return "Open Source Explorer";
  }

  if (
    frontendSkill >= 65 &&
    backendSkill >= 60 &&
    scoreComponents.systemDesign >= 65
  ) {
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
      const repoKey = normalizeRepoKey(repo.full_name);
      const [languages, readme, commitCount, contributorCount] = await Promise.all([
        requestGitHubOptional<Record<string, number>>(repo.languages_url, apiKey),
        requestGitHubOptional<GitHubReadme>(`/repos/${repo.full_name}/readme`, apiKey),
        requestRepositoryCommitCount(repo.full_name, user.login, apiKey).catch(
          () => recentCommitsByRepo.get(repoKey) ?? 0,
        ),
        requestRepositoryContributorCount(repo.full_name, apiKey).catch(() => 0),
      ]);

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
        contributors: contributorCount,
        sizeKb: repo.size,
        primaryLanguage: stack[0] ?? repo.language ?? "Unspecified",
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
  const scorableFeaturedRepos = featuredRepos.filter(
    (repo) => repo.size >= minScorableRepoSizeKb,
  );
  const ignoredTinyRepos = analyzedRepos.filter(
    (repo) => repo.size < minScorableRepoSizeKb,
  ).length;

  const readmeByRepoName = new Map(
    enrichedRepos.map((repo) => [repo.name.toLowerCase(), repo.hasReadme] as const),
  );

  const reposWithReadme = scorableFeaturedRepos.filter(
    (repo) => readmeByRepoName.get(repo.full_name.toLowerCase()) === true,
  ).length;
  const meaningfulLanguageCount = countMeaningfulLanguages(languageTotals);
  const frameworkCount = detectFrameworkCount(analyzedRepos);

  const totalLanguageBytes =
    Array.from(languageTotals.values()).reduce((sum, value) => sum + value, 0) || 1;

  const commitListsByRepo = await Promise.all(
    featuredRepos.slice(0, COMMIT_SAMPLE_REPO_LIMIT).map(async (repo) => ({
      repoName: repo.full_name,
      commits: await requestRecentCommitsForRepo(repo.full_name, user.login, apiKey),
    })),
  );

  const commitSample = commitListsByRepo
    .flatMap((entry) =>
      entry.commits.map((commit) => ({
        repoName: entry.repoName,
        sha: commit.sha,
        message: commit.commit?.message ?? "",
      })),
    )
    .slice(0, COMMIT_DETAIL_LIMIT);

  const commitDetailResults = await Promise.all(
    commitSample.map(async (entry) => ({
      repoName: entry.repoName,
      message: entry.message,
      detail: await requestCommitDetail(entry.repoName, entry.sha, apiKey),
    })),
  );

  const commitDetails = commitDetailResults
    .map((entry) => ({
      repoName: entry.repoName,
      message: entry.message,
      files: entry.detail?.files ?? [],
    }))
    .filter((entry) => entry.files.length > 0 || entry.message.length > 0);

  const multiFileCommits = commitDetails.filter((entry) => entry.files.length >= 2).length;
  const multiFileCommitRatio = multiFileCommits / Math.max(1, commitDetails.length);
  const avgLinesChangedPerCommit = average(
    commitDetails.map((entry) =>
      entry.files.reduce((sum, file) => sum + Number(file.changes ?? 0), 0),
    ),
  );
  const commitMessageQualityScore = Math.round(
    average(commitDetails.map((entry) => scoreCommitMessageQuality(entry.message))),
  );
  const refactorCommits = commitDetails.filter((entry) => /\brefactor|cleanup|restructure\b/i.test(entry.message)).length;
  const featureCommits = commitDetails.filter((entry) => /\badd|implement|build|create|feature\b/i.test(entry.message)).length;
  const refactorToFeatureRatio = refactorCommits / Math.max(1, featureCommits);

  const legacyDepthScore = Math.round(
    clamp(
      multiFileCommitRatio * 35 +
        clamp(avgLinesChangedPerCommit / 220, 0, 1) * 25 +
        (Number.isFinite(commitMessageQualityScore) ? commitMessageQualityScore : 0) * 0.25 +
        clamp(refactorToFeatureRatio, 0, 1) * 15 +
        clamp(reposWithReadme / Math.max(1, scorableFeaturedRepos.length), 0, 1) * 10,
      0,
      100,
    ),
  );

  const repositoryCorpus = buildRepositoryCorpus(analyzedRepos);
  const enrichedCorpus = enrichedRepos
    .map((repo) => [repo.name, repo.readme, repo.recommendation, repo.note, ...repo.stack].join(" "))
    .join(" ")
    .toLowerCase();
  const fullCorpus = `${repositoryCorpus} ${enrichedCorpus}`;
  const averageRepoSizeKb =
    enrichedRepos.reduce((sum, repo) => sum + repo.sizeKb, 0) /
    Math.max(1, enrichedRepos.length);
  const averageContributorCount =
    enrichedRepos.reduce((sum, repo) => sum + repo.contributors, 0) /
    Math.max(1, enrichedRepos.length);
  const sampledPaths = commitDetails.flatMap((entry) =>
    entry.files.map((file) => file.filename ?? ""),
  );

  const projectTypeDetection = detectPrimaryProjectType({
    fullCorpus,
    analyzedRepos,
    languageTotals,
    totalLanguageBytes,
    sampledPaths,
  });

  const domainSystemDesignSignals = computeDomainSystemDesignSignals({
    projectType: projectTypeDetection.projectType,
    detectionConfidence: projectTypeDetection.confidence,
    fullCorpus,
    readmeCoverage,
    avgRepoSizeKb: averageRepoSizeKb,
    avgContributorCount: averageContributorCount,
  });

  const engineeringWeights = resolveEngineeringWeights(projectTypeDetection.projectType, {
    lowLevelLanguageShare: languageShare(languageTotals, totalLanguageBytes, [
      "C",
      "C++",
      "Rust",
      "Assembly",
      "Zig",
    ]),
  });

  const deploymentTargets = detectDeploymentTargets(fullCorpus);
  const deploymentDetected = deploymentTargets.length > 0;
  const ciCdPresent = containsAnyPattern(fullCorpus, [
    /\bgithub actions\b/i,
    /\bworkflow\b/i,
    /\bci\b/i,
    /\bcd\b/i,
    /\bpipeline\b/i,
  ]);
  const testingPatternHits = [
    /\btest\b/i,
    /\bvitest\b/i,
    /\bjest\b/i,
    /\bplaywright\b/i,
    /\bcypress\b/i,
    /\bcoverage\b/i,
  ].filter((pattern) => pattern.test(fullCorpus)).length;
  const testCoverageIndicators = Math.round(clamp((testingPatternHits / 6) * 100, 0, 100));
  const legacyExecutionScore = Math.round(
    clamp(
      (deploymentDetected ? 34 : 10) +
        (ciCdPresent ? 28 : 8) +
        testCoverageIndicators * 0.28 +
        clamp((activityWindowStats.externalContributions / 6) * 10, 0, 10),
      1,
      100,
    ),
  );

  const commitFrequencyVariance = roundToTenth(
    stdDev(monthlyRaw) / Math.max(1, average(monthlyRaw)),
  );
  const projectCompletionRate = roundToTenth(
    clamp(
      readmeCoverage * 0.5 +
        recentCoverage * 0.2 +
        clamp(averageQuality(enrichedRepos.map((repo) => repo.quality)) / 100, 0, 1) * 0.3,
      0,
      1,
    ),
  );
  const repoAbandonmentRate = roundToTenth(
    analyzedRepos.filter((repo) => daysSince(repo.pushed_at) > 180).length /
      Math.max(1, analyzedRepos.length),
  );
  const consistencyScore = Math.round(
    clamp(
      (1 - clamp(commitFrequencyVariance / 1.2, 0, 1)) * 36 +
        projectCompletionRate * 42 +
        (1 - repoAbandonmentRate) * 22,
      1,
      100,
    ),
  );

  const evolution = analyzeEvolution({
    monthlyCommits: monthlyRaw,
    readmeCoverage,
    recentCoverage,
    avgContributorCount: averageContributorCount,
    commitMessageQualityScore,
    featureCommits,
  });

  const totalForks = sortedRepos.reduce((sum, repo) => sum + repo.forks_count, 0);
  const legacyImpactScore = Math.round(
    clamp(
      clamp(totalStars / 400, 0, 1) * 35 +
        clamp(totalForks / 120, 0, 1) * 20 +
        clamp(user.followers / 220, 0, 1) * 25 +
        clamp(activityWindowStats.externalContributions / 14, 0, 1) * 20,
      1,
      100,
    ),
  );

  const hasModularitySignals = containsAnyPattern(fullCorpus, [
    /\bmodule\b/i,
    /\bpackage\b/i,
    /\binterface\b/i,
    /\blayer\b/i,
    /\badapter\b/i,
  ]);
  const hasConcurrencySignals = containsAnyPattern(fullCorpus, [
    /\bconcurrency\b/i,
    /\bthread\b/i,
    /\bmutex\b/i,
    /\bchannel\b/i,
    /\basync\b/i,
    /\bparallel\b/i,
  ]);
  const hasPerformanceSignals = containsAnyPattern(fullCorpus, [
    /\bbenchmark\b/i,
    /\bprofil\w*\b/i,
    /\blatency\b/i,
    /\bthroughput\b/i,
    /\bperf\b/i,
    /\boptimiz\w*\b/i,
  ]);
  const hasLibraryApiSignals = containsAnyPattern(fullCorpus, [
    /\bapi\b/i,
    /\btyped\b/i,
    /\binterface\b/i,
    /\bgeneric\b/i,
    /\bpublic\b/i,
  ]);
  const hasReusabilitySignals = containsAnyPattern(fullCorpus, [
    /\breusable\b/i,
    /\bplugin\b/i,
    /\bconfigurable\b/i,
    /\bextensible\b/i,
  ]);
  const hasCliSignals = containsAnyPattern(fullCorpus, [
    /\bcli\b/i,
    /\bcommand line\b/i,
    /\bterminal\b/i,
    /\bsubcommand\b/i,
    /\bflags?\b/i,
  ]);
  const hasMlSignals = containsAnyPattern(fullCorpus, [
    /\bmachine learning\b/i,
    /\bdeep learning\b/i,
    /\btraining\b/i,
    /\binference\b/i,
    /\bdataset\b/i,
    /\bpytorch\b/i,
    /\btensorflow\b/i,
  ]);

  const lowLevelLanguageShare = languageShare(languageTotals, totalLanguageBytes, [
    "C",
    "C++",
    "Rust",
    "Assembly",
    "Zig",
  ]);
  const webLanguageShare = languageShare(languageTotals, totalLanguageBytes, [
    "TypeScript",
    "JavaScript",
    "HTML",
    "CSS",
  ]);
  const backendLanguageShare = languageShare(languageTotals, totalLanguageBytes, [
    "Go",
    "Rust",
    "Java",
    "Python",
    "Ruby",
    "PHP",
    "C#",
    "Kotlin",
  ]);
  const mlLanguageShare = languageShare(languageTotals, totalLanguageBytes, [
    "Python",
    "Jupyter Notebook",
    "R",
    "Julia",
  ]);
  const contributorBase = Math.round(
    enrichedRepos.reduce((sum, repo) => sum + repo.contributors, 0),
  );

  const domainScorecard = buildDomainScorecard({
    domain: projectTypeToDomain(projectTypeDetection.projectType),
    domainConfidence: projectTypeDetection.confidence,
    lowLevelLanguageShare,
    webLanguageShare,
    backendLanguageShare,
    mlLanguageShare,
    readmeCoverage,
    avgRepoSizeKb: averageRepoSizeKb,
    avgContributorCount: averageContributorCount,
    totalStars,
    totalForks,
    contributorBase,
    multiFileCommitRatio,
    avgLinesChangedPerCommit,
    commitMessageQualityScore,
    externalContributions: activityWindowStats.externalContributions,
    deploymentDetected,
    ciCdPresent,
    testCoverageIndicators,
    hasAuthSystems: domainSystemDesignSignals.hasAuthSystems,
    hasDbSchema: domainSystemDesignSignals.hasDbSchema,
    hasApis: domainSystemDesignSignals.hasApis,
    hasModularitySignals,
    hasConcurrencySignals,
    hasPerformanceSignals,
    hasLibraryApiSignals,
    hasReusabilitySignals,
    hasCliSignals,
    hasMlSignals,
  });

  const depthScore = resolveMetricScore(domainScorecard.depth, legacyDepthScore);
  const systemDesignScore = resolveMetricScore(
    domainScorecard.system_design,
    domainSystemDesignSignals.score,
  );
  const executionScore = resolveMetricScore(domainScorecard.execution, legacyExecutionScore);
  const impactScore = resolveMetricScore(domainScorecard.impact, legacyImpactScore);

  const domainSystemDesign = {
    ...domainSystemDesignSignals,
    score: systemDesignScore,
    confidence: domainScorecard.system_design.confidence,
    unclearReason: domainScorecard.system_design.insufficient_evidence
      ? "System design marked as insufficient evidence for this domain."
      : domainSystemDesignSignals.unclearReason,
    evidence: [
      ...projectTypeDetection.evidence,
      ...domainSystemDesignSignals.evidence,
      domainScorecard.system_design.notes,
    ],
  };

  const engineeringScore = computeEngineeringScore({
    depth: depthScore,
    systemDesign: systemDesignScore,
    execution: executionScore,
    consistency: consistencyScore,
    impact: impactScore,
  }, engineeringWeights);

  const previousComponentSnapshot = {
    depth: Math.round(clamp(depthScore - clamp((commitMessageQualityScore - 55) / 3, -12, 12), 0, 100)),
    systemDesign: Math.round(
      clamp(domainSystemDesign.score - (domainSystemDesign.hasDbSchema ? 4 : 0), 0, 100),
    ),
    execution: Math.round(clamp(executionScore - (deploymentDetected ? 6 : 0), 0, 100)),
    consistency: Math.round(
      clamp(
        consistencyScore -
          clamp(
            ((average(monthlyRaw.slice(-2)) - average(monthlyRaw.slice(0, 2))) /
              Math.max(1, maxMonthlyRaw)) *
              20,
            -12,
            12,
          ),
        0,
        100,
      ),
    ),
    impact: Math.round(clamp(impactScore - clamp(activityWindowStats.externalContributions, 0, 8), 0, 100)),
  };
  const previousEngineeringScore = computeEngineeringScore(
    previousComponentSnapshot,
    engineeringWeights,
  );
  const scoreChange = explainEngineeringScoreChange(
    previousEngineeringScore.finalScore,
    engineeringScore.finalScore,
    previousEngineeringScore.components,
    engineeringScore.components,
  );

  const breakdown = [
    {
      label: "Depth",
      value: engineeringScore.components.depth,
      note: `${domainScorecard.depth.notes}. Multi-file commit ratio ${normalizePercentage(multiFileCommitRatio)}%, average ${Math.round(avgLinesChangedPerCommit)} lines/commit, message quality ${commitMessageQualityScore}/100, and ${pullRequestCount} PRs + ${issueCount} issues in 90 days.`,
    },
    {
      label: "System design",
      value: engineeringScore.components.systemDesign,
      note: domainSystemDesign.unclearReason
        ? `${domainSystemDesign.unclearReason} Domain: ${describeProjectType(projectTypeDetection.projectType)}. ${domainScorecard.system_design.notes}`
        : `${domainScorecard.system_design.notes}. ${projectTypeDetection.projectType === "web-app"
            ? `${domainSystemDesign.hasAuthSystems ? "Auth" : "No auth"}, ${domainSystemDesign.hasDbSchema ? "DB/schema" : "No DB/schema"}, ${domainSystemDesign.hasApis ? "API" : "No API"} signals.`
            : projectTypeDetection.projectType === "system-software"
              ? `Modularity ${domainSystemDesign.modularityScore}/100, concurrency ${domainSystemDesign.concurrencyScore}/100, low-level complexity ${domainSystemDesign.lowLevelComplexityScore}/100, performance ${domainSystemDesign.performanceConsiderationsScore}/100.`
              : projectTypeDetection.projectType === "library"
                ? `API design ${domainSystemDesign.libraryApiDesignScore}/100, reusability ${domainSystemDesign.reusabilityScore}/100, abstraction quality ${domainSystemDesign.abstractionQualityScore}/100.`
                : `Domain-aware system-design assessment for ${describeProjectType(projectTypeDetection.projectType)} repositories.`}`,
    },
    {
      label: "Execution",
      value: engineeringScore.components.execution,
      note: `${domainScorecard.execution.notes}. ${deploymentDetected ? `Deployment targets: ${deploymentTargets.join(", ")}` : "No deployment target detected"}; CI/CD ${ciCdPresent ? "present" : "missing"}; test indicators ${testCoverageIndicators}/100.`,
    },
    {
      label: "Consistency",
      value: engineeringScore.components.consistency,
      note: `Commit frequency variance ${commitFrequencyVariance}, completion rate ${normalizePercentage(projectCompletionRate)}, abandonment rate ${normalizePercentage(repoAbandonmentRate)}.`,
    },
    {
      label: "Impact",
      value: engineeringScore.components.impact,
      note: `${domainScorecard.impact.notes}. ${totalStars} stars, ${totalForks} forks, ${user.followers} followers, and ${activityWindowStats.externalContributions} external contributions.`,
    },
  ];

  const breakdownByScore = [...breakdown].sort((first, second) => second.value - first.value);
  const strongestMetric = breakdownByScore[0] ?? breakdown[0];
  const weakestMetric =
    breakdownByScore[breakdownByScore.length - 1] ?? breakdown[breakdown.length - 1];

  const score = engineeringScore.finalScore;
  const confidence = roundToTenth(
    clamp(
      0.34 +
        clamp(analyzedRepos.length / 12, 0, 1) * 0.2 +
        readmeCoverage * 0.1 +
        recentCoverage * 0.1 +
        clamp(activityWindowStats.activeDays / DAYS_IN_SCORING_WINDOW, 0, 1) * 0.16 +
        clamp(commitDetails.length / 20, 0, 1) * 0.08 +
        domainSystemDesign.confidence * 0.08 +
        projectTypeDetection.confidence * 0.06 -
        clamp(ignoredTinyRepos / Math.max(1, analyzedRepos.length), 0, 0.2),
      0.25,
      0.95,
    ),
  );
  const domainInfo = projectTypeDetection.domainInfo;
  const insights = buildInsights(domainInfo, domainScorecard, evolution);
  const recommendations = buildRecommendations(domainInfo, domainScorecard);
  const confidenceSummary = buildConfidenceSummary(domainInfo, domainScorecard);

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

  const archetype = detectArchetype(engineeringScore.components, skills);

  const earlySkills = Object.entries(CATEGORY_LANGUAGES).map(([label, langs]) => {
    const earlyBytes = langs.reduce((sum, language) => {
      const bytes = enrichedRepos
        .filter((repo) => daysSince(analyzedRepos.find((entry) => entry.full_name === repo.name)?.pushed_at ?? new Date().toISOString()) > 120)
        .reduce((repoSum, repo) => {
          const languageEntry = repo.languageEntries.find(([lang]) => lang === language);
          return repoSum + (languageEntry?.[1] ?? 0);
        }, 0);
      return sum + bytes;
    }, 0);

    const share = earlyBytes / totalLanguageBytes;
    return {
      label,
      value: Math.round(clamp(share * 120, 15, 90)),
    };
  });

  const skillEvolution = skills.slice(0, 4).map((skill) => ({
    label: skill.label,
    before: earlySkills.find((entry) => entry.label === skill.label)?.value ?? skill.value,
    current: skill.value,
  }));

  const scoreOverTime = monthlyWindow.slice(-3).map((month, index, list) => {
    const monthIndex = monthlyWindow.length - list.length + index;
    const activityShare = maxMonthlyRaw > 0 ? monthlyRaw[monthIndex] / maxMonthlyRaw : 0.5;
    const monthScore = Math.round(clamp(score * 0.82 + activityShare * 18, 0, 100));
    return {
      label: month.label,
      score: monthScore,
    };
  });

  const commitQualityOverTime = monthlyWindow.slice(-3).map((month, index, list) => {
    const monthIndex = monthlyWindow.length - list.length + index;
    const activityShare = maxMonthlyRaw > 0 ? monthlyRaw[monthIndex] / maxMonthlyRaw : 0.5;
    const monthQuality = Math.round(
      clamp(commitMessageQualityScore * 0.75 + activityShare * 25, 0, 100),
    );
    return {
      label: month.label,
      score: monthQuality,
    };
  });

  const developerSignals = {
    depth: {
      score: engineeringScore.components.depth,
      multiFileCommitRatio: roundToTenth(multiFileCommitRatio),
      avgLinesChangedPerCommit: roundToTenth(avgLinesChangedPerCommit),
      commitMessageQualityScore,
      refactorToFeatureRatio: roundToTenth(refactorToFeatureRatio),
      evidence: [
        `${multiFileCommits}/${Math.max(1, commitDetails.length)} sampled commits touch multiple files`,
        `Average lines changed per sampled commit: ${Math.round(avgLinesChangedPerCommit)}`,
        `Commit message quality score: ${commitMessageQualityScore}/100`,
      ],
    },
    systemDesign: {
      score: engineeringScore.components.systemDesign,
      projectType: projectTypeDetection.projectType,
      detectionConfidence: projectTypeDetection.confidence,
      scoreConfidence: domainSystemDesign.confidence,
      unclearReason: domainSystemDesign.unclearReason,
      hasAuthSystems: domainSystemDesign.hasAuthSystems,
      hasDbSchema: domainSystemDesign.hasDbSchema,
      hasApis: domainSystemDesign.hasApis,
      modularityScore: domainSystemDesign.modularityScore,
      concurrencyScore: domainSystemDesign.concurrencyScore,
      lowLevelComplexityScore: domainSystemDesign.lowLevelComplexityScore,
      performanceConsiderationsScore: domainSystemDesign.performanceConsiderationsScore,
      libraryApiDesignScore: domainSystemDesign.libraryApiDesignScore,
      reusabilityScore: domainSystemDesign.reusabilityScore,
      abstractionQualityScore: domainSystemDesign.abstractionQualityScore,
      backendComplexityScore: domainSystemDesign.backendComplexityScore,
      frontendStateManagementComplexityScore:
        domainSystemDesign.frontendStateManagementComplexityScore,
      evidence: [
        ...projectTypeDetection.evidence,
        ...domainSystemDesign.evidence,
      ],
    },
    execution: {
      score: engineeringScore.components.execution,
      deploymentDetected,
      deploymentTargets,
      ciCdPresent,
      testCoverageIndicators,
      evidence: [
        deploymentDetected
          ? `Deployment targets detected: ${deploymentTargets.join(", ")}`
          : "No deployment target detected",
        `CI/CD ${ciCdPresent ? "signals found" : "signals not found"}`,
        `Test/coverage indicator score: ${testCoverageIndicators}/100`,
      ],
    },
    consistency: {
      score: engineeringScore.components.consistency,
      commitFrequencyVariance,
      projectCompletionRate: roundToTenth(projectCompletionRate),
      repoAbandonmentRate: roundToTenth(repoAbandonmentRate),
      evidence: [
        `Commit frequency variance: ${commitFrequencyVariance}`,
        `Project completion rate: ${normalizePercentage(projectCompletionRate)}%`,
        `Repo abandonment rate: ${normalizePercentage(repoAbandonmentRate)}%`,
      ],
    },
    impact: {
      score: engineeringScore.components.impact,
      totalStars,
      totalForks,
      followers: user.followers,
      externalContributions: activityWindowStats.externalContributions,
      evidence: [
        `${totalStars} stars across analyzed repos`,
        `${totalForks} forks across analyzed repos`,
        `${activityWindowStats.externalContributions} external contribution signals in 90 days`,
      ],
    },
  };

  const fakeDevDetector = detectTutorialCloneRisk(analyzedRepos, enrichedRepos);

  const evidenceFindings = [
    {
      category: "weakness" as const,
      claim: "Lack of backend depth",
      evidence: [
        `${domainSystemDesign.hasDbSchema ? "DB usage detected" : "0 repos with clear database schema usage"}`,
        `${domainSystemDesign.hasApis ? "API routes detected" : "No API routes detected in repository corpus"}`,
        `Domain system complexity score: ${engineeringScore.components.systemDesign}/100`,
      ],
    },
    {
      category: "risk" as const,
      claim: "Potential shallow portfolio risk",
      evidence: fakeDevDetector.evidence,
    },
    {
      category: "strength" as const,
      claim: "Consistent contribution behavior",
      evidence: [
        `${activityWindowStats.activeDays} active days in last 90 days`,
        `Longest streak: ${activityWindowStats.longestStreak} days`,
        `Consistency score: ${engineeringScore.components.consistency}/100`,
      ],
    },
  ];

  const strengths = [
    `Strength: ${strongestMetric.label} is currently strongest at ${strongestMetric.value}/100.`,
    `${user.login} has ${activityWindowStats.activeDays} active days in the last 90 days across ${user.public_repos} public repositories.`,
    `${toPercent(readmeCoverage)}% README coverage across featured repositories supports reviewer trust and maintainability perception.`,
  ];

  const weaknesses = [
    `Weakness: ${weakestMetric.label} is currently the lowest signal at ${weakestMetric.value}/100.`,
    ignoredTinyRepos > 0
      ? `${ignoredTinyRepos} small repositories were excluded from scoring to reduce gaming by low-signal projects.`
      : "No repositories were excluded by anti-gaming size filters.",
    activityWindowStats.spamCommitsSuppressed > 0
      ? `${activityWindowStats.spamCommitsSuppressed} same-minute commit units were discounted to avoid burst-spam inflation.`
      : "No commit-burst spam signals were detected in the 90-day activity window.",
  ];

  const suggestions = [
    `Raise ${weakestMetric.label} by closing evidence gaps listed in its score note.`,
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
        ? `High-signal portfolio with strong momentum: ${activityWindowStats.activeDays} active days in the last 90, ${meaningfulLanguageCount} meaningful languages, and ${frameworkCount} frameworks.`
        : `Useful baseline signal with clear upside in ${weakestMetric.label.toLowerCase()} and open-source visibility.`,
    summary:
      `${user.login} scored ${score}/100 from a deterministic weighted model (${describeProjectType(projectTypeDetection.projectType)} profile: Depth ${roundToTenth(engineeringScore.weights.depth)}, System design ${roundToTenth(engineeringScore.weights.systemDesign)}, Execution ${roundToTenth(engineeringScore.weights.execution)}, Consistency ${roundToTenth(engineeringScore.weights.consistency)}, Impact ${roundToTenth(engineeringScore.weights.impact)}). Strongest signal: ${strongestMetric?.label ?? "Depth"}. Lowest signal: ${weakestMetric?.label ?? "Impact"}. ${domainInfo.domain_confidence < 0.5 ? "Domain classification is uncertain; treat inferred signals as directional." : "Domain classification confidence is stable."}`,
    highlights: [
      `Analyzed ${analyzedRepos.length} top repositories and ${events.length} recent public events.`,
      `Score change vs previous window: ${scoreChange.scoreDelta >= 0 ? "+" : ""}${scoreChange.scoreDelta}. ${scoreChange.reasons[0]}.`,
      domainInfo.is_multi_domain
        ? `Multi-domain profile: ${domainInfo.primary_domain} with secondary domains ${domainInfo.secondary_domains.join(", ")}.`
        : `Primary domain: ${domainInfo.primary_domain}.`,
      domainSystemDesign.unclearReason
        ? domainSystemDesign.unclearReason
        : `System design confidence: ${Math.round(domainSystemDesign.confidence * 100)}% for ${describeProjectType(projectTypeDetection.projectType)} scoring.`,
      confidenceSummary,
      `Fake Dev Detector risk: ${fakeDevDetector.verdict} (${fakeDevDetector.riskScore}/100).`,
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
    domain_info: domainInfo,
    scorecard: domainScorecard,
    evolution,
    project_maturity_score: evolution.project_maturity_score,
    evolution_trend: evolution.evolution_trend,
    insights,
    recommendations,
    metadata: {
      confidence_summary: confidenceSummary,
      project_maturity_score: evolution.project_maturity_score,
      evolution_trend: evolution.evolution_trend,
    },
    developerSignals,
    domainScorecard,
    evidenceFindings,
    fakeDevDetector,
    scoreTrajectory: {
      scoreOverTime,
      commitQualityOverTime,
      skillEvolution,
    },
    scoreMeta: {
      archetype,
      averageDeveloperScore: 56,
      scoreModel: {
        projectType: projectTypeDetection.projectType,
        classificationConfidence: projectTypeDetection.confidence,
        domain: domainScorecard.domain,
        weights: engineeringScore.weights,
        components: engineeringScore.components,
        previousScore: previousEngineeringScore.finalScore,
        scoreDelta: scoreChange.scoreDelta,
        changeReasons: scoreChange.reasons,
      },
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
