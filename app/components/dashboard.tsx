"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { fetchLiveAnalysis } from "@/lib/api-client";
import { DEFAULT_USERNAME, navItems, sectionTransition } from "@/lib/constants";
import { buildAnalysis } from "@/lib/mock-analysis";
import type { AnalysisData } from "@/lib/types";
import { isValidGitHubUsername, normalizeUsername } from "@/lib/utils";
import {
  AnimatedNumber,
  AppShell,
  GitInsightMark,
  Panel,
  ScoreRing,
  SectionHeading,
  SkillRadar,
  SurfaceLabel,
  ThemeToggle,
  usePersistedTheme,
} from "./primitives";

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
  const [analysis, setAnalysis] = useState<AnalysisData>(() =>
    buildAnalysis(initialUsername),
  );

  useEffect(() => {
    setUsernameInput(normalizeUsername(initialUsername));
  }, [initialUsername]);

  useEffect(() => {
    const normalizedUsername = normalizeUsername(initialUsername) || DEFAULT_USERNAME;
    const controller = new AbortController();

    const hydrateAnalysis = async () => {
      setAnalysisLoading(true);

      try {
        const response = await fetchLiveAnalysis(normalizedUsername, controller.signal);
        setAnalysis(response.analysis);
        setAnalysisNotice(response.warning ?? "Live analysis loaded from GitHub API.");
      } catch (caughtError) {
        if (controller.signal.aborted) {
          return;
        }

        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "Live analysis failed. Showing generated preview data.";

        setAnalysis(buildAnalysis(normalizedUsername));
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

  const handleReanalyze = (event: React.FormEvent<HTMLFormElement>) => {
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

  return (
    <AppShell theme={theme}>
        <main
          className="relative mx-auto flex min-h-screen w-full max-w-370 flex-col gap-10 px-4 pb-12 pt-4 sm:px-6 sm:pb-16 lg:px-8"
        >
          <header className="sticky top-4 z-40">
          <div
            className="flex flex-col gap-4 rounded-[28px] border border-white/8 bg-(--nav) px-4 py-4 shadow-[0_16px_40px_rgba(0,0,0,0.22)] backdrop-blur-2xl sm:px-5 lg:flex-row lg:items-center lg:justify-between"
          >
            <div className="flex items-center gap-3">
              <GitInsightMark />
              <div>
                <p className="text-sm font-medium uppercase tracking-[0.18em] text-(--muted)">
                  GitInsight
                </p>
                <p
                  className="text-base font-semibold tracking-[-0.03em] text-(--foreground)"
                >
                  Analysis workspace for @{analysis.username}
                </p>
              </div>
            </div>

            <nav className="hidden items-center gap-6 lg:flex">
              {navItems.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  className="text-sm font-medium tracking-[-0.02em] text-(--muted) transition hover:text-(--foreground)"
                >
                  {item.label}
                </a>
              ))}
            </nav>

            <div className="flex flex-wrap items-center gap-3 lg:justify-end">
              <Link
                href="/"
                className="rounded-full border border-white/8 bg-white/6 px-3 py-2 text-sm text-(--foreground) transition hover:bg-white/10"
              >
                New search
              </Link>
              <div
                className="rounded-full border border-white/8 bg-white/6 px-3 py-2 font-mono text-[0.72rem] uppercase tracking-[0.22em] text-(--muted)"
              >
                Server token mode
              </div>
              <ThemeToggle theme={theme} onChange={setTheme} />
            </div>
          </div>
        </header>

        <Panel className="px-5 py-4 sm:px-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-mono text-[0.7rem] uppercase tracking-[0.22em] text-(--muted)">
              {analysisLoading ? "Syncing live data" : "Data source"}
            </p>
            <p className="text-sm leading-6 text-(--muted-strong)">
              {analysisLoading
                ? "Fetching repositories and profile signals from GitHub..."
                : analysisNotice}
            </p>
          </div>
        </Panel>

        <section className="grid gap-4 xl:grid-cols-[0.84fr_1.16fr]">
          <motion.div
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={sectionTransition}
          >
            <Panel className="p-6 sm:p-7">
              <SurfaceLabel>Analysis dashboard</SurfaceLabel>
              <h1
                className="mt-5 max-w-3xl text-4xl font-semibold tracking-[-0.06em] text-(--foreground) sm:text-5xl lg:text-[3.7rem]"
              >
                Deep portfolio intelligence for @{analysis.username}.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-8 text-(--muted-strong) sm:text-lg">
                Repository quality, shipping behavior, documentation maturity,
                and skill confidence are all separated into a dedicated result
                workspace rather than compressed into the landing screen.
              </p>

              <form onSubmit={handleReanalyze} className="mt-8 grid gap-4">
                <div
                  className="flex flex-col gap-3 rounded-3xl border border-white/8 bg-(--panel-strong) p-4 sm:flex-row sm:items-center"
                >
                  <input
                    type="text"
                    aria-label="Analyze another GitHub username"
                    value={usernameInput}
                    onChange={(event) => setUsernameInput(event.target.value)}
                    placeholder="Analyze another username"
                    className="min-w-0 flex-1 border-0 bg-transparent text-lg text-(--foreground) outline-none placeholder:text-(--muted)"
                  />
                  <button
                    type="submit"
                    className="inline-flex h-12 items-center justify-center gap-3 rounded-2xl bg-(--accent-strong) px-5 text-sm font-semibold uppercase tracking-[0.14em] text-(--button-foreground) transition hover:-translate-y-px hover:bg-(--accent)"
                  >
                    {isPending ? "Opening" : "Analyze another"}
                  </button>
                </div>

                {error ? (
                  <div
                    className="rounded-[20px] border border-(--accent)/30 bg-(--accent-soft) px-4 py-3 text-sm leading-6 text-(--foreground)"
                  >
                    {error}
                  </div>
                ) : null}
              </form>
            </Panel>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 28 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...sectionTransition, delay: 0.1 }}
            className="grid gap-4 sm:grid-cols-2"
          >
            <Panel className="p-6">
              <p className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-(--muted)">
                Review posture
              </p>
              <p className="mt-3 text-xl font-semibold tracking-[-0.04em] text-(--foreground)">
                {analysis.benchmarkDelta}
              </p>
              <p className="mt-3 text-sm leading-6 text-(--muted)">{analysis.summary}</p>
            </Panel>

            <Panel className="p-6">
              <p className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-(--muted)">
                Signature signals
              </p>
              <div className="mt-4 space-y-3">
                {analysis.highlights.map((highlight) => (
                  <div key={highlight} className="flex items-start gap-3">
                    <span className="mt-1 h-2.5 w-2.5 rounded-full bg-(--accent-strong)" />
                    <p className="text-sm leading-6 text-(--muted-strong)">{highlight}</p>
                  </div>
                ))}
              </div>
            </Panel>
          </motion.div>
        </section>

        <section className="space-y-8">
          <SectionHeading
            id="overview"
            eyebrow="Developer overview"
            title="A result page with clear hierarchy and room for serious analysis."
            description={
              "The landing view now stops at data entry. Everything evaluative lives here, where the portfolio score, repository depth, and AI critique can breathe without competing with acquisition copy."
            }
          />

          <motion.div
            key={analysis.username}
            initial={{ opacity: 0, y: 28 }}
            animate={{ opacity: 1, y: 0 }}
            transition={sectionTransition}
            className="grid gap-4 xl:grid-cols-[0.92fr_1.08fr]"
          >
            <Panel className="p-6 sm:p-7">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-4">
                  <Image
                    src={`https://github.com/${analysis.username}.png?size=200`}
                    alt={`${analysis.username} avatar`}
                    width={72}
                    height={72}
                    className="h-18 w-18 rounded-3xl border border-white/10 object-cover shadow-[0_16px_36px_rgba(0,0,0,0.25)]"
                    unoptimized
                  />

                  <div>
                    <p className="font-mono text-[0.72rem] uppercase tracking-[0.24em] text-(--muted)">
                      Developer overview
                    </p>
                    <h3 className="mt-2 text-3xl font-semibold tracking-[-0.05em] text-(--foreground)">
                      @{analysis.username}
                    </h3>
                    <p
                      className="mt-2 max-w-xl text-sm leading-6 text-(--muted-strong)"
                    >
                      {analysis.headline}
                    </p>
                  </div>
                </div>

                <div className="rounded-3xl border border-white/8 bg-(--panel-strong) px-4 py-3">
                  <p className="font-mono text-[0.68rem] uppercase tracking-[0.22em] text-(--muted)">
                    Benchmark
                  </p>
                  <p className="mt-2 text-base font-semibold tracking-[-0.03em] text-(--foreground)">
                    {analysis.benchmarkDelta}
                  </p>
                </div>
              </div>

              <div className="mt-8 grid gap-4 sm:grid-cols-3">
                <div className="rounded-3xl border border-white/8 bg-(--panel-strong) p-5">
                  <p className="text-sm text-(--muted)">Followers</p>
                  <p className="mt-3 text-3xl font-semibold tracking-[-0.06em] text-(--foreground)">
                    <AnimatedNumber value={analysis.followers} />
                  </p>
                </div>
                <div className="rounded-3xl border border-white/8 bg-(--panel-strong) p-5">
                  <p className="text-sm text-(--muted)">Total stars</p>
                  <p className="mt-3 text-3xl font-semibold tracking-[-0.06em] text-(--foreground)">
                    <AnimatedNumber value={analysis.totalStars} />
                  </p>
                </div>
                <div className="rounded-3xl border border-white/8 bg-(--panel-strong) p-5">
                  <p className="text-sm text-(--muted)">Repos analyzed</p>
                  <p className="mt-3 text-3xl font-semibold tracking-[-0.06em] text-(--foreground)">
                    <AnimatedNumber value={analysis.repositoriesAnalyzed} />
                  </p>
                </div>
              </div>

              <div className="mt-6 grid gap-3">
                {analysis.highlights.map((highlight) => (
                  <div
                    key={highlight}
                    className="rounded-[20px] border border-white/8 bg-white/4 px-4 py-3 text-sm leading-6 text-(--muted-strong)"
                  >
                    {highlight}
                  </div>
                ))}
              </div>
            </Panel>

            <Panel className="p-6 sm:p-7">
              <div className="grid gap-6 lg:grid-cols-[0.55fr_0.45fr] lg:items-center">
                <div className="space-y-4">
                  <p className="font-mono text-[0.72rem] uppercase tracking-[0.24em] text-(--muted)">
                    AI portfolio score
                  </p>
                  <ScoreRing score={analysis.score} />
                </div>

                <div className="space-y-3">
                  {analysis.breakdown.map((metric) => (
                    <div
                      key={metric.label}
                      className="rounded-[22px] border border-white/8 bg-(--panel-strong) p-4"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <p className="text-sm font-medium text-(--foreground)">
                          {metric.label}
                        </p>
                        <p className="font-mono text-sm text-(--foreground)">{metric.value}</p>
                      </div>
                      <div className="mt-3 h-2 rounded-full bg-white/6">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${metric.value * 10}%` }}
                          transition={{
                            duration: 0.72,
                            ease: [0.22, 1, 0.36, 1],
                          }}
                          className="h-full rounded-full bg-[linear-gradient(90deg,var(--accent-strong),var(--warm))]"
                        />
                      </div>
                      <p className="mt-3 text-sm leading-6 text-(--muted)">{metric.note}</p>
                    </div>
                  ))}
                </div>
              </div>
            </Panel>
          </motion.div>

          <div className="grid gap-4 xl:grid-cols-[1.04fr_0.96fr]">
            <Panel className="p-6 sm:p-7">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-(--muted)">
                    Contribution velocity
                  </p>
                  <h3 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-(--foreground)">
                    Output quality is improving month over month.
                  </h3>
                </div>
                <div
                  className="rounded-full border border-white/8 bg-white/6 px-3 py-2 font-mono text-[0.72rem] uppercase tracking-[0.2em] text-(--muted)"
                >
                  7-month view
                </div>
              </div>

              <div className="mt-8 grid grid-cols-7 gap-3">
                {analysis.activity.map((entry) => (
                  <div key={entry.label} className="flex flex-col items-center gap-3">
                    <div
                      className="flex h-44 w-full items-end rounded-3xl border border-white/8 bg-(--panel-strong) p-2"
                    >
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: `${entry.value}%` }}
                        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                        className="w-full rounded-[18px] bg-[linear-gradient(180deg,var(--accent-strong),rgba(255,255,255,0.08))]"
                      />
                    </div>
                    <div className="text-center">
                      <p className="font-mono text-xs uppercase tracking-[0.18em] text-(--muted)">
                        {entry.label}
                      </p>
                      <p className="mt-1 text-sm text-(--foreground)">{entry.value}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel className="p-6 sm:p-7">
              <p className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-(--muted)">
                Assessment notes
              </p>
              <div className="mt-6 space-y-5">
                {analysis.breakdown.map((metric) => (
                  <div key={metric.label} className="space-y-2">
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm font-medium text-(--foreground)">{metric.label}</p>
                      <p className="font-mono text-sm text-(--muted)">Confidence high</p>
                    </div>
                    <p className="text-sm leading-6 text-(--muted)">{metric.note}</p>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </section>

        <section className="space-y-8">
          <SectionHeading
            id="repositories"
            eyebrow="Repository insights"
            title="Scrollable repository intelligence that lives on the result page."
            description={
              "Each repository card exposes technical stack, adoption, activity, README quality, and a concrete AI recommendation without forcing the homepage to carry the weight of the entire product."
            }
          />

          <Panel className="overflow-hidden p-3 sm:p-4">
            <div className="grid max-h-176 gap-4 overflow-y-auto pr-1 lg:grid-cols-2">
              {analysis.repositories.map((repository, index) => (
                <motion.article
                  key={repository.name}
                  initial={{ opacity: 0, y: 18 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.25 }}
                  transition={{
                    duration: 0.5,
                    delay: index * 0.06,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  whileHover={{ y: -4 }}
                  className="group rounded-[28px] border border-white/8 bg-(--panel-strong) p-6 transition"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-(--muted)">
                        Repository {index + 1}
                      </p>
                      <h3 className="mt-3 text-2xl font-semibold tracking-[-0.05em] text-(--foreground)">
                        {repository.name}
                      </h3>
                    </div>
                    <div
                      className="rounded-full border border-white/8 bg-white/6 px-3 py-2 font-mono text-xs uppercase tracking-[0.18em] text-(--muted)"
                    >
                      Quality {repository.quality}
                    </div>
                  </div>

                  <p className="mt-4 text-sm leading-6 text-(--muted-strong)">
                    {repository.note}
                  </p>

                  <div className="mt-5 flex flex-wrap gap-2">
                    {repository.stack.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-white/8 bg-white/5 px-3 py-1.5 font-mono text-xs uppercase tracking-[0.14em] text-(--foreground)"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>

                  <div className="mt-6 grid grid-cols-3 gap-3">
                    <div className="rounded-[20px] border border-white/8 bg-white/4 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-(--muted)">Stars</p>
                      <p className="mt-2 text-xl font-semibold tracking-[-0.04em] text-(--foreground)">
                        {repository.stars}
                      </p>
                    </div>
                    <div className="rounded-[20px] border border-white/8 bg-white/4 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-(--muted)">Commits</p>
                      <p className="mt-2 text-xl font-semibold tracking-[-0.04em] text-(--foreground)">
                        {repository.commits}
                      </p>
                    </div>
                    <div className="rounded-[20px] border border-white/8 bg-white/4 p-4">
                      <p className="text-xs uppercase tracking-[0.18em] text-(--muted)">README</p>
                      <p className="mt-2 text-xl font-semibold tracking-[-0.04em] text-(--foreground)">
                        A-
                      </p>
                    </div>
                  </div>

                  <div className="mt-6 rounded-3xl border border-white/8 bg-white/4 p-4">
                    <div className="flex items-center justify-between gap-4">
                      <p className="font-mono text-[0.68rem] uppercase tracking-[0.22em] text-(--muted)">
                        Commit activity
                      </p>
                      <p className="text-sm text-(--muted)">7 weeks</p>
                    </div>
                    <div className="mt-4 grid grid-cols-7 gap-2">
                      {repository.velocity.map((value, velocityIndex) => (
                        <div
                          key={`${repository.name}-${velocityIndex}`}
                          className="flex flex-col items-center gap-2"
                        >
                          <div className="flex h-18 w-full items-end rounded-full bg-white/6 p-1.5">
                            <div
                              className="w-full rounded-full bg-[linear-gradient(180deg,var(--accent-strong),rgba(255,255,255,0.12))]"
                              style={{ height: `${value * 8}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-6 grid gap-3 opacity-90 transition duration-300 group-hover:opacity-100">
                    <div className="rounded-[22px] border border-white/8 bg-(--panel) p-4">
                      <p className="font-mono text-[0.68rem] uppercase tracking-[0.2em] text-(--muted)">
                        README analysis
                      </p>
                      <p className="mt-3 text-sm leading-6 text-(--muted-strong)">
                        {repository.readme}
                      </p>
                    </div>
                    <div className="rounded-[22px] border border-(--accent)/40 bg-(--accent-soft) p-4">
                      <p className="font-mono text-[0.68rem] uppercase tracking-[0.2em] text-(--muted)">
                        Improvement suggestion
                      </p>
                      <p className="mt-3 text-sm leading-6 text-(--foreground)">
                        {repository.recommendation}
                      </p>
                    </div>
                  </div>
                </motion.article>
              ))}
            </div>
          </Panel>
        </section>

        <section className="grid gap-8 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-8">
            <SectionHeading
              id="skills"
              eyebrow="Skill graph"
              title="Confidence-weighted skill mapping from public work."
              description={
                "GitInsight turns repository patterns, deployment posture, and library choices into a radar that shows where engineering range is obvious and where the portfolio should provide stronger evidence."
              }
            />

            <Panel className="p-6 sm:p-7">
              <SkillRadar skills={analysis.skills} />
            </Panel>
          </div>

          <div className="space-y-8">
            <SectionHeading
              id="feedback"
              eyebrow="AI portfolio feedback"
              title="A critique panel with the tone of a premium staff-engineering review."
              description={
                "The feedback surface is designed to feel credible and useful: concrete strengths, direct weaknesses, and portfolio improvements that materially raise hiring signal."
              }
            />

            <Panel className="p-6 sm:p-7">
              <div className="grid gap-4">
                <div
                  className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-6"
                >
                  <p className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-(--muted)">
                    Assistant summary
                  </p>
                  <h3 className="mt-3 text-2xl font-semibold tracking-[-0.05em] text-(--foreground)">
                    GitInsight sees a high-trust portfolio with notable leverage.
                  </h3>
                  <p className="mt-4 max-w-3xl text-sm leading-7 text-(--muted-strong)">
                    {analysis.summary}
                  </p>
                </div>

                <div className="grid gap-4 lg:grid-cols-3">
                  <div className="rounded-[26px] border border-white/8 bg-(--panel-strong) p-5">
                    <p className="font-mono text-[0.68rem] uppercase tracking-[0.22em] text-(--muted)">
                      Strengths
                    </p>
                    <div className="mt-4 space-y-3">
                      {analysis.strengths.map((item) => (
                        <div
                          key={item}
                          className="rounded-[20px] border border-white/8 bg-white/4 p-4 text-sm leading-6 text-(--muted-strong)"
                        >
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-[26px] border border-white/8 bg-(--panel-strong) p-5">
                    <p className="font-mono text-[0.68rem] uppercase tracking-[0.22em] text-(--muted)">
                      Weaknesses
                    </p>
                    <div className="mt-4 space-y-3">
                      {analysis.weaknesses.map((item) => (
                        <div
                          key={item}
                          className="rounded-[20px] border border-white/8 bg-white/4 p-4 text-sm leading-6 text-(--muted-strong)"
                        >
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-[26px] border border-(--accent)/35 bg-(--accent-soft) p-5">
                    <p className="font-mono text-[0.68rem] uppercase tracking-[0.22em] text-(--muted)">
                      Suggestions
                    </p>
                    <div className="mt-4 space-y-3">
                      {analysis.suggestions.map((item) => (
                        <div
                          key={item}
                          className="rounded-[20px] border border-white/10 bg-black/8 p-4 text-sm leading-6 text-(--foreground)"
                        >
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </Panel>
          </div>
        </section>
      </main>
    </AppShell>
  );
}
