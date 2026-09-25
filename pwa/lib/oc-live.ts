/** Tracks in-flight async prompts per session: POST /message resolves only
 *  when the whole run finishes, so a set entry = opencode is actively
 *  working on that session right now. Definitive — the client's stable-state
 *  heuristic can't tell "thinking between steps" from "done". */
const live = new Set<string>();

export const markRunStart = (sid: string) => live.add(sid);
export const markRunEnd = (sid: string) => live.delete(sid);
export const isRunLive = (sid: string) => live.has(sid);
