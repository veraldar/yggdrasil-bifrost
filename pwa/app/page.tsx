'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PixelIcon } from '@/components/pixel-icon';
import { slugify } from '@/lib/slug';
import { askedSessions, clearAsked, notifyReply } from '@/lib/notify';

type Sess = { id: string; title: string; preview: string; updated: number; lastRole?: string };

export default function SessionsPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Sess[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const loadInFlightRef = useRef(false);

  const load = useCallback(async () => {
    // backgrounded mobile tabs freeze in-flight polls for minutes and then
    // fail on resume — bound each request, never overlap, never throw
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setLoading(true);
    try {
      const r = await fetch('/api/session', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      const list: Sess[] = await r.json();
      setSessions(list);
      // sessions the user asked a question in: when a reply lands, it's
      // their turn again — notify (even from the background)
      for (const s of list) {
        const slug = slugify(s.title || s.id);
        if (!askedSessions().includes(slug)) continue;
        if (s.lastRole === 'assistant') {
          clearAsked(slug);
          void notifyReply(slug);
        }
      }
    } catch {
      /* transient — keep showing the stale list */
    } finally {
      loadInFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // background watcher for "my turn" across sessions
    const t = setInterval(() => {
      if (document.hidden) void load();
    }, 8000);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  async function create() {
    const title = name.trim() || `session ${new Date().toLocaleString()}`;
    const r = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: title }),
    });
    const s = await r.json();
    if (s.id) router.push(`/session/${slugify(s.title)}?id=${s.id}`);
    setCreating(false);
    setName('');
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="flex items-center justify-between pt-4 pb-2">
        <h1 className="text-sm font-bold tracking-widest uppercase">opencode</h1>
        <button onClick={load} className="text-xs text-[var(--oz-dim)] hover:text-white">
          {loading ? '···' : 'refresh'}
        </button>
      </header>

      <button
        onClick={() => setCreating(true)}
        className="oz-row mb-2 flex items-center gap-2 rounded border border-[var(--oz-success)]/60 px-3 py-3 text-left text-sm text-[var(--oz-success)]"
      >
        <PixelIcon name="plus" size={14} /> new session
      </button>

      {creating && (
        <div className="mb-2 rounded border border-[var(--oz-border)] bg-[var(--oz-surface)] p-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder="session name…"
            className="w-full bg-transparent pb-3 text-sm outline-none placeholder:text-[var(--oz-dim)]"
          />
          <div className="flex gap-2 text-xs">
            <button
              onClick={create}
              className="flex-1 rounded border border-[var(--oz-success)]/60 py-2 text-[var(--oz-success)]"
            >
              create & open
            </button>
            <button
              onClick={() => setCreating(false)}
              className="rounded border border-[var(--oz-border)] px-4 py-2 text-[var(--oz-dim)]"
            >
              cancel
            </button>
          </div>
        </div>
      )}

      <ul className="flex flex-col gap-1">
        {sessions.map((s) => (
          <li key={s.id}>
            <button
              onClick={() => router.push(`/session/${slugify(s.title)}?id=${s.id}`)}
              className="oz-row w-full rounded border border-[var(--oz-border)] bg-[var(--oz-surface)] px-3 py-2 text-left"
            >
              <div className="truncate text-sm">{s.title || s.id}</div>
              <div className="truncate text-xs text-[var(--oz-dim)]">{s.preview || '\u00a0'}</div>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
