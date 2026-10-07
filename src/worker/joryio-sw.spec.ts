import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

/**
 * The push service worker, scan 2 (web): #6 badge / tag / requireInteraction
 * dropped, #14 the click report fired outside waitUntil().
 */

const source = fs.readFileSync(path.join(__dirname, 'joryio-sw.js'), 'utf8');

function loadWorker(opts: { fetch?: jest.Mock; clients?: any } = {}) {
  const handlers: Record<string, (event: any) => void> = {};
  const showNotification = jest.fn(async () => undefined);
  const fetchMock = opts.fetch || jest.fn(async () => ({ ok: true }));
  const self: any = {
    addEventListener: (type: string, fn: (event: any) => void) => {
      handlers[type] = fn;
    },
    registration: { showNotification },
    clients: opts.clients || {
      matchAll: jest.fn(async () => []),
      openWindow: jest.fn(async () => undefined),
    },
  };
  vm.runInNewContext(source, { self, fetch: fetchMock, URL, Promise, console, encodeURIComponent });
  return { handlers, showNotification, fetchMock, self };
}

function pushEvent(payload: any) {
  const waits: Promise<unknown>[] = [];
  return {
    event: { data: { json: () => payload, text: () => JSON.stringify(payload) }, waitUntil: (p: Promise<unknown>) => waits.push(p) },
    waits,
  };
}

describe('push: the notification as the composer set it up (scan 2 #6)', () => {
  it('passes badge, tag (with renotify) and requireInteraction to showNotification', async () => {
    const { handlers, showNotification } = loadWorker();
    const { event, waits } = pushEvent({
      title: 'Sale',
      body: 'Today only',
      icon: 'https://cdn.example/i.png',
      badge: 'https://cdn.example/b.png',
      tag: 'promo',
      requireInteraction: true,
      data: { trackingId: 't-1', jry_api_origin: 'https://api.example/api' },
    });
    handlers.push(event);
    await Promise.all(waits);

    expect(showNotification).toHaveBeenCalledWith(
      'Sale',
      expect.objectContaining({
        body: 'Today only',
        badge: 'https://cdn.example/b.png',
        tag: 'promo',
        renotify: true,
        requireInteraction: true,
      }),
    );
  });

  it('leaves them out when the push does not set them', async () => {
    const { handlers, showNotification } = loadWorker();
    const { event, waits } = pushEvent({ title: 'Hi', body: 'There', data: {} });
    handlers.push(event);
    await Promise.all(waits);
    const options = (showNotification.mock.calls[0] as any[])[1];
    expect(options).not.toHaveProperty('badge');
    expect(options).not.toHaveProperty('tag');
    expect(options).not.toHaveProperty('requireInteraction');
  });
});

describe('notificationclick: the click report is part of waitUntil (scan 2 #14)', () => {
  it('waitUntil does not settle before the click request has been made and answered', async () => {
    let answer!: () => void;
    const fetchMock = jest.fn(
      (url: string) =>
        new Promise((resolve) => {
          if (String(url).includes('/track/push/click/')) answer = () => resolve({ ok: true });
          else resolve({ ok: true });
        }),
    );
    const { handlers } = loadWorker({ fetch: fetchMock });
    const waits: Promise<unknown>[] = [];
    const event = {
      notification: {
        close: jest.fn(),
        data: { trackingId: 't-9', jry_api_origin: 'https://api.example/api', jry_deep_link: 'https://shop.example/p' },
      },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    };
    handlers.notificationclick(event);
    expect(waits).toHaveLength(1);

    let settled = false;
    waits[0].then(() => (settled = true));
    for (let i = 0; i < 10 && !answer; i++) await new Promise((r) => setImmediate(r));

    // The click went to the ROOT-mounted route on the API origin.
    expect(fetchMock).toHaveBeenCalledWith('https://api.example/track/push/click/t-9', expect.anything());
    expect(settled).toBe(false); // the worker is kept alive for it
    answer();
    await waits[0];
    expect(settled).toBe(true);
  });
});
