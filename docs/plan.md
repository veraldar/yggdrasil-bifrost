# Plan — bifrost

Single source of truth for status and next work. Decisions & incidents: `journal.md`.
Checklist = board. A phase done = all boxes checked.

## Invariants (must always hold — regression here is a bug)

- [x] List sessions, select one, create, delete
- [x] Text message → agent reply lands in transcript
- [x] Busy state clears only when the run settles (not per-step)
- [x] Voice: PTT + hands-free; keyboard mode releases the mic (OS-level)
- [x] Voice self-heals stale tokens; polls bounded, silent on failure
- [x] Attachments: one picker — images downscale, files become text parts
- [x] Chat page scrolls only in transcript; session list never caches empty
- [x] Phone talks only to the Next proxy; opencode stays tailnet/localhost-only

## Done (base)

- [x] LiveKit + speaches compose; ICE pinned to tailnet/LAN
- [x] Python agent: room slug ⇄ opencode session, STT→opencode→TTS (Mac MLX, speaches fallback)
- [x] PWA: sessions UI, transcript w/ markdown, attachments + sandboxed HTML, voice modes, notifications
- [x] Diagnostics: console/net/tap/voice events → `pwa/.diag/`; net-fail captures error bodies
- [x] systemd units: `lk-pwa`, `lk-agent`, `opencode-serve` (reboots self-heal)
- [x] Repo: `veraldar/yggdrasil-bifrost`, context via root `AGENTS.md`

## Current — harden to v1.0

- [ ] Phone e2e pass: voice round-trip, busy→notify, mic release, scroll feel
- [ ] Vercel deploy validated in isolated container (clean `npm ci && build`, env matrix)
- [ ] Release v0.1.0 (tag + GitHub release) only after the two boxes above

## Deferred

- [ ] LiveKit on €3 OVH VPS (only `LIVEKIT_URL` + DNS/TLS change)
- [ ] Multi-user / public mode, SIP, video
