"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  API_KEY_STORAGE_KEY,
  DEFAULT_USERNAME,
  LANDING_QUICK_PROFILES,
  sectionTransition,
} from "@/lib/gitinsight/constants";
import { isValidGitHubUsername, normalizeUsername } from "@/lib/gitinsight/utils";
import {
  AppShell,
  GitInsightMark,
  Panel,
  SurfaceLabel,
  ThemeToggle,
  usePersistedTheme,
} from "./gitinsight-primitives";
import { GitInsightLandingForm } from "./gitinsight-landing-form";
import { readSessionStorageValue } from "./gitinsight-storage";

export function GitInsightLanding() {
  const router = useRouter();
  const [theme, setTheme] = usePersistedTheme();
  const [username, setUsername] = useState(DEFAULT_USERNAME);
  const [apiKey, setApiKey] = useState(() =>
    readSessionStorageValue(API_KEY_STORAGE_KEY),
  );
  const [showApiKey, setShowApiKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextUsername = normalizeUsername(username) || DEFAULT_USERNAME;
    const nextApiKey = apiKey.trim();

    if (!isValidGitHubUsername(nextUsername)) {
      setError("Enter a valid GitHub username before starting the analysis.");
      return;
    }

    if (!nextApiKey) {
      setError(
        "Enter your API key. GitInsight keeps it in this browser session and does not place it in the URL.",
      );
      return;
    }

    window.sessionStorage.setItem(API_KEY_STORAGE_KEY, nextApiKey);
    setError(null);

    startTransition(() => {
      router.push(`/analyze/${encodeURIComponent(nextUsername)}`);
    });
  };

  return (
    <AppShell theme={theme}>
      <main className="relative mx-auto flex min-h-screen w-full max-w-[1240px] flex-col px-4 pb-10 pt-4 sm:px-6 lg:px-8">
        <header className="sticky top-4 z-40">
          <div className="flex items-center justify-between gap-4 rounded-[28px] border border-white/8 bg-[color:var(--nav)] px-4 py-3 shadow-[0_16px_40px_rgba(0,0,0,0.22)] backdrop-blur-2xl sm:px-5">
            <div className="flex items-center gap-3">
              <GitInsightMark />
              <div>
                <p className="text-sm font-medium uppercase tracking-[0.18em] text-[color:var(--muted)]">
                  GitInsight
                </p>
                <p className="text-base font-semibold tracking-[-0.03em] text-[color:var(--foreground)]">
                  AI GitHub Portfolio Analyzer
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="hidden rounded-full border border-white/8 bg-white/6 px-3 py-2 font-mono text-[0.72rem] uppercase tracking-[0.22em] text-[color:var(--muted)] sm:block">
                Session-scoped API key
              </div>
              <ThemeToggle theme={theme} onChange={setTheme} />
            </div>
          </div>
        </header>

        <section className="flex min-h-[calc(100vh-7rem)] items-center justify-center py-10">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={sectionTransition}
            className="w-full max-w-4xl"
          >
            <Panel className="overflow-hidden px-6 py-8 sm:px-8 sm:py-10 lg:px-10 lg:py-12">
              <div className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--accent),transparent)] opacity-70" />
              <div className="space-y-8 text-center">
                <div className="space-y-5">
                  <div className="flex justify-center">
                    <SurfaceLabel>Developer portfolio intelligence</SurfaceLabel>
                  </div>
                  <div className="space-y-4">
                    <h1 className="mx-auto max-w-3xl text-5xl font-semibold leading-[0.92] tracking-[-0.07em] text-[color:var(--foreground)] sm:text-6xl md:text-7xl">
                      Understand your GitHub portfolio.
                    </h1>
                    <p className="mx-auto max-w-2xl text-lg leading-8 text-[color:var(--muted-strong)] sm:text-xl">
                      Enter a GitHub username and your API key to open a dedicated analysis workspace with repository signals, skill mapping, and AI portfolio feedback.
                    </p>
                  </div>
                </div>

                <GitInsightLandingForm
                  username={username}
                  apiKey={apiKey}
                  showApiKey={showApiKey}
                  error={error}
                  isPending={isPending}
                  quickProfiles={LANDING_QUICK_PROFILES}
                  onUsernameChange={setUsername}
                  onApiKeyChange={setApiKey}
                  onToggleApiKey={() => setShowApiKey((current) => !current)}
                  onQuickProfile={(profile) => {
                    setUsername(profile);
                    setError(null);
                  }}
                  onSubmit={handleSubmit}
                />
              </div>
            </Panel>
          </motion.div>
        </section>
      </main>
    </AppShell>
  );
}
