import { fetchEvents, getCalendarToken, type RawEvent } from './calendar';
import type { Config, Env } from './types';

export interface Theme {
  kind: 'calendar-event' | 'holiday' | 'mood' | 'news' | 'weather' | 'custom';
  text: string;
  timeLabel?: string; // HH:MM (24h), rendered statically in the art
}

export interface ActiveEventTheme {
  theme: Theme;
  key: string; // stable identity, used to avoid re-sending the same event
}

// Manual generation path (Web UI): always picks a fresh theme.
export async function pickTheme(env: Env, cfg: Config): Promise<Theme> {
  const now = new Date();
  const token = await getCalendarToken(env);
  if (token && cfg.agendaCalendars.length > 0) {
    try {
      const active = await findActiveEventTheme(token, cfg, now);
      if (active) return active.theme;
    } catch {
      // calendar problems must not break theme selection
    }
  }
  return pickRandomTopic(cfg, token, now);
}

export async function findActiveEventTheme(
  token: string,
  cfg: Config,
  now: Date,
): Promise<ActiveEventTheme | null> {
  const ev = await findActiveEvent(token, cfg, now);
  if (!ev) return null;
  const theme: Theme = { kind: 'calendar-event', text: `Calendar event "${ev.title}"` };
  if (ev.start) theme.timeLabel = formatHHMM(new Date(ev.start), cfg.timezone);
  const key = `${ev.calendar}|${ev.id ?? `${ev.title}|${ev.start ?? ev.date ?? ''}`}`;
  return { theme, key };
}

export async function pickRandomTopic(cfg: Config, token: string | null, now: Date): Promise<Theme> {
  const sources: (() => Promise<Theme | null>)[] = [];
  if (token && cfg.holidayCalendars.length > 0) sources.push(() => holidayTheme(token, cfg, now));
  sources.push(() => Promise.resolve(moodTheme(cfg, now)));
  sources.push(() => newsTheme());
  sources.push(() => weatherTheme(cfg));

  for (const source of shuffle(sources)) {
    try {
      const theme = await source();
      if (theme) return theme;
    } catch {
      // try the next source
    }
  }
  return { kind: 'mood', text: 'a cheerful abstract geometric pattern' };
}

// Active = ongoing, or starting within 15 minutes. Among several actives,
// pick the one whose start is nearest to now.
async function findActiveEvent(token: string, cfg: Config, now: Date): Promise<RawEvent | null> {
  const events = await fetchEvents(
    token,
    cfg.agendaCalendars,
    new Date(now.getTime() - 12 * 3600_000),
    new Date(now.getTime() + 24 * 3600_000),
  );
  const isExcluded = exclusionMatcher(cfg.eventExclusionPattern);
  const nowMs = now.getTime();
  const today = dateStrInTz(now, cfg.timezone);

  const active = events.filter((ev) => {
    if (isExcluded(ev.title)) return false;
    if (ev.allDay) {
      if (cfg.skipAllDayAgendaEvents) return false;
      return !!ev.date && !!ev.endDate && ev.date <= today && today < ev.endDate;
    }
    if (!ev.start || !ev.end) return false;
    const s = new Date(ev.start).getTime();
    const e = new Date(ev.end).getTime();
    return (s <= nowMs && e > nowMs) || (s > nowMs && s - nowMs <= 15 * 60_000);
  });

  const startMs = (ev: RawEvent) =>
    ev.allDay ? new Date(`${ev.date}T00:00:00Z`).getTime() : new Date(ev.start!).getTime();
  active.sort((a, b) => Math.abs(startMs(a) - nowMs) - Math.abs(startMs(b) - nowMs));
  return active[0] ?? null;
}

function exclusionMatcher(pattern: string): (title: string) => boolean {
  const p = pattern.trim();
  if (!p) return () => false;
  try {
    const re = new RegExp(p, 'i');
    return (title) => re.test(title);
  } catch {
    const needle = p.toLowerCase();
    return (title) => title.toLowerCase().includes(needle);
  }
}

async function holidayTheme(token: string, cfg: Config, now: Date): Promise<Theme | null> {
  const events = await fetchEvents(
    token,
    cfg.holidayCalendars,
    new Date(now.getTime() - 3 * 86400_000),
    new Date(now.getTime() + 3 * 86400_000),
  );
  const today = dateStrInTz(now, cfg.timezone);
  const hits = events.filter((ev) => ev.allDay && ev.date && ev.endDate && ev.date <= today && today < ev.endDate);
  if (hits.length === 0) return null;
  const ev = hits[Math.floor(Math.random() * hits.length)];
  return { kind: 'holiday', text: `Local holiday: ${ev.title}` };
}

function moodTheme(cfg: Config, now: Date): Theme {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone, hour: 'numeric', hourCycle: 'h23' }).format(now),
    10,
  );
  let mood: string;
  if (hour >= 5 && hour < 7) mood = 'sunrise and fresh early-morning energy';
  else if (hour < 9) mood = 'morning coffee and a bright start to the day';
  else if (hour < 12) mood = 'focused productive morning work';
  else if (hour < 14) mood = 'lunch time and tasty food';
  else if (hour < 17) mood = 'steady afternoon focus with a cup of tea';
  else if (hour < 19) mood = 'evening sunset and winding down';
  else if (hour < 22) mood = 'a cozy relaxed evening at home';
  else mood = 'a calm night sky with stars and a crescent moon';
  return { kind: 'mood', text: `Mood of the moment: ${mood}` };
}

async function newsTheme(): Promise<Theme | null> {
  const res = await fetch('https://feeds.bbci.co.uk/news/world/rss.xml', {
    headers: { 'User-Agent': 'tc002-pixel-clock/1.0' },
  });
  if (!res.ok) return null;
  const xml = await res.text();
  const m = xml.match(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
  if (!m) return null;
  return { kind: 'news', text: `Breaking world news headline: "${decodeEntities(m[1].trim())}"` };
}

async function weatherTheme(cfg: Config): Promise<Theme | null> {
  const location = cfg.weatherLocation.trim();
  if (!location) return null;

  let lat: number;
  let lon: number;
  let name = location;
  const coord = location.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (coord) {
    lat = Number(coord[1]);
    lon = Number(coord[2]);
  } else {
    const g = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
    );
    if (!g.ok) return null;
    const gd = (await g.json()) as { results?: { latitude: number; longitude: number; name: string }[] };
    const r = gd.results?.[0];
    if (!r) return null;
    lat = r.latitude;
    lon = r.longitude;
    name = r.name;
  }

  const res = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`,
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { current?: { temperature_2m?: number; weather_code?: number } };
  const cur = data.current;
  if (!cur || cur.weather_code === undefined || cur.temperature_2m === undefined) return null;
  return {
    kind: 'weather',
    text: `Current weather in ${name}: ${wmoText(cur.weather_code)}, ${Math.round(cur.temperature_2m)}C`,
  };
}

function wmoText(code: number): string {
  if (code === 0) return 'clear sky';
  if (code <= 2) return 'partly cloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code >= 61 && code <= 67) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain showers';
  if (code === 85 || code === 86) return 'snow showers';
  if (code >= 95) return 'thunderstorm';
  return 'changing weather';
}

function formatHHMM(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

function dateStrInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
