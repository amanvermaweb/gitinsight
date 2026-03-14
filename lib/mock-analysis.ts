import type { AnalysisData } from "./types";
import { clamp, normalizeUsername, roundToTenth, seedFromUsername } from "./utils";

export function buildAnalysis(rawUsername: string): AnalysisData {
  const username = normalizeUsername(rawUsername) || "sindresorhus";
  const seed = seedFromUsername(username.toLowerCase());
  const score = roundToTenth(7.7 + (seed % 15) / 10);
  const followers = 1200 + (seed % 4100);
  const totalStars = 4100 + (seed % 9300);
  const repositoriesAnalyzed = 12 + (seed % 15);

  const breakdownBase = [
    { label: "Code quality", value: 8.4, note: "Healthy module boundaries and low entropy in file structure." },
    { label: "Documentation", value: 7.8, note: "Readmes explain intent well, but setup friction remains in some repos." },
    { label: "Project originality", value: 8.6, note: "The portfolio contains clear product thinking rather than tutorial clones." },
    { label: "Open source activity", value: 7.9, note: "Commit cadence is consistent, though maintenance signals vary by project." },
    { label: "Portfolio completeness", value: 8.2, note: "Public work covers multiple surfaces, but curation can be sharper." },
  ];

  const breakdown = breakdownBase.map((metric, index) => ({
    ...metric,
    value: roundToTenth(
      clamp(metric.value + (((seed >> (index + 1)) % 7) - 3) * 0.17, 6.5, 9.7),
    ),
  }));

  const repositories = [
    {
      name: `${username}/signal-foundry`,
      stack: ["Next.js", "TypeScript", "OpenAI"],
      stars: 420 + (seed % 610),
      commits: 82 + (seed % 66),
      quality: roundToTenth(clamp(breakdown[0].value + 0.3, 7.1, 9.8)),
      readme: "Clear framing, strong architecture diagram, concise usage path.",
      recommendation: "Add a decision log for AI prompt changes to strengthen maintainability signals.",
      note: "Strong product framing and precise implementation detail.",
      velocity: [7, 10, 8, 11, 9, 12, 10],
    },
    {
      name: `${username}/merge-lab`,
      stack: ["Go", "PostgreSQL", "Docker"],
      stars: 170 + ((seed * 2) % 340),
      commits: 56 + ((seed * 3) % 70),
      quality: roundToTenth(clamp(breakdown[3].value + 0.2, 6.9, 9.5)),
      readme: "Good deployment coverage, but the value proposition is undersold above the fold.",
      recommendation: "Expose benchmark screenshots and one production-scale case study.",
      note: "Operational maturity is visible from CI and container discipline.",
      velocity: [5, 7, 9, 8, 10, 8, 9],
    },
    {
      name: `${username}/pattern-codex`,
      stack: ["React", "Storybook", "Turborepo"],
      stars: 260 + ((seed * 5) % 500),
      commits: 48 + ((seed * 7) % 54),
      quality: roundToTenth(clamp(breakdown[1].value + 0.4, 6.8, 9.4)),
      readme: "Polished examples and strong onboarding, missing maintenance boundaries.",
      recommendation: "Call out versioning guarantees and deprecation strategy more explicitly.",
      note: "Visual craft stands out immediately to reviewers.",
      velocity: [4, 6, 7, 7, 8, 9, 8],
    },
    {
      name: `${username}/infra-bench`,
      stack: ["Rust", "Kubernetes", "Grafana"],
      stars: 140 + ((seed * 11) % 310),
      commits: 34 + ((seed * 13) % 45),
      quality: roundToTenth(clamp(breakdown[2].value - 0.1, 6.7, 9.2)),
      readme: "Technical depth is obvious, but the user outcome needs more narrative context.",
      recommendation: "Lead with the performance story, then move into benchmark methodology.",
      note: "Advanced systems work gives the portfolio range and credibility.",
      velocity: [3, 4, 6, 5, 7, 8, 6],
    },
  ];

  const activity = [
    { label: "Jan", value: 58 + (seed % 15) },
    { label: "Feb", value: 64 + ((seed >> 1) % 15) },
    { label: "Mar", value: 71 + ((seed >> 2) % 13) },
    { label: "Apr", value: 67 + ((seed >> 3) % 17) },
    { label: "May", value: 80 + ((seed >> 4) % 12) },
    { label: "Jun", value: 76 + ((seed >> 5) % 15) },
    { label: "Jul", value: 88 + ((seed >> 6) % 10) },
  ];

  const skills = [
    { label: "Frontend", value: clamp(72 + (seed % 18), 58, 95) },
    { label: "Backend", value: clamp(68 + ((seed >> 1) % 20), 54, 94) },
    { label: "DevOps", value: clamp(54 + ((seed >> 2) % 24), 42, 90) },
    { label: "Algorithms", value: clamp(48 + ((seed >> 3) % 28), 38, 88) },
    { label: "AI / ML", value: clamp(62 + ((seed >> 4) % 22), 46, 91) },
  ];

  return {
    username,
    score,
    followers,
    totalStars,
    repositoriesAnalyzed,
    benchmarkDelta: `Top ${clamp(Math.round(19 - score), 6, 18)}% of public technical portfolios`,
    headline: "Elite signal density with room to sharpen presentation.",
    summary:
      "GitInsight sees strong execution, consistent shipping behavior, and above-average technical range. The remaining upside comes from tighter storytelling and clearer proof of impact.",
    highlights: [
      "High-leverage repo selection with credible production depth",
      "Strong maintainability patterns across the most visible projects",
      "Clear AI and infrastructure exposure without looking trend-chasing",
    ],
    breakdown,
    activity,
    repositories,
    skills,
    strengths: [
      `${username} has a portfolio that signals real product work rather than experimental clutter.`,
      "The strongest repositories show thoughtful architecture and a preference for durable tooling decisions.",
      "Naming, information hierarchy, and public repo curation are well above the median GitHub profile.",
    ],
    weaknesses: [
      "A few repositories lead with implementation before communicating business or user value.",
      "Documentation quality is uneven between flagship projects and older utilities.",
      "The portfolio would benefit from a more explicit narrative around scale, adoption, and outcomes.",
    ],
    suggestions: [
      "Promote one flagship repository into a canonical case study with outcomes, constraints, and tradeoffs.",
      "Add concise architecture notes to the most technically ambitious repos to increase reviewer confidence quickly.",
      "Archive or consolidate lower-signal projects so the public profile feels even more deliberate.",
    ],
  };
}
