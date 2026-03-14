"use client";

import { motion } from "framer-motion";
import { useEffect, useId, useState } from "react";
import { THEME_STORAGE_KEY } from "@/lib/constants";
import type { AnalysisData, ThemeMode } from "@/lib/types";
import { clamp } from "@/lib/utils";

function getSystemTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readThemePreference(): {
  hasStoredPreference: boolean;
  theme: ThemeMode;
} {
  if (typeof window === "undefined") {
    return {
      hasStoredPreference: false,
      theme: "dark" as ThemeMode,
    };
  }

  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (storedTheme === "dark" || storedTheme === "light") {
    return {
      hasStoredPreference: true,
      theme: storedTheme,
    };
  }

  return {
    hasStoredPreference: false,
    theme: getSystemTheme(),
  };
}

export function usePersistedTheme(): [ThemeMode, (nextTheme: ThemeMode) => void] {
  const [{ hasStoredPreference, theme }, setThemeState] = useState(
    readThemePreference,
  );

  useEffect(() => {
    if (hasStoredPreference) {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
      return;
    }

    window.localStorage.removeItem(THEME_STORAGE_KEY);

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => {
      setThemeState((current) =>
        current.hasStoredPreference
          ? current
          : { hasStoredPreference: false, theme: getSystemTheme() },
      );
    };

    syncSystemTheme();
    mediaQuery.addEventListener("change", syncSystemTheme);

    return () => mediaQuery.removeEventListener("change", syncSystemTheme);
  }, [hasStoredPreference, theme]);

  const setTheme = (nextTheme: ThemeMode) => {
    setThemeState({
      hasStoredPreference: true,
      theme: nextTheme,
    });
  };

  return [theme, setTheme];
}

export function GitInsightMark() {
  return (
    <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/8 bg-white/6 shadow-[0_12px_40px_rgba(0,0,0,0.28)] backdrop-blur-xl">
      <svg
        aria-hidden="true"
        className="h-5 w-5 text-[color:var(--accent-strong)]"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
        <path d="M16 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
        <path d="M16 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
        <path d="M10.8 7.4 13.2 6" />
        <path d="M10.8 10.6 13.2 18" />
      </svg>
    </div>
  );
}

function BackgroundLayers() {
  return (
    <>
      <div className="gi-grid" aria-hidden="true" />
      <div className="gi-orb gi-orb-primary" aria-hidden="true" />
      <div className="gi-orb gi-orb-secondary" aria-hidden="true" />
      <div className="gi-noise" aria-hidden="true" />
      <div className="gi-particles" aria-hidden="true">
        {Array.from({ length: 9 }).map((_, index) => (
          <span key={index} className="gi-particle" />
        ))}
      </div>
    </>
  );
}

export function AppShell({
  theme,
  children,
}: {
  theme: ThemeMode;
  children: React.ReactNode;
}) {
  return (
    <div className="gitinsight-app" data-theme={theme}>
      <BackgroundLayers />
      {children}
    </div>
  );
}

export function Panel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={`gi-panel ${className ?? ""}`}>{children}</div>;
}

export function SurfaceLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-white/8 bg-white/6 px-3 py-1 font-mono text-[0.72rem] uppercase tracking-[0.22em] text-[color:var(--muted)]">
      {children}
    </span>
  );
}

export function SectionHeading({
  id,
  eyebrow,
  title,
  description,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div id={id} className="space-y-3">
      <SurfaceLabel>{eyebrow}</SurfaceLabel>
      <div className="space-y-2">
        <h2 className="text-3xl font-semibold tracking-[-0.04em] text-[color:var(--foreground)] sm:text-[2.45rem]">
          {title}
        </h2>
        <p className="max-w-3xl text-base leading-7 text-[color:var(--muted)] sm:text-lg">
          {description}
        </p>
      </div>
    </div>
  );
}

export function ThemeToggle({
  theme,
  onChange,
}: {
  theme: ThemeMode;
  onChange: (theme: ThemeMode) => void;
}) {
  return (
    <div className=" flex items-center rounded-full border border-white/8 bg-white/6 p-1 backdrop-blur-xl">
      {(["dark", "light"] as const).map((mode) => {
        const active = theme === mode;

        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            className={`cursor-pointer rounded-full px-3 py-2 text-sm font-medium tracking-[-0.02em] transition ${
              active
                ? "bg-[color:var(--foreground)] text-[color:var(--background)]"
                : "text-[color:var(--muted-strong)] hover:text-[color:var(--foreground)]"
            }`}
          >
            {mode === "dark" ? "Dark" : "Light"}
          </button>
        );
      })}
    </div>
  );
}

export function AnimatedNumber({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
}) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    let frame = 0;
    let start = 0;
    const duration = 900;

    const animate = (timestamp: number) => {
      if (!start) {
        start = timestamp;
      }

      const progress = clamp((timestamp - start) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(value * eased);

      if (progress < 1) {
        frame = window.requestAnimationFrame(animate);
      }
    };

    frame = window.requestAnimationFrame(animate);

    return () => window.cancelAnimationFrame(frame);
  }, [value]);

  return (
    <>
      {prefix}
      {displayValue.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </>
  );
}

export function ScoreRing({ score }: { score: number }) {
  const progress = `${score * 10}%`;

  return (
    <div
      className="relative flex h-40 w-40 items-center justify-center rounded-full border border-white/10"
      style={{
        background: `conic-gradient(var(--accent-strong) ${progress}, rgba(255,255,255,0.08) ${progress})`,
      }}
    >
      <div className="absolute inset-[14px] rounded-full bg-[color:var(--panel-strong)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]" />
      <div className="relative z-10 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.22em] text-[color:var(--muted)]">
          Portfolio
        </p>
        <p className="mt-2 text-4xl font-semibold tracking-[-0.06em] text-[color:var(--foreground)]">
          <AnimatedNumber value={score} decimals={1} />
        </p>
        <p className="mt-1 text-sm text-[color:var(--muted)]">/ 10</p>
      </div>
    </div>
  );
}

export function SkillRadar({ skills }: { skills: AnalysisData["skills"] }) {
  const gradientId = useId();
  const center = 170;
  const radius = 110;
  const angleStep = (Math.PI * 2) / skills.length;

  const pointAt = (value: number, index: number, scale = 1) => {
    const angle = -Math.PI / 2 + index * angleStep;
    const adjustedRadius = radius * scale * (value / 100);
    return {
      x: center + Math.cos(angle) * adjustedRadius,
      y: center + Math.sin(angle) * adjustedRadius,
    };
  };

  const shapePoints = skills
    .map((skill, index) => {
      const point = pointAt(skill.value, index);
      return `${point.x},${point.y}`;
    })
    .join(" ");

  const axisPoints = skills.map((_, index) => {
    const point = pointAt(100, index, 1);
    return { ...point, index };
  });

  return (
    <div className="grid gap-8 lg:grid-cols-[0.95fr_1.05fr]">
      <div className="relative overflow-hidden rounded-[28px] border border-white/8 bg-[color:var(--panel-strong)] p-4 sm:p-6">
        <svg viewBox="0 0 340 340" className="mx-auto w-full max-w-[340px]">
          <defs>
            <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-strong)" stopOpacity="0.8" />
              <stop offset="100%" stopColor="var(--warm)" stopOpacity="0.24" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75, 1].map((ring) => (
            <polygon
              key={ring}
              points={skills
                .map((_, index) => {
                  const point = pointAt(100, index, ring);
                  return `${point.x},${point.y}`;
                })
                .join(" ")}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="1"
            />
          ))}
          {axisPoints.map((point) => (
            <line
              key={point.index}
              x1={center}
              y1={center}
              x2={point.x}
              y2={point.y}
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="1"
            />
          ))}
          <motion.polygon
            points={shapePoints}
            fill={`url(#${gradientId})`}
            stroke="var(--accent-strong)"
            strokeWidth="2"
            initial={{ opacity: 0, scale: 0.92, transformOrigin: "50% 50%" }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          />
          {skills.map((skill, index) => {
            const point = pointAt(skill.value, index);
            return (
              <circle
                key={skill.label}
                cx={point.x}
                cy={point.y}
                r="4.5"
                fill="var(--accent-strong)"
                stroke="rgba(255,255,255,0.65)"
                strokeWidth="1"
              />
            );
          })}
        </svg>
      </div>

      <div className="grid content-start gap-4 sm:grid-cols-2">
        {skills.map((skill) => (
          <div
            key={skill.label}
            className="rounded-[24px] border border-white/8 bg-[color:var(--panel-strong)] p-5"
          >
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm font-medium uppercase tracking-[0.18em] text-[color:var(--muted)]">
                {skill.label}
              </p>
              <p className="font-mono text-sm text-[color:var(--foreground)]">{skill.value}%</p>
            </div>
            <div className="mt-4 h-2.5 rounded-full bg-white/6">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${skill.value}%` }}
                transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                className="h-full rounded-full bg-[linear-gradient(90deg,var(--accent-strong),var(--warm))]"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
