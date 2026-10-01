import type { Env } from './types';

interface GoogleTokens {
  refresh_token: string;
  access_token?: string;
  access_token_expires?: number;
}

const TOKEN_KEY = 'google_tokens';
const SCOPE = 'openid email https://www.googleapis.com/auth/calendar.readonly';

export interface CalendarEventFields {
  summary: string;
  eventType?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  detectedAllDay: boolean;
}

export interface RawEvent {
  id?: string;
  title: string;
  calendar: string;
  allDay: boolean;
  start?: string; // RFC3339 dateTime for timed events
  end?: string;
  date?: string; // YYYY-MM-DD start (inclusive) for all-day events
  endDate?: string; // YYYY-MM-DD end (exclusive) for all-day events
  fields: CalendarEventFields;
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

// Exchanges the auth code, identifies the user, enforces ALLOWED_EMAIL, and
// stores the Google tokens. Returns the signed-in email.
export async function handleAuthCallback(env: Env, code: string, redirectUri: string): Promise<string> {
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
  const accessToken = String(data.access_token ?? '');

  const ui = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!ui.ok) throw new Error(`userinfo failed: ${ui.status}`);
  const info = (await ui.json()) as { email?: string };
  const email = (info.email ?? '').toLowerCase();
  const allowed = (env.ALLOWED_EMAIL ?? '').toLowerCase();
  if (!allowed) throw new Error('ALLOWED_EMAIL secret is not set on the worker');
  if (!email || email !== allowed) throw new Error(`account ${email || '(unknown)'} is not allowed`);

  const existing = await env.KV.get<GoogleTokens>(TOKEN_KEY, 'json');
  const refreshToken = data.refresh_token ? String(data.refresh_token) : existing?.refresh_token;
  if (!refreshToken) {
    throw new Error('Google did not return a refresh_token; revoke app access at myaccount.google.com/permissions and sign in again');
  }
  await env.KV.put(TOKEN_KEY, JSON.stringify({
    refresh_token: refreshToken,
    access_token: accessToken || undefined,
    access_token_expires: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  } satisfies GoogleTokens));
  return email;
}

async function getAccessToken(env: Env): Promise<string> {
  const tokens = await env.KV.get<GoogleTokens>(TOKEN_KEY, 'json');
  if (!tokens?.refresh_token) throw new Error('Google Calendar is not connected');
  if (tokens.access_token && (tokens.access_token_expires ?? 0) > Date.now() + 60_000) {
    return tokens.access_token;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    signal: AbortSignal.timeout(30_000),
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
    signal: AbortSignal.timeout(30_000),
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

// Google and synced calendars often store all-day events, including "Out of office",
// as dateTimes on local midnights instead of date-only values.
export function allDayBounds(
  startIso: string,
  endIso: string,
  timeZone: string,
): { date: string; endDate: string } | null {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  const startWall = wallClock(start, timeZone);
  const endWall = wallClock(end, timeZone);
  if (!startWall || !endWall || startWall.hms !== '00:00:00') return null;
  if (endWall.hms === '00:00:00' && endWall.ymd > startWall.ymd) {
    return { date: startWall.ymd, endDate: endWall.ymd };
  }
  if ((endWall.hms === '23:59:00' || endWall.hms === '23:59:59') && endWall.ymd >= startWall.ymd) {
    return { date: startWall.ymd, endDate: addDays(endWall.ymd, 1) };
  }
  return null;
}

function wallClock(d: Date, timeZone: string): { ymd: string; hms: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
    const hour = get('hour') === '24' ? '00' : get('hour').padStart(2, '0');
    return {
      ymd: `${get('year')}-${get('month').padStart(2, '0')}-${get('day').padStart(2, '0')}`,
      hms: `${hour}:${get('minute').padStart(2, '0')}:${get('second').padStart(2, '0')}`,
    };
  } catch {
    return null;
  }
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function toRawEvent(
  item: {
    id?: string;
    summary?: string;
    eventType?: string;
    start?: { dateTime?: string; date?: string; timeZone?: string };
    end?: { dateTime?: string; date?: string; timeZone?: string };
  },
  calendar: string,
  timeZone?: string,
): RawEvent {
  const title = item.summary ?? '(no title)';
  const base = { id: item.id, title, calendar };
  const withFields = (allDay: boolean, extra: Omit<RawEvent, 'id' | 'title' | 'calendar' | 'allDay' | 'fields'>): RawEvent => ({
    ...base,
    allDay,
    ...extra,
    fields: eventFields(item, allDay),
  });
  if (item.start?.date) return withFields(true, { date: item.start.date, endDate: item.end?.date });
  const start = item.start?.dateTime;
  const end = item.end?.dateTime;
  if (start && end && timeZone) {
    const bounds = allDayBounds(start, end, timeZone);
    if (bounds) return withFields(true, bounds);
  }
  return withFields(!start, { start, end });
}

function eventFields(
  item: {
    summary?: string;
    eventType?: string;
    start?: { date?: string; dateTime?: string; timeZone?: string };
    end?: { date?: string; dateTime?: string; timeZone?: string };
  },
  detectedAllDay: boolean,
): CalendarEventFields {
  const fields: CalendarEventFields = {
    summary: item.summary ?? '(no title)',
    detectedAllDay,
  };
  if (item.eventType) fields.eventType = item.eventType;
  const start = timeFields(item.start);
  const end = timeFields(item.end);
  if (start) fields.start = start;
  if (end) fields.end = end;
  return fields;
}

function timeFields(
  value?: { date?: string; dateTime?: string; timeZone?: string },
): { date?: string; dateTime?: string; timeZone?: string } | undefined {
  if (!value) return undefined;
  const out: { date?: string; dateTime?: string; timeZone?: string } = {};
  if (value.date) out.date = value.date;
  if (value.dateTime) out.dateTime = value.dateTime;
  if (value.timeZone) out.timeZone = value.timeZone;
  return out.date || out.dateTime || out.timeZone ? out : undefined;
}

// Returns events overlapping [timeMin, timeMax] across all matching calendars.
export async function fetchEvents(
  accessToken: string,
  calendarNames: string[],
  timeMin: Date,
  timeMax: Date,
  timeZone?: string,
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
    if (timeZone) params.set('timeZone', timeZone);
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
      { signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) continue; // calendar not shared/accessible - skip it
    const data = (await res.json()) as {
      items?: {
        status?: string;
        id?: string;
        summary?: string;
        eventType?: string;
        start?: { dateTime?: string; date?: string; timeZone?: string };
        end?: { dateTime?: string; date?: string; timeZone?: string };
      }[];
    };
    for (const item of data.items ?? []) {
      if (item.status === 'cancelled') continue;
      out.push(toRawEvent(item, cal.name, timeZone));
    }
  }
  return out;
}
