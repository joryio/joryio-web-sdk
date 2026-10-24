import { IdentityManager } from './identity';
import { StorageManager } from './storage';
import { JoryioSDK } from './sdk';
import type { QueuedEvent } from './queue';

const stubLogger = { error() {}, warn() {}, info() {}, debug() {} } as any;

// In the node/jsdom-less test env StorageManager falls back to its in-memory
// map, so these exercise the real generate/persist path without a browser.
describe('IdentityManager anonymous/user id', () => {
  it('generates an anonymous id, persists it, and is stable across calls', () => {
    const storage = new StorageManager('jry_sdk_test', stubLogger);
    const identity = new IdentityManager(storage, stubLogger);

    const id = identity.getAnonymousId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    // Stable across repeated calls on the same instance.
    expect(identity.getAnonymousId()).toBe(id);
    // Persisted: a fresh manager over the same storage reads the SAME id.
    const identity2 = new IdentityManager(storage, stubLogger);
    expect(identity2.getAnonymousId()).toBe(id);
  });

  it('returns a persisted anonymous id ahead of generating a new one', () => {
    const storage = new StorageManager('jry_sdk_test2', stubLogger);
    storage.set('anonymous_id', 'anon-persisted-1');
    const identity = new IdentityManager(storage, stubLogger);
    expect(identity.getAnonymousId()).toBe('anon-persisted-1');
  });

  it('getUserId is null when anonymous and reflects identify()', () => {
    const storage = new StorageManager('jry_sdk_test3', stubLogger);
    const identity = new IdentityManager(storage, stubLogger);
    expect(identity.getUserId()).toBeNull();
    identity.identify('user-123');
    expect(identity.getUserId()).toBe('user-123');
  });
});

describe('JoryioSDK.getAnonymousId / getUserId public API', () => {
  let sdk: JoryioSDK;

  const makeSdk = () => {
    const instance = new JoryioSDK({
      sdkKey: 'jry_sdk_test',
      trackSessionStart: false,
      trackPageViews: false,
      persistQueue: false,
      // Keep the test off the network / timers: in-app messaging otherwise
      // fires a sync fetch + a 60s interval that would leak as an open handle.
      inApp: { enabled: false },
    });
    // Silence the flush timer + network for the test; we only inspect the queue.
    (instance as any).queue.stop();
    (instance as any).queue.flush = async () => {};
    return instance;
  };

  afterEach(async () => {
    if (sdk) {
      await sdk.destroy();
    }
  });

  it('exposes a stable anonymous id that matches the id stamped on track()', () => {
    sdk = makeSdk();

    const anonId = sdk.getAnonymousId();
    expect(typeof anonId).toBe('string');
    expect(anonId.length).toBeGreaterThan(0);
    expect(sdk.getAnonymousId()).toBe(anonId); // stable across calls

    // Capture the event the SDK would enqueue and assert its anonymousId
    // matches what getAnonymousId() reports.
    const captured: QueuedEvent[] = [];
    (sdk as any).queue.enqueue = (event: QueuedEvent) => captured.push(event);

    sdk.track('Test Event');

    expect(captured).toHaveLength(1);
    expect(captured[0].anonymousId).toBe(anonId);
  });

  it('getUserId is null until identify(), then returns the user id', () => {
    sdk = makeSdk();
    expect(sdk.getUserId()).toBeNull();

    sdk.identify('user-abc');
    expect(sdk.getUserId()).toBe('user-abc');
    // getAnonymousId stays available after identify.
    expect(typeof sdk.getAnonymousId()).toBe('string');
  });

  it('ready(cb) runs the callback with the SDK instance', () => {
    sdk = makeSdk();
    const seen: string[] = [];
    sdk.ready((instance) => {
      seen.push(instance.getAnonymousId());
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(sdk.getAnonymousId());
  });
});
