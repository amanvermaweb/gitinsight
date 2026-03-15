"use client";

import { motion } from "framer-motion";
import { Share2 } from "lucide-react";
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
      <Share2 aria-hidden="true" className="h-5 w-5 text-(--accent-strong)" strokeWidth={1.8} />
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
    <span className="inline-flex items-center rounded-full border border-white/8 bg-white/6 px-3 py-1 font-mono text-[0.72rem] uppercase tracking-[0.22em] text-(--muted)">
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
        <h2 className="text-3xl font-semibold tracking-[-0.04em] text-(--foreground) sm:text-[2.45rem]">
          {title}
        </h2>
        <p className="max-w-3xl text-base leading-7 text-(--muted) sm:text-lg">
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
    <div className="flex items-center rounded-full border border-white/8 bg-white/6 p-1 backdrop-blur-xl">
      {(["dark", "light"] as const).map((mode) => {
        const active = theme === mode;

        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            className={`cursor-pointer rounded-full px-3 py-2 text-sm font-medium tracking-[-0.02em] transition ${
              active
                ? "bg-(--foreground) text-(--background)"
                : "text-(--muted-strong) hover:text-(--foreground)"
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
      <div className="absolute inset-3.5 rounded-full bg-(--panel-strong) shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]" />
      <div className="relative z-10 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.22em] text-(--muted)">
          Portfolio
        </p>
        <p className="mt-2 text-4xl font-semibold tracking-[-0.06em] text-(--foreground)">
          <AnimatedNumber value={score} decimals={1} />
        </p>
        <p className="mt-1 text-sm text-(--muted)">/ 10</p>
      </div>
    </div>
  );
}

export function SkillRadar({ skills }: { skills: AnalysisData["skills"] }) {
  const gradientId = useId();
  const glowId = useId();
  const center = 170;
  const radius = 110;
  const angleStep = (Math.PI * 2) / skills.length;
  const averageSkill = Math.round(
    skills.reduce((sum, skill) => sum + skill.value, 0) / skills.length,
  );
  const strongestSkill = [...skills].sort((a, b) => b.value - a.value)[0];

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

  const describeSkillConfidence = (value: number) => {
    if (value >= 75) {
      return "Strong evidence";
    }

    if (value >= 55) {
      return "Clear signal";
    }

    return "Needs more evidence";
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="gi-skill-stage w-full">
        <div className="gi-skill-stage-grid" aria-hidden="true" />

        <svg viewBox="0 0 340 340" className="relative z-10 mx-auto w-full max-w-85">
          <defs>
            <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-strong)" stopOpacity="0.88" />
              <stop offset="100%" stopColor="var(--warm)" stopOpacity="0.2" />
            </linearGradient>
            <radialGradient id={glowId} cx="50%" cy="50%" r="60%">
              <stop offset="0%" stopColor="var(--accent-strong)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="var(--accent-strong)" stopOpacity="0" />
            </radialGradient>
          </defs>

          <circle cx={center} cy={center} r="132" fill={`url(#${glowId})`} />

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
              stroke="rgba(255,255,255,0.13)"
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
              stroke="rgba(255,255,255,0.12)"
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
                stroke="rgba(255,255,255,0.72)"
                strokeWidth="1"
              />
            );
          })}
        </svg>

        <div className="relative z-10 mt-5 grid gap-3 sm:grid-cols-2">
          <div className="gi-skill-chip">
            <p className="font-mono text-[0.66rem] uppercase tracking-[0.2em] text-(--muted)">
              Average confidence
            </p>
            <p className="mt-2 text-xl font-semibold tracking-[-0.03em] text-(--foreground)">
              {averageSkill}%
            </p>
          </div>
          <div className="gi-skill-chip">
            <p className="font-mono text-[0.66rem] uppercase tracking-[0.2em] text-(--muted)">
              Strongest signal
            </p>
            <p className="mt-2 text-xl font-semibold tracking-[-0.03em] text-(--foreground)">
              {strongestSkill.label}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {skills.map((skill, index) => (
          <motion.div
            key={skill.label}
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.35 }}
            transition={{
              duration: 0.42,
              delay: index * 0.06,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="gi-skill-card"
          >
            <div className="flex items-center justify-between gap-4">
              <p className="text-base font-semibold tracking-[0.01em] text-(--foreground)">
                {skill.label}
              </p>
              <p className="font-mono text-sm text-(--muted-strong)">{skill.value}%</p>
            </div>

            <div className="gi-skill-progress-track">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${skill.value}%` }}
                transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                className="gi-skill-progress-fill"
              />
            </div>

            <p className="mt-3 text-sm text-(--muted)">
              {describeSkillConfidence(skill.value)}
            </p>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
