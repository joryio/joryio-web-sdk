import { InAppMessagingManager, cssValue } from './inapp';
import { installFakeDocument, uninstallFakeDocument, installFetch, RecordedRequest } from './test-harness';

/**
 * In-app, scan 2 (web): #3 the sync retry, #4 a delayed message displayed
 * twice, #7 displayOptions ignored by the renderer.
 */

const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;
const identity = {
  getUserId: () => null,
  getAnonymousId: () => 'anon-1',
  getAttributes: () => ({}),
  getAttribute: () => undefined,
  pending: { pending: () => ({}) },
} as any;
const session = { getSessionId: () => 's-1', getSessionInfo: () => ({ sessionStart: 0 }) } as any;

const native = (extra: Record<string, unknown> = {}) =>
  ({
    id: 'camp-1',
    name: 'Native',
    type: 'modal',
    triggers: [{ type: 'event', event: 'Opened' }],
    content: { kind: 'native', title: 'Hi', body: 'Body' },
    ...extra,
  }) as any;

let calls: RecordedRequest[] = [];
let mounted: any[] = [];

function make(displayOptions: Record<string, unknown> = {}) {
  (globalThis as any).window = { open: jest.fn() };
  return new InAppMessagingManager(
    'https://api.example/api',
    'jry_sdk_test',
    identity,
    session,
    logger,
    null,
    { closeButton: true, backdropClose: true, ...displayOptions },
    undefined,
    null,
    {},
  );
}

/** Let pending promise callbacks run (fake timers do not touch setImmediate). */
const drain = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  ({ mounted } = installFakeDocument());
});
afterEach(() => {
  jest.useRealTimers();
  uninstallFakeDocument();
  delete (globalThis as any).fetch;
  delete (globalThis as any).window;
  delete (globalThis as any).navigator;
});

describe('a failed sync is retried ONCE (scan 2 #3)', () => {
  it('a persistently failing API is not asked again every 5 seconds', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    (globalThis as any).navigator = { language: 'en' };
    calls = installFetch(() => ({ status: 500, body: {} }));
    const m = make();
    const syncs = () => calls.filter((c) => c.path === '/api/v1/in-app/sync').length;

    await m.sync().catch(() => undefined);
    expect(syncs()).toBe(1);

    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(5000);
      await drain();
    }
    // The first sync and its one retry - not one more every 5 s.
    expect(syncs()).toBe(2);
    m.destroy();
  });

  it('a success re-arms the retry for the next failure', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    (globalThis as any).navigator = { language: 'en' };
    let fail = true;
    calls = installFetch((req) =>
      req.path === '/api/v1/in-app/sync' && fail ? { status: 500, body: {} } : { status: 200, body: { success: true, campaigns: [] } },
    );
    const m = make();
    const syncs = () => calls.filter((c) => c.path === '/api/v1/in-app/sync').length;

    await m.sync().catch(() => undefined);
    fail = false;
    jest.advanceTimersByTime(5000);
    await drain();
    expect(syncs()).toBe(2); // retried, succeeded

    fail = true;
    await m.sync().catch(() => undefined);
    jest.advanceTimersByTime(5000);
    await drain();
    expect(syncs()).toBe(4); // a fresh failure gets its own retry
    m.destroy();
  });

  it('a 200 with success:false is a failed sync (addendum 15)', async () => {
    (globalThis as any).navigator = { language: 'en' };
    calls = installFetch(() => ({ status: 200, body: { success: false, campaigns: [], error: 'no subject' } }));
    const m = make();
    await expect(m.sync()).rejects.toThrow(/success: false/);
    m.destroy();
  });
});

describe('a delayed message is scheduled once (scan 2 #4)', () => {
  it('a second trigger while the first is waiting out its delay does not display it twice', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    (globalThis as any).navigator = { language: 'en', userAgent: 'jest' };
    calls = installFetch(() => ({ status: 200, body: { success: true } }));
    const m = make();
    const campaign = native({ delay: 2 });
    (m as any).campaigns.set(campaign.id, campaign);

    m.onEventTracked('Opened');
    m.onEventTracked('Opened'); // e.g. the event fired again, or a re-sync
    await drain();

    jest.advanceTimersByTime(2000);
    await drain();

    expect(mounted.filter((el) => el.id === 'joryio-inapp-camp-1')).toHaveLength(1);
    const displayed = calls.filter((c) => c.path === '/api/v1/in-app/track' && c.body.displayedAt);
    expect(displayed).toHaveLength(1);
    m.destroy();
  });
});

describe('displayOptions reach the renderer (scan 2 #7)', () => {
  const styleOf = () => mounted.find((el) => el.tagName === 'STYLE')!.textContent as string;
  const containerOf = (id: string) => mounted.find((el) => el.id === `joryio-inapp-${id}`)!;

  beforeEach(() => {
    (globalThis as any).navigator = { language: 'en', userAgent: 'jest' };
    calls = installFetch(() => ({ status: 200, body: { success: true } }));
  });

  it('backdropColor, closeButtonColor, defaultAnimation and defaultPosition are applied', async () => {
    const m = make({
      backdropColor: 'rgba(10, 20, 30, 0.7)',
      closeButtonColor: '#ff0000',
      defaultAnimation: 'slide',
      defaultPosition: 'bottom',
      zIndex: 5000,
    });
    const custom = native({ id: 'camp-c', type: 'custom' });
    (m as any).campaigns.set(custom.id, custom);
    await m.displayCampaign(custom);

    const css = styleOf();
    expect(css).toContain('background: rgba(10, 20, 30, 0.7);');
    expect(css).toContain('color: #ff0000;');
    expect(css).toContain('z-index: 5000;');
    const cls = containerOf('camp-c').className;
    expect(cls).toContain('joryio-inapp-pos-bottom'); // a custom type takes defaultPosition
    expect(cls).toContain('joryio-inapp-anim-slide');
    m.destroy();
  });

  it('a type with its own placement ignores defaultPosition; none means no animation', async () => {
    const m = make({ defaultPosition: 'top', defaultAnimation: 'none' });
    const modal = native({ id: 'camp-m', type: 'modal' });
    (m as any).campaigns.set(modal.id, modal);
    await m.displayCampaign(modal);
    const cls = containerOf('camp-m').className;
    expect(cls).not.toContain('joryio-inapp-pos-');
    expect(cls).not.toContain('joryio-inapp-anim-');
    m.destroy();
  });

  it('defaults: fade, the old backdrop colour, close button inherits the text colour', async () => {
    const m = make({});
    const modal = native({ id: 'camp-d', type: 'modal' });
    (m as any).campaigns.set(modal.id, modal);
    await m.displayCampaign(modal);
    const css = styleOf();
    expect(css).toContain('background: rgba(0, 0, 0, 0.5);');
    expect(containerOf('camp-d').className).toContain('joryio-inapp-anim-fade');
    m.destroy();
  });

  it('a value that could break out of the stylesheet is refused', () => {
    expect(cssValue('red;} body { display: none')).toBeNull();
    expect(cssValue('</style><script>')).toBeNull();
    expect(cssValue('  #123456 ')).toBe('#123456');
    expect(cssValue(null)).toBeNull();
  });
});
