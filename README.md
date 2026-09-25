# TC002 Pixel Clock

A Cloudflare Worker that generates 52×16 pixel art with an OpenAI-compatible chat model
and pushes it to an Ulanzi TC002 LED clock — on a schedule, or on demand from a small Web UI.

## How it works

The worker wakes **every 10 minutes** (fixed cron trigger in `wrangler.toml`; Cloudflare cron
is always UTC). On each wake:

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

```powershell
npm install
```

1. **KV namespace**

   ```powershell
   npx wrangler kv namespace create KV
   ```

   Paste the returned `id` into `wrangler.toml`.

2. **Vars** in `wrangler.toml`: set `TC002_BASE` and `GOOGLE_CLIENT_ID`.

3. **Secrets**

   ```powershell
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put TC002_TOKEN
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put ADMIN_TOKEN   # password for the Web UI / API
   ```

4. **Google OAuth** (Calendar API)
   - Google Cloud Console → create an OAuth client (type: *Web application*).
   - Enable the **Google Calendar API**.
   - Add authorized redirect URI: `https://<your-worker>.workers.dev/auth/google/callback`
     (also `http://localhost:8787/auth/google/callback` if you test with `npm run dev`).
   - If the OAuth consent screen stays in "Testing" mode, refresh tokens expire after 7 days —
     publish the app to avoid reconnecting weekly.
   - All agenda/holiday calendars you configure must be visible in the *connected* account's
     calendar list (share/subscribe them there). Calendars are matched by id or name.

5. **Deploy**

   ```powershell
   npx wrangler deploy
   ```

6. Open `https://<your-worker>.workers.dev`, enter `ADMIN_TOKEN`, connect Google, then fill in
   the configuration (agenda/holiday calendars, weather location, ...) and press
   **Generate & Send** to test.

## Web UI / API

Everything except the OAuth callback requires `Authorization: Bearer $ADMIN_TOKEN`.

| Route | Purpose |
| --- | --- |
| `GET /` | Web UI |
| `GET /api/state` | config, secret presence, Google status, last run |
| `POST /api/config` | update configuration (partial JSON merge) |
| `POST /api/generate` | `{ "prompt": "..." }` — empty prompt = automatic topic |
| `GET /api/last.gif` | last generated GIF |
| `POST /auth/google` / `POST /auth/google/disconnect` | OAuth connect / disconnect |

### Configurable via UI

OpenAI endpoint & model, timezone, agenda calendars, holiday calendars, skip-all-day toggle,
event exclusion pattern (regex or substring), weather location, TC002 base URL.
Tokens (`OPENAI_API_KEY`, `TC002_TOKEN`, `GOOGLE_CLIENT_SECRET`, `ADMIN_TOKEN`) stay secrets.

## Local development

```powershell
cp .dev.vars.example .dev.vars   # fill in secrets for `wrangler dev`
npm run dev
```

Note: the scheduled handler only runs under `wrangler dev --test-scheduled`
(then call `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`), and the TC002 must be
reachable from wherever the worker runs.
