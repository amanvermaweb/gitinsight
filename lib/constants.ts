export const THEME_STORAGE_KEY = "gitinsight_theme";
export const DEFAULT_USERNAME = "sindresorhus";

export const navItems = [
  { label: "Overview", href: "#overview" },
  { label: "Repositories", href: "#repositories" },
  { label: "Skills", href: "#skills" },
  { label: "Feedback", href: "#feedback" },
];

export const sectionTransition = {
  duration: 0.68,
  ease: [0.22, 1, 0.36, 1] as const,
};
