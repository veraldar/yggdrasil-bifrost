/** Tracks in-flight async prompts per session: POST /message resolves only
 *  when the whole run finishes, so a set entry = opencode is actively
 *  working on that session right now. Definitive — the client's stable-state
 *  heuristic can't tell "thinking between steps" from "done". */
const live = new Set<string>();

export const markRunStart = (sid: string) => live.add(sid);
export const markRunEnd = (sid: string) => live.delete(sid);
export const isRunLive = (sid: string) => live.has(sid);

/** How long a prompt-with-no-answer still counts as "awaiting answer".
 *  Aborted/failed prompts stay user-last forever — without this window they
 *  would pin their session as thinking until the end of time. Live runs are
 *  exempt (tracked above). */
export const PENDING_TTL_MS = 10 * 60_000;
