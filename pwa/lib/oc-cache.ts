/** Tiny 60s cache for the enriched session list (server-side). */
let cache: { at: number; data: unknown } | null = null;
const CACHE_MS = 60_000;

export function getCache() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  return null;
}

export function setCache(data: unknown) {
  cache = { at: Date.now(), data };
}

export function bustCache() {
  cache = null;
}
