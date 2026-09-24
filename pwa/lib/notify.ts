/** Reply-ready notifications: asks permission once (first send), then shows
 *  a notification via the service worker when a reply lands while the app
 *  is backgrounded — or for any session the user asked a question in. */

const ASKED_KEY = 'oz-asked';

function readAsked(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(ASKED_KEY) || '{}');
  } catch {
    return {};
  }
}

export function markAsked(slug: string): void {
  try {
    const d = readAsked();
    d[slug] = Date.now();
    localStorage.setItem(ASKED_KEY, JSON.stringify(d));
  } catch {
    /* private mode */
  }
}

export function clearAsked(slug: string): void {
  try {
    const d = readAsked();
    delete d[slug];
    localStorage.setItem(ASKED_KEY, JSON.stringify(d));
  } catch {
    /* ignore */
  }
}

export function askedSessions(): string[] {
  return Object.keys(readAsked());
}

/** Prompt once — call from a user gesture (first send). */
export async function ensureNotifyPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission !== 'default') return Notification.permission === 'granted';
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/** Fire-and-forget reply notification (no-ops without granted permission). */
export async function notifyReply(slug: string): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  const options: NotificationOptions & { data: { slug: string } } = {
    body: `reply ready — ${slug}`,
    tag: `oz-${slug}`,
    icon: '/lk-logo-dark.svg',
    data: { slug },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification('opencode', options);
    else new Notification('opencode', options);
  } catch {
    /* notifications unavailable */
  }
}
