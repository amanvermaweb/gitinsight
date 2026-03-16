import { GoogleGenAI } from "@google/genai";
import type { AnalysisData } from "@/lib/types";

export type AiFeedback = Pick<
  AnalysisData,
  "summary" | "strengths" | "weaknesses" | "suggestions"
>;

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_SUMMARY_SENTENCE =
  "Evidence is mixed and should be interpreted as a portfolio signal, not a full codebase audit.";

function scoreVerdict(score: number) {
  if (score < 5.5) {
    return "well below the hiring bar for production engineering roles";
  }

  if (score < 6.8) {
    return "below the hiring bar for most mid-level product engineering roles";
  }

  if (score < 7.6) {
    return "borderline and currently not competitive without targeted fixes";
  }

  if (score < 8.5) {
    return "competitive but still held back by clear risk areas";
  }

  return "competitive for senior-level review loops";
}

function needsBluntSummary(score: number, summary: string) {
  if (score >= 7.6) {
    return false;
  }

  const normalized = summary.toLowerCase();
  const bluntSignals = [
    "below the hiring bar",
    "not competitive",
    "weak profile",
    "fails",
    "high-risk",
    "material gap",
  ];

  return !bluntSignals.some((signal) => normalized.includes(signal));
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
    .slice(0, 3);

  return cleaned.length >= 2 ? cleaned : fallback;
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

function deriveSpecificSignals(analysis: AnalysisData) {
  const repositoryNames = analysis.repositories
    .slice(0, 6)
    .map((repository) => repository.name.toLowerCase());
  const metricLabels = analysis.breakdown.map((metric) => metric.label.toLowerCase());

  return [...repositoryNames, ...metricLabels, analysis.username.toLowerCase()];
}

function looksGenericLine(line: string, specificSignals: string[]) {
  const normalized = line.toLowerCase();
  const genericPraiseTokens = [
    "great",
    "excellent",
    "impressive",
    "strong",
    "solid",
    "well done",
    "outstanding",
    "notable",
    "high-trust",
  ];
  const containsGenericPraise = genericPraiseTokens.some((token) =>
    normalized.includes(token),
  );
  const hasNumber = /\d/.test(normalized);
  const hasSpecificSignal = specificSignals.some((signal) =>
    signal.length > 2 ? normalized.includes(signal) : false,
  );

  return containsGenericPraise && !hasNumber && !hasSpecificSignal;
}

function buildDeterministicFallback(analysis: AnalysisData): AiFeedback {
  const sortedBreakdown = [...analysis.breakdown].sort((a, b) => b.value - a.value);
  const strongestMetric = sortedBreakdown[0] ?? {
    label: "Code quality",
    value: analysis.score,
    note: "",
  };
  const weakestMetric = sortedBreakdown[sortedBreakdown.length - 1] ?? {
    label: "Documentation",
    value: analysis.score,
    note: "",
  };
  const strongestRepo = [...analysis.repositories].sort((a, b) => b.quality - a.quality)[0];
  const weakestRepo = [...analysis.repositories].sort((a, b) => a.quality - b.quality)[0];
  const lowMetrics = sortedBreakdown
    .slice(-2)
    .map((metric) => `${metric.label} ${metric.value}/10`)
    .join(" and ");
  const verdict = scoreVerdict(analysis.score);

  return {
    summary: `${analysis.username} scores ${analysis.score}/10 and is ${verdict}. The biggest liabilities are ${lowMetrics || "the two lowest-scoring dimensions"}, with ${weakestMetric.label} as the primary blocker at ${weakestMetric.value}/10.`,
    strengths: [
      `${strongestMetric.label} is the only clear bright spot at ${strongestMetric.value}/10 across ${analysis.repositoriesAnalyzed} analyzed repositories.`,
      `${strongestRepo?.name ?? "Top featured repo"} leads with quality ${strongestRepo?.quality ?? analysis.score}/10 and ${strongestRepo?.stars ?? 0} stars; the rest of the portfolio trails behind it.`,
      `${analysis.totalStars} total stars and ${analysis.followers} followers indicate visible output, but visibility does not offset weak execution metrics in lower-scoring categories.`,
    ],
    weaknesses: [
      `${weakestMetric.label} is a hard blocker at ${weakestMetric.value}/10 and will trigger rejection in most technical screens if left unresolved.`,
      `${weakestRepo?.name ?? "The weakest featured repo"} sits at quality ${weakestRepo?.quality ?? analysis.score}/10, which is not production-grade evidence for hiring decisions.`,
      "Missing test strategy, observability proof, and incident-readiness evidence creates delivery and reliability risk that reviewers cannot ignore.",
    ],
    suggestions: [
      `Fix ${weakestMetric.label} first: implement tests, monitoring notes, and rollback instructions in the top 3 repositories before adding new projects.`,
      `Start with ${weakestRepo?.name ?? "the weakest featured repo"}: ship a concrete remediation pass (failing test coverage gaps, runbook, and benchmark or reliability evidence).`,
      "Publish release notes with risk, verification, and post-deploy outcomes so reviewers can evaluate engineering judgment instead of repository volume.",
    ],
  };
}

function ensureFeedbackQuality(feedback: AiFeedback, analysis: AnalysisData): AiFeedback {
  const specificSignals = deriveSpecificSignals(analysis);
  const summarySentences = feedback.summary
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const summaryHasEvidence = /\d/.test(feedback.summary) ||
    specificSignals.some((signal) =>
      signal.length > 2 ? feedback.summary.toLowerCase().includes(signal) : false,
    );

  const strengthsGenericCount = feedback.strengths.filter((item) =>
    looksGenericLine(item, specificSignals),
  ).length;
  const weaknessesGenericCount = feedback.weaknesses.filter((item) =>
    looksGenericLine(item, specificSignals),
  ).length;

  if (
    !summaryHasEvidence ||
    summarySentences.length < 2 ||
    strengthsGenericCount >= 2 ||
    weaknessesGenericCount >= 1 ||
    needsBluntSummary(analysis.score, feedback.summary)
  ) {
    return buildDeterministicFallback(analysis);
  }

  const summary = summaryHasEvidence
    ? feedback.summary
    : `${feedback.summary} ${DEFAULT_SUMMARY_SENTENCE}`;

  return {
    ...feedback,
    summary,
  };
}

function parseAiFeedback(raw: string, baseline: AnalysisData): AiFeedback {
  const strictFallback = buildDeterministicFallback(baseline);
  const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;

  const normalized = {
    summary: normalizeText(parsed.summary, strictFallback.summary),
    strengths: normalizeList(parsed.strengths, strictFallback.strengths),
    weaknesses: normalizeList(parsed.weaknesses, strictFallback.weaknesses),
    suggestions: normalizeList(parsed.suggestions, strictFallback.suggestions),
  };

  return ensureFeedbackQuality(normalized, baseline);
}

export async function generateAiFeedback(
  analysis: AnalysisData,
  apiKey: string,
): Promise<AiFeedback> {
  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

  const context = {
    username: analysis.username,
    score: analysis.score,
    benchmarkDelta: analysis.benchmarkDelta,
    followers: analysis.followers,
    totalStars: analysis.totalStars,
    repositoriesAnalyzed: analysis.repositoriesAnalyzed,
    breakdown: analysis.breakdown,
    highlights: analysis.highlights,
    skills: analysis.skills,
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
    "You are a staff-plus engineering interviewer reviewing a candidate's public GitHub portfolio.",
    "Generate technical feedback with senior-engineer rigor and skeptical evidence standards.",
    "Default stance: risk-first review. Be stricter on weaknesses than strengths.",
    "Return STRICT JSON only with keys: summary, strengths, weaknesses, suggestions.",
    "Rules:",
    "- summary: 2-3 sentences; lead with technical risks and hiring decision impact.",
    "- strengths: array of exactly 3 concise bullets focused on technical execution; keep each short and evidence-backed.",
    "- weaknesses: array of exactly 3 concise bullets focused on technical gaps and risks; each must be more specific than strengths.",
    "- suggestions: array of exactly 3 concrete, high-impact technical actions with implementation direction.",
    "- Every bullet must cite at least one concrete data point from context (number, metric label, or repository name).",
    "- At least 2 weakness bullets must be explicit high-severity risks with potential consequence (reliability, security, maintainability, or delivery risk).",
    "- At least 1 weakness bullet must identify missing evidence (for example tests, observability, incident-readiness, or performance proof).",
    "- Weaknesses and suggestions together should carry most of the analytical weight.",
    "- Do not balance criticism with compliments; prioritize what could fail in production or during scale.",
    "- If evidence is limited, state uncertainty directly instead of praising.",
    "- Be direct and blunt. Do not soften language with politeness or motivational framing.",
    "- If score is below 7.6, explicitly state the profile is below the hiring bar or not competitive.",
    "- If score is below 6.8, clearly state this profile would likely be rejected in most technical screens today.",
    "- Avoid generic career advice and avoid soft-skill commentary.",
    "- Avoid generic praise words like 'great', 'excellent', 'impressive', 'outstanding', or 'strong' unless followed by concrete evidence.",
    "- Avoid markdown, numbering, and any keys outside the required schema.",
    "Portfolio analysis context:",
    JSON.stringify(context),
  ].join("\n");

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  });

  const rawText = response.text?.trim();

  if (!rawText) {
    throw new Error("AI service returned an empty feedback payload.");
  }

  return parseAiFeedback(rawText, analysis);
}