'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent } from 'livekit-client';
import { PixelIcon } from '@/components/pixel-icon';
import { type Msg, SessionMessage } from '@/components/session-message';
import { diagEvent } from '@/lib/diag';
import { clearAsked, ensureNotifyPermission, markAsked, notifyReply } from '@/lib/notify';

type Mode = 'text' | 'ptt' | 'free';
type Attach =
  | { kind: 'image'; name: string; dataUrl: string }
  | { kind: 'file'; name: string; content: string };

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${what} timeout (${ms / 1000}s)`)), ms)
    ),
  ]);
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

/** Downscale to max 1568px and re-encode JPEG unless it's already small. */
async function downscaleImage(f: File): Promise<string> {
  const MAX = 1568;
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    if (scale === 1 && f.size < 300_000) {
      bmp.close?.();
      return await fileToDataUrl(f);
    }
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return c.toDataURL('image/jpeg', 0.85);
  } catch {
    return await fileToDataUrl(f);
  }
}

/** Collapse consecutive ⚙ tool-only steps into one line with a count —
 *  an edit burst otherwise floods the chat with near-identical bubbles. */
function collapseToolSteps(msgs: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (m.text.startsWith('⚙ ') && prev && prev.text.startsWith('⚙ ')) {
      const n = (prev.count || 1) + 1;
      out[out.length - 1] = { ...m, text: `${m.text} ×${n}`, count: n };
      continue;
    }
    out.push({ ...m });
  }
  return out;
}

export default function SessionView({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ id?: string }>;
}) {
  const [slug, setSlug] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<Mode>('text');
  const [busy, setBusy] = useState(false);
  const [busySecs, setBusySecs] = useState(0);
  const [holding, setHolding] = useState(false);
  const [voiceState, setVoiceState] = useState<'off' | 'connecting' | 'ready'>('off');
  const [error, setError] = useState('');
  const [attachments, setAttachments] = useState<Attach[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(60);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const modeRef = useRef<Mode>('text');
  const unmountedRef = useRef(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const voicePromiseRef = useRef<Promise<Room> | null>(null);
  const echoesRef = useRef<Msg[]>([]);
  const seenRef = useRef(0);
  const pollInFlightRef = useRef(false);
  // "working…" clears only when the run is really over: opencode emits one
  // assistant message per STEP, so the first reply chunk is not the end.
  // The proxy reports the last raw message + its completed timestamp; the
  // run counts as finished only when that state is unchanged across two
  // polls (~2.5s apart) AND the completed timestamp is set (ends "|0" means
  // in-progress: user msg last or step still streaming — thinking models
  // can hold that state for minutes) AND the transcript grew since the send
  // (a stable pre-send state from the previous run must not clear it).
  const runStateRef = useRef('');
  const runStreakRef = useRef(0);
  const totalRef = useRef(0);
  const runBaseTotalRef = useRef(0);

  /** Reset run tracking at send time so the previous run's settled state
   *  can't instantly clear the new "working…" indicator. */
  function armRunWatch() {
    runStateRef.current = '';
    runStreakRef.current = 0;
    runBaseTotalRef.current = totalRef.current;
  }
  // wedge guard: fires at most once per send (see the busy ticker)
  const wedgeFiredRef = useRef(false);

  /** Show the user's own message instantly; the poll reconciles later. */
  function addEcho(text: string, images: string[] = []) {
    const m: Msg = { role: 'user', text: text || '(📎 attachment)', images, time: Date.now() };
    echoesRef.current = [...echoesRef.current, m];
    setMsgs((prev) => [...prev, m]);
    stickRef.current = true;
  }

  /** Discord-style growth: 1 line up to ~4, then internal scroll. */
  function autogrow(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  // auto-scroll only while the user is parked at (or near) the bottom;
  // scrolling up to read history must not be fought by the poller
  const stickRef = useRef(true);

  useEffect(() => {
    params.then((p) => {
      setSlug(p.slug);
      echoesRef.current = [];
      seenRef.current = 0;
      setLimit(60);
      // instant paint from the session cache while the fresh fetch runs
      try {
        const raw = sessionStorage.getItem('oz-cache:' + p.slug);
        if (raw) {
          const c = JSON.parse(raw);
          if (Array.isArray(c.msgs) && c.msgs.length) {
            setMsgs(c.msgs);
            setTotal(c.total || c.msgs.length);
            seenRef.current = c.msgs.length;
            requestAnimationFrame(() => {
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            });
          }
        }
      } catch {
        /* no cache */
      }
    });
  }, [params]);

  const loadMsgs = useCallback(
    async (lim?: number) => {
      // backgrounded mobile tabs freeze in-flight polls for minutes and then
      // fail in a burst on resume — never poll while hidden, never overlap
      if (!slug || pollInFlightRef.current || document.hidden) return;
      pollInFlightRef.current = true;
      try {
        const want = lim ?? limit;
        const r = await fetch(`/api/session/${slug}/messages?limit=${want}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        });
        if (r.ok) {
          const fresh: Msg[] = await r.json();
          const totalCount = Number(r.headers.get('X-Total-Count') || fresh.length);
          setTotal(totalCount);
          totalRef.current = totalCount;
          const st = r.headers.get('X-Run-State') || '';
          // "id|completed|lastRole" — completed=0 while a step runs or the
          // last raw message is the user's own prompt
          const [, done] = st.split('|');
          if (st && st === runStateRef.current) {
            runStreakRef.current += 1;
          } else {
            runStateRef.current = st;
            // fresh state that already shows a completed run = seen once
            runStreakRef.current = done === '0' ? 0 : 1;
          }
          // backgrounded + the run's final answer landed = notify (a bare
          // assistant message is not enough — steps land mid-run)
          const lastFresh = fresh[fresh.length - 1];
          if (
            document.hidden &&
            runStreakRef.current >= 1 &&
            lastFresh?.role === 'assistant' &&
            fresh.length > seenRef.current
          ) {
            void notifyReply(slug);
          }
          // keep optimistic echoes until the server transcript catches up
          const echoes = echoesRef.current.filter(
            (e) => !fresh.some((m) => m.role === 'user' && m.text === e.text)
          );
          setMsgs([...fresh, ...echoes]);
          try {
            if (JSON.stringify(fresh).length < 300_000) {
              sessionStorage.setItem(
                'oz-cache:' + slug,
                JSON.stringify({
                  msgs: fresh,
                  total: Number(r.headers.get('X-Total-Count') || fresh.length),
                })
              );
            }
          } catch {
            /* quota — skip cache */
          }
        }
      } catch {
        /* transient */
      } finally {
        pollInFlightRef.current = false;
      }
    },
    [slug, limit]
  );

  useEffect(() => {
    loadMsgs();
    const t = setInterval(loadMsgs, 2500);
    // catch up immediately when the page becomes visible again
    const onVisible = () => {
      if (!document.hidden) loadMsgs();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadMsgs]);

  useEffect(() => {
    seenRef.current = Math.max(seenRef.current, msgs.length);
    if (!stickRef.current) return;
    // hard snap (scrollIntoView races late layout from images/fonts)
    const snap = () => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    snap();
    requestAnimationFrame(snap);
    const t = setTimeout(snap, 300);
    return () => clearTimeout(t);
  }, [msgs]);

  useEffect(() => {
    if (!busy) return;
    setBusySecs(0);
    wedgeFiredRef.current = false;
    let sec = 0;
    const t = setInterval(() => {
      sec += 1;
      setBusySecs(sec);
      // done = two consecutive polls saw the same run state, that state is a
      // COMPLETED assistant message (mid part "0" = in-progress — thinking
      // models can hold it for minutes), and the transcript grew past what
      // existed at send time (a stable pre-send state must not clear it)
      if (
        runStreakRef.current >= 2 &&
        runStateRef.current.split('|')[1] !== '0' &&
        totalRef.current > runBaseTotalRef.current
      ) {
        setBusy(false);
        runStreakRef.current = 0;
        clearAsked(slug);
        if (document.hidden) void notifyReply(slug);
        return;
      }
      // wedge guard: 30s busy and the LAST raw message is still the user's
      // own prompt (state ends "|0|user") → the runner never picked the
      // message up (hung earlier run, queue dead). Abort so the session
      // un-wedges; the prompt stays in the transcript, user can resend.
      if (!wedgeFiredRef.current && sec >= 30 && runStateRef.current.endsWith('|0|user')) {
        wedgeFiredRef.current = true;
        setError('no reply — the run seemed stuck, auto-stopped. Send again.');
        void fetch(`/api/session/${slug}/abort`, { method: 'POST' }).catch(() => {});
      }
    }, 1000);
    return () => clearInterval(t);
  }, [busy, slug]);

  // disconnect voice when leaving the page
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, []);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  async function ensureVoice(): Promise<Room> {
    if (roomRef.current && voiceState === 'ready') return roomRef.current;
    if (voicePromiseRef.current) return voicePromiseRef.current;
    setVoiceState('connecting');
    voicePromiseRef.current = connectVoice();
    return voicePromiseRef.current;
  }

  async function connectVoice(): Promise<Room> {
    try {
      try {
        const p = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        diagEvent('voice', `mic permission: ${p.state}`);
        if (p.state === 'denied') {
          throw new Error('microphone blocked — allow it in browser site settings (lock icon)');
        }
      } catch (e) {
        if (String(e).includes('blocked')) throw e;
        diagEvent('voice', 'permissions API unavailable');
      }
      const r = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: slug }),
      });
      const d = await r.json();
      const room = new Room({ adaptiveStream: false });
      room.on(RoomEvent.SignalConnected, () => diagEvent('voice', 'signal connected'));
      room.on(RoomEvent.Connected, () => diagEvent('voice', 'room connected'));
      room.on(RoomEvent.Disconnected, () => {
        diagEvent('voice', 'room disconnected');
        // the room's join token is stale now — reconnecting with it just 401s
        // ("token is expired"). Drop it so the next connect mints a fresh one.
        roomRef.current = null;
        voicePromiseRef.current = null;
        setVoiceState('off');
        // in voice modes, self-heal once with a fresh token (e.g. the phone
        // slept past the token TTL and the server dropped the room)
        if (!unmountedRef.current && modeRef.current !== 'text') {
          void ensureVoice().catch(() => {});
        }
      });
      room.on(RoomEvent.MediaDevicesError, (e: Error) => diagEvent('voice-fail', String(e)));
      diagEvent('voice', 'connecting signal…');
      await withTimeout(room.connect(d.serverUrl, d.participantToken), 12_000, 'signal');
      diagEvent('voice', 'connected, enabling mic…');
      await withTimeout(room.localParticipant.setMicrophoneEnabled(true), 10_000, 'mic');
      roomRef.current = room;
      setVoiceState('ready');
      diagEvent('voice', 'ready');
      return room;
    } catch (e) {
      setError(`voice connect failed: ${e instanceof Error ? e.message : e}`);
      setVoiceState('off');
      voicePromiseRef.current = null;
      throw e;
    }
  }

  async function mic(on: boolean) {
    await roomRef.current?.localParticipant.setMicrophoneEnabled(on);
  }

  async function switchMode(next: Mode) {
    if (next === mode) return;
    setError('');
    setMode(next); // optimistic — bottom UX must react immediately
    try {
      if (next === 'text') {
        // mute is not enough: the room keeps the capture device open, so the
        // phone still shows "mic in use". Release it for real — ensureVoice()
        // reconnects lazily (fresh token) when a voice mode is picked again.
        const room = roomRef.current;
        roomRef.current = null;
        voicePromiseRef.current = null;
        setVoiceState('off');
        diagEvent('voice', 'released (keyboard mode)');
        await room?.disconnect();
      } else if (next === 'ptt') {
        await ensureVoice();
        await mic(false); // muted until held
      } else {
        // hands-free: mic stays on, VAD drives turns (agent auto-commits)
        await ensureVoice();
        await mic(true);
      }
    } catch {
      setMode('text'); // connect/mic failed (error surfaced by ensureVoice)
    }
  }

  async function pttDown() {
    if (busy || !roomRef.current) return;
    await mic(true);
    setHolding(true);
  }

  async function pttUp() {
    setHolding(false);
    const room = roomRef.current;
    if (!room) return;
    await mic(false);
    stickRef.current = true;
    setBusy(true); // cleared when the run state settles (see poller)
    armRunWatch();
    try {
      const agent = Array.from(room.remoteParticipants.values())[0];
      if (agent) {
        await room.localParticipant.performRpc({
          destinationIdentity: agent.identity,
          method: 'commit_turn',
          payload: '{}',
          responseTimeout: 10_000,
        });
      }
    } catch (e) {
      setError(`commit failed: ${e}`);
    }
  }

  async function loadOlder() {
    if (loadingOlder || !slug || total <= msgs.length) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight || 0;
    const next = limit + 120;
    setLimit(next);
    await loadMsgs(next);
    // keep the viewport anchored to the same content after prepending
    requestAnimationFrame(() => {
      const s = scrollRef.current;
      if (s) s.scrollTop = s.scrollHeight - prevHeight;
    });
    setLoadingOlder(false);
  }

  async function abortGeneration() {
    try {
      await fetch(`/api/session/${slug}/abort`, { method: 'POST' });
    } catch {
      /* best effort */
    } finally {
      setBusy(false);
      runStreakRef.current = 0;
      await loadMsgs();
    }
  }

  async function addAttachments(files: FileList | null) {
    if (!files?.length) return;
    const picked = Array.from(files).slice(0, 4);
    const next: Attach[] = [];
    for (const f of picked) {
      try {
        if (f.type.startsWith('image/')) {
          next.push({ kind: 'image', name: f.name, dataUrl: await downscaleImage(f) });
        } else {
          next.push({ kind: 'file', name: f.name, content: (await f.text()).slice(0, 200_000) });
        }
      } catch (e) {
        setError(`could not read ${f.name}: ${e}`);
      }
    }
    if (next.length) setAttachments((a) => [...a, ...next].slice(0, 8));
  }

  function sendText() {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    const images = attachments
      .filter((a): a is Extract<Attach, { kind: 'image' }> => a.kind === 'image')
      .map((a) => a.dataUrl);
    const files = attachments
      .filter((a): a is Extract<Attach, { kind: 'file' }> => a.kind === 'file')
      .map((a) => ({ name: a.name, content: a.content }));
    setAttachments([]);
    stickRef.current = true;
    void sendTextAsync(text, images, files);
  }

  async function sendTextAsync(
    text: string,
    images: string[],
    files: { name: string; content: string }[]
  ) {
    markAsked(slug);
    void ensureNotifyPermission();
    // sending while busy = queue behind the current run (opencode serializes
    // per session) — stopping is a separate, explicit action
    if (!images.length && !files.length && roomRef.current && voiceState === 'ready') {
      // voice context: through the room so the agent speaks the reply
      // (attachments must take the REST path — the room only carries text)
      setBusy(true);
      armRunWatch();
      addEcho(text);
      try {
        await roomRef.current.localParticipant.sendText(text, { topic: 'lk.chat' });
      } catch (e) {
        setError(`send failed: ${e}`);
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    armRunWatch();
    try {
      const r = await fetch(`/api/session/${slug}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, images, files, async: true }),
        // a hung radio/socket must surface as an error, not a silent stuck send
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.error || `send failed (${r.status})`);
        setInput((prev) => (prev.trim() ? prev : text)); // draft back, no clobber
        setBusy(false);
      } else {
        addEcho(text, images);
      }
      await loadMsgs();
    } catch {
      setError('send failed');
      setInput((prev) => (prev.trim() ? prev : text)); // draft back, no clobber
      setBusy(false);
    }
  }

  const segBtn = (m: Mode, icon: 'keyboard' | 'mic' | 'infinity', label: string) => (
    <button
      aria-label={label}
      onClick={() => switchMode(m)}
      className={`flex-1 rounded px-2 py-1.5 text-xs ${
        mode === m ? 'bg-[var(--oz-surface-hover)] text-[var(--oz-active)]' : 'text-[var(--oz-dim)]'
      }`}
    >
      <span className="mx-auto block w-fit">
        <PixelIcon name={icon} size={16} />
      </span>
    </button>
  );

  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col overflow-hidden px-3">
      {/* header */}
      <header className="flex items-center justify-between gap-2 py-3">
        <div className="min-w-0 flex-1 truncate text-sm">
          {slug}
          {busy && <span className="oz-busy ml-2 text-[var(--oz-active)]">●</span>}
        </div>
        <div className="flex items-center gap-1 rounded border border-[var(--oz-border)] p-0.5">
          {segBtn('text', 'keyboard', 'text mode')}
          {segBtn('ptt', 'mic', 'push-to-talk')}
          {segBtn('free', 'infinity', 'hands-free')}
        </div>
      </header>

      {error && (
        <div className="mb-2 rounded border border-[var(--oz-danger)]/60 px-3 py-2 text-xs text-[var(--oz-danger)]">
          {error}{' '}
          <button onClick={() => setError('')} className="underline">
            dismiss
          </button>
        </div>
      )}

      {/* transcript */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          if (el.scrollTop <= 2) void loadOlder();
        }}
        className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto overscroll-contain pb-2"
      >
        {loadingOlder && (
          <div className="pt-1 text-center text-[10px] text-[var(--oz-dim)]">loading older…</div>
        )}
        {msgs.length === 0 && (
          <div className="pt-10 text-center text-xs text-[var(--oz-dim)]">
            empty session — type, hold the mic, or go hands-free
          </div>
        )}
        {collapseToolSteps(msgs).map((m, i) => (
          <SessionMessage key={i} m={m} />
        ))}
        {busy && (
          <div className="flex items-center gap-3 text-xs text-[var(--oz-active)]">
            <span className="oz-busy">● working… {busySecs}s</span>
            <button
              onClick={abortGeneration}
              className="flex items-center gap-1 rounded border border-[var(--oz-danger)]/70 px-2.5 py-1 text-[var(--oz-danger)]"
            >
              <PixelIcon name="stop" size={12} /> stop
            </button>
          </div>
        )}
      </div>

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1 pb-1">
          {attachments.map((a, i) => (
            <span
              key={i}
              className="flex items-center gap-1 rounded border border-[var(--oz-border)] px-2 py-1 text-xs"
            >
              {a.kind === 'image' && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.dataUrl} alt="" className="h-6 w-6 rounded object-cover" />
              )}
              <span className="max-w-28 truncate text-[var(--oz-dim)]">{a.name}</span>
              <button
                aria-label={`remove ${a.name}`}
                onClick={() => setAttachments((arr) => arr.filter((_, j) => j !== i))}
                className="text-[var(--oz-dim)]"
              >
                <PixelIcon name="close" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* text input — always available */}
      <div className="flex items-end gap-2 border-t border-[var(--oz-border)] py-3">
        {/* single paper-clip button — opens the phone's photo/camera picker
            (accept=image/*); files ride along when picked from there */}
        <button
          aria-label="attach"
          onClick={() => photoInputRef.current?.click()}
          className="rounded border border-[var(--oz-border)] px-2.5 py-2 text-[var(--oz-dim)]"
        >
          <PixelIcon name="attachment" size={16} />
        </button>
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addAttachments(e.target.files);
            e.currentTarget.value = '';
          }}
        />
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          onChange={(e) => {
            setInput(e.target.value);
            autogrow(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendText();
            }
          }}
          placeholder="message…"
          className="min-w-0 flex-1 resize-none rounded border border-[var(--oz-border)] bg-[var(--oz-surface)] px-3 py-2 text-sm leading-snug outline-none placeholder:text-[var(--oz-dim)]"
          style={{ maxHeight: 96 }}
        />
        <button
          onClick={sendText}
          aria-label="send"
          disabled={!input.trim() && attachments.length === 0}
          className="rounded border border-[var(--oz-success)]/60 px-3 py-2 text-sm text-[var(--oz-success)] disabled:opacity-40"
        >
          <PixelIcon name="send" size={16} />
        </button>
      </div>

      {mode === 'ptt' && (
        <div className="border-t border-[var(--oz-border)] py-4">
          <button
            onPointerDown={(e) => {
              e.preventDefault();
              pttDown();
            }}
            onPointerUp={pttUp}
            onPointerLeave={() => holding && pttUp()}
            onContextMenu={(e) => e.preventDefault()}
            className={`w-full rounded border py-5 text-sm tracking-widest uppercase select-none ${
              holding
                ? 'oz-ptt-hold border-[var(--oz-success)]'
                : 'border-[var(--oz-border)] text-[var(--oz-dim)]'
            }`}
            style={{ touchAction: 'none' }}
          >
            {voiceState === 'connecting' ? 'connecting…' : holding ? '● listening' : 'hold to talk'}
          </button>
        </div>
      )}

      {mode === 'free' && (
        <div className="border-t border-[var(--oz-border)] py-4 text-center text-xs text-[var(--oz-success)]">
          {voiceState === 'connecting'
            ? 'connecting…'
            : '● hands-free — just talk, pauses end your turn'}
        </div>
      )}
    </main>
  );
}
