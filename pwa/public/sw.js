/* Minimal service worker: notification clicks focus/open the session. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const slug = (e.notification.data || {}).slug;
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (slug && c.url.includes(`/session/${slug}`)) return c.focus();
      }
      for (const c of all) {
        if ('focus' in c) {
          if (slug) c.navigate(`/session/${slug}`).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(slug ? `/session/${slug}` : '/');
    })()
  );
});
