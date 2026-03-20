# GitInsight

GitInsight is a Next.js app that analyzes a GitHub username and generates a technical portfolio assessment. It combines live GitHub signals (repositories, language usage, activity, documentation coverage) with AI-generated feedback tuned for hiring-level engineering review.

## Highlights

- Live GitHub analysis from server-side API calls.
- Portfolio scoring across code quality, documentation, originality, activity, and completeness.
- AI feedback with strict JSON output (`summary`, `strengths`, `weaknesses`, `suggestions`).
- Per-IP request protection (cooldown + minute/day rate limits).
- AI feedback caching with optional Upstash/Vercel KV backing.
- Dedicated route-based workspace per user: `/analyze/[username]`.

## Tech Stack

- Next.js
- React
- TypeScript
- Tailwind CSS
- Framer Motion
- Octokit-compatible GitHub API usage via `fetch`
- Google GenAI SDK (`@google/genai`)

## Routes

- `/`: Landing page with username input.
- `/analyze/[username]`: Dashboard that fetches live analysis for the selected username.
- `/analyze/[username]/share`: Share card view backed by the latest cached analysis snapshot.
- `POST /api/analyze`: Backend analysis endpoint.
- `GET /api/analyze?username=<name>`: Returns latest shared analysis snapshot for a username.

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create `.env.local`:

Refer to [.env.example](.env.example)

### 3. Start development server

```bash
npm run dev
```

Open `http://localhost:3000`.

## Scripts

- `npm run dev`: Start local dev server.
- `npm run build`: Create production build.
- `npm run start`: Run production server.
- `npm run lint`: Run ESLint.
- `npm run test`: Run unit tests.

## API Contract

### `POST /api/analyze`

Request body:

```json
{
    "username": "octocat"
}
```

Success response (`200`):

```json
{
    "source": "github",
    "cachedAi": false,
    "warning": "AI provider is temporarily unavailable. Returned deterministic system feedback.",
    "analysis": {
        "username": "octocat",
        "score": 78,
        "followers": 123,
        "totalStars": 456,
        "repositoriesAnalyzed": 12,
        "benchmarkDelta": "Top 12% among analyzed GitInsight profiles",
        "headline": "...",
        "summary": "...",
        "highlights": ["..."],
        "breakdown": [{ "label": "Code quality proxy", "value": 81, "note": "..." }],
        "activity": [{ "label": "Jan", "value": 62 }],
        "repositories": [{ "name": "owner/repo", "stack": ["TypeScript"], "stars": 10, "commits": 30, "quality": 7.9, "readme": "...", "recommendation": "...", "note": "...", "velocity": [3, 6, 7, 5, 8, 6, 9] }],
        "skills": [{ "label": "Frontend", "value": 74 }],
        "strengths": ["..."],
        "weaknesses": ["..."],
        "suggestions": ["..."]
    }
}
```

### `GET /api/analyze?username=<name>`

Returns the latest share snapshot if available (`200`) or `404` if that username has no recent snapshot.

Error responses return:

```json
{ "error": "message" }
```

Common status codes:

- `400`: Invalid request body or username.
- `401`: Invalid GitHub token.
- `403`: GitHub API forbidden or rate-limited upstream.
- `404`: GitHub user not found.
- `429`: Cooldown/rate limit triggered.
- `500`: Missing GitHub credentials or unexpected failure.
- `502`: GitHub upstream failure.

Rate limit headers returned by the API:

- `X-RateLimit-Minute-Limit`
- `X-RateLimit-Minute-Remaining`
- `X-RateLimit-Day-Limit`
- `X-RateLimit-Day-Remaining`
- `Retry-After` (on `429`)

## How Analysis Is Built

1. Validate and normalize username input.
2. Enforce request protection (cooldown + minute/day quotas).
3. Query GitHub user profile and top repositories (`/search/repositories`, sorted by stars, up to 30).
4. Fetch recent public events and repository metadata (languages, README, commit count).
5. Compute metrics and generate the analysis object.
6. Load cached AI feedback when available, otherwise call Gemini and cache result.
7. If AI credentials are absent or AI generation fails, return deterministic scoring-backed feedback and include a response `warning`.
8. Persist a snapshot for the share route (`GET /api/analyze?username=...`).

Notes:

- Public events fetch is best-effort and does not fail the full analysis if unavailable.
- AI feedback cache keys include `ANALYZE_AI_PROMPT_VERSION` so prompt updates can invalidate old cache entries.
- If Redis REST config is absent or unavailable, the app falls back to in-memory controls/cache.
- Share snapshots use `ANALYZE_SHARE_SNAPSHOT_TTL_SECONDS` with Redis or in-memory fallback.

## Project Structure

```text
app/
    page.tsx                     # Landing route
    analyze/[username]/page.tsx  # Username-scoped dashboard route
    api/analyze/route.ts         # Analysis API controller
    components/                  # Landing, dashboard, primitives
lib/
    live-analysis.ts             # GitHub data collection + scoring
    ai-feedback.ts               # Gemini prompt + response hardening
    ai-response-cache.ts         # AI cache (memory/Redis REST)
    analyze-request-protection.ts# Cooldown + rate limiting
    redis-rest.ts                # Upstash/Vercel KV REST helpers
    api-client.ts                # Frontend API integration
    types.ts                     # Shared API/domain types
```

## Troubleshooting

- `Server is missing GitHub credentials`: set `GITHUB_TOKEN` (or `GITHUB_PERSONAL_ACCESS_TOKEN`).
- `Rate limit exceeded` / cooldown errors: wait for `Retry-After` and tune limits if needed.
- AI provider credentials absent/outages: the API still returns `200` with deterministic feedback and a `warning` field.
- Share route returning `No shared analysis snapshot...`: run `POST /api/analyze` for that username first.

## Security Notes

- GitHub and AI keys are server-side only; client does not store or send provider tokens.
- Input usernames are validated against GitHub username rules.
- The API applies per-IP protection before expensive GitHub/AI calls.
- Security headers are set centrally in `next.config.ts` (CSP, HSTS, frame/type/referrer/permissions policies).
