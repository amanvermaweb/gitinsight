"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type SubmitEvent } from "react";
import { fetchLiveAnalysis } from "@/lib/api-client";
import { DEFAULT_USERNAME } from "@/lib/constants";
import type { AnalysisData } from "@/lib/types";
import { isValidGitHubUsername, normalizeUsername } from "@/lib/utils";
import {
  AppShell,
  usePersistedTheme,
} from "./primitives";
import {
  DashboardHeader,
  HeroSection,
  OverviewSection,
  RepositoryInsightsSection,
  SkillsAndFeedbackSection,
} from "./dashboard-sections";

type GitInsightDashboardProps = {
  initialUsername: string;
};

export function GitInsightDashboard({
  initialUsername,
}: GitInsightDashboardProps) {
  const router = useRouter();
  const [theme, setTheme] = usePersistedTheme();
  const [usernameInput, setUsernameInput] = useState(normalizeUsername(initialUsername));
  const [error, setError] = useState<string | null>(null);
  const [analysisNotice, setAnalysisNotice] = useState<string | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);

  useEffect(() => {
    setUsernameInput(normalizeUsername(initialUsername));
  }, [initialUsername]);

  useEffect(() => {
    const normalizedUsername = normalizeUsername(initialUsername) || DEFAULT_USERNAME;
    const controller = new AbortController();

    const hydrateAnalysis = async () => {
      setAnalysisLoading(true);
      setAnalysis(null);
      setAnalysisNotice(null);

      try {
        const response = await fetchLiveAnalysis(normalizedUsername, controller.signal);
        setAnalysis(response.analysis);
        setAnalysisNotice(response.warning ?? null);
      } catch (caughtError) {
        if (controller.signal.aborted) {
          return;
        }

        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "Live analysis failed. No analysis data is available right now.";

        setAnalysis(null);
        setAnalysisNotice(message);
      } finally {
        if (!controller.signal.aborted) {
          setAnalysisLoading(false);
        }
      }
    };

    void hydrateAnalysis();

    return () => {
      controller.abort();
    };
  }, [initialUsername]);

  const handleReanalyze = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextUsername = normalizeUsername(usernameInput);

    if (!isValidGitHubUsername(nextUsername)) {
      setError("Enter a valid GitHub username to open another analysis.");
      return;
    }

    setError(null);
    startTransition(() => {
      router.push(`/analyze/${encodeURIComponent(nextUsername)}`);
    });
  };

  const headerUsername =
    analysis?.username ?? (normalizeUsername(initialUsername) || DEFAULT_USERNAME);

  return (
    <AppShell theme={theme}>
      <main className="relative mx-auto flex min-h-screen w-full max-w-370 flex-col gap-10 px-4 pb-12 pt-4 sm:px-6 sm:pb-16 lg:px-8">
        <DashboardHeader
          username={headerUsername}
          theme={theme}
          onThemeChange={setTheme}
        />

        <HeroSection
          analysis={analysis}
          usernameInput={usernameInput}
          onUsernameChange={setUsernameInput}
          onSubmit={handleReanalyze}
          isPending={isPending}
          isLoading={analysisLoading}
          notice={analysisNotice}
          error={error}
        />

        {analysis ? (
          <>
            <OverviewSection analysis={analysis} />
            <RepositoryInsightsSection analysis={analysis} />
            <SkillsAndFeedbackSection analysis={analysis} />
          </>
        ) : null}
      </main>
    </AppShell>
  );
}
