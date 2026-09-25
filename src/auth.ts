import type { Env } from './types';

const SESSION_TTL_S = 30 * 24 * 3600;

export async function createSession(env: Env, email: string): Promise<string> {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
  await env.KV.put(`session:${token}`, email, { expirationTtl: SESSION_TTL_S });
  return token;
}

export async function getSessionEmail(request: Request, env: Env): Promise<string | null> {
  const token = readCookie(request.headers.get('Cookie'), 'session');
  if (!token) return null;
  return env.KV.get(`session:${token}`);
}

export async function destroySession(request: Request, env: Env): Promise<void> {
  const token = readCookie(request.headers.get('Cookie'), 'session');
  if (token) await env.KV.delete(`session:${token}`);
}

export function sessionCookie(token: string): string {
  return `session=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
}

export function clearSessionCookie(): string {
  return 'session=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0';
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
