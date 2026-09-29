import assert from 'node:assert/strict';
import test from 'node:test';
import { getConfig, saveConfig } from '../src/config.ts';
import worker from '../src/index.ts';
import { renderUi } from '../src/ui.ts';

function setup(config) {
  const values = new Map([['session:test', 'test@example.com']]);
  if (config) values.set('config', JSON.stringify(config));
  const env = { KV: {
    get: async (key, type) => {
      const value = values.get(key) ?? null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key, value) => { values.set(key, value); },
  } };
  return { env, values };
}

test('new and existing configurations default to a 12-minute model timeout', async () => {
  for (const stored of [undefined, { openaiModel: 'existing-model' }]) {
    const { env } = setup(stored);
    assert.equal((await getConfig(env)).openaiTimeoutMinutes, 12);
  }
});

test('model timeout accepts whole minutes and persists as a number across partial updates', async () => {
  const { env, values } = setup();
  for (const value of [1, 60, '8']) {
    await saveConfig(env, { openaiTimeoutMinutes: value });
    assert.equal(JSON.parse(values.get('config')).openaiTimeoutMinutes, Number(value));
    await saveConfig(env, { weatherLocation: 'Shanghai' });
    assert.equal((await getConfig(env)).openaiTimeoutMinutes, Number(value));
  }
});

test('invalid model timeouts reject the entire config update', async () => {
  const { env, values } = setup({ openaiTimeoutMinutes: 12 });
  const original = values.get('config');
  for (const value of [0, -1, 61, 1.5, '', ' ', 'nope', null, true, [], {}, NaN, Infinity]) {
    await assert.rejects(saveConfig(env, { openaiModel: 'changed', openaiTimeoutMinutes: value }), /whole number between 1 and 60/);
    assert.equal(values.get('config'), original);
  }
});

test('config API reports invalid timeouts as 400 and accepts valid values', async () => {
  const { env } = setup();
  for (const [minutes, status] of [[0, 400], [7, 200]]) {
    const request = new Request('https://clock.example/api/config', {
      method: 'POST',
      headers: { Cookie: 'session=test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ openaiTimeoutMinutes: minutes }),
    });
    const response = await worker.fetch(request, env, {});
    assert.equal(response.status, status);
    const body = await response.json();
    if (status === 200) assert.equal(body.config.openaiTimeoutMinutes, minutes);
    else assert.match(body.error, /Model timeout/);
  }
});

test('UI includes the timeout field and generates valid client JavaScript', () => {
  const html = renderUi();
  assert.match(html, /id="f_timeout" min="1" max="60"/);
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new Function(script));
  }
});
