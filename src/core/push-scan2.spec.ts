import { PushManager } from './push';
import { NetworkClient } from './network';
import { classifyWriteResponse } from './write-retry';
import { installFetch } from './test-harness';

/**
 * Web push and the success:false rule, scan 2 (web): #8 a 200 with
 * success:false counted as a registration, #9 no deviceId on registration,
 * #15 unsubscribe() rejecting, addendum 22 (an unsubscribe is durable).
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

let navDescriptor: PropertyDescriptor | undefined;

function makeSub(endpoint: string) {
  return {
    endpoint,
    options: {},
    toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: jest.fn(async () => true),
  };
}

function setBrowser(current: { sub: any }, getRegistration?: () => Promise<any>) {
  const pushManager = {
    getSubscription: jest.fn(async () => current.sub),
    subscribe: jest.fn(async () => {
      current.sub = makeSub('https://push.example/new');
      return current.sub;
    }),
  };
  (globalThis as any).window = { PushManager: {}, Notification: {} };
  (globalThis as any).Notification = { permission: 'granted' };
  navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: { getRegistration: jest.fn(getRegistration || (async () => ({ pushManager }))) } },
    configurable: true,
  });
  return pushManager;
}

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).Notification;
  delete (globalThis as any).fetch;
  if (navDescriptor) Object.defineProperty(globalThis, 'navigator', navDescriptor);
  navDescriptor = undefined;
});

function make(opts: {
  storage?: any;
  canSend?: () => boolean;
  canWithdraw?: () => boolean;
  register?: (req: any) => any;
  identity?: { userId: string | null; anon: string };
} = {}) {
  const requests: any[] = [];
  const network = {
    request: jest.fn(async (req: any) => {
      requests.push(req);
      if (req.url.endsWith('/v1/push/vapid-public-key')) {
        return { ok: true, status: 200, data: { enabled: true, publicKey: 'BAAA' } };
      }
      if (req.url.endsWith('/v1/push/register') && opts.register) return opts.register(req);
      return { ok: true, status: 200, data: { success: true } };
    }),
    isSdkAuthError: () => false,
  } as any;
  const who = opts.identity || { userId: null, anon: 'anon-1' };
  const id = { getUserId: () => who.userId, getAnonymousId: () => who.anon } as any;
  const storage = opts.storage || memoryStorage();
  const push = new PushManager(logger, network, id, 'https://api.example/api', {
    canSend: opts.canSend || (() => true),
    canWithdraw: opts.canWithdraw || (() => true),
    storage,
    getDeviceId: () => 'device-123',
  });
  const by = (suffix: string) => requests.filter((r) => r.url.endsWith(suffix));
  return { push, requests, storage, registers: () => by('/v1/push/register'), unregisters: () => by('/v1/push/unregister') };
}

describe('registration carries the stable deviceId (scan 2 #9)', () => {
  it('sends deviceId like Android and iOS do', async () => {
    setBrowser({ sub: makeSub('https://push.example/1') });
    const { push, registers } = make();
    await push.syncExistingSubscription(true);
    expect(registers()[0].body.deviceId).toBe('device-123');
  });
});

describe('a 2xx with success:false is not a registration (scan 2 #8)', () => {
  it('the network client reports it as a failure, not ok', async () => {
    installFetch(() => ({ status: 200, body: { success: false, error: 'refused' } }));
    const client = new NetworkClient('jry_sdk_test', logger, { maxRetries: 0, backoffMs: 1 });
    const res = await client.request({ url: 'https://api.example/api/v1/push/register', body: {} });
    expect(res.ok).toBe(false);
    expect(res.softFailure).toBe(true);
    expect(res.status).toBe(200);
  });

  it('no marker is written, so the next page load registers again', async () => {
    setBrowser({ sub: makeSub('https://push.example/1') });
    const storage = memoryStorage();
    let refuse = true;
    const register = () =>
      refuse
        ? { ok: false, status: 200, softFailure: true, data: { success: false } }
        : { ok: true, status: 200, data: { success: true } };
    const first = make({ storage, register });
    await first.push.syncExistingSubscription();
    expect(first.registers()).toHaveLength(1);

    refuse = false;
    const second = make({ storage, register }); // next page view, same storage
    await second.push.syncExistingSubscription();
    expect(second.registers()).toHaveLength(1);
  });

  it('a success:false write is retried (and counted), never counted done', () => {
    const verdict = classifyWriteResponse({ ok: false, status: 200, softFailure: true }, {
      isSdkAuthError: false,
      ownerIsCurrentUser: true,
    });
    expect(verdict).toEqual({ action: 'retry', counts: true });
  });
});

describe('unsubscribe() (scan 2 #15, addendum 22)', () => {
  it('never rejects into the host page', async () => {
    setBrowser({ sub: null }, async () => {
      throw new Error('SecurityError');
    });
    const { push } = make();
    await expect(push.unsubscribe()).resolves.toBe(false);
  });

  it('is durable: a later page load does not silently subscribe the browser again', async () => {
    const current = { sub: makeSub('https://push.example/1') as any };
    const pm = setBrowser(current);
    const storage = memoryStorage();
    const first = make({ storage });
    await expect(first.push.unsubscribe()).resolves.toBe(true);
    expect(first.unregisters()).toHaveLength(1);
    current.sub = null; // the browser dropped it

    // Next page view: permission is still granted. It used to re-subscribe.
    const second = make({ storage });
    await second.push.syncExistingSubscription(true);
    expect(pm.subscribe).not.toHaveBeenCalled();
    expect(second.registers()).toHaveLength(0);
  });

  it('is a withdrawal: sent while tracking is off or consent pending (contract item 36)', async () => {
    setBrowser({ sub: makeSub('https://push.example/1') });
    const first = make({ canSend: () => false });
    await first.push.unsubscribe();
    expect(first.unregisters()).toHaveLength(1);
  });

  it('a registration of the same endpoint cancels an unregister not sent yet', async () => {
    const sub = makeSub('https://push.example/1');
    setBrowser({ sub: sub as any });
    let allowed = false; // withdrawals held (suspended workspace)
    const { push, storage, unregisters, registers } = make({ canWithdraw: () => allowed });
    await push.unsubscribe();
    expect(storage.get('push_pending_unregister')).toHaveLength(1);
    // The same endpoint is registered again (the browser kept it - its own
    // unsubscribe failed - and subscribe() re-registers it).
    await (push as any).registerWithBackend(sub);
    expect(registers()).toHaveLength(1);
    allowed = true;
    push.retryPendingUnregister();
    await new Promise((r) => setTimeout(r, 10));
    // Sent after the registration, the unregister would turn push off for good.
    expect(unregisters()).toHaveLength(0);
    expect(storage.get('push_pending_unregister')).toBeNull();
  });

  it('the server is told later when it could not be told at the time', async () => {
    setBrowser({ sub: makeSub('https://push.example/1') });
    const storage = memoryStorage();
    let allowed = false; // e.g. the workspace's ingestion was suspended
    const first = make({ storage, canSend: () => allowed, canWithdraw: () => allowed });
    await first.push.unsubscribe();
    expect(first.unregisters()).toHaveLength(0);

    allowed = true;
    const second = make({ storage, canSend: () => allowed, canWithdraw: () => allowed });
    await second.push.syncExistingSubscription();
    expect(second.unregisters()).toHaveLength(1);
    expect(second.unregisters()[0].body).toEqual(
      expect.objectContaining({ platform: 'web', endpoint: 'https://push.example/1', anonymousId: 'anon-1' }),
    );
  });
});
