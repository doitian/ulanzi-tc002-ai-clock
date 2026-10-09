import { getCalendarToken } from './calendar';
import { getConfig } from './config';
import { generatePixelArt } from './pixelart';
import { sendToTc002 } from './tc002';
import { findActiveEventTheme, localDate, pickRandomTopic, pickTheme, type AgendaLookup, type Theme } from './topics';
import type { Config, Env, ProgressFn } from './types';

const TOPIC_THROTTLE_MS = 60 * 60_000; // at most one random-topic image per hour
const FAILURE_PREFIX = 'failed_run:';
const FAILURE_TTL_S = 30 * 24 * 3600;
const MAX_FAILURE_RUNS = 3;
const MAX_LOG_ENTRIES = 100;

export interface FailureLog {
  at: string;
  runId: string;
  startedAt: string;
  source: 'manual' | 'scheduled';
  ok: false;
  stage: string;
  delivered: boolean;
  frames?: number;
  error: string;
  stack?: string;
  logs: { at: string; step: string; detail?: string }[];
}

interface RunLog {
  runId: string;
  startedAt: string;
  source: FailureLog['source'];
  stage: string;
  delivered: boolean;
  theme?: Theme;
  frames?: number;
  logs: FailureLog['logs'];
  progress: ProgressFn;
}

export interface RunResult {
  theme: Theme;
  frames: number;
}

// Explicit generation from the Web UI: always generates and sends,
// bypassing event dedupe and the topic throttle.
export async function runManual(env: Env, prompt?: string, onProgress?: ProgressFn): Promise<RunResult> {
  const run = createRunLog('manual', onProgress);
  try {
    run.progress({ step: 'config', detail: 'loading configuration...' });
    const cfg = await getConfig(env);
    run.progress({ step: 'theme', detail: 'picking theme...' });
    run.theme = prompt?.trim()
      ? { kind: 'custom' as const, text: prompt.trim() }
      : await pickTheme(env, cfg);
    run.progress({ step: 'theme', detail: `${run.theme.kind}: ${run.theme.text}` });
    const result = await generateSend(env, cfg, run.theme, run);
    await recordRun(env, run, { ok: true });
    return result;
  } catch (e) {
    await recordFailure(env, run, e);
    throw e;
  }
}

// Cron wake (every 20 min): send an image for a newly active agenda event;
// otherwise send a random-topic image, throttled to at most once per hour.
export async function runScheduled(env: Env): Promise<string> {
  const run = createRunLog('scheduled');
  try {
    run.progress({ step: 'wake', detail: 'scheduled run started' });
    // A separate key avoids KV's one-write-per-key-per-second limit on quick runs.
    await env.KV.put('last_scheduled_at', run.startedAt);
    return await schedule(env, run);
  } catch (e) {
    await recordFailure(env, run, e);
    throw e;
  }
}

async function schedule(env: Env, run: RunLog): Promise<string> {
  run.progress({ step: 'config', detail: 'loading configuration...' });
  const cfg = await getConfig(env);
  const now = new Date();
  run.progress({ step: 'calendar', detail: 'checking agenda calendars...' });
  const token = await getCalendarToken(env);

  const agenda: AgendaLookup = {};
  let active = null;
  if (token && cfg.agendaCalendars.length > 0) {
    try {
      active = await findActiveEventTheme(token, cfg, now, agenda);
    } catch (e) {
      // calendar failure falls through to the throttled random topic
      run.progress({ step: 'calendar', detail: `agenda check failed: ${message(e)}; trying a random topic` });
    }
  }
  if (active) {
    run.theme = active.theme;
    run.progress({ step: 'theme', detail: `${active.theme.kind}: ${active.theme.text}` });
    const lastKey = await env.KV.get('last_event_key');
    if (lastKey === active.key) {
      await recordRun(env, run, {
        ok: true,
        skipped: 'active event already sent',
      });
      return 'skipped-same-event';
    }
    await generateSend(env, cfg, active.theme, run);
    await env.KV.put('last_event_key', active.key);
    await recordRun(env, run, { ok: true });
    return 'sent-event';
  }

  const lastTopicAt = Number((await env.KV.get('last_topic_at')) ?? 0);
  if (now.getTime() - lastTopicAt < TOPIC_THROTTLE_MS) {
    await recordRun(env, run, { ok: true, skipped: 'topic throttled (max 1/hour)' });
    return 'skipped-topic-throttled';
  }
  run.progress({ step: 'theme', detail: 'picking a random topic...' });
  const theme = run.theme = await pickRandomTopic(env, cfg, token, now, agenda);
  run.progress({ step: 'theme', detail: `${theme.kind}: ${theme.text}` });
  await generateSend(env, cfg, theme, run);
  await env.KV.put('last_topic_at', String(now.getTime()));
  if (theme.kind === 'calendar-event') await env.KV.put('last_topic_kind', theme.kind);
  await recordRun(env, run, { ok: true });
  return 'sent-topic';
}

async function generateSend(
  env: Env,
  cfg: Config,
  theme: Theme,
  run: RunLog,
): Promise<RunResult> {
  run.progress({ step: 'llm', detail: 'starting image generation...' });
  const art = await generatePixelArt(env, cfg, theme, run.progress);
  run.frames = art.frames;
  run.progress({ step: 'gif', detail: `encoded ${art.frames} frame(s), 52x16` });
  run.progress({ step: 'tc002', detail: 'sending to TC002 (30-second timeout)...' });
  await sendToTc002(env, cfg, art.gifBase64);
  run.delivered = true;
  run.progress({ step: 'state', detail: 'TC002 accepted the image; saving run state...' });
  if (theme.kind !== 'calendar-event' && theme.kind !== 'custom') {
    await env.KV.put('last_topic_kind', theme.kind);
    if (theme.kind === 'holiday') {
      await env.KV.put('last_holiday_date', localDate(new Date(), cfg.timezone));
    }
  }
  await env.KV.put('last_gif', art.gifBase64);
  return { theme, frames: art.frames };
}

function createRunLog(source: RunLog['source'], onProgress?: ProgressFn): RunLog {
  const run: RunLog = {
    runId: crypto.randomUUID(), startedAt: new Date().toISOString(), source,
    stage: 'start', delivered: false, logs: [],
    progress(event) {
      run.stage = event.step;
      const entry = { at: new Date().toISOString(), step: event.step, detail: event.detail?.slice(0, 1000) };
      run.logs.push(entry);
      if (run.logs.length > MAX_LOG_ENTRIES) run.logs.shift();
      // Workers Logs retains progress even if the runtime terminates before catch.
      console.log({ event: 'run-progress', runId: run.runId, source, startedAt: run.startedAt, ...entry });
      onProgress?.(event);
    },
  };
  return run;
}

async function recordFailure(env: Env, run: RunLog, error: unknown): Promise<void> {
  const failure: FailureLog = {
    at: new Date().toISOString(), runId: run.runId, startedAt: run.startedAt,
    source: run.source, ok: false, stage: run.stage, delivered: run.delivered,
    ...themeRecord(run.theme), frames: run.frames,
    error: message(error), stack: error instanceof Error ? error.stack : undefined,
    logs: run.logs,
  };
  console.error({ event: 'run-failed', ...failure });
  // Inverted timestamps sort newest first. Unique keys preserve concurrent failures
  // and avoid KV's per-key write limit; successes never overwrite this history.
  const order = String(9_999_999_999_999 - Date.parse(failure.at)).padStart(13, '0');
  const key = `${FAILURE_PREFIX}${order}:${run.runId}`;
  const value = JSON.stringify(failure);
  const results = await Promise.allSettled([
    env.KV.put(key, value, { expirationTtl: FAILURE_TTL_S }),
    env.KV.put('last_run', value),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') console.error('could not save failure log:', result.reason);
  }
  if (results[0].status === 'fulfilled') {
    try {
      await pruneFailureLogs(env, key);
    } catch (e) {
      console.error('could not remove older failure logs:', e);
    }
  }
}

async function pruneFailureLogs(env: Env, newKey: string): Promise<void> {
  // Include the new key explicitly: KV listing may lag behind a successful put.
  const keys = new Set([newKey]);
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: FAILURE_PREFIX, limit: 1000, cursor });
    for (const key of page.keys) keys.add(key.name);
    if (page.list_complete) break;
    cursor = page.cursor;
  } while (true);
  // Collect every page before deleting so cleanup does not disturb pagination.
  const older = [...keys].sort().slice(MAX_FAILURE_RUNS);
  await Promise.all(older.map((key) => env.KV.delete(key)));
}

export async function getFailureLogs(env: Env): Promise<FailureLog[]> {
  const failures: FailureLog[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: FAILURE_PREFIX, limit: MAX_FAILURE_RUNS - failures.length, cursor });
    const records = await Promise.all(page.keys.map((key) => env.KV.get<FailureLog>(key.name, 'json')));
    for (const record of records) if (record) failures.push(record);
    if (page.list_complete) break;
    cursor = page.cursor;
  } while (failures.length < MAX_FAILURE_RUNS);
  return failures;
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

async function recordRun(env: Env, run: RunLog, info: Record<string, unknown>): Promise<void> {
  run.progress({ step: 'state', detail: 'recording run result...' });
  await env.KV.put('last_run', JSON.stringify({
    at: new Date().toISOString(), runId: run.runId, startedAt: run.startedAt,
    source: run.source, ...themeRecord(run.theme), frames: run.frames, ...info,
  }));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
