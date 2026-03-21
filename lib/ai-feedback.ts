import { GoogleGenAI } from "@google/genai";
import type { AnalysisData } from "@/lib/types";
import { clamp, roundToTenth } from "@/lib/utils";

type AiQualitativeFeedback = Pick<
  AnalysisData,
  "summary" | "strengths" | "weaknesses" | "suggestions"
>;

type AnalysisRepository = AnalysisData["repositories"][number];

export type AiFeedback = AiQualitativeFeedback;

export type ScoringFlags = {
  hasCloneProjects: boolean;
  frontendHeavy: boolean;
  hasBackend: boolean;
  hasDevOps: boolean;
  shallowCommits: boolean;
  hasRealWorldUsage: boolean;
  poorDocumentation: boolean;
};

type EvidenceAnchors = {
  all: Set<string>;
  strict: Set<string>;
};

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_AI_TIMEOUT_MS = 12_000;
const DEFAULT_SUMMARY =
  "Evidence is limited, architecture depth is unclear, and hiring risk remains high without stronger operational proof.";
const SPECULATIVE_PATTERN =
  /\b(maybe|might|probably|likely|possibly|guess|assume|appears|seems|feels like|could be)\b/i;
const SOFT_INTERVIEWER_PATTERN =
  /\b(great|excellent|impressive|promising|potential|talented|strong candidate|would hire)\b/i;

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

function getAiTimeoutMs(): number {
  return parsePositiveIntegerEnv("ANALYZE_AI_TIMEOUT_MS", DEFAULT_AI_TIMEOUT_MS);
}

function isAbortError(error: unknown): boolean {
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

function normalizeText(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || fallback;
}

function normalizeList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const cleaned = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .slice(0, 5);

  return cleaned.length >= 2 ? cleaned : fallback;
}

function extractJsonObject(raw: string): string {
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

function metricValue(analysis: AnalysisData, label: string): number {
  return (
    analysis.breakdown.find((metric) => metric.label.toLowerCase() === label.toLowerCase())
      ?.value ?? analysis.score
  );
}

function skillValue(analysis: AnalysisData, label: string): number {
  return (
    analysis.skills.find((skill) => skill.label.toLowerCase() === label.toLowerCase())
      ?.value ?? 0
  );
}

function averageRepoCommits(analysis: AnalysisData): number {
  return (
    analysis.repositories.reduce((sum, repo) => sum + repo.commits, 0) /
    Math.max(1, analysis.repositories.length)
  );
}

function buildRepositoryText(repo: AnalysisRepository): string {
  return [repo.name, ...repo.stack, repo.readme, repo.recommendation, repo.note]
    .join(" ")
    .toLowerCase();
}

function buildPortfolioText(analysis: AnalysisData): string {
  const breakdownText = analysis.breakdown
    .map((metric) => `${metric.label} ${metric.note}`)
    .join(" ")
    .toLowerCase();
  const repositoryText = analysis.repositories
    .map((repo) => buildRepositoryText(repo))
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

function sentenceHasPositiveSignal(sentence: string, keywordPattern: RegExp): boolean {
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
    const text = buildRepositoryText(repo);
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

function hasDevOpsSignals(analysis: AnalysisData) {
  const devopsPattern =
    /(ci|cd|pipeline|github actions|workflow|docker|kubernetes|helm|terraform|deploy|deployment|release|monitoring|observability|sentry)/i;

  return devopsPattern.test(buildPortfolioText(analysis));
}

function hasRealWorldUsageSignals(analysis: AnalysisData) {
  const evidencePattern =
    /(https?:\/\/|live|production|deployed|deployment|demo|vercel|netlify|render|railway|cloudflare|aws|gcp|azure|uptime|users)/i;

  const sentences = buildPortfolioText(analysis)
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
  return Math.round(clamp(analysis.score, 0, 100));
}

export function computeConfidence(
  analysis: AnalysisData,
): number {
  return roundToTenth(clamp(analysis.confidence, 0.25, 0.95));
}

function countSummarySentences(summary: string): number {
  return summary
    .split(/[.!?]+/)
    .map((segment) => segment.trim())
    .filter(Boolean).length;
}

function normalizeForAnchorMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Build a whitelist of evidence tokens that generated text must reference.
function buildEvidenceAnchors(analysis: AnalysisData): EvidenceAnchors {
  const all = new Set<string>();
  const strict = new Set<string>();

  const usernameAnchor = normalizeForAnchorMatch(analysis.username);
  all.add(usernameAnchor);
  strict.add(usernameAnchor);
  all.add(normalizeForAnchorMatch(String(analysis.repositoriesAnalyzed)));
  all.add(normalizeForAnchorMatch(String(computeSystemScore(analysis))));
  all.add(normalizeForAnchorMatch(String(analysis.totalStars)));
  all.add(normalizeForAnchorMatch(String(analysis.followers)));

  for (const metric of analysis.breakdown) {
    const labelAnchor = normalizeForAnchorMatch(metric.label);
    all.add(labelAnchor);
    strict.add(labelAnchor);
    all.add(normalizeForAnchorMatch(String(metric.value)));
  }

  for (const skill of analysis.skills) {
    const labelAnchor = normalizeForAnchorMatch(skill.label);
    all.add(labelAnchor);
    strict.add(labelAnchor);
    all.add(normalizeForAnchorMatch(String(skill.value)));
  }

  for (const repository of analysis.repositories.slice(0, 6)) {
    const repoAnchor = normalizeForAnchorMatch(repository.name);
    all.add(repoAnchor);
    strict.add(repoAnchor);
    const repoLeaf = repository.name.split("/").pop();
    if (repoLeaf) {
      const leafAnchor = normalizeForAnchorMatch(repoLeaf);
      all.add(leafAnchor);
      strict.add(leafAnchor);
    }

    all.add(normalizeForAnchorMatch(String(repository.commits)));
    all.add(normalizeForAnchorMatch(String(repository.quality)));

    for (const stackItem of repository.stack) {
      all.add(normalizeForAnchorMatch(stackItem));
    }
  }

  for (const finding of analysis.evidenceFindings ?? []) {
    const claimAnchor = normalizeForAnchorMatch(finding.claim);
    all.add(claimAnchor);
    strict.add(claimAnchor);
    for (const evidence of finding.evidence) {
      all.add(normalizeForAnchorMatch(evidence));
    }
  }

  for (const reason of analysis.scoreMeta?.scoreModel?.changeReasons ?? []) {
    all.add(normalizeForAnchorMatch(reason));
  }

  all.delete("");
  strict.delete("");
  return { all, strict };
}

function textHasEvidenceAnchor(text: string, anchors: EvidenceAnchors): boolean {
  const normalizedText = normalizeForAnchorMatch(text);

  for (const anchor of anchors.strict) {
    if (anchor.length < 3) {
      continue;
    }

    if (normalizedText.includes(anchor)) {
      return true;
    }
  }

  return false;
}

function textHasHallucinationSignal(text: string, anchors: EvidenceAnchors): boolean {
  if (SPECULATIVE_PATTERN.test(text) || SOFT_INTERVIEWER_PATTERN.test(text)) {
    return true;
  }

  const strongClaimPattern =
    /\b(production grade|enterprise scale|millions of users|distributed system|microservices|event driven|kafka|high throughput)\b/i;

  if (strongClaimPattern.test(text) && !textHasEvidenceAnchor(text, anchors)) {
    return true;
  }

  return false;
}

function isGroundedStatement(text: string, anchors: EvidenceAnchors): boolean {
  return textHasEvidenceAnchor(text, anchors) && !textHasHallucinationSignal(text, anchors);
}

function buildDeterministicFallback(analysis: AnalysisData): AiQualitativeFeedback {
  const sortedBreakdown = [...analysis.breakdown].sort((a, b) => b.value - a.value);
  const strongestMetric = sortedBreakdown[0] ?? {
    label: "Activity",
    value: analysis.score,
    note: "",
  };
  const weakestMetric = sortedBreakdown[sortedBreakdown.length - 1] ?? {
    label: "Impact",
    value: analysis.score,
    note: "",
  };
  const weakestRepo = [...analysis.repositories].sort((a, b) => a.quality - b.quality)[0];

  return {
    summary: `${analysis.username} shows uneven engineering signals across analyzed repositories. ${strongestMetric.label} is ${strongestMetric.value}/100 while ${weakestMetric.label} is ${weakestMetric.value}/100, making ${weakestMetric.label.toLowerCase()} the primary improvement area. ${DEFAULT_SUMMARY}`,
    strengths: [
      `${strongestMetric.label} is the strongest measurable signal at ${strongestMetric.value}/100 across analyzed repositories.`,
      `${analysis.repositoriesAnalyzed} repositories and ${analysis.totalStars} total stars provide baseline evidence, with ${strongestMetric.label} currently the clearest measurable strength.`,
      `${analysis.repositories[0]?.name ?? "Top repository"} has the best repository-level quality and offers the clearest technical proof point in the set.`,
    ],
    weaknesses: [
      `${weakestMetric.label} at ${weakestMetric.value}/100 is the weakest measured area in the current score breakdown.`,
      `${weakestRepo?.name ?? "The weakest repository"} has the lowest repository quality signal in the analyzed set and needs stronger implementation evidence.`,
      `${analysis.repositories[0]?.name ?? "Top repository"} and ${weakestRepo?.name ?? "the weakest repository"} contain limited explicit evidence for CI/CD, automated tests, deployment, and observability practices.`,
    ],
    suggestions: [
      `Prioritize ${weakestMetric.label}: publish architecture decisions, setup verification, and runtime tradeoffs for top repositories.`,
      `In ${analysis.repositories[0]?.name ?? "a top repository"}, add automated quality gates (tests, coverage, CI pipeline, build checks) and expose results in repository documentation.`,
      `For ${weakestRepo?.name ?? "the weakest repository"}, provide deployment evidence (live environments, uptime/error metrics, release notes) so reviewers can verify behavior beyond code snapshots.`,
    ],
  };
}

export function buildDeterministicAiFeedback(analysis: AnalysisData): AiFeedback {
  return {
    ...buildDeterministicFallback(analysis),
  };
}

function hasMinimumBulletCount(feedback: AiQualitativeFeedback): boolean {
  return (
    feedback.strengths.length >= 2 &&
    feedback.weaknesses.length >= 2 &&
    feedback.suggestions.length >= 2
  );
}

function ensureFeedbackQuality(
  feedback: AiQualitativeFeedback,
  analysis: AnalysisData,
): AiQualitativeFeedback {
  const fallback = buildDeterministicFallback(analysis);
  const sentenceCount = countSummarySentences(feedback.summary);
  const anchors = buildEvidenceAnchors(analysis);

  if (sentenceCount < 2 || sentenceCount > 3) {
    return fallback;
  }

  if (!hasMinimumBulletCount(feedback)) {
    return fallback;
  }

  const summarySentences = feedback.summary
    .split(/[.!?]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const groundedSummarySentences = summarySentences.filter((sentence) =>
    isGroundedStatement(sentence, anchors),
  ).length;

  if (groundedSummarySentences < Math.min(2, summarySentences.length)) {
    return fallback;
  }

  const allBullets = [
    ...feedback.strengths,
    ...feedback.weaknesses,
    ...feedback.suggestions,
  ];
  const hasUngroundedBullet = allBullets.some(
    (bullet) => !isGroundedStatement(bullet, anchors),
  );

  if (hasUngroundedBullet) {
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

function buildAiPrompt(context: Record<string, unknown>): string {
  return [
    "You are a strict portfolio evidence summarizer.",
    "System-first policy: deterministic scoring/signals are already computed by the engine.",
    "Your job is explanation only. Do not invent signals or infer hidden skills.",
    "Use ONLY facts present in the provided JSON context.",
    "Never infer unseen systems, business impact, team scale, or production usage.",
    "If evidence is missing, say evidence is missing.",
    "Return STRICT JSON only with keys: summary, strengths, weaknesses, suggestions.",
    "Do NOT return score or confidence. The system computes score and confidence deterministically.",
    "summary requirements: exactly 2-3 sentences, critical, evidence-based, no motivational language.",
    "strengths requirements: 2-4 concise bullets and each bullet must cite at least one concrete evidence anchor (repo name, metric label/value, skill label/value, commits, quality).",
    "weaknesses requirements: 2-4 concise bullets and each bullet must cite at least one concrete evidence anchor (repo name, metric label/value, skill label/value, commits, quality).",
    "suggestions requirements: 2-4 actionable bullets and each bullet must reference a concrete gap from the context.",
    "Disallowed style: interviewer tone, speculation, praise adjectives, or hypothetical claims.",
    "No markdown. No extra keys.",
    "Portfolio context JSON:",
    JSON.stringify(context),
  ].join("\n");
}

function buildAiContext(analysis: AnalysisData, systemScore: number): Record<string, unknown> {
  return {
    username: analysis.username,
    systemScore,
    repositoriesAnalyzed: analysis.repositoriesAnalyzed,
    breakdown: analysis.breakdown.map((metric) => ({
      label: metric.label,
      value: metric.value,
      note: metric.note,
    })),
    skills: analysis.skills.map((skill) => ({
      label: skill.label,
      value: skill.value,
    })),
    repositories: analysis.repositories.slice(0, 6).map((repository) => ({
      name: repository.name,
      stack: repository.stack,
      commits: repository.commits,
      quality: repository.quality,
      readme: repository.readme,
    })),
    developerSignals: analysis.developerSignals,
    evidenceFindings: analysis.evidenceFindings,
    scoreModel: analysis.scoreMeta?.scoreModel,
  };
}

export async function generateAiFeedback(
  analysis: AnalysisData,
  apiKey: string,
): Promise<AiFeedback> {
  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

  const systemScore = computeSystemScore(analysis);

  const context = buildAiContext(analysis, systemScore);
  const prompt = buildAiPrompt(context);

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
  };
}
