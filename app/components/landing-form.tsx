"use client";

type GitInsightLandingFormProps = {
  username: string;
  error: string | null;
  isPending: boolean;
  onUsernameChange: (value: string) => void;
  onQuickProfile: (profile: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
};

export function GitInsightLandingForm({
  username,
  error,
  isPending,
  onUsernameChange,
  onQuickProfile,
  onSubmit,
}: GitInsightLandingFormProps) {
  return (
    <form onSubmit={onSubmit} className="mx-auto grid w-full max-w-3xl gap-4 text-left">
      <div className="rounded-[28px] border border-white/8 bg-(--panel-strong) p-4 sm:p-5">
        <label className="block">
          <span className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-(--muted)">
            GitHub username
          </span>
          <div className="mt-3 flex items-center gap-3 rounded-[22px] border border-white/8 bg-white/4 px-4 py-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/8 bg-white/6 text-(--muted)">
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
              className="min-w-0 flex-1 border-0 bg-transparent text-lg text-(--foreground) outline-none placeholder:text-(--muted) sm:text-[1.28rem]"
            />
          </div>
        </label>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">

        <button
          type="submit"
          className="w-full cursor-pointer inline-flex h-14 items-center justify-center gap-3 rounded-2xl bg-(--accent-strong) px-6 text-sm font-semibold uppercase tracking-[0.14em] text-(--button-foreground) transition hover:-translate-y-px hover:bg-(--accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
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
        <div className="rounded-[20px] border border-(--accent)/30 bg-(--accent-soft) px-4 py-3 text-sm leading-6 text-(--foreground)">
          {error}
        </div>
      ) : null}
    </form>
  );
}
