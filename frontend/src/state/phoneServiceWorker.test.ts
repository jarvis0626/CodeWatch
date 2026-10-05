import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => undefined);
  const matchAll = vi.fn(async (): Promise<unknown[]> => []);
  const self = { addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler), skipWaiting: async () => undefined, registration: { showNotification }, location: { origin: 'https://private.trycloudflare.com' }, clients: { claim: async () => undefined, matchAll, openWindow } };
  runInNewContext(readFileSync(new URL('../../public/phone-sw.js', import.meta.url), 'utf8'), { self, URL });
  return { handlers, showNotification, openWindow, matchAll };
}

describe('private phone service worker', () => {
  it('displays a background completion alert without using a supplied navigation URL', async () => {
    const app = worker();
    let pending: Promise<void> | undefined;
    app.handlers.get('push')!({ data: { json: () => ({ eventId: 'done-1', runId: 'watch_1', title: 'Work reported complete', body: 'Example project', url: 'https://attacker.example/collect', token: 'secret' }) }, waitUntil: (promise: Promise<void>) => { pending = promise; } });
    await pending;
    expect(app.showNotification).toHaveBeenCalledOnce();
    expect(app.showNotification.mock.calls[0]).toEqual(['Work reported complete', { body: 'Example project', icon: '/phone-icon-192.png', badge: '/phone-icon-192.png', tag: 'codewatch-watch_1', data: { runId: 'watch_1', eventId: 'done-1' } }]);
    expect(app.handlers.has('fetch')).toBe(false);
  });
  it('ignores malformed pushes', () => {
    const app = worker();
    app.handlers.get('push')!({ data: { json: () => { throw new Error('bad payload'); } } });
    app.handlers.get('push')!({ data: { json: () => ({ title: 'missing identity' }) } });
    expect(app.showNotification).not.toHaveBeenCalled();
  });
  it('opens only the fixed phone route when a notification is clicked', async () => {
    const app = worker();
    let pending: Promise<void> | undefined;
    const close = vi.fn();
    app.handlers.get('notificationclick')!({ notification: { close, data: { url: 'https://attacker.example/' } }, waitUntil: (promise: Promise<void>) => { pending = promise; } });
    await pending;
    expect(close).toHaveBeenCalledOnce();
    expect(app.openWindow).toHaveBeenCalledWith('https://private.trycloudflare.com/phone');
  });
  it('focuses an existing same-origin phone instead of opening another window', async () => {
    const app = worker();
    const focus = vi.fn(async () => undefined);
    app.matchAll.mockResolvedValue([{ url: 'https://attacker.example/phone', focus: vi.fn() }, { url: 'https://private.trycloudflare.com/phone', focus }]);
    let pending: Promise<void> | undefined;
    app.handlers.get('notificationclick')!({ notification: { close: vi.fn() }, waitUntil: (promise: Promise<void>) => { pending = promise; } });
    await pending;
    expect(focus).toHaveBeenCalledOnce();
    expect(app.openWindow).not.toHaveBeenCalled();
  });
});
