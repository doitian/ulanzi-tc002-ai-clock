import assert from 'node:assert/strict';
import test from 'node:test';
import { saveConfig } from '../src/config.ts';
import worker from '../src/index.ts';
import { getFailureLogs, runManual, runScheduled } from '../src/pipeline.ts';

const now = Date.parse('2026-09-29T02:54:00Z');
const standup = {
  id: 'standup', summary: 'Dev Stand-up Meeting',
  start: { dateTime: '2026-09-29T09:00:00+08:00' },
  end: { dateTime: '2026-09-29T09:30:00+08:00' },
};
const commitment = {
  id: 'personal', summary: 'Busy: Personal Commitment (appointment)',
  start: { dateTime: '2026-09-29T10:30:00+08:00' },
  end: { dateTime: '2026-09-29T11:30:00+08:00' },
};
const scene = {
  palette: ['#000000', '#ffb92f', '#22bbdd'],
  base: [
    { kind: 'rect', x: 0, y: 15, w: 52, h: 1, color: 2 },
    { kind: 'ellipse', x: 7, y: 1, w: 17, h: 13, color: 1 },
    { kind: 'rect', x: 0, y: 3, w: 5, h: 8, color: 2 },
    { kind: 'rect', x: 40, y: 2, w: 8, h: 6, color: 2 },
  ],
  frames: [[]],
};

function setup(t, events = [standup, commitment]) {
  t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.method(Math, 'random', () => 0.999);
  const progressMock = t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const values = new Map([
    ['config', JSON.stringify({
      agendaCalendars: ['Agenda'], eventExclusionPattern: 'personal commitment',
      tc002BaseUrl: 'https://clock.example',
    })],
    ['google_tokens', JSON.stringify({ refresh_token: 'refresh', access_token: 'token', access_token_expires: now + 3600_000 })],
    ['last_event_key', 'Agenda|standup'],
    ['last_topic_at', String(now - 2 * 3600_000)],
    ['last_run', JSON.stringify({ at: '2026-09-29T01:10:53.084Z', ok: true, skipped: 'active event already sent' })],
  ]);
  const writes = [];
  const writeOptions = new Map();
  const requests = [];
  const env = {
    OPENAI_API_KEY: 'test-key', TC002_TOKEN: 'test-token',
    KV: {
      get: async (key, type) => {
        const value = values.get(key) ?? null;
        return type === 'json' ? JSON.parse(value) : value;
      },
      put: async (key, value, options) => {
        values.set(key, value);
        writes.push([key, value]);
        writeOptions.set(key, options);
      },
      delete: async (key) => { values.delete(key); },
      list: async ({ prefix, limit, cursor }) => {
        const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).sort();
        const start = Number(cursor ?? 0);
        const end = start + limit;
        return {
          keys: keys.slice(start, end).map((name) => ({ name })),
          list_complete: end >= keys.length,
          cursor: String(end),
        };
      },
    },
  };
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push(String(url));
    assert.ok(init.signal instanceof AbortSignal);
    init.signal.throwIfAborted();
    if (String(url).includes('calendarList')) return Response.json({ items: [{ id: 'agenda-id', summary: 'Agenda' }] });
    if (String(url).includes('/calendars/agenda-id/events')) return Response.json({ items: events });
    if (String(url).endsWith('/chat/completions')) {
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(scene) } }] })}\n\ndata: [DONE]\n\n`);
    }
    if (String(url).endsWith('/api/apps/random')) {
      assert.match(JSON.parse(init.body).image, /^data:image\/gif;base64,/);
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  return { env, values, writes, writeOptions, requests, fetchMock, progressMock };
}

test('ended stand-up and excluded ongoing commitment fall through to a mood image', async (t) => {
  const { env, values, writes, requests } = setup(t);
  assert.equal(await runScheduled(env), 'sent-topic');
  assert.deepEqual(writes[0], ['last_scheduled_at', new Date(now).toISOString()]);
  assert.equal(writes.filter(([key]) => key === 'last_run').length, 1);
  assert.equal(JSON.parse(values.get('last_run')).kind, 'mood');
  assert.equal(JSON.parse(values.get('last_run')).ok, true);
  assert.equal(values.get('last_topic_at'), String(now));
  assert.equal(values.get('last_event_key'), 'Agenda|standup');
  assert.equal(requests.filter((url) => url.endsWith('/api/apps/random')).length, 1);
});

test('excluded commitment does not hide another eligible ongoing event', async (t) => {
  const { env, values } = setup(t, [commitment, {
    ...standup, id: 'other', end: { dateTime: '2026-09-29T11:00:00+08:00' },
  }]);
  assert.equal(await runScheduled(env), 'sent-event');
  assert.equal(values.get('last_event_key'), 'Agenda|other');
  assert.equal(JSON.parse(values.get('last_run')).timeLabel, '09:00');
});

test('an already sent event only suppresses topics while still active', async (t) => {
  const { env, values, requests } = setup(t, [{
    ...standup, end: { dateTime: '2026-09-29T11:00:00+08:00' },
  }]);
  assert.equal(await runScheduled(env), 'skipped-same-event');
  const lastRun = JSON.parse(values.get('last_run'));
  assert.equal(lastRun.skipped, 'active event already sent');
  assert.deepEqual(lastRun.eventFields, {
    summary: 'Dev Stand-up Meeting',
    start: { dateTime: '2026-09-29T09:00:00+08:00' },
    end: { dateTime: '2026-09-29T11:00:00+08:00' },
    detectedAllDay: false,
  });
  assert.equal(requests.length, 2);
});

test('excluded events still respect the hourly random-topic throttle', async (t) => {
  const { env, values } = setup(t);
  values.set('last_topic_at', String(now - 30 * 60_000));
  assert.equal(await runScheduled(env), 'skipped-topic-throttled');
  assert.equal(JSON.parse(values.get('last_run')).skipped, 'topic throttled (max 1/hour)');
});

for (const [name, run] of [['manual', runManual], ['scheduled', runScheduled]]) {
  test(`${name} generation uses the configured timeout without changing other deadlines`, async (t) => {
    const { env } = setup(t);
    await saveConfig(env, { openaiTimeoutMinutes: 8 });
    const timeout = t.mock.method(AbortSignal, 'timeout');
    await run(env);
    assert.deepEqual(timeout.mock.calls.map(({ arguments: [ms] }) => ms), [30_000, 30_000, 480_000, 30_000]);
  });
}

test('a model timeout replaces stale success without consuming the topic throttle', async (t) => {
  const { env, values } = setup(t);
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms) => ms === 720_000
    ? AbortSignal.abort(new DOMException('Model request timed out', 'TimeoutError'))
    : timeout(ms));
  await assert.rejects(runScheduled(env), /Model request timed out/);
  assert.equal(JSON.parse(values.get('last_run')).ok, false);
  assert.match(JSON.parse(values.get('last_run')).error, /timed out/);
  const [failure] = await getFailureLogs(env);
  assert.equal(failure.stage, 'llm');
  assert.equal(failure.delivered, false);
  assert.equal(failure.kind, 'mood');
  assert.match(failure.logs.at(-1).detail, /attempt 1\/3/);
  assert.equal(values.get('last_topic_at'), String(now - 2 * 3600_000));
  assert.equal(values.has('last_gif'), false);
});

test('event generation errors do not get mistaken for calendar errors and send a random topic', async (t) => {
  const { env, values, fetchMock } = setup(t, [{
    ...standup, id: 'new', end: { dateTime: '2026-09-29T11:00:00+08:00' },
  }]);
  delete env.OPENAI_API_KEY;
  await assert.rejects(runScheduled(env), /OPENAI_API_KEY/);
  assert.equal(values.get('last_event_key'), 'Agenda|standup');
  assert.equal(values.get('last_topic_at'), String(now - 2 * 3600_000));
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('delivery timeout leaves the event eligible for retry', async (t) => {
  const { env, values, fetchMock } = setup(t, [{
    ...standup, id: 'new', end: { dateTime: '2026-09-29T11:00:00+08:00' },
  }]);
  fetchMock.mock.mockImplementationOnce(async () => {
    throw new DOMException('Clock request timed out', 'TimeoutError');
  }, 3);
  await assert.rejects(runScheduled(env), /Clock request timed out/);
  assert.equal(values.get('last_event_key'), 'Agenda|standup');
  assert.equal(JSON.parse(values.get('last_run')).ok, false);
  assert.equal(values.has('last_gif'), false);
  const [failure] = await getFailureLogs(env);
  assert.equal(failure.stage, 'tc002');
  assert.match(failure.theme, /Dev Stand-up Meeting/);
  assert.equal(failure.eventFields.summary, standup.summary);
  assert.deepEqual(failure.eventFields.start, standup.start);
  assert.equal(failure.frames, 1);
  assert.equal(failure.delivered, false);
  assert.match(failure.logs.at(-1).detail, /sending to TC002/);
  assert.equal(await runScheduled(env), 'sent-event');
  assert.equal(values.get('last_event_key'), 'Agenda|new');
  assert.equal(JSON.parse(values.get('last_run')).ok, true);
  assert.deepEqual(await getFailureLogs(env), [failure]);
});

test('errors before generation replace stale status too', async (t) => {
  const { env, values } = setup(t);
  values.set('config', 'invalid json');
  await assert.rejects(runScheduled(env));
  assert.equal(JSON.parse(values.get('last_run')).ok, false);
  assert.equal((await getFailureLogs(env))[0].stage, 'config');
});

for (const [source, run] of [['manual', runManual], ['scheduled', runScheduled]]) {
  test(`${source} delivery HTTP errors save diagnostic history for 30 days`, async (t) => {
    const { env, values, writeOptions, fetchMock } = setup(t);
    fetchMock.mock.mockImplementationOnce(async () => new Response('Clock is offline', { status: 503 }), 3);
    await assert.rejects(run(env), /TC002 error 503: Clock is offline/);
    const [failure] = await getFailureLogs(env);
    assert.equal(failure.source, source);
    assert.equal(failure.stage, 'tc002');
    assert.equal(failure.startedAt, new Date(now).toISOString());
    assert.equal(failure.logs[0].at, failure.startedAt);
    assert.match(failure.stack, /Clock is offline/);
    assert.ok(failure.logs.some((entry) => entry.step === 'scene'));
    const [key] = [...values.keys()].filter((key) => key.startsWith('failed_run:'));
    assert.equal(writeOptions.get(key).expirationTtl, 30 * 24 * 3600);
    assert.doesNotMatch(values.get(key), /test-key|test-token|data:image/);
    assert.equal(values.get('last_topic_at'), String(now - 2 * 3600_000));
  });
}

test('authenticated state exposes failure logs after a later successful delivery', async (t) => {
  const { env, values } = setup(t);
  delete env.TC002_TOKEN;
  await assert.rejects(runManual(env, 'a waving cat'), /TC002_TOKEN/);
  env.TC002_TOKEN = 'test-token';
  await runManual(env, 'a waving dog');
  values.set('session:test', 'test@example.com');
  const response = await worker.fetch(new Request('https://clock.example/api/state', {
    headers: { Cookie: 'session=test' },
  }), env, {});
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.lastRun.ok, true);
  assert.equal(state.lastRun.theme, 'a waving dog');
  assert.equal(state.failureLogs.length, 1);
  assert.equal(state.failureLogs[0].theme, 'a waving cat');
  assert.equal(state.failureLogs[0].stage, 'tc002');
  const unauthorized = await worker.fetch(new Request('https://clock.example/api/state'), env, {});
  assert.equal(unauthorized.status, 401);
});

test('history saves only the 3 newest failures and deletes older records', async (t) => {
  const { env, values } = setup(t);
  delete env.OPENAI_API_KEY;
  for (let i = 0; i < 12; i++) {
    t.mock.timers.setTime(now + i * 1000);
    await assert.rejects(runManual(env, `scene ${i}`), /OPENAI_API_KEY/);
  }
  const failures = await getFailureLogs(env);
  assert.equal(failures.length, 3);
  assert.equal([...values.keys()].filter((key) => key.startsWith('failed_run:')).length, 3);
  assert.deepEqual(failures.map((failure) => failure.theme),
    Array.from({ length: 3 }, (_, i) => `scene ${11 - i}`));
});

test('cleanup includes a newly saved failure even before KV listing sees it', async (t) => {
  const { env, values } = setup(t);
  delete env.OPENAI_API_KEY;
  for (let i = 0; i < 3; i++) {
    t.mock.timers.setTime(now + i * 1000);
    await assert.rejects(runManual(env, `scene ${i}`), /OPENAI_API_KEY/);
  }
  const list = env.KV.list;
  const previousKeys = new Set([...values.keys()].filter((key) => key.startsWith('failed_run:')));
  t.mock.method(env.KV, 'list', async (options) => {
    const page = await list(options);
    return { ...page, keys: page.keys.filter((key) => previousKeys.has(key.name)) };
  });
  t.mock.timers.setTime(now + 3000);
  await assert.rejects(runManual(env, 'newest scene'), /OPENAI_API_KEY/);
  const records = [...values.entries()].filter(([key]) => key.startsWith('failed_run:'))
    .map(([, value]) => JSON.parse(value));
  assert.equal(records.length, 3);
  assert.deepEqual(new Set(records.map((record) => record.theme)), new Set(['scene 1', 'scene 2', 'newest scene']));
});

test('cleanup removes older failures across every KV page', async (t) => {
  const { env, values } = setup(t);
  for (let i = 0; i < 8; i++) {
    const order = String(9_999_999_999_999 - (now - (i + 1) * 1000)).padStart(13, '0');
    values.set(`failed_run:${order}:old-${i}`, JSON.stringify({ theme: `old scene ${i}` }));
  }
  const list = env.KV.list;
  t.mock.method(env.KV, 'list', async (options) => list({ ...options, limit: Math.min(2, options.limit) }));
  delete env.OPENAI_API_KEY;
  await assert.rejects(runManual(env, 'newest scene'), /OPENAI_API_KEY/);
  const failures = await getFailureLogs(env);
  assert.equal([...values.keys()].filter((key) => key.startsWith('failed_run:')).length, 3);
  assert.deepEqual(failures.map((failure) => failure.theme), ['newest scene', 'old scene 0', 'old scene 1']);
});

test('concurrent failures at the same timestamp keep separate records', async (t) => {
  const { env } = setup(t);
  delete env.OPENAI_API_KEY;
  const results = await Promise.allSettled([runManual(env, 'first scene'), runManual(env, 'second scene')]);
  assert.ok(results.every((result) => result.status === 'rejected'));
  const failures = await getFailureLogs(env);
  assert.equal(failures.length, 2);
  assert.notEqual(failures[0].runId, failures[1].runId);
  assert.deepEqual(new Set(failures.map((failure) => failure.theme)), new Set(['first scene', 'second scene']));
});

test('history continues past empty KV pages left by expired keys', async (t) => {
  const { env, values } = setup(t);
  delete env.OPENAI_API_KEY;
  await assert.rejects(runManual(env, 'a cat'), /OPENAI_API_KEY/);
  const key = [...values.keys()].find((key) => key.startsWith('failed_run:'));
  t.mock.method(env.KV, 'list', async ({ cursor }) => cursor
    ? { keys: [{ name: key }], list_complete: true }
    : { keys: [], list_complete: false, cursor: 'next-page' });
  const failures = await getFailureLogs(env);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].theme, 'a cat');
});

test('failure to update last_run preserves the original error and independent failure history', async (t) => {
  const { env, values } = setup(t);
  delete env.OPENAI_API_KEY;
  const put = env.KV.put;
  t.mock.method(env.KV, 'put', async (key, value, options) => {
    if (key === 'last_run') throw new Error('KV write limit');
    return put(key, value, options);
  });
  await assert.rejects(runManual(env, 'a cat'), /OPENAI_API_KEY/);
  assert.equal(JSON.parse(values.get('last_run')).ok, true);
  assert.match((await getFailureLogs(env))[0].error, /OPENAI_API_KEY/);
});

test('state-saving errors report that TC002 already accepted the image', async (t) => {
  const { env } = setup(t);
  const put = env.KV.put;
  t.mock.method(env.KV, 'put', async (key, value, options) => {
    if (key === 'last_gif') throw new Error('Could not save preview');
    return put(key, value, options);
  });
  await assert.rejects(runManual(env, 'a cat'), /Could not save preview/);
  const [failure] = await getFailureLogs(env);
  assert.equal(failure.stage, 'state');
  assert.equal(failure.delivered, true);
});

test('progress is logged while generation is waiting, before a final result exists', async (t) => {
  const { env, values, progressMock, fetchMock } = setup(t);
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  fetchMock.mock.mockImplementationOnce(async () => {
    started();
    return await new Promise((resolve) => { release = resolve; });
  }, 2);
  const pending = runScheduled(env);
  await waiting;
  const entries = progressMock.mock.calls.map(({ arguments: [entry] }) => entry);
  assert.equal(entries.at(-1).step, 'llm');
  assert.equal(entries.at(-1).source, 'scheduled');
  assert.equal(entries.at(-1).startedAt, values.get('last_scheduled_at'));
  assert.equal(new Set(entries.map((entry) => entry.runId)).size, 1);
  assert.equal(JSON.parse(values.get('last_run')).at, '2026-09-29T01:10:53.084Z');
  release(new Response('Provider unavailable', { status: 503 }));
  await assert.rejects(pending, /LLM API error 503/);
});
