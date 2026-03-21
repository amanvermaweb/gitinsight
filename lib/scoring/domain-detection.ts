import type { RepositoryDomain } from "@/lib/types";
import { clamp, roundToTenth } from "@/lib/utils";

export type DomainDetectionInput = {
  corpus: string;
  repositoryCount: number;
  languageTotals: Map<string, number>;
  totalLanguageBytes: number;
  sampledPaths: string[];
};

export type DomainDetectionResult = {
  primary_domain: RepositoryDomain;
  domain_confidence: number;
  secondary_domains: RepositoryDomain[];
  is_multi_domain: boolean;
  evidence: string[];
  scoreByDomain: Record<RepositoryDomain, number>;
  // Backward-compatible aliases used by existing call sites.
  domain: RepositoryDomain;
  confidence: number;
  shares: {
    lowLevel: number;
    web: number;
    backend: number;
    ml: number;
  };
};

function languageShare(
  languageTotals: Map<string, number>,
  totalLanguageBytes: number,
  languageNames: string[],
) {
  const bytes = languageNames.reduce(
    (sum, language) => sum + (languageTotals.get(language) ?? 0),
    0,
  );

  return clamp(bytes / Math.max(1, totalLanguageBytes), 0, 1);
}

function keywordScore(corpus: string, patterns: RegExp[], perHit: number) {
  const hits = patterns.filter((pattern) => pattern.test(corpus)).length;
  return hits * perHit;
}

function pathScore(paths: string[], patterns: RegExp[], perHit: number) {
  const joined = paths.join(" ").toLowerCase();
  const hits = patterns.filter((pattern) => pattern.test(joined)).length;
  return hits * perHit;
}

function scoreCap(value: number) {
  return Math.round(clamp(value, 0, 100));
}

export function detectRepositoryDomain(input: DomainDetectionInput): DomainDetectionResult {
  const corpus = input.corpus.toLowerCase();
  const paths = input.sampledPaths;

  const lowLevelShare = languageShare(
    input.languageTotals,
    input.totalLanguageBytes,
    ["C", "C++", "Rust", "Assembly", "Zig"],
  );
  const webShare = languageShare(
    input.languageTotals,
    input.totalLanguageBytes,
    ["TypeScript", "JavaScript", "HTML", "CSS"],
  );
  const backendShare = languageShare(
    input.languageTotals,
    input.totalLanguageBytes,
    ["Go", "Rust", "Java", "Python", "Ruby", "PHP", "C#", "Kotlin"],
  );
  const mlShare = languageShare(
    input.languageTotals,
    input.totalLanguageBytes,
    ["Python", "Jupyter Notebook", "R", "Julia"],
  );

  const webApplication = scoreCap(
    webShare * 40 +
      keywordScore(
        corpus,
        [
          /\bnext\b/i,
          /\breact\b/i,
          /\bfrontend\b/i,
          /\bauth\b/i,
          /\broute\b/i,
          /\bcomponent\b/i,
        ],
        8,
      ) +
      pathScore(paths, [/\bapp\//i, /\bpages\//i, /\bcomponents\//i, /\bclient\//i], 5),
  );

  const backendService = scoreCap(
    backendShare * 38 +
      keywordScore(
        corpus,
        [
          /\bservice\b/i,
          /\bapi\b/i,
          /\bworker\b/i,
          /\bqueue\b/i,
          /\bmicroservice\b/i,
          /\bgrpc\b/i,
          /\bpostgres\b/i,
        ],
        7,
      ) +
      pathScore(paths, [/\bserver\//i, /\binternal\//i, /\bapi\//i, /\bcmd\//i], 5),
  );

  const systemSoftware = scoreCap(
    lowLevelShare * 48 +
      keywordScore(
        corpus,
        [
          /\bkernel\b/i,
          /\bdriver\b/i,
          /\bcompiler\b/i,
          /\bsyscall\b/i,
          /\bthread\b/i,
          /\bmutex\b/i,
          /\bmemory\b/i,
        ],
        7,
      ) +
      pathScore(paths, [/\bkernel\//i, /\bdrivers\//i, /\barch\//i, /\bsrc\/core\//i], 6),
  );

  const libraryFramework = scoreCap(
    keywordScore(
      corpus,
      [
        /\blibrary\b/i,
        /\bsdk\b/i,
        /\bframework\b/i,
        /\bpackage\b/i,
        /\bmodule\b/i,
        /\bplugin\b/i,
      ],
      10,
    ) +
      pathScore(paths, [/\bsrc\/lib\//i, /\binclude\//i, /\bpackages\//i], 6) +
      backendShare * 16 +
      webShare * 12,
  );

  const cliTool = scoreCap(
    keywordScore(
      corpus,
      [
        /\bcli\b/i,
        /\bcommand line\b/i,
        /\bterminal\b/i,
        /\bsubcommand\b/i,
        /\bflags?\b/i,
        /\bargparse\b/i,
      ],
      11,
    ) +
      pathScore(paths, [/\bcmd\//i, /\bbin\//i, /\bcommands?\//i], 7) +
      backendShare * 14,
  );

  const aiMlProject = scoreCap(
    mlShare * 42 +
      keywordScore(
        corpus,
        [
          /\bmachine learning\b/i,
          /\bdeep learning\b/i,
          /\btraining\b/i,
          /\binference\b/i,
          /\bdataset\b/i,
          /\bpytorch\b/i,
          /\btensorflow\b/i,
        ],
        8,
      ) +
      pathScore(paths, [/\bnotebooks?\//i, /\bmodels?\//i, /\bdatasets?\//i], 6),
  );

  const scoreByDomain: Record<RepositoryDomain, number> = {
    web_application: webApplication,
    backend_service: backendService,
    system_software: systemSoftware,
    library_framework: libraryFramework,
    cli_tool: cliTool,
    ai_ml_project: aiMlProject,
  };

  const ranked = (Object.entries(scoreByDomain) as Array<[RepositoryDomain, number]>).sort(
    (first, second) => second[1] - first[1],
  );

  const [topDomain, topScore] = ranked[0] ?? ["web_application", 0];
  const [, runnerScore] = ranked[1] ?? ["web_application", 0];
  const margin = Math.max(0, topScore - runnerScore);

  const secondaryDomains = ranked
    .slice(1)
    .filter(([, score]) => score >= topScore - 18 || score >= topScore * 0.8)
    .slice(0, 2)
    .map(([domain]) => domain);
  const isMultiDomain = secondaryDomains.length > 0;

  const confidence = roundToTenth(
    clamp(
      0.35 +
        clamp(topScore / 100, 0, 0.35) +
        clamp(margin / 80, 0, 0.2) +
        clamp(input.repositoryCount / 12, 0, 0.1) -
        (isMultiDomain ? 0.08 : 0),
      0.25,
      0.95,
    ),
  );

  const uncertaintyLine =
    confidence < 0.5
      ? "Low classifier confidence: mixed repository signals create uncertainty."
      : isMultiDomain
        ? `Multi-domain classification: secondary signals in ${secondaryDomains.join(", ")}.`
        : "Primary domain classification is stable.";

  return {
    primary_domain: topDomain,
    domain_confidence: confidence,
    secondary_domains: secondaryDomains,
    is_multi_domain: isMultiDomain,
    domain: topDomain,
    confidence,
    scoreByDomain,
    shares: {
      lowLevel: lowLevelShare,
      web: webShare,
      backend: backendShare,
      ml: mlShare,
    },
    evidence: [
      `Domain classifier top score: ${topDomain} (${topScore})`,
      `Runner-up score: ${runnerScore}; margin ${margin}`,
      `Language shares - low-level ${Math.round(lowLevelShare * 100)}%, web ${Math.round(
        webShare * 100,
      )}%, backend ${Math.round(backendShare * 100)}%, AI/ML ${Math.round(mlShare * 100)}%`,
      `Classification evaluated over ${input.repositoryCount} repositories and ${paths.length} sampled paths`,
      uncertaintyLine,
    ],
  };
}
