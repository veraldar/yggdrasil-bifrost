# Journal — bifrost

Append-only log. One line per decision or incident; newest first. Open decisions belong in `open-questions.md` until resolved, then land here. Duplicates nothing: this is the *when & why*, `plan.md` is the *what's next*, `spec.md` is the *what it is*.

## 2026-09-24

- **GitHub**: repo `veraldar/yggdrasil-bifrost` (public). Fine-grained PAT gotcha: private org repos need explicit per-repo selection — public-only access 404s them.
- **Session-scope incident**: pointing `opencode-serve` at `~/Work/bifrost` orphaned all sessions (opencode scopes sessions per project) and the proxy **cached the empty list**. Fix: scope stays `~/Work` (agent context comes from root `AGENTS.md` + repo files), cache never pins empty results. Lesson: the base must degrade to retry, never lock in a wrong state.
- **Diag upgraded**: net-fail entries now include the response error body — a 500 is pinpointable from the log alone.
- **UX fixes**: single attach button (one picker, routing by type); keyboard mode fully disconnects the room (Android mic indicator was "hanging" on mute-only); chat shell clipped (`overflow-hidden` + `overscroll-contain`) so only the transcript scrolls; busy state clears on run-settle (`X-Run-State`), not per-step.

## 2026-09-23

- **Standing policy**: user grants autonomy — proceed without sign-off when confident; contact only if stuck, looping, or needing human input (tests, logins, passwords). Evidence-based verification still mandatory.

## Earlier (from open-questions ledger, resolved)

- **Speech stack on Mac (M3 Ultra)**: MLX wrapper `com.opencode.mlxvoice` on the Mac's LAN address, port 8001 (see `docs/local.md`) — Qwen3-ASR (~1.3s) + Qwen3-TTS (~1.2s). Fallback: speaches on omarchy `:8000` (CPU). No cloud APIs, no keys.
- **PWA serving**: Next.js node server on :8080 (token minting needs server runtime); Caddy dropped. Tailnet-only exposure is the security boundary.
- **STT/TTS local-only**: speaches (OpenAI-compatible) was the first answer; superseded by the Mac MLX wrapper above.
