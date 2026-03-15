export type ThemeMode = "dark" | "light";

export type AnalysisData = {
  username: string;
  score: number;
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
};

export type AnalyzeApiResponse = {
  analysis: AnalysisData;
  source: "github";
  warning?: string;
  cachedAi?: boolean;
};
