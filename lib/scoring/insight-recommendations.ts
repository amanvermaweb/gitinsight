import type {
  ActionRecommendation,
  AnalysisInsights,
  DomainInfo,
  DomainScorecard,
  EvolutionModel,
} from "@/lib/types";

function scoreValue(metric: { evidence_score: number | "unknown"; inferred_score: number | "unknown" }) {
  const evidence = typeof metric.evidence_score === "number" ? metric.evidence_score : null;
  const inferred = typeof metric.inferred_score === "number" ? metric.inferred_score : null;

  if (evidence !== null && inferred !== null) {
    return Math.round(evidence * 0.7 + inferred * 0.3);
  }

  if (evidence !== null) {
    return evidence;
  }

  if (inferred !== null) {
    return inferred;
  }

  return 40;
}

export function buildInsights(
  domainInfo: DomainInfo,
  scorecard: DomainScorecard,
  evolution: EvolutionModel,
): AnalysisInsights {
  const entries = [
    ["system design", scorecard.system_design],
    ["execution", scorecard.execution],
    ["depth", scorecard.depth],
    ["impact", scorecard.impact],
    ["consistency", scorecard.consistency],
  ] as const;

  const ranked = [...entries]
    .map(([label, metric]) => ({ label, metric, value: scoreValue(metric) }))
    .sort((a, b) => b.value - a.value);

  const strongest = ranked[0];
  const weakest = ranked[ranked.length - 1];

  const trendText =
    evolution.evolution_trend === "insufficient evidence"
      ? "Growth trajectory is uncertain due to insufficient historical evidence"
      : evolution.evolution_trend === "improving"
        ? "Momentum is improving; convert this trend into stronger architecture artifacts"
        : evolution.evolution_trend === "declining"
          ? "Recent momentum is declining; prioritize sustained release cadence and visible updates"
          : "Momentum is stagnant; target one high-impact upgrade to change trajectory";

  return {
    key_strength: `Strong ${strongest.label} signal for ${domainInfo.primary_domain.replace("_", " ")} context (${strongest.value}/100)` ,
    biggest_gap: `${weakest.label} is the biggest gap (${weakest.value}/100) and currently limits overall engineering confidence`,
    growth_direction: trendText,
  };
}

export function buildRecommendations(
  domainInfo: DomainInfo,
  scorecard: DomainScorecard,
): ActionRecommendation[] {
  const recommendations: ActionRecommendation[] = [];

  if (scorecard.system_design.insufficient_evidence) {
    recommendations.push({
      issue: "System design evidence is limited",
      action:
        domainInfo.primary_domain === "system_software"
          ? "Add architecture notes describing concurrency model, memory boundaries, and module ownership in a top repository"
          : "Publish one architecture document per flagship repository with explicit modules, data flow, and tradeoffs",
      expected_impact: "Raises system design evidence score and domain-confidence credibility",
    });
  }

  if (scorecard.execution.insufficient_evidence) {
    recommendations.push({
      issue: "Execution signals are weak",
      action: "Add CI workflow with tests plus one deployment pipeline for a maintained project",
      expected_impact: "Improves execution evidence and reduces confidence penalty",
    });
  }

  if (scorecard.depth.insufficient_evidence) {
    recommendations.push({
      issue: "Depth is under-evidenced",
      action: "Ship a multi-module feature touching storage, API/interface, and tests in one repository",
      expected_impact: "Increases depth evidence through multi-file and complexity signals",
    });
  }

  if (recommendations.length < 3) {
    recommendations.push({
      issue: "Impact growth is constrained",
      action: "Create release notes and roadmap issues, then drive external contributions through tagged starter issues",
      expected_impact: "Improves impact and consistency through measurable community activity",
    });
  }

  return recommendations.slice(0, 3);
}

export function buildConfidenceSummary(
  domainInfo: DomainInfo,
  scorecard: DomainScorecard,
): string {
  const confidenceEntries: Array<[string, number]> = [
    ["system design", scorecard.system_design.confidence],
    ["execution", scorecard.execution.confidence],
    ["depth", scorecard.depth.confidence],
    ["impact", scorecard.impact.confidence],
    ["consistency", scorecard.consistency.confidence],
  ];

  const lowConfidenceMetrics = confidenceEntries
    .filter(([, confidence]) => confidence < 0.5)
    .map(([label]) => label);

  if (domainInfo.domain_confidence < 0.5) {
    return `Low overall confidence: mixed domain signals (${domainInfo.primary_domain}) and sparse direct evidence in ${lowConfidenceMetrics.join(", ") || "multiple metrics"}.`;
  }

  if (lowConfidenceMetrics.length > 0) {
    return `Moderate confidence: domain classification is stable, but direct evidence is limited for ${lowConfidenceMetrics.join(", ")}.`;
  }

  return "High confidence: domain classification and direct evidence are aligned across key metrics.";
}
