import { buildAuthUrl, disconnectGoogle, handleAuthCallback, isGoogleConnected } from './calendar';
import { getConfig, saveConfig } from './config';
import { runManual, runScheduled } from './pipeline';
import type { Config, Env } from './types';
import { renderUi } from './ui';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' && request.method === 'GET') {
      return new Response(renderUi(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // Google redirects here without our Authorization header, so this route is
    // protected by the single-use state token created by /auth/google instead.
    if (path === '/auth/google/callback') {
      const state = url.searchParams.get('state') ?? '';
      const stored = await env.KV.get('oauth_state');
      await env.KV.delete('oauth_state');
      if (!state || !stored || state !== stored) return json({ error: 'invalid oauth state' }, 403);
      const code = url.searchParams.get('code');
      if (!code) return json({ error: 'missing code' }, 400);
      try {
        await handleAuthCallback(env, code, `${url.origin}/auth/google/callback`);
        return Response.redirect(`${url.origin}/?auth=ok`, 302);
      } catch (e) {
        return json({ error: message(e) }, 500);
      }
    }

    if (!path.startsWith('/api/') && !path.startsWith('/auth/')) {
      return json({ error: 'not found' }, 404);
    }
    const denied = requireAdmin(request, env);
    if (denied) return denied;

    try {
      if (path === '/api/state' && request.method === 'GET') return await handleState(env);
      if (path === '/api/config' && request.method === 'POST') return await handleSaveConfig(request, env);
      if (path === '/api/generate' && request.method === 'POST') return await handleGenerate(request, env);
      if (path === '/api/last.gif' && request.method === 'GET') return await handleLastGif(env);
      if (path === '/auth/google' && request.method === 'POST') return await handleGoogleAuthStart(env, url.origin);
      if (path === '/auth/google/disconnect' && request.method === 'POST') {
        await disconnectGoogle(env);
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: message(e) }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Fires every 10 minutes (wrangler.toml); dedupe/throttle live in runScheduled.
    ctx.waitUntil(runScheduled(env).catch((e) => console.error('scheduled run failed:', e)));
  },
};

async function handleState(env: Env): Promise<Response> {
  const config = await getConfig(env);
  return json({
    config,
    secrets: {
      openaiApiKey: !!env.OPENAI_API_KEY,
      tc002Token: !!env.TC002_TOKEN,
      googleClientId: !!env.GOOGLE_CLIENT_ID,
      googleClientSecret: !!env.GOOGLE_CLIENT_SECRET,
    },
    tc002BaseEffective: config.tc002BaseUrl || env.TC002_BASE || '',
    googleConnected: await isGoogleConnected(env),
    lastRun: await env.KV.get('last_run', 'json'),
    hasLastGif: (await env.KV.get('last_gif')) !== null,
    serverTime: new Date().toISOString(),
  });
}

async function handleSaveConfig(request: Request, env: Env): Promise<Response> {
  const patch = (await request.json()) as Partial<Config>;
  const config = await saveConfig(env, patch);
  return json({ ok: true, config });
}

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { prompt?: string };
  const result = await runManual(env, body.prompt);
  return json({ ok: true, ...result });
}

async function handleLastGif(env: Env): Promise<Response> {
  const b64 = await env.KV.get('last_gif');
  if (!b64) return json({ error: 'no image generated yet' }, 404);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' } });
}

async function handleGoogleAuthStart(env: Env, origin: string): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID var is not set');
  const state = crypto.randomUUID();
  await env.KV.put('oauth_state', state, { expirationTtl: 600 });
  return json({ url: buildAuthUrl(env, `${origin}/auth/google/callback`, state) });
}

function requireAdmin(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) return json({ error: 'ADMIN_TOKEN secret is not set on the worker' }, 500);
  if (request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
