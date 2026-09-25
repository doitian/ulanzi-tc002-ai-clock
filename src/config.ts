import type { Config, Env } from './types';

export const DEFAULT_CONFIG: Config = {
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  openaiThinking: 'default',
  timezone: 'Asia/Shanghai',
  agendaCalendars: [], // configure in the Web UI, e.g. ["alice@example.com"]
  holidayCalendars: [], // configure in the Web UI, e.g. ["Holidays in China"]
  skipAllDayAgendaEvents: true,
  eventExclusionPattern: '',
  weatherLocation: '',
  tc002BaseUrl: '',
};

const KEY = 'config';

export async function getConfig(env: Env): Promise<Config> {
  const stored = await env.KV.get(KEY, 'json');
  return { ...DEFAULT_CONFIG, ...(stored as Partial<Config> | null) };
}

export async function saveConfig(env: Env, patch: Partial<Config>): Promise<Config> {
  const current = await getConfig(env);
  const next: Config = { ...current };
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof Config)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    const target = next as unknown as Record<string, unknown>;
    if ((key === 'agendaCalendars' || key === 'holidayCalendars')) {
      target[key] = Array.isArray(value)
        ? value.map((s) => String(s).trim()).filter(Boolean)
        : String(value).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (key === 'skipAllDayAgendaEvents') {
      next[key] = Boolean(value);
    } else {
      target[key] = String(value);
    }
  }
  await env.KV.put(KEY, JSON.stringify(next));
  return next;
}
