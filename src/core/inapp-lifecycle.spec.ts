import { InAppMessagingManager } from './inapp';
import { installFakeDocument, uninstallFakeDocument, installFetch, RecordedRequest, settle } from './test-harness';

/**
 * In-app display, wire vocabulary and timers (review findings 12, 16, 17;
 * contract item 9).
 */

const logger = { error() {}, warn() {}, info() {}, debug() {} } as any;

const identity = {
  getUserId: () => null,
  getAnonymousId: () => 'anon-1',
  getAttributes: () => ({ email: 'ada@example.com' }),
  getAttribute: () => undefined,
  pending: { pending: () => ({}) },
} as any;
const session = { getSessionId: () => 's-1', getSessionInfo: () => ({ sessionStart: 0 }) } as any;

const nativeCampaign = (extra: Record<string, unknown> = {}) =>
  ({
    id: 'camp-n',
    name: 'Native',
    type: 'modal',
    triggers: [{ type: 'immediate' }],
    content: {
      kind: 'native',
      title: 'Hi',
      body: 'Body',
      buttons: [{ id: 'cta', text: 'Go', action: 'url', url: 'https://example.com/x' }],
    },
    ...extra,
  }) as any;

let calls: RecordedRequest[] = [];
let mounted: any[] = [];

beforeEach(() => {
  calls = installFetch(() => ({ status: 200, body: { success: true } }));
  ({ mounted } = installFakeDocument());
});
afterEach(() => {
  uninstallFakeDocument();
  delete (globalThis as any).fetch;
  delete (globalThis as any).window;
});

function make(opts: { onDisplay?: jest.Mock; onClick?: jest.Mock; canSend?: () => boolean } = {}) {
  (globalThis as any).window = { open: jest.fn() };
  const m = new InAppMessagingManager(
    'https://api.example/api',
    'jry_sdk_test',
    identity,
    session,
    logger,
    null,
    { closeButton: true, backdropClose: true, onDisplay: opts.onDisplay, onClick: opts.onClick },
    undefined,
    null,
    { canSend: opts.canSend },
  );
  return m;
}

const tracks = () => calls.filter((c) => c.path === '/api/v1/in-app/track').map((c) => c.body);

describe('native in-app messages', () => {
  it('report ONE displayed impression and fire onMessageDisplay', async () => {
    const onDisplay = jest.fn();
    const m = make({ onDisplay });
    (m as any).campaigns.set('camp-n', nativeCampaign());

    await m.displayCampaign(nativeCampaign());
    await settle(5);

    expect(tracks().filter((t) => t.displayedAt)).toHaveLength(1);
    expect(onDisplay).toHaveBeenCalledTimes(1);
    // Mounted with its stylesheet (it used to be appended unstyled to <body>).
    expect(mounted.some((el) => el.tagName === 'STYLE')).toBe(true);
    expect(mounted.some((el) => el.id === 'joryio-inapp-camp-n')).toBe(true);
  });

  it('a button click is tracked with the vocabulary action `clicked`, never the button id', async () => {
    const onClick = jest.fn();
    const m = make({ onClick });
    (m as any).campaigns.set('camp-n', nativeCampaign());
    await m.displayCampaign(nativeCampaign());

    const container = mounted.find((el) => el.id === 'joryio-inapp-camp-n');
    const card = container.children[0];
    const row = card.children.find((c: any) => c.className.startsWith('joryio-inapp-buttons'));
    row.children[0].on_click();
    await settle(5);

    const click = tracks().find((t) => t.clicked);
    expect(click.action).toBe('clicked');
    expect(click.clickedUrl).toBe('https://example.com/x');
    // Which button: `elementId`, the same field name on every SDK.
    expect(click.elementId).toBe('cta');
    const dismiss = tracks().find((t) => t.dismissedAt);
    expect(dismiss.action).toBe('dismissed');
    expect(onClick).toHaveBeenCalledWith(expect.anything(), 'cta');
  });

  it('identifies the visitor by anonymousId, never by the email attribute', async () => {
    const m = make();
    (m as any).campaigns.set('camp-n', nativeCampaign());
    await m.displayCampaign(nativeCampaign());
    await settle(5);
    const t = tracks()[0];
    expect(t.externalId).toBeUndefined();
    expect(t.anonymousId).toBe('anon-1');
    expect(t.userId).toBeUndefined();
  });

  it('sends no impression while sending is not allowed (opt-out / consent pending)', async () => {
    const m = make({ canSend: () => false });
    (m as any).campaigns.set('camp-n', nativeCampaign());
    await m.displayCampaign(nativeCampaign());
    await settle(5);
    expect(tracks()).toEqual([]);
  });
});

describe('timers do not outlive clearAll() / destroy() / stop()', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a delayed message scheduled before reset never appears after it', async () => {
    const m = make();
    const shown = jest.fn();
    (m as any).display = shown;
    await m.displayCampaign(nativeCampaign({ delay: 10 }));
    expect((m as any).pendingDelays.size).toBe(1);

    m.clearAll();
    jest.advanceTimersByTime(20_000);
    expect(shown).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('the failed-sync retry is cancelled by destroy()', async () => {
    (globalThis as any).fetch = jest.fn(async () => {
      throw new Error('offline');
    });
    const m = make();
    await m.sync().catch(() => undefined);
    expect((m as any).syncRetryTimer).toBeDefined();
    m.destroy();
    expect((m as any).syncRetryTimer).toBeUndefined();
    const fetchCalls = (globalThis as any).fetch.mock.calls.length;
    jest.advanceTimersByTime(10_000);
    expect((globalThis as any).fetch.mock.calls.length).toBe(fetchCalls);
  });

  it('initialize() twice runs ONE attribute-watch interval, and stop() ends it', async () => {
    jest.useRealTimers();
    calls = installFetch(() => ({
      status: 200,
      body: {
        success: true,
        campaigns: [{ ...nativeCampaign(), triggers: [], evaluationMode: 'differential-sync', watchedAttributes: ['plan'] }],
      },
    }));
    const m = make();
    const set = jest.spyOn(globalThis, 'setInterval');
    const clear = jest.spyOn(globalThis, 'clearInterval');
    (globalThis as any).window.setInterval = setInterval;
    await m.initialize();
    await m.initialize();
    const started = set.mock.calls.length;
    const stopped = clear.mock.calls.length;
    // Every interval but one was cleared again.
    expect(started - stopped).toBe(1);
    m.stop();
    expect((m as any).syncInterval).toBeUndefined();
    set.mockRestore();
    clear.mockRestore();
  });
});

// Real timers and real debounce windows; generous under a loaded CI machine.
jest.setTimeout(30_000);

describe('normalizedElementId', () => {
  it('keeps a real id, drops generic names, trims and caps at 128', () => {
    const { normalizedElementId } = require('./inapp');
    expect(normalizedElementId('buy-now')).toBe('buy-now');
    expect(normalizedElementId(' cta_click ')).toBeUndefined();
    expect(normalizedElementId('Click')).toBeUndefined();
    expect(normalizedElementId('')).toBeUndefined();
    expect(normalizedElementId(undefined)).toBeUndefined();
    expect(normalizedElementId('x'.repeat(200))).toHaveLength(128);
  });
});
