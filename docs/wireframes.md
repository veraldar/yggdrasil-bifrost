# Wireframes — opencode Voice PWA (viz dark-terminal styling)

Stack: existing Next.js fork + @livekit/components-react voice view, reskinned with viz tokens
(`#080810` bg, `#000` surface, white Consolas mono, `#4ade80` success / `#fbbf24` active / `#f87171` danger).

## Core model

Sessions are **modeless**. One session = one opencode conversation. Input switches freely between
PTT voice (WebRTC, connects lazily on first hold) and typed text (REST, always available).
Transcript shows both interleaved.

## Storyboard (user flow)

```
┌──────────┐  tap +   ┌──────────┐  create   ┌─────────────────────┐
│ SESSIONS │─────────►│  NEW     │──────────►│ SESSION             │
│  (home)  │  tap row │ (name)   │           │ [🎙 voice] [⌨ text] │
└──────────┘─────────►└──────────┘           └─────────────────────┘
     ▲  ⌫ back from any session, switch = tap another row
```

## 1. Sessions (home)

```
┌─────────────────────────────┐
│ opencode            ● mac   │  ← header: title + voice-stack status dot
│─────────────────────────────│
│ + new session               │  ← always first row, green
│─────────────────────────────│
│ refactor auth               │  ← name only (no mode — sessions are modeless)
│ 2m ago · "let's add tests"  │  ← last message preview (dim)
│─────────────────────────────│
│ db migration ideas          │
│ 1h ago · "use alembic…"     │
│─────────────────────────────│
│ weekly report               │
│ yesterday                   │
│─────────────────────────────│
│ …list from GET /session…    │
└─────────────────────────────┘
```

## 2. New session

```
┌─────────────────────────────┐
│ new session            [x]  │
│─────────────────────────────│
│ name: [_____________]       │
│                             │
│      [ CREATE & OPEN ]      │  ← green
└─────────────────────────────┘
```

## 3. Session view — voice input (PTT active)

```
┌─────────────────────────────┐
│ ⌫ refactor auth     [🎙|⌨]  │  ← back | input-mode toggle
│─────────────────────────────│
│ (you) refactor the auth     │  ← transcript, mono, auto-scroll
│ module                      │
│ (asst) Here's the plan:     │
│ ┌ md ────────────────────┐  │  ← markdown rendered (code blocks,
│ │ ```python              │  │    lists, tables) in terminal theme
│ │ def fix(): …           │  │
│ └────────────────────────┘  │
│ [img] screenshot.png        │  ← image attachments: thumb, tap=full
│ [html] report.html ⇄ raw    │  ← html: rendered/raw toggle
│ ██████████░░░               │  ← waveform while listening/speaking
│                             │
│─────────────────────────────│
│ [📎] ┌────────────────┐ [▶] │  ← attach: file picker / drag-drop
│      │ message…       │     │     chips above input before send
│      └────────────────┘     │
│─────────────────────────────│
│ ┌─────────────────────────┐ │
│ │      HOLD TO TALK       │ │  ← PTT: hold = mic on (lazy WebRTC)
│ └─────────────────────────┘ │  ← green while held, dim idle
└─────────────────────────────┘
```

## 4. Session view — text input (same session, toggled)

```
┌─────────────────────────────┐
│ ⌫ refactor auth     [🎙|⌨]  │  ← ⌨ highlighted when text mode
│─────────────────────────────│
│ (you) refactor the auth     │
│ module                      │
│ (assistant) Working on it…  │
│                             │
│─────────────────────────────│
│ [📎] [ message…     ] [▶]   │  ← Enter = send (REST)
└─────────────────────────────┘
```

## Interaction notes

- **Modeless sessions**: 🎙/⌨ toggle only changes INPUT method, never the conversation.
- **Voice**: mic track enabled ONLY while PTT held; WebRTC connects on first hold, disconnects on ⌫.
- **Text**: REST POST to the session — works regardless of connection state.
- **Switching**: back → list is instant; voice disconnects on ⌫.
- **Session row**: long-press → rename/delete (delete = opencode session delete + confirm).
- **Agent busy indicator**: `#fbbf24` pulsing dot in header while opencode is generating.
- **Errors**: inline red banner in transcript ("talking to opencode failed — tap to retry").
- **Attachments**: 📎 file picker + drag-drop overlay ("drop image / .md / .html").
  Images → image parts; .md/.html → text parts (wrapped as fenced content) to the session.
- **Rich rendering**: assistant replies render markdown (code blocks, lists, tables);
  html replies get rendered/raw toggle; images show as tappable thumbnails.

