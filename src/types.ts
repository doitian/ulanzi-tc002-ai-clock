export interface Config {
  openaiBaseUrl: string;
  openaiModel: string;
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
  ADMIN_TOKEN?: string;
  TC002_BASE?: string;
}
