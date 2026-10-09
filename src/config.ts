import type { Config, Env } from './types';

export const DEFAULT_CONFIG: Config = {
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  openaiReasoningEffort: 'medium',
  openaiTimeoutMinutes: 12,
  timezone: 'Asia/Shanghai',
  agendaCalendars: [], // configure in the Web UI, e.g. ["alice@example.com"]
  holidayCalendars: [], // configure in the Web UI, e.g. ["Holidays in China"]
  skipAllDayAgendaEvents: true,
  eventExclusionPattern: '',
  weatherLocation: '',
  tc002BaseUrl: '',
};

const KEY = 'config';
const REASONING_EFFORTS: Config['openaiReasoningEffort'][] = [
  'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

export async function getConfig(env: Env): Promise<Config> {
  const stored = await env.KV.get(KEY, 'json') as (Partial<Config> & { openaiThinking?: string }) | null;
  const { openaiThinking, ...config } = stored ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...config,
    openaiReasoningEffort: config.openaiReasoningEffort
      ?? (openaiThinking === 'off' ? 'none' : DEFAULT_CONFIG.openaiReasoningEffort),
  };
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
    } else if (key === 'openaiReasoningEffort') {
      if (!REASONING_EFFORTS.includes(value as Config['openaiReasoningEffort'])) {
        throw new RangeError(`Reasoning effort must be one of: ${REASONING_EFFORTS.join(', ')}`);
      }
      next.openaiReasoningEffort = value as Config['openaiReasoningEffort'];
    } else if (key === 'openaiTimeoutMinutes') {
      const minutes = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
        throw new RangeError('Model timeout must be a whole number between 1 and 60 minutes');
      }
      next.openaiTimeoutMinutes = minutes;
    } else if (key === 'skipAllDayAgendaEvents') {
      next[key] = Boolean(value);
    } else {
      target[key] = String(value);
    }
  }
  await env.KV.put(KEY, JSON.stringify(next));
  return next;
}
