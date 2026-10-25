import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { generatePixelArt } from '../src/pixelart.ts';

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

function sse(content, reasoning) {
  const delta = { content };
  if (reasoning) delta.reasoning_content = reasoning;
  return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
}

function env() {
  return { OPENAI_API_KEY: 'openai-key', KV: {} };
}

test('each image generation gets a new OpenCode session id and retries reuse it', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    if (calls.length === 1) return sse('not json', 'thinking about the scene');
    return sse(JSON.stringify(scene));
  });
  const theme = { kind: 'mood', text: 'a cat' };
  await generatePixelArt(env(), DEFAULT_CONFIG, theme);
  await generatePixelArt(env(), DEFAULT_CONFIG, theme);

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://opencode.ai/inference/go/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer openai-key');
  assert.equal(calls[0].headers['User-Agent'], 'ulanzi-tc002-ai-clock/0.1.0');
  assert.equal(calls[0].body.model, 'deepseek-v4.1-flash');
  assert.match(calls[0].headers['x-opencode-session'], /^[0-9a-f-]{36}$/);
  assert.equal(calls[1].headers['x-opencode-session'], calls[0].headers['x-opencode-session']);
  assert.equal(calls[1].body.messages.at(-2).reasoning_content, 'thinking about the scene');
  assert.notEqual(calls[2].headers['x-opencode-session'], calls[0].headers['x-opencode-session']);
});

test('every endpoint uses OPENAI_API_KEY and sends a session header', async (t) => {
  let init;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    init = options;
    return sse(JSON.stringify(scene));
  });
  const cfg = { ...DEFAULT_CONFIG, openaiBaseUrl: 'https://api.openai.com/v1', openaiModel: 'gpt-4o' };
  await generatePixelArt(env(), cfg, { kind: 'mood', text: 'a cat' });
  assert.equal(init.headers.Authorization, 'Bearer openai-key');
  assert.match(init.headers['x-opencode-session'], /^[0-9a-f-]{36}$/);
  assert.equal(JSON.parse(init.body).model, 'gpt-4o');
});

test('generation fails when OPENAI_API_KEY is missing', async () => {
  const missing = env();
  delete missing.OPENAI_API_KEY;
  await assert.rejects(generatePixelArt(missing, DEFAULT_CONFIG, { kind: 'mood', text: 'a cat' }), /OPENAI_API_KEY/);
});
