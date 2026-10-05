/* No cache or fetch handler: private phone snapshots stay on the server. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { return; }
  if (!payload || typeof payload !== 'object' || typeof payload.eventId !== 'string' || typeof payload.runId !== 'string') return;
  const title = typeof payload.title === 'string' ? payload.title.slice(0, 120) : 'CodeWatch';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 300) : 'The agent reported work complete.';
  event.waitUntil(self.registration.showNotification(title, {
    body, icon: '/phone-icon-192.png', badge: '/phone-icon-192.png',
    tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 200) : `codewatch-${payload.runId}`,
    data: { runId: payload.runId, eventId: payload.eventId },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  // Push content cannot choose a URL or open another origin.
  const phoneUrl = new URL('/phone', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    const existing = windows.find(client => { try { const url = new URL(client.url); return url.origin === self.location.origin && url.pathname === '/phone'; } catch { return false; } });
    if (existing) return existing.focus();
    return self.clients.openWindow(phoneUrl);
  }));
});
