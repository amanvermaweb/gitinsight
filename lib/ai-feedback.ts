import { GoogleGenAI } from "@google/genai";
import type { AnalysisData } from "@/lib/types";
import { clamp, roundToTenth } from "@/lib/utils";

type AiQualitativeFeedback = Pick<
  AnalysisData,
  "summary" | "strengths" | "weaknesses" | "suggestions"
>;

export type AiFeedback = AiQualitativeFeedback &
  Pick<AnalysisData, "score" | "confidence">;

export type ScoringFlags = {
  hasCloneProjects: boolean;
  frontendHeavy: boolean;
  hasBackend: boolean;
  hasDevOps: boolean;
  shallowCommits: boolean;
  hasRealWorldUsage: boolean;
  poorDocumentation: boolean;
};

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_AI_TIMEOUT_MS = 12_000;
const DEFAULT_SUMMARY =
  "Evidence is limited, architecture depth is unclear, and hiring risk remains high without stronger operational proof.";

const SCORING = {
  penalties: {
    clonePerProject: 1.5,
    cloneMax: 3,
    frontendHeavy: 2,
    shallow: 1,
    noBackend: 2,
    noCICD: 1,
    poorDocs: 1,
  },
  bonuses: {
    backend: 1.5,
    complexity: 1,
    consistency: 1,
    realWorld: 1.5,
  },
  weights: {
    baselineModel: 0.55,
    baselineRepo: 0.45,
    top1: 0.4,
    top3Total: 0.7,
    remaining: 0.3,
  },
  thresholds: {
    shallowAvgCommits: 20,
    shallowReposAnalyzed: 3,
    strongBackendSkill: 55,
    frontendDominanceGap: 20,
    poorDocsRatio: 0.5,
    nonTrivialRepoQuality: 7,
    nonTrivialRepoCommits: 20,
  },
} as const;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);

  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function getAiTimeoutMs() {
  return parsePositiveIntegerEnv("ANALYZE_AI_TIMEOUT_MS", DEFAULT_AI_TIMEOUT_MS);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("AI request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function normalizeText(value: unknown, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || fallback;
}

function normalizeList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const cleaned = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .slice(0, 5);

  return cleaned.length >= 3 ? cleaned : fallback;
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function metricValue(analysis: AnalysisData, label: string) {
  return (
    analysis.breakdown.find((metric) => metric.label.toLowerCase() === label.toLowerCase())
      ?.value ?? analysis.score
  );
}

function skillValue(analysis: AnalysisData, label: string) {
  return (
    analysis.skills.find((skill) => skill.label.toLowerCase() === label.toLowerCase())
      ?.value ?? 0
  );
}

function averageRepoCommits(analysis: AnalysisData) {
  return (
    analysis.repositories.reduce((sum, repo) => sum + repo.commits, 0) /
    Math.max(1, analysis.repositories.length)
  );
}

function repositoryCorpus(repo: AnalysisData["repositories"][number]) {
  return [repo.name, ...repo.stack, repo.readme, repo.recommendation, repo.note]
    .join(" ")
    .toLowerCase();
}

function portfolioCorpus(analysis: AnalysisData) {
  const breakdownText = analysis.breakdown
    .map((metric) => `${metric.label} ${metric.note}`)
    .join(" ")
    .toLowerCase();
  const repositoryText = analysis.repositories
    .map((repo) => repositoryCorpus(repo))
    .join(" ");

  return [
    analysis.headline,
    analysis.summary,
    analysis.highlights.join(" "),
    breakdownText,
    repositoryText,
  ]
    .join(" ")
    .toLowerCase();
}

function sentenceHasPositiveSignal(sentence: string, keywordPattern: RegExp) {
  if (!keywordPattern.test(sentence)) {
    return false;
  }

  const negationPattern = /(missing|lack|lacks|few|none|without|needs\b|need\b|add\b|absent)/i;
  return !negationPattern.test(sentence);
}

function countCloneProjects(analysis: AnalysisData) {
  const clonePattern =
    /(clone|netflix|spotify|youtube|amazon|twitter|instagram|whatsapp|discord|airbnb)/i;

  return analysis.repositories.filter((repo) => clonePattern.test(repo.name)).length;
}

function hasBackendSignals(analysis: AnalysisData) {
  const backendSkill = skillValue(analysis, "Backend");
  const backendStackPattern =
    /(go|rust|java|python|ruby|php|c#|kotlin|node|express|sql|postgres|mysql|mongodb)/i;
  const dbPattern =
    /(sql|postgres|mysql|sqlite|mongo|redis|prisma|typeorm|sequelize|orm|schema|migration)/i;
  const apiPattern = /(api|rest|graphql|endpoint|route|controller)/i;
  const authPattern = /(auth|authentication|authorization|oauth|jwt|session|role|permission)/i;
  const middlewarePattern = /(middleware|queue|worker|cache|throttle|rate limit|webhook)/i;

  const meaningfulBackendRepos = analysis.repositories.filter((repo) => {
    const text = repositoryCorpus(repo);
    const signalCount = [
      dbPattern.test(text),
      apiPattern.test(text),
      authPattern.test(text),
      middlewarePattern.test(text),
      repo.stack.some((entry) => backendStackPattern.test(entry.toLowerCase())),
    ].filter(Boolean).length;

    return signalCount >= 2;
  }).length;

  return (
    backendSkill >= SCORING.thresholds.strongBackendSkill ||
    meaningfulBackendRepos >= 1
  );
}

function hasTestingSignals(analysis: AnalysisData) {
  const testingPattern = /(test|coverage|unit test|integration test|e2e|playwright|jest|vitest)/i;
  return testingPattern.test(portfolioCorpus(analysis));
}

function hasDevOpsSignals(analysis: AnalysisData) {
  const devopsPattern =
    /(ci|cd|pipeline|github actions|workflow|docker|kubernetes|helm|terraform|deploy|deployment|release|monitoring|observability|sentry)/i;

  return devopsPattern.test(portfolioCorpus(analysis));
}

function hasRealWorldUsageSignals(analysis: AnalysisData) {
  const evidencePattern =
    /(https?:\/\/|live|production|deployed|deployment|demo|vercel|netlify|render|railway|cloudflare|aws|gcp|azure|uptime|users)/i;

  const sentences = portfolioCorpus(analysis)
    .split(/[.!?\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const sentenceSignal = sentences.some((sentence) =>
    sentenceHasPositiveSignal(sentence, evidencePattern),
  );
  const completenessSignal = metricValue(analysis, "Portfolio completeness") >= 7;

  return sentenceSignal || completenessSignal;
}

function hasPoorDocumentationSignals(analysis: AnalysisData) {
  const weakReadmePattern = /(minimal|does not yet|needs stronger|unclear|missing)/i;
  const weakRepoRatio =
    analysis.repositories.filter((repo) => weakReadmePattern.test(repo.readme)).length /
    Math.max(1, analysis.repositories.length);
  const docsMetric = metricValue(analysis, "Documentation");

  return weakRepoRatio >= SCORING.thresholds.poorDocsRatio || docsMetric < 7;
}

function isFrontendHeavyLogicLight(analysis: AnalysisData) {
  const frontendSkill = skillValue(analysis, "Frontend");
  const backendSkill = skillValue(analysis, "Backend");
  const devOpsSkill = skillValue(analysis, "DevOps");

  return (
    frontendSkill >= backendSkill + SCORING.thresholds.frontendDominanceGap &&
    frontendSkill >= devOpsSkill + SCORING.thresholds.frontendDominanceGap
  );
}

function hasShallowContributionSignals(analysis: AnalysisData) {
  return (
    averageRepoCommits(analysis) < SCORING.thresholds.shallowAvgCommits ||
    analysis.repositoriesAnalyzed < SCORING.thresholds.shallowReposAnalyzed
  );
}

function computeWeightedRepositoryScore(analysis: AnalysisData) {
  const sorted = [...analysis.repositories]
    .map((repo) => repo.quality)
    .sort((a, b) => b - a);

  if (!sorted.length) {
    return analysis.score;
  }

  if (sorted.length === 1) {
    return sorted[0];
  }

  const top23Weight = (SCORING.weights.top3Total - SCORING.weights.top1) / 2;
  const top1 = sorted[0] * SCORING.weights.top1;
  const second = (sorted[1] ?? sorted[0]) * top23Weight;
  const third = (sorted[2] ?? sorted[1] ?? sorted[0]) * top23Weight;
  const remainderValues = sorted.slice(3);
  const remainderAverage = remainderValues.length
    ? remainderValues.reduce((sum, value) => sum + value, 0) / remainderValues.length
    : sorted[Math.min(2, sorted.length - 1)];
  const remainder = remainderAverage * SCORING.weights.remaining;

  return top1 + second + third + remainder;
}

function qualityConsistencyScore(analysis: AnalysisData) {
  const qualities = analysis.repositories.map((repo) => repo.quality);

  if (qualities.length <= 1) {
    return 0.4;
  }

  const mean = qualities.reduce((sum, value) => sum + value, 0) / qualities.length;
  const variance =
    qualities.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    qualities.length;
  const stdDev = Math.sqrt(variance);

  return clamp(1 - stdDev / 2.5, 0, 1);
}

function hasComplexityBonusSignals(analysis: AnalysisData) {
  const nonTrivialRepos = analysis.repositories.filter(
    (repo) =>
      repo.quality >= SCORING.thresholds.nonTrivialRepoQuality &&
      repo.commits >= SCORING.thresholds.nonTrivialRepoCommits,
  ).length;

  return nonTrivialRepos >= 2;
}

export function deriveScoringFlags(analysis: AnalysisData): ScoringFlags {
  return {
    hasCloneProjects: countCloneProjects(analysis) > 0,
    frontendHeavy: isFrontendHeavyLogicLight(analysis),
    hasBackend: hasBackendSignals(analysis),
    hasDevOps: hasDevOpsSignals(analysis),
    shallowCommits: hasShallowContributionSignals(analysis),
    hasRealWorldUsage: hasRealWorldUsageSignals(analysis),
    poorDocumentation: hasPoorDocumentationSignals(analysis),
  };
}

export function computeSystemScore(analysis: AnalysisData): number {
  const flags = deriveScoringFlags(analysis);
  const cloneCount = countCloneProjects(analysis);
  const weightedRepoScore = computeWeightedRepositoryScore(analysis);

  const baseline =
    analysis.score * SCORING.weights.baselineModel +
    weightedRepoScore * SCORING.weights.baselineRepo;

  const clonePenalty = Math.min(
    SCORING.penalties.cloneMax,
    cloneCount * SCORING.penalties.clonePerProject,
  );
  const frontendHeavyPenalty = flags.frontendHeavy ? SCORING.penalties.frontendHeavy : 0;
  const shallowPenalty = flags.shallowCommits ? SCORING.penalties.shallow : 0;
  const noBackendPenalty = flags.hasBackend ? 0 : SCORING.penalties.noBackend;
  const hasDeliverySignals =
    flags.hasDevOps || flags.hasRealWorldUsage || hasTestingSignals(analysis);
  const noCICDPenalty = hasDeliverySignals ? 0 : SCORING.penalties.noCICD;
  const poorDocsPenalty = flags.poorDocumentation ? SCORING.penalties.poorDocs : 0;

  const backendBonus = flags.hasBackend ? SCORING.bonuses.backend : 0;
  const complexityBonus = hasComplexityBonusSignals(analysis)
    ? SCORING.bonuses.complexity
    : 0;
  const consistencyBonus = qualityConsistencyScore(analysis) >= 0.7
    ? SCORING.bonuses.consistency
    : 0;
  const realWorldBonus = flags.hasRealWorldUsage ? SCORING.bonuses.realWorld : 0;

  const penalties =
    clonePenalty +
    frontendHeavyPenalty +
    shallowPenalty +
    noBackendPenalty +
    noCICDPenalty +
    poorDocsPenalty;
  const bonuses = backendBonus + complexityBonus + consistencyBonus + realWorldBonus;

  return roundToTenth(clamp(baseline - penalties + bonuses, 0, 10));
}

export function computeConfidence(
  analysis: AnalysisData,
  flags: ScoringFlags,
  systemScore = computeSystemScore(analysis),
) {
  const repoDepth = clamp(analysis.repositoriesAnalyzed / 8, 0, 1);
  const commitDepth = clamp(averageRepoCommits(analysis) / 40, 0, 1);
  const consistencyDepth = qualityConsistencyScore(analysis);
  const realSignalDepth =
    [flags.hasBackend, flags.hasDevOps, flags.hasRealWorldUsage].filter(Boolean)
      .length / 3;

  let confidence =
    0.2 +
    repoDepth * 0.2 +
    commitDepth * 0.25 +
    consistencyDepth * 0.25 +
    realSignalDepth * 0.2;

  if (systemScore >= 7.5 && realSignalDepth < 0.5) {
    confidence -= 0.2;
  }

  if (systemScore >= 8 && (!flags.hasBackend || flags.shallowCommits || flags.poorDocumentation)) {
    confidence -= 0.2;
  }

  return roundToTenth(clamp(confidence, 0.2, 0.9));
}

function countSummarySentences(summary: string) {
  return summary
    .split(/[.!?]+/)
    .map((segment) => segment.trim())
    .filter(Boolean).length;
}

function buildDeterministicFallback(analysis: AnalysisData): AiQualitativeFeedback {
  const sortedBreakdown = [...analysis.breakdown].sort((a, b) => b.value - a.value);
  const strongestMetric = sortedBreakdown[0] ?? {
    label: "Code quality",
    value: analysis.score,
    note: "",
  };
  const weakestMetric = sortedBreakdown[sortedBreakdown.length - 1] ?? {
    label: "Portfolio completeness",
    value: analysis.score,
    note: "",
  };
  const weakestRepo = [...analysis.repositories].sort((a, b) => a.quality - b.quality)[0];

  return {
    summary: `${analysis.username} shows inconsistent engineering maturity with elevated execution risk. Architecture quality is mixed: ${strongestMetric.label} is ${strongestMetric.value}/10 while ${weakestMetric.label} is ${weakestMetric.value}/10 and remains the main blocker. ${DEFAULT_SUMMARY}`,
    strengths: [
      `${strongestMetric.label} is the strongest measurable signal at ${strongestMetric.value}/10 across analyzed repositories.`,
      `${analysis.repositoriesAnalyzed} repositories and ${analysis.totalStars} total stars provide a baseline evidence set instead of purely empty portfolio claims.`,
      `${analysis.repositories[0]?.name ?? "Top repository"} has the best repository-level quality and offers the clearest technical proof point in the set.`,
    ],
    weaknesses: [
      `${weakestMetric.label} at ${weakestMetric.value}/10 indicates weak proof for production-grade execution and increases rejection risk.`,
      `${weakestRepo?.name ?? "The weakest repository"} lacks robust engineering signals and raises maintainability risk under real delivery pressure.`,
      "CI/CD, test coverage, deployment quality, and observability evidence remain insufficiently demonstrated in the available portfolio data.",
    ],
    suggestions: [
      `Prioritize ${weakestMetric.label}: publish architecture decisions, setup verification, and runtime tradeoffs for top repositories.`,
      "Add automated quality gates (tests, coverage, CI pipeline, build checks) and expose results in repository documentation.",
      "Provide deployment evidence (live environments, uptime/error metrics, release notes) so reviewers can verify behavior beyond code snapshots.",
    ],
  };
}

export function buildDeterministicAiFeedback(analysis: AnalysisData): AiFeedback {
  const flags = deriveScoringFlags(analysis);
  const score = computeSystemScore(analysis);

  return {
    ...buildDeterministicFallback(analysis),
    score,
    confidence: computeConfidence(analysis, flags, score),
  };
}

function ensureFeedbackQuality(
  feedback: AiQualitativeFeedback,
  analysis: AnalysisData,
): AiQualitativeFeedback {
  const fallback = buildDeterministicFallback(analysis);
  const sentenceCount = countSummarySentences(feedback.summary);

  if (sentenceCount < 2 || sentenceCount > 3) {
    return fallback;
  }

  if (
    feedback.strengths.length < 3 ||
    feedback.weaknesses.length < 3 ||
    feedback.suggestions.length < 3
  ) {
    return fallback;
  }

  return feedback;
}

function parseAiFeedback(raw: string, baseline: AnalysisData): AiQualitativeFeedback {
  const fallback = buildDeterministicFallback(baseline);

  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;

    const normalized: AiQualitativeFeedback = {
      summary: normalizeText(parsed.summary, fallback.summary),
      strengths: normalizeList(parsed.strengths, fallback.strengths),
      weaknesses: normalizeList(parsed.weaknesses, fallback.weaknesses),
      suggestions: normalizeList(parsed.suggestions, fallback.suggestions),
    };

    return ensureFeedbackQuality(normalized, baseline);
  } catch {
    return fallback;
  }
}

export async function generateAiFeedback(
  analysis: AnalysisData,
  apiKey: string,
): Promise<AiFeedback> {
  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

  const flags = deriveScoringFlags(analysis);
  const systemScore = computeSystemScore(analysis);

  const context = {
    username: analysis.username,
    baselineScore: analysis.score,
    systemScore,
    followers: analysis.followers,
    totalStars: analysis.totalStars,
    repositoriesAnalyzed: analysis.repositoriesAnalyzed,
    breakdown: analysis.breakdown,
    skills: analysis.skills,
    flags,
    repositories: analysis.repositories.slice(0, 6).map((repository) => ({
      name: repository.name,
      stack: repository.stack,
      stars: repository.stars,
      commits: repository.commits,
      quality: repository.quality,
      readme: repository.readme,
      recommendation: repository.recommendation,
      note: repository.note,
    })),
  };

  const prompt = [
    "You are a staff-level software engineer and hiring interviewer evaluating a candidate's public GitHub portfolio.",
    "Return STRICT JSON only with keys: summary, strengths, weaknesses, suggestions.",
    "Do NOT return score or confidence. The system computes score and confidence deterministically.",
    "summary requirements: 2-3 sentences, direct, critical, evidence-based.",
    "strengths requirements: 3-5 concise bullets with concrete technical signals.",
    "weaknesses requirements: 3-5 concise bullets, critical and specific.",
    "suggestions requirements: 3-5 actionable technical improvements.",
    "No markdown. No extra keys. No motivational tone.",
    "Portfolio context JSON:",
    JSON.stringify(context),
  ].join("\n");

  let response: Awaited<ReturnType<typeof ai.models.generateContent>>;

  try {
    response = await withTimeout(
      ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      }),
      getAiTimeoutMs(),
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("AI request timed out.");
    }

    throw error;
  }

  const rawText = response.text?.trim();
  const qualitative = rawText
    ? parseAiFeedback(rawText, analysis)
    : buildDeterministicFallback(analysis);

  return {
    ...qualitative,
    score: systemScore,
    confidence: computeConfidence(analysis, flags, systemScore),
  };
}
