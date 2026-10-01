import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { findActiveEventTheme, localDate, pickRandomTopic } from '../src/topics.ts';

function calendarFetch(items) {
  return async (url) => {
    const u = String(url);
    if (u.includes('calendarList')) {
      return Response.json({ items: [{ id: 'work-id', summary: 'Work' }] });
    }
    if (u.includes('/calendars/work-id/events')) return Response.json({ items });
    return new Response('', { status: 503 });
  };
}

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

test('does not lock the schedule on an all-day Out of office stored at local midnight', async () => {
  const now = new Date('2026-10-01T08:51:03.361Z');
  const cfg = {
    ...DEFAULT_CONFIG,
    agendaCalendars: ['Work'],
    timezone: 'Asia/Shanghai',
    skipAllDayAgendaEvents: true,
    weatherLocation: '',
  };
  const ooo = {
    id: 'ooo',
    summary: 'Out of office',
    eventType: 'outOfOffice',
    start: { dateTime: '2026-10-01T00:00:00+08:00', timeZone: 'Asia/Shanghai' },
    end: { dateTime: '2026-10-02T00:00:00+08:00', timeZone: 'Asia/Shanghai' },
  };
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  try {
    globalThis.fetch = calendarFetch([ooo]);
    const active = await findActiveEventTheme('fake-token', cfg, now);
    assert.equal(active, null);

    Math.random = () => 0;
    const env = {
      KV: {
        get: async (key) => (key === 'last_topic_kind' ? 'mood' : null),
        put: async () => {},
      },
    };
    const theme = await pickRandomTopic(env, cfg, 'fake-token', now);
    assert.equal(theme.kind, 'calendar-event');
    assert.equal(theme.text, 'Calendar event "Out of office"');
    assert.equal(theme.timeLabel, undefined);
    assert.deepEqual(theme.eventFields, {
      summary: 'Out of office',
      eventType: 'outOfOffice',
      start: { dateTime: '2026-10-01T00:00:00+08:00', timeZone: 'Asia/Shanghai' },
      end: { dateTime: '2026-10-02T00:00:00+08:00', timeZone: 'Asia/Shanghai' },
      detectedAllDay: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

test('keeps a midnight meeting timed and reports the fields used to decide', async () => {
  const now = new Date('2026-09-30T16:30:00Z');
  const cfg = { ...DEFAULT_CONFIG, agendaCalendars: ['Work'], timezone: 'Asia/Shanghai' };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = calendarFetch([{
      id: 'deploy',
      summary: 'Night deploy',
      start: { dateTime: '2026-10-01T00:00:00+08:00', timeZone: 'Asia/Shanghai' },
      end: { dateTime: '2026-10-01T01:00:00+08:00', timeZone: 'Asia/Shanghai' },
    }]);
    const active = await findActiveEventTheme('fake-token', cfg, now);
    assert.equal(active?.theme.timeLabel, '00:00');
    assert.equal(active?.theme.eventFields?.detectedAllDay, false);
    assert.equal(active?.theme.eventFields?.start?.dateTime, '2026-10-01T00:00:00+08:00');
    assert.equal(active?.theme.eventFields?.end?.dateTime, '2026-10-01T01:00:00+08:00');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
