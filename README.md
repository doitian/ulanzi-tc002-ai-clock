# TC002 Pixel Clock

A Cloudflare Worker that generates 52×16 pixel art with an OpenAI-compatible chat model
and pushes it to an Ulanzi TC002 LED clock — on a schedule, or on demand from a small Web UI.

## How it works

The worker wakes **every 10 minutes, 07:00–23:59 UTC+0800** (fixed cron trigger in
`wrangler.toml`; Cloudflare cron is always UTC, hence `*/10 23,0-15 * * *`). On each wake:

1. **Check the agenda calendars.** If a Google Calendar event is *active* (ongoing, or starting
   within 15 minutes; all-day and excluded-title events are skipped; the one whose start is
   nearest to now wins), its theme is used and its start time (24h) is rendered as static pixel
   text. The event's identity (`calendar|id`) is stored in KV (`last_event_key`) — **the same
   event is never re-sent**.
2. **Otherwise, a random topic**, throttled to **at most one image per hour** (tracked via the
   `last_topic_at` KV key). Sources, chosen at random:
   - today's all-day events from the configured holiday calendar(s)
   - a mood fitting the current time of day
   - the top BBC World News headline
   - current weather at the configured location (Open-Meteo, no key needed)
3. **Generate.** The chat model returns palette-indexed rows for a 52×16 matrix (index 0 =
   `#000000` = LED off, 1–8 GIF frames when motion helps). The worker validates the grid and
   encodes a GIF in pure JS (`gifenc`) — no image API needed.
4. **Send.** The GIF is POSTed as a data URL to `$TC002_BASE/api/apps/random`.

Manual generation from the Web UI bypasses the dedupe and throttle.

## Setup

Deployment is automated with the Cloudflare GitHub App (Workers Builds). `wrangler.toml`
declares the `KV` binding without an id, so Wrangler **auto-provisions** the KV namespace on
first deploy; later deploys inherit the binding from the deployed version, so the same
namespace (and its data) is reused.

1. **Connect the repo**: Cloudflare dashboard → Workers → *Create* → *Import a repository* →
   pick this repo. No build command is needed (wrangler bundles `src/index.ts` directly).
   The KV namespace is created automatically on the first deploy.
2. **Variables and secrets** (Settings → Variables and Secrets):
   - Variables: `TC002_BASE` (e.g. `http://192.168.1.100`), `GOOGLE_CLIENT_ID`
   - Secrets: `OPENAI_API_KEY`, `TC002_TOKEN`, `GOOGLE_CLIENT_SECRET`,
     `ALLOWED_EMAIL` (the only Google account allowed to sign in)
3. **Google OAuth** (sign-in + Calendar API)
   - Google Cloud Console → create an OAuth client (type: *Web application*).
   - Enable the **Google Calendar API**.
   - Add authorized redirect URI: `https://<your-worker>.workers.dev/auth/google/callback`
     (also `http://localhost:8787/auth/google/callback` if you test locally).
   - The OAuth scopes are `openid email` + `calendar.readonly`: one consent both signs the
     user in and grants the worker offline calendar access via a stored refresh token.
   - Only the Google account matching the `ALLOWED_EMAIL` secret can sign in; other accounts
     are rejected after consent.
   - If the OAuth consent screen stays in "Testing" mode, refresh tokens expire after 7 days —
     publish the app to avoid reconnecting weekly.
   - All agenda/holiday calendars you configure must be visible in the *connected* account's
     calendar list (share/subscribe them there). Calendars are matched by id or name.
4. Open `https://<your-worker>.workers.dev`, sign in with Google, then fill in
   the configuration (agenda/holiday calendars, weather location, ...) and press
   **Generate & Send** to test.

## Web UI / API

Sign-in is via Google OAuth; the callback verifies the account against the `ALLOWED_EMAIL`
secret and issues a 30-day `HttpOnly` session cookie. Everything except `/`, `/auth/login`
and `/auth/google/callback` requires that session.

| Route | Purpose |
| --- | --- |
| `GET /` | Web UI |
| `GET /auth/login` | start Google sign-in (redirects to Google) |
| `GET /auth/google/callback` | OAuth callback: verify email, store tokens, set session |
| `POST /auth/logout` | destroy session (Google tokens stay, clock keeps running) |
| `POST /auth/google/disconnect` | delete stored Google tokens (stops calendar features) |
| `GET /api/state` | user, config, secret presence, Google status, last run |
| `POST /api/config` | update configuration (partial JSON merge) |
| `POST /api/generate` | `{ "prompt": "..." }` — empty prompt = automatic topic |
| `GET /api/last.gif` | last generated GIF |

### Configurable via UI

OpenAI endpoint & model, timezone, agenda calendars, holiday calendars, skip-all-day toggle,
event exclusion pattern (regex or substring), weather location, TC002 base URL.
Tokens (`OPENAI_API_KEY`, `TC002_TOKEN`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL`) stay secrets.

## Local development

```powershell
cp .dev.vars.example .dev.vars   # fill in secrets for `wrangler dev`
npm run dev
```

`wrangler dev` auto-provisions a local KV namespace that persists between runs, so no extra
configuration is needed.

Note: the scheduled handler only runs under `wrangler dev --test-scheduled`
(then call `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`), and the TC002 must be
reachable from wherever the worker runs.
