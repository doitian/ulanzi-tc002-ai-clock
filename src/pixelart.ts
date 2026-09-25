import { GIFEncoder } from 'gifenc';
import type { Theme } from './topics';
import type { Config, Env, ProgressFn } from './types';

export const MATRIX_W = 52;
export const MATRIX_H = 16;
const MAX_COLORS = 16;
const MAX_FRAMES = 8;

interface Art {
  palette: string[];
  frames: number[][][]; // [frame][row][x] = palette index
  delayMs: number;
}

export interface GeneratedArt {
  gifBase64: string;
  frames: number;
}

const SYSTEM_PROMPT = `You are a pixel artist designing animations for a ${MATRIX_W}x${MATRIX_H} LED matrix display (width ${MATRIX_W}, height ${MATRIX_H}) on an Ulanzi TC002 clock.

Reply with STRICT JSON ONLY (no markdown fences, no commentary) in this exact shape:
{
  "palette": ["#000000", "#RRGGBB", "..."],
  "delayMs": 400,
  "frames": [["<row0>", "<row1>", "...", "<row15>"]]
}

Rules:
- "palette": 2 to ${MAX_COLORS} hex colors. Index 0 MUST be "#000000" (black = LED off).
- "frames": 1 to ${MAX_FRAMES} frames. Each frame is exactly ${MATRIX_H} strings; each string is exactly ${MATRIX_W} characters; every character is a hex digit (0-9a-f) giving the palette index of that pixel. Row 0 is the TOP row.
- The background MUST be palette index 0. Keep large areas black so the display looks clean.
- Use bold, simple shapes with high contrast; fine detail is unreadable at this size.
- Any text must use a chunky 3x5-style pixel font, be clearly legible, and be pixel-identical in every frame (text NEVER animates, scrolls, or moves).
- Use more than 1 frame only when a simple looping motion genuinely improves the art (falling rain, blinking stars, waves). Otherwise return exactly 1 frame.
- "delayMs": 200-800 for animations; use 400 for a single frame.`;

export async function generatePixelArt(
  env: Env,
  cfg: Config,
  theme: Theme,
  onProgress?: ProgressFn,
): Promise<GeneratedArt> {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY secret is not set');

  const messages: { role: string; content: string }[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt(theme) },
  ];

  let lastError = 'no response';
  for (let attempt = 0; attempt < 2; attempt++) {
    onProgress?.({ step: 'llm', detail: `requesting art from ${cfg.openaiModel} (attempt ${attempt + 1}/2)` });
    const content = await chatCompletion(env, cfg, messages, onProgress);
    try {
      const art = normalizeArt(extractJson(content));
      return { gifBase64: encodeGif(art), frames: art.frames.length };
    } catch (e) {
      lastError = (e as Error).message;
      onProgress?.({ step: 'llm', detail: `invalid reply: ${lastError}` });
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `That reply was invalid: ${lastError}. Reply with corrected JSON only, no markdown, no commentary.`,
      });
    }
  }
  throw new Error(`pixel art generation failed: ${lastError}`);
}

function userPrompt(theme: Theme): string {
  let p = `Create the pixel art now.\nSubject: ${theme.text}`;
  if (theme.timeLabel) {
    p += `\nThe subject is a calendar event starting at ${theme.timeLabel} (24-hour time). Render "${theme.timeLabel}" as large, clearly readable pixel text that is static (identical) in every frame.`;
  }
  return p;
}

// Streams the chat completion (required by reasoning models on OpenAI-compatible
// providers such as DashScope compatible-mode, and avoids gateway timeouts like
// HTTP 524 on slow models).
async function chatCompletion(
  env: Env,
  cfg: Config,
  messages: { role: string; content: string }[],
  onProgress?: ProgressFn,
): Promise<string> {
  const base = cfg.openaiBaseUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: cfg.openaiModel, messages, temperature: 0.7, stream: true }),
  });
  if (!res.ok) throw new Error(`LLM API error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  if (!res.body) throw new Error('LLM API returned no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reported = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const delta = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] })
            .choices?.[0]?.delta?.content;
          if (delta) content += delta;
        } catch {
          // incomplete JSON fragment - ignore
        }
      }
    }
    if (content.length - reported >= 2000) {
      reported = content.length;
      onProgress?.({ step: 'llm', detail: `streaming... ${content.length} chars received` });
    }
  }
  if (!content) throw new Error('LLM returned an empty response');
  return content;
}

function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found in reply');
  return JSON.parse(raw.slice(start, end + 1));
}

function normalizeArt(raw: unknown): Art {
  if (!raw || typeof raw !== 'object') throw new Error('reply is not a JSON object');
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.palette) || obj.palette.length < 2) {
    throw new Error('palette must be an array of at least 2 colors');
  }
  const palette = obj.palette.slice(0, MAX_COLORS).map(normalizeColor);
  palette[0] = '#000000';

  if (!Array.isArray(obj.frames) || obj.frames.length === 0) {
    throw new Error('frames must be a non-empty array');
  }
  const frames = obj.frames.slice(0, MAX_FRAMES).map((f, i) => normalizeFrame(f, palette.length, i));

  const delayMs = Math.min(2000, Math.max(100, Number(obj.delayMs) || 400));
  return { palette, frames, delayMs };
}

function normalizeColor(c: unknown): string {
  if (typeof c !== 'string') return '#000000';
  const m = c.trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toLowerCase()}` : '#000000';
}

function normalizeFrame(f: unknown, paletteSize: number, fi: number): number[][] {
  if (!Array.isArray(f)) throw new Error(`frame ${fi} is not an array of rows`);
  const rows: number[][] = [];
  for (let y = 0; y < MATRIX_H; y++) {
    const rawRow = typeof f[y] === 'string' ? (f[y] as string) : '';
    const row: number[] = [];
    for (let x = 0; x < MATRIX_W; x++) {
      const v = parseInt(rawRow[x] ?? '0', 16);
      row.push(Number.isNaN(v) || v >= paletteSize ? 0 : v);
    }
    rows.push(row);
  }
  return rows;
}

function hexToRgb(hex: string): number[] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function encodeGif(art: Art): string {
  const gif = GIFEncoder();
  const paletteRgb = art.palette.map(hexToRgb);
  for (const frame of art.frames) {
    const indices = new Uint8Array(MATRIX_W * MATRIX_H);
    for (let y = 0; y < MATRIX_H; y++) {
      for (let x = 0; x < MATRIX_W; x++) indices[y * MATRIX_W + x] = frame[y][x];
    }
    gif.writeFrame(indices, MATRIX_W, MATRIX_H, {
      palette: paletteRgb,
      delay: art.delayMs,
      repeat: 0,
      dispose: -1,
    });
  }
  gif.finish();
  return uint8ToBase64(gif.bytes());
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
