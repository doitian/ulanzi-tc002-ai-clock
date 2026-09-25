import type { Env } from './types';

interface GoogleTokens {
  refresh_token: string;
  access_token?: string;
  access_token_expires?: number;
}

const TOKEN_KEY = 'google_tokens';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export interface RawEvent {
  id?: string;
  title: string;
  calendar: string;
  allDay: boolean;
  start?: string; // RFC3339 dateTime for timed events
  end?: string;
  date?: string; // YYYY-MM-DD start (inclusive) for all-day events
  endDate?: string; // YYYY-MM-DD end (exclusive) for all-day events
}

export async function isGoogleConnected(env: Env): Promise<boolean> {
  return (await env.KV.get(TOKEN_KEY)) !== null;
}

export async function disconnectGoogle(env: Env): Promise<void> {
  await env.KV.delete(TOKEN_KEY);
}

export function buildAuthUrl(env: Env, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function handleAuthCallback(env: Env, code: string, redirectUri: string): Promise<void> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.refresh_token) {
    throw new Error('Google did not return a refresh_token; revoke app access at myaccount.google.com/permissions and connect again');
  }
  await env.KV.put(TOKEN_KEY, JSON.stringify({
    refresh_token: String(data.refresh_token),
    access_token: data.access_token ? String(data.access_token) : undefined,
    access_token_expires: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  } satisfies GoogleTokens));
}

async function getAccessToken(env: Env): Promise<string> {
  const tokens = await env.KV.get<GoogleTokens>(TOKEN_KEY, 'json');
  if (!tokens?.refresh_token) throw new Error('Google Calendar is not connected');
  if (tokens.access_token && (tokens.access_token_expires ?? 0) > Date.now() + 60_000) {
    return tokens.access_token;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as Record<string, unknown>;
  const next: GoogleTokens = {
    refresh_token: tokens.refresh_token,
    access_token: String(data.access_token),
    access_token_expires: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  };
  await env.KV.put(TOKEN_KEY, JSON.stringify(next));
  return next.access_token!;
}

export async function getCalendarToken(env: Env): Promise<string | null> {
  try {
    return await getAccessToken(env);
  } catch {
    return null;
  }
}

// Matches configured names against calendar id or summary (exact, then substring).
async function resolveCalendars(accessToken: string, names: string[]): Promise<{ name: string; id: string }[]> {
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`calendarList failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items?: { id?: string; summary?: string }[] };
  const items = data.items ?? [];
  const out: { name: string; id: string }[] = [];
  for (const name of names) {
    const needle = name.toLowerCase();
    const match =
      items.find((i) => (i.id ?? '').toLowerCase() === needle || (i.summary ?? '').toLowerCase() === needle) ??
      items.find((i) => (i.id ?? '').toLowerCase().includes(needle) || (i.summary ?? '').toLowerCase().includes(needle));
    if (match?.id) out.push({ name, id: match.id });
  }
  return out;
}

// Returns events overlapping [timeMin, timeMax] across all matching calendars.
export async function fetchEvents(
  accessToken: string,
  calendarNames: string[],
  timeMin: Date,
  timeMax: Date,
): Promise<RawEvent[]> {
  const calendars = await resolveCalendars(accessToken, calendarNames);
  const out: RawEvent[] = [];
  for (const cal of calendars) {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '100',
    });
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) continue; // calendar not shared/accessible - skip it
    const data = (await res.json()) as {
      items?: {
        status?: string;
        id?: string;
        summary?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
      }[];
    };
    for (const item of data.items ?? []) {
      if (item.status === 'cancelled') continue;
      const allDay = !item.start?.dateTime;
      out.push({
        id: item.id,
        title: item.summary ?? '(no title)',
        calendar: cal.name,
        allDay,
        start: item.start?.dateTime,
        end: item.end?.dateTime,
        date: allDay ? item.start?.date : undefined,
        endDate: allDay ? item.end?.date : undefined,
      });
    }
  }
  return out;
}
