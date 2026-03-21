import { isRedisRestConfigured, runRedisPipeline } from "@/lib/redis-rest";
import type { ProjectType } from "@/lib/types";
import { clamp } from "@/lib/utils";

export type GitInsightScoreComponents = {
  activity: number;
  consistency: number;
  quality: number;
  impact: number;
  breadth: number;
};

export type GitInsightScoreInput = {
  commits: number;
  prs: number;
  issues: number;
  activeDays: number;
  streakDays: number;
  qualityStars: number;
  reposWithReadme: number;
  avgRepoSizeScore: number;
  impactStars: number;
  impactForks: number;
  followers: number;
  externalContributions: number;
  languages: number;
  frameworks: number;
};

export type GitInsightScoreResult = {
  finalScore: number;
  components: GitInsightScoreComponents;
};

export type GitInsightPercentileResult = {
  percentile: number;
  topPercent: number;
  totalProfiles: number;
};

export type EngineeringScoreComponents = {
  depth: number;
  systemDesign: number;
  execution: number;
  consistency: number;
  impact: number;
};

export type EngineeringScoreResult = {
  finalScore: number;
  components: EngineeringScoreComponents;
  weights: EngineeringScoreComponents;
};

export type EngineeringWeightProfile = EngineeringScoreComponents;

export const DOMAIN_ENGINEERING_SCORE_WEIGHTS: Record<
  ProjectType,
  EngineeringWeightProfile
> = {
  "web-app": {
    depth: 0.27,
    systemDesign: 0.29,
    execution: 0.2,
    consistency: 0.14,
    impact: 0.1,
  },
  "backend-service": {
    depth: 0.26,
    systemDesign: 0.3,
    execution: 0.22,
    consistency: 0.13,
    impact: 0.09,
  },
  library: {
    depth: 0.32,
    systemDesign: 0.27,
    execution: 0.17,
    consistency: 0.14,
    impact: 0.1,
  },
  "system-software": {
    depth: 0.26,
    systemDesign: 0.35,
    execution: 0.17,
    consistency: 0.12,
    impact: 0.1,
  },
  "cli-tool": {
    depth: 0.3,
    systemDesign: 0.24,
    execution: 0.2,
    consistency: 0.16,
    impact: 0.1,
  },
  "ml-project": {
    depth: 0.28,
    systemDesign: 0.24,
    execution: 0.18,
    consistency: 0.15,
    impact: 0.15,
  },
};

export const ENGINEERING_SCORE_WEIGHTS: EngineeringScoreComponents = {
  depth: 0.3,
  systemDesign: 0.25,
  execution: 0.2,
  consistency: 0.15,
  impact: 0.1,
};

export function resolveEngineeringWeights(
  projectType: ProjectType,
  options?: { lowLevelLanguageShare?: number },
): EngineeringWeightProfile {
  const base = DOMAIN_ENGINEERING_SCORE_WEIGHTS[projectType] ?? ENGINEERING_SCORE_WEIGHTS;

  // System-heavy repositories in low-level languages get additional system-design weight.
  if (projectType !== "system-software") {
    return base;
  }

  const lowLevelLanguageShare = clamp(options?.lowLevelLanguageShare ?? 0, 0, 1);
  const boost = clamp(lowLevelLanguageShare * 0.08, 0, 0.08);

  if (boost <= 0) {
    return base;
  }

  const adjusted = {
    depth: clamp(base.depth - boost * 0.45, 0.15, 0.5),
    systemDesign: clamp(base.systemDesign + boost, 0.15, 0.6),
    execution: clamp(base.execution - boost * 0.2, 0.1, 0.4),
    consistency: clamp(base.consistency - boost * 0.25, 0.08, 0.35),
    impact: base.impact,
  };

  const total =
    adjusted.depth +
    adjusted.systemDesign +
    adjusted.execution +
    adjusted.consistency +
    adjusted.impact;

  if (total <= 0) {
    return base;
  }

  return {
    depth: adjusted.depth / total,
    systemDesign: adjusted.systemDesign / total,
    execution: adjusted.execution / total,
    consistency: adjusted.consistency / total,
    impact: adjusted.impact / total,
  };
}

const SCOREBOARD_KEY = "analyze:scoreboard:v1";
const inMemoryScoreboard = new Map<string, number>();

function roundScore(value: number) {
  return Math.round(clamp(value, 0, 100));
}

function clampScore(value: number) {
  return clamp(value, 0, 100);
}

function softCap(value: number, scale: number) {
  if (value <= 0 || scale <= 0) {
    return 0;
  }

  // A smooth saturation curve that preserves separation at low/mid ranges.
  return clamp(100 * (1 - Math.exp(-value / scale)), 0, 100);
}

export function computeGitInsightScore(input: GitInsightScoreInput): GitInsightScoreResult {
  const activity = clampScore(
    softCap(input.commits, 170) * 0.55 +
      softCap(input.prs, 22) * 0.3 +
      softCap(input.issues, 30) * 0.15,
  );
  const consistency = clampScore(
    (input.activeDays / 90) * 70 + (input.streakDays / 30) * 30,
  );
  const quality = clampScore(
    softCap(input.qualityStars, 14) * 0.45 +
      softCap(input.reposWithReadme, 5) * 0.35 +
      clampScore(input.avgRepoSizeScore * 100) * 0.2,
  );
  const impact = clampScore(
    softCap(input.impactStars, 95) * 0.35 +
      softCap(input.impactForks, 35) * 0.2 +
      softCap(input.followers, 120) * 0.3 +
      softCap(input.externalContributions, 20) * 0.15,
  );
  const breadth = clampScore(
    softCap(input.languages, 8) * 0.6 + softCap(input.frameworks, 5) * 0.4,
  );

  const finalScore = roundScore(
    activity * 0.25 +
      consistency * 0.2 +
      quality * 0.2 +
      impact * 0.2 +
      breadth * 0.15,
  );

  return {
    finalScore,
    components: {
      activity: roundScore(activity),
      consistency: roundScore(consistency),
      quality: roundScore(quality),
      impact: roundScore(impact),
      breadth: roundScore(breadth),
    },
  };
}

export function computeEngineeringScore(
  components: EngineeringScoreComponents,
  weights: EngineeringWeightProfile = ENGINEERING_SCORE_WEIGHTS,
): EngineeringScoreResult {
  const bounded: EngineeringScoreComponents = {
    depth: roundScore(components.depth),
    systemDesign: roundScore(components.systemDesign),
    execution: roundScore(components.execution),
    consistency: roundScore(components.consistency),
    impact: roundScore(components.impact),
  };

  const finalScore = roundScore(
    bounded.depth * weights.depth +
      bounded.systemDesign * weights.systemDesign +
      bounded.execution * weights.execution +
      bounded.consistency * weights.consistency +
      bounded.impact * weights.impact,
  );

  return {
    finalScore,
    components: bounded,
    weights,
  };
}

export function explainEngineeringScoreChange(
  previousScore: number,
  currentScore: number,
  previous: EngineeringScoreComponents,
  current: EngineeringScoreComponents,
) {
  const scoreDelta = Math.round(currentScore - previousScore);
  const componentDeltas = (Object.keys(current) as Array<keyof EngineeringScoreComponents>)
    .map((key) => ({
      key,
      delta: Math.round(current[key] - previous[key]),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const reasons = componentDeltas
    .filter((entry) => Math.abs(entry.delta) >= 3)
    .slice(0, 3)
    .map((entry) => {
      const direction = entry.delta > 0 ? "increased" : "decreased";
      const points = Math.abs(entry.delta);
      const label =
        entry.key === "systemDesign"
          ? "System design"
          : entry.key.charAt(0).toUpperCase() + entry.key.slice(1);
      return `${label} ${direction} by ${points} points`;
    });

  if (reasons.length === 0) {
    reasons.push("No material component change (all deltas < 3 points)");
  }

  return {
    scoreDelta,
    reasons,
  };
}

function componentLabel(component: keyof GitInsightScoreComponents) {
  switch (component) {
    case "activity":
      return "Activity";
    case "consistency":
      return "Consistency";
    case "quality":
      return "Code quality proxy";
    case "impact":
      return "Impact";
    case "breadth":
      return "Tech breadth";
    default:
      return "Signal";
  }
}

export function buildScoreNarratives(components: GitInsightScoreComponents) {
  const entries = Object.entries(components) as Array<
    [keyof GitInsightScoreComponents, number]
  >;
  const strongest = [...entries].sort((a, b) => b[1] - a[1])[0];
  const weakest = [...entries].sort((a, b) => a[1] - b[1])[0];

  const strengthTextByComponent: Record<keyof GitInsightScoreComponents, string> = {
    activity: "Strength: High execution volume",
    consistency: "Strength: Consistency beast",
    quality: "Strength: Quality-first builder",
    impact: "Strength: Open-source pull",
    breadth: "Strength: Versatile stack explorer",
  };

  const weaknessTextByComponent: Record<keyof GitInsightScoreComponents, string> = {
    activity: "Weakness: Low shipping volume",
    consistency: "Weakness: Inconsistent coding cadence",
    quality: "Weakness: Code quality signal is underpowered",
    impact: "Weakness: Low open-source impact",
    breadth: "Weakness: Narrow stack coverage",
  };

  const coaching =
    weakest[0] === "impact"
      ? "You code frequently but should contribute to public repos to improve impact."
      : `Your strongest signal is ${componentLabel(strongest[0])}, but ${componentLabel(weakest[0]).toLowerCase()} is the fastest lever to raise your global rank.`;

  return {
    strongestComponent: strongest[0],
    weakestComponent: weakest[0],
    strengthLine: strengthTextByComponent[strongest[0]],
    weaknessLine: weaknessTextByComponent[weakest[0]],
    coaching,
  };
}

function toNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentileFromCounts(usersBelowOrEqual: number, totalUsers: number) {
  if (totalUsers <= 0) {
    return {
      percentile: 0,
      topPercent: 100,
      totalProfiles: 0,
    };
  }

  const percentile = clamp((usersBelowOrEqual / totalUsers) * 100, 0, 100);
  const usersAbove = Math.max(0, totalUsers - usersBelowOrEqual);
  const topPercent = clamp(Math.round(((usersAbove + 1) / totalUsers) * 100), 1, 100);

  return {
    percentile: Math.round(percentile),
    topPercent,
    totalProfiles: totalUsers,
  };
}

export async function upsertScorePercentile(
  username: string,
  score: number,
): Promise<GitInsightPercentileResult> {
  const normalizedUsername = username.trim().toLowerCase();

  if (!normalizedUsername) {
    return {
      percentile: 0,
      topPercent: 100,
      totalProfiles: 0,
    };
  }

  const boundedScore = clamp(score, 0, 100);

  if (isRedisRestConfigured()) {
    try {
      const [, totalRaw, belowOrEqualRaw] = await runRedisPipeline([
        ["ZADD", SCOREBOARD_KEY, boundedScore, normalizedUsername],
        ["ZCARD", SCOREBOARD_KEY],
        ["ZCOUNT", SCOREBOARD_KEY, "-inf", boundedScore],
      ]);

      const total = Math.max(0, Math.round(toNumber(totalRaw)));
      const belowOrEqual = Math.max(0, Math.round(toNumber(belowOrEqualRaw)));

      return percentileFromCounts(belowOrEqual, total);
    } catch {
      // Fall back to in-memory ranking when Redis is unavailable.
    }
  }

  inMemoryScoreboard.set(normalizedUsername, boundedScore);
  const scores = Array.from(inMemoryScoreboard.values());
  const total = scores.length;
  const belowOrEqual = scores.filter((entry) => entry <= boundedScore).length;

  return percentileFromCounts(belowOrEqual, total);
}

export function __resetInMemoryScoreboardForTests() {
  inMemoryScoreboard.clear();
}
