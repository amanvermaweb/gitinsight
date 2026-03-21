import { describe, expect, it } from "vitest";
import { detectRepositoryDomain } from "@/lib/scoring/domain-detection";
import {
  buildDomainScorecard,
  domainToProjectType,
  resolveMetricScore,
} from "@/lib/scoring/domain-strategies";

describe("domain-aware scoring", () => {
  it("classifies system software from low-level signals", () => {
    const detection = detectRepositoryDomain({
      corpus:
        "kernel driver scheduler memory allocator syscall thread mutex performance profiling",
      repositoryCount: 8,
      languageTotals: new Map([
        ["C", 900_000],
        ["Rust", 300_000],
        ["Python", 40_000],
      ]),
      totalLanguageBytes: 1_240_000,
      sampledPaths: ["kernel/sched/core.c", "drivers/net/eth.c", "arch/x86/mm/init.c"],
    });

    expect(detection.domain).toBe("system_software");
    expect(detection.confidence).toBeGreaterThan(0.5);
    expect(detection.primary_domain).toBe("system_software");
    expect(domainToProjectType(detection.domain)).toBe("system-software");
  });

  it("marks mixed-domain repositories as multi-domain", () => {
    const detection = detectRepositoryDomain({
      corpus:
        "react next api service worker cli command subcommand auth postgres sdk package",
      repositoryCount: 6,
      languageTotals: new Map([
        ["TypeScript", 700_000],
        ["JavaScript", 240_000],
        ["Go", 210_000],
      ]),
      totalLanguageBytes: 1_150_000,
      sampledPaths: ["app/page.tsx", "api/routes.ts", "cmd/main.ts"],
    });

    expect(detection.is_multi_domain).toBe(true);
    expect(detection.secondary_domains.length).toBeGreaterThan(0);
  });

  it("reports insufficient evidence instead of forcing zero", () => {
    const scorecard = buildDomainScorecard({
      domain: "library_framework",
      domainConfidence: 0.42,
      lowLevelLanguageShare: 0,
      webLanguageShare: 0.1,
      backendLanguageShare: 0.2,
      mlLanguageShare: 0,
      readmeCoverage: 0.2,
      avgRepoSizeKb: 50,
      avgContributorCount: 1,
      totalStars: 0,
      totalForks: 0,
      contributorBase: 1,
      multiFileCommitRatio: 0,
      avgLinesChangedPerCommit: 0,
      commitMessageQualityScore: 0,
      externalContributions: 0,
      deploymentDetected: false,
      ciCdPresent: false,
      testCoverageIndicators: 0,
      hasAuthSystems: false,
      hasDbSchema: false,
      hasApis: false,
      hasModularitySignals: false,
      hasConcurrencySignals: false,
      hasPerformanceSignals: false,
      hasLibraryApiSignals: false,
      hasReusabilitySignals: false,
      hasCliSignals: false,
      hasMlSignals: false,
    });

    expect(scorecard.system_design.evidence_score).toBe("unknown");
    expect(scorecard.system_design.notes).toContain("insufficient evidence");
    expect(resolveMetricScore(scorecard.system_design, 43)).toBeGreaterThan(0);
  });

  it("applies scale-aware inferred boost for large repos", () => {
    const scorecard = buildDomainScorecard({
      domain: "system_software",
      domainConfidence: 0.8,
      lowLevelLanguageShare: 0.75,
      webLanguageShare: 0.03,
      backendLanguageShare: 0.22,
      mlLanguageShare: 0,
      readmeCoverage: 0.5,
      avgRepoSizeKb: 5200,
      avgContributorCount: 40,
      totalStars: 120_000,
      totalForks: 45_000,
      contributorBase: 4000,
      multiFileCommitRatio: 0.6,
      avgLinesChangedPerCommit: 210,
      commitMessageQualityScore: 72,
      externalContributions: 18,
      deploymentDetected: false,
      ciCdPresent: true,
      testCoverageIndicators: 35,
      hasAuthSystems: false,
      hasDbSchema: false,
      hasApis: false,
      hasModularitySignals: true,
      hasConcurrencySignals: true,
      hasPerformanceSignals: true,
      hasLibraryApiSignals: false,
      hasReusabilitySignals: false,
      hasCliSignals: false,
      hasMlSignals: false,
    });

    expect(typeof scorecard.system_design.inferred_score).toBe("number");
    expect((scorecard.system_design.inferred_score as number) >= 70).toBe(true);
    expect(scorecard.system_design.inference_factors.length).toBeGreaterThan(0);
  });

  it("does not over-trust inference-only metrics", () => {
    const resolved = resolveMetricScore(
      {
        evidence_score: "unknown",
        inferred_score: 90,
        confidence: 0.3,
        notes: "inference-only",
        insufficient_evidence: true,
        evidence: ["insufficient evidence"],
        inference_factors: ["high star count (>100k)"],
      },
      50,
    );

    expect(resolved).toBeLessThan(90);
  });
});
