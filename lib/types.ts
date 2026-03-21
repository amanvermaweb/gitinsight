export type ThemeMode = "dark" | "light";

export type ProjectType =
  | "web-app"
  | "backend-service"
  | "library"
  | "system-software"
  | "cli-tool"
  | "ml-project";

export type RepositoryDomain =
  | "web_application"
  | "backend_service"
  | "system_software"
  | "library_framework"
  | "cli_tool"
  | "ai_ml_project";

export type ScoreValue = number | "unknown";

export type DomainMetricResult = {
  evidence_score: ScoreValue;
  inferred_score: ScoreValue;
  confidence: number;
  notes: string;
  insufficient_evidence: boolean;
  evidence: string[];
  inference_factors: string[];
};

export type DomainScorecard = {
  domain: RepositoryDomain;
  system_design: DomainMetricResult;
  execution: DomainMetricResult;
  depth: DomainMetricResult;
  impact: DomainMetricResult;
  consistency: DomainMetricResult;
};

export type DomainInfo = {
  primary_domain: RepositoryDomain;
  domain_confidence: number;
  secondary_domains: RepositoryDomain[];
  is_multi_domain: boolean;
};

export type EvolutionTrend = "improving" | "stagnant" | "declining" | "insufficient evidence";

export type EvolutionModel = {
  project_maturity_score: ScoreValue;
  evolution_trend: EvolutionTrend;
  signals: string[];
};

export type AnalysisInsights = {
  key_strength: string;
  biggest_gap: string;
  growth_direction: string;
};

export type ActionRecommendation = {
  issue: string;
  action: string;
  expected_impact: string;
};

export type AnalysisMetadata = {
  confidence_summary: string;
  project_maturity_score?: ScoreValue;
  evolution_trend?: EvolutionTrend;
};

export type EvidenceFinding = {
  claim: string;
  evidence: string[];
  category: "strength" | "weakness" | "risk";
};

export type ScoreTimePoint = {
  label: string;
  score: number;
};

export type SkillEvolutionPoint = {
  label: string;
  before: number;
  current: number;
};

export type DeveloperSignalEngine = {
  depth: {
    score: number;
    multiFileCommitRatio: number;
    avgLinesChangedPerCommit: number;
    commitMessageQualityScore: number;
    refactorToFeatureRatio: number;
    evidence: string[];
  };
  systemDesign: {
    score: number;
    projectType: ProjectType;
    detectionConfidence: number;
    scoreConfidence: number;
    unclearReason?: string;
    hasAuthSystems: boolean;
    hasDbSchema: boolean;
    hasApis: boolean;
    modularityScore: number;
    concurrencyScore: number;
    lowLevelComplexityScore: number;
    performanceConsiderationsScore: number;
    libraryApiDesignScore: number;
    reusabilityScore: number;
    abstractionQualityScore: number;
    backendComplexityScore: number;
    frontendStateManagementComplexityScore: number;
    evidence: string[];
  };
  execution: {
    score: number;
    deploymentDetected: boolean;
    deploymentTargets: string[];
    ciCdPresent: boolean;
    testCoverageIndicators: number;
    evidence: string[];
  };
  consistency: {
    score: number;
    commitFrequencyVariance: number;
    projectCompletionRate: number;
    repoAbandonmentRate: number;
    evidence: string[];
  };
  impact: {
    score: number;
    totalStars: number;
    totalForks: number;
    followers: number;
    externalContributions: number;
    evidence: string[];
  };
};

export type AnalysisData = {
  username: string;
  score: number;
  confidence: number;
  followers: number;
  totalStars: number;
  repositoriesAnalyzed: number;
  benchmarkDelta: string;
  headline: string;
  summary: string;
  highlights: string[];
  breakdown: Array<{
    label: string;
    value: number;
    note: string;
  }>;
  activity: Array<{
    label: string;
    value: number;
  }>;
  repositories: Array<{
    name: string;
    stack: string[];
    stars: number;
    commits: number;
    quality: number;
    readme: string;
    recommendation: string;
    note: string;
    velocity: number[];
  }>;
  skills: Array<{
    label: string;
    value: number;
  }>;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  domain_info?: DomainInfo;
  developerSignals?: DeveloperSignalEngine;
  domainScorecard?: DomainScorecard;
  scorecard?: DomainScorecard;
  evolution?: EvolutionModel;
  project_maturity_score?: ScoreValue;
  evolution_trend?: EvolutionTrend;
  insights?: AnalysisInsights;
  recommendations?: ActionRecommendation[];
  metadata?: AnalysisMetadata;
  evidenceFindings?: EvidenceFinding[];
  fakeDevDetector?: {
    riskScore: number;
    verdict: "low-risk" | "medium-risk" | "high-risk";
    signals: string[];
    evidence: string[];
  };
  scoreTrajectory?: {
    scoreOverTime: ScoreTimePoint[];
    commitQualityOverTime: ScoreTimePoint[];
    skillEvolution: SkillEvolutionPoint[];
  };
  scoreMeta?: {
    archetype: string;
    averageDeveloperScore: number;
    topPercent?: number;
    benchmarkProfiles?: number;
    scoreModel?: {
      projectType?: ProjectType;
      domain?: RepositoryDomain;
      classificationConfidence?: number;
      weights: {
        depth: number;
        systemDesign: number;
        execution: number;
        consistency: number;
        impact: number;
      };
      components: {
        depth: number;
        systemDesign: number;
        execution: number;
        consistency: number;
        impact: number;
      };
      previousScore?: number;
      scoreDelta?: number;
      changeReasons?: string[];
    };
    nextLevel?: {
      targetTopPercent: number;
      starsNeeded: number;
      externalContributionsNeeded: number;
      commitsNeeded: number;
    };
  };
};

export type AnalyzeApiResponse = {
  analysis: AnalysisData;
  source: "github";
  warning?: string;
  cachedAi?: boolean;
};
