import { describe, expect, it } from "vitest";
import {
  __resetInMemoryScoreboardForTests,
  buildScoreNarratives,
  computeEngineeringScore,
  computeGitInsightScore,
  resolveEngineeringWeights,
  explainEngineeringScoreChange,
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

  it("computes explainable engineering score components with fixed weights", () => {
    const result = computeEngineeringScore({
      depth: 72,
      systemDesign: 64,
      execution: 58,
      consistency: 70,
      impact: 45,
    });

    expect(result.finalScore).toBeGreaterThan(0);
    expect(result.finalScore).toBeLessThanOrEqual(100);
    expect(result.weights.depth).toBe(0.3);
    expect(result.weights.systemDesign).toBe(0.25);
    expect(result.weights.execution).toBe(0.2);
    expect(result.weights.consistency).toBe(0.15);
    expect(result.weights.impact).toBe(0.1);
  });

  it("explains why the engineering score changed", () => {
    const previous = computeEngineeringScore({
      depth: 55,
      systemDesign: 50,
      execution: 47,
      consistency: 63,
      impact: 40,
    });
    const current = computeEngineeringScore({
      depth: 69,
      systemDesign: 64,
      execution: 58,
      consistency: 65,
      impact: 42,
    });

    const change = explainEngineeringScoreChange(
      previous.finalScore,
      current.finalScore,
      previous.components,
      current.components,
    );

    expect(change.reasons.length).toBeGreaterThan(0);
    expect(typeof change.scoreDelta).toBe("number");
  });

  it("resolves project-type-aware weights with low-level language boost", () => {
    const baseSystemWeights = resolveEngineeringWeights("system-software", {
      lowLevelLanguageShare: 0,
    });
    const boostedSystemWeights = resolveEngineeringWeights("system-software", {
      lowLevelLanguageShare: 0.8,
    });

    expect(boostedSystemWeights.systemDesign).toBeGreaterThan(
      baseSystemWeights.systemDesign,
    );
    const total =
      boostedSystemWeights.depth +
      boostedSystemWeights.systemDesign +
      boostedSystemWeights.execution +
      boostedSystemWeights.consistency +
      boostedSystemWeights.impact;
    expect(Math.abs(total - 1)).toBeLessThan(0.0001);
  });
});
