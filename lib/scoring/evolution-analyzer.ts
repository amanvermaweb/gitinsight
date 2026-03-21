import type { EvolutionModel, ScoreValue } from "@/lib/types";
import { clamp } from "@/lib/utils";

export type EvolutionInput = {
  monthlyCommits: number[];
  readmeCoverage: number;
  recentCoverage: number;
  avgContributorCount: number;
  commitMessageQualityScore: number;
  featureCommits: number;
};

function avg(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]) {
  if (values.length <= 1) {
    return 0;
  }

  const mean = avg(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function scoreOrUnknown(score: number, hasEvidence: boolean): ScoreValue {
  if (!hasEvidence) {
    return "unknown";
  }

  return Math.round(clamp(score, 1, 100));
}

export function analyzeEvolution(input: EvolutionInput): EvolutionModel {
  const hasMonthlyEvidence = input.monthlyCommits.length >= 5;
  const totalMonthlyCommits = input.monthlyCommits.reduce((sum, value) => sum + value, 0);
  const hasEvidence = hasMonthlyEvidence && totalMonthlyCommits > 0;

  if (!hasEvidence) {
    return {
      project_maturity_score: "unknown",
      evolution_trend: "insufficient evidence",
      signals: [
        "insufficient historical commit timeline",
        "insufficient evidence",
      ],
    };
  }

  const firstHalf = input.monthlyCommits.slice(0, Math.floor(input.monthlyCommits.length / 2));
  const secondHalf = input.monthlyCommits.slice(Math.floor(input.monthlyCommits.length / 2));
  const firstAvg = avg(firstHalf);
  const secondAvg = avg(secondHalf);
  const momentum = secondAvg - firstAvg;
  const variability = stdDev(input.monthlyCommits) / Math.max(1, avg(input.monthlyCommits));

  const maturityScore = scoreOrUnknown(
    input.readmeCoverage * 28 +
      input.recentCoverage * 26 +
      clamp(input.avgContributorCount / 20, 0, 1) * 20 +
      clamp(input.commitMessageQualityScore / 100, 0, 1) * 14 +
      clamp(input.featureCommits / 20, 0, 1) * 12,
    true,
  );

  const evolutionTrend =
    momentum > 2 && variability <= 1.1
      ? "improving"
      : momentum < -2
        ? "declining"
        : "stagnant";

  return {
    project_maturity_score: maturityScore,
    evolution_trend: evolutionTrend,
    signals: [
      `commit frequency over time: first-half avg ${Math.round(firstAvg)}, second-half avg ${Math.round(secondAvg)}`,
      `repo update recency coverage: ${Math.round(input.recentCoverage * 100)}%`,
      `feature expansion commits sampled: ${input.featureCommits}`,
      `commit variability ratio: ${variability.toFixed(2)}`,
    ],
  };
}
