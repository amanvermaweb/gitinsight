import type {
  DomainMetricResult,
  DomainScorecard,
  ProjectType,
  RepositoryDomain,
  ScoreValue,
} from "@/lib/types";
import { clamp, roundToTenth } from "@/lib/utils";

export type DomainScoringInput = {
  domain: RepositoryDomain;
  domainConfidence: number;
  lowLevelLanguageShare: number;
  webLanguageShare: number;
  backendLanguageShare: number;
  mlLanguageShare: number;
  readmeCoverage: number;
  avgRepoSizeKb: number;
  avgContributorCount: number;
  totalStars: number;
  totalForks: number;
  contributorBase: number;
  multiFileCommitRatio: number;
  avgLinesChangedPerCommit: number;
  commitMessageQualityScore: number;
  externalContributions: number;
  deploymentDetected: boolean;
  ciCdPresent: boolean;
  testCoverageIndicators: number;
  hasAuthSystems: boolean;
  hasDbSchema: boolean;
  hasApis: boolean;
  hasModularitySignals: boolean;
  hasConcurrencySignals: boolean;
  hasPerformanceSignals: boolean;
  hasLibraryApiSignals: boolean;
  hasReusabilitySignals: boolean;
  hasCliSignals: boolean;
  hasMlSignals: boolean;
};

function avg(...values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampScore(value: number) {
  return Math.round(clamp(value, 1, 100));
}

function scoreOrUnknown(value: number, signalCount: number): ScoreValue {
  return signalCount <= 0 ? "unknown" : clampScore(value);
}

function buildMetric(
  evidence: ScoreValue,
  inferred: ScoreValue,
  confidence: number,
  notes: string,
  evidenceDetails: string[],
  inferenceFactors: string[],
): DomainMetricResult {
  const insufficientEvidence = evidence === "unknown";

  return {
    evidence_score: evidence,
    inferred_score: inferred,
    confidence: roundToTenth(clamp(confidence, 0.2, 0.98)),
    notes: insufficientEvidence ? `${notes} insufficient evidence` : notes,
    insufficient_evidence: insufficientEvidence,
    evidence: evidenceDetails,
    inference_factors: inferenceFactors,
  };
}

function scaleInferenceBoost(totalStars: number, totalForks: number, contributorBase: number) {
  return clamp(
    clamp(totalStars / 50_000, 0, 1) * 0.55 +
      clamp(totalForks / 12_000, 0, 1) * 0.25 +
      clamp(contributorBase / 800, 0, 1) * 0.2,
    0,
    1,
  );
}

function systemDesignMetric(input: DomainScoringInput): DomainMetricResult {
  const scaleBoost = scaleInferenceBoost(
    input.totalStars,
    input.totalForks,
    input.contributorBase,
  );

  if (input.domain === "web_application") {
    const directSignals = [input.hasAuthSystems, input.hasDbSchema, input.hasApis].filter(Boolean)
      .length;
    const evidence = scoreOrUnknown(
      22 * (input.hasAuthSystems ? 1 : 0) +
        26 * (input.hasDbSchema ? 1 : 0) +
        24 * (input.hasApis ? 1 : 0) +
        28 * (input.hasModularitySignals ? 1 : 0),
      directSignals + (input.hasModularitySignals ? 1 : 0),
    );
    const inferred = clampScore(avg(input.webLanguageShare * 100, input.readmeCoverage * 100) * 0.8);

    return buildMetric(
      evidence,
      inferred,
      0.5 + input.domainConfidence * 0.35,
      "Web-app system design uses auth/data/api architecture evidence",
      [
        input.hasAuthSystems ? "Auth signal detected" : "No explicit auth evidence",
        input.hasDbSchema ? "Database/schema signal detected" : "No explicit schema evidence",
        input.hasApis ? "API signal detected" : "No explicit API signal",
      ],
      [
        input.webLanguageShare > 0.45 ? "high web-language share" : "moderate web-language share",
        input.readmeCoverage >= 0.6 ? "documentation coverage above 60%" : "limited documentation coverage",
      ],
    );
  }

  if (input.domain === "system_software") {
    const directSignals = [
      input.hasConcurrencySignals,
      input.hasModularitySignals,
      input.hasPerformanceSignals,
    ].filter(Boolean).length;

    const evidence = scoreOrUnknown(
      input.lowLevelLanguageShare * 45 +
        (input.hasConcurrencySignals ? 20 : 0) +
        (input.hasModularitySignals ? 18 : 0) +
        (input.hasPerformanceSignals ? 17 : 0),
      directSignals + (input.lowLevelLanguageShare > 0.2 ? 1 : 0),
    );

    const inferred = clampScore(
      avg(
        clamp(input.avgRepoSizeKb / 4000, 0, 1) * 100,
        clamp(input.avgContributorCount / 24, 0, 1) * 100,
      ) + scaleBoost * 18,
    );

    return buildMetric(
      evidence,
      inferred,
      0.55 + input.domainConfidence * 0.32,
      "System software system design emphasizes low-level complexity, modularity, and concurrency",
      [
        `Low-level language share ${Math.round(input.lowLevelLanguageShare * 100)}%`,
        input.hasConcurrencySignals
          ? "Concurrency primitives detected"
          : "No direct concurrency primitives detected",
        input.hasPerformanceSignals
          ? "Performance and profiling signals detected"
          : "Performance signals are sparse",
      ],
      [
        input.totalStars > 100_000 ? "high star count (>100k)" : "repository scale not extreme",
        input.lowLevelLanguageShare > 0.5 ? "low-level language (C/C++/Rust/Assembly/Zig)" : "limited low-level language share",
        input.contributorBase > 500 ? "large contributor base" : "small-to-mid contributor base",
      ],
    );
  }

  if (input.domain === "library_framework") {
    const directSignals = [
      input.hasLibraryApiSignals,
      input.hasReusabilitySignals,
      input.hasModularitySignals,
    ].filter(Boolean).length;

    const evidence = scoreOrUnknown(
      (input.hasLibraryApiSignals ? 34 : 0) +
        (input.hasReusabilitySignals ? 30 : 0) +
        (input.hasModularitySignals ? 22 : 0) +
        input.readmeCoverage * 14,
      directSignals,
    );

    const inferred = clampScore(
      avg(
        input.backendLanguageShare * 100,
        input.webLanguageShare * 100,
        clamp(input.avgContributorCount / 16, 0, 1) * 100,
      ) + scaleBoost * 10,
    );

    return buildMetric(
      evidence,
      inferred,
      0.48 + input.domainConfidence * 0.34,
      "Library/framework system design focuses on API shape and reusability",
      [
        input.hasLibraryApiSignals ? "API design language detected" : "API design evidence is limited",
        input.hasReusabilitySignals
          ? "Reusability and extension language detected"
          : "Reusability evidence is limited",
      ],
      [
        input.avgContributorCount > 10 ? "broad contributor engagement" : "limited contributor engagement",
        input.readmeCoverage > 0.6 ? "strong docs imply reusable surface" : "docs not strong enough for high reusability confidence",
      ],
    );
  }

  if (input.domain === "backend_service") {
    const directSignals = [input.hasDbSchema, input.hasApis, input.hasModularitySignals].filter(Boolean)
      .length;
    const evidence = scoreOrUnknown(
      (input.hasDbSchema ? 32 : 0) +
        (input.hasApis ? 28 : 0) +
        (input.hasModularitySignals ? 24 : 0) +
        (input.hasConcurrencySignals ? 12 : 0),
      directSignals,
    );
    const inferred = clampScore(
      avg(
        input.backendLanguageShare * 100,
        clamp(input.avgRepoSizeKb / 2500, 0, 1) * 100,
      ) + scaleBoost * 12,
    );

    return buildMetric(
      evidence,
      inferred,
      0.5 + input.domainConfidence * 0.33,
      "Backend service system design uses API/data/modularity evidence",
      [
        input.hasApis ? "Service API signals detected" : "No explicit service API signals",
        input.hasDbSchema ? "Persistence/schema signals detected" : "No explicit persistence signals",
      ],
      [
        input.backendLanguageShare > 0.45 ? "high backend-language share" : "mixed backend-language share",
        input.avgRepoSizeKb > 2500 ? "large repository size" : "moderate repository size",
      ],
    );
  }

  if (input.domain === "cli_tool") {
    const directSignals = [input.hasCliSignals, input.hasModularitySignals].filter(Boolean).length;
    const evidence = scoreOrUnknown(
      (input.hasCliSignals ? 40 : 0) +
        (input.hasModularitySignals ? 25 : 0) +
        (input.hasPerformanceSignals ? 15 : 0),
      directSignals,
    );
    const inferred = clampScore(
      avg(
        input.backendLanguageShare * 100,
        clamp(input.avgRepoSizeKb / 1600, 0, 1) * 100,
      ) + scaleBoost * 10,
    );

    return buildMetric(
      evidence,
      inferred,
      0.45 + input.domainConfidence * 0.34,
      "CLI system design weights command ergonomics and modular structure",
      [
        input.hasCliSignals ? "CLI command/flag signals detected" : "CLI structure evidence is limited",
      ],
      [
        input.avgRepoSizeKb > 1500 ? "larger CLI codebase" : "compact CLI codebase",
        input.totalForks > 1000 ? "community adoption via forks" : "limited fork-based adoption",
      ],
    );
  }

  const directSignals = [input.hasMlSignals, input.hasPerformanceSignals, input.hasModularitySignals].filter(
    Boolean,
  ).length;
  const evidence = scoreOrUnknown(
    (input.hasMlSignals ? 36 : 0) +
      (input.hasPerformanceSignals ? 16 : 0) +
      (input.hasModularitySignals ? 18 : 0) +
      input.mlLanguageShare * 20,
    directSignals + (input.mlLanguageShare > 0.2 ? 1 : 0),
  );
  const inferred = clampScore(
    avg(
      input.mlLanguageShare * 100,
      clamp(input.avgRepoSizeKb / 2200, 0, 1) * 100,
      clamp(input.avgContributorCount / 18, 0, 1) * 100,
    ) + scaleBoost * 12,
  );

  return buildMetric(
    evidence,
    inferred,
    0.45 + input.domainConfidence * 0.34,
    "AI/ML system design uses pipeline, reproducibility, and performance signals",
    [input.hasMlSignals ? "Training/inference language detected" : "Model pipeline evidence is limited"],
    [
      input.mlLanguageShare > 0.45 ? "high AI/ML language share" : "partial AI/ML language share",
      input.totalStars > 50_000 ? "high star count (>50k)" : "limited star-based scale signal",
      input.avgContributorCount > 20 ? "large contributor base" : "small-to-mid contributor base",
    ],
  );
}

function depthMetric(input: DomainScoringInput): DomainMetricResult {
  const directSignals = [
    input.multiFileCommitRatio > 0.2,
    input.avgLinesChangedPerCommit > 40,
    input.commitMessageQualityScore >= 50,
  ].filter(Boolean).length;

  const evidence = scoreOrUnknown(
    input.multiFileCommitRatio * 42 +
      clamp(input.avgLinesChangedPerCommit / 220, 0, 1) * 33 +
      input.commitMessageQualityScore * 0.25,
    directSignals,
  );

  const inferred = clampScore(
    avg(
      clamp(input.avgRepoSizeKb / 2600, 0, 1) * 100,
      clamp(input.avgContributorCount / 16, 0, 1) * 100,
      input.readmeCoverage * 100,
    ) + scaleInferenceBoost(input.totalStars, input.totalForks, input.contributorBase) * 12,
  );

  return buildMetric(
    evidence,
    inferred,
    0.42 + input.domainConfidence * 0.34,
    "Depth combines direct commit complexity with repository-scale inference",
    [
      `Multi-file commit ratio ${Math.round(input.multiFileCommitRatio * 100)}%`,
      `Average lines changed ${Math.round(input.avgLinesChangedPerCommit)}`,
    ],
    [
      input.avgRepoSizeKb > 3000 ? "large codebase size" : "moderate codebase size",
      input.contributorBase > 800 ? "large contributor base" : "limited contributor base",
      input.totalStars > 75_000 ? "high star count (>75k)" : "limited star scale signal",
    ],
  );
}

function executionMetric(input: DomainScoringInput): DomainMetricResult {
  const directSignals = [input.deploymentDetected, input.ciCdPresent, input.testCoverageIndicators > 25].filter(
    Boolean,
  ).length;

  const evidence = scoreOrUnknown(
    (input.deploymentDetected ? 32 : 0) +
      (input.ciCdPresent ? 30 : 0) +
      input.testCoverageIndicators * 0.32,
    directSignals,
  );

  const inferred = clampScore(
    avg(
      clamp(input.externalContributions / 10, 0, 1) * 100,
      input.readmeCoverage * 100,
      clamp(input.avgContributorCount / 14, 0, 1) * 100,
    ),
  );

  return buildMetric(
    evidence,
    inferred,
    0.4 + input.domainConfidence * 0.3,
    "Execution emphasizes direct delivery/test automation evidence",
    [
      input.deploymentDetected ? "Deployment target detected" : "No deployment evidence",
      input.ciCdPresent ? "CI/CD signal detected" : "No CI/CD signal",
    ],
    [
      input.avgContributorCount > 10 ? "collaboration signals from contributor count" : "limited collaboration scale",
      input.readmeCoverage > 0.65 ? "docs suggest operational maturity" : "docs provide weak operational inference",
    ],
  );
}

function impactMetric(input: DomainScoringInput): DomainMetricResult {
  const directSignals = [input.totalStars > 0, input.totalForks > 0, input.externalContributions > 0].filter(
    Boolean,
  ).length;

  const evidence = scoreOrUnknown(
    clamp(input.totalStars / 450, 0, 1) * 45 +
      clamp(input.totalForks / 140, 0, 1) * 25 +
      clamp(input.externalContributions / 14, 0, 1) * 30,
    directSignals,
  );

  const inferred = clampScore(
    clamp(input.totalStars / 50_000, 0, 1) * 55 +
      clamp(input.totalForks / 12_000, 0, 1) * 25 +
      clamp(input.contributorBase / 800, 0, 1) * 20,
  );

  return buildMetric(
    evidence,
    inferred,
    0.45 + input.domainConfidence * 0.28,
    "Impact separates direct OSS traction from global scale inference",
    [
      `${input.totalStars} stars`,
      `${input.totalForks} forks`,
      `${input.externalContributions} external contribution signals`,
    ],
    [
      input.totalStars > 100_000 ? "high star count (>100k)" : "star count below hyperscale threshold",
      input.totalForks > 10_000 ? "high fork count (>10k)" : "fork count below hyperscale threshold",
      input.contributorBase > 500 ? "large contributor base" : "limited contributor-base signal",
    ],
  );
}

function consistencyMetric(input: DomainScoringInput): DomainMetricResult {
  const hasEvidence = input.multiFileCommitRatio > 0 || input.commitMessageQualityScore > 0;
  const evidence: ScoreValue = hasEvidence
    ? clampScore(
        input.multiFileCommitRatio * 24 +
          input.readmeCoverage * 18 +
          clamp(input.commitMessageQualityScore, 0, 100) * 0.22 +
          clamp(input.externalContributions / 12, 0, 1) * 36,
      )
    : "unknown";

  const inferred = clampScore(
    avg(
      input.readmeCoverage * 100,
      clamp(input.avgContributorCount / 20, 0, 1) * 100,
    ),
  );

  return buildMetric(
    evidence,
    inferred,
    0.38 + input.domainConfidence * 0.25,
    "Consistency uses shipping behavior and maintenance evidence",
    [
      `README coverage ${Math.round(input.readmeCoverage * 100)}%`,
      `External contributions ${input.externalContributions}`,
    ],
    [
      input.readmeCoverage > 0.6 ? "sustained documentation maintenance" : "documentation maintenance uncertain",
      input.avgContributorCount > 8 ? "ongoing collaborative updates" : "collaboration cadence is limited",
    ],
  );
}

export function resolveMetricScore(metric: DomainMetricResult, fallback = 50): number {
  const evidence = typeof metric.evidence_score === "number" ? metric.evidence_score : null;
  const inferred = typeof metric.inferred_score === "number" ? metric.inferred_score : null;
  const confidence = clamp(metric.confidence, 0.2, 0.95);
  const confidencePenalty = (1 - confidence) * 12;

  if (evidence === null && inferred === null) {
    return clampScore(fallback - confidencePenalty);
  }

  if (evidence !== null && inferred === null) {
    return clampScore(evidence * (0.9 + confidence * 0.1) - confidencePenalty * 0.5);
  }

  if (evidence === null && inferred !== null) {
    // Never fully trust inference-only signals without direct evidence.
    const conservative = inferred * (0.55 + confidence * 0.15) + fallback * 0.3;
    return clampScore(conservative - confidencePenalty);
  }

  // Explicitly narrow for TypeScript before blending.
  if (evidence === null || inferred === null) {
    return clampScore(fallback - confidencePenalty);
  }

  const evidenceWeight = clamp(0.68 + confidence * 0.2, 0.62, 0.9);
  const inferredWeight = 1 - evidenceWeight;
  const blended = evidence * evidenceWeight + inferred * inferredWeight;

  return clampScore(blended - confidencePenalty * 0.6);
}

export function domainToProjectType(domain: RepositoryDomain): ProjectType {
  switch (domain) {
    case "web_application":
      return "web-app";
    case "backend_service":
      return "backend-service";
    case "system_software":
      return "system-software";
    case "library_framework":
      return "library";
    case "cli_tool":
      return "cli-tool";
    case "ai_ml_project":
      return "ml-project";
    default:
      return "library";
  }
}

export function buildDomainScorecard(input: DomainScoringInput): DomainScorecard {
  return {
    domain: input.domain,
    system_design: systemDesignMetric(input),
    execution: executionMetric(input),
    depth: depthMetric(input),
    impact: impactMetric(input),
    consistency: consistencyMetric(input),
  };
}
