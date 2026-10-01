import assert from 'node:assert/strict';
import test from 'node:test';
import { saveConfig } from '../src/config.ts';
import { runManual, runScheduled } from '../src/pipeline.ts';

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
  const requests = [];
  const env = {
    OPENAI_API_KEY: 'test-key', TC002_TOKEN: 'test-token',
    KV: {
      get: async (key, type) => {
        const value = values.get(key) ?? null;
        return type === 'json' ? JSON.parse(value) : value;
      },
      put: async (key, value) => { values.set(key, value); writes.push([key, value]); },
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
  return { env, values, writes, requests, fetchMock };
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
  assert.equal(await runScheduled(env), 'sent-event');
  assert.equal(values.get('last_event_key'), 'Agenda|new');
});

test('errors before generation replace stale status too', async (t) => {
  const { env, values } = setup(t);
  values.set('config', 'invalid json');
  await assert.rejects(runScheduled(env));
  assert.equal(JSON.parse(values.get('last_run')).ok, false);
});
