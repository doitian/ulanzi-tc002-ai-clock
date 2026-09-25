import type { Config, Env } from './types';

export async function sendToTc002(env: Env, cfg: Config, gifBase64: string): Promise<void> {
  if (!env.TC002_TOKEN) throw new Error('TC002_TOKEN secret is not set');
  const base = cfg.tc002BaseUrl.replace(/\/+$/, '');
  if (!base) throw new Error('TC002 base URL is not configured (set it in the Web UI)');

  const res = await fetch(`${base}/api/apps/random`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TC002_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ image: `data:image/gif;base64,${gifBase64}` }),
  });
  if (!res.ok) throw new Error(`TC002 error ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
