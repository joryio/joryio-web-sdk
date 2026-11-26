import { JoryioSDK } from './sdk';
import { BASE_CONFIG, installFetch, installLocalStorage, uninstallLocalStorage, waitFor, settle, RecordedRequest } from './test-harness';

/**
 * Show when re-checks (1.4.0-beta.9 test): one request per (key set, event),
 * as on iOS and Android. Two re-checks are never folded into one request, an
 * event never rides on another key's re-check, and a re-check never joins a
 * normal fetch.
 */
let sdk: JoryioSDK | null = null;
let calls: RecordedRequest[] = [];
let batchStatus = 200;

const ANSWERS: Record<string, any> = {
  xk_a: { placementKey: 'xk_a', recheckOn: ['ev_a'], items: [] },
  xk_b: { placementKey: 'xk_b', recheckOn: ['ev_b'], items: [] },
};

beforeEach(() => {
  installLocalStorage();
  batchStatus = 200;
  calls = installFetch((req) => {
    if (req.path.endsWith('/v1/in-app/placements')) {
      const placements: Record<string, any> = {};
      for (const key of req.body?.placements || []) placements[key] = ANSWERS[key] || { placementKey: key, items: [] };
      return { status: 200, body: { success: true, placements } };
    }
    if (req.path.endsWith('/v1/track/batch')) {
      return batchStatus === 200 ? { status: 200, body: { success: true, processed: req.body?.events?.length ?? 0 } } : { status: batchStatus, body: { success: false } };
    }
    return { status: 200, body: { success: true } };
  });
  const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as any).window = { location: { href: 'https://shop.example/', origin: 'https://shop.example', pathname: '/', search: '' }, ...listeners };
  (globalThis as any).document = { referrer: '', readyState: 'complete', visibilityState: 'visible', ...listeners };
});

afterEach(async () => {
  if (sdk) await sdk.destroy();
  sdk = null;
  uninstallLocalStorage();
  delete (globalThis as any).fetch;
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

const serves = () => calls.filter((c) => c.path.endsWith('/v1/in-app/placements'));
const rechecks = () => serves().filter((c) => c.body.recheckEvent);

describe('show when re-checks are never coalesced', () => {
  it('two keys re-checked for two events: two requests, each with its own key and its own event', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'granted' } as any);
    await sdk.getPlacements(['xk_a', 'xk_b']);
    await sdk.flush();
    expect(serves()).toHaveLength(1);

    sdk.track('ev_a');
    sdk.track('ev_b');
    await waitFor(() => rechecks().length >= 2);
    await settle(200);

    const sent = rechecks().map((c) => ({ keys: c.body.placements, event: c.body.recheckEvent.name }));
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(expect.arrayContaining([
      { keys: ['xk_a'], event: 'ev_a' },
      { keys: ['xk_b'], event: 'ev_b' },
    ]));
  });

  it('a re-check never joins a normal fetch that is waiting for its batch window', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'granted' } as any);
    await sdk.getPlacements(['xk_a']);
    await sdk.flush();
    // xk_b's first fetch sits in the batch window while xk_a is re-checked.
    void sdk.getPlacements(['xk_b']);
    await (sdk as any).placements.recheck(['xk_a'], { name: 'ev_a', eventId: 'e1', properties: {} });
    await waitFor(() => serves().length >= 3);
    await settle(200);
    const plain = serves().slice(1).filter((c) => !c.body.recheckEvent);
    expect(plain.map((c) => c.body.placements)).toEqual([['xk_b']]);
    expect(rechecks().map((c) => c.body.placements)).toEqual([['xk_a']]);
  });

  it('25 re-checks for one key wait while delivery fails: the newest 20 each get a request of their own', async () => {
    sdk = new JoryioSDK({ ...BASE_CONFIG, trackingConsent: 'granted' } as any);
    await sdk.getPlacements(['xk_a']);
    await sdk.flush();
    (sdk as any).placements.recheckKeysFor = () => ['xk_a'];
    batchStatus = 503;
    for (let i = 0; i < 25; i++) sdk.track(`E${i}`);
    await waitFor(() => (sdk as any).pendingRechecks.length === 20);
    await settle(200);
    expect(rechecks()).toHaveLength(0);

    batchStatus = 200;
    await sdk.flush();
    await waitFor(() => rechecks().length >= 20);
    await settle(300);
    const names = rechecks().map((c) => c.body.recheckEvent.name).sort();
    expect(names).toEqual(Array.from({ length: 20 }, (_, i) => `E${i + 5}`).sort());
    expect(rechecks().every((c) => JSON.stringify(c.body.placements) === '["xk_a"]')).toBe(true);
  });
});
