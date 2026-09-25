/**
 * Proxy to the opencode server (127.0.0.1:4096) — the single source of truth
 * for sessions. Keeps opencode unexposed; the phone only ever talks to this.
 *
 * Routes:
 *   GET    /api/session                 → enriched session list (title + preview, cached 60s)
 *   POST   /api/session                 → {name} create session (title = name)
 *   GET    /api/session/[id]/messages   → transcript
 *   POST   /api/session/[id]/prompt     → {text, images?: string[](dataURL), files?: {name, content}[]}
 *   DELETE /api/session/[id]            → delete
 */
import { NextResponse } from 'next/server';
import { bustCache, getCache, setCache } from '@/lib/oc-cache';
import { isRunLive } from '@/lib/oc-live';

export const dynamic = 'force-dynamic';

const OC = process.env.OPENCODE_URL || 'http://127.0.0.1:4096';

async function ocFetch(path: string, init?: RequestInit) {
  const r = await fetch(`${OC}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(`opencode ${r.status} on ${path}`);
  return r.json();
}

function textOf(parts: Array<{ type?: string; text?: string }> | undefined) {
  return (parts || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join(' ')
    .trim();
}

export async function GET() {
  try {
    const cached = getCache();
    if (cached) return NextResponse.json(cached);
    const sessions = (await ocFetch('/session')) as Array<Record<string, any>>;
    // enrich with last-message preview (LAN-local, fast; cached 60s)
    const enriched = await Promise.all(
      sessions.slice(0, 50).map(async (s) => {
        try {
          // NOTE: /messages (plural) is the SPA catch-all HTML page, not an
          // API — r.json() throws and every session silently enriched empty
          const msgs = (await ocFetch(`/session/${s.id}/message`)) as Array<{
            info?: { role?: string; time?: { created?: number } };
            parts?: Array<{ type?: string; text?: string }>;
          }>;
          const last = [...msgs].reverse().find((m) => textOf(m.parts));
          const lastRole = last?.info?.role || '';
          return {
            id: s.id,
            title: s.title || s.id,
            updated: s.time?.updated || 0,
            preview: textOf(last?.parts).slice(0, 80),
            lastRole,
            // when the last visible message landed — the client compares it
            // against its local read marks to badge unread replies
            lastAt: last?.info?.time?.created || 0,
            // awaiting an answer: a run is live right now (definitive, tracked
            // in-flight by the proxy) or the last visible message is the
            // user's own prompt — such sessions pin to the top of the list
            pending: isRunLive(s.id) || lastRole === 'user',
          };
        } catch {
          return {
            id: s.id,
            title: s.title || s.id,
            updated: s.time?.updated || 0,
            preview: '',
            lastRole: '',
            lastAt: 0,
            pending: isRunLive(s.id),
          };
        }
      })
    );
    enriched.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    // never pin an empty list: a transient opencode scope/failure window must
    // not get cached as "no sessions" — the next poll retries instead
    if (enriched.length) setCache(enriched);
    return NextResponse.json(enriched);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { name } = await req.json();
    const s = await ocFetch('/session', {
      method: 'POST',
      body: JSON.stringify({ title: String(name || '').slice(0, 80) || 'session' }),
    });
    bustCache();
    return NextResponse.json({ id: s.id, title: s.title });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
