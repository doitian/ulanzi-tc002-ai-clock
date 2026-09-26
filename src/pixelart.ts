import { GIFEncoder } from 'gifenc';
import { MATRIX_H, MATRIX_W, renderScene, type RenderedScene } from './scene';
import type { Theme } from './topics';
import type { Config, Env, ProgressFn } from './types';

export interface GeneratedArt {
  gifBase64: string;
  frames: number;
}

const SYSTEM_PROMPT = `Design pixel art for a 52x16 LED matrix. Output ONLY a JSON object describing a scene; the application renders it, so do NOT output a 52x16 grid.

Schema:
{
  "palette": ["#000000", "#F5B93D", "#35C5E8", "#FFFFFF"],
  "base": [
    {"kind":"rect","x":0,"y":14,"w":52,"h":2,"color":2},
    {"kind":"ellipse","x":19,"y":2,"w":14,"h":12,"color":1},
    {"kind":"line","x":2,"y":10,"x2":12,"y2":5,"color":3},
    {"kind":"sprite","x":43,"y":2,"rows":["01110","12221","01110"]}
  ],
  "frames": [[]],
  "delayMs": 400
}
This is a schema example, NOT a scene to copy. Create recognizable pixel art fitting the requested subject.

Canvas coordinates: x=0..51 left to right; y=0..15 top to bottom. Colors are zero-based palette indexes, where palette[0] MUST be #000000 (LED off). Use 3-10 vivid, contrasting colors. Every shape MUST use the "kind" key (rect, ellipse, line, sprite), with the fields shown above. Rect and ellipse may set "fill":false to draw an outline. Sprite rows use single hexadecimal palette-index characters; 0 in a sprite is transparent. Put static shapes in "base" (up to 60). Each frame is a list of animated overlay shapes (up to 30); use "frames":[[]] for a still image or 2-6 frames for simple motion. Shapes draw in listed order.

The canvas is BLACK by default; do NOT paint a sky, background, or filled 52x16 rectangle! No large filled rectangles covering more than 100 pixels. Make a coherent full-width scene, not a small icon in a corner. Give the main subject a bold silhouette with foreground and small atmospheric details on BOTH edges. Span at least 40 columns and 9 rows with 75-420 lit pixels total; most LEDs MUST remain off. Use 8-25 thoughtful shapes/sprites rather than hundreds of tiny dots. A single line across the width alone is not sufficient. No written text: the application draws calendar time itself.`;

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
  for (let attempt = 0; attempt < 3; attempt++) {
    onProgress?.({ step: 'llm', detail: `designing scene with ${cfg.openaiModel} (attempt ${attempt + 1}/3)` });
    const content = await chatCompletion(env, cfg, messages, onProgress);
    try {
      const art = renderScene(extractJson(content), theme.timeLabel);
      onProgress?.({ step: 'scene', detail: `rendered ${art.frames.length} full-canvas frame(s)` });
      return { gifBase64: encodeGif(art), frames: art.frames.length };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      onProgress?.({ step: 'scene', detail: `revising scene: ${lastError}` });
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: `Your scene did not render well: ${lastError}. Return a NEW complete JSON scene that fixes this issue. Use "kind" for each shape. The unlit canvas is already black: NEVER draw a large filled background or sky. Spread the subject and small details across the drawing area. JSON only.` });
    }
  }
  throw new Error(`pixel art generation failed: ${lastError}`);
}

function userPrompt(theme: Theme): string {
  if (theme.timeLabel) {
    return `Illustrate ${theme.text}. Use the WHOLE 52x16 canvas: compelling subject near center, balanced details on both left and right edges, foreground and background. Keep the bottom-right corner (x=34..51, y=10..15) dark and empty; the application overlays the static 24-hour event time ${theme.timeLabel} there. Do not draw text.`;
  }
  return `Illustrate ${theme.text}. Use the WHOLE 52x16 canvas: compelling subject near center, balanced details on both left and right edges, foreground and background. Do not draw text.`;
}

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
    body: JSON.stringify({
      model: cfg.openaiModel,
      messages,
      temperature: 1.0,
      stream: true,
      ...(cfg.openaiThinking === 'on' ? { enable_thinking: true } : {}),
      ...(cfg.openaiThinking === 'off' ? { enable_thinking: false } : {}),
    }),
  });
  if (!res.ok) throw new Error(`LLM API error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  if (!res.body) throw new Error('LLM API returned no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = 0;
  let reportedContent = 0;
  let reportedReasoning = 0;
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
          const delta = (JSON.parse(data) as {
            choices?: { delta?: { content?: string; reasoning_content?: string } }[];
          }).choices?.[0]?.delta;
          if (delta?.reasoning_content) reasoning += delta.reasoning_content.length;
          if (delta?.content) {
            if (!content) onProgress?.({ step: 'llm', detail: 'receiving scene...' });
            content += delta.content;
          }
        } catch {}
      }
    }
    if (reasoning > 0 && (reportedReasoning === 0 || reasoning - reportedReasoning >= 500)) {
      reportedReasoning = reasoning;
      onProgress?.({ step: 'think', detail: `thinking... ${reasoning} chars` });
    }
    if (content.length - reportedContent >= 1000) {
      reportedContent = content.length;
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

function hexToRgb(hex: string): number[] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function encodeGif(art: RenderedScene): string {
  const gif = GIFEncoder();
  const palette = art.palette.map(hexToRgb);
  for (const frame of art.frames) {
    gif.writeFrame(frame, MATRIX_W, MATRIX_H, {
      palette,
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
