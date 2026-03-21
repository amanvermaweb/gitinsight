"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchSharedAnalysis } from "@/lib/api-client";
import type { AnalysisData } from "@/lib/types";
import { AppShell, Panel, usePersistedTheme } from "./primitives";

type ShareCardProps = {
  username: string;
};

export function GitInsightShareCard({ username }: ShareCardProps) {
  const [theme] = usePersistedTheme();
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        const response = await fetchSharedAnalysis(username, controller.signal);
        setAnalysis(response.analysis);
      } catch (caughtError) {
        if (controller.signal.aborted) {
          return;
        }

        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to load shared analysis snapshot.",
        );
      }
    };

    void load();

    return () => controller.abort();
  }, [username]);

  const handleShare = async () => {
    if (!analysis || typeof window === "undefined") {
      return;
    }

    const shareUrl = `${window.location.origin}/analyze/${encodeURIComponent(analysis.username)}/share`;
    setSharing(true);

    try {
      if (navigator.share) {
        await navigator.share({
          url: shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
      }
    } finally {
      setSharing(false);
    }
  };

  return (
    <AppShell theme={theme}>
      <main className="relative mx-auto flex min-h-screen w-full max-w-270 flex-col gap-6 px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href={`/analyze/${encodeURIComponent(username)}`}
            className="rounded-full border border-white/10 bg-white/6 px-4 py-2 text-sm text-(--foreground) transition hover:bg-white/10"
          >
            Back to dashboard
          </Link>
          <button
            type="button"
            onClick={handleShare}
            disabled={!analysis || sharing}
            className="cursor-pointer rounded-full border border-(--accent)/40 bg-(--accent-soft) px-4 py-2 text-sm font-medium text-(--foreground) transition hover:bg-(--accent)/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sharing ? "Sharing..." : "Share your GitInsight"}
          </button>
        </div>

        <Panel className="p-6 sm:p-7">
          {error ? (
            <p className="text-sm text-(--muted-strong)">{error}</p>
          ) : null}

          {!analysis && !error ? (
            <p className="text-sm text-(--muted-strong)">Loading share card...</p>
          ) : null}

          {analysis ? (
            <div className="space-y-6">
              <div>
                <p className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-(--muted)">
                  GitInsight share card
                </p>
                <h1 className="mt-3 break-all text-4xl font-semibold tracking-[-0.05em] text-(--foreground)">
                  @{analysis.username}
                </h1>
                <p className="mt-2 text-sm text-(--accent-strong)">
                  Archetype: {analysis.scoreMeta?.archetype ?? "Quality-Focused Builder"}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-[20px] border border-white/10 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-(--muted)">Score</p>
                  <p className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-(--foreground)">
                    {analysis.score}/100
                  </p>
                </div>
                <div className="rounded-[20px] border border-white/10 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-(--muted)">Rank</p>
                  <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-(--foreground)">
                    {analysis.benchmarkDelta}
                  </p>
                </div>
                <div className="rounded-[20px] border border-white/10 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-(--muted)">You vs average</p>
                  <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-(--foreground)">
                    {analysis.score} vs {analysis.scoreMeta?.averageDeveloperScore ?? 56}
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {analysis.breakdown.map((metric) => (
                  <div
                    key={metric.label}
                    className="rounded-[18px] border border-white/10 bg-white/5 p-4"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm text-(--muted-strong)">{metric.label}</p>
                      <p className="font-mono text-sm text-(--foreground)">{metric.value}</p>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-white/8">
                      <div
                        className="h-full rounded-full bg-[linear-gradient(90deg,var(--accent-strong),var(--warm))]"
                        style={{ width: `${metric.value}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Panel>
      </main>
    </AppShell>
  );
}
