export interface Config {
  openaiBaseUrl: string;
  openaiModel: string;
  openaiReasoningEffort: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  openaiTimeoutMinutes: number;
  timezone: string;
  agendaCalendars: string[];
  holidayCalendars: string[];
  skipAllDayAgendaEvents: boolean;
  eventExclusionPattern: string;
  weatherLocation: string;
  tc002BaseUrl: string;
}

export interface Env {
  KV: KVNamespace;
  OPENAI_API_KEY?: string;
  TC002_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOWED_EMAIL?: string;
}

export type ProgressFn = (event: { step: string; detail?: string }) => void;
