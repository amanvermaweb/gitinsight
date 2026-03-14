import { GoogleGenAI } from "@google/genai";
import type { AnalysisData } from "@/lib/types";

export type AiFeedback = Pick<
  AnalysisData,
  "summary" | "strengths" | "weaknesses" | "suggestions"
>;

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

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

function parseAiFeedback(raw: string, baseline: AnalysisData): AiFeedback {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  return {
    summary: normalizeText(parsed.summary, baseline.summary),
    strengths: normalizeList(parsed.strengths, baseline.strengths),
    weaknesses: normalizeList(parsed.weaknesses, baseline.weaknesses),
    suggestions: normalizeList(parsed.suggestions, baseline.suggestions),
  };
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
    "Generate technical feedback with senior-engineer rigor.",
    "Return STRICT JSON only with keys: summary, strengths, weaknesses, suggestions.",
    "Rules:",
    "- summary: 2-3 sentences; assess architecture quality, engineering maturity, and risk profile.",
    "- strengths: array of 3 concise bullets focused on technical execution (architecture, code quality, delivery discipline, maintainability).",
    "- weaknesses: array of 3 concise bullets focused on technical gaps (testing depth, observability, security hardening, performance, reliability).",
    "- suggestions: array of 3 concrete, high-impact technical actions with clear implementation direction.",
    "- Prefer evidence grounded in the provided repository/breakdown context.",
    "- Avoid generic career advice and avoid soft-skill commentary.",
    "- Avoid markdown, numbering, and any keys outside the required schema.",
    "Portfolio analysis context:",
    JSON.stringify(context),
  ].join("\n");

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0.35,
    },
  });

  const rawText = response.text?.trim();

  if (!rawText) {
    throw new Error("AI service returned an empty feedback payload.");
  }

  return parseAiFeedback(rawText, analysis);
}