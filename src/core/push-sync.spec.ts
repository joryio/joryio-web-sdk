import { PushManager } from './push';

/**
 * Review finding 13: a subscription the browser rotated, or one bound to a
 * VAPID key the server has since replaced, was never re-registered - nothing
 * ran without a user gesture, so the visitor silently stopped getting push.
 * Plus contract item 8: the public permission names.
 */

const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;

function memoryStorage() {
  const m = new Map<string, any>();
  return {
    get: (k: string) => (m.has(k) ? m.get(k) : null),
    set: (k: string, v: any) => m.set(k, JSON.parse(JSON.stringify(v))),
    remove: (k: string) => m.delete(k),
  } as any;
}

const KEY_A = 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function b64ToBuf(b64: string): ArrayBuffer {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}

function makeSub(endpoint: string, key: string) {
  return {
    endpoint,
    options: { applicationServerKey: b64ToBuf(key) },
    toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: jest.fn(async () => true),
  };
}

let navDescriptor: PropertyDescriptor | undefined;

function setBrowser(permission: string, current: any) {
  const pushManager = {
    getSubscription: jest.fn(async () => current.sub),
    subscribe: jest.fn(async () => {
      current.sub = makeSub('https://push.example/new', current.serverKey);
      return current.sub;
    }),
  };
  (globalThis as any).window = { PushManager: {}, Notification: {} };
  (globalThis as any).Notification = { permission };
  navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: { getRegistration: jest.fn(async () => ({ pushManager })) } },
    configurable: true,
  });
  return pushManager;
}

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).Notification;
  if (navDescriptor) Object.defineProperty(globalThis, 'navigator', navDescriptor);
});

function make(serverKey: string, identity = { userId: null as string | null, anon: 'anon-1' }, canSend = () => true) {
  const requests: any[] = [];
  const network = {
    request: jest.fn(async (req: any) => {
      requests.push(req);
      if (req.url.endsWith('/v1/push/vapid-public-key')) {
        return { ok: true, status: 200, data: { enabled: true, publicKey: serverKey } };
      }
      return { ok: true, status: 200, data: {} };
    }),
  } as any;
  const id = { getUserId: () => identity.userId, getAnonymousId: () => identity.anon } as any;
  const storage = memoryStorage();
  const push = new PushManager(logger, network, id, 'https://api.example/api', { canSend, storage });
  return { push, requests, registers: () => requests.filter((r) => r.url.endsWith('/v1/push/register')) };
}

describe('PushManager.syncExistingSubscription', () => {
  it('re-registers an existing subscription on load, then only when something changed', async () => {
    const current = { sub: makeSub('https://push.example/1', KEY_A), serverKey: KEY_A };
    setBrowser('granted', current);
    const identity = { userId: null as string | null, anon: 'anon-1' };
    const { push, registers } = make(KEY_A, identity);

    await push.syncExistingSubscription();
    expect(registers()).toHaveLength(1);
    expect(registers()[0].body.subscription.endpoint).toBe('https://push.example/1');

    await push.syncExistingSubscription();
    expect(registers()).toHaveLength(1); // unchanged -> no request

    current.sub = makeSub('https://push.example/rotated', KEY_A); // browser rotated it
    await push.syncExistingSubscription();
    expect(registers()).toHaveLength(2);
    expect(registers()[1].body.subscription.endpoint).toBe('https://push.example/rotated');

    identity.anon = 'anon-2'; // reset() moved the visitor
    await push.syncExistingSubscription(true);
    expect(registers()).toHaveLength(3);
    expect(registers()[2].body.anonymousId).toBe('anon-2');
  });

  it('re-subscribes with the current VAPID key when the server key changed (no prompt needed)', async () => {
    const current = { sub: makeSub('https://push.example/old', KEY_A), serverKey: KEY_B };
    const pm = setBrowser('granted', current);
    const { push, registers } = make(KEY_B);
    const old = current.sub;

    await push.syncExistingSubscription();

    expect(old.unsubscribe).toHaveBeenCalled();
    expect(pm.subscribe).toHaveBeenCalled();
    expect(registers()[0].body.subscription.endpoint).toBe('https://push.example/new');
  });

  it('does nothing without granted permission, or while sending is not allowed', async () => {
    const current = { sub: makeSub('https://push.example/1', KEY_A), serverKey: KEY_A };
    setBrowser('default', current);
    const a = make(KEY_A);
    await a.push.syncExistingSubscription(true);
    expect(a.requests).toEqual([]);

    setBrowser('granted', current);
    const b = make(KEY_A, undefined, () => false);
    await b.push.syncExistingSubscription(true);
    expect(b.requests).toEqual([]);
  });
});

describe('permission state names are the cross-SDK ones', () => {
  it('maps the browser vocabulary to granted / denied / notDetermined / unavailable', () => {
    const current = { sub: null, serverKey: KEY_A };
    setBrowser('default', current);
    expect(make(KEY_A).push.getPermissionState()).toBe('notDetermined');
    (globalThis as any).Notification.permission = 'denied';
    expect(make(KEY_A).push.getPermissionState()).toBe('denied');
    delete (globalThis as any).window;
    expect(make(KEY_A).push.getPermissionState()).toBe('unavailable');
  });
});
