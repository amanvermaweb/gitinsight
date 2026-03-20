import { describe, expect, it } from "vitest";
import {
  __resetInMemoryScoreboardForTests,
  buildScoreNarratives,
  computeGitInsightScore,
  upsertScorePercentile,
} from "@/lib/gitinsight-score";

describe("gitinsight-score", () => {
  it("computes the weighted 0-100 score from component formulas", () => {
    const result = computeGitInsightScore({
      commits: 80,
      prs: 12,
      issues: 10,
      activeDays: 70,
      streakDays: 19,
      qualityStars: 20,
      reposWithReadme: 5,
      avgRepoSizeScore: 0.7,
      impactStars: 45,
      impactForks: 18,
      followers: 35,
      externalContributions: 12,
      languages: 5,
      frameworks: 2,
    });

    expect(result.components.activity).toBeGreaterThan(0);
    expect(result.components.activity).toBeLessThanOrEqual(100);
    expect(result.components.consistency).toBeGreaterThan(0);
    expect(result.components.quality).toBeGreaterThan(0);
    expect(result.components.impact).toBeGreaterThan(0);
    expect(result.components.breadth).toBeGreaterThan(0);
    expect(result.finalScore).toBeGreaterThan(0);
    expect(result.finalScore).toBeLessThanOrEqual(100);
  });

  it("produces required UX narrative lines", () => {
    const narratives = buildScoreNarratives({
      activity: 70,
      consistency: 91,
      quality: 62,
      impact: 41,
      breadth: 55,
    });

    expect(narratives.strengthLine.startsWith("Strength:")).toBe(true);
    expect(narratives.weaknessLine.startsWith("Weakness:")).toBe(true);
    expect(typeof narratives.coaching).toBe("string");
    expect(narratives.coaching.length).toBeGreaterThan(20);
  });

  it("computes a shareable top percentile with in-memory fallback", async () => {
    __resetInMemoryScoreboardForTests();

    await upsertScorePercentile("alice", 40);
    await upsertScorePercentile("bob", 65);
    const charlie = await upsertScorePercentile("charlie", 80);

    expect(charlie.totalProfiles).toBe(3);
    expect(charlie.topPercent).toBeGreaterThan(0);
    expect(charlie.topPercent).toBeLessThanOrEqual(100);
  });
});
