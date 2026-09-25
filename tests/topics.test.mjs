import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { localDate, pickRandomTopic } from '../src/topics.ts';

test('shows a holiday at most once per local day', async () => {
  const now = new Date('2026-10-01T02:00:00Z');
  const today = localDate(now, 'Asia/Shanghai');
  const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400_000).toISOString().slice(0, 10);
  const cfg = { ...DEFAULT_CONFIG, holidayCalendars: ['Holidays'], weatherLocation: '' };
  const values = new Map();
  const env = { KV: { get: async (key) => values.get(key) ?? null, put: async (key, value) => values.set(key, value) } };
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  let calendarRequests = 0;
  try {
    Math.random = () => 0.999;
    globalThis.fetch = async (url) => {
      if (String(url).includes('calendarList')) {
        calendarRequests++;
        return Response.json({ items: [{ id: 'holiday-id', summary: 'Holidays' }] });
      }
      if (String(url).includes('/calendars/holiday-id/events')) {
        calendarRequests++;
        return Response.json({ items: [{ summary: 'Example Festival', start: { date: today }, end: { date: tomorrow } }] });
      }
      return new Response('', { status: 503 });
    };
    const first = await pickRandomTopic(env, cfg, 'fake-token', now);
    assert.equal(first.kind, 'holiday');
    assert.equal(calendarRequests, 2);

    values.set('last_holiday_date', today);
    values.set('last_topic_kind', 'holiday');
    const second = await pickRandomTopic(env, cfg, 'fake-token', now);
    assert.notEqual(second.kind, 'holiday');
    assert.equal(calendarRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});
