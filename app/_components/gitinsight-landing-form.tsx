"use client";

type GitInsightLandingFormProps = {
  username: string;
  apiKey: string;
  showApiKey: boolean;
  error: string | null;
  isPending: boolean;
  quickProfiles: readonly string[];
  onUsernameChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onToggleApiKey: () => void;
  onQuickProfile: (profile: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
};

export function GitInsightLandingForm({
  username,
  apiKey,
  showApiKey,
  error,
  isPending,
  quickProfiles,
  onUsernameChange,
  onApiKeyChange,
  onToggleApiKey,
  onQuickProfile,
  onSubmit,
}: GitInsightLandingFormProps) {
  return (
    <form onSubmit={onSubmit} className="mx-auto grid w-full max-w-3xl gap-4 text-left">
      <div className="rounded-[28px] border border-white/8 bg-[color:var(--panel-strong)] p-4 sm:p-5">
        <label className="block">
          <span className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-[color:var(--muted)]">
            GitHub username
          </span>
          <div className="mt-3 flex items-center gap-3 rounded-[22px] border border-white/8 bg-white/4 px-4 py-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/8 bg-white/6 text-[color:var(--muted)]">
              <svg
                aria-hidden="true"
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </div>
            <input
              type="text"
              aria-label="GitHub username"
              value={username}
              onChange={(event) => onUsernameChange(event.target.value)}
              placeholder="sindresorhus"
              className="min-w-0 flex-1 border-0 bg-transparent text-lg text-[color:var(--foreground)] outline-none placeholder:text-[color:var(--muted)] sm:text-[1.28rem]"
            />
          </div>
        </label>
      </div>

      <div className="rounded-[28px] border border-white/8 bg-[color:var(--panel-strong)] p-4 sm:p-5">
        <label className="block">
          <span className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-[color:var(--muted)]">
            API key
          </span>
          <div className="mt-3 flex items-center gap-3 rounded-[22px] border border-white/8 bg-white/4 px-4 py-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/8 bg-white/6 text-[color:var(--muted)]">
              <svg
                aria-hidden="true"
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 11h16" />
                <path d="M12 3v16" />
                <path d="M5 20h14" />
              </svg>
            </div>
            <input
              type={showApiKey ? "text" : "password"}
              aria-label="API key"
              value={apiKey}
              onChange={(event) => onApiKeyChange(event.target.value)}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              className="min-w-0 flex-1 border-0 bg-transparent text-lg text-[color:var(--foreground)] outline-none placeholder:text-[color:var(--muted)] sm:text-[1.28rem]"
            />
            <button
              type="button"
              onClick={onToggleApiKey}
              className="rounded-full border border-white/8 bg-white/6 px-3 py-2 text-sm text-[color:var(--foreground)] transition hover:bg-white/10"
            >
              {showApiKey ? "Hide" : "Show"}
            </button>
          </div>
        </label>
        <p className="mt-3 text-sm leading-6 text-[color:var(--muted)]">
          Use a GitHub personal access token. It is stored in session storage for this browser
          session only and is not appended to the URL.
        </p>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-[color:var(--muted)]">
            Quick fill
          </span>
          {quickProfiles.map((profile) => (
            <button
              key={profile}
              type="button"
              onClick={() => onQuickProfile(profile)}
              className="rounded-full border border-white/8 bg-white/5 px-3 py-2 text-sm text-[color:var(--foreground)] transition hover:border-[color:var(--accent)] hover:bg-white/8"
            >
              @{profile}
            </button>
          ))}
        </div>

        <button
          type="submit"
          className="inline-flex h-14 items-center justify-center gap-3 rounded-2xl bg-[color:var(--accent-strong)] px-6 text-sm font-semibold uppercase tracking-[0.14em] text-[color:var(--button-foreground)] transition hover:translate-y-[-1px] hover:bg-[color:var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
        >
          {isPending ? "Opening analysis" : "Analyze portfolio"}
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12h14" />
            <path d="m13 5 7 7-7 7" />
          </svg>
        </button>
      </div>

      {error ? (
        <div className="rounded-[20px] border border-[color:var(--accent)]/30 bg-[color:var(--accent-soft)] px-4 py-3 text-sm leading-6 text-[color:var(--foreground)]">
          {error}
        </div>
      ) : null}
    </form>
  );
}
