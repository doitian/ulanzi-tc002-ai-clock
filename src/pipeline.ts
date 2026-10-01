import { getCalendarToken } from './calendar';
import { getConfig } from './config';
import { generatePixelArt } from './pixelart';
import { sendToTc002 } from './tc002';
import { findActiveEventTheme, localDate, pickRandomTopic, pickTheme, type AgendaLookup, type Theme } from './topics';
import type { Config, Env, ProgressFn } from './types';

const TOPIC_THROTTLE_MS = 60 * 60_000; // at most one random-topic image per hour

export interface RunResult {
  theme: Theme;
  frames: number;
}

// Explicit generation from the Web UI: always generates and sends,
// bypassing event dedupe and the topic throttle.
export async function runManual(env: Env, prompt?: string, onProgress?: ProgressFn): Promise<RunResult> {
  let theme: Theme | undefined;
  try {
    const cfg = await getConfig(env);
    onProgress?.({ step: 'theme', detail: 'picking theme...' });
    theme = prompt?.trim()
      ? { kind: 'custom' as const, text: prompt.trim() }
      : await pickTheme(env, cfg);
    onProgress?.({ step: 'theme', detail: `${theme.kind}: ${theme.text}` });
    return await generateSendRecord(env, cfg, theme, onProgress);
  } catch (e) {
    await recordRun(env, { ok: false, ...themeRecord(theme), error: message(e) });
    throw e;
  }
}

// Cron wake (every 10 min): send an image for a newly active agenda event;
// otherwise send a random-topic image, throttled to at most once per hour.
export async function runScheduled(env: Env): Promise<string> {
  // A separate key avoids KV's one-write-per-key-per-second limit on quick runs.
  await env.KV.put('last_scheduled_at', new Date().toISOString());
  try {
    return await schedule(env);
  } catch (e) {
    await recordRun(env, { ok: false, error: message(e) });
    throw e;
  }
}

async function schedule(env: Env): Promise<string> {
  const cfg = await getConfig(env);
  const now = new Date();
  const token = await getCalendarToken(env);

  const agenda: AgendaLookup = {};
  let active = null;
  if (token && cfg.agendaCalendars.length > 0) {
    try {
      active = await findActiveEventTheme(token, cfg, now, agenda);
    } catch (e) {
      // calendar failure falls through to the throttled random topic
      console.error('agenda check failed:', e);
    }
  }
  if (active) {
    const lastKey = await env.KV.get('last_event_key');
    if (lastKey === active.key) {
      await recordRun(env, {
        ok: true,
        skipped: 'active event already sent',
        ...themeRecord(active.theme),
      });
      return 'skipped-same-event';
    }
    await generateSendRecord(env, cfg, active.theme);
    await env.KV.put('last_event_key', active.key);
    return 'sent-event';
  }

  const lastTopicAt = Number((await env.KV.get('last_topic_at')) ?? 0);
  if (now.getTime() - lastTopicAt < TOPIC_THROTTLE_MS) {
    await recordRun(env, { ok: true, skipped: 'topic throttled (max 1/hour)' });
    return 'skipped-topic-throttled';
  }
  const theme = await pickRandomTopic(env, cfg, token, now, agenda);
  await generateSendRecord(env, cfg, theme);
  await env.KV.put('last_topic_at', String(now.getTime()));
  if (theme.kind === 'calendar-event') await env.KV.put('last_topic_kind', theme.kind);
  return 'sent-topic';
}

async function generateSendRecord(
  env: Env,
  cfg: Config,
  theme: Theme,
  onProgress?: ProgressFn,
): Promise<RunResult> {
  const art = await generatePixelArt(env, cfg, theme, onProgress);
  onProgress?.({ step: 'gif', detail: `encoded ${art.frames} frame(s), 52x16` });
  onProgress?.({ step: 'tc002', detail: 'sending to TC002...' });
  await sendToTc002(env, cfg, art.gifBase64);
  if (theme.kind !== 'calendar-event' && theme.kind !== 'custom') {
    await env.KV.put('last_topic_kind', theme.kind);
    if (theme.kind === 'holiday') {
      await env.KV.put('last_holiday_date', localDate(new Date(), cfg.timezone));
    }
  }
  await env.KV.put('last_gif', art.gifBase64);
  await recordRun(env, {
    ok: true,
    ...themeRecord(theme),
    frames: art.frames,
  });
  return { theme, frames: art.frames };
}

function themeRecord(theme?: Theme): Record<string, unknown> {
  if (!theme) return {};
  return {
    kind: theme.kind,
    theme: theme.text,
    timeLabel: theme.timeLabel ?? null,
    ...(theme.eventFields ? { eventFields: theme.eventFields } : {}),
  };
}

async function recordRun(env: Env, info: Record<string, unknown>): Promise<void> {
  await env.KV.put('last_run', JSON.stringify({ at: new Date().toISOString(), ...info }));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
