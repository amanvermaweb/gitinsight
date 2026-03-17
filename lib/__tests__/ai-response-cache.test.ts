import { afterEach, describe, expect, it } from "vitest";
import {
  configureAiFeedbackCacheAdapter,
  getCachedAiFeedback,
  setCachedAiFeedback,
} from "@/lib/ai-response-cache";
import type { AiFeedback } from "@/lib/ai-feedback";
import type { AnalysisData } from "@/lib/types";

function createAnalysisFixture(overrides?: Partial<AnalysisData>): AnalysisData {
  return {
    username: "octocat",
    score: 7,
    confidence: 0.7,
    followers: 100,
    totalStars: 200,
    repositoriesAnalyzed: 3,
    benchmarkDelta: "Top 15%",
    headline: "headline",
    summary: "summary",
    highlights: ["h1", "h2", "h3"],
    breakdown: [
      { label: "Code quality", value: 7.1, note: "n" },
      { label: "Documentation", value: 6.8, note: "n" },
      { label: "Project originality", value: 7.2, note: "n" },
      { label: "Open source activity", value: 6.5, note: "n" },
      { label: "Portfolio completeness", value: 6.4, note: "n" },
    ],
    activity: [{ label: "Jan", value: 55 }],
    repositories: [
      {
        name: "octocat/repo",
        stack: ["TypeScript"],
        stars: 20,
        commits: 24,
        quality: 7.5,
        readme: "README",
        recommendation: "rec",
        note: "note",
        velocity: [2, 2, 3, 3, 4, 4, 4],
      },
    ],
    skills: [
      { label: "Frontend", value: 70 },
      { label: "Backend", value: 55 },
      { label: "DevOps", value: 45 },
      { label: "Algorithms", value: 35 },
      { label: "AI / ML", value: 25 },
    ],
    strengths: ["s1", "s2", "s3"],
    weaknesses: ["w1", "w2", "w3"],
    suggestions: ["x1", "x2", "x3"],
    ...overrides,
  };
}

const feedback: AiFeedback = {
  summary: "summary",
  strengths: ["s1", "s2", "s3"],
  weaknesses: ["w1", "w2", "w3"],
  suggestions: ["x1", "x2", "x3"],
  score: 7.3,
  confidence: 0.7,
};

afterEach(() => {
  configureAiFeedbackCacheAdapter(null);
});

describe("ai-response-cache keying", () => {
  it("uses different cache keys when analysis fingerprint changes", async () => {
    const seenKeys: string[] = [];

    configureAiFeedbackCacheAdapter({
      get: async (key) => {
        seenKeys.push(`get:${key}`);
        return null;
      },
      set: async (key) => {
        seenKeys.push(`set:${key}`);
      },
    });

    const baseline = createAnalysisFixture();
    const changed = createAnalysisFixture({
      repositories: [
        {
          ...baseline.repositories[0],
          commits: baseline.repositories[0].commits + 10,
        },
      ],
    });

    await setCachedAiFeedback("octocat", feedback, baseline);
    await setCachedAiFeedback("octocat", feedback, changed);
    await getCachedAiFeedback("octocat", baseline);

    const firstSetKey = seenKeys[0]?.replace("set:", "") ?? "";
    const secondSetKey = seenKeys[1]?.replace("set:", "") ?? "";

    expect(firstSetKey).not.toBe(secondSetKey);
    expect(seenKeys[2]?.startsWith("get:")).toBe(true);
  });
});
