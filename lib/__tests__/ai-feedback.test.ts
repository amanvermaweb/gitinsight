import { describe, expect, it } from "vitest";
import {
  buildDeterministicAiFeedback,
  computeConfidence,
  computeSystemScore,
  deriveScoringFlags,
} from "@/lib/ai-feedback";
import type { AnalysisData } from "@/lib/types";

function createAnalysisFixture(): AnalysisData {
  return {
    username: "octocat",
    score: 72,
    confidence: 0.6,
    followers: 120,
    totalStars: 380,
    repositoriesAnalyzed: 6,
    benchmarkDelta: "Top 12% among analyzed GitInsight profiles",
    headline: "Strong baseline profile.",
    summary: "Base summary.",
    highlights: ["h1", "h2", "h3"],
    breakdown: [
      { label: "Activity", value: 78, note: "good" },
      { label: "Consistency", value: 66, note: "mixed" },
      { label: "Code quality proxy", value: 71, note: "good" },
      { label: "Impact", value: 69, note: "moderate" },
      { label: "Tech breadth", value: 65, note: "needs demos" },
    ],
    activity: [
      { label: "Jan", value: 55 },
      { label: "Feb", value: 66 },
      { label: "Mar", value: 60 },
    ],
    repositories: [
      {
        name: "octocat/api-service",
        stack: ["TypeScript", "PostgreSQL", "Docker"],
        stars: 220,
        commits: 74,
        quality: 8.7,
        readme: "README is strong.",
        recommendation: "Add runbooks.",
        note: "stable",
        velocity: [4, 5, 6, 5, 7, 6, 6],
      },
      {
        name: "octocat/dashboard",
        stack: ["TypeScript", "React"],
        stars: 88,
        commits: 41,
        quality: 7.6,
        readme: "README captures intent.",
        recommendation: "Add architecture diagram.",
        note: "solid",
        velocity: [3, 4, 4, 5, 4, 5, 4],
      },
      {
        name: "octocat/cli",
        stack: ["Go"],
        stars: 72,
        commits: 35,
        quality: 7.2,
        readme: "README is minimal.",
        recommendation: "Document commands.",
        note: "improving",
        velocity: [2, 3, 3, 2, 3, 3, 2],
      },
    ],
    skills: [
      { label: "Frontend", value: 72 },
      { label: "Backend", value: 66 },
      { label: "DevOps", value: 52 },
      { label: "Algorithms", value: 41 },
      { label: "AI / ML", value: 26 },
    ],
    strengths: ["s1", "s2", "s3"],
    weaknesses: ["w1", "w2", "w3"],
    suggestions: ["x1", "x2", "x3"],
  };
}

describe("ai-feedback deterministic behavior", () => {
  it("builds deterministic feedback with computed score and confidence", () => {
    const analysis = createAnalysisFixture();
    const flags = deriveScoringFlags(analysis);
    const expectedScore = computeSystemScore(analysis);
    const expectedConfidence = computeConfidence(analysis, flags, expectedScore);

    const feedback = buildDeterministicAiFeedback(analysis);

    expect(feedback.score).toBe(expectedScore);
    expect(feedback.confidence).toBe(expectedConfidence);
    expect(feedback.strengths.length).toBeGreaterThanOrEqual(3);
    expect(feedback.weaknesses.length).toBeGreaterThanOrEqual(3);
    expect(feedback.suggestions.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps computed score in valid portfolio range", () => {
    const analysis = createAnalysisFixture();
    const score = computeSystemScore(analysis);

    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});
